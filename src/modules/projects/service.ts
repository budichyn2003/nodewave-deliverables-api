import type { Prisma } from "../../../generated/prisma/client";
import { ApiError } from "../../lib/errors";
import { type ParsedListQuery, parseListQuery } from "../../lib/ezfilter";
import { prisma } from "../../lib/prisma";
import { canCreateProject, canManageMembers } from "../../policies/projects";
import type { AuthUser } from "../../types";
import type { CreateProjectInput, UpdateProjectInput } from "./schemas";
import { projectListWhitelist } from "./schemas";

/** True when the user has a live membership row on the project. */
export async function isMember(userId: string, projectId: string): Promise<boolean> {
  const m = await prisma.projectMember.findFirst({
    where: { userId, projectId },
    select: { id: true },
  });
  return m !== null;
}

/** PM gate + membership ABAC check. 404 (not 403) when not a member. */
export async function assertProjectManager(user: AuthUser, projectId: string): Promise<void> {
  if (!canManageMembers(user)) {
    throw new ApiError("FORBIDDEN", "Only PMs can manage projects");
  }
  if (!(await isMember(user.id, projectId))) {
    throw ApiError.notFound("Project");
  }
}

export async function createProject(user: AuthUser, input: CreateProjectInput) {
  if (!canCreateProject(user)) {
    throw new ApiError("FORBIDDEN", "Only PMs can create projects");
  }
  return prisma.$transaction(async (tx) => {
    const project = await tx.project.create({
      data: { name: input.name, description: input.description },
    });
    // The creating PM becomes the first member — "projects they manage"
    // is represented by PM membership rows.
    await tx.projectMember.create({
      data: { projectId: project.id, userId: user.id },
    });
    return project;
  });
}

export async function updateProject(user: AuthUser, projectId: string, input: UpdateProjectInput) {
  await assertProjectManager(user, projectId);
  return prisma.project.update({ where: { id: projectId }, data: input });
}

export async function softDeleteProject(user: AuthUser, projectId: string) {
  await assertProjectManager(user, projectId);
  await prisma.project.delete({ where: { id: projectId } }); // extension -> soft
  return { ok: true };
}

/** Role-scoped, contract-compliant project listing (membership visibility). */
export async function listProjects(user: AuthUser, query: URLSearchParams) {
  const q: ParsedListQuery = parseListQuery(query, projectListWhitelist);

  // ezfilter emits its conditions as top-level AND fragments; merge them
  // directly into the project's AND (no nesting — Prisma rejects empty
  // nested AND objects).
  const userFragments = (q.where as { AND?: unknown[] }).AND ?? [];

  // The whitelist only exposes project columns, so ordering targets the
  // related project rows. Applied on the OUTER query (before pagination
  // slicing) via the relation. Note: ezfilter always emits `orderBy: {}`
  // even without an orderKey — guard on key count.
  const rawOrderBy = q.orderBy as Prisma.ProjectOrderByWithRelationInput | undefined;
  const orderFrag: Prisma.ProjectMemberOrderByWithRelationInput[] =
    rawOrderBy && Object.keys(rawOrderBy).length > 0 ? [{ project: rawOrderBy }] : [];

  const membershipWhere: Prisma.ProjectMemberWhereInput = {
    userId: user.id,
    deletedAt: null,
    project: {
      deletedAt: null,
      AND: userFragments as Prisma.ProjectWhereInput[],
    },
  };

  const [rows, total] = await Promise.all([
    prisma.projectMember.findMany({
      where: membershipWhere,
      ...(orderFrag.length > 0 ? { orderBy: orderFrag } : {}),
      take: q.take,
      skip: q.skip,
      include: {
        project: { include: { members: { include: { user: true } } } },
      },
    }),
    prisma.projectMember.count({ where: membershipWhere }),
  ]);

  return {
    data: rows.map((r) => r.project),
    meta: { page: q.page, rows: q.rows, total },
  };
}

export async function getProject(user: AuthUser, projectId: string) {
  if (!(await isMember(user.id, projectId))) throw ApiError.notFound("Project");
  return prisma.project.findUnique({
    where: { id: projectId },
    include: { members: { include: { user: true } } },
  });
}

export async function addMember(user: AuthUser, projectId: string, memberUserId: string) {
  await assertProjectManager(user, projectId);

  const target = await prisma.user.findUnique({ where: { id: memberUserId } });
  if (!target) throw ApiError.notFound("User");

  // CLIENT users may belong to exactly one project (tenant invariant).
  if (target.role === "CLIENT") {
    const existing = await prisma.projectMember.findFirst({
      where: { userId: target.id, deletedAt: null, projectId: { not: projectId } },
      select: { id: true },
    });
    if (existing) {
      throw new ApiError("BUSINESS_RULE", "Client users can only be a member of one project");
    }
  }

  // Idempotent: revives a soft-deleted membership instead of erroring on the
  // unique(projectId, userId) constraint.
  const any = await prisma.$includeDeleted().projectMember.findFirst({
    where: { projectId, userId: memberUserId },
  });
  if (any) {
    return prisma.projectMember.update({ where: { id: any.id }, data: { deletedAt: null } });
  }
  return prisma.projectMember.create({ data: { projectId, userId: memberUserId } });
}

export async function removeMember(user: AuthUser, projectId: string, memberUserId: string) {
  await assertProjectManager(user, projectId);
  const membership = await prisma.projectMember.findFirst({
    where: { projectId, userId: memberUserId },
  });
  if (!membership) throw ApiError.notFound("Membership");
  await prisma.projectMember.delete({ where: { id: membership.id } }); // soft
  return { ok: true };
}
