import type { TaskStatus } from "../../../generated/prisma/client";

/**
 * Stored-status state machine. BLOCKED is never stored — it is derived from
 * dependencies (see blocked.ts).
 *
 * Reopen paths (documented assumption in docs/ARCHITECTURE.md):
 * - IN_PROGRESS -> TODO   (send a task back to the backlog)
 * - DONE -> IN_PROGRESS   (reopen; dependency rule still applies — a reopened
 *   task must not have unfinished prerequisites)
 */
export const ALLOWED_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  TODO: ["IN_PROGRESS"],
  IN_PROGRESS: ["DONE", "TODO"],
  DONE: ["IN_PROGRESS"],
};

export function isTransitionAllowed(from: TaskStatus, to: TaskStatus): boolean {
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

/** Reasons a transition can be rejected — mirrors the API error codes. */
export type TransitionRejection =
  | { kind: "INVALID_TRANSITION" }
  | { kind: "FORBIDDEN_TRANSITION"; reason: "NOT_ASSIGNEE" | "PM_CANNOT_COMPLETE" | "NOT_A_MEMBER" }
  | { kind: "TASK_BLOCKED"; blockedBy: { id: string; title: string; status: TaskStatus }[] };

/** Inputs for the pure transition evaluator. */
export interface TransitionContext {
  actor: {
    id: string;
    role: "PM" | "INTERNAL" | "CLIENT";
    department: "UIUX" | "FRONTEND" | "BACKEND" | null;
  };
  task: {
    status: TaskStatus;
    assigneeId: string | null;
    department: "UIUX" | "FRONTEND" | "BACKEND" | null;
  };
  /** Live prerequisites that are not DONE. */
  unfinishedDependencies: { id: string; title: string; status: TaskStatus }[];
  /** Whether the actor is a live member of the task's project. */
  isProjectMember: boolean;
}

/**
 * Pure transition evaluation, applied in the brief's order:
 * 1. membership (ABAC)          -> FORBIDDEN_TRANSITION / NOT_A_MEMBER
 * 2. state machine              -> INVALID_TRANSITION
 * 3. role rules (RBAC)          -> FORBIDDEN_TRANSITION
 * 4. dependency rule            -> TASK_BLOCKED (with blockedBy details)
 *
 * (Optimistic-lock check is order 5 but lives in the service — it needs the DB.)
 */
export function evaluateTransition(
  from: TaskStatus,
  to: TaskStatus,
  ctx: TransitionContext,
): { ok: true } | { ok: false; rejection: TransitionRejection } {
  // 1. The actor must be able to see the task at all.
  if (!ctx.isProjectMember || ctx.actor.role === "CLIENT") {
    return { ok: false, rejection: { kind: "FORBIDDEN_TRANSITION", reason: "NOT_A_MEMBER" } };
  }

  // 2. State machine.
  if (!isTransitionAllowed(from, to)) {
    return { ok: false, rejection: { kind: "INVALID_TRANSITION" } };
  }

  const completing = to === "DONE";

  // 3a. Only the assigned executor may complete a task.
  if (completing && ctx.task.assigneeId !== ctx.actor.id) {
    if (ctx.actor.role === "PM") {
      return {
        ok: false,
        rejection: { kind: "FORBIDDEN_TRANSITION", reason: "PM_CANNOT_COMPLETE" },
      };
    }
    return { ok: false, rejection: { kind: "FORBIDDEN_TRANSITION", reason: "NOT_ASSIGNEE" } };
  }

  // 3b. PM may move any task except completing one (handled above).
  if (completing && ctx.actor.role !== "INTERNAL" && ctx.actor.role !== "PM") {
    return { ok: false, rejection: { kind: "FORBIDDEN_TRANSITION", reason: "NOT_A_MEMBER" } };
  }

  // 4. Starting work requires every dependency to be DONE.
  if (to === "IN_PROGRESS" && ctx.unfinishedDependencies.length > 0) {
    return {
      ok: false,
      rejection: { kind: "TASK_BLOCKED", blockedBy: ctx.unfinishedDependencies },
    };
  }

  return { ok: true };
}
