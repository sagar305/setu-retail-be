import { z } from "zod";

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

// Development-only fallbacks. Production refuses to start without real values.
const DEV_JWT_SECRET = "dev-only-jwt-secret-not-for-production-000000";
const DEV_LICENSE_SECRET = "dev-only-license-secret-not-for-production";

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(4000),
    DATABASE_URL: z.string().min(1).optional(),
    /** Comma-separated list of browser origins allowed to call the API. */
    CORS_ORIGINS: z.string().default("http://localhost:5173"),
    LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
    /** Signs access tokens. 32+ random characters. */
    JWT_SECRET: z.string().min(32).default(DEV_JWT_SECRET),
    /** Decrypts SETU-R license keys; the same value as on setutechnology.com. */
    RETAIL_LICENSE_SECRET: z.string().min(16).default(DEV_LICENSE_SECRET),
    /** The web app's address, used in emailed links. */
    APP_URL: z.url().default("http://localhost:5173"),
    /** Resend API key. Without it, emails are written to the log instead (dev only). */
    RESEND_API_KEY: z.string().min(1).optional(),
    MAIL_FROM: z.string().default("Setu Retail <no-reply@setutechnology.com>"),
    /** Vercel Cron sends it as a bearer token to /internal/cron/*. Without it, the daily reminder job is off. */
    CRON_SECRET: z.string().min(16).optional(),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== "production") return;
    const need = (key: keyof typeof env, ok: boolean, message: string) => {
      if (!ok) ctx.addIssue({ code: "custom", path: [key], message });
    };
    need("DATABASE_URL", Boolean(env.DATABASE_URL), "DATABASE_URL is required in production");
    need("JWT_SECRET", env.JWT_SECRET !== DEV_JWT_SECRET, "JWT_SECRET must be set in production");
    need(
      "RETAIL_LICENSE_SECRET",
      env.RETAIL_LICENSE_SECRET !== DEV_LICENSE_SECRET,
      "RETAIL_LICENSE_SECRET must be set in production",
    );
    need("RESEND_API_KEY", Boolean(env.RESEND_API_KEY), "RESEND_API_KEY is required in production");
    need("APP_URL", env.APP_URL.startsWith("https://"), "APP_URL must be https in production");
  });

export type Env = z.infer<typeof schema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  // A blank line in .env (KEY=) means "not set", not "set to an empty string".
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== ""));
  const result = schema.safeParse(cleaned);
  if (!result.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export function corsOrigins(env: Env): string[] {
  return env.CORS_ORIGINS.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}
