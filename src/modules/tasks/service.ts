import type { Prisma, TaskStatus } from "../../../generated/prisma/client";
import { ApiError } from "../../lib/errors";
import { type ParsedListQuery, parseListQuery } from "../../lib/ezfilter";
import { prisma } from "../../lib/prisma";
import { canCreateTask, canManageDependencies, canSoftDeleteTask } from "../../policies/tasks";
import type { AuthUser } from "../../types";
import { diffTask, statusChange } from "../audit/diff";
import { writeAudit } from "../audit/writer";
import { projectListWhitelist } from "../projects/schemas";
import { isMember } from "../projects/service";
import { computeAllowedActions } from "./allowed-actions";
import { blockedBy, type DependencyLite, isBlocked } from "./blocked";
import { validateAddDependency } from "./dependencies-graph";
import {
  type ChangeStatusInput,
  type CreateTaskInput,
  taskListWhitelist,
  type UpdateTaskInput,
} from "./schemas";
import { serializeTask, serializeTaskForBoard } from "./serializers";
import { evaluateTransition } from "./transitions";

/** Loads a task the actor can see (membership gate), or throws 404. */
async function getVisibleTask(actor: AuthUser, taskId: string) {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    include: { assignee: true },
  });
  if (!task) throw ApiError.notFound("Task");
  // CLIENT users are routed to the client-view module exclusively — the
  // internal task shape (assignee, department, dependencies) must never
  // reach them, even though they are a project member.
  if (actor.role === "CLIENT") throw ApiError.notFound("Task");
  if (!(await isMember(actor.id, task.projectId))) throw ApiError.notFound("Task");
  return task;
}

/** Live (non-deleted) dependency rows of a task, with prerequisite titles. */
async function liveDependencies(taskId: string): Promise<DependencyLite[]> {
  const edges = await prisma.taskDependency.findMany({
    where: { taskId },
    include: { dependsOn: true },
  });
  return edges.map((e) => ({
    id: e.dependsOnId,
    title: e.dependsOn.title,
    status: e.dependsOn.status,
  }));
}

/** All adjacency edges (dependent -> prerequisite) for a project's graph. */
async function projectAdjacency(projectId: string) {
  const rows = await prisma.taskDependency.findMany({
    where: { task: { projectId } },
    select: { taskId: true, dependsOnId: true },
  });
  return rows;
}

export async function createTask(actor: AuthUser, projectId: string, input: CreateTaskInput) {
  if (!canCreateTask(actor)) throw new ApiError("FORBIDDEN", "Only PMs can create tasks");
  if (!(await isMember(actor.id, projectId))) throw ApiError.notFound("Project");

  if (input.assigneeId) {
    const assignee = await prisma.user.findUnique({ where: { id: input.assigneeId } });
    if (!assignee) throw ApiError.notFound("Assignee");
  }

  const task = await prisma.$transaction(async (tx) => {
    const created = await tx.task.create({
      data: {
        projectId,
        title: input.title,
        description: input.description,
        priority: input.priority,
        dueDate: input.dueDate ? new Date(input.dueDate) : null,
        department: input.department,
        assigneeId: input.assigneeId,
        clientVisible: input.clientVisible ?? false,
        clientTitle: input.clientTitle,
        clientSummary: input.clientSummary,
      },
    });

    // CREATE audit row (one row per populated field, action CREATE).
    await writeAudit(tx, {
      taskId: created.id,
      projectId,
      userId: actor.id,
      action: "CREATE",
      changes: [
        { column: "title", oldValue: null, newValue: created.title },
        { column: "status", oldValue: null, newValue: created.status },
      ],
    });

    // Optional initial dependencies (PM-only endpoint semantics).
    if (input.dependencyIds && input.dependencyIds.length > 0) {
      const adjacency = await tx.taskDependency.findMany({
        where: { task: { projectId } },
        select: { taskId: true, dependsOnId: true },
      });
      for (const depId of input.dependencyIds) {
        const prereq = await tx.task.findUnique({ where: { id: depId } });
        if (!prereq || prereq.projectId !== projectId) {
          throw new ApiError(
            "CROSS_PROJECT_DEPENDENCY",
            "Dependency tasks must belong to the same project",
          );
        }
        const rejection = validateAddDependency(created.id, depId, {
          sameProject: true,
          adjacency: [...adjacency, { taskId: created.id, dependsOnId: depId }],
        });
        if (rejection) {
          throw new ApiError(
            rejection.code,
            rejection.message,
            "cycle" in rejection ? { cycle: rejection.cycle } : undefined,
          );
        }
        await tx.taskDependency.create({ data: { taskId: created.id, dependsOnId: depId } });
      }
    }

    return created;
  });

  return task;
}

