import { Hono } from "hono";
import { ApiError } from "../../lib/errors";
import { ok, okList } from "../../lib/http";
import { auth } from "../../middleware/auth";
import type { AppEnv } from "../../types";
import { addMemberSchema, createProjectSchema, updateProjectSchema } from "./schemas";
import { serializeProject } from "./serializers";
import * as svc from "./service";

export const projectRoutes = new Hono<AppEnv>();

projectRoutes.use("/projects/*", auth());
projectRoutes.use("/projects", auth());

async function parseBody(c: { req: { json(): Promise<unknown> } }): Promise<unknown> {
  return c.req.json().catch(() => {
    throw new ApiError("MALFORMED_JSON", "Request body is not valid JSON");
  });
}

projectRoutes.post("/projects", async (c) => {
  const user = c.get("user");
  const input = createProjectSchema.parse(await parseBody(c));
  const project = await svc.createProject(user, input);
  return ok(c, serializeProject(project), 201);
});

projectRoutes.get("/projects", async (c) => {
  const user = c.get("user");
  const result = await svc.listProjects(user, new URLSearchParams(c.req.query()));
  return okList(c, result.data, result.meta);
});

projectRoutes.get("/projects/:id", async (c) => {
  const user = c.get("user");
  const project = await svc.getProject(user, c.req.param("id"));
  if (!project) throw ApiError.notFound("Project");
  return ok(c, serializeProject(project));
});

projectRoutes.patch("/projects/:id", async (c) => {
  const user = c.get("user");
  const input = updateProjectSchema.parse(await parseBody(c));
  const project = await svc.updateProject(user, c.req.param("id"), input);
  return ok(c, serializeProject(project));
});

projectRoutes.delete("/projects/:id", async (c) => {
  const user = c.get("user");
  const result = await svc.softDeleteProject(user, c.req.param("id"));
  return ok(c, result);
});

projectRoutes.post("/projects/:id/members", async (c) => {
  const user = c.get("user");
  const input = addMemberSchema.parse(await parseBody(c));
  const member = await svc.addMember(user, c.req.param("id"), input.userId);
  return ok(c, { id: member.id, projectId: member.projectId, userId: member.userId }, 201);
});

projectRoutes.delete("/projects/:id/members/:userId", async (c) => {
  const user = c.get("user");
  const result = await svc.removeMember(user, c.req.param("id"), c.req.param("userId"));
  return ok(c, result);
});
