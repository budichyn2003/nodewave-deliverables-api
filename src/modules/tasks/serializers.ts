import type { Attachment, Comment, Task, TaskStatus, User } from "../../../generated/prisma/client";
import type { AllowedActions } from "./allowed-actions";
import type { DependencyLite } from "./blocked";
import { blockedBy, effectiveStatus, isBlocked } from "./blocked";

export interface SerializeTaskOptions {
  dependencies: DependencyLite[];
  allowedActions: AllowedActions;
  includeMembers?: boolean;
  attachments?: (Attachment & { uploadedBy: User })[];
  comments?: (Comment & { author: User })[];
}

/**
 * Internal task shape (PM/INTERNAL viewers). Contains assignee, department,
 * dependency details and optionally comments/attachments — must NEVER be
 * reused for client responses; modules/client-view has its own whitelist.
 */
export function serializeTask(
  task: Task & { assignee?: User | null },
  opts: SerializeTaskOptions,
): Record<string, unknown> {
  const deps = opts.dependencies;
  return {
    id: task.id,
    projectId: task.projectId,
    title: task.title,
    description: task.description,
    status: task.status,
    effectiveStatus: effectiveStatus(task.status, deps),
    isBlocked: isBlocked(task.status, deps),
    blockedBy: blockedBy(task.status, deps),
    priority: task.priority,
    dueDate: task.dueDate,
    department: task.department,
    assignee: task.assignee
      ? { id: task.assignee.id, name: task.assignee.name, department: task.assignee.department }
      : null,
    assigneeId: task.assigneeId,
    clientVisible: task.clientVisible,
    clientTitle: task.clientTitle,
    clientSummary: task.clientSummary,
    version: task.version,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    allowedActions: opts.allowedActions,
    ...(opts.attachments
      ? {
          attachments: opts.attachments.map((a) => ({
            id: a.id,
            fileName: a.fileName,
            mimeType: a.mimeType,
            size: a.size,
            url: a.url,
            uploadedBy: { id: a.uploadedBy.id, name: a.uploadedBy.name },
            createdAt: a.createdAt,
          })),
        }
      : {}),
    ...(opts.comments
      ? {
          comments: opts.comments.map((cm) => ({
            id: cm.id,
            body: cm.body,
            isInternal: cm.isInternal,
            author: { id: cm.author.id, name: cm.author.name },
            createdAt: cm.createdAt,
          })),
        }
      : {}),
  };
}

/** Light shape for the board endpoint. */
export function serializeTaskForBoard(
  task: Task & { assignee?: User | null },
  deps: DependencyLite[],
  allowedActions: AllowedActions,
): Record<string, unknown> {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    effectiveStatus: effectiveStatus(task.status, deps),
    isBlocked: isBlocked(task.status, deps),
    blockedBy: blockedBy(task.status, deps),
    priority: task.priority,
    department: task.department,
    assignee: task.assignee ? { id: task.assignee.id, name: task.assignee.name } : null,
    dueDate: task.dueDate,
    version: task.version,
    allowedActions,
  };
}

export function statusOf(task: Task): TaskStatus {
  return task.status;
}