export async function getTask(actor: AuthUser, taskId: string) {
  const task = await getVisibleTask(actor, taskId);
  const deps = await liveDependencies(task.id);
  const allowedActions = computeAllowedActions(
    { ...actor, isProjectMember: true },
    { status: task.status, assigneeId: task.assigneeId, department: task.department },
    deps,
  );
  return serializeTask(task, { dependencies: deps, allowedActions });
}

/**
 * PM-only core-field update. Optimistic locking: the body must carry the
 * client's last-seen version; mismatch -> 409 with current server state.
 */
export async function updateTask(actor: AuthUser, taskId: string, input: UpdateTaskInput) {
  return prisma.$transaction(async (tx) => {
    const task = await tx.task.findUnique({ where: { id: taskId } });
    if (!task) throw ApiError.notFound("Task");
    if (!(await isMember(actor.id, task.projectId))) throw ApiError.notFound("Task");
    if (actor.role !== "PM") throw new ApiError("FORBIDDEN", "Only PMs can edit task fields");

    const { version, ...changes } = input;
    const data: Record<string, unknown> = { ...changes };
    if ("dueDate" in changes) {
      data.dueDate = changes.dueDate ? new Date(changes.dueDate as string) : null;
    }

    // Field-level audit diff BEFORE the write (old values needed).
    const auditChanges = diffTask(task as unknown as Record<string, unknown>, data);

    // Conditional write = optimistic lock.
    const updated = await tx.task.updateMany({
      where: { id: taskId, version: version },
      data: { ...data, version: { increment: 1 } },
    });
    if (updated.count === 0) {
      const current = await tx.task.findUnique({ where: { id: taskId } });
      throw new ApiError("VERSION_CONFLICT", "Task was modified by someone else", {
        currentVersion: current?.version,
        currentTask: current,
      });
    }

    // Atomic field-level audit rows (same transaction as the write).
    await writeAudit(tx, {
      taskId,
      projectId: task.projectId,
      userId: actor.id,
      action: "UPDATE",
      changes: auditChanges,
    });

    return tx.task.findUnique({ where: { id: taskId }, include: { assignee: true } });
  });
}

/**
 * Status transition endpoint. Evaluation order (see transitions.ts):
 * membership -> state machine -> role rules -> dependency rule -> optimistic lock.
 */
