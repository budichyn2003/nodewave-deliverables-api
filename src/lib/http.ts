import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv } from "../types";

/** Success envelope: { success, data }. */
export function ok<T>(c: Context<AppEnv>, data: T, status: ContentfulStatusCode = 200): Response {
  return c.json({ success: true as const, data }, status);
}

/** Success envelope with pagination meta for list endpoints. */
export function okList<T>(
  c: Context<AppEnv>,
  data: T[],
  meta: { page: number; rows: number; total: number },
): Response {
  const totalPages = meta.rows > 0 ? Math.ceil(meta.total / meta.rows) : 0;
  return c.json({
    success: true as const,
    data,
    meta: { ...meta, totalPages },
  });
}

/** Error envelope: { success, error: { code, message, details? } }. */
export function fail(
  c: Context<AppEnv>,
  status: ContentfulStatusCode,
  code: string,
  message: string,
  details?: unknown,
): Response {
  return c.json(
    {
      success: false as const,
      error: { code, message, ...(details !== undefined ? { details } : {}) },
    },
    status,
  );
}
