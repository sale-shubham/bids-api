import Joi from 'joi';

export const paginationSchema = Joi.object({
  cursor: Joi.string().optional(),
  limit: Joi.number().integer().min(1).max(100).default(20),
});

export type PaginationParams = {
  cursor?: string;
  limit: number;
};

export function buildPage<T extends { id: string }>(rows: T[], limit: number) {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? items[items.length - 1].id : null;
  return { items, nextCursor };
}

// ---- Offset pagination (page-numbers) ----
// For admin/member list tables that want jump-to-page + a free-text `q` search
// bar. Keyset (buildPage above) stays the default for the buyer catalog/FTS.
export const offsetSchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(20),
  q: Joi.string().trim().allow('').optional(),
});

export type OffsetParams = { page: number; pageSize: number; q?: string };

// Prisma skip/take from a validated page/pageSize.
export function offsetArgs(p: { page: number; pageSize: number }) {
  return { skip: (p.page - 1) * p.pageSize, take: p.pageSize };
}

// Standard offset meta for paginated() — totalPages is always >= 1.
export function pageMeta(total: number, p: { page: number; pageSize: number }) {
  return { total, page: p.page, pageSize: p.pageSize, totalPages: Math.max(1, Math.ceil(total / p.pageSize)) };
}

// ---- Opt-in paging for dropdown ("options") endpoints ----
// A searchable dropdown calls the API with `q` (server-side search) and, to
// page, `page`/`pageSize`. Unlike offsetSchema there are NO defaults: the
// deployed app calls these endpoints without any of it and must keep getting
// exactly the old (unpaged) response. Paging is on when `page` OR `pageSize`
// is present (the other falls back to 1 / DEFAULT_OPTIONS_PAGE_SIZE).
export const DEFAULT_OPTIONS_PAGE_SIZE = 25;

export const optionsQuerySchema = Joi.object({
  q: Joi.string().trim().allow('').optional(),
  page: Joi.number().integer().min(1).optional(),
  pageSize: Joi.number().integer().min(1).max(100).optional(),
});

/** `{ page, pageSize }` when the caller opted into paging, else null. */
export function optionalPaging(p: { page?: number; pageSize?: number }): { page: number; pageSize: number } | null {
  if (p.page === undefined && p.pageSize === undefined) return null;
  return { page: p.page ?? 1, pageSize: p.pageSize ?? DEFAULT_OPTIONS_PAGE_SIZE };
}

const MAX_EXCLUDE_IDS = 500;

/**
 * `excludeIds` query param: comma-separated (`?excludeIds=a,b`) or repeated
 * (`?excludeIds=a&excludeIds=b`); normalised to a trimmed, de-blanked string[]
 * (capped at 500). Empty string -> [].
 */
export const excludeIdsSchema = Joi.alternatives()
  .try(Joi.array().items(Joi.string().allow('')), Joi.string().allow(''))
  .custom((value: string | string[]) => {
    const parts = (Array.isArray(value) ? value : [value]).flatMap((v) => v.split(','));
    return parts.map((v) => v.trim()).filter(Boolean).slice(0, MAX_EXCLUDE_IDS);
  })
  .optional();

// ---- Column sort (sortBy/sortOrder) ----
// Shared by every admin list endpoint that has a the web app `SortableTableHead`
// column. `sortBy` itself is validated per-module against that module's own
// `.valid(...allowedKeys)` list (never accepted as a raw column name — see
// buildOrderBy below) since the allowed keys differ per list; only the
// asc/desc direction is generic enough to share.
export type SortOrder = 'asc' | 'desc';
export const sortOrderSchema = Joi.string().valid('asc', 'desc').optional();

/**
 * Turns a validated `sortBy` key into a Prisma `orderBy` fragment via a
 * per-module allowlist map (key -> `(order) => orderBy fragment`), so a
 * relation field sorts as `{ member: { name: order } }` etc. Falls back to
 * `fallback` when `sortBy` is absent or not a key `sortMap` declares — an
 * unrecognized key can never reach Prisma as a raw column/relation name.
 * A key legitimately absent from `sortMap` (e.g. a column computed in JS
 * after the fetch, uncountable in one Prisma query) silently falls back too —
 * document that case at the call site, the web app's client-side re-sort still
 * reorders whatever page loads either way (see `readme/flows/admin.md` in
 * the web app, the sort's `useSortedItems`).
 */
export function buildOrderBy<T>(
  sortBy: string | undefined,
  sortOrder: SortOrder | undefined,
  sortMap: Record<string, (order: SortOrder) => T>,
  fallback: T,
): T {
  const order: SortOrder = sortOrder === 'desc' ? 'desc' : 'asc';
  const build = sortBy ? sortMap[sortBy] : undefined;
  return build ? build(order) : fallback;
}