export async function changeStatus(actor: AuthUser, taskId: string, input: ChangeStatusInput) {
  const task = await getVisibleTask(actor, taskId);
  const deps = await liveDependencies(task.id);
  const unfinished = deps.filter((d) => d.status !== "DONE");

  const result = evaluateTransition(task.status, input.status, {
    actor: { id: actor.id, role: actor.role, department: actor.department },
    task: { status: task.status, assigneeId: task.assigneeId, department: task.department },
    unfinishedDependencies: unfinished,
    isProjectMember: true, // getVisibleTask already enforced membership
  });

  if (!result.ok) {
    const r = result.rejection;
    if (r.kind === "INVALID_TRANSITION") {
      throw new ApiError(
        "INVALID_TRANSITION",
        `Cannot move task from ${task.status} to ${input.status}`,
      );
    }
    if (r.kind === "TASK_BLOCKED") {
      throw new ApiError("TASK_BLOCKED", "Task has unfinished dependencies", {
        blockedBy: r.blockedBy,
      });
    }
    throw new ApiError("FORBIDDEN_TRANSITION", r.reason);
  }

  // Optimistic lock via conditional write inside a transaction.
  return prisma.$transaction(async (tx) => {
    const updated = await tx.task.updateMany({
      where: { id: task.id, version: input.version },
      data: { status: input.status, version: { increment: 1 } },
    });
    if (updated.count === 0) {
      const current = await tx.task.findUnique({ where: { id: task.id } });
      throw new ApiError("VERSION_CONFLICT", "Task was modified by someone else", {
        currentVersion: current?.version,
        currentTask: current,
      });
    }

    // Atomic status audit row (same transaction as the write).
    await writeAudit(tx, {
      taskId: task.id,
      projectId: task.projectId,
      userId: actor.id,
      action: "UPDATE",
      changes: [statusChange(task.status, input.status)],
    });

    return tx.task.findUnique({ where: { id: task.id } });
  });
}

export async function softDeleteTask(actor: AuthUser, taskId: string) {
  const task = await getVisibleTask(actor, taskId);
  if (!canSoftDeleteTask(actor)) throw new ApiError("FORBIDDEN", "Only PMs can delete tasks");

  await prisma.$transaction(async (tx) => {
    await tx.task.delete({ where: { id: task.id } }); // soft via extension

    // Soft-delete dependency edges in BOTH directions so that:
    // - dependents are no longer blocked by a deleted task
    // - the deleted task holds no live edges to other tasks
    await tx.taskDependency.deleteMany({ where: { taskId: task.id } });
    await tx.taskDependency.deleteMany({ where: { dependsOnId: task.id } });

    await writeAudit(tx, {
      taskId: task.id,
      projectId: task.projectId,
      userId: actor.id,
      action: "DELETE",
      changes: [{ column: "deletedAt", oldValue: null, newValue: new Date().toISOString() }],
    });
  });
  return { ok: true };
}

export async function restoreTask(actor: AuthUser, taskId: string) {
  if (actor.role !== "PM") throw new ApiError("FORBIDDEN", "Only PMs can restore tasks");
  const raw = prisma.$includeDeleted();
  const task = await raw.task.findUnique({ where: { id: taskId } });
  if (!task) throw ApiError.notFound("Task");
  await prisma.task.update({ where: { id: taskId }, data: { deletedAt: null } });
  return { ok: true };
}

export async function addDependency(actor: AuthUser, taskId: string, dependsOnId: string) {
  if (!canManageDependencies(actor)) {
    throw new ApiError("FORBIDDEN", "Only PMs can manage dependencies");
  }
  const task = await getVisibleTask(actor, taskId);
  const prereq = await prisma.task.findUnique({ where: { id: dependsOnId } });
  if (!prereq) throw ApiError.notFound("Dependency task");

  const adjacency = await projectAdjacency(task.projectId);
  const rejection = validateAddDependency(task.id, dependsOnId, {
    sameProject: prereq.projectId === task.projectId,
    adjacency,
  });
  if (rejection) {
    throw new ApiError(
      rejection.code,
      rejection.message,
      "cycle" in rejection ? { cycle: rejection.cycle } : undefined,
    );
  }

  // Idempotent add (unique taskId+dependsOnId): revive soft-deleted edge.
  const raw = prisma.$includeDeleted();
  const existing = await raw.taskDependency.findFirst({
    where: { taskId: task.id, dependsOnId },
  });
  if (existing) {
    await prisma.taskDependency.update({ where: { id: existing.id }, data: { deletedAt: null } });
  } else {
    await prisma.taskDependency.create({ data: { taskId: task.id, dependsOnId } });
  }

  // Dependency changes are audited against the affected task.
  await prisma.$transaction((tx) =>
    writeAudit(tx, {
      taskId: task.id,
      projectId: task.projectId,
      userId: actor.id,
      action: "DEPENDENCY_ADD",
      changes: [{ column: "dependencies", oldValue: null, newValue: prereq.title }],
    }),
  );
  return { ok: true };
}

