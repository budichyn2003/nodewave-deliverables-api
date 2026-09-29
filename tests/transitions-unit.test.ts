import { describe, expect, test } from "bun:test";
import { computeAllowedActions } from "../src/modules/tasks/allowed-actions";
import { blockedBy, effectiveStatus, isBlocked } from "../src/modules/tasks/blocked";
import { validateAddDependency } from "../src/modules/tasks/dependencies-graph";
import {
  ALLOWED_TRANSITIONS,
  evaluateTransition,
  isTransitionAllowed,
} from "../src/modules/tasks/transitions";

const pm = {
  id: "u-pm",
  role: "PM" as const,
  department: null,
  email: "pm@t.test",
  name: "PM",
  tokenVersion: 0,
};
const frontend = {
  id: "u-fe",
  role: "INTERNAL" as const,
  department: "FRONTEND" as const,
  email: "fe@t.test",
  name: "FE",
  tokenVersion: 0,
};
const backend = {
  id: "u-be",
  role: "INTERNAL" as const,
  department: "BACKEND" as const,
  email: "be@t.test",
  name: "BE",
  tokenVersion: 0,
};

function ctx(overrides: Partial<Parameters<typeof evaluateTransition>[2]> = {}) {
  return {
    actor: frontend,
    task: { status: "TODO" as const, assigneeId: "u-fe", department: "FRONTEND" as const },
    unfinishedDependencies: [],
    isProjectMember: true,
    ...overrides,
  };
}

describe("state machine", () => {
  test("only forward paths and documented reopen paths exist", () => {
    expect(ALLOWED_TRANSITIONS.TODO).toEqual(["IN_PROGRESS"]);
    expect(ALLOWED_TRANSITIONS.IN_PROGRESS).toEqual(["DONE", "TODO"]);
    expect(ALLOWED_TRANSITIONS.DONE).toEqual(["IN_PROGRESS"]);
    expect(isTransitionAllowed("TODO", "DONE")).toBe(false);
    expect(isTransitionAllowed("DONE", "TODO")).toBe(false);
    expect(isTransitionAllowed("IN_PROGRESS", "DONE")).toBe(true);
    expect(isTransitionAllowed("IN_PROGRESS", "TODO")).toBe(true);
    expect(isTransitionAllowed("DONE", "IN_PROGRESS")).toBe(true);
  });

  test("TODO -> DONE is invalid (must pass through IN_PROGRESS)", () => {
    const r = evaluateTransition("TODO", "DONE", ctx());
    expect(r.ok).toBe(false);
    if (!r.ok && r.rejection.kind === "INVALID_TRANSITION") {
      expect(r.rejection.kind).toBe("INVALID_TRANSITION");
    } else {
      expect.unreachable();
    }
  });
});

