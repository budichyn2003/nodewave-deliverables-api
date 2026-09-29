import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { dayWindow, defaultStandupDate } from "../src/modules/standup/service";
import { disconnectTestDb, resetDatabase, seedUser } from "./helpers/db";
import { makeClient } from "./helpers/http";

const app = createApp();
const client = makeClient(app);

interface Setup {
  pmToken: string;
  feToken: string;
  projectId: string;
  taskAId: string;
  taskBId: string;
}

async function setup(): Promise<Setup> {
  const pm = await seedUser({ email: "pm@t.test", name: "PM", role: "PM" });
  const fe = await seedUser({
    email: "fe@t.test",
    name: "FE Guy",
    role: "INTERNAL",
    department: "FRONTEND",
  });
  const cli = await seedUser({ email: "cli@t.test", name: "Client", role: "CLIENT" });

  const login = async (email: string) => {
    const res = await client.post("/api/v1/auth/login", { email, password: "Password123!" });
    return ((await res.json()) as { data: { token: string } }).data.token;
  };
  const pmToken = await login("pm@t.test");
  const feToken = await login("fe@t.test");

  const proj = await client.post("/api/v1/projects", { name: "Apollo" }, pmToken);
  const projectId = ((await proj.json()) as { data: { id: string } }).data.id;
  for (const u of [pm, fe, cli]) {
    await client.post(`/api/v1/projects/${projectId}/members`, { userId: u.id }, pmToken);
  }

  const taskA = await client.post(
    `/api/v1/projects/${projectId}/tasks`,
    { title: "UI Design", department: "UIUX", assigneeId: fe.id },
    pmToken,
  );
  const taskAId = ((await taskA.json()) as { data: { id: string } }).data.id;
  const taskB = await client.post(
    `/api/v1/projects/${projectId}/tasks`,
    { title: "FE Slicing", department: "FRONTEND", assigneeId: fe.id },
    pmToken,
  );
  const taskBId = ((await taskB.json()) as { data: { id: string } }).data.id;

  await client.post(`/api/v1/tasks/${taskBId}/dependencies`, { dependsOnId: taskAId }, pmToken);

  return { pmToken, feToken, projectId, taskAId, taskBId };
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await disconnectTestDb();
});

describe("day window helpers", () => {
  test("Jakarta window covers 00:00-24:00 WIB (17:00 UTC boundary)", () => {
    const { start, end } = dayWindow("2026-09-28");
    expect(start.toISOString()).toBe("2026-09-27T17:00:00.000Z");
    expect(end.toISOString()).toBe("2026-09-28T17:00:00.000Z");
  });

  test("invalid date rejected 400", () => {
    expect(() => dayWindow("28-09-2026")).toThrow(/YYYY-MM-DD/);
  });

  test("default standup date is yesterday (Jakarta)", () => {
    const now = new Date("2026-09-29T02:00:00.000Z"); // 09:00 WIB
    expect(defaultStandupDate(now)).toBe("2026-09-28");
  });
});

describe("GET /projects/:id/standup", () => {
  test("completedYesterday uses audit trail; blockedToday computed live", async () => {
    const f = await setup();

    // Yesterday: FE completes task A (UI Design -> DONE) inside the window.
    const yesterday = defaultStandupDate();
    const { start, end } = dayWindow(yesterday);
    await prisma.taskAuditLog.create({
      data: {
        taskId: f.taskAId,
        projectId: f.projectId,
        userId: (await prisma.user.findUnique({ where: { email: "fe@t.test" } }))!.id,
        column: "status",
        oldValue: "IN_PROGRESS",
        newValue: "DONE",
        action: "UPDATE",
        // Timestamp inside yesterday's Jakarta window.
        createdAt: new Date(start.getTime() + 3 * 3600_000),
      },
    });
    expect(new Date(start.getTime() + 3 * 3600_000) < end).toBe(true);

    const res = await client.get(
      `/api/v1/projects/${f.projectId}/standup?date=${yesterday}`,
      f.pmToken,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        date: string;
        project: { name: string };
        departments: {
          department: string;
          completedYesterday: { taskId: string; completedBy: string }[];
          blockedToday: { taskId: string; blockedBy: { title: string }[] }[];
        }[];
      };
    };
    expect(body.data.date).toBe(yesterday);
    expect(body.data.project.name).toBe("Apollo");

    const uiux = body.data.departments.find((d) => d.department === "UIUX")!;
    expect(uiux.completedYesterday).toHaveLength(1);
    expect(uiux.completedYesterday[0]!.completedBy).toBe("FE Guy");

    // FE Slicing is blocked today by UI Design... wait: UI Design audit says
    // DONE but the stored status is still TODO — live computation uses the
    // stored status, so it is still blocked. This is correct behaviour:
    // audit "what happened yesterday" is history; blockedToday is live truth.
    const frontend = body.data.departments.find((d) => d.department === "FRONTEND")!;
    expect(frontend.blockedToday).toHaveLength(1);
    expect(frontend.blockedToday[0]!.blockedBy[0]!.title).toBe("UI Design");
  });

  test("blockedToday clears when the prerequisite is actually DONE", async () => {
    const f = await setup();
    await prisma.task.update({ where: { id: f.taskAId }, data: { status: "DONE" } });

    const res = await client.get(`/api/v1/projects/${f.projectId}/standup`, f.pmToken);
    const body = (await res.json()) as {
      data: { departments: { department: string; blockedToday: unknown[] }[] };
    };
    const frontend = body.data.departments.find((d) => d.department === "FRONTEND")!;
    expect(frontend.blockedToday).toHaveLength(0);
  });

  test("CLIENT cannot access standup (404); default date works without query param", async () => {
    const f = await setup();
    const cliLogin = await client.post("/api/v1/auth/login", {
      email: "cli@t.test",
      password: "Password123!",
    });
    const cliToken = ((await cliLogin.json()) as { data: { token: string } }).data.token;
    const res = await client.get(`/api/v1/projects/${f.projectId}/standup`, cliToken);
    expect(res.status).toBe(404);

    const okRes = await client.get(`/api/v1/projects/${f.projectId}/standup`, f.pmToken);
    expect(okRes.status).toBe(200);
  });
});
