-- Listing quality (Phase F): category tree, condition grades, estimates, video, shipping options, delivery choice.
-- Never run `prisma migrate dev`: it would drop the hand-written indexes below (Sale_open_per_auction, Auction_attributes_gin).

-- AlterEnum: new values are not used in this migration (a new value cannot be used in the transaction that adds it).
ALTER TYPE "ItemCondition" ADD VALUE 'LIKE_NEW' AFTER 'NEW';
ALTER TYPE "ItemCondition" ADD VALUE 'GOOD' AFTER 'LIKE_NEW';
ALTER TYPE "ItemCondition" ADD VALUE 'FAIR' AFTER 'GOOD';
ALTER TYPE "ItemCondition" ADD VALUE 'FOR_PARTS' AFTER 'USED';

-- AlterTable
ALTER TABLE "Auction" ADD COLUMN     "attributes" JSONB,
ADD COLUMN     "categoryId" TEXT,
ADD COLUMN     "conditionReport" TEXT,
ADD COLUMN     "estimateHighPaise" BIGINT,
ADD COLUMN     "estimateLowPaise" BIGINT,
ADD COLUMN     "shippingOptions" JSONB,
ADD COLUMN     "videoUrl" TEXT;

-- AlterTable
ALTER TABLE "Sale" ADD COLUMN     "deliveryChoice" TEXT;

-- CreateTable
CREATE TABLE "Category" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parentId" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "description" TEXT,
    "attributeSchema" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Category_slug_key" ON "Category"("slug");

-- CreateIndex
CREATE INDEX "Category_parentId_idx" ON "Category"("parentId");

-- CreateIndex
CREATE INDEX "Auction_categoryId_idx" ON "Auction"("categoryId");

-- AddForeignKey
ALTER TABLE "Auction" ADD CONSTRAINT "Auction_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Category" ADD CONSTRAINT "Category_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written (Prisma cannot express GIN jsonb_path_ops): attribute filters on browse.
CREATE INDEX "Auction_attributes_gin" ON "Auction" USING GIN ("attributes" jsonb_path_ops);

-- Data migration: one root Category per name in AppSetting `auction.categories` (array order = sortOrder),
-- then per distinct existing Auction.category not already present; then backfill Auction.categoryId by name.
-- The AppSetting row is left in place (ignored from now on).
DO $$
DECLARE
  names TEXT[] := ARRAY[]::TEXT[];
  extra TEXT[];
  raw TEXT;
  nm TEXT;
  base TEXT;
  v_slug TEXT;
  n INT;
  ord INT := 0;
BEGIN
  SELECT "value" INTO raw FROM "AppSetting" WHERE "key" = 'auction.categories';
  IF raw IS NOT NULL THEN
    BEGIN
      SELECT COALESCE(array_agg(btrim(t.e) ORDER BY t.o), ARRAY[]::TEXT[]) INTO names
      FROM jsonb_array_elements_text(raw::jsonb) WITH ORDINALITY AS t(e, o)
      WHERE btrim(t.e) <> '';
    EXCEPTION WHEN others THEN
      names := ARRAY[]::TEXT[];
    END;
  END IF;

  SELECT COALESCE(array_agg(d.c ORDER BY d.c), ARRAY[]::TEXT[]) INTO extra
  FROM (SELECT DISTINCT btrim("category") AS c FROM "Auction" WHERE btrim("category") <> '') d
  WHERE d.c <> ALL(names);
  names := names || extra;

  FOREACH nm IN ARRAY names LOOP
    IF EXISTS (SELECT 1 FROM "Category" WHERE "name" = nm AND "parentId" IS NULL) THEN
      CONTINUE;
    END IF;
    base := btrim(regexp_replace(lower(nm), '[^a-z0-9]+', '-', 'g'), '-');
    IF base = '' THEN base := 'category'; END IF;
    v_slug := base;
    n := 1;
    WHILE EXISTS (SELECT 1 FROM "Category" WHERE "slug" = v_slug) LOOP
      n := n + 1;
      v_slug := base || '-' || n;
    END LOOP;
    INSERT INTO "Category" ("id", "slug", "name", "sortOrder", "isActive", "attributeSchema", "createdAt", "updatedAt")
    VALUES (gen_random_uuid()::text, v_slug, nm, ord, true, '[]'::jsonb, now(), now());
    ord := ord + 1;
  END LOOP;

  UPDATE "Auction" a
  SET "categoryId" = c."id", "category" = c."name"
  FROM "Category" c
  WHERE c."parentId" IS NULL AND c."name" = btrim(a."category") AND a."categoryId" IS NULL;
END $$;
