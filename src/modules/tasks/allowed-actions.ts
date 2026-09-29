import type { TaskStatus } from "../../../generated/prisma/client";
import { canManageDependencies } from "../../policies/tasks";
import type { AuthUser } from "../../types";
import type { DependencyLite } from "./blocked";
import { evaluateTransition } from "./transitions";

/**
 * Permission hints for the UI. Computed with the SAME pure policy functions
 * the write endpoints use, so a disabled button in the frontend always
 * matches the server's decision. Backend validation remains the real guard.
 */
export interface ActionFlag {
  allowed: boolean;
  reason?: string;
  blockedBy?: { id: string; title: string; status: TaskStatus }[];
}

export interface AllowedActions {
  canStart: ActionFlag;
  canComplete: ActionFlag;
  canEdit: ActionFlag;
  canUpload: ActionFlag;
  canManageDependencies: ActionFlag;
}

export function computeAllowedActions(
  actor: AuthUser & { isProjectMember: boolean },
  task: {
    status: TaskStatus;
    assigneeId: string | null;
    department: "UIUX" | "FRONTEND" | "BACKEND" | null;
  },
  dependencies: DependencyLite[],
): AllowedActions {
  const unfinished = dependencies.filter((d) => d.status !== "DONE");

  // A task already IN_PROGRESS needs no "start" action — report it as
  // allowed so the UI does not disable a no-op button.
  const startEval =
    task.status === "IN_PROGRESS"
      ? ({ ok: true } as const)
      : evaluateTransition(task.status, "IN_PROGRESS", {
          actor: { id: actor.id, role: actor.role, department: actor.department },
          task,
          unfinishedDependencies: unfinished,
          isProjectMember: actor.isProjectMember,
        });

  const completeEval = evaluateTransition(task.status, "DONE", {
    actor: { id: actor.id, role: actor.role, department: actor.department },
    task,
    unfinishedDependencies: unfinished,
    isProjectMember: actor.isProjectMember,
  });

  const isPm = actor.role === "PM";
  const canWriteCore = isPm; // only PM edits title/description/assignee/etc.

  return {
    canStart: startEval.ok
      ? { allowed: true }
      : startEval.rejection.kind === "INVALID_TRANSITION"
        ? { allowed: false, reason: "INVALID_TRANSITION" }
        : startEval.rejection.kind === "TASK_BLOCKED"
          ? { allowed: false, reason: "TASK_BLOCKED", blockedBy: startEval.rejection.blockedBy }
          : { allowed: false, reason: startEval.rejection.reason },
    canComplete: completeEval.ok
      ? { allowed: true }
      : completeEval.rejection.kind === "INVALID_TRANSITION"
        ? { allowed: false, reason: "INVALID_TRANSITION" }
        : completeEval.rejection.kind === "TASK_BLOCKED"
          ? { allowed: false, reason: "TASK_BLOCKED", blockedBy: completeEval.rejection.blockedBy }
          : { allowed: false, reason: completeEval.rejection.reason },
    canEdit: { allowed: canWriteCore },
    canUpload: { allowed: actor.isProjectMember && actor.role !== "CLIENT" },
    canManageDependencies: { allowed: canManageDependencies(actor) && actor.isProjectMember },
  };
}
