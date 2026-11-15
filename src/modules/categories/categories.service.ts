import { prisma } from '@/core/prisma/client';
import { AppError } from '@/core/errors/AppError';
import { statusWhere } from '@/modules/auctions/auctions.query';
import {
  buildCategoryTree,
  descendantIds,
  parseSchema,
  slugify,
  type AttributeDef,
  type CategoryRow,
} from './categories.rules';
import type { CreateCategoryInput, UpdateCategoryInput } from './categories.validation';

const DAY_MS = 86_400_000;
export const SOLD_WINDOW_DAYS = 90;

export const categoryNotFound = () => new AppError(404, 'CATEGORY_NOT_FOUND', 'Category not found');
const slugTaken = () => new AppError(409, 'CATEGORY_SLUG_TAKEN', 'That slug is already used by another category');
const invalidCategory = () => new AppError(400, 'INVALID_CATEGORY', 'Choose an active category');

const rowSelect = { id: true, slug: true, name: true, description: true, parentId: true, sortOrder: true, attributeSchema: true } as const;

// ---------------------------------------------------------------- public reads

async function liveCountsByCategory(now: Date): Promise<Map<string, number>> {
  const groups = await prisma.auction.groupBy({
    by: ['categoryId'],
    where: { AND: [statusWhere('live', now), { categoryId: { not: null } }] },
    _count: { _all: true },
  });
  return new Map(groups.filter((g) => g.categoryId).map((g) => [g.categoryId as string, g._count._all]));
}

/** Active category tree with live-auction counts (descendants included). */
export async function getCategoryTree(now = new Date()) {
  const [rows, counts] = await Promise.all([
    prisma.category.findMany({ where: { isActive: true }, select: rowSelect }),
    liveCountsByCategory(now),
  ]);
  return { items: buildCategoryTree(rows as CategoryRow[], counts) };
}

/** Legacy `GET /auctions/categories` shape: active root categories with their live counts. */
export async function categoriesWithCounts(now = new Date()) {
  const { items } = await getCategoryTree(now);
  return items.map((c) => ({ name: c.name, liveCount: c.liveCount }));
}

/** Names of active root categories, sorted (the `categories` field of the platform settings). */
export async function activeRootCategoryNames(): Promise<string[]> {
  const rows = await prisma.category.findMany({ where: { parentId: null, isActive: true }, select: { name: true } });
  return rows.map((r) => r.name).sort((a, b) => a.localeCompare(b));
}

type Found = CategoryRow & { isActive: boolean };

/** A category by slug or (case-insensitive) name; `activeOnly` for writes. */
export async function findCategoryByTerm(term: string, activeOnly: boolean): Promise<Found | null> {
  const t = term.trim();
  if (!t) return null;
  const row = await prisma.category.findFirst({
    where: {
      ...(activeOnly ? { isActive: true } : {}),
      OR: [{ slug: t.toLowerCase() }, { name: { equals: t, mode: 'insensitive' } }],
    },
    select: { ...rowSelect, isActive: true },
  });
  return (row as Found | null) ?? null;
}

/** The category id plus all descendant ids. */
export async function categoryIdsWithDescendants(rootId: string): Promise<string[]> {
  const all = await prisma.category.findMany({ select: { id: true, parentId: true } });
  return descendantIds(all, rootId);
}

/** Browse filter: ids for a slug-or-name term (descendants included); null when no category matches. */
export async function resolveBrowseCategoryIds(term: string): Promise<string[] | null> {
  const cat = await findCategoryByTerm(term, false);
  return cat ? categoryIdsWithDescendants(cat.id) : null;
}

/** Ancestor chain names + slugs of a category (itself included), for saved-search matching. */
export async function categoryTerms(categoryId: string | null | undefined): Promise<string[]> {
  const terms: string[] = [];
  let id: string | null = categoryId ?? null;
  for (let i = 0; id && i < 10; i++) {
    const c: { name: string; slug: string; parentId: string | null } | null = await prisma.category.findUnique({
      where: { id },
      select: { name: true, slug: true, parentId: true },
    });
    if (!c) break;
    terms.push(c.name, c.slug);
    id = c.parentId;
  }
  return terms;
}

