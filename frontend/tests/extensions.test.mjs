import assert from 'node:assert/strict'
import test from 'node:test'
import { createApiClient, createApiLedgerRepository } from '../src/integrations/api/ledgerApi.ts'
import { createWasmCalculatorLoader } from '../src/integrations/wasm/monthlyCalculator.ts'
import { summarize } from '../src/domain/ledger.ts'

test('远端仓库通过注入的 Axios 实例读写，撤销仅使用服务端实际改动的 ID', async () => {
  const snapshot = { platforms: [], entries: [], settings: { defaultSalaryCents: 0, warningFloorCents: 0 }, salaryOverrides: {} }
  const responses = [snapshot, { id: 'p1' }, null, null, null, null, { changedIds: ['b/1', 'b/2'] }, { changedIds: ['b2'] }, null]
  const calls = []
  const client = createApiClient('https://ledger.example.invalid/v1')
  client.defaults.adapter = async config => {
    calls.push([config.method, config.url, config.data && JSON.parse(config.data)])
    return { data: responses.shift(), status: 200, statusText: 'OK', headers: {}, config }
  }
  const repository = createApiLedgerRepository(client)
  const bill = { platformId: 'p1', title: '样例', month: '2026-11', amountCents: 2980, kind: 'single', installmentCount: 1 }
  const changes = { title: '补款', month: '2026-12', amountCents: 3200 }
  const budget = { month: '2026-12', defaultSalaryCents: 800000, warningFloorCents: 0, overrideSalaryCents: null }

  assert.deepEqual(await repository.load(), snapshot)
  assert.equal(await repository.createPlatform('自定义平台'), 'p1')
  await repository.createBill(bill)
  await repository.confirmEstimate({ id: 'b/2', ...changes })
  await repository.setEntryVoided('b/2', true)
  await repository.setEntryVoided('b/2', false)
  assert.deepEqual(await repository.setInstallmentVoided('b/2', true), ['b/1', 'b/2'])
  assert.deepEqual(await repository.setPayment(['b1', 'b2'], true), ['b2'])
  await repository.saveBudget(budget)
  assert.deepEqual(calls, [
    ['get', '/ledger', undefined],
    ['post', '/platforms', { name: '自定义平台' }],
    ['post', '/bills', bill],
    ['post', '/bills/b%2F2/confirm', changes],
    ['put', '/bills/b%2F2/voided', { voided: true }],
    ['put', '/bills/b%2F2/voided', { voided: false }],
    ['put', '/bills/b%2F2/installment/voided', { voided: true }],
    ['patch', '/payments', { ids: ['b1', 'b2'], paid: true }],
    ['put', '/budget', budget],
  ])
})

test('在线分期重试可复用提交 ID，两次独立的新消费即使内容相同也有各自 ID', async () => {
  const keys = []
  const client = createApiClient('https://ledger.example.invalid')
  client.defaults.adapter = async config => {
    keys.push(config.headers.get('Idempotency-Key'))
    return { data: null, status: 204, statusText: 'OK', headers: {}, config }
  }
  const repo = createApiLedgerRepository(client)
  const bill = { platformId: 'p1', title: '分期', month: '2026-11', amountCents: 100, kind: 'installment', installmentCount: 12 }
  const operationId = crypto.randomUUID()
  await repo.createBill(bill, operationId)
  await repo.createBill(bill, operationId)
  await repo.createBill(bill)
  await repo.createBill(bill)
  assert.deepEqual(keys.slice(0, 2), [operationId, operationId])
  assert.equal(new Set(keys).size, 3)
})

test('WASM 加载器按需初始化，复用并发请求，失败后可重试', async () => {
  let imports = 0
  let initializations = 0
  const load = createWasmCalculatorLoader(async () => {
    imports++
    return {
      async default() {
        if (++initializations === 1) throw new Error('初始化失败')
      },
      summarize,
    }
  })
  assert.equal(imports, 0)
  const attempt = load()
  assert.equal(load(), attempt)
  await assert.rejects(attempt, /初始化失败/)
  const [first, second] = await Promise.all([load(), load()])
  assert.equal(first, summarize)
  assert.equal(second, first)
  assert.equal(await load(), first)
  assert.equal(imports, 2)
  assert.equal(initializations, 2)
})
