import { createPrismaClient, type ExtendedPrismaClient } from "../../src/lib/prisma";

/**
 * Dedicated client for test orchestration. Created from DATABASE_URL which
 * tests/setup.ts has already pointed at the test database. This is the RAW
 * client (no soft-delete extension) so cleanup can see graveyard rows too.
 */
export const testDb: ExtendedPrismaClient = createPrismaClient(process.env.DATABASE_URL as string);

const TABLES = [
  "TaskAuditLog",
  "Comment",
  "Attachment",
  "TaskDependency",
  "Task",
  "ProjectMember",
  "Project",
  "User",
] as const;

/** Truncates every table (physical) — tests always start from a clean slate. */
export async function resetDatabase(): Promise<void> {
  for (const table of TABLES) {
    await testDb.$executeRawUnsafe(`TRUNCATE TABLE "${table}" CASCADE;`);
  }
}

export async function disconnectTestDb(): Promise<void> {
  await testDb.$disconnect();
}

/** Creates a user directly in the DB (bypasses the register API). */
export async function seedUser(opts: {
  email: string;
  name: string;
  role: "PM" | "INTERNAL" | "CLIENT";
  department?: "UIUX" | "FRONTEND" | "BACKEND" | null;
  password?: string;
}) {
  const passwordHash = await Bun.password.hash(opts.password ?? "Password123!");
  return testDb.user.create({
    data: {
      email: opts.email,
      name: opts.name,
      role: opts.role,
      department: opts.department ?? undefined,
      passwordHash,
    },
  });
}
