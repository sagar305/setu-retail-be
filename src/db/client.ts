import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";

let prisma: PrismaClient | undefined;

/**
 * One PrismaClient per process (per warm serverless instance on Vercel).
 * Created lazily so routes that never touch the database — and the tests —
 * don't need DATABASE_URL.
 */
export function getPrisma(): PrismaClient {
  if (!prisma) {
    const connectionString = process.env["DATABASE_URL"];
    if (!connectionString) throw new Error("DATABASE_URL is not set");
    // Each serverless instance keeps its own pool: keep it small so many
    // instances fit in the database's connection limit (DATABASE_POOL_MAX).
    const max = Number(process.env["DATABASE_POOL_MAX"] ?? 5);
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString, max: Number.isInteger(max) && max > 0 ? max : 5, idleTimeoutMillis: 10_000 }) });
  }
  return prisma;
}

export async function checkDatabase(): Promise<void> {
  await getPrisma().$queryRaw`SELECT 1`;
}
