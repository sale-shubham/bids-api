-- CreateEnum
CREATE TYPE "BidKind" AS ENUM ('MANUAL', 'AUTO', 'BUY_NOW');

-- AlterTable
ALTER TABLE "Auction" ADD COLUMN     "buyNowPricePaise" BIGINT,
ADD COLUMN     "reservePricePaise" BIGINT;

-- AlterTable
ALTER TABLE "Bid" ADD COLUMN     "kind" "BidKind" NOT NULL DEFAULT 'MANUAL';

-- CreateTable
CREATE TABLE "MaxBid" (
    "auctionId" TEXT NOT NULL,
    "bidderId" TEXT NOT NULL,
    "maxAmountPaise" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaxBid_pkey" PRIMARY KEY ("auctionId","bidderId")
);

-- AddForeignKey
ALTER TABLE "MaxBid" ADD CONSTRAINT "MaxBid_auctionId_fkey" FOREIGN KEY ("auctionId") REFERENCES "Auction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaxBid" ADD CONSTRAINT "MaxBid_bidderId_fkey" FOREIGN KEY ("bidderId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
