/**
 * Bun test preload — runs before any module import.
 * Redirects the shared Prisma singleton to the dedicated test database so
 * integration tests never touch development data.
 */
process.env.NODE_ENV = "test";

const testUrl = process.env.DATABASE_URL_TEST;
if (!testUrl) {
  throw new Error("DATABASE_URL_TEST is required to run tests (see .env.example)");
}
process.env.DATABASE_URL = testUrl;
