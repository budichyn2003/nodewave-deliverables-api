import { z } from "zod";

/**
 * Registration policy (assumption, documented in ARCHITECTURE.md):
 * public sign-up always creates an INTERNAL user with no project access.
 * PM and CLIENT accounts are provisioned by seed / an existing PM.
 */
export const registerSchema = z.object({
  email: z.string().email().toLowerCase(),
  name: z.string().min(2).max(120),
  password: z.string().min(8).max(128),
});

export const loginSchema = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string().min(1),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
