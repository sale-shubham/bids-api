import { describe, expect, it } from 'vitest';
import { HARD_MAX_PRICE_PAISE, toPaise, toPaiseOrNull } from './money';
import '@/core/json-bigint';

describe('toPaise / toPaiseOrNull', () => {
  it('converts bigint and passes numbers through', () => {
    expect(toPaise(123n)).toBe(123);
    expect(toPaise(HARD_MAX_PRICE_PAISE)).toBe(HARD_MAX_PRICE_PAISE);
    expect(toPaise(BigInt(HARD_MAX_PRICE_PAISE))).toBe(HARD_MAX_PRICE_PAISE);
  });
  it('throws on an unsafe or non-integer value', () => {
    expect(() => toPaise(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toThrow(/safe integer/);
    expect(() => toPaise(1.5)).toThrow();
    expect(() => toPaise(Number.NaN)).toThrow();
  });
  it('toPaiseOrNull maps null/undefined to null', () => {
    expect(toPaiseOrNull(null)).toBeNull();
    expect(toPaiseOrNull(undefined)).toBeNull();
    expect(toPaiseOrNull(5n)).toBe(5);
  });
});

describe('BigInt JSON safety net', () => {
  it('serialises safe bigints as numbers and unsafe ones as strings', () => {
    expect(JSON.stringify({ a: 10n })).toBe('{"a":10}');
    expect(JSON.stringify({ a: BigInt(Number.MAX_SAFE_INTEGER) + 2n })).toBe('{"a":"9007199254740993"}');
  });
});
