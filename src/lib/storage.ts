import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "../config/env";
import { ApiError } from "./errors";

/**
 * Storage abstraction so the local-disk driver can be swapped for an
 * S3-compatible one without touching handlers. Documented caveat: local
 * disk is EPHEMERAL on many hosts (Railway/Render/Heroku) — files are lost
 * on redeploy. Use STORAGE_DRIVER=s3 in production for durability.
 */
export interface StorageService {
  /** Persists a file and returns its public/relative URL key. */
  save(key: string, data: Buffer, mimeType: string): Promise<{ url: string }>;
  remove(key: string): Promise<void>;
}

const ALLOWED_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "application/pdf",
  "text/plain",
  "text/csv",
  "application/json",
  "application/zip",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

const ALLOWED_EXTENSIONS = /\.(png|jpe?g|gif|webp|svg|pdf|txt|csv|json|zip|docx?|xlsx?|pptx?)$/i;

export function validateFile(meta: { fileName: string; mimeType: string; size: number }): void {
  // Browsers/runtimes may append parameters (e.g. ";charset=utf-8") —
  // compare on the base type only.
  const baseType = meta.mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!ALLOWED_MIME.has(baseType)) {
    throw new ApiError("UNSUPPORTED_MEDIA_TYPE", `File type ${meta.mimeType} is not allowed`);
  }
  if (!ALLOWED_EXTENSIONS.test(meta.fileName)) {
    throw new ApiError("UNSUPPORTED_MEDIA_TYPE", "File extension is not allowed");
  }
  const maxBytes = env.MAX_UPLOAD_SIZE_MB * 1024 * 1024;
  if (meta.size > maxBytes) {
    throw new ApiError("PAYLOAD_TOO_LARGE", `File exceeds ${env.MAX_UPLOAD_SIZE_MB}MB limit`);
  }
  if (meta.fileName.includes("..") || meta.fileName.includes("/") || meta.fileName.includes("\\")) {
    throw new ApiError("VALIDATION_ERROR", "Invalid file name");
  }
}

/** Local-disk driver (dev/demo). Files live under STORAGE_LOCAL_DIR. */
export class LocalStorage implements StorageService {
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(process.cwd(), root);
  }

  async save(key: string, data: Buffer, _mimeType: string): Promise<{ url: string }> {
    const target = path.join(this.root, key);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data);
    return { url: `/files/${key}` };
  }

  async remove(key: string): Promise<void> {
    try {
      await unlink(path.join(this.root, key));
    } catch {
      // Already gone — removal is best-effort.
    }
  }
}

/** S3-compatible driver placeholder — activate with STORAGE_DRIVER=s3. */
export class S3Storage implements StorageService {
  // Wire an S3 client here when needed; interface is the contract.
  async save(): Promise<{ url: string }> {
    throw new Error(
      "S3Storage not configured: implement with an S3 client or use STORAGE_DRIVER=local",
    );
  }

  async remove(): Promise<void> {
    throw new Error("S3Storage not configured");
  }
}

export function getStorage(): StorageService {
  return env.STORAGE_DRIVER === "s3" ? new S3Storage() : new LocalStorage(env.STORAGE_LOCAL_DIR);
}
