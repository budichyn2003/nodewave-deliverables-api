import type { Prisma } from "../../../generated/prisma/client";
import { ApiError } from "../../lib/errors";
import { type ParsedListQuery, parseListQuery } from "../../lib/ezfilter";
import { prisma } from "../../lib/prisma";
import { getStorage, validateFile } from "../../lib/storage";
import { canUploadAttachment } from "../../policies/tasks";
import type { AuthUser } from "../../types";
import { isMember } from "../projects/service";
import { attachmentListWhitelist } from "./schemas";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function visibleTask(actor: AuthUser, taskId: string) {
  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task || !(await isMember(actor.id, task.projectId))) throw ApiError.notFound("Task");
  return task;
}

export interface UploadFile {
  name: string;
  type: string;
  size: number;
  data: Buffer;
}

export async function uploadAttachment(actor: AuthUser, taskId: string, file: UploadFile) {
  if (!canUploadAttachment(actor)) {
    throw new ApiError("FORBIDDEN", "Only PM and internal members can upload attachments");
  }
  const task = await visibleTask(actor, taskId);
  validateFile({ fileName: file.name, mimeType: file.type, size: file.size });

  const storage = getStorage();
  const key = `${task.projectId}/${taskId}/${crypto.randomUUID()}-${file.name}`;
  const { url } = await storage.save(key, file.data, file.type);

  return prisma.attachment.create({
    data: {
      taskId,
      uploadedById: actor.id,
      fileName: file.name,
      url,
      mimeType: file.type,
      size: file.size,
    },
  });
}

export async function listAttachments(actor: AuthUser, taskId: string, query: URLSearchParams) {
  await visibleTask(actor, taskId);

  const q: ParsedListQuery = parseListQuery(query, attachmentListWhitelist);
  const userFragments = (q.where as { AND?: unknown[] }).AND ?? [];
  const rawOrderBy = q.orderBy as Prisma.AttachmentOrderByWithRelationInput | undefined;
  const orderBy: Prisma.AttachmentOrderByWithRelationInput =
    rawOrderBy && Object.keys(rawOrderBy).length > 0 ? rawOrderBy : { createdAt: "asc" };

  const where: Prisma.AttachmentWhereInput = {
    taskId,
    AND: userFragments as Prisma.AttachmentWhereInput[],
  };

  const [rows, total] = await Promise.all([
    prisma.attachment.findMany({
      where,
      orderBy,
      take: q.take,
      skip: q.skip,
      include: { uploadedBy: true },
    }),
    prisma.attachment.count({ where }),
  ]);

  return {
    data: rows.map((a) => ({
      id: a.id,
      taskId: a.taskId,
      fileName: a.fileName,
      url: a.url,
      mimeType: a.mimeType,
      size: a.size,
      uploadedBy: { id: a.uploadedBy.id, name: a.uploadedBy.name },
      createdAt: a.createdAt,
    })),
    meta: { page: q.page, rows: q.rows, total },
  };
}

export { UUID_RE };
