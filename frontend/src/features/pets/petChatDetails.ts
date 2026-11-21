import type { Entry, MonthlySummary } from '../../domain/ledger.ts'

type DetailFields = Pick<Entry, 'title' | 'kind' | 'status' | 'amountCents' | 'depositCents' | 'voided'>

export interface PetChatDetail extends DetailFields {
  platform: string
  installmentIndex?: number
  installmentCount?: number
}

export interface PetChatDetails {
  month: string
  entries: PetChatDetail[]
}

export interface PetChatDetailOption {
  id: string
  month: string
  detail: PetChatDetail
}

function projectDetail(platform: string, entry: DetailFields & Partial<Pick<Entry, 'installmentIndex' | 'installmentCount'>>): PetChatDetail {
  const { title, kind, status, amountCents } = entry
  const detail: PetChatDetail = { platform, title, kind, status, amountCents }
  if (entry.voided) detail.voided = true
  if (kind === 'estimate') detail.depositCents = entry.depositCents ?? 0
  if (kind === 'installment') {
    if (entry.installmentIndex != null) detail.installmentIndex = entry.installmentIndex
    if (entry.installmentCount != null) detail.installmentCount = entry.installmentCount
  }
  return detail
}

export function petChatDetailOptions(month: string, summary: Pick<MonthlySummary, 'groups'>, includeVoided = false): PetChatDetailOption[] {
  const options: PetChatDetailOption[] = []
  for (const { platform, entries } of summary.groups) {
    for (const entry of entries) {
      if (entry.month === month && (includeVoided || !entry.voided)) {
        options.push({ id: entry.id, month, detail: projectDetail(platform.name, entry) })
      }
    }
  }
  return options
}

// Only construct wire fields here. Local selection IDs and ledger metadata stay on the device.
export function petChatDetailsPayload({ month, entries }: PetChatDetails): PetChatDetails {
  return { month, entries: entries.map(entry => projectDetail(entry.platform, entry)) }
}

// Tool row numbers index this send's selected options in display order.
export function selectedPetChatOptions(month: string, options: readonly PetChatDetailOption[], selectedIds: ReadonlySet<string>): PetChatDetailOption[] {
  return options.filter(option => option.month === month && selectedIds.has(option.id))
}

export function selectedPetChatDetails(month: string, options: readonly PetChatDetailOption[], selectedIds: ReadonlySet<string>): PetChatDetails {
  const entries = selectedPetChatOptions(month, options, selectedIds).map(option => option.detail)
  return petChatDetailsPayload({ month, entries })
}
