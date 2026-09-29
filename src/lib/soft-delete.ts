/**
 * Soft-delete conventions (documented in docs/ARCHITECTURE.md):
 * - A model is "soft-deletable" when it carries a `deletedAt` column.
 * - TaskAuditLog is NOT soft-deletable: it is append-only and immutable
 *   (enforced by a PostgreSQL trigger migration).
 *
 * These sets drive the Prisma client extension and are kept as plain data so
 * they can be unit-tested without a DB.
 */

/** Models with a `deletedAt` column (every deletable entity). */
export const SOFT_DELETE_MODELS = new Set([
  "User",
  "Project",
  "ProjectMember",
  "Task",
  "TaskDependency",
  "Attachment",
  "Comment",
]);

/** Read operations that must exclude soft-deleted rows by default. */
export const FILTERED_READ_OPS = new Set([
  "findMany",
  "findFirst",
  "findFirstOrThrow",
  "findUnique",
  "findUniqueOrThrow",
  "count",
  "aggregate",
  "groupBy",
]);

/** Write operations whose `where` must also exclude deleted rows. */
export const FILTERED_WRITE_OPS = new Set([
  "updateMany",
  "update",
  "upsert",
  "delete",
  "deleteMany",
]);

/**
 * Standard `deletedAt: null` clause. Spread into a where object, or used
 * standalone. Accepts a modifier so callers can express `deletedAt: { not: null }`.
 */
export function notDeleted(): { deletedAt: null } {
  return { deletedAt: null };
}

/** Inverse clause for explicit "look at the graveyard" queries. */
export function onlyDeleted(): { deletedAt: { not: null } } {
  return { deletedAt: { not: null } };
}

/** Merges `deletedAt: null` into a user-supplied where without clobbering it. */
export function withNotDeleted<T extends Record<string, unknown> | undefined>(
  where: T,
): T & { deletedAt: null } {
  return { ...(where ?? {}), deletedAt: null } as T & { deletedAt: null };
}
