import type { Department, Role } from "../generated/prisma/client";

/** Authenticated principal attached by the auth middleware. */
export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  department: Department | null;
  tokenVersion: number;
}

/** Hono context variables used across the app. */
export type AppEnv = {
  Variables: {
    requestId: string;
    user: AuthUser;
  };
};
