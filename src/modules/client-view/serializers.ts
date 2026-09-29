import type { Task } from "../../../generated/prisma/client";
import { type DependencyLite, effectiveStatus } from "../tasks/blocked";

/**
 * CLIENT serializers — explicit allow-list ONLY.
 *
 * These objects are constructed field-by-field (never by deleting fields
 * from an internal shape), so a new internal field can never leak by
 * accident. Forbidden by design: assignee/assigneeId, department, user
 * emails, avatarUrl, comments, attachments, audit logs, dependency titles.
 */

export interface ClientProjectShape {
  id: string;
  name: string;
  description: string | null;
  createdAt: Date;
}

export function serializeClientProject(project: ClientProjectShape): Record<string, unknown> {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    createdAt: project.createdAt,
  };
}

export interface ClientMetrics {
  totalTasks: number;
  doneTasks: number;
  percentComplete: number;
}

export function serializeClientMetrics(metrics: ClientMetrics): Record<string, unknown> {
  return {
    totalTasks: metrics.totalTasks,
    doneTasks: metrics.doneTasks,
    percentComplete: metrics.percentComplete,
  };
}

export interface ClientTaskInput {
  task: Pick<
    Task,
    "id" | "status" | "clientVisible" | "clientTitle" | "title" | "dueDate" | "updatedAt"
  >;
  dependencies: DependencyLite[];
}

/** Client-safe task: client-safe title + effective status + dates only. */
export function serializeClientTask({
  task,
  dependencies,
}: ClientTaskInput): Record<string, unknown> {
  return {
    id: task.id,
    // clientTitle is the PM-approved client-safe text; fall back to a masked
    // notice (NOT the internal title) when unset.
    title: task.clientTitle ?? "(details pending)",
    status: task.status,
    effectiveStatus: effectiveStatus(task.status, dependencies),
    dueDate: task.dueDate,
    updatedAt: task.updatedAt,
  };
}
