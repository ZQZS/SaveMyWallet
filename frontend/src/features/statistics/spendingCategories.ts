import type { Entry, Platform } from '../../domain/ledger.ts'
import type { StatisticsMonth } from './statistics.ts'

const spendingCategories = [
  'food', 'transport', 'housing', 'shopping', 'health', 'education', 'gaming', 'merchandise', 'leisure', 'other',
] as const
export type SpendingCategory = typeof spendingCategories[number]

interface SpendingTotals {
  amountCents: number
  count: number
}

export interface CategorySpendingDetail {
  entry: Entry
  platform: Platform
}

export interface CategorySpendingInput extends SpendingTotals {
  titles: string[]
  details: CategorySpendingDetail[]
}

export interface CategorySpendingRow extends SpendingTotals {
  category: SpendingCategory
  share: number
  details: CategorySpendingDetail[]
}

export function prepareCategorySpending(months: readonly StatisticsMonth[]): CategorySpendingInput {
  const titles = new Set<string>()
  const details: CategorySpendingDetail[] = []
  let amountCents = 0
  for (const month of months) {
    for (const group of month.groups) {
      for (const entry of group.entries) {
        if (entry.voided) continue
        details.push({ entry, platform: group.platform })
        amountCents += entry.amountCents
        const title = entry.title.trim()
        // Legacy titles outside the provider's limits are still included in local details.
        if (title && !title.includes('\0') && Array.from(title).length <= 120) titles.add(title)
      }
    }
  }
  return { titles: [...titles], details, amountCents, count: details.length }
}

type ClassifyBatch = (titles: string[], signal: AbortSignal) => Promise<unknown>
const batchSize = 40

export async function analyzeCategorySpending(
  input: CategorySpendingInput, classifyBatch: ClassifyBatch, signal: AbortSignal,
): Promise<CategorySpendingRow[]> {
  if (signal.aborted) throw new Error('AI_CANCELLED')
  const categoryByTitle = new Map<string, SpendingCategory>()
  for (let start = 0; start < input.titles.length; start += batchSize) {
    const batch = input.titles.slice(start, start + batchSize)
    const categories = await classifyBatch(batch, signal)
    if (signal.aborted) throw new Error('AI_CANCELLED')
    if (!Array.isArray(categories) || categories.length !== batch.length) throw new Error('AI_BAD_RESPONSE')
    for (const [index, title] of batch.entries()) {
      const category = categories[index]
      if (!spendingCategories.includes(category)) throw new Error('AI_BAD_RESPONSE')
      categoryByTitle.set(title, category)
    }
  }

  const groups = new Map<SpendingCategory, CategorySpendingDetail[]>()
  for (const detail of input.details) {
    const category = categoryByTitle.get(detail.entry.title.trim()) ?? 'other'
    const details = groups.get(category)
    if (details) details.push(detail)
    else groups.set(category, [detail])
  }
  return Array.from(groups, ([category, details]) => {
    const amountCents = details.reduce((sum, detail) => sum + detail.entry.amountCents, 0)
    details.sort((a, b) => b.entry.month.localeCompare(a.entry.month))
    return { category, details, amountCents, count: details.length, share: input.amountCents ? amountCents / input.amountCents : 0 }
  }).sort((a, b) => b.amountCents - a.amountCents || b.count - a.count)
}
