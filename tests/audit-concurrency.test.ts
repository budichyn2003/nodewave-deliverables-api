import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { disconnectTestDb, resetDatabase, seedUser } from "./helpers/db";
import { makeClient } from "./helpers/http";

const app = createApp();
const client = makeClient(app);

interface Setup {
  pmToken: string;
  feToken: string;
  uiToken: string;
  projectId: string;
}

async function setup(): Promise<Setup> {
  const pm = await seedUser({ email: "pm@t.test", name: "PM", role: "PM" });
  const fe = await seedUser({
    email: "fe@t.test",
    name: "FE",
    role: "INTERNAL",
    department: "FRONTEND",
  });
  const ui = await seedUser({
    email: "ui@t.test",
    name: "UI",
    role: "INTERNAL",
    department: "UIUX",
  });

  const login = async (email: string) => {
    const res = await client.post("/api/v1/auth/login", { email, password: "Password123!" });
    return ((await res.json()) as { data: { token: string } }).data.token;
  };
  const pmToken = await login("pm@t.test");
  const feToken = await login("fe@t.test");
  const uiToken = await login("ui@t.test");

  const proj = await client.post("/api/v1/projects", { name: "Apollo" }, pmToken);
  const projectId = ((await proj.json()) as { data: { id: string } }).data.id;
  for (const u of [pm, fe, ui]) {
    await client.post(`/api/v1/projects/${projectId}/members`, { userId: u.id }, pmToken);
  }
  return { pmToken, feToken, uiToken, projectId };
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

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await disconnectTestDb();
});

describe("optimistic locking (the tested race scenario)", () => {
  test("PM editing with a stale version gets 409 + current server state; nothing is overwritten", async () => {
    const f = await setup();
    const fe = await prisma.user.findUnique({ where: { email: "fe@t.test" } });
    const taskId = await createTask(f.pmToken, f.projectId, { title: "T", assigneeId: fe!.id });

    // Both actors load the task at v1.
    const v1 = (await prisma.task.findUnique({ where: { id: taskId } }))!.version;
    expect(v1).toBe(1);

    // Engineer sets status DONE first (v1 -> v2).
    const eng = await client.post(
      `/api/v1/tasks/${taskId}/status`,
      { version: v1, status: "IN_PROGRESS" },
      f.feToken,
    );
    expect(eng.status).toBe(200);
    const v2 = (await prisma.task.findUnique({ where: { id: taskId } }))!.version;
    expect(v2).toBe(2);

    // PM saves a description edit still holding v1 -> must be rejected 409.
    const pmRes = await client.patch(
      `/api/v1/tasks/${taskId}`,
      { version: v1, description: "PM's concurrent edit" },
      f.pmToken,
    );
    expect(pmRes.status).toBe(409);
    const conflict = (await pmRes.json()) as {
      error: { code: string; details: { currentVersion: number } };
    };
    expect(conflict.error.code).toBe("VERSION_CONFLICT");
    expect(conflict.error.details.currentVersion).toBe(v2);

    // The engineer's write was NOT overwritten:
    expect((await prisma.task.findUnique({ where: { id: taskId } }))!.status).toBe("IN_PROGRESS");
    // And the PM's edit did not silently land:
    expect((await prisma.task.findUnique({ where: { id: taskId } }))!.description).toBeNull();
  });

  test("successful write increments version exactly once", async () => {
    const f = await setup();
    const taskId = await createTask(f.pmToken, f.projectId, { title: "T" });
    const before = (await prisma.task.findUnique({ where: { id: taskId } }))!.version;
    await client.patch(`/api/v1/tasks/${taskId}`, { version: before, priority: "HIGH" }, f.pmToken);
    const after = (await prisma.task.findUnique({ where: { id: taskId } }))!.version;
    expect(after).toBe(before + 1);
  });

  test("second writer with the same version loses (409), first writer wins", async () => {
    const f = await setup();
    const taskId = await createTask(f.pmToken, f.projectId, { title: "T" });
    const v = (await prisma.task.findUnique({ where: { id: taskId } }))!.version;

    const first = await client.patch(
      `/api/v1/tasks/${taskId}`,
      { version: v, priority: "HIGH" },
      f.pmToken,
    );
    expect(first.status).toBe(200);

    const second = await client.patch(
      `/api/v1/tasks/${taskId}`,
      { version: v, priority: "LOW" },
      f.pmToken,
    );
    expect(second.status).toBe(409);

    // First writer's value stands.
    expect((await prisma.task.findUnique({ where: { id: taskId } }))!.priority).toBe("HIGH");
  });
});

