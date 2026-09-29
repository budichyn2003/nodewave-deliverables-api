import type { Project, ProjectMember, User } from "../../../generated/prisma/client";

type ProjectWithMembers = Project & {
  members?: (ProjectMember & { user: User })[];
};

/**
 * Internal serializer for projects. Internal identities (member names) are
 * fine here — this shape must never be served to CLIENT users; the
 * client-view module has its own strict whitelist serializer.
 */
export function serializeProject(project: ProjectWithMembers): Record<string, unknown> {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    ...(project.members
      ? {
          members: project.members
            .filter((m) => !m.deletedAt)
            .map((m) => ({
              userId: m.userId,
              role: m.user.role,
              department: m.user.department,
              name: m.user.name,
              email: m.user.email,
            })),
        }
      : {}),
  };
}
