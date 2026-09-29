import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { disconnectTestDb, resetDatabase, seedUser } from "./helpers/db";
import { makeClient } from "./helpers/http";

const app = createApp();
const client = makeClient(app);

interface Setup {
  pmToken: string;
  clientAToken: string;
  clientBToken: string;
  projectAId: string;
  projectBId: string;
}

async function setup(): Promise<Setup> {
  const pm = await seedUser({ email: "pm@t.test", name: "PM", role: "PM" });
  const fe = await seedUser({
    email: "fe@t.test",
    name: "SecretFE",
    role: "INTERNAL",
    department: "FRONTEND",
  });
  const cliA = await seedUser({ email: "a@t.test", name: "Client A", role: "CLIENT" });
  const cliB = await seedUser({ email: "b@t.test", name: "Client B", role: "CLIENT" });

  const login = async (email: string) => {
    const res = await client.post("/api/v1/auth/login", { email, password: "Password123!" });
    return ((await res.json()) as { data: { token: string } }).data.token;
  };
  const pmToken = await login("pm@t.test");
  const clientAToken = await login("a@t.test");
  const clientBToken = await login("b@t.test");

  const projA = await client.post("/api/v1/projects", { name: "Project A" }, pmToken);
  const projectAId = ((await projA.json()) as { data: { id: string } }).data.id;
  const projB = await client.post("/api/v1/projects", { name: "Project B" }, pmToken);
  const projectBId = ((await projB.json()) as { data: { id: string } }).data.id;

  for (const u of [pm, fe, cliA]) {
    await client.post(`/api/v1/projects/${projectAId}/members`, { userId: u.id }, pmToken);
  }
  for (const u of [pm, cliB]) {
    await client.post(`/api/v1/projects/${projectBId}/members`, { userId: u.id }, pmToken);
  }

  // Tasks in A: some client-visible, some not; one DONE for metrics.
  await client.post(
    `/api/v1/projects/${projectAId}/tasks`,
    {
      title: "Public Task",
      clientVisible: true,
      clientTitle: "Customer onboarding flow",
      department: "FRONTEND",
      assigneeId: fe.id,
      clientSummary: "We are building your onboarding flow.",
    },
    pmToken,
  );
  await client.post(
    `/api/v1/projects/${projectAId}/tasks`,
    { title: "Internal Task", department: "BACKEND", assigneeId: fe.id },
    pmToken,
  );
  await client.post(
    `/api/v1/projects/${projectAId}/tasks`,
    { title: "Done Task", clientVisible: true, clientTitle: "Delivered item" },
    pmToken,
  );
  const done = await prisma.task.findFirst({ where: { title: "Done Task" } });
  await prisma.task.update({ where: { id: done!.id }, data: { status: "DONE" } });

  // Task in B with a dependency edge inside A's task set (no cross-project edges).
  await client.post(
    `/api/v1/projects/${projectBId}/tasks`,
    { title: "B Task", clientVisible: true },
    pmToken,
  );

  return { pmToken, clientAToken, clientBToken, projectAId, projectBId };
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await disconnectTestDb();
});

describe("GET /client/project", () => {
  test("masked project info + honest aggregate metrics over ALL tasks", async () => {
    const f = await setup();
    const res = await client.get("/api/v1/client/project", f.clientAToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        project: { name: string };
        metrics: { totalTasks: number; doneTasks: number; percentComplete: number };
      };
    };
    expect(body.data.project.name).toBe("Project A");
    // Metrics over ALL non-deleted tasks (3 in A, 1 DONE) — honest progress.
    expect(body.data.metrics.totalTasks).toBe(3);
    expect(body.data.metrics.doneTasks).toBe(1);
    expect(body.data.metrics.percentComplete).toBe(33);
  });

  test("PM/INTERNAL get 403 (client view is for client accounts)", async () => {
    const f = await setup();
    const res = await client.get("/api/v1/client/project", f.pmToken);
    expect(res.status).toBe(403);
  });
});

describe("GET /client/tasks — masking", () => {
  test("only clientVisible tasks, whitelist fields only (raw JSON assertions)", async () => {
    const f = await setup();
    const res = await client.get("/api/v1/client/tasks", f.clientAToken);
    expect(res.status).toBe(200);
    const raw = JSON.stringify(await res.json());

    // Only the two visible tasks are listed.
    const body = (await client
      .get("/api/v1/client/tasks", f.clientAToken)
      .then((r) => r.json())) as {
      data: Record<string, unknown>[];
      meta: { total: number };
    };
    expect(body.meta.total).toBe(2);
    for (const t of body.data) {
      expect(Object.keys(t).sort()).toEqual([
        "dueDate",
        "effectiveStatus",
        "id",
        "status",
        "title",
        "updatedAt",
      ]);
    }

    // Forbidden internal identities/fields must NOT appear anywhere in the JSON.
    expect(raw).not.toContain("assignee");
    expect(raw).not.toContain("department");
    expect(raw).not.toContain("SecretFE");
    expect(raw).not.toContain("email");
    expect(raw).not.toContain("avatarUrl");
    expect(raw).not.toContain("comment");
    expect(raw).not.toContain("attachment");
    expect(raw).not.toContain("clientVisible"); // server-controlled, not exposed
    // Internal titles of invisible tasks must not leak.
    expect(raw).not.toContain("Internal Task");
    // Visible task uses the client-safe title.
    expect(raw).toContain("Customer onboarding flow");
  });

  test("client without clientTitle falls back to masked notice, never internal title", async () => {
    const f = await setup();
    const body = (await client
      .get("/api/v1/client/tasks", f.clientBToken)
      .then((r) => r.json())) as {
      data: { title: string }[];
    };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.title).toBe("(details pending)");
  });

  test("tenant isolation: client A can never read project B (guessed ids rejected)", async () => {
    const f = await setup();
    // A's view never includes B's tasks.
    const list = (await client
      .get("/api/v1/client/tasks", f.clientAToken)
      .then((r) => r.json())) as {
      data: { id: unknown }[];
    };
    const bTasks = await prisma.task.findMany({ where: { projectId: f.projectBId } });
    for (const bt of bTasks) {
      expect(list.data.some((t) => t.id === bt.id)).toBe(false);
    }

    // Filtering by another project's id cannot override the tenant scope.
    const q = encodeURIComponent(JSON.stringify({ projectId: f.projectBId }));
    const res = await client.get(`/api/v1/client/tasks?filters=${q}`, f.clientAToken);
    expect(res.status).toBe(400); // projectId not in client whitelist
  });

  test("client cannot reach internal task endpoints (404, no leak)", async () => {
    const f = await setup();
    const visible = await prisma.task.findFirst({
      where: { projectId: f.projectAId, clientVisible: true },
    });
    const res = await client.get(`/api/v1/tasks/${visible!.id}`, f.clientAToken);
    expect(res.status).toBe(404);
    const board = await client.get(`/api/v1/projects/${f.projectAId}/board`, f.clientAToken);
    expect(board.status).toBe(404);
  });

  test("whitelist enforced: unknown filter fields -> 400", async () => {
    const f = await setup();
    const q = encodeURIComponent(JSON.stringify({ assigneeId: "anything" }));
    const res = await client.get(`/api/v1/client/tasks?filters=${q}`, f.clientAToken);
    expect(res.status).toBe(400);
  });
});
