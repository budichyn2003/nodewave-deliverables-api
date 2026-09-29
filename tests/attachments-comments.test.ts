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
  clientToken: string;
  projectId: string;
  taskId: string;
}

async function setup(): Promise<Setup> {
  const pm = await seedUser({ email: "pm@t.test", name: "PM", role: "PM" });
  const fe = await seedUser({
    email: "fe@t.test",
    name: "FE",
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
  const clientToken = await login("cli@t.test");

  const proj = await client.post("/api/v1/projects", { name: "Apollo" }, pmToken);
  const projectId = ((await proj.json()) as { data: { id: string } }).data.id;
  for (const u of [pm, fe, cli]) {
    await client.post(`/api/v1/projects/${projectId}/members`, { userId: u.id }, pmToken);
  }
  const task = await client.post(
    `/api/v1/projects/${projectId}/tasks`,
    { title: "Slicing", department: "FRONTEND", assigneeId: fe.id },
    pmToken,
  );
  const taskId = ((await task.json()) as { data: { id: string } }).data.id;
  return { pmToken, feToken, clientToken, projectId, taskId };
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await disconnectTestDb();
});

describe("attachments", () => {
  test("PM and internal upload; CLIENT gets 403", async () => {
    const f = await setup();
    const form = new FormData();
    form.append("file", new Blob(["hello"], { type: "text/plain" }), "notes.txt");

    const feRes = await app.request(`/api/v1/tasks/${f.taskId}/attachments`, {
      method: "POST",
      headers: { Authorization: `Bearer ${f.feToken}` },
      body: form,
    });
    expect(feRes.status).toBe(201);
    const body = (await feRes.json()) as { data: { url: string; size: number } };
    expect(body.data.url).toContain(f.taskId);
    expect(body.data.size).toBe(5);

    const cliForm = new FormData();
    cliForm.append("file", new Blob(["x"], { type: "text/plain" }), "x.txt");
    const cliRes = await app.request(`/api/v1/tasks/${f.taskId}/attachments`, {
      method: "POST",
      headers: { Authorization: `Bearer ${f.clientToken}` },
      body: cliForm,
    });
    expect(cliRes.status).toBe(403);
  });

  test("disallowed mime type and extension rejected with 415", async () => {
    const f = await setup();
    const badForm = new FormData();
    badForm.append("file", new Blob(["#!/bin/sh"], { type: "text/x-shellscript" }), "evil.sh");
    const res = await app.request(`/api/v1/tasks/${f.taskId}/attachments`, {
      method: "POST",
      headers: { Authorization: `Bearer ${f.pmToken}` },
      body: badForm,
    });
    expect(res.status).toBe(415);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "UNSUPPORTED_MEDIA_TYPE",
    );
  });

  test("oversized file rejected with 413", async () => {
    const f = await setup();
    const big = "x".repeat(11 * 1024 * 1024); // > 10MB default cap
    const form = new FormData();
    form.append("file", new Blob([big], { type: "text/plain" }), "big.txt");
    const res = await app.request(`/api/v1/tasks/${f.taskId}/attachments`, {
      method: "POST",
      headers: { Authorization: `Bearer ${f.pmToken}` },
      body: form,
    });
    expect(res.status).toBe(413);
  });

  test("path traversal in file name rejected", async () => {
    const f = await setup();
    const form = new FormData();
    form.append("file", new Blob(["x"], { type: "text/plain" }), "../../etc/passwd.txt");
    const res = await app.request(`/api/v1/tasks/${f.taskId}/attachments`, {
      method: "POST",
      headers: { Authorization: `Bearer ${f.pmToken}` },
      body: form,
    });
    expect(res.status).toBe(400);
  });

  test("list supports the query contract (search + pagination)", async () => {
    const f = await setup();
    for (const name of ["alpha.txt", "beta.txt", "gamma.txt"]) {
      const form = new FormData();
      form.append("file", new Blob(["data"], { type: "text/plain" }), name);
      const res = await app.request(`/api/v1/tasks/${f.taskId}/attachments`, {
        method: "POST",
        headers: { Authorization: `Bearer ${f.pmToken}` },
        body: form,
      });
      expect(res.status).toBe(201);
    }
    const q = encodeURIComponent(JSON.stringify({ fileName: ".txt" }));
    const res = await client.get(
      `/api/v1/tasks/${f.taskId}/attachments?searchFilters=${q}&rows=2&page=1`,
      f.pmToken,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { fileName: string }[]; meta: { total: number } };
    expect(body.meta.total).toBe(3);
    expect(body.data).toHaveLength(2);
  });
});

describe("internal comments", () => {
  test("PM and internal create; list shows author; pagination works", async () => {
    const f = await setup();
    await client.post(`/api/v1/tasks/${f.taskId}/comments`, { body: "First" }, f.pmToken);
    await client.post(`/api/v1/tasks/${f.taskId}/comments`, { body: "Second" }, f.feToken);

    const res = await client.get(`/api/v1/tasks/${f.taskId}/comments?rows=1&page=1`, f.feToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { body: string; author: { name: string }; isInternal: boolean }[];
      meta: { total: number };
    };
    expect(body.meta.total).toBe(2);
    expect(body.data[0]!.isInternal).toBe(true);
    expect(body.data[0]!.author.name).toBe("PM");
  });

  test("CLIENT cannot read (404) nor write (403) comments", async () => {
    const f = await setup();
    await client.post(`/api/v1/tasks/${f.taskId}/comments`, { body: "Internal note" }, f.pmToken);

    const read = await client.get(`/api/v1/tasks/${f.taskId}/comments`, f.clientToken);
    expect(read.status).toBe(404); // existence not leaked

    const write = await client.post(
      `/api/v1/tasks/${f.taskId}/comments`,
      { body: "hi" },
      f.clientToken,
    );
    expect(write.status).toBe(403);
  });

  test("comments never appear for client even on their visible tasks (masking sanity)", async () => {
    const f = await setup();
    // Flag the task client-visible, add internal comments.
    const v = (await prisma.task.findUnique({ where: { id: f.taskId } }))!.version;
    await client.patch(`/api/v1/tasks/${f.taskId}`, { version: v, clientVisible: true }, f.pmToken);
    await client.post(`/api/v1/tasks/${f.taskId}/comments`, { body: "secret note" }, f.pmToken);

    const res = await client.get(`/api/v1/tasks/${f.taskId}`, f.clientToken);
    // Task detail endpoint is internal-only: the client gets 404 entirely.
    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).not.toContain("secret note");
  });
});
