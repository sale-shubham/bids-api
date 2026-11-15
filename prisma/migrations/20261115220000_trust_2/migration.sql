-- CreateEnum
CREATE TYPE "DepositStatus" AS ENUM ('PENDING', 'HELD', 'REFUNDED', 'FORFEITED');

-- CreateEnum
CREATE TYPE "StrikeReason" AS ENUM ('UNPAID');

-- CreateEnum
CREATE TYPE "OfferStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "RiskOutcome" AS ENUM ('DISMISSED', 'ACTION_TAKEN');

-- DropIndex
DROP INDEX "Sale_auctionId_key";

-- AlterTable
ALTER TABLE "Auction" ADD COLUMN     "depositPaise" BIGINT;

-- CreateTable
CREATE TABLE "AuctionDeposit" (
    "id" TEXT NOT NULL,
    "auctionId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "amountPaise" BIGINT NOT NULL,
    "status" "DepositStatus" NOT NULL DEFAULT 'PENDING',
    "paymentOrderId" TEXT,
    "gatewayPaymentId" TEXT,
    "refundId" TEXT,
    "heldAt" TIMESTAMP(3),
    "refundedAt" TIMESTAMP(3),
    "forfeitedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuctionDeposit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Strike" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "reason" "StrikeReason" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "removedAt" TIMESTAMP(3),
    "removedById" TEXT,
    "note" TEXT,

    CONSTRAINT "Strike_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SecondChanceOffer" (
    "id" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "auctionId" TEXT NOT NULL,
    "bidderId" TEXT NOT NULL,
    "amountPaise" BIGINT NOT NULL,
    "status" "OfferStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "respondedAt" TIMESTAMP(3),
    "newSaleId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SecondChanceOffer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShillSignal" (
    "id" TEXT NOT NULL,
    "auctionId" TEXT NOT NULL,
    "bidderId" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "reasons" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "reviewedAt" TIMESTAMP(3),
    "reviewedById" TEXT,
    "outcome" "RiskOutcome",
    "note" TEXT,

    CONSTRAINT "ShillSignal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AuctionDeposit_paymentOrderId_key" ON "AuctionDeposit"("paymentOrderId");

-- CreateIndex
CREATE INDEX "AuctionDeposit_status_idx" ON "AuctionDeposit"("status");

-- CreateIndex
CREATE UNIQUE INDEX "AuctionDeposit_auctionId_memberId_key" ON "AuctionDeposit"("auctionId", "memberId");

-- CreateIndex
CREATE UNIQUE INDEX "Strike_saleId_key" ON "Strike"("saleId");

-- CreateIndex
CREATE INDEX "Strike_memberId_expiresAt_idx" ON "Strike"("memberId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "SecondChanceOffer_saleId_key" ON "SecondChanceOffer"("saleId");

-- CreateIndex
CREATE INDEX "SecondChanceOffer_bidderId_status_idx" ON "SecondChanceOffer"("bidderId", "status");

-- CreateIndex
CREATE INDEX "SecondChanceOffer_status_expiresAt_idx" ON "SecondChanceOffer"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "ShillSignal_reviewedAt_score_idx" ON "ShillSignal"("reviewedAt", "score");

-- CreateIndex
CREATE UNIQUE INDEX "ShillSignal_auctionId_bidderId_key" ON "ShillSignal"("auctionId", "bidderId");

-- CreateIndex
CREATE INDEX "Sale_auctionId_idx" ON "Sale"("auctionId");

-- AddForeignKey
ALTER TABLE "AuctionDeposit" ADD CONSTRAINT "AuctionDeposit_auctionId_fkey" FOREIGN KEY ("auctionId") REFERENCES "Auction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuctionDeposit" ADD CONSTRAINT "AuctionDeposit_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Strike" ADD CONSTRAINT "Strike_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Strike" ADD CONSTRAINT "Strike_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SecondChanceOffer" ADD CONSTRAINT "SecondChanceOffer_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SecondChanceOffer" ADD CONSTRAINT "SecondChanceOffer_auctionId_fkey" FOREIGN KEY ("auctionId") REFERENCES "Auction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SecondChanceOffer" ADD CONSTRAINT "SecondChanceOffer_bidderId_fkey" FOREIGN KEY ("bidderId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShillSignal" ADD CONSTRAINT "ShillSignal_auctionId_fkey" FOREIGN KEY ("auctionId") REFERENCES "Auction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShillSignal" ADD CONSTRAINT "ShillSignal_bidderId_fkey" FOREIGN KEY ("bidderId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShillSignal" ADD CONSTRAINT "ShillSignal_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Hand-written (Prisma cannot express partial indexes): at most one open sale per auction.
-- A cancelled / refunded sale frees the auction for a second-chance sale. Never run `prisma migrate dev`:
-- it sees this index as drift and would drop it.
CREATE UNIQUE INDEX "Sale_open_per_auction" ON "Sale"("auctionId") WHERE "status" NOT IN ('CANCELLED','REFUNDED');
