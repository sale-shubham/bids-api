-- Single MEMBER role (decision D17): BIDDER and AUCTIONEER become MEMBER; SUPER_ADMIN stays.
-- Hand-written. Never run `prisma migrate dev` (Sale_open_per_auction is not in the schema).

-- 1. Back up every member's current role so the change can be undone.
CREATE TABLE "MemberRoleBackup" (
    "memberId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemberRoleBackup_pkey" PRIMARY KEY ("memberId")
);

ALTER TABLE "MemberRoleBackup" ADD CONSTRAINT "MemberRoleBackup_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "MemberRoleBackup" ("memberId", "role")
SELECT "id", "role"::text FROM "Member";

-- 2. Swap the enum (the way Prisma does when a value is removed).
CREATE TYPE "Role_new" AS ENUM ('MEMBER', 'SUPER_ADMIN');
ALTER TABLE "Member" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "Member" ALTER COLUMN "role" TYPE "Role_new" USING (CASE WHEN "role"::text = 'SUPER_ADMIN' THEN 'SUPER_ADMIN' ELSE 'MEMBER' END)::"Role_new";
ALTER TYPE "Role" RENAME TO "Role_old";
ALTER TYPE "Role_new" RENAME TO "Role";
DROP TYPE "Role_old";
ALTER TABLE "Member" ALTER COLUMN "role" SET DEFAULT 'MEMBER';
CREATE INDEX IF NOT EXISTS "Member_role_idx" ON "Member"("role");

-- 3. Members with an active payout account were verified sellers by the old rule; keep the badge.
UPDATE "Member" m
SET "verifiedAt" = now()
WHERE m."verifiedAt" IS NULL
  AND m."verificationRevokedAt" IS NULL
  AND EXISTS (
    SELECT 1 FROM "SellerPayoutAccount" p
    WHERE p."sellerId" = m."id" AND p."status" = 'ACTIVE'
  );

-- 4. Force every non-admin member to log in again so their token carries the MEMBER role.
DELETE FROM "Session" WHERE "memberId" IN (SELECT "id" FROM "Member" WHERE "role" <> 'SUPER_ADMIN');
