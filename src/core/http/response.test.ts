import type { Response } from 'express';
import { describe, expect, it } from 'vitest';
import { optionsResult } from './response';

function fakeRes() {
  const out: { status?: number; body?: unknown } = {};
  const res = {
    status: (s: number) => {
      out.status = s;
      return res;
    },
    json: (b: unknown) => {
      out.body = b;
      return res;
    },
  } as unknown as Response;
  return { res, out };
}

describe('optionsResult()', () => {
  it('without paging returns the legacy bare array envelope', () => {
    const { res, out } = fakeRes();
    optionsResult(res, [{ id: 'a' }], 1, null);
    expect(out.body).toEqual({ success: true, data: [{ id: 'a' }] });
  });
  it('with paging returns the standard paged shape', () => {
    const { res, out } = fakeRes();
    optionsResult(res, [{ id: 'a' }], 61, { page: 2, pageSize: 25 });
    expect(out.body).toEqual({
      success: true,
      data: [{ id: 'a' }],
      meta: { total: 61, page: 2, pageSize: 25, totalPages: 3 },
    });
  });
});
