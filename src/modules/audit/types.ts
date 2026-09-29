import type { Prisma } from "../../../generated/prisma/client";
import type { ExtendedPrismaClient } from "../../lib/prisma";

/** Either the extended client or an interactive-transaction client. */
export type PrismaClientOrTx =
  | ExtendedPrismaClient
  | Omit<
      Prisma.TransactionClient,
      "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
    >;
