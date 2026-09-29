/**
 * Machine-readable API errors. Every error maps to an HTTP status via
 * `statusFor`, and carries a stable `code` the frontend can react to.
 */
export type ErrorCode =
  // 400
  | "VALIDATION_ERROR"
  | "MALFORMED_JSON"
  | "SEARCH_TYPE_MISMATCH" // 401
  | "UNAUTHENTICATED"
  | "TOKEN_EXPIRED"
  | "TOKEN_REVOKED" // 403
  | "FORBIDDEN"
  | "FORBIDDEN_TRANSITION" // 404
  | "NOT_FOUND" // 409
  | "VERSION_CONFLICT"
  | "EMAIL_ALREADY_USED" // 422
  | "INVALID_TRANSITION"
  | "TASK_BLOCKED"
  | "DEPENDENCY_CYCLE"
  | "SELF_DEPENDENCY"
  | "CROSS_PROJECT_DEPENDENCY"
  | "BUSINESS_RULE" // 413
  | "PAYLOAD_TOO_LARGE" // 415
  | "UNSUPPORTED_MEDIA_TYPE";

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  MALFORMED_JSON: 400,
  SEARCH_TYPE_MISMATCH: 400,
  UNAUTHENTICATED: 401,
  TOKEN_EXPIRED: 401,
  TOKEN_REVOKED: 401,
  FORBIDDEN: 403,
  FORBIDDEN_TRANSITION: 403,
  NOT_FOUND: 404,
  VERSION_CONFLICT: 409,
  EMAIL_ALREADY_USED: 409,
  INVALID_TRANSITION: 422,
  TASK_BLOCKED: 422,
  DEPENDENCY_CYCLE: 422,
  SELF_DEPENDENCY: 422,
  CROSS_PROJECT_DEPENDENCY: 422,
  BUSINESS_RULE: 422,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
};

export function statusFor(code: ErrorCode): number {
  return STATUS_BY_CODE[code];
}

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.details = details;
  }

  get status(): number {
    return statusFor(this.code);
  }

  /** Zod issues -> one ApiError with field-level details. */
  static fromZod(error: ZodErrorLike): ApiError {
    return new ApiError("VALIDATION_ERROR", "Invalid request payload", {
      issues: error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
  }

  static notFound(what = "Resource"): ApiError {
    // 404 is deliberately generic: it must not leak the existence of
    // resources the caller cannot see (tenant isolation).
    return new ApiError("NOT_FOUND", `${what} not found`);
  }
}

/** Structural subset of zod's ZodError, to keep errors decoupled from zod. */
export interface ZodErrorLike {
  issues: { path: (string | number | symbol)[]; message: string }[];
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}
