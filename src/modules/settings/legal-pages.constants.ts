// The fixed catalogue of admin-editable legal/content pages. Kept free of any
// prisma import so route modules can reach it at module scope (for Joi
// `valid()` lists) without pulling the DB client into the cold-start path —
// the service itself is still lazy-imported inside handlers.

// Adding a page = one entry here (plus a link wherever it should surface);
// no migration, no admin-side "create page" flow.
export const LEGAL_PAGES = [
  { slug: 'privacy-policy', name: 'Privacy Policy' },
  { slug: 'terms-conditions', name: 'Terms and Conditions' },
  { slug: 'refund-policy', name: 'Refund Policy' },
  { slug: 'prohibited-items', name: 'Prohibited items' },
] as const;

export type LegalPageSlug = (typeof LEGAL_PAGES)[number]['slug'];

export const LEGAL_PAGE_SLUGS: LegalPageSlug[] = LEGAL_PAGES.map((p) => p.slug);

export function isLegalPageSlug(slug: string): slug is LegalPageSlug {
  return LEGAL_PAGE_SLUGS.includes(slug as LegalPageSlug);
}

export function legalPageName(slug: string) {
  return LEGAL_PAGES.find((p) => p.slug === slug)?.name ?? slug;
}
