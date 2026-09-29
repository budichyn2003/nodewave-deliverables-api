import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { disconnectTestDb, resetDatabase, seedUser } from "./helpers/db";
import { makeClient } from "./helpers/http";

const app = createApp();
const client = makeClient(app);

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await disconnectTestDb();
});

interface Fixture {
  pmToken: string;
  engToken: string;
  outsiderToken: string;
  clientToken: string;
  project: { id: string };
}

async function setupFixture(): Promise<Fixture> {
  const _pm = await seedUser({ email: "pm@t.test", name: "PM", role: "PM" });
  const eng = await seedUser({
    email: "eng@t.test",
    name: "Eng",
    role: "INTERNAL",
    department: "FRONTEND",
  });
  const _outsider = await seedUser({
    email: "out@t.test",
    name: "Out",
    role: "INTERNAL",
    department: "BACKEND",
  });
  const cli = await seedUser({ email: "cli@t.test", name: "Client", role: "CLIENT" });

  const login = async (email: string) => {
    const res = await client.post("/api/v1/auth/login", { email, password: "Password123!" });
    return ((await res.json()) as { data: { token: string } }).data.token;
  };

  const pmToken = await login("pm@t.test");
  const engToken = await login("eng@t.test");
  const outsiderToken = await login("out@t.test");
  const clientToken = await login("cli@t.test");

  const created = await client.post(
    "/api/v1/projects",
    { name: "Apollo", description: "Deliverables hub" },
    pmToken,
  );
  const project = ((await created.json()) as { data: { id: string } }).data;

  // PM adds members via the API (exercises the route too).
  await client.post(`/api/v1/projects/${project.id}/members`, { userId: eng.id }, pmToken);
  await client.post(`/api/v1/projects/${project.id}/members`, { userId: cli.id }, pmToken);

  return { pmToken, engToken, outsiderToken, clientToken, project };
}

