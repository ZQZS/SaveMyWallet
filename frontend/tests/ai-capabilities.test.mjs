import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { toReminderFacts } from '../src/integrations/ai/capabilities.ts'
import { readBillDrafts } from '../src/integrations/ai/visionDrafts.ts'

test('提醒上下文只提取指定月份的汇总事实', () => {
  const summary = { due: 3250, balance: 10675, salary: 100000, groups: [{ title: '私密款项' }] }
  assert.deepEqual(toReminderFacts('2027-01', summary, 20000), {
    month: '2027-01', dueCents: 3250, balanceCents: 10675, warningFloorCents: 20000,
  })
})

test('识图草稿保留多笔、分期与缺失字段，可处理没有款项的图片', async () => {
  const path = new URL('../resources/ai/fixtures/vision-synthetic.json', import.meta.url)
  const sample = JSON.parse(await readFile(path, 'utf8'))
  assert.deepEqual(readBillDrafts(sample), sample.drafts)
  assert.deepEqual(readBillDrafts({ drafts: [] }), [])
})

test('越界或无法辨认的字段留给审核，不接受模型提供的平台 ID 或还款状态', () => {
  const [draft] = readBillDrafts({ drafts: [{
    platformHint: ' 示例 ', title: '', platformId: 'model-id', status: 'paid',
    month: '2027-13', amountCents: 5.5, kind: 'installment', installmentCount: 0,
  }] })
  assert.deepEqual(draft, {
    platformHint: '示例', title: null, month: null, amountCents: null, kind: 'installment', installmentCount: null,
  })
  assert.throws(() => readBillDrafts({ items: [] }), /drafts/)
  assert.throws(() => readBillDrafts({ drafts: [null] }), /第 1 条/)
})
