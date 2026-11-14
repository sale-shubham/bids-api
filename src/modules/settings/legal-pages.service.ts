import { prisma } from '@/core/prisma/client';
import { LEGAL_PAGES, LEGAL_PAGE_SLUGS, legalPageName, type LegalPageSlug } from './legal-pages.constants';
import { sanitizeLegalHtml } from './legal-pages.sanitize';

// Admin-editable legal pages (Terms, Privacy, Refund). AppSetting rows, no
// dedicated table: `page:<slug>` = HTML content, `page-title:<slug>` = title.
// The slug set is fixed in legal-pages.constants.ts. Content is sanitised on
// write (and the seed only creates missing rows, never overwriting edits).

const contentKey = (slug: string) => `page:${slug}`;
const titleKey = (slug: string) => `page-title:${slug}`;

export interface LegalPage {
  slug: string;
  title: string;
  content: string;
  updatedAt: string | null;
}

type Row = { key: string; value: string | null; updatedAt: Date };

function toPage(slug: string, rows: Map<string, Row>): LegalPage {
  const c = rows.get(contentKey(slug));
  const t = rows.get(titleKey(slug));
  const times = [c?.updatedAt, t?.updatedAt].filter((d): d is Date => !!d).map((d) => d.getTime());
  return {
    slug,
    title: t?.value || legalPageName(slug),
    content: c?.value ?? '',
    updatedAt: times.length ? new Date(Math.max(...times)).toISOString() : null,
  };
}

async function loadRows(slugs: string[]) {
  const rows = await prisma.appSetting.findMany({
    where: { key: { in: slugs.flatMap((s) => [contentKey(s), titleKey(s)]) } },
  });
  return new Map(rows.map((r) => [r.key, r as Row]));
}

// An unedited page is not an error: it comes back with empty content.
export async function getLegalPages(): Promise<LegalPage[]> {
  const rows = await loadRows(LEGAL_PAGE_SLUGS);
  return LEGAL_PAGES.map(({ slug }) => toPage(slug, rows));
}

export async function getLegalPage(slug: LegalPageSlug): Promise<LegalPage> {
  return toPage(slug, await loadRows([slug]));
}

export async function setLegalPage(slug: LegalPageSlug, input: { title: string; content: string }): Promise<LegalPage> {
  const content = sanitizeLegalHtml(input.content);
  const title = input.title.trim();
  await prisma.$transaction([
    prisma.appSetting.upsert({ where: { key: contentKey(slug) }, create: { key: contentKey(slug), value: content }, update: { value: content } }),
    prisma.appSetting.upsert({ where: { key: titleKey(slug) }, create: { key: titleKey(slug), value: title }, update: { value: title } }),
  ]);
  return getLegalPage(slug);
}
