import type { ListWhitelist } from "../../lib/ezfilter";

/**
 * Whitelist for GET /client/tasks. Deliberately minimal: clients may filter
 * on status/priority-safe/dueDate columns only. `clientVisible` itself is
 * NOT filterable — the server forces it to true. `assigneeId`, `department`
 * and every internal-only column are absent by design.
 */
export const clientTaskListWhitelist: ListWhitelist = {
  filterable: ["status", "dueDate"],
  searchable: ["clientTitle"],
  searchableTypes: { clientTitle: "string" },
  rangable: ["dueDate", "updatedAt"],
  sortable: ["dueDate", "updatedAt", "status"],
};
