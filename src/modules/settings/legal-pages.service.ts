import { prisma } from '@/core/prisma/client';
import {
  LEGAL_PAGES,
  LEGAL_PAGE_SLUGS,
  legalPageName,
  type LegalPageSlug,
} from './legal-pages.constants';

// Admin-editable legal/content pages (Privacy Policy, Terms & Conditions).
// Stored as rows in the existing AppSetting key/value table — one row per page,
// key `page:<slug>`, value = the page's HTML (produced by the admin rich-text
// editor). No dedicated table/migration: the page set is fixed in
// legal-pages.constants.ts, admins edit content only.

const KEY_PREFIX = 'page:';

const keyFor = (slug: string) => `${KEY_PREFIX}${slug}`;

export interface LegalPage {
  slug: string;
  name: string;
  content: string;
  updatedAt: string | null;
}

// An unedited page is not an error — it comes back with empty content so the
// public route can render a "not published yet" state and the admin editor
// starts blank (same fallback as the hospital project's `getPageByKey`).
export async function getLegalPages(): Promise<LegalPage[]> {
  const rows = await prisma.appSetting.findMany({
    where: { key: { in: LEGAL_PAGE_SLUGS.map(keyFor) } },
  });
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return LEGAL_PAGES.map(({ slug, name }) => {
    const row = byKey.get(keyFor(slug));
    return {
      slug,
      name,
      content: row?.value ?? '',
      updatedAt: row?.updatedAt?.toISOString() ?? null,
    };
  });
}

export async function getLegalPage(slug: LegalPageSlug): Promise<LegalPage> {
  const row = await prisma.appSetting.findUnique({ where: { key: keyFor(slug) } });
  return {
    slug,
    name: legalPageName(slug),
    content: row?.value ?? '',
    updatedAt: row?.updatedAt?.toISOString() ?? null,
  };
}

// Bulk upsert — the admin editor saves every page it renders in one call, so a
// partial save can never leave two pages out of sync with each other.
export async function setLegalPages(
  pages: { slug: LegalPageSlug; content: string }[],
): Promise<LegalPage[]> {
  await prisma.$transaction(
    pages.map(({ slug, content }) =>
      prisma.appSetting.upsert({
        where: { key: keyFor(slug) },
        create: { key: keyFor(slug), value: content },
        update: { value: content },
      }),
    ),
  );
  return getLegalPages();
}
