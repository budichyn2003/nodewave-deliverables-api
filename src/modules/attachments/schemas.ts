import { z } from "zod";
import type { ListWhitelist } from "../../lib/ezfilter";

export const attachmentResponseSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  fileName: z.string(),
  url: z.string(),
  mimeType: z.string(),
  size: z.number().int(),
  uploadedBy: z.object({ id: z.string(), name: z.string() }),
  createdAt: z.date(),
});

/** Whitelist for GET /tasks/:id/attachments (ezfilter contract). */
export const attachmentListWhitelist: ListWhitelist = {
  filterable: ["mimeType"],
  searchable: ["fileName"],
  searchableTypes: { fileName: "string", mimeType: "string" },
  rangable: ["createdAt", "size"],
  sortable: ["fileName", "size", "createdAt"],
};

export type AttachmentResponse = z.infer<typeof attachmentResponseSchema>;
