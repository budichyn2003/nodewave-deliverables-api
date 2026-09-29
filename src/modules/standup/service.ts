import { ApiError } from "../../lib/errors";
import { prisma } from "../../lib/prisma";
import type { AuthUser } from "../../types";
import { liveDependencies } from "../client-view/dependencies";
import { isMember } from "../projects/service";
import { blockedBy } from "../tasks/blocked";

/** Configurable timezone (brief: Asia/Jakarta). */
const STANDUP_TZ_OFFSET_HOURS = 7;

/**
 * Computes the [start, end) window for `date` (YYYY-MM-DD) in the standup
 * timezone. Jakarta is UTC+7 with no DST, so a fixed offset is exact.
 */
export function dayWindow(dateStr: string): { start: Date; end: Date } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    throw new ApiError("VALIDATION_ERROR", "date must be YYYY-MM-DD");
  }
  const startUtcMs = Date.parse(`${dateStr}T00:00:00.000Z`) - STANDUP_TZ_OFFSET_HOURS * 3600_000;
  const endUtcMs = startUtcMs + 24 * 3600_000;
  if (Number.isNaN(startUtcMs)) {
    throw new ApiError("VALIDATION_ERROR", "date must be a valid calendar date");
  }
  return { start: new Date(startUtcMs), end: new Date(endUtcMs) };
}

/** Default standup date: "yesterday" in the standup timezone. */
export function defaultStandupDate(now = new Date()): string {
  // Calendar date in UTC+N comes from shifting the instant FORWARD by N
  // hours before reading the UTC date parts; then step back one day.
  const shifted = new Date(now.getTime() + STANDUP_TZ_OFFSET_HOURS * 3600_000 - 24 * 3600_000);
  return shifted.toISOString().slice(0, 10);
}

const DEPARTMENTS = ["UIUX", "FRONTEND", "BACKEND"] as const;

/**
 * GET /projects/:projectId/standup?date=YYYY-MM-DD (PM or members).
 * - completedYesterday: audit rows where status changed to DONE inside the
 *   day window, grouped by the task's department, with the actor's name.
 * - blockedToday: tasks currently blocked, computed live from dependencies.
 */
export async function getStandup(actor: AuthUser, projectId: string, dateStr?: string) {
  if (actor.role === "CLIENT") throw ApiError.notFound("Project");
  if (!(await isMember(actor.id, projectId))) throw ApiError.notFound("Project");

  const date = dateStr ?? defaultStandupDate();
  const { start, end } = dayWindow(date);

  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) throw ApiError.notFound("Project");

  // "Completed yesterday": status -> DONE transitions inside the window.
  const completions = await prisma.taskAuditLog.findMany({
    where: {
      projectId,
      column: "status",
      newValue: "DONE",
      createdAt: { gte: start, lt: end },
    },
    include: { task: true, user: true },
    orderBy: { createdAt: "asc" },
  });

  // "Blocked today": live computation over non-deleted tasks.
  const tasks = await prisma.task.findMany({
    where: { projectId },
    include: { assignee: true },
  });
  const depMap = new Map<string, Awaited<ReturnType<typeof liveDependencies>>>();
  for (const t of tasks) {
    depMap.set(t.id, await liveDependencies(t.id));
  }

  const departments = DEPARTMENTS.map((dept) => {
    const deptTasks = tasks.filter((t) => t.department === dept);

    const completedYesterday = completions
      .filter((c) => c.task.department === dept)
      .map((c) => ({
        taskId: c.taskId,
        title: c.task.title,
        completedBy: c.user.name,
        at: c.createdAt,
      }));

    const blockedToday = deptTasks
      .filter(
        (t) => t.status !== "DONE" && (depMap.get(t.id) ?? []).some((d) => d.status !== "DONE"),
      )
      .map((t) => ({
        taskId: t.id,
        title: t.title,
        blockedBy: blockedBy(t.status, depMap.get(t.id) ?? []),
      }));

    return { department: dept, completedYesterday, blockedToday };
  });

  return {
    date,
    project: { id: project.id, name: project.name },
    departments,
  };
}
