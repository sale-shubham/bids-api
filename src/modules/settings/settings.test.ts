import { describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({
  rows: new Map<string, { key: string; value: string; updatedAt: Date }>(),
  roots: [{ name: 'Books' }, { name: 'Art' }],
}));
vi.mock('@/core/prisma/client', () => {
  const upsert = async ({ where, create, update }: any) => {
    const cur = store.rows.get(where.key);
    const row = { key: where.key, value: cur ? (update.value ?? cur.value) : create.value, updatedAt: new Date() };
    store.rows.set(where.key, row);
    return row;
  };
  return {
    prisma: {
      appSetting: {
        upsert: vi.fn(upsert),
        findMany: async ({ where }: any) => where.key.in.map((k: string) => store.rows.get(k)).filter(Boolean),
        findUnique: async ({ where }: any) => store.rows.get(where.key) ?? null,
      },
      category: { findMany: vi.fn(async () => store.roots) },
      $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
    },
  };
});

import { platformSettingsSchema, legalPageBodySchema } from './settings.validation';
import { getPlatformSettings, setPlatformSettings } from './settings.service';
import { getLegalPage, setLegalPage } from './legal-pages.service';
import { sanitizeLegalHtml } from './legal-pages.sanitize';

const valid = { commissionRateBps: 500, minIncrementPaise: 10000, antiSnipingMinutes: 2, maxPricePaise: 10_000_000_000, categories: ['Art', 'Books'], checkoutMode: 'optional' as const, depositThresholdPaise: 10_000_000, depositRateBps: 1000, featuredEnabled: true, featuredPrices: { '1': 9900, '3': 24900, '7': 49900 }, referralEnabled: true, referralRewardPaise: 10_000, referralMaxRewardsPerMember: 20 };
const { maxPricePaise: _omit, checkoutMode: _omit2, depositThresholdPaise: _omit3, depositRateBps: _omit4, featuredEnabled: _o5, featuredPrices: _o6, referralEnabled: _o7, referralRewardPaise: _o8, referralMaxRewardsPerMember: _o9, ...legacy } = valid;

