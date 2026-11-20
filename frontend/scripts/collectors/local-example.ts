import { isMonth, toCents } from '../../src/domain/ledger.ts'
import type { BillCollector } from './contract.ts'

interface ExportRow {
  reference: string
  platform: string
  description: string
  repaymentMonth: string
  amountYuan: string
}

const collect: BillCollector<ExportRow[]> = async rows => rows.map(row => {
  const amountCents = toCents(row.amountYuan)
  if (amountCents === null || amountCents < 1 || !isMonth(row.repaymentMonth)) {
    throw new Error('示例导出记录的金额或还款月份无效：' + row.reference)
  }
  return {
    source: 'local-example',
    externalId: row.reference,
    platformName: row.platform,
    title: row.description,
    month: row.repaymentMonth,
    amountCents,
    kind: 'single',
    installmentCount: 1,
  }
})

const sampleRows: ExportRow[] = [{
  reference: 'example-001',
  platform: '示例平台',
  description: '手办尾款',
  repaymentMonth: '2026-12',
  amountYuan: '168.50',
}]

console.log(JSON.stringify(await collect(sampleRows), null, 2))
