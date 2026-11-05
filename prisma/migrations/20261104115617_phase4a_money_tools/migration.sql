-- CreateEnum
CREATE TYPE "CustomerEntryType" AS ENUM ('OPENING', 'CREDIT', 'PAYMENT');

-- CreateEnum
CREATE TYPE "CashEntryType" AS ENUM ('IN', 'OUT');

-- CreateEnum
CREATE TYPE "PurchaseReturnMode" AS ENUM ('CREDIT_NOTE', 'REPLACEMENT');

-- CreateEnum
CREATE TYPE "PurchaseReturnStatus" AS ENUM ('SETTLED', 'PENDING', 'RECEIVED');

-- CreateEnum
CREATE TYPE "SupplierEntryType" AS ENUM ('OPENING', 'BILL', 'PAYMENT');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "InventoryChange" ADD VALUE 'PURCHASE';
ALTER TYPE "InventoryChange" ADD VALUE 'PURCHASE_RETURN';
ALTER TYPE "InventoryChange" ADD VALUE 'REPLACEMENT';
ALTER TYPE "InventoryChange" ADD VALUE 'PURCHASE_CANCEL';

-- AlterTable
ALTER TABLE "accounts" ADD COLUMN     "disabledTools" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "suppliers" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL DEFAULT '',
    "email" TEXT NOT NULL DEFAULT '',
    "gstin" TEXT,
    "stateCode" TEXT,
    "address" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "archivedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expenses" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "spentAt" TIMESTAMPTZ(3) NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "amount" INTEGER NOT NULL,
    "methodId" UUID,
    "methodName" TEXT NOT NULL,
    "kind" "PaymentKind" NOT NULL,
    "supplierId" UUID,
    "userId" UUID,
    "counterId" UUID,
    "offline" BOOLEAN NOT NULL DEFAULT false,
    "importedFrom" TEXT,
    "deletedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "expenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_ledger_entries" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "branchId" UUID,
    "type" "CustomerEntryType" NOT NULL,
    "amount" INTEGER NOT NULL,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "methodId" UUID,
    "methodName" TEXT NOT NULL DEFAULT '',
    "kind" "PaymentKind",
    "note" TEXT NOT NULL DEFAULT '',
    "userId" UUID,
    "counterId" UUID,
    "offline" BOOLEAN NOT NULL DEFAULT false,
    "importedFrom" TEXT,
    "voidedAt" TIMESTAMPTZ(3),
    "voidedById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_entries" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "type" "CashEntryType" NOT NULL,
    "amount" INTEGER NOT NULL,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "description" TEXT NOT NULL,
    "userId" UUID,
    "importedFrom" TEXT,
    "deletedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_openings" (
    "branchId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "day" DATE NOT NULL,
    "amount" INTEGER NOT NULL,
    "userId" UUID,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "cash_openings_pkey" PRIMARY KEY ("branchId")
);