describe("state-based permissions", () => {
  test("PM cannot move IN_PROGRESS -> DONE (only the executor completes)", () => {
    const r = evaluateTransition(
      "IN_PROGRESS",
      "DONE",
      ctx({ actor: pm, task: { status: "IN_PROGRESS", assigneeId: "u-fe", department: null } }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok && r.rejection.kind === "FORBIDDEN_TRANSITION") {
      expect(r.rejection.reason).toBe("PM_CANNOT_COMPLETE");
    } else {
      expect.unreachable();
    }
  });

  test("only the assignee completes; a non-assigned internal gets NOT_ASSIGNEE", () => {
    const r = evaluateTransition(
      "IN_PROGRESS",
      "DONE",
      ctx({
        actor: backend,
        task: { status: "IN_PROGRESS", assigneeId: "u-fe", department: null },
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok && r.rejection.kind === "FORBIDDEN_TRANSITION") {
      expect(r.rejection.reason).toBe("NOT_ASSIGNEE");
    } else {
      expect.unreachable();
    }
  });

  test("the assignee completes successfully", () => {
    const r = evaluateTransition(
      "IN_PROGRESS",
      "DONE",
      ctx({ task: { status: "IN_PROGRESS", assigneeId: "u-fe", department: "FRONTEND" } }),
    );
    expect(r.ok).toBe(true);
  });

  test("a frontend task cannot START while its UI/UX dependency is not DONE", () => {
    const r = evaluateTransition(
      "TODO",
      "IN_PROGRESS",
      ctx({
        unfinishedDependencies: [{ id: "t-ui", title: "UI Design", status: "IN_PROGRESS" }],
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok && r.rejection.kind === "TASK_BLOCKED") {
      expect(r.rejection.blockedBy[0]!.title).toBe("UI Design");
    } else {
      expect.unreachable();
    }
  });

  test("a task can start once ALL dependencies are DONE (multi-dependency case)", () => {
    const deps = [
      { id: "t-a", title: "UI Design", status: "DONE" as const },
      { id: "t-b", title: "Backend API", status: "DONE" as const },
    ];
    const r = evaluateTransition(
      "TODO",
      "IN_PROGRESS",
      ctx({ unfinishedDependencies: deps.filter((d) => d.status !== "DONE") }),
    );
    expect(r.ok).toBe(true);
  });

  test("non-members are rejected before anything else", () => {
    const r = evaluateTransition("TODO", "IN_PROGRESS", ctx({ isProjectMember: false }));
    expect(r.ok).toBe(false);
    if (!r.ok && r.rejection.kind === "FORBIDDEN_TRANSITION") {
      expect(r.rejection.reason).toBe("NOT_A_MEMBER");
    } else {
      expect.unreachable();
    }
  });

  test("CLIENT users can never transition", () => {
    const r = evaluateTransition(
      "TODO",
      "IN_PROGRESS",
      ctx({ actor: { id: "u-c", role: "CLIENT", department: null } }),
    );
    expect(r.ok).toBe(false);
  });
});

describe("derived BLOCKED status", () => {
  const deps = (statuses: ("TODO" | "IN_PROGRESS" | "DONE")[]) =>
    statuses.map((s, i) => ({ id: `t-${i}`, title: `dep-${i}`, status: s }));

  test("task with any non-DONE dependency is blocked", () => {
    expect(isBlocked("TODO", deps(["DONE", "IN_PROGRESS"]))).toBe(true);
    expect(isBlocked("TODO", deps(["DONE", "DONE"]))).toBe(false);
    expect(isBlocked("IN_PROGRESS", deps(["TODO"]))).toBe(true);
  });

  test("DONE tasks are never blocked", () => {
    expect(isBlocked("DONE", deps(["TODO"]))).toBe(false);
  });

  test("blockedBy lists only unfinished prerequisites", () => {
    const b = blockedBy("TODO", [
      { id: "a", title: "A", status: "DONE" },
      { id: "b", title: "B", status: "IN_PROGRESS" },
      { id: "c", title: "C", status: "TODO" },
    ]);
    expect(b.map((d) => d.id).sort()).toEqual(["b", "c"]);
  });

  test("effectiveStatus is BLOCKED when blocked, else stored status", () => {
    expect(effectiveStatus("TODO", deps(["TODO"]))).toBe("BLOCKED");
    expect(effectiveStatus("TODO", deps([]))).toBe("TODO");
    expect(effectiveStatus("IN_PROGRESS", deps(["DONE"]))).toBe("IN_PROGRESS");
  });
});

describe("dependency graph validation", () => {
  const edges = [
    { taskId: "C", dependsOnId: "A" },
    { taskId: "C", dependsOnId: "B" },
  ];

  test("self-dependency rejected", () => {
    const r = validateAddDependency("A", "A", { sameProject: true, adjacency: edges });
    expect(r?.code).toBe("SELF_DEPENDENCY");
  });

  test("cross-project dependency rejected", () => {
    const r = validateAddDependency("A", "D", { sameProject: false, adjacency: edges });
    expect(r?.code).toBe("CROSS_PROJECT_DEPENDENCY");
  });

  test("direct cycle rejected: B -> C -> B", () => {
    // B depends on C? Existing: C dependsOn B. Adding B dependsOn C closes B->C->B.
    const r = validateAddDependency("B", "C", { sameProject: true, adjacency: edges });
    expect(r?.code).toBe("DEPENDENCY_CYCLE");
  });

  test("longer cycle rejected: A -> C, C -> B, B -> A (A->C->B->A)", () => {
    // Existing: C->A, C->B. Add A -> B: path B->? ... B has no outgoing edges, no cycle.
    const r1 = validateAddDependency("A", "B", { sameProject: true, adjacency: edges });
    expect(r1).toBeNull();
    // Now A depends on B; add B -> A? B->A plus A->B is a cycle.
    const r2 = validateAddDependency("B", "A", {
      sameProject: true,
      adjacency: [...edges, { taskId: "A", dependsOnId: "B" }],
    });
    expect(r2?.code).toBe("DEPENDENCY_CYCLE");
  });

  test("3-node cycle rejected: A->B, B->C, then C->A", () => {
    const base = [
      { taskId: "B", dependsOnId: "A" },
      { taskId: "C", dependsOnId: "B" },
    ];
    const r = validateAddDependency("A", "C", { sameProject: true, adjacency: base });
    expect(r?.code).toBe("DEPENDENCY_CYCLE");
  });

  test("a valid chain does not create a cycle", () => {
    const r = validateAddDependency("C", "D", {
      sameProject: true,
      adjacency: [...edges, { taskId: "D", dependsOnId: "E" }],
    });
    expect(r).toBeNull();
  });
});

describe("allowedActions hints match server enforcement", () => {
  test("blocked task reports canStart false with TASK_BLOCKED and blockedBy", () => {
    const actions = computeAllowedActions(
      { ...frontend, isProjectMember: true },
      { status: "TODO", assigneeId: "u-fe", department: "FRONTEND" },
      [{ id: "t-ui", title: "UI Design", status: "IN_PROGRESS" }],
    );
    expect(actions.canStart.allowed).toBe(false);
    expect(actions.canStart.reason).toBe("TASK_BLOCKED");
    expect(actions.canStart.blockedBy?.[0]?.title).toBe("UI Design");
    expect(actions.canComplete.allowed).toBe(false);
    expect(actions.canComplete.reason).toBe("INVALID_TRANSITION");
    expect(actions.canEdit.allowed).toBe(false); // internal cannot edit core fields
    expect(actions.canManageDependencies.allowed).toBe(false); // internal
  });

  test("PM sees edit/manage-dependencies allowed, complete not allowed", () => {
    const actions = computeAllowedActions(
      { ...pm, isProjectMember: true },
      { status: "IN_PROGRESS", assigneeId: "u-fe", department: null },
      [],
    );
    expect(actions.canEdit.allowed).toBe(true);
    expect(actions.canManageDependencies.allowed).toBe(true);
    expect(actions.canComplete.allowed).toBe(false);
    expect(actions.canComplete.reason).toBe("PM_CANNOT_COMPLETE");
    expect(actions.canStart.allowed).toBe(true); // PM can start any task
  });
});
