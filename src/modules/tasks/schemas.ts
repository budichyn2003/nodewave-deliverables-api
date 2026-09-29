import { z } from "zod";
import type { ListWhitelist } from "../../lib/ezfilter";

export const createTaskSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(8000).optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).optional(),
  dueDate: z.string().datetime().nullable().optional(),
  department: z.enum(["UIUX", "FRONTEND", "BACKEND"]).nullable().optional(),
  assigneeId: z.string().uuid().nullable().optional(),
  clientVisible: z.boolean().optional(),
  clientTitle: z.string().max(200).nullable().optional(),
  clientSummary: z.string().max(2000).nullable().optional(),
  dependencyIds: z.array(z.string().uuid()).optional(),
});

export const updateTaskSchema = z
  .object({
    version: z.number().int().positive({ message: "version is required for optimistic locking" }),
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(8000).nullable().optional(),
    priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).optional(),
    dueDate: z.string().datetime().nullable().optional(),
    department: z.enum(["UIUX", "FRONTEND", "BACKEND"]).nullable().optional(),
    assigneeId: z.string().uuid().nullable().optional(),
    clientVisible: z.boolean().optional(),
    clientTitle: z.string().max(200).nullable().optional(),
    clientSummary: z.string().max(2000).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 1, { message: "No fields to update" });

export const changeStatusSchema = z.object({
  version: z.number().int().positive({ message: "version is required for optimistic locking" }),
  status: z.enum(["TODO", "IN_PROGRESS", "DONE"]),
});

export const addDependencySchema = z.object({
  dependsOnId: z.string().uuid(),
});

/** Whitelist for GET /tasks (ezfilter contract). */
export const taskListWhitelist: ListWhitelist = {
  filterable: ["status", "priority", "department", "assigneeId", "clientVisible", "projectId"],
  searchable: ["title", "description"],
  searchableTypes: { title: "string", description: "string" },
  rangable: ["dueDate", "createdAt", "updatedAt"],
  sortable: ["title", "status", "priority", "dueDate", "createdAt", "updatedAt"],
};

export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;
export type ChangeStatusInput = z.infer<typeof changeStatusSchema>;
