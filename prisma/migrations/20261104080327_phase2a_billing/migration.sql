-- CreateEnum
CREATE TYPE "InventoryChange" AS ENUM ('OPENING', 'ADD', 'REDUCE', 'SET', 'SALE', 'CANCEL', 'RETURN');

-- CreateEnum
CREATE TYPE "PaymentKind" AS ENUM ('CASH', 'UPI', 'CARD', 'CREDIT', 'OTHER');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('COMPLETED', 'CANCELLED');

-- AlterTable
ALTER TABLE "accounts" ADD COLUMN     "allowNegativeStock" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "cashierMaxDiscountBp" INTEGER NOT NULL DEFAULT 1000,
ADD COLUMN     "receiptFooter" TEXT NOT NULL DEFAULT 'Thank you for shopping with us!',
ADD COLUMN     "receiptPaperSize" TEXT NOT NULL DEFAULT '80mm',
ADD COLUMN     "taxEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "categories" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "archivedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "categoryId" UUID,
    "name" TEXT NOT NULL,
    "sku" TEXT NOT NULL DEFAULT '',
    "barcode" TEXT NOT NULL DEFAULT '',
    "hsn" TEXT NOT NULL DEFAULT '',
    "gstRateBp" INTEGER NOT NULL DEFAULT 0,
    "taxInclusive" BOOLEAN NOT NULL DEFAULT true,
    "unit" TEXT NOT NULL DEFAULT 'pcs',
    "price" INTEGER NOT NULL,
    "costPrice" INTEGER,
    "trackStock" BOOLEAN NOT NULL DEFAULT true,
    "lowStockMilli" INTEGER,
    "archivedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "branch_products" (
    "branchId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "price" INTEGER,
    "stockMilli" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "branch_products_pkey" PRIMARY KEY ("branchId","productId")
);

