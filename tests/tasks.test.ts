import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { disconnectTestDb, resetDatabase, seedUser } from "./helpers/db";
import { makeClient } from "./helpers/http";

const app = createApp();
const client = makeClient(app);

interface Ctx {
  pmToken: string;
  uiToken: string;
  feToken: string;
  beToken: string;
  clientToken: string;
  projectId: string;
  tokens: Record<string, string>;
}

async function setup(): Promise<Ctx> {
  const pm = await seedUser({ email: "pm@t.test", name: "PM", role: "PM" });
  const ui = await seedUser({
    email: "ui@t.test",
    name: "UI",
    role: "INTERNAL",
    department: "UIUX",
  });
  const fe = await seedUser({
    email: "fe@t.test",
    name: "FE",
    role: "INTERNAL",
    department: "FRONTEND",
  });
  const be = await seedUser({
    email: "be@t.test",
    name: "BE",
    role: "INTERNAL",
    department: "BACKEND",
  });
  const cli = await seedUser({ email: "cli@t.test", name: "Client", role: "CLIENT" });

  const login = async (email: string) => {
    const res = await client.post("/api/v1/auth/login", { email, password: "Password123!" });
    return ((await res.json()) as { data: { token: string } }).data.token;
  };

  const pmToken = await login("pm@t.test");
  const uiToken = await login("ui@t.test");
  const feToken = await login("fe@t.test");
  const beToken = await login("be@t.test");
  const clientToken = await login("cli@t.test");

  const proj = await client.post("/api/v1/projects", { name: "Apollo" }, pmToken);
  const projectId = ((await proj.json()) as { data: { id: string } }).data.id;

  for (const u of [pm, ui, fe, be, cli]) {
    await client.post(`/api/v1/projects/${projectId}/members`, { userId: u.id }, pmToken);
  }

  return {
    pmToken,
    uiToken,
    feToken,
    beToken,
    clientToken,
    projectId,
    tokens: { pm: pmToken, ui: uiToken, fe: feToken, be: beToken, client: clientToken },
  };
}

async function createTask(
  token: string,
  projectId: string,
  body: Record<string, unknown>,
): Promise<string> {
  const res = await client.post(`/api/v1/projects/${projectId}/tasks`, body, token);
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data.id;
}

async function currentVersion(taskId: string): Promise<number> {
  const t = await prisma.task.findUnique({ where: { id: taskId } });
  return t!.version;
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await disconnectTestDb();
});

describe("task creation & RBAC", () => {
  test("PM creates tasks; INTERNAL/CLIENT cannot", async () => {
    const f = await setup();
    const okRes = await client.post(
      `/api/v1/projects/${f.projectId}/tasks`,
      {
        title: "UI Design: Dashboard",
        department: "UIUX",
        assigneeId: (await prisma.user.findUnique({ where: { email: "ui@t.test" } }))!.id,
      },
      f.pmToken,
    );
    expect(okRes.status).toBe(201);

    const nope = await client.post(
      `/api/v1/projects/${f.projectId}/tasks`,
      { title: "X" },
      f.feToken,
    );
    expect(nope.status).toBe(403);
    const nope2 = await client.post(
      `/api/v1/projects/${f.projectId}/tasks`,
      { title: "X" },
      f.clientToken,
    );
    expect(nope2.status).toBe(403);
  });

  test("internal non-member cannot see the task (404)", async () => {
    const f = await setup();
    const _outsider = await seedUser({
      email: "out@t.test",
      name: "Out",
      role: "INTERNAL",
      department: "FRONTEND",
    });
    const taskId = await createTask(f.pmToken, f.projectId, { title: "Secret" });

    const login = await client.post("/api/v1/auth/login", {
      email: "out@t.test",
      password: "Password123!",
    });
    const outToken = ((await login.json()) as { data: { token: string } }).data.token;

    const res = await client.get(`/api/v1/tasks/${taskId}`, outToken);
    expect(res.status).toBe(404);
  });
});

