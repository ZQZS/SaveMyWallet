import type { LedgerSession } from '../../app/ledgerSession.ts'
import type { LedgerRepository } from '../../data/repository.ts'
import { estimateTotalCents, installmentPeriods, isMonth, MAX_AMOUNT_CENTS, projectBillingMonths,
  type Entry, type LedgerData } from '../../domain/ledger.ts'
import { formatMoney, formatMonth, t } from '../../i18n/index.ts'
import { entryStatusLabel } from '../../shared/entryStatusLabel.ts'
import { prepareCreationAction, type CreationActionName } from './ledgerCreationActions.ts'

type RowAction = 'mark_bills_paid' | 'mark_bills_unpaid' | 'undo_last_payment' | 'void_bills' | 'restore_bill' | 'confirm_estimate'
export type LedgerActionName = RowAction | CreationActionName
type LastPayment = LedgerSession['lastPayment']['value']
type ActionArgs = Record<string, unknown>
export type ActionOutcome = 'applied' | 'refreshPending' | 'unchanged' | 'partial'

export interface PreparedLedgerAction {
  name: LedgerActionName
  lines: string[]
  readonly changedCount?: number
  apply(): Promise<ActionOutcome>
}

export interface LedgerActionPlan {
  lines: string[]
  fingerprint: string
  expectedCount?: number
  write(repository: LedgerRepository, operationId: string): Promise<string[] | void>
}

function invalid(key = 'ledger.actionRows'): never {
  throw new Error(t(key))
}

function rowNumbers(name: RowAction, args: ActionArgs): number[] {
  const single = name === 'restore_bill' || name === 'confirm_estimate'
  const allowed = single ? ['row'] : ['rows']
  if (name === 'confirm_estimate') allowed.push('title', 'month', 'amountCents', 'totalCents', 'depositCents')
  if (name === 'restore_bill' || name === 'void_bills') allowed.push('scope')
  if (Object.keys(args).some(key => !allowed.includes(key))) invalid()
  if ('scope' in args && args.scope !== 'entry' && args.scope !== 'installment') invalid()
  const rows = single ? [args.row] : args.rows
  if (!Array.isArray(rows) || !rows.length || (args.scope === 'installment' && rows.length !== 1)
      || rows.some(row => !Number.isSafeInteger(row) || row < 1) || new Set(rows).size !== rows.length) invalid()
  return rows
}

function billLabel(entry: Entry, platform: string, next: Entry): string {
  const period = entry.kind === 'installment' ? t('ledger.installment', {
    index: entry.installmentIndex ?? '—', count: entry.installmentCount ?? '—',
  }) : ''
  const before = [entry.title, formatMonth(entry.month), formatMoney(entry.amountCents), entryStatusLabel(entry)].join(' · ')
  const after = [
    next.title !== entry.title && next.title,
    next.month !== entry.month && formatMonth(next.month),
    next.amountCents !== entry.amountCents && formatMoney(next.amountCents),
    entryStatusLabel(next),
  ].filter(Boolean).join(' · ')
  return [platform, period, before].filter(Boolean).join(' · ') + ' → ' + after
}

function amountField(args: ActionArgs, key: string, minimum: number): number | undefined {
  if (!Object.hasOwn(args, key)) return undefined
  const value = args[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > MAX_AMOUNT_CENTS) {
    invalid(key === 'depositCents' ? 'forms.depositError' : 'forms.totalError')
  }
  return value
}

