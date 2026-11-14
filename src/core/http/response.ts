import type { Response } from 'express';
import { pageMeta } from './pagination';

// Standard success envelope.
export function ok<T>(res: Response, data: T, status = 200) {
  return res.status(status).json({ success: true, data });
}

export function paginated<T>(
  res: Response,
  items: T[],
  meta: {
    nextCursor?: string | null;
    total?: number;
    page?: number;
    pageSize?: number;
    totalPages?: number;
  },
  extra?: Record<string, unknown>,
) {
  return res.status(200).json({ success: true, data: items, meta, ...extra });
}

// Dropdown ("options") endpoints: opt-in paging. `paging` null = the legacy
// bare array in the standard envelope; otherwise the standard offset-paged
// shape (`data` = rows, `meta` = pageMeta()) — same as every other paged list.
export function optionsResult<T>(
  res: Response,
  items: T[],
  total: number,
  paging: { page: number; pageSize: number } | null,
) {
  if (!paging) return ok(res, items);
  return paginated(res, items, pageMeta(total, paging));
}