describe("dependencies & blocked flow (the core scenario)", () => {
  test("full chain: UI DONE + Backend IN_PROGRESS -> Frontend slicing blocked, then unblocked", async () => {
    const f = await setup();
    const ui = await prisma.user.findUnique({ where: { email: "ui@t.test" } });
    const fe = await prisma.user.findUnique({ where: { email: "fe@t.test" } });
    const be = await prisma.user.findUnique({ where: { email: "be@t.test" } });

    const taskA = await createTask(f.pmToken, f.projectId, {
      title: "UI Design: Dashboard",
      department: "UIUX",
      assigneeId: ui!.id,
    });
    const taskB = await createTask(f.pmToken, f.projectId, {
      title: "Backend API Integration",
      department: "BACKEND",
      assigneeId: be!.id,
    });
    const taskC = await createTask(f.pmToken, f.projectId, {
      title: "Frontend Slicing",
      department: "FRONTEND",
      assigneeId: fe!.id,
    });

    // PM defines dependencies: C depends on A and B.
    await client.post(`/api/v1/tasks/${taskC}/dependencies`, { dependsOnId: taskA }, f.pmToken);
    await client.post(`/api/v1/tasks/${taskC}/dependencies`, { dependsOnId: taskB }, f.pmToken);

    // A -> DONE (assignee completes)
    let v = await currentVersion(taskA);
    let res = await client.post(
      `/api/v1/tasks/${taskA}/status`,
      { version: v, status: "IN_PROGRESS" },
      f.uiToken,
    );
    expect(res.status).toBe(200);
    v = await currentVersion(taskA);
    res = await client.post(
      `/api/v1/tasks/${taskA}/status`,
      { version: v, status: "DONE" },
      f.uiToken,
    );
    expect(res.status).toBe(200);

    // B -> IN_PROGRESS
    v = await currentVersion(taskB);
    res = await client.post(
      `/api/v1/tasks/${taskB}/status`,
      { version: v, status: "IN_PROGRESS" },
      f.beToken,
    );
    expect(res.status).toBe(200);

    // C cannot start (B not DONE) -> 422 TASK_BLOCKED with blockedBy
    v = await currentVersion(taskC);
    res = await client.post(
      `/api/v1/tasks/${taskC}/status`,
      { version: v, status: "IN_PROGRESS" },
      f.feToken,
    );
    expect(res.status).toBe(422);
    const blockedBody = (await res.json()) as {
      error: { code: string; details: { blockedBy: { title: string }[] } };
    };
    expect(blockedBody.error.code).toBe("TASK_BLOCKED");
    expect(blockedBody.error.details.blockedBy[0]!.title).toBe("Backend API Integration");

    // Task detail reports isBlocked + effectiveStatus BLOCKED
    const detail = await client.get(`/api/v1/tasks/${taskC}`, f.feToken);
    const detailBody = (await detail.json()) as {
      data: {
        isBlocked: boolean;
        effectiveStatus: string;
        allowedActions: { canStart: { allowed: boolean; reason: string } };
      };
    };
    expect(detailBody.data.isBlocked).toBe(true);
    expect(detailBody.data.effectiveStatus).toBe("BLOCKED");
    expect(detailBody.data.allowedActions.canStart.allowed).toBe(false);
    expect(detailBody.data.allowedActions.canStart.reason).toBe("TASK_BLOCKED");

    // B -> DONE; now C can start
    v = await currentVersion(taskB);
    await client.post(`/api/v1/tasks/${taskB}/status`, { version: v, status: "DONE" }, f.beToken);
    v = await currentVersion(taskC);
    res = await client.post(
      `/api/v1/tasks/${taskC}/status`,
      { version: v, status: "IN_PROGRESS" },
      f.feToken,
    );
    expect(res.status).toBe(200);

    const after = await client.get(`/api/v1/tasks/${taskC}`, f.feToken);
    const afterBody = (await after.json()) as {
      data: { isBlocked: boolean; effectiveStatus: string };
    };
    expect(afterBody.data.isBlocked).toBe(false);
    expect(afterBody.data.effectiveStatus).toBe("IN_PROGRESS");
  });

  test("self-dependency rejected 422", async () => {
    const f = await setup();
    const t = await createTask(f.pmToken, f.projectId, { title: "A" });
    const res = await client.post(`/api/v1/tasks/${t}/dependencies`, { dependsOnId: t }, f.pmToken);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("SELF_DEPENDENCY");
  });

  test("cycle rejected 422 with DEPENDENCY_CYCLE", async () => {
    const f = await setup();
    const a = await createTask(f.pmToken, f.projectId, { title: "A" });
    const b = await createTask(f.pmToken, f.projectId, { title: "B" });
    const c = await createTask(f.pmToken, f.projectId, { title: "C" });

    await client.post(`/api/v1/tasks/${b}/dependencies`, { dependsOnId: a }, f.pmToken);
    await client.post(`/api/v1/tasks/${c}/dependencies`, { dependsOnId: b }, f.pmToken);
    const res = await client.post(`/api/v1/tasks/${a}/dependencies`, { dependsOnId: c }, f.pmToken);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; details: { cycle: string[] } } };
    expect(body.error.code).toBe("DEPENDENCY_CYCLE");
    expect(body.error.details.cycle.length).toBeGreaterThanOrEqual(3);
  });

  test("cross-project dependency rejected 422", async () => {
    const f = await setup();
    const other = await client.post("/api/v1/projects", { name: "Other" }, f.pmToken);
    const otherId = ((await other.json()) as { data: { id: string } }).data.id;
    const a = await createTask(f.pmToken, f.projectId, { title: "A" });
    const x = await createTask(f.pmToken, otherId, { title: "X" });

    const res = await client.post(`/api/v1/tasks/${a}/dependencies`, { dependsOnId: x }, f.pmToken);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "CROSS_PROJECT_DEPENDENCY",
    );
  });

  test("only PM manages dependencies; internal gets 403", async () => {
    const f = await setup();
    const a = await createTask(f.pmToken, f.projectId, { title: "A" });
    const b = await createTask(f.pmToken, f.projectId, { title: "B" });
    const res = await client.post(`/api/v1/tasks/${b}/dependencies`, { dependsOnId: a }, f.feToken);
    expect(res.status).toBe(403);
  });

  test("removing the dependency edge unblocks the dependent; soft-deleted edge does not block", async () => {
    const f = await setup();
    const a = await createTask(f.pmToken, f.projectId, { title: "A" });
    const b = await createTask(f.pmToken, f.projectId, { title: "B" });
    await client.post(`/api/v1/tasks/${b}/dependencies`, { dependsOnId: a }, f.pmToken);

    // B is blocked (A is TODO)
    const v = await currentVersion(b);
    const start = await client.post(
      `/api/v1/tasks/${b}/status`,
      { version: v, status: "IN_PROGRESS" },
      f.feToken,
    );
    expect(start.status).toBe(422);

    // PM removes the edge -> unblocked
    const del = await client.delete(`/api/v1/tasks/${b}/dependencies/${a}`, f.pmToken);
    expect(del.status).toBe(200);
    const v2 = await currentVersion(b);
    const start2 = await client.post(
      `/api/v1/tasks/${b}/status`,
      { version: v2, status: "IN_PROGRESS" },
      f.feToken,
    );
    expect(start2.status).toBe(200);

    // The edge row still exists, soft-deleted
    const raw = await prisma
      .$includeDeleted()
      .taskDependency.findFirst({ where: { taskId: b, dependsOnId: a } });
    expect(raw).not.toBeNull();
    expect(raw!.deletedAt).not.toBeNull();
  });

  test("soft-deleting the prerequisite task stops blocking the dependent", async () => {
    const f = await setup();
    const a = await createTask(f.pmToken, f.projectId, { title: "A" });
    const b = await createTask(f.pmToken, f.projectId, { title: "B" });
    await client.post(`/api/v1/tasks/${b}/dependencies`, { dependsOnId: a }, f.pmToken);

    // PM deletes A (soft) -> B must be unblocked
    await client.delete(`/api/v1/tasks/${a}`, f.pmToken);

    const v = await currentVersion(b);
    const res = await client.post(
      `/api/v1/tasks/${b}/status`,
      { version: v, status: "IN_PROGRESS" },
      f.feToken,
    );
    expect(res.status).toBe(200);
  });
});

