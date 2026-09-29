import type { AuthUser } from "../types";

/**
 * Pure permission functions for projects (RBAC + ABAC).
 * These take plain data (principal + project shape) and return booleans or
 * scope descriptors — no DB, no HTTP. The same functions back the write
 * endpoints and the `allowedActions` computation, so UI hints and server
 * enforcement can never diverge.
 */

/** Scope fragment limiting project lists to what the actor may see. */
export type ProjectScope = {
  // PM: projects they manage = projects they created. We model "managed by"
  // as explicit PM membership rows, so the scope is a membership filter.
  viaMembership: true;
  requireMembership: boolean;
  /** CLIENT users only ever see their own (single) project via membership. */
  clientTenantOnly: boolean;
};

export function projectListScope(user: AuthUser): ProjectScope {
  return {
    viaMembership: true,
    // INTERNAL users: member-only. PM: member of the projects they manage.
    requireMembership: user.role !== "CLIENT",
    clientTenantOnly: user.role === "CLIENT",
  };
}

export function canCreateProject(user: AuthUser): boolean {
  return user.role === "PM";
}

export function canUpdateProject(user: AuthUser): boolean {
  return user.role === "PM";
}

export function canSoftDeleteProject(user: AuthUser): boolean {
  return user.role === "PM";
}

export function canManageMembers(user: AuthUser): boolean {
  return user.role === "PM";
}

/** Membership is the ABAC gate: every non-PM must be a member to view. */
export function canViewProject(user: AuthUser, isMember: boolean): boolean {
  if (user.role === "PM") return isMember; // PM manages only their projects
  return isMember; // INTERNAL/CLIENT: membership required (CLIENT: own tenant)
}

/** PM needs membership too (they are seeded/added as members of projects they manage). */
export function canManageMembersOnProject(user: AuthUser, isMember: boolean): boolean {
  return user.role === "PM" && isMember;
}
