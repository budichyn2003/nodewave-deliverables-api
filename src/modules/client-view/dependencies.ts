import { prisma } from "../../lib/prisma";
import type { DependencyLite } from "../tasks/blocked";

/** Live (non-deleted) dependency rows of a task, with prerequisite statuses. */
export async function liveDependencies(taskId: string): Promise<DependencyLite[]> {
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
