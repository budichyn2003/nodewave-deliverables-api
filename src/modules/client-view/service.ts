import type { Prisma } from "../../../generated/prisma/client";
import { ApiError } from "../../lib/errors";
import { type ParsedListQuery, parseListQuery } from "../../lib/ezfilter";
import { prisma } from "../../lib/prisma";
import type { AuthUser } from "../../types";
import { liveDependencies } from "./dependencies";
import { clientTaskListWhitelist } from "./schemas";
import { serializeClientMetrics, serializeClientProject, serializeClientTask } from "./serializers";

/**
 * Tenant derivation: the project comes from the authenticated client's
 * membership row — NEVER from a client-supplied id. A CLIENT belongs to
 * exactly one project (enforced at membership creation).
 */
async function tenantProject(actor: AuthUser) {
  if (actor.role !== "CLIENT") {
    throw new ApiError("FORBIDDEN", "Client view is only for client accounts");
  }
  const membership = await prisma.projectMember.findFirst({
    where: { userId: actor.id },
    include: { project: true },
  });
  if (!membership || membership.project.deletedAt) {
    throw ApiError.notFound("Project");
  }
  return membership.project;
}

/** GET /client/project — masked project info + aggregate metrics. */
export async function getClientProject(actor: AuthUser) {
  const project = await tenantProject(actor);

  // Assumption (documented): metrics are computed over ALL non-deleted
  // tasks — not just client-visible ones — so the client's progress number
  // is honest rather than flattering.
  const [totalTasks, doneTasks] = await Promise.all([
    prisma.task.count({ where: { projectId: project.id } }),
    prisma.task.count({ where: { projectId: project.id, status: "DONE" } }),
  ]);

  return {
    project: serializeClientProject(project),
    metrics: serializeClientMetrics({
      totalTasks,
      doneTasks,
      percentComplete: totalTasks === 0 ? 0 : Math.round((doneTasks / totalTasks) * 100),
    }),
  };
}

/** GET /client/tasks — clientVisible tasks only, whitelist fields only. */
export async function getClientTasks(actor: AuthUser, query: URLSearchParams) {
  const project = await tenantProject(actor);

  const q: ParsedListQuery = parseListQuery(query, clientTaskListWhitelist);
  const userFragments = (q.where as { AND?: unknown[] }).AND ?? [];
  const rawOrderBy = q.orderBy as Prisma.TaskOrderByWithRelationInput | undefined;
  const orderBy: Prisma.TaskOrderByWithRelationInput =
    rawOrderBy && Object.keys(rawOrderBy).length > 0 ? rawOrderBy : { updatedAt: "desc" };

  // Authorization scope (tenant + clientVisible) is ANDed on top of user
  // filters and can never be overridden by them.
  const where: Prisma.TaskWhereInput = {
    projectId: project.id,
    clientVisible: true,
    AND: userFragments as Prisma.TaskWhereInput[],
  };

  const [tasks, total] = await Promise.all([
    prisma.task.findMany({ where, orderBy, take: q.take, skip: q.skip }),
    prisma.task.count({ where }),
  ]);

  const data = await Promise.all(
    tasks.map(async (t) =>
      serializeClientTask({ task: t, dependencies: await liveDependencies(t.id) }),
    ),
  );

  return { data, meta: { page: q.page, rows: q.rows, total } };
}
