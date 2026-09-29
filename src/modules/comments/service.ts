import type { Prisma } from "../../../generated/prisma/client";
import { ApiError } from "../../lib/errors";
import { type ParsedListQuery, parseListQuery } from "../../lib/ezfilter";
import { prisma } from "../../lib/prisma";
import { canCommentInternally } from "../../policies/tasks";
import type { AuthUser } from "../../types";
import { isMember } from "../projects/service";
import type { CreateCommentInput } from "./schemas";
import { commentListWhitelist } from "./schemas";

async function visibleTask(actor: AuthUser, taskId: string) {
  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task || !(await isMember(actor.id, task.projectId))) throw ApiError.notFound("Task");
  return task;
}

export async function createComment(actor: AuthUser, taskId: string, input: CreateCommentInput) {
  if (!canCommentInternally(actor)) {
    throw new ApiError("FORBIDDEN", "Clients cannot comment on tasks");
  }
  await visibleTask(actor, taskId);
  return prisma.comment.create({
    data: {
      taskId,
      authorId: actor.id,
      body: input.body,
      isInternal: input.isInternal ?? true,
    },
  });
}

export async function listComments(actor: AuthUser, taskId: string, query: URLSearchParams) {
  // Clients must not even list comments (masking happens at this layer).
  if (actor.role === "CLIENT") throw ApiError.notFound("Task");
  await visibleTask(actor, taskId);

  const q: ParsedListQuery = parseListQuery(query, commentListWhitelist);
  const userFragments = (q.where as { AND?: unknown[] }).AND ?? [];
  const rawOrderBy = q.orderBy as Prisma.CommentOrderByWithRelationInput | undefined;
  const orderBy: Prisma.CommentOrderByWithRelationInput =
    rawOrderBy && Object.keys(rawOrderBy).length > 0 ? rawOrderBy : { createdAt: "asc" };

  const where: Prisma.CommentWhereInput = {
    taskId,
    AND: userFragments as Prisma.CommentWhereInput[],
  };

  const [rows, total] = await Promise.all([
    prisma.comment.findMany({
      where,
      orderBy,
      take: q.take,
      skip: q.skip,
      include: { author: true },
    }),
    prisma.comment.count({ where }),
  ]);

  return {
    data: rows.map((cm) => ({
      id: cm.id,
      taskId: cm.taskId,
      body: cm.body,
      isInternal: cm.isInternal,
      author: { id: cm.author.id, name: cm.author.name, department: cm.author.department },
      createdAt: cm.createdAt,
    })),
    meta: { page: q.page, rows: q.rows, total },
  };
}
