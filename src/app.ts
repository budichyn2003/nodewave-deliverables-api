import { Hono } from "hono";
import { cors } from "hono/cors";
import { env } from "./config/env";
import { prisma } from "./lib/prisma";
import { errorHandler } from "./middleware/error-handler";
import { requestId } from "./middleware/request-id";
import { attachmentRoutes } from "./modules/attachments/routes";
import { authRoutes } from "./modules/auth/routes";
import { clientViewRoutes } from "./modules/client-view/routes";
import { commentRoutes } from "./modules/comments/routes";
import { projectRoutes } from "./modules/projects/routes";
import { standupRoutes } from "./modules/standup/routes";
import { taskRoutes } from "./modules/tasks/routes";
import type { AppEnv } from "./types";

export function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.onError(errorHandler);
  app.use(requestId());
  app.use(
    "*",
    cors({
      origin: env.FRONTEND_ORIGINS,
      allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization", "If-Match", "X-Request-Id"],
      exposeHeaders: ["X-Request-Id"],
      maxAge: 86400,
    }),
  );

  // Liveness + DB readiness probe.
  app.get("/health", async (c) => {
    await prisma.$queryRaw`SELECT 1`;
    return c.json({
      status: "ok",
      service: "nodewave-deliverables-api",
      time: new Date().toISOString(),
    });
  });

  const v1 = new Hono<AppEnv>();

  v1.route("/", authRoutes);
  v1.route("/", projectRoutes);
  v1.route("/", taskRoutes);
  v1.route("/", attachmentRoutes);
  v1.route("/", commentRoutes);
  v1.route("/", clientViewRoutes);
  v1.route("/", standupRoutes);

  app.route("/api/v1", v1);

  app.notFound((c) =>
    c.json(
      { success: false as const, error: { code: "NOT_FOUND", message: "Route not found" } },
      404,
    ),
  );

  return app;
}