-- CreateTable
CREATE TABLE "purchases" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "supplierId" UUID NOT NULL,
    "billNumber" TEXT NOT NULL,
    "billDate" DATE NOT NULL,
    "dueDate" DATE,
    "interState" BOOLEAN NOT NULL DEFAULT false,
    "taxableTotal" INTEGER NOT NULL,
    "cgstTotal" INTEGER NOT NULL,
    "sgstTotal" INTEGER NOT NULL,
    "igstTotal" INTEGER NOT NULL,
    "total" INTEGER NOT NULL,
    "paidAmount" INTEGER NOT NULL DEFAULT 0,
    "paidMethodId" UUID,
    "paidMethodName" TEXT NOT NULL DEFAULT '',
    "paidKind" "PaymentKind",
    "notes" TEXT NOT NULL DEFAULT '',
    "stockApplied" BOOLEAN NOT NULL DEFAULT true,
    "importedFrom" TEXT,
    "userId" UUID,
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelReason" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "purchases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_items" (
    "id" UUID NOT NULL,
    "purchaseId" UUID NOT NULL,
    "productId" UUID,
    "name" TEXT NOT NULL,
    "hsn" TEXT NOT NULL DEFAULT '',
    "unit" TEXT NOT NULL DEFAULT 'pcs',
    "qtyMilli" INTEGER NOT NULL,
    "unitCost" INTEGER NOT NULL,
    "gstRateBp" INTEGER NOT NULL DEFAULT 0,
    "taxable" INTEGER NOT NULL,
    "cgst" INTEGER NOT NULL,
    "sgst" INTEGER NOT NULL,
    "igst" INTEGER NOT NULL,
    "total" INTEGER NOT NULL,
    "batchId" UUID,
    "batchNo" TEXT NOT NULL DEFAULT '',
    "expiry" DATE,
    "returnedQtyMilli" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "purchase_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_returns" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "purchaseId" UUID NOT NULL,
    "supplierId" UUID NOT NULL,
    "mode" "PurchaseReturnMode" NOT NULL,
    "status" "PurchaseReturnStatus" NOT NULL,
    "taxableTotal" INTEGER NOT NULL,
    "cgstTotal" INTEGER NOT NULL,
    "sgstTotal" INTEGER NOT NULL,
    "igstTotal" INTEGER NOT NULL,
    "total" INTEGER NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "receivedAt" TIMESTAMPTZ(3),
    "importedFrom" TEXT,
    "userId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_returns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_return_items" (
    "id" UUID NOT NULL,
    "returnId" UUID NOT NULL,
    "purchaseItemId" UUID,
    "productId" UUID,
    "name" TEXT NOT NULL,
    "qtyMilli" INTEGER NOT NULL,
    "taxable" INTEGER NOT NULL,
    "cgst" INTEGER NOT NULL,
    "sgst" INTEGER NOT NULL,
    "igst" INTEGER NOT NULL,
    "total" INTEGER NOT NULL,

    CONSTRAINT "purchase_return_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_ledger_entries" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "supplierId" UUID NOT NULL,
    "branchId" UUID,
    "type" "SupplierEntryType" NOT NULL,
    "amount" INTEGER NOT NULL,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "dueDate" DATE,
    "methodId" UUID,
    "methodName" TEXT NOT NULL DEFAULT '',
    "kind" "PaymentKind",
    "note" TEXT NOT NULL DEFAULT '',
    "userId" UUID,
    "counterId" UUID,
    "offline" BOOLEAN NOT NULL DEFAULT false,
    "importedFrom" TEXT,
    "voidedAt" TIMESTAMPTZ(3),
    "voidedById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "suppliers_accountId_name_idx" ON "suppliers"("accountId", "name");

-- CreateIndex
CREATE INDEX "expenses_accountId_branchId_spentAt_idx" ON "expenses"("accountId", "branchId", "spentAt");

-- CreateIndex
CREATE INDEX "customer_ledger_entries_accountId_customerId_occurredAt_idx" ON "customer_ledger_entries"("accountId", "customerId", "occurredAt");

-- CreateIndex
CREATE INDEX "customer_ledger_entries_branchId_occurredAt_idx" ON "customer_ledger_entries"("branchId", "occurredAt");

-- CreateIndex
CREATE INDEX "cash_entries_branchId_occurredAt_idx" ON "cash_entries"("branchId", "occurredAt");

-- CreateIndex
CREATE INDEX "purchases_accountId_supplierId_billDate_idx" ON "purchases"("accountId", "supplierId", "billDate");

-- CreateIndex
CREATE INDEX "purchases_accountId_branchId_billDate_idx" ON "purchases"("accountId", "branchId", "billDate");

-- CreateIndex
CREATE INDEX "purchase_items_purchaseId_idx" ON "purchase_items"("purchaseId");

-- CreateIndex
CREATE INDEX "purchase_returns_accountId_supplierId_occurredAt_idx" ON "purchase_returns"("accountId", "supplierId", "occurredAt");

-- CreateIndex
CREATE INDEX "purchase_return_items_returnId_idx" ON "purchase_return_items"("returnId");

-- CreateIndex
CREATE INDEX "supplier_ledger_entries_accountId_supplierId_occurredAt_idx" ON "supplier_ledger_entries"("accountId", "supplierId", "occurredAt");

-- CreateIndex
CREATE INDEX "supplier_ledger_entries_branchId_occurredAt_idx" ON "supplier_ledger_entries"("branchId", "occurredAt");

-- AddForeignKey
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "purchases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "purchases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_return_items" ADD CONSTRAINT "purchase_return_items_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES "purchase_returns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
