import type { ErrorHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { isApiError } from "../lib/errors";
import type { AppEnv } from "../types";

/**
 * Central error handler. Contract:
 * - ApiError       -> its own status + machine-readable code
 * - Zod-like error -> 400 VALIDATION_ERROR
 * - everything else -> 500 INTERNAL_ERROR (no stack traces in production)
 */
export const errorHandler: ErrorHandler<AppEnv> = (err, c) => {
  if (isApiError(err)) {
    return c.json(
      {
        success: false as const,
        error: {
          code: err.code,
          message: err.message,
          ...(err.details !== undefined ? { details: err.details } : {}),
        },
      },
      err.status as ContentfulStatusCode,
    );
  }

  // Zod errors (thrown by zod's .parse()) carry an `issues` array.
  const maybeZod = err as { issues?: unknown; name?: string };
  if (maybeZod.name === "ZodError" && Array.isArray(maybeZod.issues)) {
    return c.json(
      {
        success: false as const,
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid request payload",
          details: { issues: maybeZod.issues },
        },
      },
      400,
    );
  }

  // eslint-disable-next-line no-console
  console.error(`[unhandled] ${err instanceof Error ? err.stack : String(err)}`);
  return c.json(
    {
      success: false as const,
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected error occurred",
      },
    },
    500,
  );
};