describe("immutable audit trail", () => {
  test("one row per changed field with correct old/new values", async () => {
    const f = await setup();
    const taskId = await createTask(f.pmToken, f.projectId, { title: "T", priority: "LOW" });

    const v = (await prisma.task.findUnique({ where: { id: taskId } }))!.version;
    await client.patch(
      `/api/v1/tasks/${taskId}`,
      { version: v, title: "New Title", priority: "URGENT", description: "desc" },
      f.pmToken,
    );

    const rows = await prisma.taskAuditLog.findMany({
      where: { taskId, action: "UPDATE" },
      orderBy: { column: "asc" },
    });
    const cols = rows.map((r) => r.column).sort();
    expect(cols).toEqual(["description", "priority", "title"]);

    const byCol = new Map(rows.map((r) => [r.column, r]));
    expect(byCol.get("title")!.oldValue).toBe("T");
    expect(byCol.get("title")!.newValue).toBe("New Title");
    expect(byCol.get("priority")!.oldValue).toBe("LOW");
    expect(byCol.get("priority")!.newValue).toBe("URGENT");
    expect(byCol.get("description")!.oldValue).toBeNull();
    expect(byCol.get("description")!.newValue).toBe("desc");
    // Actor recorded
    const pm = await prisma.user.findUnique({ where: { email: "pm@t.test" } });
    expect(rows.every((r) => r.userId === pm!.id)).toBe(true);
  });

  test("status transitions are audited with old/new status", async () => {
    const f = await setup();
    const fe = await prisma.user.findUnique({ where: { email: "fe@t.test" } });
    const taskId = await createTask(f.pmToken, f.projectId, { title: "T", assigneeId: fe!.id });

    let v = (await prisma.task.findUnique({ where: { id: taskId } }))!.version;
    await client.post(
      `/api/v1/tasks/${taskId}/status`,
      { version: v, status: "IN_PROGRESS" },
      f.feToken,
    );
    v = (await prisma.task.findUnique({ where: { id: taskId } }))!.version;
    await client.post(`/api/v1/tasks/${taskId}/status`, { version: v, status: "DONE" }, f.feToken);

    const rows = await prisma.taskAuditLog.findMany({
      where: { taskId, column: "status", action: "UPDATE" },
      orderBy: { createdAt: "asc" },
    });
    expect(rows.map((r) => [r.oldValue, r.newValue])).toEqual([
      ["TODO", "IN_PROGRESS"],
      ["IN_PROGRESS", "DONE"],
    ]);
    const fe2 = await prisma.user.findUnique({ where: { email: "fe@t.test" } });
    expect(rows[1]!.userId).toBe(fe2!.id);
  });

  test("dependency add/remove audited", async () => {
    const f = await setup();
    const a = await createTask(f.pmToken, f.projectId, { title: "A" });
    const b = await createTask(f.pmToken, f.projectId, { title: "B" });
    await client.post(`/api/v1/tasks/${b}/dependencies`, { dependsOnId: a }, f.pmToken);
    await client.delete(`/api/v1/tasks/${b}/dependencies/${a}`, f.pmToken);

    const rows = await prisma.taskAuditLog.findMany({
      where: { taskId: b, action: { in: ["DEPENDENCY_ADD", "DEPENDENCY_REMOVE"] } },
    });
    expect(rows.map((r) => r.action).sort()).toEqual(["DEPENDENCY_ADD", "DEPENDENCY_REMOVE"]);
  });

  test("UPDATE on the audit table fails at the DB level (raw SQL)", async () => {
    const f = await setup();
    const taskId = await createTask(f.pmToken, f.projectId, { title: "T" });
    const row = await prisma.taskAuditLog.findFirstOrThrow({ where: { taskId } });

    let updateFailed = false;
    try {
      await prisma.$executeRawUnsafe(
        `UPDATE "TaskAuditLog" SET "newValue" = 'tampered' WHERE id = $1`,
        row.id,
      );
    } catch {
      updateFailed = true;
    }
    expect(updateFailed).toBe(true);
  });

  test("DELETE on the audit table fails at the DB level (raw SQL)", async () => {
    const f = await setup();
    const taskId = await createTask(f.pmToken, f.projectId, { title: "T" });
    const row = await prisma.taskAuditLog.findFirstOrThrow({ where: { taskId } });

    let deleteFailed = false;
    try {
      await prisma.$executeRawUnsafe(`DELETE FROM "TaskAuditLog" WHERE id = $1`, row.id);
    } catch {
      deleteFailed = true;
    }
    expect(deleteFailed).toBe(true);

    // Row is still there.
    const still = await prisma.taskAuditLog.findUnique({ where: { id: row.id } });
    expect(still).not.toBeNull();
  });

  test("audit rows are written atomically with the change (conflict => no audit rows)", async () => {
    const f = await setup();
    const taskId = await createTask(f.pmToken, f.projectId, { title: "T" });
    // Stale version -> write fails -> no audit rows may exist for this attempt.
    await client.patch(`/api/v1/tasks/${taskId}`, { version: 99999, title: "X" }, f.pmToken);
    const updateRows = await prisma.taskAuditLog.findMany({ where: { taskId, action: "UPDATE" } });
    expect(updateRows).toHaveLength(0);
  });
});

describe("GET audit endpoint", () => {
  test("PM-only; internal gets 403; supports the standard query contract", async () => {
    const f = await setup();
    const taskId = await createTask(f.pmToken, f.projectId, { title: "T" });
    const v = (await prisma.task.findUnique({ where: { id: taskId } }))!.version;
    await client.patch(`/api/v1/tasks/${taskId}`, { version: v, title: "T2" }, f.pmToken);

    const pmRes = await client.get(
      `/api/v1/projects/${f.projectId}/tasks/${taskId}/audit`,
      f.pmToken,
    );
    expect(pmRes.status).toBe(200);
    const body = (await pmRes.json()) as {
      data: { column: string; oldValue: string | null; newValue: string | null }[];
      meta: { total: number };
    };
    expect(
      body.data.some((r) => r.column === "title" && r.oldValue === "T" && r.newValue === "T2"),
    ).toBe(true);

    const feRes = await client.get(
      `/api/v1/projects/${f.projectId}/tasks/${taskId}/audit`,
      f.feToken,
    );
    expect(feRes.status).toBe(403);
  });
});
