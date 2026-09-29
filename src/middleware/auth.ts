import type { MiddlewareHandler } from "hono";
import { ApiError } from "../lib/errors";
import { verifyAccessToken } from "../lib/jwt";
import { prisma } from "../lib/prisma";
import type { AppEnv, AuthUser } from "../types";

function extractBearerToken(header: string | undefined): string {
  if (!header) throw new ApiError("UNAUTHENTICATED", "Missing Authorization header");
  const [scheme, token] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) {
    throw new ApiError("UNAUTHENTICATED", "Invalid Authorization scheme, expected Bearer token");
  }
  return token;
}

/**
 * Verifies the JWT and loads the user fresh from the DB on every request:
 * - tokenVersion mismatch => token was revoked by logout => 401 TOKEN_REVOKED
 * - deleted/missing user => 401 UNAUTHENTICATED
 */
export function auth(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = extractBearerToken(c.req.header("authorization"));
    let payload: ReturnType<typeof verifyAccessToken>;
    try {
      payload = verifyAccessToken(token);
    } catch (err) {
      if (err instanceof Error && err.name === "TokenExpiredError") {
        throw new ApiError("TOKEN_EXPIRED", "Access token expired");
      }
      throw new ApiError("UNAUTHENTICATED", "Invalid access token");
    }

    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) throw new ApiError("UNAUTHENTICATED", "User no longer exists");
    if (user.tokenVersion !== payload.tokenVersion) {
      throw new ApiError("TOKEN_REVOKED", "Session revoked, please log in again");
    }

    const principal: AuthUser = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      department: user.department,
      tokenVersion: user.tokenVersion,
    };
    c.set("user", principal);
    await next();
  };
}

/**
 * RBAC guard: restricts a route to the given roles. Finer-grained (ABAC)
 * checks — membership, task state, ownership — live in policies/ and are
 * evaluated by the handlers themselves.
 */
export function requireRole(...roles: Array<AuthUser["role"]>): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const user = c.get("user");
    if (!roles.includes(user.role)) {
      throw new ApiError("FORBIDDEN", `Requires role: ${roles.join(" or ")}`);
    }
    await next();
  };
}
