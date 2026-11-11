-- AlterTable
ALTER TABLE "accounts" ADD COLUMN     "printUpiQrOnReceipt" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "upiId" TEXT NOT NULL DEFAULT '';