describe("status transition rules over HTTP", () => {
  test("PM cannot complete a task (IN_PROGRESS -> DONE)", async () => {
    const f = await setup();
    const fe = await prisma.user.findUnique({ where: { email: "fe@t.test" } });
    const t = await createTask(f.pmToken, f.projectId, { title: "T", assigneeId: fe!.id });
    let v = await currentVersion(t);
    await client.post(
      `/api/v1/tasks/${t}/status`,
      { version: v, status: "IN_PROGRESS" },
      f.pmToken,
    );
    v = await currentVersion(t);
    const res = await client.post(
      `/api/v1/tasks/${t}/status`,
      { version: v, status: "DONE" },
      f.pmToken,
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "FORBIDDEN_TRANSITION",
    );
  });

  test("only the assignee completes; other internals get 403 NOT_ASSIGNEE", async () => {
    const f = await setup();
    const fe = await prisma.user.findUnique({ where: { email: "fe@t.test" } });
    const t = await createTask(f.pmToken, f.projectId, { title: "T", assigneeId: fe!.id });
    let v = await currentVersion(t);
    await client.post(
      `/api/v1/tasks/${t}/status`,
      { version: v, status: "IN_PROGRESS" },
      f.feToken,
    );
    v = await currentVersion(t);
    const res = await client.post(
      `/api/v1/tasks/${t}/status`,
      { version: v, status: "DONE" },
      f.uiToken,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("NOT_ASSIGNEE");
  });

  test("TODO -> DONE directly is 422 INVALID_TRANSITION", async () => {
    const f = await setup();
    const t = await createTask(f.pmToken, f.projectId, { title: "T" });
    const v = await currentVersion(t);
    const res = await client.post(
      `/api/v1/tasks/${t}/status`,
      { version: v, status: "DONE" },
      f.pmToken,
    );
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "INVALID_TRANSITION",
    );
  });

  test("internal cannot edit core fields (PATCH /tasks/:id)", async () => {
    const f = await setup();
    const t = await createTask(f.pmToken, f.projectId, { title: "T" });
    const v = await currentVersion(t);
    const res = await client.patch(
      `/api/v1/tasks/${t}`,
      { version: v, title: "Hacked" },
      f.feToken,
    );
    expect(res.status).toBe(403);
  });

  test("status change requires version; missing version -> 400", async () => {
    const f = await setup();
    const t = await createTask(f.pmToken, f.projectId, { title: "T" });
    const res = await client.post(
      `/api/v1/tasks/${t}/status`,
      { status: "IN_PROGRESS" },
      f.pmToken,
    );
    expect(res.status).toBe(400);
  });
});

