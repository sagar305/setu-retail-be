import "dotenv/config";
import { defineConfig } from "prisma/config";

// DATABASE_URL is any PostgreSQL connection string (Neon, Supabase, RDS,
// self-hosted…). On Vercel use the provider's *pooled* URL.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: process.env["DATABASE_URL"],
  },
});
