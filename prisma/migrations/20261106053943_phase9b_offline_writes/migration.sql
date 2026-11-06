-- CreateEnum
CREATE TYPE "ConflictStatus" AS ENUM ('OPEN', 'RESOLVED');

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "key" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "status" INTEGER,
    "body" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "conflicts" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "branchId" UUID,
    "kind" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "relatedId" TEXT,
    "label" TEXT NOT NULL,
    "field" TEXT,
    "baseValue" JSONB,
    "cloudValue" JSONB,
    "deviceValue" JSONB,
    "userId" UUID,
    "userName" TEXT NOT NULL DEFAULT '',
    "changedAt" TIMESTAMPTZ(3) NOT NULL,
    "status" "ConflictStatus" NOT NULL DEFAULT 'OPEN',
    "resolution" TEXT,
    "resolvedBy" UUID,
    "resolvedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conflicts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idempotency_keys_createdAt_idx" ON "idempotency_keys"("createdAt");

-- CreateIndex
CREATE INDEX "conflicts_accountId_status_createdAt_idx" ON "conflicts"("accountId", "status", "createdAt");
