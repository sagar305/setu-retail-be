import type { Prisma, PrismaClient } from "../generated/prisma/client.js";

/** A client or an open transaction. */
export type Db = PrismaClient | Prisma.TransactionClient;
