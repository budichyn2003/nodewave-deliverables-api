import type { Hono } from "hono";

/**
 * Minimal JSON client around Hono's `app.request` — no network, fast and
 * deterministic for integration tests. `any` is intentional: the helper is
 * app-shape agnostic.
 */
export interface JsonResponse<T = unknown> {
  status: number;
  body: T;
}

// biome-ignore lint/suspicious/noExplicitAny: test helper is app-shape agnostic
export function makeClient(app: Hono<any>) {
  return {
    async get(path: string, token?: string): Promise<Response> {
      return app.request(path, { method: "GET", headers: headers(token) });
    },
    async post(path: string, body?: unknown, token?: string): Promise<Response> {
      return app.request(path, {
        method: "POST",
        headers: headers(token),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    },
    async patch(path: string, body: unknown, token?: string): Promise<Response> {
      return app.request(path, {
        method: "PATCH",
        headers: headers(token),
        body: JSON.stringify(body),
      });
    },
    async delete(path: string, token?: string): Promise<Response> {
      return app.request(path, { method: "DELETE", headers: headers(token) });
    },
  };
}

function headers(token?: string): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

/** Convenience: register-or-login via the API and return the bearer token. */
export async function loginAndGetToken(
  client: ReturnType<typeof makeClient>,
  email: string,
  password: string,
): Promise<string> {
  const res = await client.post("/api/v1/auth/login", { email, password });
  if (res.status !== 200) {
    const reg = await client.post("/api/v1/auth/register", {
      email,
      name: email.split("@")[0],
      password,
    });
    if (reg.status !== 201) {
      throw new Error(
        `Cannot obtain token for ${email}: login ${res.status}, register ${reg.status}`,
      );
    }
    const _created = (await reg.json()) as never as { data: { token?: string } };
    // register does not return a token — perform an explicit login.
    const relogin = await client.post("/api/v1/auth/login", { email, password });
    const body = (await relogin.json()) as { data: { token: string } };
    return body.data.token;
  }
  const body = (await res.json()) as { data: { token: string } };
  return body.data.token;
}
