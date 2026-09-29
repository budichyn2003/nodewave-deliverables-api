import { z } from "zod";
import type { ListWhitelist } from "../../lib/ezfilter";

export const createCommentSchema = z.object({
  body: z.string().min(1).max(4000),
  isInternal: z.boolean().optional(),
});

export const commentListWhitelist: ListWhitelist = {
  filterable: ["isInternal", "authorId"],
  searchable: ["body"],
  searchableTypes: { body: "string" },
  rangable: ["createdAt"],
  sortable: ["createdAt"],
};

export type CreateCommentInput = z.infer<typeof createCommentSchema>;
