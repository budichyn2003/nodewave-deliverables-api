import {
  BuildQueryFilter,
  type FilteringQuery,
  type PrismaQueryOptions,
} from "@nodewave/prisma-ezfilter";
import { ApiError } from "./errors";

/**
 * Standard list query contract (docs "Filtering, Paginating and Searching").
 *
 * We pre-parse and validate everything ourselves because the library's
 * `extractQueryFromParams` silently swallows malformed JSON (console.warn only),
 * while the contract requires a 400. `BuildQueryFilter` is used *without* a
 * TransformConfig so `filters` keeps exact-match semantics (a transform config
 * would turn every string into a `contains`).
 */

/** Per-resource whitelist: which columns may be touched by which param. */
export interface ListWhitelist {
  filterable: string[];
  searchable: string[];
  /** Column types for the multi-column same-type search constraint. */
  searchableTypes: Record<string, "string" | "number" | "boolean" | "date">;
  rangable: string[];
  sortable: string[];
}

export interface ParsedListQuery {
  /** ezfilter-built where: `{ AND: [...] }` — merge scope before executing. */
  where: PrismaQueryOptions["where"];
  orderBy?: PrismaQueryOptions["orderBy"];
  take: number;
  skip: number;
  page: number;
  rows: number;
}

const DEFAULT_ROWS = 10;
const MAX_ROWS = 100;

