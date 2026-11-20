import type { BillInput } from '../../src/domain/ledger.ts'

/** 采集结果使用来源平台名，审核时再选择账本中的平台 ID。 */
export interface CollectedBill extends Omit<BillInput, 'platformId'> {
  source: string
  externalId: string
  platformName: string
}

export type BillCollector<Input> = (input: Input) => Promise<CollectedBill[]>
