import { isMonth, MAX_AMOUNT_CENTS, shiftMonth, type BillKind, type Platform } from '../../domain/ledger.ts'

/** Unreviewed model output. Amount means each period's payable amount for an installment. */
export interface RecognizedBillDraft {
  platformHint: string | null
  title: string | null
  month: string | null
  amountCents: number | null
  /** Original row annotation for the reviewer. */
  refundText?: string
  totalCents?: number | null
  depositCents?: number | null
  invalidEstimateAmounts?: true
  kind: BillKind | null
  installmentCount: number | null
  /** Current period in month. A full plan omits this, an unreadable billed period uses null. */
  installmentIndex?: number | null
}

export function isHuabeiName(name: string): boolean {
  return /^(?:支付宝\s*)?花呗(?:分期)?$/.test(name)
}

export function draftPlatformId(platforms: Platform[], hint?: string | null, selectedId?: string): string {
  if (selectedId && platforms.some(platform => platform.id === selectedId)) return selectedId
  const name = hint?.trim().toLowerCase()
  if (!name) return ''
  const exact = platforms.filter(platform => platform.name.toLowerCase() === name)
  if (exact.length > 0) return exact.length === 1 ? exact[0].id : ''
  const aliases = isHuabeiName(name) ? platforms.filter(platform => isHuabeiName(platform.name)) : []
  return aliases.length === 1 ? aliases[0].id : ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readText(value: unknown): string | null {
  return typeof value === 'string' ? value.trim() || null : null
}

function readRepaymentMonth(value: unknown): string | null {
  // A numeric 2026.11 is unambiguous, but JSON turns both 2026.1 and 2026.10 into 2026.1.
  const text = typeof value === 'number' && /^\d{4}\.\d{2}$/.test(String(value)) ? String(value) : readText(value)
  if (!text) return null
  const date = text.normalize('NFKC')
    .replace(/^(?:已付定金[^,]*,\s*)?预计\s*/, '')
    .replace(/^(?:首期还款|尾款支付|还款|补款)(?:时间|日期|月份)?\s*:?\s*/, '')
    .replace(/\s*到货(?:后)?补款$/, '')
    .trim()
    .replace(/(?:T|\s+)(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/, '')
  const parts = /^(\d{4})\s*年\s*(\d{1,2})\s*月(?:\s*(\d{1,2})\s*[日号])?$/.exec(date)
    ?? /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/.exec(date.replace(/[./]/g, '-'))
  if (!parts) return null
  const [, year, month, day] = parts
  const result = `${year}-${month.padStart(2, '0')}`
  if (!isMonth(result)) return null
  if (day) {
    const daysInMonth = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate()
    if (Number(day) < 1 || Number(day) > daysInMonth) return null
  }
  return result
}

function readInteger(value: unknown, minimum: number, maximum: number): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : null
}

function readStatementMonth(label: string, referenceMonth?: string): string | null {
  const date = label.normalize('NFKC').trim()
    .replace(/^(?:账单月份?|还款日(?:期)?)\s*:?\s*/, '')
    .replace(/\s*(?:总计)?账单$/, '')
    .trim()
  const fullMonth = readRepaymentMonth(date)
  if (fullMonth) return fullMonth

  const yearless = /^(\d{1,2})月(?:\s*\d{1,2}[日号])?$/.exec(date)
  if (!yearless || !referenceMonth || !isMonth(referenceMonth)) return null
  const month = yearless[1].padStart(2, '0')
  for (const offset of [-1, 0, 1]) {
    const candidate = shiftMonth(referenceMonth, offset)
    if (isMonth(candidate) && candidate.slice(5) === month) {
      return readRepaymentMonth(candidate.slice(0, 4) + '年' + date)
    }
  }
  return null
}

function readEstimateAmounts(row: Record<string, unknown>, balance: number | null) {
  let totalCents = readInteger(row.totalCents, 1, MAX_AMOUNT_CENTS)
  let depositCents = readInteger(row.depositCents, 0, MAX_AMOUNT_CENTS)
  if ((row.totalCents != null && totalCents === null) || (row.depositCents != null && depositCents === null)
    || (row.amountCents != null && balance === null)) {
    return { totalCents, depositCents, invalidEstimateAmounts: true as const }
  }
  // Two stated amounts determine the third. A missing deposit is different from an explicit zero.
  if (balance !== null) {
    if (totalCents === null && depositCents !== null) totalCents = readInteger(depositCents + balance, 1, MAX_AMOUNT_CENTS)
    else if (depositCents === null && totalCents !== null) depositCents = readInteger(totalCents - balance, 0, MAX_AMOUNT_CENTS)
  }
  return { totalCents, depositCents }
}

export function estimateAmountsConflict(draft: RecognizedBillDraft): boolean {
  if (draft.kind !== 'estimate') return false
  if (draft.invalidEstimateAmounts) return true
  const { amountCents: balance, totalCents, depositCents } = draft
  if (totalCents != null && totalCents < Math.max(balance ?? 0, depositCents ?? 0)) return true
  if (depositCents == null || balance === null) return false
  const sum = depositCents + balance
  return sum < 1 || sum > MAX_AMOUNT_CENTS || (totalCents != null && totalCents !== sum)
}

// Match the prefix on the original title to preserve full-width characters in product names.
const periodPrefix = /^(?:花呗分期[\s:：、·-]+)?第\s*([0-9０-９]+)\s*(?:[／/]\s*([0-9０-９]+)\s*)?期[\s:：、·-]*/u

function periodValue(field: unknown, printed?: string): number | null {
  const value = readInteger(field, 1, 120)
  if (printed === undefined) return value
  const onBill = readInteger(Number(printed.normalize('NFKC')), 1, 120)
  return value !== null && value !== onBill ? null : onBill
}

function rowPlatformHint(row: Record<string, unknown>, title: string | null): string | null {
  const hint = readText(row.platformHint)
  if ((!hint || hint === '支付宝') && title?.includes('花呗分期')) return '花呗'
  return hint
}

function excludeRefund(row: Record<string, unknown>, title: string | null, payableCharge: boolean): boolean {
  // A separate refund can display an unsigned amount. Its title identifies the transaction.
  const refundLabel = /^(?:商家|订单|商品|交易|消费|退货|花呗)?退款(?:$|[\s:：·—，,（(-]|到账|入账|成功|至|到|金额)/
  const statusTitle = /^(?:已退款|部分退款|有退款)[。.]?$|^(?:(?:已退款|部分退款|有退款)[\s，,:：—-]+)?已退(?:至|到|回)/
  if (title && (refundLabel.test(title) || statusTitle.test(title))) return true
  if (payableCharge) return false
  const status = /(?:已退款|部分退款|退款成功|(?<!没)有退款|已退(?:至|到|回)|(?:退款|退)(?:至|到|回)[^，,。\n]*(?:月|账单))/
  const memo = readText(row.refundText) ?? ''
  return row.isRefunded === true || status.test(memo) || refundLabel.test(memo) || status.test(title ?? '')
    || status.test(readText(row.repaymentTimeText) ?? '')
}

/** Parse a provider's decoded JSON. Unknown fields never become ledger writes. */
export function readBillRecognition(response: unknown, referenceMonth?: string, selectedPlatform?: string) {
  if (!isRecord(response) || !Array.isArray(response.drafts)) {
    throw new Error('识图响应缺少 drafts 数组。')
  }
  const rows = response.drafts.map((row: unknown, index: number) => {
    if (!isRecord(row)) throw new Error(`第 ${index + 1} 条识图草稿格式有误。`)
    const title = readText(row.title)
    return { row, title, header: readText(row.statementMonthText), prefix: title?.match(periodPrefix),
      platform: rowPlatformHint(row, title) }
  })
  const headers = new Set(rows.map(item => item.header).filter(value => value !== null))
  const sharedHeader = headers.size === 1 ? [...headers][0] : null
  const hints = rows.map(item => item.platform).filter(value => value !== null)
  const platforms = new Set(hints.map(name => isHuabeiName(name) ? '花呗' : name))
  // 支付宝 alone may label the parent app on a 花呗 statement.
  if (platforms.has('花呗')) platforms.delete('支付宝')
  const huabeiPage = (platforms.size === 1 && platforms.has('花呗'))
    || (isHuabeiName(selectedPlatform?.trim() ?? '') && hints.every(name => name === '支付宝'))
  // Read the printed total independently so a missing row remains detectable.
  const statementTotalCents = readInteger(response.statementTotalCents, 0, Number.MAX_SAFE_INTEGER)
  const isMonthlyStatement = statementTotalCents !== null || headers.size > 0
  const isStatement = isMonthlyStatement || rows.some(({ row, prefix }) =>
    row.installmentIndex != null || prefix?.[2] || (huabeiPage && prefix))
  const sharedPlatform = isStatement && platforms.size === 1 ? [...platforms][0] : null
  const drafts = rows.flatMap(({ row, title, header, prefix, platform }): RecognizedBillDraft | [] => {
    const recognizedKind = row.kind === 'single' || row.kind === 'installment' || row.kind === 'estimate' ? row.kind : null
    const statementMonth = header ?? (recognizedKind !== 'estimate' ? sharedHeader : null)
    const huabeiPeriod = Boolean(prefix && (huabeiPage || (platform && isHuabeiName(platform))))
    const statementLine = Boolean(statementMonth || huabeiPeriod || (isStatement && recognizedKind !== 'estimate'))
    const billed = Boolean(prefix?.[2] || row.installmentIndex != null || huabeiPeriod
      || (statementLine && (recognizedKind === 'installment'
        || (recognizedKind === null && readInteger(row.installmentCount, 2, 120) !== null))))
    const product = billed && prefix ? readText(title?.slice(prefix[0].length)) : title
    if (typeof row.amountCents === 'number' && row.amountCents < 0) return []
    const kind = billed ? 'installment' : statementLine ? 'single' : recognizedKind
    const amountCents = readInteger(row.amountCents, kind === 'estimate' ? 0 : 1, MAX_AMOUNT_CENTS)
    const charge = billed || kind === 'single' || (kind === null && (huabeiPage || isHuabeiName(platform ?? '')))
    if (excludeRefund(row, product, charge && amountCents !== null)) return []
    const count = kind === 'installment' ? periodValue(row.installmentCount, billed ? prefix?.[2] : undefined) : null
    const index = billed ? periodValue(row.installmentIndex, prefix?.[1]) : null
    const repaymentText = readText(row.repaymentTimeText)
    const repaymentMonth = billed && index !== 1 && repaymentText?.startsWith('首期')
      ? null : readRepaymentMonth(row.repaymentTimeText)
    const month = readRepaymentMonth(row.month)
    const refundText = readText(row.refundText)
    return {
      platformHint: platform === '支付宝' && sharedPlatform === '花呗' ? sharedPlatform : platform ?? sharedPlatform,
      title: product,
      month: statementMonth ? readStatementMonth(statementMonth, referenceMonth)
        : billed ? month ?? repaymentMonth : repaymentMonth ?? month,
      amountCents,
      ...(refundText ? { refundText } : {}),
      ...(kind === 'estimate' ? readEstimateAmounts(row, amountCents) : {}),
      kind,
      installmentCount: count,
      ...(billed ? { installmentIndex: count !== null && index !== null && index > count ? null : index } : {}),
    }
  })
  return { drafts, statementTotalCents, isMonthlyStatement }
}

export function readBillDrafts(response: unknown, referenceMonth?: string, selectedPlatform?: string): RecognizedBillDraft[] {
  return readBillRecognition(response, referenceMonth, selectedPlatform).drafts
}