describe("board endpoint", () => {
  test("groups tasks by status with computed blocked info", async () => {
    const f = await setup();
    const a = await createTask(f.pmToken, f.projectId, { title: "A" });
    const b = await createTask(f.pmToken, f.projectId, { title: "B" });
    await client.post(`/api/v1/tasks/${b}/dependencies`, { dependsOnId: a }, f.pmToken);

    const res = await client.get(`/api/v1/projects/${f.projectId}/board`, f.pmToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Record<string, { id: string; isBlocked: boolean }[] | undefined>;
    };
    const todoIds = (body.data.TODO ?? []).map((t) => t.id);
    expect(todoIds).toContain(a);
    expect(todoIds).toContain(b);
    const bTask = (body.data.TODO ?? []).find((t) => t.id === b)!;
    expect(bTask.isBlocked).toBe(true);
  });
});

describe("task list query contract", () => {
  test("filters + pagination + ordering work on tasks", async () => {
    const f = await setup();
    for (const [i, dep] of ["UIUX", "FRONTEND", "BACKEND"].entries()) {
      await createTask(f.pmToken, f.projectId, { title: `Task ${i}`, department: dep });
    }
    const q = encodeURIComponent(JSON.stringify({ department: ["FRONTEND", "BACKEND"] }));
    const res = await client.get(
      `/api/v1/projects/${f.projectId}/tasks?filters=${q}&rows=2&page=1&orderkey=title&orderRule=asc`,
      f.pmToken,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { title: string }[]; meta: { total: number } };
    expect(body.meta.total).toBe(2);
    expect(body.data).toHaveLength(2);
  });

  test("mixed-type searchFilters -> 400 (unknown column is whitelist-rejected)", async () => {
    const f = await setup();
    const q = encodeURIComponent(JSON.stringify({ title: "x", dueDate: "2026-01-01" }));
    const res = await client.get(
      `/api/v1/projects/${f.projectId}/tasks?searchFilters=${q}`,
      f.pmToken,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("VALIDATION_ERROR");
  });

  test("same-type multi-column search works", async () => {
    const f = await setup();
    await createTask(f.pmToken, f.projectId, {
      title: "Login Page",
      description: "build the login form",
    });
    const q = encodeURIComponent(JSON.stringify({ title: "login", description: "form" }));
    const res = await client.get(
      `/api/v1/projects/${f.projectId}/tasks?searchFilters=${q}`,
      f.pmToken,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(body.data).toHaveLength(1);
  });

  test("rangedFilters on dueDate", async () => {
    const f = await setup();
    await createTask(f.pmToken, f.projectId, {
      title: "Dated",
      dueDate: "2026-10-15T00:00:00.000Z",
    });
    await createTask(f.pmToken, f.projectId, {
      title: "Later",
      dueDate: "2027-10-15T00:00:00.000Z",
    });
    const r = encodeURIComponent(
      JSON.stringify([
        { key: "dueDate", start: "2026-10-01T00:00:00.000Z", end: "2026-10-31T00:00:00.000Z" },
      ]),
    );
    const res = await client.get(
      `/api/v1/projects/${f.projectId}/tasks?rangedFilters=${r}`,
      f.pmToken,
    );
    const body = (await res.json()) as { data: { title: string }[] };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.title).toBe("Dated");
  });
});