function makeRowPlan(name: RowAction, args: ActionArgs, selectedIds: readonly string[], month: string,
    data: LedgerData, lastPayment: LastPayment, calendarMonth: string): LedgerActionPlan {
  const rows = rowNumbers(name, args)
  const byId = new Map(data.entries.map(entry => [entry.id, entry]))
  let entries = rows.map(row => {
    const entry = byId.get(selectedIds[row - 1])
    if (!entry || entry.month !== month) invalid()
    return entry
  })
  const anchor = entries[0]
  const entirePlan = args.scope === 'installment'
  if (entirePlan) {
    entries = installmentPeriods(data.entries, anchor) ?? invalid('error.INSTALLMENT_GROUP_UNAVAILABLE')
  }
  const platforms = new Map(data.platforms.map(platform => [platform.id, platform.name]))
  const fingerprint = JSON.stringify(entries.map(entry => [
    entry.id, entry.platformId, platforms.get(entry.platformId), entry.title, entry.month, entry.carriedFromMonth,
    entry.amountCents, entry.depositCents ?? 0, entry.status, Boolean(entry.voided), entry.kind,
    entry.installmentId, entry.installmentCount, entry.installmentIndex,
  ]))
  const lines: string[] = entirePlan ? [t('ledger.installmentPlan')] : []
  const ids = entries.map(entry => entry.id)
  const platformOf = (entry: Entry) => platforms.get(entry.platformId) ?? invalid()
  if (name === 'confirm_estimate') {
    if (anchor.kind !== 'estimate' || anchor.status !== 'estimated' || anchor.voided) invalid('forms.staleEstimate')
    const title = 'title' in args ? args.title : anchor.title
    const targetMonth = 'month' in args ? args.month : anchor.month
    if (typeof title !== 'string' || !title.trim() || title.includes('\0') || Array.from(title.trim()).length > 120) invalid('forms.titleError')
    if (typeof targetMonth !== 'string' || !isMonth(targetMonth)) invalid('forms.monthError')
    const oldDeposit = anchor.depositCents ?? 0
    const oldTotal = estimateTotalCents(anchor)
    const depositCents = amountField(args, 'depositCents', 0) ?? oldDeposit
    const balance = amountField(args, 'amountCents', 0)
    const totalCents = amountField(args, 'totalCents', 1) ?? (balance === undefined ? oldTotal : balance + depositCents)
    if (totalCents <= 0 || totalCents > MAX_AMOUNT_CENTS) invalid('forms.totalError')
    if (totalCents < depositCents) invalid('forms.depositError')
    const amountCents = totalCents - depositCents
    if (balance !== undefined && balance !== amountCents) invalid('billImage.amountConflict')
    const input = { id: anchor.id, title: title.trim(), month: targetMonth, amountCents, totalCents, depositCents }
    const next: Entry = { ...anchor, ...input, status: amountCents === 0 ? 'paid' : 'due' }
    const previousAmounts = t('ledger.estimateBreakdown', { total: formatMoney(oldTotal), deposit: formatMoney(oldDeposit) })
    const nextAmounts = t('ledger.estimateBreakdown', {
      total: formatMoney(estimateTotalCents(next)), deposit: formatMoney(depositCents),
    })
    lines.push(billLabel(anchor, platformOf(anchor), next),
      oldTotal !== totalCents || oldDeposit !== depositCents ? previousAmounts + ' → ' + nextAmounts : nextAmounts)
    return { lines, fingerprint, write: repository => repository.confirmEstimate(input) }
  }
  if (name === 'restore_bill' || name === 'void_bills') {
    const voided = name === 'void_bills'
    const affected = entries.filter(entry => Boolean(entry.voided) !== voided)
    if (!affected.length || (!entirePlan && affected.length !== entries.length)) invalid()
    const afterMonth = (entry: Entry) => {
      if (voided) return entry.carriedFromMonth ?? entry.month
      return entry.status === 'estimated' && entry.month < calendarMonth ? calendarMonth : entry.month
    }
    for (const entry of entries) lines.push(billLabel(entry, platformOf(entry), { ...entry, voided, month: afterMonth(entry) }))
    return { lines, expectedCount: affected.length, fingerprint: JSON.stringify([fingerprint, entries.map(afterMonth)]), write: async (repository, operationId) => {
      if (entirePlan) return repository.setInstallmentVoided(anchor.id, voided, operationId)
      if (voided) return repository.voidEntries(ids, operationId)
      await repository.setEntryVoided(anchor.id, false, operationId)
      return [anchor.id]
    } }
  }

  let paid = name === 'mark_bills_paid'
  if (name === 'undo_last_payment') {
    const previousIds = new Set(lastPayment?.ids)
    if (!lastPayment || (lastPayment.month && lastPayment.month !== month)
        || ids.length !== previousIds.size || ids.some(id => !previousIds.has(id))) invalid('ledger.actionUndoRows')
    paid = !lastPayment.paid
  }
  const previousStatus = paid ? 'due' : 'paid'
  if (entries.some(entry => entry.voided || entry.status !== previousStatus || entry.amountCents <= 0)) invalid()
  for (const entry of entries) lines.push(billLabel(entry, platformOf(entry), { ...entry, status: paid ? 'paid' : 'due' }))
  lines.push(t('forms.selectedBillsTotal', {
    count: ids.length, amount: formatMoney(entries.reduce((sum, entry) => sum + entry.amountCents, 0)),
  }))
  return { lines, fingerprint, expectedCount: ids.length, write: (repository, operationId) =>
    name === 'undo_last_payment' && repository.undoPayment
      ? repository.undoPayment(ids, paid)
      : repository.setPayment(ids, paid, operationId) }
}

