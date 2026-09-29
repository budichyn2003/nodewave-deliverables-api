import { describe, expect, test } from "bun:test";
import { type ListWhitelist, parseListQuery } from "../src/lib/ezfilter";
import { taskListWhitelist } from "../src/modules/tasks/schemas";

describe("ezfilter adapter (parseListQuery)", () => {
  const wl: ListWhitelist = {
    filterable: ["category", "origin"],
    searchable: ["name", "origin"],
    searchableTypes: { name: "string", origin: "string" },
    rangable: ["price"],
    sortable: ["name", "price"],
  };

  test("malformed JSON -> MALFORMED_JSON 400", () => {
    const p = new URLSearchParams(`filters={"name":`);
    expect(() => parseListQuery(p, wl)).toThrow(/not valid JSON/);
  });

  test("field outside whitelist -> 400 with allowed list", () => {
    const p = new URLSearchParams(
      `filters=${encodeURIComponent(JSON.stringify({ passwordHash: "x" }))}`,
    );
    try {
      parseListQuery(p, wl);
      expect.unreachable();
    } catch (e) {
      const err = e as { code: string; details: { allowed: string[] } };
      expect(err.code).toBe("VALIDATION_ERROR");
      expect(err.details.allowed).toContain("category");
    }
  });

  test("genuinely mixed-type multi-column search -> SEARCH_TYPE_MISMATCH", () => {
    const mixedWl: ListWhitelist = {
      filterable: [],
      searchable: ["name", "price"],
      searchableTypes: { name: "string", price: "number" },
      rangable: [],
      sortable: [],
    };
    const p = new URLSearchParams(
      `searchFilters=${encodeURIComponent(JSON.stringify({ name: "x", price: 5 }))}`,
    );
    try {
      parseListQuery(p, mixedWl);
      expect.unreachable();
    } catch (e) {
      expect((e as { code: string }).code).toBe("SEARCH_TYPE_MISMATCH");
    }
  });

  test("same-type multi-column search passes", () => {
    const p = new URLSearchParams(
      `searchFilters=${encodeURIComponent(JSON.stringify({ name: "a", origin: "b" }))}`,
    );
    const q = parseListQuery(p, wl);
    expect(q.page).toBe(1);
    expect(q.rows).toBe(10);
  });

  test("rows above the cap -> 400", () => {
    const p = new URLSearchParams("rows=500");
    expect(() => parseListQuery(p, wl)).toThrow(/cannot exceed/);
  });

  test("orderkey (lowercase alias from the build prompt) is accepted", () => {
    const p = new URLSearchParams("orderkey=name&orderRule=desc");
    const q = parseListQuery(p, wl);
    expect(q.orderBy).toEqual({ name: "desc" });
  });

  test("orderRule must be asc|desc", () => {
    const p = new URLSearchParams("orderKey=name&orderRule=sideways");
    expect(() => parseListQuery(p, wl)).toThrow(/asc.*desc/);
  });

  test("rangedFilters require key/start/end", () => {
    const p = new URLSearchParams(
      `rangedFilters=${encodeURIComponent(JSON.stringify([{ key: "price", start: 1 }]))}`,
    );
    expect(() => parseListQuery(p, wl)).toThrow(/start.*end/);
  });

  test("exact filters keep exact semantics (no contains)", () => {
    const p = new URLSearchParams(
      `filters=${encodeURIComponent(JSON.stringify({ category: "Local" }))}`,
    );
    const q = parseListQuery(p, wl);
    expect((q.where as { AND: unknown[] }).AND[0]).toEqual({ category: "Local" });
  });

  test("array filter expands to OR on the column", () => {
    const p = new URLSearchParams(
      `filters=${encodeURIComponent(JSON.stringify({ origin: ["Germany", "Italy"] }))}`,
    );
    const q = parseListQuery(p, wl);
    expect((q.where as { AND: unknown[] }).AND[0]).toEqual({
      OR: [{ origin: "Germany" }, { origin: "Italy" }],
    });
  });

  test("searchFilters produce contains+insensitive", () => {
    const p = new URLSearchParams(
      `searchFilters=${encodeURIComponent(JSON.stringify({ origin: "Ita" }))}`,
    );
    const q = parseListQuery(p, wl);
    expect((q.where as { AND: unknown[] }).AND[0]).toEqual({
      origin: { contains: "Ita", mode: "insensitive" },
    });
  });

  test("task whitelist compiles with the required shape", () => {
    expect(taskListWhitelist.searchable).toContain("title");
    expect(taskListWhitelist.rangable).toContain("dueDate");
  });
});
