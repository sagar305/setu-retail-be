-- AlterTable
ALTER TABLE "counters" ADD COLUMN     "deviceKeyHash" TEXT;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "offline" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "priceDiffers" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "syncedAt" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "pinHash" TEXT,
ADD COLUMN     "pinIterations" INTEGER,
ADD COLUMN     "pinSalt" TEXT;
