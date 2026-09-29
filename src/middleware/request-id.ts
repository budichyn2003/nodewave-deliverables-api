import { randomUUID } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../types";

/**
 * Attaches a request id (propagating an incoming `X-Request-Id`) and emits a
 * structured one-line request log with status and duration.
 */
export function requestId(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const incoming = c.req.header("x-request-id");
    const id = incoming && incoming.length <= 128 ? incoming : randomUUID();
    c.set("requestId", id);
    c.header("X-Request-Id", id);

    const start = performance.now();
    await next();
    const ms = (performance.now() - start).toFixed(1);
    // eslint-disable-next-line no-console
    console.log(`[${id}] ${c.req.method} ${c.req.path} -> ${c.res.status} (${ms}ms)`);
  };
}
