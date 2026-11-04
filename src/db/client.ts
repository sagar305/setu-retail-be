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
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  }
  return prisma;
}

export async function checkDatabase(): Promise<void> {
  await getPrisma().$queryRaw`SELECT 1`;
}
