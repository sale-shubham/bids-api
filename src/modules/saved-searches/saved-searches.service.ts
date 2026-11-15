import { prisma } from '@/core/prisma/client';
import { AppError, NotFound } from '@/core/errors/AppError';
import { toPaiseOrNull } from '@/core/money';
import type { CreateSavedSearchInput } from './saved-searches.validation';

export const MAX_SAVED_SEARCHES = 10;

type Row = {
  id: string;
  name: string | null;
  q: string | null;
  category: string | null;
  condition: 'NEW' | 'USED' | null;
  minPricePaise: bigint | number | null;
  maxPricePaise: bigint | number | null;
  createdAt: Date;
};

export function toSavedSearchDTO(r: Row) {
  return {
    id: r.id,
    name: r.name,
    q: r.q,
    category: r.category,
    condition: r.condition,
    minPricePaise: toPaiseOrNull(r.minPricePaise),
    maxPricePaise: toPaiseOrNull(r.maxPricePaise),
    createdAt: r.createdAt.toISOString(),
  };
}

export async function listSavedSearches(memberId: string) {
  const rows = await prisma.savedSearch.findMany({ where: { memberId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  return { items: rows.map(toSavedSearchDTO) };
}

export async function createSavedSearch(memberId: string, input: CreateSavedSearchInput) {
  if ((await prisma.savedSearch.count({ where: { memberId } })) >= MAX_SAVED_SEARCHES) {
    throw new AppError(409, 'SAVED_SEARCH_LIMIT', `You can save at most ${MAX_SAVED_SEARCHES} searches`);
  }
  const row = await prisma.savedSearch.create({
    data: {
      memberId,
      name: input.name || null,
      q: input.q || null,
      category: input.category || null,
      condition: input.condition ?? null,
      minPricePaise: input.minPricePaise ?? null,
      maxPricePaise: input.maxPricePaise ?? null,
    },
  });
  return { savedSearch: toSavedSearchDTO(row) };
}

export async function deleteSavedSearch(memberId: string, id: string) {
  const { count } = await prisma.savedSearch.deleteMany({ where: { id, memberId } });
  if (count === 0) throw NotFound('Saved search not found');
  return { id };
}
