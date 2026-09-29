import { Hono } from "hono";
import { ok, okList } from "../../lib/http";
import { auth } from "../../middleware/auth";
import type { AppEnv } from "../../types";
import * as svc from "./service";

export const attachmentRoutes = new Hono<AppEnv>();

attachmentRoutes.use("/tasks/*", auth());

attachmentRoutes.post("/tasks/:id/attachments", async (c) => {
  const user = c.get("user");
  const taskId = c.req.param("id");

  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return ok(c, { error: "file field is required" }, 400);
  }
  const buffer = Buffer.from(await file.arrayBuffer());

  const created = await svc.uploadAttachment(user, taskId, {
    name: file.name,
    type: file.type || "application/octet-stream",
    size: buffer.byteLength,
    data: buffer,
  });
  return ok(
    c,
    {
      id: created.id,
      taskId: created.taskId,
      fileName: created.fileName,
      url: created.url,
      mimeType: created.mimeType,
      size: created.size,
      createdAt: created.createdAt,
    },
    201,
  );
});

attachmentRoutes.get("/tasks/:id/attachments", async (c) => {
  const user = c.get("user");
  const result = await svc.listAttachments(
    user,
    c.req.param("id"),
    new URLSearchParams(c.req.query()),
  );
  return okList(c, result.data, result.meta);
});
