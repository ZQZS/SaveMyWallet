import assert from 'node:assert/strict'
import test from 'node:test'
import { petChatDetailOptions, petChatDetailsPayload, selectedPetChatDetails, selectedPetChatOptions } from '../src/features/pets/petChatDetails.ts'

const month = '2026-11'
const platform = { id: 'local-platform', name: '玩具店' }
function bill(id, fields = {}) {
  return { id, month, platformId: platform.id, title: '同款画册', kind: 'single', status: 'due',
    amountCents: 1299, installmentIndex: null, installmentCount: null, ...fields }
}

test('同月可选明细保留同名项并排除作废和他月，只提交勾选的记录', () => {
  const summary = { groups: [{ platform, entries: [
    bill('first'), bill('second', { kind: 'estimate', depositCents: 200, status: 'estimated' }),
    bill('voided', { voided: true }), bill('next', { month: '2026-12' }),
  ] }] }
  const options = petChatDetailOptions(month, summary)
  assert.deepEqual(options.map(option => option.id), ['first', 'second'])
  assert.deepEqual(selectedPetChatDetails(month, options, new Set(['second', 'voided', 'next'])), {
    month, entries: [{ platform: '玩具店', title: '同款画册', kind: 'estimate', status: 'estimated', amountCents: 1299, depositCents: 200 }],
  })
  assert.deepEqual(selectedPetChatDetails('2026-12', options, new Set(['second'])), { month: '2026-12', entries: [] })
  assert.deepEqual(selectedPetChatDetails(month, options, new Set()), { month, entries: [] })
})

test('按原账本表达每期金额、全额预付和旧预计补款，IPC 仅包含预览字段', () => {
  const entries = [
    bill('term', { kind: 'installment', installmentIndex: 2, installmentCount: 6, installmentId: 'private-plan' }),
    bill('prepaid', { kind: 'estimate', status: 'paid', amountCents: 0, depositCents: 4399 }),
    bill('legacy', { kind: 'estimate' }),
  ]
  const options = petChatDetailOptions(month, { groups: [{ platform, entries }] })
  const shared = selectedPetChatDetails(month, options, new Set(entries.map(entry => entry.id)))
  assert.deepEqual(shared.entries, [
    { platform: '玩具店', title: '同款画册', kind: 'installment', status: 'due', amountCents: 1299, installmentIndex: 2, installmentCount: 6 },
    { platform: '玩具店', title: '同款画册', kind: 'estimate', status: 'paid', amountCents: 0, depositCents: 4399 },
    { platform: '玩具店', title: '同款画册', kind: 'estimate', status: 'due', amountCents: 1299, depositCents: 0 },
  ])
  const tagged = { ...shared, deviceId: 'private-device', entries: shared.entries.map(entry => ({ ...entry, id: 'private-id', platformId: 'private-platform', note: 'private-note' })) }
  assert.deepEqual(petChatDetailsPayload(tagged), shared)
})

test('本轮按界面顺序给勾选项编号，明确选择的作废项带状态，本机 ID 留在映射中', () => {
  const entries = [bill('local-a'), bill('local-b', { voided: true }), bill('local-c'), bill('local-d')]
  const options = petChatDetailOptions(month, { groups: [{ platform, entries }] }, true)
  const selected = new Set(['local-c', 'local-b', 'local-a'])
  const snapshot = selectedPetChatOptions(month, options, selected)
  const shared = selectedPetChatDetails(month, options, selected)
  selected.delete('local-a')
  assert.deepEqual(snapshot.map(row => row.id), ['local-a', 'local-b', 'local-c'])
  assert.deepEqual(shared.entries, snapshot.map(row => row.detail))
  assert.deepEqual(shared.entries.map(row => row.voided), [undefined, true, undefined])
  assert.ok(!JSON.stringify(shared).includes('local-'))
  assert.deepEqual(selectedPetChatOptions('2026-12', options, selected), [])
})

test('较大的月度清单仍能预览并选择末尾的明细', () => {
  const entries = Array.from({ length: 512 }, (_, index) => bill('item-' + index, { amountCents: index + 1 }))
  const options = petChatDetailOptions(month, { groups: [{ platform, entries }] })
  assert.equal(options.length, entries.length)
  const shared = selectedPetChatDetails(month, options, new Set(['item-511']))
  assert.equal(shared.entries.length, 1)
  assert.equal(shared.entries[0].amountCents, 512)
})