export type CategoryContext = { path: { id: string; slug: string; name: string }[]; schema: AttributeDef[] };
export const EMPTY_CATEGORY_CONTEXT: CategoryContext = { path: [], schema: [] };

/** Root-to-leaf path and the leaf's attribute schema (for detail `categoryPath` / `specs`). */
export async function categoryContext(categoryId: string | null | undefined): Promise<CategoryContext> {
  const path: CategoryContext['path'] = [];
  let schema: AttributeDef[] = [];
  let id: string | null = categoryId ?? null;
  for (let i = 0; id && i < 10; i++) {
    const c: { id: string; slug: string; name: string; parentId: string | null; attributeSchema: unknown } | null =
      await prisma.category.findUnique({ where: { id }, select: { id: true, slug: true, name: true, parentId: true, attributeSchema: true } });
    if (!c) break;
    if (i === 0) schema = parseSchema(c.attributeSchema);
    path.unshift({ id: c.id, slug: c.slug, name: c.name });
    id = c.parentId;
  }
  return { path, schema };
}

/** Resolve `categoryId` (preferred) or a legacy `category` name / slug to an active category. */
export async function resolveActiveCategory(input: { categoryId?: string; category?: string }) {
  let row: Found | null = null;
  if (input.categoryId) {
    row = (await prisma.category.findUnique({ where: { id: input.categoryId }, select: { ...rowSelect, isActive: true } })) as Found | null;
  } else if (input.category) {
    row = await findCategoryByTerm(input.category, true);
  }
  if (!row || !row.isActive) throw invalidCategory();
  return { id: row.id, name: row.name, schema: parseSchema(row.attributeSchema) };
}

/** Median final price needs raw SQL (percentile_cont); count comes back as bigint, the median as a float. */
export async function categoryStats(slug: string, now = new Date()) {
  const cat = await prisma.category.findUnique({ where: { slug: slug.toLowerCase() }, select: { id: true } });
  if (!cat) throw categoryNotFound();
  const ids = await categoryIdsWithDescendants(cat.id);
  const since = new Date(now.getTime() - SOLD_WINDOW_DAYS * DAY_MS);
  const [liveCount, rows] = await Promise.all([
    prisma.auction.count({ where: { AND: [statusWhere('live', now), { categoryId: { in: ids } }] } }),
    prisma.$queryRaw<{ cnt: bigint | number | string; median: number | string | null }[]>`
      SELECT COUNT(*)::bigint AS cnt,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY "currentBidPaise")::float8 AS median
      FROM "Auction"
      WHERE "categoryId" = ANY(${ids}::text[])
        AND "winnerId" IS NOT NULL
        AND "deletedAt" IS NULL
        AND "status" = 'ENDED'
        AND "endedAt" >= ${since}`,
  ]);
  const row = rows[0];
  const median = row?.median === null || row?.median === undefined ? null : Math.round(Number(row.median));
  return { liveCount, soldCount90d: row ? Number(row.cnt) : 0, medianSoldPaise: median };
}

// ---------------------------------------------------------------- admin

type AdminRow = CategoryRow & { isActive: boolean; createdAt: Date; updatedAt: Date; _count?: { auctions: number } };

export function toAdminCategoryDTO(c: AdminRow) {
  return {
    id: c.id,
    slug: c.slug,
    name: c.name,
    description: c.description,
    parentId: c.parentId,
    sortOrder: c.sortOrder,
    isActive: c.isActive,
    attributeSchema: parseSchema(c.attributeSchema),
    auctionCount: c._count?.auctions ?? 0,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

export async function adminListCategories() {
  const rows = await prisma.category.findMany({
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }],
    select: { ...rowSelect, isActive: true, createdAt: true, updatedAt: true, _count: { select: { auctions: true } } },
  });
  return { items: (rows as AdminRow[]).map(toAdminCategoryDTO) };
}

