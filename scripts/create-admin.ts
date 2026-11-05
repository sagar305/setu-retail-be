// Creates the first Setu team (super-admin) login, or sends a fresh link to an
// existing one (e.g. the only admin lost their phone). Run on a machine with
// the production DATABASE_URL:
//
//   npm run admin:create -- you@setutechnology.com "Your Name"
//
// It prints the set-password link and also emails it. After setting a
// password, the first sign-in at /super-admin links an authenticator app.
import "dotenv/config";
import { loadEnv } from "../src/config/env.js";
import { getPrisma } from "../src/db/client.js";
import { normalizeEmail } from "../src/lib/normalize.js";
import { LogMailer, ResendMailer } from "../src/mail/mailer.js";
import { sendAdminLink } from "../src/routes/adminAuth.js";
import { revokeAdminSessions } from "../src/auth/admin.js";

const [emailArg, ...nameParts] = process.argv.slice(2);
const name = nameParts.join(" ").trim();
if (!emailArg || !emailArg.includes("@")) {
  console.error('Usage: npm run admin:create -- <email> "<name>"');
  process.exit(1);
}

const env = loadEnv();
const prisma = getPrisma();
const mailer = env.RESEND_API_KEY ? new ResendMailer(env.RESEND_API_KEY, env.MAIL_FROM) : new LogMailer();
const ctx = { env, prisma, mailer, now: () => new Date() };
const email = normalizeEmail(emailArg);

const existing = await prisma.superAdmin.findUnique({ where: { email } });
let admin;
if (existing) {
  admin = await prisma.superAdmin.update({ where: { id: existing.id }, data: { status: "INVITED", passwordHash: null, totpSecretEnc: null, totpLastStep: null, failedLogins: 0, lockedUntil: null } });
  await revokeAdminSessions(prisma, admin.id, new Date());
} else {
  if (!name) {
    console.error("Give a name for a new admin.");
    process.exit(1);
  }
  admin = await prisma.superAdmin.create({ data: { email, name, status: "INVITED" } });
}
const link = await sendAdminLink(ctx, admin, Boolean(existing));
await prisma.adminAuditLog.create({ data: { adminId: null, adminName: "server command", action: existing ? "admin.reset" : "admin.invited", data: { adminId: admin.id, email } } });
console.log(`${existing ? "Reset" : "Created"} ${email}. Set-password link (works once, 48 hours):\n${link}`);
await prisma.$disconnect();
