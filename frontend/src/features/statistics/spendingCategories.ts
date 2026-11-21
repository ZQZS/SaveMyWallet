import type { StatisticsMonth } from './statistics.ts'

const spendingCategories = [
  'food', 'transport', 'housing', 'shopping', 'health', 'education', 'gaming', 'merchandise', 'leisure', 'other',
] as const
export type SpendingCategory = typeof spendingCategories[number]

interface SpendingTotals {
  amountCents: number
  count: number
}

interface TitleSpending extends SpendingTotals {
  title: string
}

export interface CategorySpendingInput extends SpendingTotals {
  items: TitleSpending[]
  unclassified: SpendingTotals
}

export interface CategorySpendingRow extends SpendingTotals {
  category: SpendingCategory
  share: number
}

export function prepareCategorySpending(months: readonly StatisticsMonth[]): CategorySpendingInput {
  const byTitle = new Map<string, TitleSpending>()
  const unclassified = { amountCents: 0, count: 0 }
  let amountCents = 0
  let count = 0
  for (const month of months) {
    for (const group of month.groups) {
      for (const entry of group.entries) {
        if (entry.voided) continue
        amountCents += entry.amountCents
        count++
        const title = entry.title.trim()
        // Keep unusable legacy titles in the local totals without sending a truncated or invented title.
        if (!title || title.includes('\0') || Array.from(title).length > 120) {
          unclassified.amountCents += entry.amountCents
          unclassified.count++
          continue
        }
        const item = byTitle.get(title)
        if (item) {
          item.amountCents += entry.amountCents
          item.count++
        } else {
          byTitle.set(title, { title, amountCents: entry.amountCents, count: 1 })
        }
      }
    }
  }
  return { items: [...byTitle.values()], amountCents, count, unclassified }
}

type ClassifyBatch = (titles: string[], signal: AbortSignal) => Promise<unknown>
const batchSize = 40

export async function analyzeCategorySpending(
  input: CategorySpendingInput, classifyBatch: ClassifyBatch, signal: AbortSignal,
): Promise<CategorySpendingRow[]> {
  if (signal.aborted) throw new Error('AI_CANCELLED')
  const totals = new Map<SpendingCategory, SpendingTotals>()
  if (input.unclassified.count) totals.set('other', { ...input.unclassified })
  for (let start = 0; start < input.items.length; start += batchSize) {
    const batch = input.items.slice(start, start + batchSize)
    const categories = await classifyBatch(batch.map(item => item.title), signal)
    if (signal.aborted) throw new Error('AI_CANCELLED')
    if (!Array.isArray(categories) || categories.length !== batch.length) throw new Error('AI_BAD_RESPONSE')
    for (const [index, item] of batch.entries()) {
      const category = categories[index]
      if (!spendingCategories.includes(category)) throw new Error('AI_BAD_RESPONSE')
      const row = totals.get(category)
      if (row) {
        row.amountCents += item.amountCents
        row.count += item.count
      } else {
        totals.set(category, { amountCents: item.amountCents, count: item.count })
      }
    }
  }
  return Array.from(totals, ([category, row]) => ({
    category, ...row, share: input.amountCents ? row.amountCents / input.amountCents : 0,
  })).sort((a, b) => b.amountCents - a.amountCents || b.count - a.count)
}
