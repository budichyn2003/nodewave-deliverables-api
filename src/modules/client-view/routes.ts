import { Hono } from "hono";
import { ok, okList } from "../../lib/http";
import { auth } from "../../middleware/auth";
import type { AppEnv } from "../../types";
import * as svc from "./service";

export const clientViewRoutes = new Hono<AppEnv>();

clientViewRoutes.use("/client/*", auth());

clientViewRoutes.get("/client/project", async (c) => {
  const user = c.get("user");
  const result = await svc.getClientProject(user);
  return ok(c, result);
});

clientViewRoutes.get("/client/tasks", async (c) => {
  const user = c.get("user");
  const result = await svc.getClientTasks(user, new URLSearchParams(c.req.query()));
  return okList(c, result.data, result.meta);
});
