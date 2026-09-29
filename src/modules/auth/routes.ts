import { Hono } from "hono";
import { ApiError } from "../../lib/errors";
import { ok } from "../../lib/http";
import { auth } from "../../middleware/auth";
import type { AppEnv } from "../../types";
import { loginSchema, registerSchema } from "./schemas";
import * as authService from "./service";

export const authRoutes = new Hono<AppEnv>();

authRoutes.post("/auth/register", async (c) => {
  const body = await c.req.json().catch(() => {
    throw new ApiError("MALFORMED_JSON", "Request body is not valid JSON");
  });
  const input = registerSchema.parse(body);
  const result = await authService.register(input);
  return ok(c, result, 201);
});

authRoutes.post("/auth/login", async (c) => {
  const body = await c.req.json().catch(() => {
    throw new ApiError("MALFORMED_JSON", "Request body is not valid JSON");
  });
  const input = loginSchema.parse(body);
  const result = await authService.login(input);
  return ok(c, result);
});

authRoutes.post("/auth/logout", auth(), async (c) => {
  const user = c.get("user");
  const result = await authService.logout(user.id);
  return ok(c, result);
});

authRoutes.get("/auth/me", auth(), async (c) => {
  const user = c.get("user");
  const result = await authService.me(user.id);
  return ok(c, result);
});
