-- CreateEnum
CREATE TYPE "TransferStatus" AS ENUM ('SENT', 'RECEIVED', 'CANCELLED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "InventoryChange" ADD VALUE 'TRANSFER_OUT';
ALTER TYPE "InventoryChange" ADD VALUE 'TRANSFER_IN';
ALTER TYPE "InventoryChange" ADD VALUE 'TRANSFER_RETURN';

-- AlterTable
ALTER TABLE "accounts" ADD COLUMN     "nextTransferNumber" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN     "branchId" UUID,
ADD COLUMN     "ip" TEXT;

-- CreateTable
CREATE TABLE "stock_transfers" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "fromBranchId" UUID NOT NULL,
    "toBranchId" UUID NOT NULL,
    "status" "TransferStatus" NOT NULL DEFAULT 'SENT',
    "note" TEXT NOT NULL DEFAULT '',
    "sentById" UUID NOT NULL,
    "sentAt" TIMESTAMPTZ(3) NOT NULL,
    "receivedById" UUID,
    "receivedAt" TIMESTAMPTZ(3),
    "receiveNote" TEXT NOT NULL DEFAULT '',
    "cancelledById" UUID,
    "cancelledAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_transfer_items" (
    "id" UUID NOT NULL,
    "transferId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "qtyMilli" INTEGER NOT NULL,
    "receivedMilli" INTEGER,
    "returnedMilli" INTEGER NOT NULL DEFAULT 0,
    "writtenOffMilli" INTEGER NOT NULL DEFAULT 0,
    "unitCost" INTEGER,

    CONSTRAINT "stock_transfer_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_transfer_batches" (
    "id" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "sourceBatchId" UUID,
    "batchNo" TEXT NOT NULL DEFAULT '',
    "expiry" DATE,
    "costPrice" INTEGER,
    "qtyMilli" INTEGER NOT NULL,

    CONSTRAINT "stock_transfer_batches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stock_transfers_accountId_status_sentAt_idx" ON "stock_transfers"("accountId", "status", "sentAt");

-- CreateIndex
CREATE INDEX "stock_transfers_fromBranchId_sentAt_idx" ON "stock_transfers"("fromBranchId", "sentAt");

-- CreateIndex
CREATE INDEX "stock_transfers_toBranchId_sentAt_idx" ON "stock_transfers"("toBranchId", "sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "stock_transfers_accountId_number_key" ON "stock_transfers"("accountId", "number");

-- CreateIndex
CREATE INDEX "stock_transfer_items_transferId_idx" ON "stock_transfer_items"("transferId");

-- CreateIndex
CREATE INDEX "stock_transfer_batches_itemId_idx" ON "stock_transfer_batches"("itemId");

-- CreateIndex
CREATE INDEX "audit_logs_accountId_branchId_createdAt_idx" ON "audit_logs"("accountId", "branchId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_accountId_userId_createdAt_idx" ON "audit_logs"("accountId", "userId", "createdAt");

-- AddForeignKey
ALTER TABLE "stock_transfer_items" ADD CONSTRAINT "stock_transfer_items_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "stock_transfers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer_batches" ADD CONSTRAINT "stock_transfer_batches_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "stock_transfer_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