function parseJsonParam(raw: string | undefined, name: string): unknown {
  if (raw === undefined || raw === "") return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new ApiError("MALFORMED_JSON", `Query parameter '${name}' is not valid JSON`);
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function assertKeysAllowed(keys: string[], allowed: string[], param: string): void {
  const bad = keys.filter((k) => !allowed.includes(k));
  if (bad.length > 0) {
    throw new ApiError(
      "VALIDATION_ERROR",
      `Field(s) ${bad.map((k) => `'${k}'`).join(", ")} are not allowed in '${param}'`,
      { notAllowed: bad, allowed },
    );
  }
}

/**
 * Enforces the PDF constraint: "Constraint When searching across multiple
 * columns, all targeted columns must share the same data type."
 */
function assertSameSearchTypes(filters: Record<string, unknown>, wl: ListWhitelist): void {
  const keys = Object.keys(filters).filter((k) => filters[k] !== null && filters[k] !== undefined);
  if (keys.length < 2) return;
  const types = keys.map((k) => wl.searchableTypes[k]);
  if (types.some((t) => t === undefined)) {
    throw new ApiError("SEARCH_TYPE_MISMATCH", "Unknown searchable column type");
  }
  const unique = new Set(types);
  if (unique.size > 1) {
    throw new ApiError(
      "SEARCH_TYPE_MISMATCH",
      `searchFilters targets multiple columns of different types (${keys.join(", ")}); they must share the same data type`,
    );
  }
}

/** Parses + validates the standard list query params from a request URL. */
export function parseListQuery(searchParams: URLSearchParams, wl: ListWhitelist): ParsedListQuery {
  // --- filters ---
  const filters = parseJsonParam(searchParams.get("filters") ?? undefined, "filters");
  if (filters !== undefined) {
    if (!isPlainObject(filters)) {
      throw new ApiError("VALIDATION_ERROR", "'filters' must be a JSON object");
    }
    assertKeysAllowed(Object.keys(filters), wl.filterable, "filters");
  }

  // --- searchFilters ---
  const searchFilters = parseJsonParam(
    searchParams.get("searchFilters") ?? undefined,
    "searchFilters",
  );
  if (searchFilters !== undefined) {
    if (!isPlainObject(searchFilters)) {
      throw new ApiError("VALIDATION_ERROR", "'searchFilters' must be a JSON object");
    }
    assertKeysAllowed(Object.keys(searchFilters), wl.searchable, "searchFilters");
    assertSameSearchTypes(searchFilters, wl);
  }

  // --- rangedFilters ---
  const rangedFilters = parseJsonParam(
    searchParams.get("rangedFilters") ?? undefined,
    "rangedFilters",
  );
  if (rangedFilters !== undefined) {
    if (!Array.isArray(rangedFilters)) {
      throw new ApiError("VALIDATION_ERROR", "'rangedFilters' must be a JSON array");
    }
    for (const r of rangedFilters) {
      if (!isPlainObject(r) || typeof r.key !== "string") {
        throw new ApiError(
          "VALIDATION_ERROR",
          "Each rangedFilters entry must be { key, start, end }",
        );
      }
      if (!("start" in r) || !("end" in r)) {
        throw new ApiError(
          "VALIDATION_ERROR",
          `Range for '${r.key}' requires both 'start' and 'end'`,
        );
      }
    }
    assertKeysAllowed(
      (rangedFilters as Array<{ key: string }>).map((r) => r.key),
      wl.rangable,
      "rangedFilters",
    );
  }

  // --- ordering: accept `orderKey` (canonical, per the PDF) and `orderkey`
  // (as used in the build prompt) for frontend convenience. ---
  const orderKey = searchParams.get("orderKey") ?? searchParams.get("orderkey") ?? undefined;
  if (orderKey !== undefined && !wl.sortable.includes(orderKey)) {
    throw new ApiError("VALIDATION_ERROR", `Field '${orderKey}' is not sortable`, {
      allowed: wl.sortable,
    });
  }
  const orderRuleRaw = searchParams.get("orderRule") ?? undefined;
  if (orderRuleRaw !== undefined && orderRuleRaw !== "asc" && orderRuleRaw !== "desc") {
    throw new ApiError("VALIDATION_ERROR", "'orderRule' must be 'asc' or 'desc'");
  }

  // --- pagination ---
  const pageRaw = searchParams.get("page");
  const rowsRaw = searchParams.get("rows");
  let page = 1;
  let rows = DEFAULT_ROWS;
  if (pageRaw !== null) {
    page = Number.parseInt(pageRaw, 10);
    if (!Number.isInteger(page) || page < 1) {
      throw new ApiError("VALIDATION_ERROR", "'page' must be a positive integer");
    }
  }
  if (rowsRaw !== null) {
    rows = Number.parseInt(rowsRaw, 10);
    if (!Number.isInteger(rows) || rows < 1) {
      throw new ApiError("VALIDATION_ERROR", "'rows' must be a positive integer");
    }
    if (rows > MAX_ROWS) {
      throw new ApiError("VALIDATION_ERROR", `'rows' cannot exceed ${MAX_ROWS}`);
    }
  }

  const filter: FilteringQuery = {
    ...(filters !== undefined ? { filters } : {}),
    ...(searchFilters !== undefined ? { searchFilters } : {}),
    ...(rangedFilters !== undefined
      ? { rangedFilters: rangedFilters as FilteringQuery["rangedFilters"] }
      : {}),
    ...(orderKey !== undefined
      ? { orderKey, orderRule: (orderRuleRaw as "asc" | "desc") ?? "asc" }
      : {}),
    page,
    rows,
  };

  const { query } = new BuildQueryFilter().build(filter);
  return {
    where: query.where,
    ...(query.orderBy ? { orderBy: query.orderBy } : {}),
    take: query.take,
    skip: query.skip,
    page,
    rows,
  };
}

/**
 * Merges the authorization scope (membership/tenant/deletedAt/clientVisible)
 * into an ezfilter where clause. Scope is an extra AND element, so user
 * filters can *never* override it.
 */
export function scopedWhere(
  q: Pick<ParsedListQuery, "where">,
  scope: Record<string, unknown>,
): Record<string, unknown> {
  const and = Array.isArray((q.where as { AND?: unknown[] }).AND)
    ? (q.where as { AND: unknown[] }).AND
    : [];
  return { AND: [...and, scope] };
}
