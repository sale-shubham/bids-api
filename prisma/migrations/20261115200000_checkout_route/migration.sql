-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('PENDING', 'NEEDS_CLARIFICATION', 'ACTIVE', 'SUSPENDED', 'REJECTED');

-- CreateEnum
CREATE TYPE "SaleStatus" AS ENUM ('AWAITING_PAYMENT', 'PAID', 'SHIPPED', 'DELIVERED', 'RELEASED', 'DISPUTED', 'REFUNDED', 'CANCELLED');

-- CreateTable
CREATE TABLE "SellerPayoutAccount" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "razorpayAccountId" TEXT NOT NULL,
    "productId" TEXT,
    "status" "PayoutStatus" NOT NULL DEFAULT 'PENDING',
    "statusReason" TEXT,
    "legalName" TEXT NOT NULL,
    "businessType" TEXT NOT NULL,
    "bankLast4" TEXT NOT NULL,
    "ifsc" TEXT NOT NULL,
    "beneficiaryName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SellerPayoutAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Sale" (
    "id" TEXT NOT NULL,
    "auctionId" TEXT NOT NULL,
    "buyerId" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "itemPaise" BIGINT NOT NULL,
    "shippingFeePaise" BIGINT NOT NULL DEFAULT 0,
    "amountPaise" BIGINT NOT NULL,
    "commissionPaise" BIGINT NOT NULL,
    "rateBps" INTEGER NOT NULL,
    "status" "SaleStatus" NOT NULL DEFAULT 'AWAITING_PAYMENT',
    "payBy" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),
    "gatewayPaymentId" TEXT,
    "transferId" TEXT,
    "shippingMethod" TEXT,
    "courier" TEXT,
    "trackingNo" TEXT,
    "shippedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "disputedAt" TIMESTAMP(3),
    "disputeReason" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolution" TEXT,
    "refundedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Sale_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SellerPayoutAccount_sellerId_key" ON "SellerPayoutAccount"("sellerId");

-- CreateIndex
CREATE UNIQUE INDEX "SellerPayoutAccount_razorpayAccountId_key" ON "SellerPayoutAccount"("razorpayAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Sale_auctionId_key" ON "Sale"("auctionId");

-- CreateIndex
CREATE INDEX "Sale_buyerId_status_idx" ON "Sale"("buyerId", "status");

-- CreateIndex
CREATE INDEX "Sale_sellerId_status_idx" ON "Sale"("sellerId", "status");

-- CreateIndex
CREATE INDEX "Sale_status_payBy_idx" ON "Sale"("status", "payBy");

-- CreateIndex
CREATE INDEX "Sale_status_shippedAt_idx" ON "Sale"("status", "shippedAt");

-- AddForeignKey
ALTER TABLE "SellerPayoutAccount" ADD CONSTRAINT "SellerPayoutAccount_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_auctionId_fkey" FOREIGN KEY ("auctionId") REFERENCES "Auction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

