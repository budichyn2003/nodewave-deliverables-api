import type { AuthUser } from "../types";

/**
 * Pure RBAC policies for tasks (state/dependency rules live in
 * modules/tasks/transitions.ts — the ABAC half).
 */
export function canCreateTask(user: AuthUser): boolean {
  return user.role === "PM";
}

/** Core-field edits: title/description/assignee/priority/dueDate/clientVisible. */
export function canEditTaskCore(user: AuthUser): boolean {
  return user.role === "PM";
}

export function canSoftDeleteTask(user: AuthUser): boolean {
  return user.role === "PM";
}

export function canRestoreTask(user: AuthUser): boolean {
  return user.role === "PM";
}

/** Only the PM defines/removes dependency edges. */
export function canManageDependencies(user: AuthUser): boolean {
  return user.role === "PM";
}

/** Status changes: PM (except completing) and INTERNAL members, per transitions.ts. */
export function canChangeStatus(user: AuthUser): boolean {
  return user.role === "PM" || user.role === "INTERNAL";
}

/** Attachments: PM and INTERNAL members; never CLIENT. */
export function canUploadAttachment(user: AuthUser): boolean {
  return user.role === "PM" || user.role === "INTERNAL";
}

/** Internal comments: PM and INTERNAL; CLIENT cannot even read them. */
export function canCommentInternally(user: AuthUser): boolean {
  return user.role === "PM" || user.role === "INTERNAL";
}

/** Audit trail visibility: PM only (kept strict and simple). */
export function canViewAudit(user: AuthUser): boolean {
  return user.role === "PM";
}
