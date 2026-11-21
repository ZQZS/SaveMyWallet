import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { toReminderFacts } from '../src/integrations/ai/capabilities.ts'
import { draftPlatformId, estimateAmountsConflict, readBillDrafts } from '../src/integrations/ai/visionDrafts.ts'
import { MAX_AMOUNT_CENTS } from '../src/domain/ledger.ts'

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

test('识图草稿优先使用手选的平台 ID，自动识别按截图中的名称匹配', () => {
  const platforms = [{ id: 'card', name: '信用卡' }, { id: 'shop', name: 'Shop' }]
  assert.equal(draftPlatformId(platforms, 'Shop', 'card'), 'card')
  assert.equal(draftPlatformId(platforms, null, 'card'), 'card')
  assert.equal(draftPlatformId(platforms, ' shop '), 'shop')
  assert.equal(draftPlatformId(platforms, 'Shop', 'removed'), 'shop')
  assert.equal(draftPlatformId(platforms, '未知平台'), '')
  assert.equal(draftPlatformId([], null, 'removed'), '')
})

test('截图中的尾款、总价和已付定金独立识别，有两项依据时补全金额', () => {
  const estimate = fields => readBillDrafts({ drafts: [{ kind: 'estimate', ...fields }] })[0]
  const values = draft => [draft.totalCents, draft.depositCents, draft.amountCents]
  assert.deepEqual(values(estimate({ amountCents: 500 })), [null, null, 500])
  assert.deepEqual(values(estimate({ totalCents: 500 })), [500, null, null])
  assert.deepEqual(values(estimate({ depositCents: 100 })), [null, 100, null])
  assert.deepEqual(values(estimate({ amountCents: 0, depositCents: 500 })), [500, 500, 0])
  assert.deepEqual(values(estimate({ amountCents: 400, totalCents: 500 })), [500, 100, 400])
  assert.deepEqual(values(estimate({ amountCents: 500, depositCents: 0 })), [500, 0, 500])
  assert.deepEqual(values(estimate({ totalCents: 500, depositCents: 100 })), [500, 100, null])
  assert.equal(estimateAmountsConflict(estimate({ totalCents: 500, depositCents: 100, amountCents: 400 })), false)
  for (const fields of [
    { amountCents: 420, totalCents: 500, depositCents: 100 },
    { totalCents: 100, depositCents: 150 },
    { totalCents: 100, amountCents: 150 },
    { amountCents: MAX_AMOUNT_CENTS, depositCents: 1 },
  ]) assert.equal(estimateAmountsConflict(estimate(fields)), true)
  for (const kind of ['installment', 'single']) {
    const [draft] = readBillDrafts({ drafts: [{ kind, amountCents: 0, totalCents: 500, depositCents: 100 }] })
    assert.equal(draft.amountCents, null)
    assert.equal(draft.totalCents, undefined)
    assert.equal(draft.depositCents, undefined)
  }
})