// The model receives one-based row numbers. Only this send's local snapshot maps them to real IDs.
export function createLedgerActionScope(session: LedgerSession, month: string, selectedIds: readonly string[]) {
  let snapshot = session.data.value
  const ids = [...selectedIds]
  let lastPayment = session.lastPayment.value
  function prepare(name: LedgerActionName, parameters: ActionArgs): PreparedLedgerAction {
    if (!snapshot || session.month.value !== month || session.needsReload.value) invalid('ledger.actionBusy')
    if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) invalid()
    const args = structuredClone(parameters)
    const build = (data: LedgerData, last: LastPayment) => {
      switch (name) {
        case 'create_bill': case 'create_platform': case 'update_budget':
          return prepareCreationAction(name, args, month, data)
        case 'mark_bills_paid': case 'mark_bills_unpaid': case 'undo_last_payment':
        case 'void_bills': case 'restore_bill': case 'confirm_estimate':
          return makeRowPlan(name, args, ids, month, data, last, session.calendarMonth.value)
        default: return invalid()
      }
    }
    const approved = build(snapshot, lastPayment)
    const operationId = crypto.randomUUID()
    let outcome: ActionOutcome | undefined
    let changedCount: number | undefined
    async function apply(): Promise<ActionOutcome> {
      if (outcome) return outcome
      if (session.busy.value || session.needsReload.value) invalid('ledger.actionBusy')
      if (session.month.value !== month) invalid('ledger.actionStale')
      await session.commit(async () => {
        const reviewed = session.repository.beginReviewedWrite
          ? await session.repository.beginReviewedWrite()
          : { ledger: await session.repository.load(), repository: session.repository }
        let current: LedgerActionPlan
        try {
          current = build(projectBillingMonths(reviewed.ledger, session.calendarMonth.value), session.lastPayment.value)
        } catch {
          return invalid('ledger.actionStale')
        }
        if (current.fingerprint !== approved.fingerprint || session.month.value !== month) invalid('ledger.actionStale')
        const changed = await current.write(reviewed.repository, operationId)
        // The database has accepted the write. A refresh failure must only retry the read.
        outcome = 'refreshPending'
        return changed
      }, changed => {
        changedCount = changed?.length
        if (changedCount === 0) outcome = 'unchanged'
        else if (changedCount !== undefined && approved.expectedCount && changedCount < approved.expectedCount) outcome = 'partial'
        else outcome = 'applied'
        if (name === 'undo_last_payment') session.lastPayment.value = null
        else if (changed?.length && (name === 'mark_bills_paid' || name === 'mark_bills_unpaid')) {
          session.lastPayment.value = { month, ids: changed, paid: name === 'mark_bills_paid' }
        } else if (changed?.length) session.invalidatePaymentUndo(changed)
        // The next proposal in this turn can depend on this confirmed write, for example
        // marking a newly confirmed estimate paid. The original row-to-ID mapping stays fixed.
        snapshot = session.data.value
        lastPayment = session.lastPayment.value
      })
      if (!outcome) throw new Error(session.error.value || t('ledger.actionBusy'))
      return outcome
    }
    return { name, lines: approved.lines, get changedCount() { return changedCount }, apply }
  }
  return { prepare }
}
