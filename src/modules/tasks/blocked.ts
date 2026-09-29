import type { TaskStatus } from "../../../generated/prisma/client";

/**
 * BLOCKED is derived, never stored: a task is blocked when it has at least
 * one non-deleted dependency whose status is not DONE (and the task itself
 * is not DONE). Pure functions — unit-tested without a DB.
 */
export interface DependencyLite {
  id: string;
  title: string;
  status: TaskStatus;
}

export function isBlocked(taskStatus: TaskStatus, dependencies: DependencyLite[]): boolean {
  if (taskStatus === "DONE") return false;
  return dependencies.some((d) => d.status !== "DONE");
}

export function blockedBy(
  taskStatus: TaskStatus,
  dependencies: DependencyLite[],
): DependencyLite[] {
  if (taskStatus === "DONE") return [];
  return dependencies.filter((d) => d.status !== "DONE");
}

/** effectiveStatus: BLOCKED when blocked, otherwise the stored status. */
export type EffectiveStatus = TaskStatus | "BLOCKED";

export function effectiveStatus(
  taskStatus: TaskStatus,
  dependencies: DependencyLite[],
): EffectiveStatus {
  return isBlocked(taskStatus, dependencies) ? "BLOCKED" : taskStatus;
}

/**
 * Example (from the brief):
 * Task C (Frontend Slicing) depends on A (UI Design, DONE) and B (Backend
 * API, IN_PROGRESS) -> C is BLOCKED until BOTH A and B are DONE.
 */
