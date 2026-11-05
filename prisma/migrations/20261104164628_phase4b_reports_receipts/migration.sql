-- AlterTable
ALTER TABLE "accounts" ADD COLUMN     "creditDays" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "logoDataUrl" TEXT;

-- AlterTable
ALTER TABLE "branches" ADD COLUMN     "receiptTemplateId" UUID;

-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "creditDays" INTEGER;

-- CreateTable
CREATE TABLE "receipt_templates" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "paperSize" TEXT NOT NULL DEFAULT '80mm',
    "accentColor" TEXT NOT NULL DEFAULT '#26306B',
    "headerText" TEXT NOT NULL DEFAULT '',
    "footerText" TEXT NOT NULL DEFAULT '',
    "showLogo" BOOLEAN NOT NULL DEFAULT false,
    "showBusinessInfo" BOOLEAN NOT NULL DEFAULT true,
    "showGstin" BOOLEAN NOT NULL DEFAULT true,
    "showHsn" BOOLEAN NOT NULL DEFAULT true,
    "showGstSummary" BOOLEAN NOT NULL DEFAULT true,
    "showAmountWords" BOOLEAN NOT NULL DEFAULT true,
    "boldTotals" BOOLEAN NOT NULL DEFAULT true,
    "separator" TEXT NOT NULL DEFAULT 'dashed',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "archivedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "receipt_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "receipt_templates_accountId_idx" ON "receipt_templates"("accountId");