-- CreateTable
CREATE TABLE "inventory_logs" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "type" "InventoryChange" NOT NULL,
    "changeMilli" INTEGER NOT NULL,
    "stockAfterMilli" INTEGER NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "refId" UUID,
    "userId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL DEFAULT '',
    "email" TEXT NOT NULL DEFAULT '',
    "address" TEXT NOT NULL DEFAULT '',
    "gstin" TEXT,
    "stateCode" TEXT,
    "notes" TEXT NOT NULL DEFAULT '',
    "archivedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_methods" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "PaymentKind" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_methods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "counters" (
    "id" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nextInvoiceNumber" INTEGER NOT NULL DEFAULT 1,
    "nextCreditNoteNumber" INTEGER NOT NULL DEFAULT 1,
    "lastSeenAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "counters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "counterId" UUID NOT NULL,
    "cashierId" UUID NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'COMPLETED',
    "customerId" UUID,
    "customerName" TEXT NOT NULL DEFAULT '',
    "customerPhone" TEXT NOT NULL DEFAULT '',
    "customerGstin" TEXT,
    "placeOfSupply" TEXT,
    "interState" BOOLEAN NOT NULL DEFAULT false,
    "taxEnabled" BOOLEAN NOT NULL,
    "discountType" TEXT NOT NULL DEFAULT 'flat',
    "discountValue" INTEGER NOT NULL DEFAULT 0,
    "subtotal" INTEGER NOT NULL,
    "discountTotal" INTEGER NOT NULL,
    "taxableTotal" INTEGER NOT NULL,
    "cgstTotal" INTEGER NOT NULL,
    "sgstTotal" INTEGER NOT NULL,
    "igstTotal" INTEGER NOT NULL,
    "total" INTEGER NOT NULL,
    "returnedTotal" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT NOT NULL DEFAULT '',
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelledById" UUID,
    "cancelReason" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "productId" UUID,
    "position" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "hsn" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "qtyMilli" INTEGER NOT NULL,
    "unitPrice" INTEGER NOT NULL,
    "gstRateBp" INTEGER NOT NULL,
    "taxInclusive" BOOLEAN NOT NULL,
    "gross" INTEGER NOT NULL,
    "discount" INTEGER NOT NULL,
    "taxable" INTEGER NOT NULL,
    "cgst" INTEGER NOT NULL,
    "sgst" INTEGER NOT NULL,
    "igst" INTEGER NOT NULL,
    "total" INTEGER NOT NULL,
    "unitCost" INTEGER,
    "returnedQtyMilli" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_payments" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "methodId" UUID,
    "methodName" TEXT NOT NULL,
    "kind" "PaymentKind" NOT NULL,
    "amount" INTEGER NOT NULL,

    CONSTRAINT "order_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_notes" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "counterId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "reason" TEXT NOT NULL DEFAULT '',
    "refundMethodId" UUID,
    "refundMethodName" TEXT NOT NULL,
    "refundKind" "PaymentKind" NOT NULL,
    "taxableTotal" INTEGER NOT NULL,
    "cgstTotal" INTEGER NOT NULL,
    "sgstTotal" INTEGER NOT NULL,
    "igstTotal" INTEGER NOT NULL,
    "total" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_note_items" (
    "id" UUID NOT NULL,
    "creditNoteId" UUID NOT NULL,
    "orderItemId" UUID NOT NULL,
    "qtyMilli" INTEGER NOT NULL,
    "taxable" INTEGER NOT NULL,
    "cgst" INTEGER NOT NULL,
    "sgst" INTEGER NOT NULL,
    "igst" INTEGER NOT NULL,
    "total" INTEGER NOT NULL,

    CONSTRAINT "credit_note_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "held_carts" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "held_carts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "categories_accountId_idx" ON "categories"("accountId");

-- CreateIndex
CREATE INDEX "products_accountId_name_idx" ON "products"("accountId", "name");

-- CreateIndex
CREATE INDEX "products_accountId_barcode_idx" ON "products"("accountId", "barcode");

-- CreateIndex
CREATE INDEX "branch_products_productId_idx" ON "branch_products"("productId");

-- CreateIndex
CREATE INDEX "inventory_logs_branchId_productId_createdAt_idx" ON "inventory_logs"("branchId", "productId", "createdAt");

-- CreateIndex
CREATE INDEX "customers_accountId_name_idx" ON "customers"("accountId", "name");

-- CreateIndex
CREATE INDEX "customers_accountId_phone_idx" ON "customers"("accountId", "phone");

-- CreateIndex
CREATE INDEX "payment_methods_accountId_idx" ON "payment_methods"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "counters_branchId_number_key" ON "counters"("branchId", "number");

-- CreateIndex
CREATE INDEX "orders_accountId_createdAt_idx" ON "orders"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "orders_branchId_createdAt_idx" ON "orders"("branchId", "createdAt");

-- CreateIndex
CREATE INDEX "orders_cashierId_createdAt_idx" ON "orders"("cashierId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "orders_accountId_invoiceNumber_key" ON "orders"("accountId", "invoiceNumber");

-- CreateIndex
CREATE INDEX "order_items_orderId_idx" ON "order_items"("orderId");

-- CreateIndex
CREATE INDEX "order_payments_orderId_idx" ON "order_payments"("orderId");

-- CreateIndex
CREATE INDEX "credit_notes_orderId_idx" ON "credit_notes"("orderId");

-- CreateIndex
CREATE INDEX "credit_notes_branchId_createdAt_idx" ON "credit_notes"("branchId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "credit_notes_accountId_number_key" ON "credit_notes"("accountId", "number");

-- CreateIndex
CREATE INDEX "credit_note_items_creditNoteId_idx" ON "credit_note_items"("creditNoteId");

-- CreateIndex
CREATE INDEX "held_carts_branchId_createdAt_idx" ON "held_carts"("branchId", "createdAt");

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_products" ADD CONSTRAINT "branch_products_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_products" ADD CONSTRAINT "branch_products_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "counters" ADD CONSTRAINT "counters_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_counterId_fkey" FOREIGN KEY ("counterId") REFERENCES "counters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_payments" ADD CONSTRAINT "order_payments_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_note_items" ADD CONSTRAINT "credit_note_items_creditNoteId_fkey" FOREIGN KEY ("creditNoteId") REFERENCES "credit_notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Existing accounts: default payment methods, and GST on where a GSTIN was given at sign-up.
INSERT INTO "payment_methods" ("id", "accountId", "name", "kind", "sort")
SELECT gen_random_uuid(), a."id", m.name, m.kind::"PaymentKind", m.sort
FROM "accounts" a
CROSS JOIN (VALUES ('Cash', 'CASH', 1), ('UPI', 'UPI', 2), ('Card', 'CARD', 3), ('Credit (Udhaar)', 'CREDIT', 4)) AS m(name, kind, sort)
WHERE NOT EXISTS (SELECT 1 FROM "payment_methods" p WHERE p."accountId" = a."id");

UPDATE "accounts" SET "taxEnabled" = true WHERE "taxNumber" IS NOT NULL AND length("taxNumber") = 15;
