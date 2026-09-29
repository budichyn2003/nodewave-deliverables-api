import type { FieldChange } from "./diff";
import type { PrismaClientOrTx } from "./types";

/**
 * Writes audit rows inside the SAME transaction as the change they describe
 * (atomic: no change without a log, no log without a change). The audit
 * table is append-only — DB trigger rejects UPDATE/DELETE.
 */
export async function writeAudit(
  tx: PrismaClientOrTx,
  input: {
    taskId: string;
    projectId: string;
    userId: string;
    action: "CREATE" | "UPDATE" | "DELETE" | "RESTORE" | "DEPENDENCY_ADD" | "DEPENDENCY_REMOVE";
    changes: FieldChange[];
  },
): Promise<void> {
  if (input.changes.length === 0) return;
  await tx.taskAuditLog.createMany({
    data: input.changes.map((c) => ({
      taskId: input.taskId,
      projectId: input.projectId,
      userId: input.userId,
      column: c.column,
      oldValue: c.oldValue,
      newValue: c.newValue,
      action: input.action,
    })),
  });
}
