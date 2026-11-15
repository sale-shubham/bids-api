export const ATTRIBUTE_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;
export const ATTRIBUTE_TEXT_MAX = 200;

export type AttributeDef = {
  key: string;
  label: string;
  type: 'text' | 'number' | 'select';
  options?: string[];
  required?: boolean;
  unit?: string;
};
export type AttributeValue = string | number;
export type FieldError = { field: string; message: string };

export type ValidatedAttributes = { ok: true; value: Record<string, AttributeValue> } | { ok: false; fields: FieldError[] };

/** Validate seller input against a category schema: unknown keys are dropped, errors list every bad field. */
export function validateAttributes(schema: AttributeDef[], input: unknown): ValidatedAttributes {
  const src: Record<string, unknown> = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const value: Record<string, AttributeValue> = {};
  const fields: FieldError[] = [];
  for (const def of schema) {
    const raw = src[def.key];
    const field = `attributes.${def.key}`;
    if (raw === undefined || raw === null || raw === '') {
      if (def.required) fields.push({ field, message: `${def.label} is required` });
      continue;
    }
    if (def.type === 'number') {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
      if (!Number.isFinite(n)) fields.push({ field, message: `${def.label} must be a number` });
      else value[def.key] = n;
    } else if (def.type === 'select') {
      if (typeof raw !== 'string' || !(def.options ?? []).includes(raw)) fields.push({ field, message: `${def.label} must be one of the listed options` });
      else value[def.key] = raw;
    } else {
      const s = typeof raw === 'string' ? raw.trim() : typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : null;
      if (s === null) fields.push({ field, message: `${def.label} must be text` });
      else if (s.length > ATTRIBUTE_TEXT_MAX) fields.push({ field, message: `${def.label} must be at most ${ATTRIBUTE_TEXT_MAX} characters` });
      else if (s === '') {
        if (def.required) fields.push({ field, message: `${def.label} is required` });
      } else value[def.key] = s;
    }
  }
  return fields.length ? { ok: false, fields } : { ok: true, value };
}

/** Read a stored `attributeSchema` JSON defensively. */
export function parseSchema(raw: unknown): AttributeDef[] {
  return Array.isArray(raw) ? (raw.filter((d) => d && typeof d === 'object' && typeof (d as AttributeDef).key === 'string') as AttributeDef[]) : [];
}

export type SpecRow = { key: string; label: string; value: AttributeValue; unit: string | null };

/** Detail specs in category-schema order; keys no longer in the schema are omitted. */
export function buildSpecs(schema: AttributeDef[], attributes: unknown): SpecRow[] {
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) return [];
  const attrs = attributes as Record<string, unknown>;
  const out: SpecRow[] = [];
  for (const def of schema) {
    const v = attrs[def.key];
    if (typeof v === 'string' || typeof v === 'number') out.push({ key: def.key, label: def.label, value: v, unit: def.unit ?? null });
  }
  return out;
}

export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return s || 'category';
}

export type CategoryRow = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  parentId: string | null;
  sortOrder: number;
  attributeSchema: unknown;
};
export type CategoryNode = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  parentId: string | null;
  sortOrder: number;
  attributeSchema: AttributeDef[];
  liveCount: number;
  children: CategoryNode[];
};

const bySort = (a: CategoryRow, b: CategoryRow) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

/** Tree of the given (active) rows; a node whose parent is missing from `rows` is dropped with its subtree. liveCount includes descendants. */
export function buildCategoryTree(rows: CategoryRow[], ownLive: Map<string, number>): CategoryNode[] {
  const kids = new Map<string | null, CategoryRow[]>();
  const ids = new Set(rows.map((r) => r.id));
  for (const r of rows) {
    if (r.parentId !== null && !ids.has(r.parentId)) continue;
    const list = kids.get(r.parentId) ?? [];
    list.push(r);
    kids.set(r.parentId, list);
  }
  const build = (r: CategoryRow): CategoryNode => {
    const children = (kids.get(r.id) ?? []).sort(bySort).map(build);
    return {
      id: r.id,
      slug: r.slug,
      name: r.name,
      description: r.description,
      parentId: r.parentId,
      sortOrder: r.sortOrder,
      attributeSchema: parseSchema(r.attributeSchema),
      liveCount: (ownLive.get(r.id) ?? 0) + children.reduce((n, c) => n + c.liveCount, 0),
      children,
    };
  };
  return (kids.get(null) ?? []).sort(bySort).map(build);
}

/** `id` plus every descendant id, from a flat (id, parentId) list. */
export function descendantIds(rows: { id: string; parentId: string | null }[], id: string): string[] {
  const out = [id];
  for (let i = 0; i < out.length; i++) for (const r of rows) if (r.parentId === out[i] && !out.includes(r.id)) out.push(r.id);
  return out;
}
