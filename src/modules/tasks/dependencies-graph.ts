/**
 * Pure dependency-graph rules — cycle detection via DFS. Unit-tested
 * without a DB; the service feeds it edges fetched from Prisma.
 */

export interface GraphEdge {
  taskId: string;
  dependsOnId: string;
}

export type DependencyRejection =
  | { code: "SELF_DEPENDENCY"; message: string }
  | { code: "CROSS_PROJECT_DEPENDENCY"; message: string }
  | { code: "DEPENDENCY_CYCLE"; message: string; cycle: string[] };

/**
 * Validates adding taskId -> dependsOnId.
 * adjacency: existing edges keyed by taskId (dependencies point FROM the
 * dependent TO the prerequisite; a cycle is any path from dependsOnId back
 * to taskId).
 */
export function validateAddDependency(
  taskId: string,
  dependsOnId: string,
  opts: { sameProject: boolean; adjacency: GraphEdge[] },
): DependencyRejection | null {
  if (taskId === dependsOnId) {
    return { code: "SELF_DEPENDENCY", message: "A task cannot depend on itself" };
  }
  if (!opts.sameProject) {
    return {
      code: "CROSS_PROJECT_DEPENDENCY",
      message: "Dependency tasks must belong to the same project",
    };
  }

  // Build adjacency map: dependent -> prerequisites.
  const map = new Map<string, string[]>();
  for (const e of opts.adjacency) {
    const list = map.get(e.taskId) ?? [];
    list.push(e.dependsOnId);
    map.set(e.taskId, list);
  }

  // DFS from dependsOnId: if we can reach taskId, adding the edge closes a cycle.
  const stack = [...(map.get(dependsOnId) ?? [])];
  const visited = new Set<string>([dependsOnId]);

  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (current === taskId) {
      // Reconstruct the cycle for the error details.
      const cycle: string[] = [taskId, dependsOnId];
      cycle.push(...ancestorsOf(map, dependsOnId, taskId));
      return {
        code: "DEPENDENCY_CYCLE",
        message: "Adding this dependency would create a cycle",
        cycle: [...new Set(cycle)],
      };
    }
    if (visited.has(current)) continue;
    visited.add(current);
    for (const next of map.get(current) ?? []) {
      if (!visited.has(next)) stack.push(next);
    }
  }

  return null;
}

function ancestorsOf(map: Map<string, string[]>, from: string, target: string): string[] {
  // Find the path from -> target (BFS) to make the cycle readable.
  const queue: string[] = [from];
  const parent = new Map<string, string | null>([[from, null]]);
  while (queue.length > 0) {
    const node = queue.shift() as string;
    if (node === target) break;
    for (const next of map.get(node) ?? []) {
      if (!parent.has(next)) {
        parent.set(next, node);
        queue.push(next);
      }
    }
  }
  const path: string[] = [];
  let cur: string | null = target;
  while (cur !== null && cur !== undefined) {
    path.unshift(cur);
    cur = parent.get(cur) ?? null;
  }
  path.pop(); // drop duplicated target at the front end
  return path.filter((n) => n !== from);
}
