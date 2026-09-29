import jwt from "jsonwebtoken";
import type { Department, Role } from "../../generated/prisma/client";
import { env } from "../config/env";

/**
 * JWT access token payload. `tokenVersion` enables stateless logout:
 * incrementing it invalidates every previously issued token (the auth
 * middleware compares the token's version against the fresh DB row).
 */
export interface AccessTokenPayload {
  sub: string;
  role: Role;
  department: Department | null;
  jti: string;
  tokenVersion: number;
  iat?: number;
  exp?: number;
}

export function signAccessToken(payload: Omit<AccessTokenPayload, "iat" | "exp">): string {
  return jwt.sign(payload, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions["expiresIn"],
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  const decoded = jwt.verify(token, env.JWT_SECRET);
  if (typeof decoded === "string") {
    throw new Error("Unexpected string JWT");
  }
  return decoded as AccessTokenPayload;
}

/** Generates a random id for the `jti` claim. */
export function newJti(): string {
  return crypto.randomUUID();
}
