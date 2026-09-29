import { ApiError } from "../../lib/errors";
import { newJti, signAccessToken } from "../../lib/jwt";
import { prisma } from "../../lib/prisma";
import type { AuthUser } from "../../types";
import type { LoginInput, RegisterInput } from "./schemas";

/**
 * Creates a new INTERNAL user. Never lets a public caller pick a role:
 * PM/CLIENT provisioning is out of reach of this endpoint.
 */
export async function register(input: RegisterInput): Promise<{ user: AuthUser }> {
  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  if (existing) {
    throw new ApiError("EMAIL_ALREADY_USED", "An account with this email already exists");
  }

  const passwordHash = await Bun.password.hash(input.password, {
    algorithm: "argon2id",
    memoryCost: 19456,
    timeCost: 2,
  });

  const user = await prisma.user.create({
    data: {
      email: input.email,
      name: input.name,
      passwordHash,
      role: "INTERNAL",
      department: null, // assigned later by a PM (out of scope of this endpoint)
    },
  });

  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      department: user.department,
      tokenVersion: user.tokenVersion,
    },
  };
}

/** Verifies credentials and mints an access token. */
export async function login(input: LoginInput): Promise<{ token: string; user: AuthUser }> {
  const user = await prisma.user.findUnique({ where: { email: input.email } });
  if (!user) {
    // Same message for unknown email and wrong password: no account enumeration.
    throw new ApiError("UNAUTHENTICATED", "Invalid email or password");
  }

  const valid = await Bun.password.verify(input.password, user.passwordHash);
  if (!valid) {
    throw new ApiError("UNAUTHENTICATED", "Invalid email or password");
  }

  const token = signAccessToken({
    sub: user.id,
    role: user.role,
    department: user.department,
    jti: newJti(),
    tokenVersion: user.tokenVersion,
  });

  return {
    token,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      department: user.department,
      tokenVersion: user.tokenVersion,
    },
  };
}

/**
 * Stateless logout: bumping tokenVersion invalidates every token issued
 * before this call (verified against the DB by the auth middleware).
 * Chosen over a RevokedToken table: one column, no extra table, works
 * across multiple devices, documented in ARCHITECTURE.md.
 */
export async function logout(userId: string): Promise<{ ok: true }> {
  await prisma.user.update({
    where: { id: userId },
    data: { tokenVersion: { increment: 1 } },
  });
  return { ok: true };
}

export async function me(userId: string): Promise<AuthUser> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new ApiError("UNAUTHENTICATED", "User no longer exists");
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    department: user.department,
    tokenVersion: user.tokenVersion,
  };
}
