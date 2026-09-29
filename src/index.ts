import { createApp } from "./app";
import { env } from "./config/env";
import prisma from "./lib/prisma";

const app = createApp();

const server = Bun.serve({
  port: env.PORT,
  fetch: app.fetch,
  // Local-disk uploads in dev are stored under STORAGE_LOCAL_DIR.
  development: !env.IS_PROD,
});

// eslint-disable-next-line no-console
console.log(
  `🚀 nodewave-deliverables-api listening on http://localhost:${server.port} [${env.NODE_ENV}]`,
);

async function shutdown(signal: string): Promise<void> {
  // eslint-disable-next-line no-console
  console.log(`\n${signal} received, shutting down…`);
  server.stop(true);
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
