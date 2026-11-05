-- CreateEnum
CREATE TYPE "AdminStatus" AS ENUM ('INVITED', 'ACTIVE', 'DISABLED');

-- AlterEnum
ALTER TYPE "SubscriptionSource" ADD VALUE 'GRANT';

-- AlterTable
ALTER TABLE "accounts" ADD COLUMN     "lockReason" TEXT;

-- AlterTable
ALTER TABLE "inventory_logs" ADD COLUMN     "seq" BIGSERIAL NOT NULL;

-- CreateTable
CREATE TABLE "super_admins" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "AdminStatus" NOT NULL DEFAULT 'INVITED',
    "passwordHash" TEXT,
    "totpSecretEnc" TEXT,
    "totpLastStep" INTEGER,
    "failedLogins" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMPTZ(3),
    "lastLoginAt" TIMESTAMPTZ(3),
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "super_admins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_sessions" (
    "id" UUID NOT NULL,
    "adminId" UUID NOT NULL,
    "refreshTokenHash" TEXT NOT NULL,
    "previousHash" TEXT,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),
    "userAgent" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_tokens" (
    "id" UUID NOT NULL,
    "adminId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "usedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_audit_logs" (
    "id" UUID NOT NULL,
    "adminId" UUID,
    "adminName" TEXT NOT NULL DEFAULT '',
    "action" TEXT NOT NULL,
    "accountId" UUID,
    "data" JSONB,
    "ip" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "issued_keys" (
    "id" UUID NOT NULL,
    "keyId" TEXT NOT NULL,
    "accountId" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "days" INTEGER NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "issuedById" UUID NOT NULL,
    "issuedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMPTZ(3),

    CONSTRAINT "issued_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expiry_reminders" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "endsAt" TIMESTAMPTZ(3) NOT NULL,
    "step" INTEGER NOT NULL,
    "adminId" UUID,
    "sentAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expiry_reminders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "super_admins_email_key" ON "super_admins"("email");

-- CreateIndex
CREATE UNIQUE INDEX "admin_sessions_refreshTokenHash_key" ON "admin_sessions"("refreshTokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "admin_sessions_previousHash_key" ON "admin_sessions"("previousHash");

-- CreateIndex
CREATE INDEX "admin_sessions_adminId_idx" ON "admin_sessions"("adminId");

-- CreateIndex
CREATE UNIQUE INDEX "admin_tokens_tokenHash_key" ON "admin_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "admin_tokens_adminId_idx" ON "admin_tokens"("adminId");

-- CreateIndex
CREATE INDEX "admin_audit_logs_createdAt_idx" ON "admin_audit_logs"("createdAt");

-- CreateIndex
CREATE INDEX "admin_audit_logs_accountId_createdAt_idx" ON "admin_audit_logs"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "admin_audit_logs_adminId_createdAt_idx" ON "admin_audit_logs"("adminId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "issued_keys_keyId_key" ON "issued_keys"("keyId");

-- CreateIndex
CREATE INDEX "issued_keys_accountId_idx" ON "issued_keys"("accountId");

-- CreateIndex
CREATE INDEX "issued_keys_issuedAt_idx" ON "issued_keys"("issuedAt");

-- CreateIndex
CREATE INDEX "expiry_reminders_accountId_endsAt_step_idx" ON "expiry_reminders"("accountId", "endsAt", "step");

-- AddForeignKey
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "super_admins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_tokens" ADD CONSTRAINT "admin_tokens_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "super_admins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "issued_keys" ADD CONSTRAINT "issued_keys_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expiry_reminders" ADD CONSTRAINT "expiry_reminders_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One automatic reminder per account, end date and step (manual ones, step 0, may repeat).
CREATE UNIQUE INDEX "expiry_reminders_auto_once" ON "expiry_reminders"("accountId", "endsAt", "step") WHERE "step" > 0;