describe('platform settings validation', () => {
  it('accepts a valid object and enforces ranges', () => {
    expect(platformSettingsSchema.validate(valid).error).toBeUndefined();
    expect(platformSettingsSchema.validate({ ...valid, commissionRateBps: 3001 }).error).toBeDefined();
    expect(platformSettingsSchema.validate({ ...valid, commissionRateBps: -1 }).error).toBeDefined();
    expect(platformSettingsSchema.validate({ ...valid, minIncrementPaise: 99 }).error).toBeDefined();
    expect(platformSettingsSchema.validate({ ...valid, antiSnipingMinutes: 31 }).error).toBeDefined();
    expect(platformSettingsSchema.validate({ ...valid, antiSnipingMinutes: 0 }).error).toBeUndefined();
  });
  it('maxPricePaise is optional on PUT and range-checked', () => {
    expect(platformSettingsSchema.validate(legacy).error).toBeUndefined();
    expect(platformSettingsSchema.validate({ ...legacy, maxPricePaise: 99_999 }).error).toBeDefined();
    expect(platformSettingsSchema.validate({ ...legacy, maxPricePaise: 1_000_000_000_001 }).error).toBeDefined();
    expect(platformSettingsSchema.validate({ ...legacy, maxPricePaise: 1_000_000_000_000 }).error).toBeUndefined();
  });
  it('checkoutMode is optional on PUT and must be off | optional | required', () => {
    expect(platformSettingsSchema.validate(legacy).error).toBeUndefined();
    for (const m of ['off', 'optional', 'required']) {
      expect(platformSettingsSchema.validate({ ...legacy, checkoutMode: m }).error).toBeUndefined();
    }
    expect(platformSettingsSchema.validate({ ...legacy, checkoutMode: 'always' }).error).toBeDefined();
  });
  it('checkoutMode: default optional, stored value kept when PUT omits it, invalid stored value falls back', async () => {
    expect((await getPlatformSettings()).checkoutMode).toBe('optional');
    await setPlatformSettings({ ...valid, checkoutMode: 'required' });
    expect((await setPlatformSettings({ ...legacy, commissionRateBps: 600 })).checkoutMode).toBe('required');
    store.rows.set('checkout.mode', { key: 'checkout.mode', value: 'bogus', updatedAt: new Date() });
    expect((await getPlatformSettings()).checkoutMode).toBe('optional');
    store.rows.delete('checkout.mode');
    await setPlatformSettings(valid);
  });
  it('deposit settings are optional on PUT: threshold 0..hard max (0 = off), rate 100..5000 bps', () => {
    expect(platformSettingsSchema.validate(legacy).error).toBeUndefined();
    expect(platformSettingsSchema.validate({ ...legacy, depositThresholdPaise: 0 }).error).toBeUndefined();
    expect(platformSettingsSchema.validate({ ...legacy, depositThresholdPaise: -1 }).error).toBeDefined();
    expect(platformSettingsSchema.validate({ ...legacy, depositThresholdPaise: 1_000_000_000_001 }).error).toBeDefined();
    expect(platformSettingsSchema.validate({ ...legacy, depositRateBps: 99 }).error).toBeDefined();
    expect(platformSettingsSchema.validate({ ...legacy, depositRateBps: 5001 }).error).toBeDefined();
    expect(platformSettingsSchema.validate({ ...legacy, depositRateBps: 5000 }).error).toBeUndefined();
  });
  it('deposit settings: defaults, kept when PUT omits them, out-of-range stored values fall back', async () => {
    expect(await getPlatformSettings()).toMatchObject({ depositThresholdPaise: 10_000_000, depositRateBps: 1000 });
    await setPlatformSettings({ ...valid, depositThresholdPaise: 0, depositRateBps: 2500 });
    expect(await setPlatformSettings({ ...legacy, commissionRateBps: 600 })).toMatchObject({ depositThresholdPaise: 0, depositRateBps: 2500 });
    store.rows.set('auction.depositRateBps', { key: 'auction.depositRateBps', value: '7', updatedAt: new Date() });
    expect((await getPlatformSettings()).depositRateBps).toBe(1000);
    store.rows.delete('auction.depositRateBps');
    store.rows.delete('auction.depositThresholdPaise');
    await setPlatformSettings(valid);
  });
  it('categories (deprecated, optional): 1-30, unique (case-insensitive), 2-40 chars', () => {
    expect(platformSettingsSchema.validate({ ...valid, categories: [] }).error).toBeDefined();
    expect(platformSettingsSchema.validate({ ...valid, categories: ['Art', 'art'] }).error).toBeDefined();
    expect(platformSettingsSchema.validate({ ...valid, categories: ['A'] }).error).toBeDefined();
    expect(platformSettingsSchema.validate({ ...valid, categories: ['x'.repeat(41)] }).error).toBeDefined();
    const thirtyOne = Array.from({ length: 31 }, (_, i) => `Cat ${i}`);
    expect(platformSettingsSchema.validate({ ...valid, categories: thirtyOne }).error).toBeDefined();
    expect(platformSettingsSchema.validate({ ...valid, categories: thirtyOne.slice(0, 30) }).error).toBeUndefined();
    expect(platformSettingsSchema.validate({ ...valid, categories: undefined }).error).toBeUndefined();
  });
  it('categories come from the active root Category names (sorted) and a PUT value is ignored', async () => {
    expect((await getPlatformSettings()).categories).toEqual(['Art', 'Books']);
    const saved = await setPlatformSettings({ ...valid, categories: ['Ignored'] });
    expect(saved.categories).toEqual(['Art', 'Books']);
    expect(store.rows.has('auction.categories')).toBe(false);
  });
  it('round-trips through the AppSetting store', async () => {
    expect(await setPlatformSettings(valid)).toEqual(valid);
    expect(await getPlatformSettings()).toEqual(valid);
  });
  it('PUT without maxPricePaise keeps the stored value', async () => {
    await setPlatformSettings({ ...valid, maxPricePaise: 5_000_000_000 });
    expect((await setPlatformSettings({ ...legacy, commissionRateBps: 600 })).maxPricePaise).toBe(5_000_000_000);
    await setPlatformSettings(valid);
  });
  it('maxPricePaise falls back to the default when stored out of range', async () => {
    store.rows.set('auction.maxPricePaise', { key: 'auction.maxPricePaise', value: '5', updatedAt: new Date() });
    expect((await getPlatformSettings()).maxPricePaise).toBe(10_000_000_000);
    store.rows.delete('auction.maxPricePaise');
  });
});

describe('legal pages', () => {
  it('sanitiser keeps allowed tags and strips scripts, handlers, images and js: links', () => {
    const out = sanitizeLegalHtml(
      '<h2 onclick="x()">Title</h2><p>a <strong>b</strong> <em>c</em><br></p><ul><li>x</li></ul><ol><li>y</li></ol><blockquote>q</blockquote>' +
        '<script>alert(1)</script><img src=x onerror=z()><a href="javascript:alert(1)">bad</a><a href="https://e.com">ok</a><h1>no</h1>',
    );
    expect(out).toContain('<h2>Title</h2>');
    expect(out).toContain('<strong>b</strong>');
    expect(out).toContain('<blockquote>q</blockquote>');
    expect(out).toContain('href="https://e.com"');
    expect(out).toContain('rel="noopener noreferrer nofollow"');
    expect(out).not.toMatch(/script|onclick|onerror|javascript:|<img|<h1/i);
  });
  it('setLegalPage sanitises before saving and getLegalPage returns title + content', async () => {
    const page = await setLegalPage('privacy-policy', { title: ' My Privacy ', content: '<p>Hi</p><script>x</script>' });
    expect(page).toMatchObject({ slug: 'privacy-policy', title: 'My Privacy', content: '<p>Hi</p>' });
    expect(page.updatedAt).toEqual(expect.any(String));
    expect((await getLegalPage('privacy-policy')).content).toBe('<p>Hi</p>');
  });
  it('unedited page falls back to default title, empty content, null updatedAt', async () => {
    expect(await getLegalPage('refund-policy')).toEqual({
      slug: 'refund-policy',
      title: 'Refund Policy',
      content: '',
      updatedAt: null,
    });
  });
  it('body schema requires title and content', () => {
    expect(legalPageBodySchema.validate({ title: 'T1', content: '<p>x</p>' }).error).toBeUndefined();
    expect(legalPageBodySchema.validate({ title: 'T1' }).error).toBeDefined();
  });
});
