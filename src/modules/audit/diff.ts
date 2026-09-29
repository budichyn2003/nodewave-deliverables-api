/**
 * Generic field-level diff: one entry per changed field. Pure and
 * unit-tested; used by the audit writer inside task mutations.
 */

/** Fields that must never be audited as "changes". */
const IGNORED_FIELDS = new Set(["version", "updatedAt"]);

export interface FieldChange {
  column: string;
  oldValue: string | null;
  newValue: string | null;
}

/** JSON-safe scalar stringification: dates -> ISO, objects -> JSON, undefined/null -> null. */
function stringify(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * Diffs two task-shaped records. Only keys present in `changes` (the
 * requested update) are compared, so untouched fields never produce rows.
 */
export function diffTask(
  before: Record<string, unknown>,
  changes: Record<string, unknown>,
): FieldChange[] {
  const out: FieldChange[] = [];
  for (const [column, newValue] of Object.entries(changes)) {
    if (IGNORED_FIELDS.has(column)) continue;
    const oldValue = before[column];
    const oldStr = stringify(oldValue);
    const newStr = stringify(newValue);
    if (oldStr !== newStr) {
      out.push({ column, oldValue: oldStr, newValue: newStr });
    }
  }
  return out;
}

/** Builds an audit row for a status transition (convenience for /status). */
export function statusChange(from: string, to: string): FieldChange {
  return { column: "status", oldValue: from, newValue: to };
}
