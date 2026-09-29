import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { disconnectTestDb, resetDatabase, seedUser } from "./helpers/db";
import { makeClient } from "./helpers/http";

const app = createApp();
const client = makeClient(app);

beforeAll(async () => {
  // Warm up the pool (first query compiles statements).
  await app.fetch(new Request("http://localhost/health"));
});

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await disconnectTestDb();
});

describe("POST /auth/register", () => {
  test("creates an INTERNAL user and never leaks passwordHash", async () => {
    const res = await client.post("/api/v1/auth/register", {
      email: "eng@example.test",
      name: "Engineer",
      password: "Password123!",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      success: boolean;
      data: { user: Record<string, unknown> };
    };
    expect(body.success).toBe(true);
    expect(body.data.user.role).toBe("INTERNAL");
    expect(JSON.stringify(body)).not.toContain("passwordHash");
    expect(JSON.stringify(body)).not.toContain("Password123!");
  });

  test("rejects duplicate email with 409", async () => {
    await seedUser({ email: "dup@example.test", name: "Dup", role: "INTERNAL" });
    const res = await client.post("/api/v1/auth/register", {
      email: "dup@example.test",
      name: "Dup2",
      password: "Password123!",
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("EMAIL_ALREADY_USED");
  });

  test("never allows a public caller to self-register as PM or CLIENT", async () => {
    const res = await client.post("/api/v1/auth/register", {
      email: "sneaky@example.test",
      name: "Sneaky",
      password: "Password123!",
      role: "PM", // extra field must be ignored (schema has no role)
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { user: { role: string } } };
    expect(body.data.user.role).toBe("INTERNAL");
  });

  test("rejects invalid payloads with 400 and field details", async () => {
    const res = await client.post("/api/v1/auth/register", {
      email: "not-an-email",
      name: "x",
      password: "short",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("POST /auth/login", () => {
  test("returns a working access token for valid credentials", async () => {
    await seedUser({ email: "pm@example.test", name: "PM", role: "PM" });
    const res = await client.post("/api/v1/auth/login", {
      email: "pm@example.test",
      password: "Password123!",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { token: string; user: { role: string } } };
    expect(body.data.user.role).toBe("PM");
    expect(body.data.token.split(".")).toHaveLength(3);
  });

  test("same message for unknown email and wrong password", async () => {
    await seedUser({ email: "known@example.test", name: "Known", role: "INTERNAL" });
    const wrongPass = await client.post("/api/v1/auth/login", {
      email: "known@example.test",
      password: "WrongPass123!",
    });
    const unknownEmail = await client.post("/api/v1/auth/login", {
      email: "ghost@example.test",
      password: "WrongPass123!",
    });
    expect(wrongPass.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    const b1 = (await wrongPass.json()) as { error: { message: string } };
    const b2 = (await unknownEmail.json()) as { error: { message: string } };
    expect(b1.error.message).toBe(b2.error.message);
  });
});

describe("GET /auth/me", () => {
  test("returns the authenticated principal", async () => {
    await seedUser({
      email: "me@example.test",
      name: "Me",
      role: "INTERNAL",
      department: "FRONTEND",
    });
    const login = await client.post("/api/v1/auth/login", {
      email: "me@example.test",
      password: "Password123!",
    });
    const { token } = ((await login.json()) as { data: { token: string } }).data;

    const res = await client.get("/api/v1/auth/me", token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { email: string; department: string } };
    expect(body.data.email).toBe("me@example.test");
    expect(body.data.department).toBe("FRONTEND");
  });

  test("401 without a token", async () => {
    const res = await client.get("/api/v1/auth/me");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UNAUTHENTICATED");
  });

  test("401 with a tampered token", async () => {
    const res = await client.get("/api/v1/auth/me", "not.a.jwt");
    expect(res.status).toBe(401);
  });
});

describe("POST /auth/logout (tokenVersion revocation)", () => {
  test("invalidates previously issued tokens", async () => {
    await seedUser({ email: "out@example.test", name: "Out", role: "INTERNAL" });
    const login = await client.post("/api/v1/auth/login", {
      email: "out@example.test",
      password: "Password123!",
    });
    const { token } = ((await login.json()) as { data: { token: string } }).data;

    const meBefore = await client.get("/api/v1/auth/me", token);
    expect(meBefore.status).toBe(200);

    const logout = await client.post("/api/v1/auth/logout", undefined, token);
    expect(logout.status).toBe(200);

    const meAfter = await client.get("/api/v1/auth/me", token);
    expect(meAfter.status).toBe(401);
    const body = (await meAfter.json()) as { error: { code: string } };
    expect(body.error.code).toBe("TOKEN_REVOKED");
  });
});
