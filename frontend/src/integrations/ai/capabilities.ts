import type { MonthlySummary } from '../../domain/ledger'
import type { RecognizedBillDraft } from './visionDrafts'

export interface ReminderFacts {
  month: string
  balanceCents: number
  dueCents: number
  warningFloorCents: number
}

/** Only the four displayed facts may leave the local ledger for reminder copy. */
export function toReminderFacts(
  month: string,
  summary: Pick<MonthlySummary, 'balance' | 'due'>,
  warningFloorCents: number,
): ReminderFacts {
  return { month, balanceCents: summary.balance, dueCents: summary.due, warningFloorCents }
}

/**
 * Optional frontend port for a future native adapter.
 * profileId references a local provider/model profile; imageToken references a user-selected image.
 */
export interface AiCapabilities {
  writeReminder?(profileId: string, facts: ReminderFacts): Promise<string>
  reply?(profileId: string, input: { message: string; facts?: ReminderFacts }): Promise<string>
  recognizeBills?(profileId: string, input: { imageToken: string }): Promise<RecognizedBillDraft[]>
}
