import { z } from "zod";
import type { ListWhitelist } from "../../lib/ezfilter";

export const createProjectSchema = z.object({
  name: z.string().min(1).max(160),
  description: z.string().max(4000).optional(),
});

export const updateProjectSchema = z.object({
  name: z.string().min(1).max(160).optional(),
  description: z.string().max(4000).nullable().optional(),
});

export const addMemberSchema = z.object({
  userId: z.string().uuid(),
});

/** Whitelist for GET /projects (ezfilter contract). */
export const projectListWhitelist: ListWhitelist = {
  filterable: ["name", "description"],
  searchable: ["name", "description"],
  searchableTypes: { name: "string", description: "string" },
  rangable: ["createdAt", "updatedAt"],
  sortable: ["name", "createdAt", "updatedAt"],
};

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;
