import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client";
import { env } from "../config/env";
import { FILTERED_READ_OPS, FILTERED_WRITE_OPS, SOFT_DELETE_MODELS } from "./soft-delete";

type BaseClient = InstanceType<typeof PrismaClient>;

/** Client shape with the extension-internal operations removed from the surface. */
type DelegatedClient = Omit<
  BaseClient,
  | "$extends"
  | "$transaction"
  | "$queryRaw"
  | "$executeRaw"
  | "$disconnect"
  | "$connect"
  | "$on"
  | "$use"
>;

/** Extended client: soft-delete baked in + $includeDeleted escape hatch. */
export interface ExtendedPrismaClient extends DelegatedClient {
  $includeDeleted: () => DelegatedClient;
  $transaction: BaseClient["$transaction"];
  $queryRaw: BaseClient["$queryRaw"];
  $executeRaw: BaseClient["$executeRaw"];
  $queryRawUnsafe: BaseClient["$queryRawUnsafe"];
  $executeRawUnsafe: BaseClient["$executeRawUnsafe"];
  $disconnect: BaseClient["$disconnect"];
}

function toDelegateName(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1);
}

/**
 * Creates an extended Prisma client. Soft-delete behaviour is baked in:
 * - reads/writes exclude `deletedAt != null` rows for soft-deletable models
 * - `delete`/`deleteMany` are rerouted to update/updateMany stamping
 *   `deletedAt` on the RAW client, so the physical delete never executes
 * - `$includeDeleted()` is the explicit escape hatch (restore, audit, seed)
 */
export function createPrismaClient(connectionString: string): ExtendedPrismaClient {
  const base = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

  const extended = base.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!model || !SOFT_DELETE_MODELS.has(model)) {
            return query(args);
          }

          // --- delete -> update (soft): executed on the raw client so the
          // original destructive operation is bypassed entirely ---
          if (operation === "delete" || operation === "deleteMany") {
            const delegate = (base as unknown as Record<string, unknown>)[
              toDelegateName(model)
            ] as {
              update(args: unknown): Promise<unknown>;
              updateMany(args: unknown): Promise<unknown>;
            };
            const where = { ...((args as Record<string, unknown>).where ?? {}), deletedAt: null };
            if (operation === "delete") {
              return delegate.update({ where, data: { deletedAt: new Date() } });
            }
            return delegate.updateMany({ where, data: { deletedAt: new Date() } });
          }

          // --- Reads: force the deletedAt filter ---
          if (FILTERED_READ_OPS.has(operation)) {
            const a = args as Record<string, unknown>;
            a.where = { ...((a.where as object | undefined) ?? {}), deletedAt: null };
            return query(a);
          }

          // --- Other writes: scope mutations to live rows ---
          if (FILTERED_WRITE_OPS.has(operation)) {
            const a = args as Record<string, unknown>;
            a.where = { ...((a.where as object | undefined) ?? {}), deletedAt: null };
            return query(a);
          }

          return query(args);
        },
      },
    },
    client: {
      $includeDeleted() {
        return base as unknown as DelegatedClient;
      },
    },
  });

  return extended as unknown as ExtendedPrismaClient;
}

/** Application-wide singleton bound to DATABASE_URL. */
export const prisma: ExtendedPrismaClient = createPrismaClient(env.DATABASE_URL);

export default prisma;
