import type { Prisma } from "../../../generated/prisma/client";
import { ApiError } from "../../lib/errors";
import type { ListWhitelist } from "../../lib/ezfilter";
import { type ParsedListQuery, parseListQuery } from "../../lib/ezfilter";
import { prisma } from "../../lib/prisma";
import { canViewAudit } from "../../policies/tasks";
import type { AuthUser } from "../../types";
import { isMember } from "../projects/service";

export const auditListWhitelist: ListWhitelist = {
  filterable: ["column", "action", "userId", "taskId"],
  searchable: ["column", "oldValue", "newValue"],
  searchableTypes: { column: "string", oldValue: "string", newValue: "string" },
  rangable: ["createdAt"],
  sortable: ["createdAt", "column", "action"],
};

/** GET /projects/:projectId/tasks/:taskId/audit — PM only, paginated. */
export async function listTaskAudit(
  actor: AuthUser,
  projectId: string,
  taskId: string,
  query: URLSearchParams,
) {
  if (!canViewAudit(actor)) throw new ApiError("FORBIDDEN", "Only PMs can view the audit trail");
  if (!(await isMember(actor.id, projectId))) throw ApiError.notFound("Project");

  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: { id: true, projectId: true },
  });
  if (!task || task.projectId !== projectId) throw ApiError.notFound("Task");

  const q: ParsedListQuery = parseListQuery(query, auditListWhitelist);
  const userFragments = (q.where as { AND?: unknown[] }).AND ?? [];
  const rawOrderBy = q.orderBy as Prisma.TaskAuditLogOrderByWithRelationInput | undefined;
  const orderBy: Prisma.TaskAuditLogOrderByWithRelationInput =
    rawOrderBy && Object.keys(rawOrderBy).length > 0 ? rawOrderBy : { createdAt: "asc" };

  const where: Prisma.TaskAuditLogWhereInput = {
    taskId,
    projectId,
    AND: userFragments as Prisma.TaskAuditLogWhereInput[],
  };

  const [rows, total] = await Promise.all([
    prisma.taskAuditLog.findMany({ where, orderBy, take: q.take, skip: q.skip }),
    prisma.taskAuditLog.count({ where }),
  ]);

  return {
    data: rows.map((r) => ({
      id: r.id,
      taskId: r.taskId,
      userId: r.userId,
      action: r.action,
      column: r.column,
      oldValue: r.oldValue,
      newValue: r.newValue,
      createdAt: r.createdAt,
    })),
    meta: { page: q.page, rows: q.rows, total },
  };
}
