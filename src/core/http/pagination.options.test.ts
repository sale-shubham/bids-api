import { describe, expect, it } from 'vitest';
import { DEFAULT_OPTIONS_PAGE_SIZE, excludeIdsSchema, optionalPaging, optionsQuerySchema } from './pagination';

describe('optionalPaging()', () => {
  it('is null when neither page nor pageSize is sent (legacy unpaged call)', () => {
    expect(optionalPaging({})).toBeNull();
  });
  it('turns on with either param and defaults the other', () => {
    expect(optionalPaging({ page: 3 })).toEqual({ page: 3, pageSize: DEFAULT_OPTIONS_PAGE_SIZE });
    expect(optionalPaging({ pageSize: 10 })).toEqual({ page: 1, pageSize: 10 });
  });
});

describe('optionsQuerySchema', () => {
  it('accepts no params at all, without injecting defaults', () => {
    const { error, value } = optionsQuerySchema.validate({});
    expect(error).toBeUndefined();
    expect(value).toEqual({});
  });
  it('accepts an empty q', () => {
    const { error, value } = optionsQuerySchema.validate({ q: '' });
    expect(error).toBeUndefined();
    expect(value.q).toBe('');
  });
  it('coerces page/pageSize and caps pageSize at 100', () => {
    expect(optionsQuerySchema.validate({ page: '2', pageSize: '25' }).value).toEqual({ page: 2, pageSize: 25 });
    expect(optionsQuerySchema.validate({ pageSize: 101 }).error).toBeDefined();
    expect(optionsQuerySchema.validate({ page: 0 }).error).toBeDefined();
  });
});

describe('excludeIdsSchema', () => {
  const parse = (v: unknown) => excludeIdsSchema.validate(v).value;
  it('splits a comma-separated string', () => {
    expect(parse('a, b,,c')).toEqual(['a', 'b', 'c']);
  });
  it('accepts a repeated param (array)', () => {
    expect(parse(['a', 'b,c'])).toEqual(['a', 'b', 'c']);
  });
  it('treats an empty string as no ids', () => {
    expect(parse('')).toEqual([]);
  });
});
