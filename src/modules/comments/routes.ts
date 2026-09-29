import { Hono } from "hono";
import { ApiError } from "../../lib/errors";
import { ok, okList } from "../../lib/http";
import { auth } from "../../middleware/auth";
import type { AppEnv } from "../../types";
import { createCommentSchema } from "./schemas";
import * as svc from "./service";

export const commentRoutes = new Hono<AppEnv>();

commentRoutes.use("/tasks/*", auth());

commentRoutes.post("/tasks/:id/comments", async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => {
    throw new ApiError("MALFORMED_JSON", "Request body is not valid JSON");
  });
  const input = createCommentSchema.parse(body);
  const created = await svc.createComment(user, c.req.param("id"), input);
  return ok(
    c,
    { id: created.id, taskId: created.taskId, body: created.body, isInternal: created.isInternal },
    201,
  );
});

commentRoutes.get("/tasks/:id/comments", async (c) => {
  const user = c.get("user");
  const result = await svc.listComments(
    user,
    c.req.param("id"),
    new URLSearchParams(c.req.query()),
  );
  return okList(c, result.data, result.meta);
});
