import { isMonth, MAX_AMOUNT_CENTS, type BillInput, type BudgetInput, type LedgerData } from '../../domain/ledger.ts'
import { formatMoney, formatMonth, t } from '../../i18n/index.ts'
import { readInstallmentSchedule } from '../bills/installmentSchedule.ts'
import type { LedgerActionPlan } from './ledgerActions.ts'

export type CreationActionName = 'create_bill' | 'create_platform' | 'update_budget'
type Args = Record<string, unknown>

function checkKeys(args: Args, allowed: string[]) {
  if (Object.keys(args).some(key => !allowed.includes(key))) throw new Error(t('error.AI_INVALID_INPUT'))
}

function label(value: unknown, limit: number, errorKey: string): string {
  const name = typeof value === 'string' ? value.trim() : ''
  if (!name || name.includes('\0') || Array.from(name).length > limit) throw new Error(t(errorKey))
  return name
}

function cents(value: unknown, minimum: number, errorKey: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > MAX_AMOUNT_CENTS) {
    throw new Error(t(errorKey))
  }
  return value
}

function billingMonth(value: unknown): string {
  if (typeof value !== 'string' || !isMonth(value)) throw new Error(t('forms.monthError'))
  return value
}

function createBill(args: Args, selectedMonth: string, data: LedgerData): LedgerActionPlan {
  const baseKeys = ['platform', 'title', 'month', 'kind', 'amountCents']
  const kind = args.kind
  if (kind !== 'single' && kind !== 'installment' && kind !== 'estimate') throw new Error(t('billImage.selectKind'))
  checkKeys(args, baseKeys.concat(kind === 'estimate' ? ['totalCents', 'depositCents'] : kind === 'installment' ? ['installmentCount'] : []))
  const platformName = label(args.platform, 40, 'forms.selectPlatformError')
  const platforms = data.platforms.filter(platform => platform.name.toLowerCase() === platformName.toLowerCase())
  if (platforms.length !== 1) throw new Error(t('forms.selectPlatformError'))
  const platform = platforms[0]
  const title = label(args.title, 120, 'forms.titleError')
  const month = billingMonth(args.month === undefined ? selectedMonth : args.month)
  const lines = [`${t('forms.' + kind)} · ${platform.name} · ${title}`, formatMonth(month)]
  let input: BillInput
  let lastMonth = month
  if (kind === 'estimate') {
    const totalCents = cents(args.totalCents, 1, 'forms.totalError')
    const depositCents = cents(args.depositCents === undefined ? 0 : args.depositCents, 0, 'forms.depositError')
    if (depositCents > totalCents) throw new Error(t('forms.depositError'))
    const amountCents = totalCents - depositCents
    if (args.amountCents !== undefined && args.amountCents !== amountCents) throw new Error(t('billImage.amountConflict'))
    input = { kind, month, title, platformId: platform.id, totalCents, depositCents, amountCents, installmentCount: 1 }
    lines.push(t('ledger.estimateBreakdown', { total: formatMoney(totalCents), deposit: formatMoney(depositCents) }),
      `${t('ledger.balancePayment')} · ${formatMoney(amountCents)}`)
  } else {
    const amountCents = cents(args.amountCents, 1, 'forms.amountError')
    const count = kind === 'single' ? 1 : args.installmentCount
    if (typeof count !== 'number') throw new Error(t('forms.scheduleError'))
    const schedule = readInstallmentSchedule(month, count)
    if (!schedule) throw new Error(t('forms.scheduleError'))
    lastMonth = schedule.lastMonth
    input = { kind, month, title, platformId: platform.id, amountCents, installmentCount: count }
    if (kind === 'installment') {
      lines.push(`${t('forms.amountPerPeriod')} · ${formatMoney(amountCents)}`, t('forms.schedulePreview', {
        start: formatMonth(month), end: formatMonth(lastMonth), count, total: formatMoney(amountCents * count),
      }))
    } else {
      lines.push(formatMoney(amountCents))
    }
  }
  const matches = data.entries.filter(entry => {
    const originalMonth = entry.carriedFromMonth ?? entry.month
    return !entry.voided && entry.platformId === platform.id && entry.kind === kind && entry.title === title
      && originalMonth >= month && originalMonth <= lastMonth && entry.amountCents === input.amountCents
  }).map(entry => entry.id).sort()
  if (matches.length) lines.push(t('billImage.possibleMatch'))
  return { lines, fingerprint: JSON.stringify([input, platform.name, matches]),
    write: (repo, operationId) => repo.createBills([input], operationId) }
}

function createPlatform(args: Args, data: LedgerData): LedgerActionPlan {
  checkKeys(args, ['name'])
  const name = label(args.name, 40, 'forms.platformNameError')
  if (data.platforms.some(platform => platform.name.toLowerCase() === name.toLowerCase())) {
    throw new Error(t('forms.platformExists'))
  }
  return { lines: [`${t('forms.newPlatform')} · ${name}`], fingerprint: JSON.stringify(name),
    write: async repo => { await repo.createPlatform(name) } }
}

function updateBudget(args: Args, selectedMonth: string, data: LedgerData): LedgerActionPlan {
  const fields = ['defaultSalaryCents', 'warningFloorCents', 'overrideSalaryCents'] as const
  checkKeys(args, ['month', ...fields])
  const month = billingMonth(args.month === undefined ? selectedMonth : args.month)
  const input: BudgetInput = { month, ...data.settings, overrideSalaryCents: data.salaryOverrides[month] ?? null }
  const changes: [string, number | null, number | null][] = []
  const lines: string[] = []
  const fieldLabels = { defaultSalaryCents: t('ledger.defaultSalary'), warningFloorCents: t('forms.floor'),
    overrideSalaryCents: t('forms.salaryOverride', { month: formatMonth(month) }) }
  const amount = (value: number | null) => value === null ? t('ledger.defaultSalary') : formatMoney(value)
  for (const field of fields) {
    if (!Object.hasOwn(args, field)) continue
    const before = input[field]
    if (field === 'overrideSalaryCents' && args[field] === null) input.overrideSalaryCents = null
    else input[field] = cents(args[field], 0, 'forms.budgetAmountError')
    changes.push([field, before, input[field]])
    lines.push(`${fieldLabels[field]} · ${amount(before)} → ${amount(input[field])}`)
  }
  if (!changes.length) throw new Error(t('forms.budgetAmountError'))
  return { lines, fingerprint: JSON.stringify([month, changes]), write: repo => repo.saveBudget(input) }
}

export function prepareCreationAction(name: CreationActionName, args: Args, month: string, data: LedgerData): LedgerActionPlan {
  switch (name) {
    case 'create_bill': return createBill(args, month, data)
    case 'create_platform': return createPlatform(args, data)
    case 'update_budget': return updateBudget(args, month, data)
  }
}