describe("project CRUD & RBAC", () => {
  test("PM creates a project and becomes its member", async () => {
    const f = await setupFixture();
    const res = await client.get(`/api/v1/projects/${f.project.id}`, f.pmToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { members: { role: string }[] } };
    expect(body.data.members.some((m) => m.role === "PM")).toBe(true);
  });

  test("INTERNAL cannot create/update/delete projects", async () => {
    const f = await setupFixture();
    const created = await client.post("/api/v1/projects", { name: "Nope" }, f.engToken);
    expect(created.status).toBe(403);

    const patched = await client.patch(
      `/api/v1/projects/${f.project.id}`,
      { name: "X" },
      f.engToken,
    );
    expect(patched.status).toBe(403);

    const deleted = await client.delete(`/api/v1/projects/${f.project.id}`, f.engToken);
    expect(deleted.status).toBe(403);
  });

  test("non-member gets 404 (existence not leaked), member gets 200", async () => {
    const f = await setupFixture();
    const outsider = await client.get(`/api/v1/projects/${f.project.id}`, f.outsiderToken);
    expect(outsider.status).toBe(404);

    const member = await client.get(`/api/v1/projects/${f.project.id}`, f.engToken);
    expect(member.status).toBe(200);
  });

  test("delete is soft: project invisible by default, row still exists", async () => {
    const f = await setupFixture();
    const del = await client.delete(`/api/v1/projects/${f.project.id}`, f.pmToken);
    expect(del.status).toBe(200);

    const view = await client.get(`/api/v1/projects/${f.project.id}`, f.pmToken);
    expect(view.status).toBe(404);

    const raw = await prisma.$includeDeleted().project.findUnique({ where: { id: f.project.id } });
    expect(raw).not.toBeNull();
    expect(raw?.deletedAt).not.toBeNull();
  });

  test("CLIENT member added to a second project violates single-tenant rule", async () => {
    const f = await setupFixture();
    const _pm = await prisma.user.findUnique({ where: { email: "pm@t.test" } });
    const cli = await prisma.user.findUnique({ where: { email: "cli@t.test" } });
    const second = await client.post("/api/v1/projects", { name: "Second" }, f.pmToken);
    const secondProject = ((await second.json()) as { data: { id: string } }).data;

    const res = await client.post(
      `/api/v1/projects/${secondProject.id}/members`,
      { userId: cli!.id },
      f.pmToken,
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("BUSINESS_RULE");
  });
});

describe("GET /projects list contract (ezfilter)", () => {
  test("pagination + ordering", async () => {
    const f = await setupFixture();
    for (const name of ["Zeta", "Alpha", "Mike"]) {
      await client.post("/api/v1/projects", { name }, f.pmToken);
    }
    const res = await client.get(
      `/api/v1/projects?page=1&rows=2&orderKey=name&orderRule=asc`,
      f.pmToken,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { name: string }[];
      meta: { page: number; rows: number; total: number; totalPages: number };
    };
    // PM member of: Apollo + 3 = 4 projects
    expect(body.meta.total).toBe(4);
    expect(body.data).toHaveLength(2);
    expect(body.data[0]!.name).toBe("Alpha");
    expect(body.data[1]!.name).toBe("Apollo");
    expect(body.meta.totalPages).toBe(2);
  });

  test("searchFilters contains-match works", async () => {
    const f = await setupFixture();
    await client.post("/api/v1/projects", { name: "Midnight Run" }, f.pmToken);
    const q = encodeURIComponent(JSON.stringify({ name: "night" }));
    const res = await client.get(`/api/v1/projects?searchFilters=${q}`, f.pmToken);
    const body = (await res.json()) as { data: { name: string }[] };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.name).toBe("Midnight Run");
  });

  test("multi-column same-type search works; mixed/unknown types -> 400", async () => {
    const f = await setupFixture();
    const q = encodeURIComponent(JSON.stringify({ name: "Apo", description: "hub" }));
    const okRes = await client.get(`/api/v1/projects?searchFilters=${q}`, f.pmToken);
    expect(okRes.status).toBe(200);

    // mixing a string column with an unknown/other-type column is rejected
    const bad = encodeURIComponent(JSON.stringify({ name: "x", dueDate: "2026-01-01" }));
    const badRes = await client.get(`/api/v1/projects?searchFilters=${bad}`, f.pmToken);
    expect(badRes.status).toBe(400);
    const body = (await badRes.json()) as { error: { code: string } };
    expect(["SEARCH_TYPE_MISMATCH", "VALIDATION_ERROR"]).toContain(body.error.code);
  });

  test("rangedFilters on createdAt (inclusive)", async () => {
    const f = await setupFixture();
    const start = "2020-01-01T00:00:00.000Z";
    const end = "2030-01-01T00:00:00.000Z";
    const r = encodeURIComponent(JSON.stringify([{ key: "createdAt", start, end }]));
    const res = await client.get(`/api/v1/projects?rangedFilters=${r}`, f.pmToken);
    const body = (await res.json()) as { data: unknown[] };
    expect(body.data).toHaveLength(1);
  });

  test("filters array value = multi-value OR", async () => {
    const f = await setupFixture();
    await client.post("/api/v1/projects", { name: "Beta" }, f.pmToken);
    const q = encodeURIComponent(JSON.stringify({ name: ["Apollo", "Beta"] }));
    const res = await client.get(`/api/v1/projects?filters=${q}`, f.pmToken);
    const body = (await res.json()) as { data: { name: string }[] };
    expect(body.data.map((p) => p.name).sort()).toEqual(["Apollo", "Beta"]);
  });

  test("malformed JSON in params -> 400, not 500", async () => {
    const f = await setupFixture();
    const res = await client.get(`/api/v1/projects?filters={"name":`, f.pmToken);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("MALFORMED_JSON");
  });

  test("fields outside the whitelist -> 400", async () => {
    const f = await setupFixture();
    const q = encodeURIComponent(JSON.stringify({ deletedAt: null }));
    const res = await client.get(`/api/v1/projects?filters=${q}`, f.pmToken);
    expect(res.status).toBe(400);
  });

  test("membership scope cannot be overridden by user filters", async () => {
    const f = await setupFixture();
    // Outsider crafts a name filter matching an existing project; scope still
    // applies — the outsider is not a member, so they see nothing.
    const q = encodeURIComponent(JSON.stringify({ name: "Apollo" }));
    const res = await client.get(`/api/v1/projects?filters=${q}`, f.outsiderToken);
    const body = (await res.json()) as { data: unknown[] };
    expect(body.data).toHaveLength(0);
  });
});
