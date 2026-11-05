-- AlterTable
ALTER TABLE "accounts" ADD COLUMN     "batchTracking" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "batches" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "batchNo" TEXT NOT NULL DEFAULT '',
    "expiry" DATE,
    "costPrice" INTEGER,
    "qtyMilli" INTEGER NOT NULL,
    "opening" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT NOT NULL DEFAULT '',
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_item_batches" (
    "id" UUID NOT NULL,
    "orderItemId" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "qtyMilli" INTEGER NOT NULL,
    "restoredMilli" INTEGER NOT NULL DEFAULT 0,
    "unitCost" INTEGER,

    CONSTRAINT "order_item_batches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "batches_branchId_productId_expiry_idx" ON "batches"("branchId", "productId", "expiry");

-- CreateIndex
CREATE INDEX "batches_accountId_expiry_idx" ON "batches"("accountId", "expiry");

-- CreateIndex
CREATE INDEX "order_item_batches_orderItemId_idx" ON "order_item_batches"("orderItemId");

-- CreateIndex
CREATE INDEX "order_item_batches_batchId_idx" ON "order_item_batches"("batchId");

-- AddForeignKey
ALTER TABLE "order_item_batches" ADD CONSTRAINT "order_item_batches_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "order_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item_batches" ADD CONSTRAINT "order_item_batches_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
