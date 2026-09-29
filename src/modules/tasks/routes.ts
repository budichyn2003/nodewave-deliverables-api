import { Hono } from "hono";
import { ApiError } from "../../lib/errors";
import { ok, okList } from "../../lib/http";
import { auth } from "../../middleware/auth";
import type { AppEnv } from "../../types";
import { listTaskAudit } from "../audit/service";
import {
  addDependencySchema,
  changeStatusSchema,
  createTaskSchema,
  updateTaskSchema,
} from "./schemas";
import * as svc from "./service";

export const taskRoutes = new Hono<AppEnv>();

taskRoutes.use("/tasks/*", auth());
taskRoutes.use("/tasks", auth());
taskRoutes.use("/projects/*", auth());

async function parseBody(c: { req: { json(): Promise<unknown> } }): Promise<unknown> {
  return c.req.json().catch(() => {
    throw new ApiError("MALFORMED_JSON", "Request body is not valid JSON");
  });
}

// --- Task CRUD & transitions ---

taskRoutes.post("/projects/:id/tasks", async (c) => {
  const user = c.get("user");
  const input = createTaskSchema.parse(await parseBody(c));
  const task = await svc.createTask(user, c.req.param("id"), input);
  return ok(c, { id: task.id }, 201);
});

taskRoutes.get("/projects/:id/tasks", async (c) => {
  const user = c.get("user");
  const result = await svc.listProjectTasks(
    user,
    c.req.param("id"),
    new URLSearchParams(c.req.query()),
  );
  return okList(c, result.data, result.meta);
});

taskRoutes.get("/projects/:id/board", async (c) => {
  const user = c.get("user");
  const board = await svc.getBoard(user, c.req.param("id"));
  return ok(c, board);
});

taskRoutes.get("/tasks/:id", async (c) => {
  const user = c.get("user");
  const task = await svc.getTask(user, c.req.param("id"));
  return ok(c, task);
});

taskRoutes.patch("/tasks/:id", async (c) => {
  const user = c.get("user");
  const input = updateTaskSchema.parse(await parseBody(c));
  const task = await svc.updateTask(user, c.req.param("id"), input);
  return ok(c, task);
});

taskRoutes.post("/tasks/:id/status", async (c) => {
  const user = c.get("user");
  const input = changeStatusSchema.parse(await parseBody(c));
  const task = await svc.changeStatus(user, c.req.param("id"), input);
  return ok(c, task);
});

taskRoutes.delete("/tasks/:id", async (c) => {
  const user = c.get("user");
  const result = await svc.softDeleteTask(user, c.req.param("id"));
  return ok(c, result);
});

taskRoutes.post("/tasks/:id/restore", async (c) => {
  const user = c.get("user");
  const result = await svc.restoreTask(user, c.req.param("id"));
  return ok(c, result);
});

// --- Dependencies (PM only) ---

taskRoutes.post("/tasks/:id/dependencies", async (c) => {
  const user = c.get("user");
  const input = addDependencySchema.parse(await parseBody(c));
  const result = await svc.addDependency(user, c.req.param("id"), input.dependsOnId);
  return ok(c, result, 201);
});

taskRoutes.delete("/tasks/:id/dependencies/:dependsOnId", async (c) => {
  const user = c.get("user");
  const result = await svc.removeDependency(user, c.req.param("id"), c.req.param("dependsOnId"));
  return ok(c, result);
});

// --- Audit trail (PM only, append-only log) ---

taskRoutes.get("/projects/:projectId/tasks/:taskId/audit", async (c) => {
  const user = c.get("user");
  const result = await listTaskAudit(
    user,
    c.req.param("projectId"),
    c.req.param("taskId"),
    new URLSearchParams(c.req.query()),
  );
  return okList(c, result.data, result.meta);
});
