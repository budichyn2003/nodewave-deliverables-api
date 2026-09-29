import { Hono } from "hono";
import { ok } from "../../lib/http";
import { auth } from "../../middleware/auth";
import type { AppEnv } from "../../types";
import { getStandup } from "./service";

export const standupRoutes = new Hono<AppEnv>();

standupRoutes.use("/projects/*", auth());

standupRoutes.get("/projects/:id/standup", async (c) => {
  const user = c.get("user");
  const date = c.req.query("date");
  const result = await getStandup(user, c.req.param("id"), date);
  return ok(c, result);
});
