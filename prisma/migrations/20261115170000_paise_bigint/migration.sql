-- AlterTable
ALTER TABLE "Member" ALTER COLUMN "unpaidCommissionPaise" SET DATA TYPE BIGINT,
ALTER COLUMN "moneySpentPaise" SET DATA TYPE BIGINT;

-- AlterTable
ALTER TABLE "Auction" ALTER COLUMN "startingBidPaise" SET DATA TYPE BIGINT,
ALTER COLUMN "minIncrementPaise" SET DATA TYPE BIGINT,
ALTER COLUMN "currentBidPaise" SET DATA TYPE BIGINT;

-- AlterTable
ALTER TABLE "Bid" ALTER COLUMN "amountPaise" SET DATA TYPE BIGINT;

-- AlterTable
ALTER TABLE "Commission" ALTER COLUMN "amountPaise" SET DATA TYPE BIGINT;

-- AlterTable
ALTER TABLE "PaymentOrder" ALTER COLUMN "amountPaise" SET DATA TYPE BIGINT;