async function assertParent(parentId: string) {
  const p = await prisma.category.findUnique({ where: { id: parentId }, select: { id: true } });
  if (!p) throw new AppError(400, 'INVALID_PARENT', 'Parent category not found');
}

async function uniqueSlug(base: string): Promise<string> {
  let slug = base;
  for (let n = 2; await prisma.category.findUnique({ where: { slug }, select: { id: true } }); n++) {
    slug = `${base.slice(0, 55)}-${n}`;
  }
  return slug;
}

const isUniqueViolation = (err: unknown) => typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';

export async function adminCreateCategory(input: CreateCategoryInput) {
  if (input.parentId) await assertParent(input.parentId);
  let slug: string;
  if (input.slug) {
    if (await prisma.category.findUnique({ where: { slug: input.slug }, select: { id: true } })) throw slugTaken();
    slug = input.slug;
  } else {
    slug = await uniqueSlug(slugify(input.name));
  }
  try {
    const row = await prisma.category.create({
      data: {
        slug,
        name: input.name,
        parentId: input.parentId ?? null,
        sortOrder: input.sortOrder ?? 0,
        isActive: input.isActive ?? true,
        description: input.description || null,
        attributeSchema: (input.attributeSchema ?? []) as object[],
      },
      select: { ...rowSelect, isActive: true, createdAt: true, updatedAt: true },
    });
    return { category: toAdminCategoryDTO(row as AdminRow) };
  } catch (err) {
    if (isUniqueViolation(err)) throw slugTaken();
    throw err;
  }
}

export async function adminUpdateCategory(id: string, input: UpdateCategoryInput) {
  const existing = await prisma.category.findUnique({ where: { id }, select: { id: true, name: true } });
  if (!existing) throw categoryNotFound();

  if (input.parentId !== undefined && input.parentId !== null) {
    const all = await prisma.category.findMany({ select: { id: true, parentId: true } });
    if (descendantIds(all, id).includes(input.parentId)) {
      throw new AppError(400, 'CATEGORY_CYCLE', 'A category cannot be moved under itself or one of its descendants');
    }
    await assertParent(input.parentId);
  }
  if (input.slug !== undefined) {
    const clash = await prisma.category.findUnique({ where: { slug: input.slug }, select: { id: true } });
    if (clash && clash.id !== id) throw slugTaken();
  }

  const data: Record<string, unknown> = {};
  for (const k of ['name', 'slug', 'parentId', 'sortOrder', 'isActive'] as const) if (input[k] !== undefined) data[k] = input[k];
  if (input.description !== undefined) data.description = input.description || null;
  if (input.attributeSchema !== undefined) data.attributeSchema = input.attributeSchema as object[];

  try {
    const row = await prisma.$transaction(async (tx) => {
      const updated = await tx.category.update({
        where: { id },
        data,
        select: { ...rowSelect, isActive: true, createdAt: true, updatedAt: true, _count: { select: { auctions: true } } },
      });
      // Auction.category is the denormalised name; keep it in step.
      if (input.name !== undefined && input.name !== existing.name) {
        await tx.auction.updateMany({ where: { categoryId: id }, data: { category: input.name } });
      }
      return updated;
    });
    return { category: toAdminCategoryDTO(row as AdminRow) };
  } catch (err) {
    if (isUniqueViolation(err)) throw slugTaken();
    throw err;
  }
}

export async function adminDeleteCategory(id: string) {
  const c = await prisma.category.findUnique({ where: { id }, select: { id: true, _count: { select: { auctions: true, children: true } } } });
  if (!c) throw categoryNotFound();
  if (c._count.auctions > 0 || c._count.children > 0) {
    throw new AppError(409, 'CATEGORY_IN_USE', 'This category has auctions or sub-categories', {
      auctionCount: c._count.auctions,
      childCount: c._count.children,
    });
  }
  await prisma.category.delete({ where: { id } });
  return { id };
}