export async function removeDependency(actor: AuthUser, taskId: string, dependsOnId: string) {
  if (!canManageDependencies(actor)) {
    throw new ApiError("FORBIDDEN", "Only PMs can manage dependencies");
  }
  const task = await getVisibleTask(actor, taskId);
  const edge = await prisma.taskDependency.findFirst({ where: { taskId: task.id, dependsOnId } });
  if (!edge) throw ApiError.notFound("Dependency");
  await prisma.taskDependency.delete({ where: { id: edge.id } }); // soft

  const prereq = await prisma.task.findUnique({ where: { id: dependsOnId } });
  await prisma.$transaction((tx) =>
    writeAudit(tx, {
      taskId: task.id,
      projectId: task.projectId,
      userId: actor.id,
      action: "DEPENDENCY_REMOVE",
      changes: [{ column: "dependencies", oldValue: prereq?.title ?? dependsOnId, newValue: null }],
    }),
  );
  return { ok: true };
}

export async function listProjectTasks(actor: AuthUser, projectId: string, query: URLSearchParams) {
  // CLIENT uses /client/* endpoints exclusively.
  if (actor.role === "CLIENT") throw ApiError.notFound("Project");
  if (!(await isMember(actor.id, projectId))) throw ApiError.notFound("Project");

  const q: ParsedListQuery = parseListQuery(query, taskListWhitelist);
  const userFragments = (q.where as { AND?: unknown[] }).AND ?? [];

  const rawOrderBy = q.orderBy as Prisma.TaskOrderByWithRelationInput | undefined;
  const orderBy =
    rawOrderBy && Object.keys(rawOrderBy).length > 0 ? rawOrderBy : { createdAt: "desc" as const };

  const where: Prisma.TaskWhereInput = {
    projectId,
    deletedAt: null,
    AND: userFragments as Prisma.TaskWhereInput[],
  };

  const [tasks, total] = await Promise.all([
    prisma.task.findMany({
      where,
      orderBy,
      take: q.take,
      skip: q.skip,
      include: { assignee: true },
    }),
    prisma.task.count({ where }),
  ]);

  const withMeta = await Promise.all(
    tasks.map(async (t) => {
      const deps = await liveDependencies(t.id);
      const allowedActions = computeAllowedActions(
        { ...actor, isProjectMember: true },
        { status: t.status, assigneeId: t.assigneeId, department: t.department },
        deps,
      );
      return serializeTask(t, { dependencies: deps, allowedActions });
    }),
  );

  return { data: withMeta, meta: { page: q.page, rows: q.rows, total } };
}

export async function getBoard(actor: AuthUser, projectId: string) {
  // CLIENT uses /client/* endpoints exclusively.
  if (actor.role === "CLIENT") throw ApiError.notFound("Project");
  if (!(await isMember(actor.id, projectId))) throw ApiError.notFound("Project");

  const tasks = await prisma.task.findMany({
    where: { projectId, deletedAt: null },
    include: { assignee: true },
    orderBy: [{ createdAt: "asc" }],
  });

  const columns: Record<TaskStatus, unknown[]> = { TODO: [], IN_PROGRESS: [], DONE: [] };
  for (const t of tasks) {
    const deps = await liveDependencies(t.id);
    const allowedActions = computeAllowedActions(
      { ...actor, isProjectMember: true },
      { status: t.status, assigneeId: t.assigneeId, department: t.department },
      deps,
    );
    const col = isBlocked(t.status, deps) ? "TODO" : t.status;
    columns[col].push(serializeTaskForBoard(t, deps, allowedActions));
  }
  return columns;
}

export { blockedBy, isBlocked, projectListWhitelist };
