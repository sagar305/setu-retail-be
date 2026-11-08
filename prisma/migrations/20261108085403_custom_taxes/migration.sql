-- CreateEnum
CREATE TYPE "TaxMode" AS ENUM ('INDIA_GST', 'CUSTOM');

-- AlterTable
ALTER TABLE "accounts" ADD COLUMN     "invoiceTitle" TEXT NOT NULL DEFAULT 'TAX INVOICE',
ADD COLUMN     "itemCodeLabel" TEXT NOT NULL DEFAULT 'HSN',
ADD COLUMN     "taxLabel" TEXT NOT NULL DEFAULT 'GST',
ADD COLUMN     "taxMode" "TaxMode" NOT NULL DEFAULT 'INDIA_GST',
ADD COLUMN     "taxNumberLabel" TEXT NOT NULL DEFAULT 'GSTIN';

-- AlterTable
ALTER TABLE "credit_note_items" ADD COLUMN     "taxes" JSONB NOT NULL DEFAULT '[]';

-- AlterTable
ALTER TABLE "order_items" ADD COLUMN     "taxes" JSONB NOT NULL DEFAULT '[]';

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "taxMode" "TaxMode" NOT NULL DEFAULT 'INDIA_GST';

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "taxGroupId" UUID;

-- AlterTable
ALTER TABLE "purchase_items" ADD COLUMN     "taxes" JSONB NOT NULL DEFAULT '[]';

-- AlterTable
ALTER TABLE "purchase_return_items" ADD COLUMN     "taxes" JSONB NOT NULL DEFAULT '[]';

-- AlterTable
ALTER TABLE "purchases" ADD COLUMN     "taxMode" "TaxMode" NOT NULL DEFAULT 'INDIA_GST';

-- CreateTable
CREATE TABLE "tax_groups" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "taxes" JSONB NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "archivedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tax_groups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tax_groups_accountId_idx" ON "tax_groups"("accountId");

-- AddForeignKey
ALTER TABLE "tax_groups" ADD CONSTRAINT "tax_groups_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_taxGroupId_fkey" FOREIGN KEY ("taxGroupId") REFERENCES "tax_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;
