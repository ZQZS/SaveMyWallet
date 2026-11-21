import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

// Run against a disposable PostgreSQL instance and two dedicated, empty ledgers.
const { SMW_TEST_URL: base, SMW_TEST_TOKEN_A: primary, SMW_TEST_TOKEN_B: secondary } = process.env

async function request(path, { token = primary, method = 'GET', body, key } = {}) {
  const headers = {}
  if (token) headers.Authorization = 'Bearer ' + token
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (key) headers['Idempotency-Key'] = key
  const response = await fetch(new URL(path, base), {
    method, headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
  })
  const text = await response.text()
  return { status: response.status, data: text ? JSON.parse(text) : null }
}

function success(result) {
  assert.ok(result.status >= 200 && result.status < 300,
    'HTTP ' + result.status + ': ' + JSON.stringify(result.data))
  return result.data
}

function change(kind, id, value, previous) {
  return { kind, id, baseVersion: previous?.version ?? null, before: previous?.value ?? null, after: value }
}

function operation(changes) {
  return { operationId: randomUUID(), changes }
}

const push = (op, token = primary) => request('/sync/push', { token, method: 'POST', body: op })
const bootstrap = async (token = primary) => success(await request('/sync/bootstrap', { token }))

function setInstallmentVoided(id, voided, key) {
  return request('/bills/' + encodeURIComponent(id) + '/installment/voided', {
    method: 'PUT', body: { voided }, key,
  })
}

function entry(platformId, kind, title) {
  return {
    id: randomUUID(), platformId, title, month: '2026-12', amountCents: 30000,
    status: kind === 'estimate' ? 'estimated' : 'due', kind, installmentIndex: null, installmentCount: null,
  }
}

test('two isolated ledgers sync through the running PostgreSQL API', async t => {
  assert.ok(base && primary && secondary, 'Set SMW_TEST_URL, SMW_TEST_TOKEN_A and SMW_TEST_TOKEN_B.')
  assert.notEqual(primary, secondary, 'Use two different test ledgers.')
  const first = await bootstrap()
  const other = await bootstrap(secondary)
  assert.notEqual(first.ledgerId, other.ledgerId)
  for (const ledger of [first, other]) {
    assert.deepEqual(ledger.records, [], 'Use two empty, disposable ledgers.')
    assert.equal(ledger.cursor, 0)
  }
  assert.equal((await request('/sync/bootstrap', { token: null })).status, 401)
  assert.equal((await request('/ledger', { token: 'invalid-test-credential' })).status, 401)

  const platform = success(await request('/platforms', { method: 'POST', body: { name: '测试平台' } }))
  assert.ok(platform.id)
  const platformId = platform.id

  await t.test('committed request with a lost acknowledgement creates twelve stable installments exactly once', async () => {
    const installmentId = randomUUID().replaceAll('-', '')
    const installments = Array.from({ length: 12 }, (_, i) => {
      const value = { ...entry(platformId, 'installment', '离线分期'), amountCents: 12800,
        month: i ? '2027-' + String(i).padStart(2, '0') : '2026-12', installmentId, installmentIndex: i + 1, installmentCount: 12 }
      return change('entry', value.id, value)
    })
    const op = operation(installments)
    const firstAck = success(await push(op))
    const cursor = (await bootstrap()).cursor
    // The sender can lose the response after the transaction commits. Resend the identical operation.
    const retries = await Promise.all([push(op), push(op)])
    for (const retry of retries) assert.deepEqual(success(retry), firstAck)
    assert.equal((await bootstrap()).cursor, cursor)
    const entries = success(await request('/ledger')).entries
    assert.deepEqual(entries.map(e => e.id).sort(), installments.map(c => c.id).sort())
    assert.equal(entries.reduce((sum, e) => sum + e.amountCents, 0), 12 * 12800)
    const changedRequest = structuredClone(op)
    changedRequest.changes[0].after.amountCents++
    assert.equal((await push(changedRequest)).status, 409)
  })

  for (const [difference, choice] of [['amount', 'server'], ['month', 'local'], ['both', 'local']]) {
    await t.test('offline confirmations differing in ' + difference + ': choose ' + choice, async () => {
      const estimated = entry(platformId, 'estimate', '手办补款')
      const created = success(await push(operation([change('entry', estimated.id, estimated)]))).records[0]
      const baseCursor = (await bootstrap()).cursor
      const windows = { ...estimated, amountCents: 32000, status: 'due' }
      const android = { ...windows,
        month: difference === 'amount' ? windows.month : '2027-01',
        amountCents: difference === 'month' ? windows.amountCents : 35000,
      }
      const candidates = [windows, android]
      const results = await Promise.all(candidates.map(value => push(operation([change('entry', estimated.id, value, created)]))))
      const winner = results.findIndex(r => r.status === 200)
      assert.notEqual(winner, -1)
      const loser = 1 - winner
      const conflict = results[loser]
      assert.equal(conflict.status, 409)
      assert.equal(conflict.data.code, 'conflict')
      assert.equal(conflict.data.records.length, 1)
      const current = conflict.data.records[0]
      assert.deepEqual(current.value, candidates[winner])
      const chosen = candidates[choice === 'server' ? winner : loser]
      if (choice === 'local') {
        success(await push(operation([change('entry', estimated.id, chosen, current)])))
      }
      const rows = success(await request('/ledger')).entries.filter(e => e.id === estimated.id)
      assert.deepEqual(rows, [chosen])
      const pulled = success(await request('/sync/pull?cursor=' + baseCursor))
      assert.ok(pulled.cursor > baseCursor)
      assert.deepEqual(pulled.records.filter(r => r.id === estimated.id).at(-1).value, chosen)
      const caughtUp = success(await request('/sync/pull?cursor=' + pulled.cursor))
      assert.equal(caughtUp.hasMore, false)
      assert.deepEqual(caughtUp.records, [])
    })
  }

  await t.test('an invalid transaction rolls back every change', async () => {
    const good = entry(platformId, 'single', '事务检查')
    const bad = { ...entry(platformId, 'single', '金额非法'), amountCents: -1 }
    const before = await bootstrap()
    const failed = await push(operation([change('entry', good.id, good), change('entry', bad.id, bad)]))
    assert.ok(failed.status >= 400 && failed.status < 500)
    assert.deepEqual(await bootstrap(), before)
  })

  await t.test('typed sync changes reject invalid shapes atomically and distinguish replay from a stale baseline', async () => {
    const value = entry(platformId, 'single', '同步字段校验')
    const good = entry(platformId, 'single', '同批有效记录')
    const baseline = await bootstrap()
    for (const fields of [
      { installmentIndex: undefined }, { extra: true }, { amountCents: String(value.amountCents) },
      { installmentId: null }, { depositCents: null }, { voided: null },
      { title: undefined, Title: value.title }, { title: null }, { InstallmentId: 'f'.repeat(32) },
      { kind: 'Single' }, { kind: 'debit' }, { kind: 0 }, { status: 'Due' }, { status: 'cancelled' }, { status: 1 },
    ]) {
      const result = await push(operation([change('entry', good.id, good), change('entry', value.id, { ...value, ...fields })]))
      assert.deepEqual([result.status, result.data?.code], [400, 'invalid_request'], JSON.stringify(fields))
    }
    for (const invalid of [
      change('Entry', value.id, value), change(1, value.id, value), change('invalid', value.id, value),
      change('platform', 'p.bad', value), change('setting', 'warningFloorCents', { cents: 1200 }),
      change('override', '2034-05', '0'),
      { ...change('entry', value.id, value), before: undefined },
      { ...change('entry', value.id, value), baseVersion: undefined, BaseVersion: null },
      { ...change('entry', value.id, value), extra: true },
      { ...change('entry', value.id, value), before: { ...value, extra: true } },
    ]) {
      const result = await push(operation([change('entry', good.id, good), invalid]))
      assert.deepEqual([result.status, result.data?.code], [400, 'invalid_request'])
    }
    assert.deepEqual(await bootstrap(), baseline)

    const op = operation([change('entry', value.id, value)])
    const ack = success(await push(op))
    const alteredReplay = structuredClone(op)
    alteredReplay.changes[0].after.amountCents++
    const replay = await push(alteredReplay)
    assert.deepEqual([replay.status, replay.data.code], [409, 'replay_mismatch'])

    const current = ack.records[0]
    const stale = { ...current, value: { ...value, amountCents: value.amountCents + 1 } }
    const conflict = await push(operation([change('entry', value.id, { ...value, status: 'paid' }, stale)]))
    assert.deepEqual([conflict.status, conflict.data.code, conflict.data.records], [409, 'conflict', [current]])
    assert.equal((await bootstrap()).cursor, ack.cursor)
  })

  await t.test('incremental pull resumes across pages after concurrent writes, retaining whole transactions', async () => {
    const baseline = await bootstrap()
    const operations = Array.from({ length: 65 }, () => {
      const entries = [entry(platformId, 'single', '分页记录甲'), entry(platformId, 'single', '分页记录乙')]
      return operation(entries.map(e => change('entry', e.id, e)))
    })
    // Limit open connections but allow commits to interleave on the same ledger.
    for (let i = 0; i < operations.length; i += 8) {
      const replies = await Promise.all(operations.slice(i, i + 8).map(op => push(op)))
      replies.forEach(success)
    }
    const received = new Map()
    let cursor = baseline.cursor
    let pages = 0
    while (true) {
      const page = success(await request('/sync/pull?cursor=' + cursor))
      assert.ok(page.cursor > cursor)
      cursor = page.cursor
      for (const r of page.records) {
        assert.ok(!received.has(r.id), 'each inserted record must appear once')
        received.set(r.id, pages)
      }
      pages++
      if (!page.hasMore) break
    }
    assert.ok(pages >= 2)
    assert.equal(received.size, operations.length * 2)
    for (const op of operations) {
      const [a, b] = op.changes
      assert.ok(received.has(a.id))
      assert.equal(received.get(a.id), received.get(b.id), 'one commit must be applied on one page')
    }
    assert.equal(cursor, (await bootstrap()).cursor)
  })

  await t.test('existing REST adapter preserves estimates, partial payment IDs, budget zero and REST retries', async () => {
    const bill = { platformId, kind: 'installment', title: '在线分期', month: '2026-12', amountCents: 570, installmentCount: 3 }
    const key = randomUUID()
    const calls = await Promise.all([1, 2].map(() => request('/bills', { method: 'POST', body: bill, key })))
    calls.forEach(success)
    const entries = success(await request('/ledger')).entries.filter(e => e.title === bill.title)
    assert.equal(entries.length, 3)
    const estimateInput = { ...bill, kind: 'estimate', title: '预计补款 REST', installmentCount: 1 }
    success(await request('/bills', { method: 'POST', body: estimateInput }))
    const estimate = success(await request('/ledger')).entries.find(e => e.title === estimateInput.title)
    const payment = paid => request('/payments', { method: 'PATCH', body: { ids: [entries[0].id, estimate.id], paid } })
    assert.deepEqual(success(await payment(true)).changedIds, [entries[0].id])
    assert.deepEqual(success(await payment(true)).changedIds, [])
    assert.deepEqual(success(await payment(false)).changedIds, [entries[0].id])
    const amount = 7000
    success(await request('/bills/' + estimate.id + '/confirm', { method: 'POST', body: { title: estimate.title, month: '2027-02', amountCents: amount } }))
    const updated = success(await request('/ledger')).entries.find(e => e.id === estimate.id)
    assert.deepEqual([updated.month, updated.amountCents, updated.status], ['2027-02', amount, 'due'])
    const budget = { defaultSalaryCents: 600000, warningFloorCents: 20000, month: '2027-02', overrideSalaryCents: 0 }
    success(await request('/budget', { method: 'PUT', body: budget }))
    assert.equal(success(await request('/ledger')).salaryOverrides[budget.month], 0)
    success(await request('/budget', { method: 'PUT', body: { ...budget, overrideSalaryCents: null } }))
    assert.equal(Object.hasOwn(success(await request('/ledger')).salaryOverrides, budget.month), false)
  })

  await t.test('REST batch commits reviewed bills once and starts installments in the photographed month', async () => {
    const single = { platformId, kind: 'single', title: '截图单笔', month: '2026-12', amountCents: 500, installmentCount: 1 }
    const partial = { ...single, kind: 'installment', title: '截图剩余分期', installmentIndex: 3, installmentCount: 4 }
    const baseline = await bootstrap()
    const key = randomUUID()
    const save = bills => request('/bills/batch', { method: 'POST', body: bills, key })
    for (const bad of [[], [single, null], [single, { ...single, installmentIndex: 1 }],
      [single, { ...partial, installmentIndex: 0 }], [single, { ...partial, installmentIndex: 5 }],
      [single, { ...partial, month: '1900-01' }], [single, { ...partial, month: '2099-12' }],
      [single, { ...partial, platformId: 'missing-platform' }]]) {
      assert.equal((await save(bad)).status, 400)
    }
    assert.deepEqual(await bootstrap(), baseline)
    const batch = [single, partial]
    const retries = await Promise.all([save(batch), save(batch)])
    for (const response of retries) assert.equal(response.status, 204)
    const page = success(await request('/sync/pull?cursor=' + baseline.cursor))
    assert.equal(page.cursor, baseline.cursor + 1)
    assert.equal(page.records.length, 3)
    const installments = page.records.map(r => r.value).filter(e => e.kind === 'installment')
      .sort((a, b) => a.installmentIndex - b.installmentIndex)
    assert.deepEqual(installments.map(e => [e.month, e.installmentIndex, e.installmentCount, e.amountCents]),
      [['2026-12', 3, 4, 500], ['2027-01', 4, 4, 500]])
    assert.ok(installments[0].installmentId)
    assert.equal(installments[1].installmentId, installments[0].installmentId)
    const conflict = await save([single])
    assert.deepEqual([conflict.status, conflict.data.code], [409, 'replay_mismatch'])
    assert.equal((await bootstrap()).cursor, page.cursor)
  })

  await t.test('REST replays original receipts and shares device platform IDs and single-bill semantics', async () => {
    const platformKey = randomUUID()
    const options = { method: 'POST', key: platformKey, body: { name: 'QA 移动账本' } }
    const platform = success(await request('/platforms', options))
    assert.equal(platform.id, 'p.' + Buffer.from('qa 移动账本').toString('hex'))
    assert.deepEqual(success(await request('/platforms', options)), platform)
    const reuse = await request('/platforms', { ...options, body: { name: 'another platform' } })
    assert.equal(reuse.status, 409)
    assert.equal(reuse.data.code, 'replay_mismatch')
    for (const kind of ['single', 'estimate']) {
      const bill = { kind, platformId: platform.id, title: '兼容性', month: '2026-11', amountCents: 100, installmentCount: 8 }
      const post = { method: 'POST', key: randomUUID(), body: bill }
      assert.equal((await request('/bills', post)).status, 204)
      assert.equal((await request('/bills', post)).status, 204)
    }
    const entries = success(await request('/ledger')).entries.filter(e => e.platformId === platform.id)
    assert.equal(entries.length, 2)
    assert.ok(entries.every(e => e.installmentCount === null && e.installmentIndex === null))
    const single = entries.find(e => e.kind === 'single')
    const mark = { method: 'PATCH', key: randomUUID(), body: { ids: entries.map(e => e.id), paid: true } }
    assert.deepEqual(success(await request('/payments', mark)), { changedIds: [single.id] })
    assert.deepEqual(success(await request('/payments', mark)), { changedIds: [single.id] })
    assert.deepEqual(success(await request('/payments', { ...mark, key: randomUUID() })), { changedIds: [] })
  })

  await t.test('voiding and restoring one installment preserves the paid record, its sibling and retry receipts', async () => {
    const first = { ...entry(platformId, 'installment', '分期作废'), id: '账/单%2F' + randomUUID(),
      status: 'paid', installmentId: randomUUID().replaceAll('-', ''), installmentIndex: 1, installmentCount: 2 }
    const second = { ...first, id: randomUUID(), status: 'due', month: '2027-01', installmentIndex: 2 }
    const created = success(await push(operation([first, second].map(value => change('entry', value.id, value)))))
    const path = '/bills/' + encodeURIComponent(first.id) + '/voided'
    const cancel = { method: 'PUT', body: { voided: true }, key: randomUUID() }
    assert.equal((await request(path, cancel)).status, 204)
    const voided = success(await request('/sync/pull?cursor=' + created.cursor))
    assert.deepEqual(voided.records.map(r => r.value), [{ ...first, voided: true }])
    assert.equal((await request(path, { ...cancel, key: randomUUID() })).status, 204)
    assert.equal((await bootstrap()).cursor, voided.cursor)
    const unpay = await request('/payments', { method: 'PATCH', body: { ids: [first.id], paid: false } })
    assert.deepEqual(success(unpay).changedIds, [])
    const restore = { method: 'PUT', body: { voided: false } }
    assert.equal((await request(path, restore)).status, 204)
    const restored = success(await request('/sync/pull?cursor=' + voided.cursor))
    assert.deepEqual(restored.records.map(r => r.value), [first])
    assert.equal((await request(path, cancel)).status, 204)
    const snapshot = await bootstrap()
    assert.equal(snapshot.cursor, restored.cursor)
    assert.deepEqual(snapshot.records.find(r => r.id === second.id).value, second)
    assert.equal((await request('/bills/' + randomUUID() + '/voided', restore)).status, 404)
  })

  await t.test('a whole purchase changes in one commit and stays separate from an identical purchase', async () => {
    const bill = { platformId, kind: 'installment', title: '同款分期', month: '2026-12', amountCents: 5000, installmentCount: 3 }
    for (let i = 0; i < 2; i++) success(await request('/bills', { method: 'POST', body: bill }))
    const installments = success(await request('/ledger')).entries.filter(e => e.title === bill.title)
    const groups = new Set(installments.map(e => e.installmentId))
    assert.equal(groups.size, 2)
    for (const group of groups) assert.match(group, /^[0-9a-f]{32}$/)
    const periods = installments.filter(e => e.installmentId === installments[0].installmentId)
      .sort((a, b) => a.installmentIndex - b.installmentIndex)
    assert.deepEqual(periods.map(e => e.month), ['2026-12', '2027-01', '2027-02'])
    const ids = periods.map(e => e.id)
    success(await request('/payments', { method: 'PATCH', body: { ids: [ids[0]], paid: true } }))
    success(await request('/bills/' + ids[1] + '/voided', { method: 'PUT', body: { voided: true } }))
    const before = await bootstrap()
    const key = randomUUID()
    const result = success(await setInstallmentVoided(ids[1], true, key))
    assert.deepEqual(result.changedIds, [ids[0], ids[2]])
    const page = success(await request('/sync/pull?cursor=' + before.cursor))
    assert.equal(page.cursor, before.cursor + 1)
    assert.deepEqual(page.records.map(r => r.id).sort(), [...result.changedIds].sort())
    const after = await bootstrap()
    for (const record of before.records) {
      const updated = after.records.find(r => r.id === record.id && r.kind === record.kind)
      if (ids.includes(record.id)) assert.deepEqual(updated.value, { ...record.value, voided: true })
      else assert.deepEqual(updated, record)
    }
    assert.deepEqual(success(await setInstallmentVoided(ids[0], true)).changedIds, [])
    assert.deepEqual(success(await setInstallmentVoided(ids[2], false)).changedIds, ids)
    const restored = await bootstrap()
    assert.equal(restored.cursor, page.cursor + 1)
    assert.deepEqual(restored.records.filter(r => ids.includes(r.id)).map(r => [r.id, r.value.status, r.value.voided]).sort(),
      [[ids[0], 'paid', undefined], [ids[1], 'due', undefined], [ids[2], 'due', undefined]].sort())
    assert.deepEqual(success(await setInstallmentVoided(ids[1], true, key)), result)
    assert.equal((await bootstrap()).cursor, restored.cursor)
  })

  await t.test('installments require a group ID and support whole-series operations with escaped entry IDs', async () => {
    const first = { ...entry(platformId, 'installment', '完整分期'), id: '账/单%2F' + randomUUID(),
      installmentId: randomUUID().replaceAll('-', ''), installmentIndex: 1, installmentCount: 2 }
    const second = { ...first, id: randomUUID(), month: '2027-01', installmentIndex: 2 }
    const add = value => push(operation([change('entry', value.id, value)]))
    const unavailable = async id => {
      const cursor = (await bootstrap()).cursor
      const result = await setInstallmentVoided(id, true)
      assert.equal(result.status, 409)
      assert.equal(result.data.code, 'installment_group_unavailable')
      assert.equal((await bootstrap()).cursor, cursor)
    }
    const ungrouped = { ...first }
    delete ungrouped.installmentId
    const before = await bootstrap()
    assert.equal((await add(ungrouped)).status, 400)
    assert.deepEqual(await bootstrap(), before)
    success(await add(first))
    await unavailable(first.id)
    success(await add(second))
    assert.deepEqual(success(await setInstallmentVoided(first.id, true)).changedIds, [first.id, second.id])
    assert.deepEqual(success(await setInstallmentVoided(second.id, false)).changedIds, [first.id, second.id])
    const single = entry(platformId, 'single', '非分期')
    success(await add(single))
    await unavailable(single.id)
  })

  await t.test('sync accepts immutable lowercase installment IDs only on installment entries', async () => {
    const installment = { ...entry(platformId, 'installment', '分期标识'), installmentIndex: 1, installmentCount: 1 }
    const save = (value, prior) => push(operation([change('entry', value.id, value, prior)]))
    for (const id of [null, 0, '', 'a'.repeat(31), 'A'.repeat(32), 'z'.repeat(32)]) {
      assert.equal((await save({ ...installment, installmentId: id })).status, 400)
    }
    const installmentId = randomUUID().replaceAll('-', '')
    const current = success(await save({ ...installment, installmentId })).records[0]
    assert.equal((await save(installment, current)).status, 400)
    assert.equal((await save({ ...installment, installmentId: 'f'.repeat(32) }, current)).status, 400)
    for (const kind of ['single', 'estimate']) {
      assert.equal((await save({ ...entry(platformId, kind, '非分期标识'), installmentId })).status, 400)
    }
  })

  await t.test('sync enforces a consistent schedule per installment ID across batches while allowing missing periods', async () => {
    const first = { ...entry(platformId, 'installment', '分批同步'), installmentId: randomUUID().replaceAll('-', ''),
      installmentIndex: 1, installmentCount: 2 }
    const second = { ...first, id: randomUUID(), month: '2027-01', installmentIndex: 2 }
    const add = (...rows) => push(operation(rows.map(value => change('entry', value.id, value))))
    const before = await bootstrap()
    for (const bad of [{ ...first, id: randomUUID() }, { ...second, amountCents: second.amountCents + 1 }]) {
      assert.equal((await add(first, bad)).status, 400)
      assert.deepEqual(await bootstrap(), before)
    }
    success(await add(first))
    const incomplete = await setInstallmentVoided(first.id, true)
    assert.equal(incomplete.status, 409)
    assert.equal(incomplete.data.code, 'installment_group_unavailable')
    const partial = await bootstrap()
    const unrelated = entry(platformId, 'single', '应当回滚的明细')
    for (const bad of [{ ...first, id: randomUUID() }, { ...second, month: '2027-02' }]) {
      assert.equal((await add(unrelated, bad)).status, 400)
      assert.deepEqual(await bootstrap(), partial)
    }
    success(await add(second))
    assert.deepEqual(success(await setInstallmentVoided(second.id, true)).changedIds, [first.id, second.id])
  })

  await t.test('snapshots round-trip typed values and preserve zero amounts and versioned deletions', async () => {
    const baseline = await bootstrap()
    const platform = { id: randomUUID(), name: '类型往返测试' }
    const bill = { ...entry(platform.id, 'installment', '快照还款'), installmentId: randomUUID().replaceAll('-', ''),
      installmentCount: 1, installmentIndex: 1 }
    const month = '2034-04'
    const setting = baseline.records.find(r => r.kind === 'setting' && r.id === 'warningFloorCents')
    const op = operation([
      change('entry', bill.id, bill), change('platform', platform.id, platform),
      change('setting', 'warningFloorCents', 12345, setting), change('override', month, 0),
    ])
    const ack = success(await push(op))
    assert.deepEqual(success(await push(op)), ack)
    assert.deepEqual(ack.records.map(r => r.value), [bill, platform, 12345, 0])
    const snapshots = [(await bootstrap()).records, success(await request('/sync/pull?cursor=' + baseline.cursor)).records]
    for (const records of snapshots) {
      for (const record of ack.records)
        assert.deepEqual(records.find(r => r.kind === record.kind && r.id === record.id), record)
    }
    const current = snapshots[0].find(r => r.kind === 'entry' && r.id === bill.id)
    const currentOverride = snapshots[0].find(r => r.kind === 'override' && r.id === month)
    const paid = { ...current.value, status: 'paid' }
    const update = operation([change('entry', bill.id, paid, current), change('override', month, null, currentOverride)])
    const saved = success(await push(update))
    assert.equal(saved.cursor, ack.cursor + 1)
    assert.deepEqual(saved.records.map(r => r.value), [paid, null])
    const tombstone = (await bootstrap()).records.find(r => r.kind === 'override' && r.id === month)
    assert.deepEqual(tombstone, { kind: 'override', id: month, value: null, version: update.operationId })
    assert.equal(Object.hasOwn(success(await request('/ledger')).salaryOverrides, month), false)
    const stale = await push(operation([change('entry', bill.id, bill, current)]))
    assert.deepEqual([stale.status, stale.data.code, stale.data.records], [409, 'conflict', [saved.records[0]]])
    assert.deepEqual(success(await push(update)), saved)
    assert.equal((await bootstrap()).cursor, saved.cursor)
  })

  await t.test('voided estimates survive sync, reject confirmation, and conflict with an offline edit', async () => {
    const estimate = entry(platformId, 'estimate', '作废预估')
    const created = success(await push(operation([change('entry', estimate.id, estimate)]))).records[0]
    const edit = (after, before) => push(operation([change('entry', estimate.id, after, before)]))
    for (const value of [false, null, 'true']) {
      assert.equal((await edit({ ...estimate, voided: value }, created)).status, 400)
    }
    const voided = { ...estimate, voided: true }
    const current = success(await edit(voided, created)).records[0]
    const confirmed = { ...estimate, status: 'due', amountCents: 21000 }
    const stale = await edit(confirmed, created)
    assert.equal(stale.status, 409)
    assert.deepEqual(stale.data.records, [current])
    const confirmation = { method: 'POST', body: { title: estimate.title, month: estimate.month, amountCents: 21000 } }
    const path = '/bills/' + estimate.id + '/confirm'
    const failed = await request(path, confirmation)
    assert.equal(failed.status, 409)
    assert.equal(failed.data.code, 'entry_voided')
    assert.equal((await edit({ ...confirmed, voided: true }, current)).status, 400)
    assert.equal((await edit(confirmed, current)).status, 400)
    success(await edit(estimate, current))
    assert.equal((await request(path, confirmation)).status, 204)
  })

  await t.test('REST estimates keep the deposit and book only the unpaid balance', async () => {
    const body = { platformId, kind: 'estimate', installmentCount: 1, title: '定金 REST', month: '2027-01',
      totalCents: 10000, depositCents: 2500, amountCents: 7500 }
    const create = (data, key) => request('/bills', { method: 'POST', body: data, key })
    const lookup = async title => success(await request('/ledger')).entries.find(e => e.title === title)
    const cursor = (await bootstrap()).cursor
    for (const invalid of [
      { amountCents: 7501 }, { depositCents: -1 }, { amountCents: -1, depositCents: 10001 },
      { amountCents: 0, depositCents: 0, totalCents: 0 }, { totalCents: 100000000000, depositCents: 99999992500 },
      { kind: 'single' }, { kind: 'installment' },
    ]) assert.equal((await create({ ...body, ...invalid })).status, 400)
    assert.equal((await bootstrap()).cursor, cursor)

    const key = randomUUID()
    success(await create(body, key))
    success(await create(body, key))
    assert.equal((await create({ ...body, totalCents: 11000, depositCents: 3500 }, key)).status, 409)
    const estimate = await lookup(body.title)
    assert.equal(estimate.amountCents, 7500)
    assert.equal(estimate.depositCents, 2500)
    assert.equal(estimate.status, 'estimated')
    const path = '/bills/' + estimate.id + '/confirm'
    const confirmation = { title: body.title, month: body.month, amountCents: 7000 }
    success(await request(path, { method: 'POST', body: confirmation }))
    success(await request(path, { method: 'POST', body: { ...confirmation, totalCents: 9500, depositCents: 2500 } }))
    assert.equal((await request(path, { method: 'POST', body: { ...confirmation, depositCents: 0 } })).status, 409)
    const updated = await lookup(body.title)
    assert.deepEqual([updated.status, updated.amountCents, updated.depositCents], ['due', 7000, 2500])

    const prepaid = { ...body, title: '定金付清', depositCents: 10000, amountCents: 0 }
    success(await create(prepaid))
    const full = await lookup(prepaid.title)
    assert.equal(full.status, 'estimated')
    success(await request('/bills/' + full.id + '/confirm', { method: 'POST', body: {
      title: full.title, month: full.month, amountCents: 0, totalCents: 10000,
    } }))
    assert.equal((await lookup(full.title)).status, 'paid')
    for (const paid of [true, false]) {
      const payment = success(await request('/payments', { method: 'PATCH', body: { ids: [full.id], paid } }))
      assert.deepEqual(payment.changedIds, [])
    }
  })

  await t.test('sync validates canonical deposits and protects them across voiding, retries and stale writes', async () => {
    const estimate = { ...entry(platformId, 'estimate', '定金同步'), amountCents: 9250, depositCents: 1750 }
    const edit = (after, previous) => push(operation([change('entry', estimate.id, after, previous)]))
    for (const invalid of [
      { depositCents: 0 }, { depositCents: null }, { depositCents: -1 }, { depositCents: 1.5 },
      { kind: 'single', status: 'due' }, { amountCents: 99999999900 }, { totalCents: 11000 },
      { status: 'due', amountCents: 0 },
    ]) assert.equal((await edit({ ...estimate, ...invalid })).status, 400)
    const op = operation([change('entry', estimate.id, estimate)])
    const ack = success(await push(op))
    assert.deepEqual(success(await push(op)), ack)
    const current = ack.records[0]
    const withoutDeposit = { ...estimate }
    delete withoutDeposit.depositCents
    const wrongBefore = { ...current, value: withoutDeposit }
    assert.equal((await edit({ ...withoutDeposit, status: 'due' }, wrongBefore)).status, 409)
    assert.equal((await edit({ ...withoutDeposit, voided: true }, current)).status, 400)
    const voided = success(await edit({ ...estimate, voided: true }, current)).records[0]
    const restored = success(await edit(estimate, voided)).records[0]
    const corrected = { ...withoutDeposit, status: 'due' }
    success(await edit(corrected, restored))
    const pulled = success(await request('/sync/pull?cursor=' + ack.cursor)).records
    assert.deepEqual(pulled.find(record => record.id === estimate.id).value, corrected)
  })

  await t.test('authorization scopes snapshots, changes and operation receipts to the selected ledger', async () => {
    assert.deepEqual(await bootstrap(secondary), other)
    assert.deepEqual(success(await request('/sync/pull?cursor=0', { token: secondary })).records, [])
    const id = randomUUID()
    const op = operation([change('platform', id, { id, name: '独立账本' })])
    success(await push(op))
    const scoped = structuredClone(op)
    scoped.changes[0].after.name = '另一账本'
    success(await push(scoped, secondary))
    assert.deepEqual(success(await request('/ledger', { token: secondary })).platforms, [scoped.changes[0].after])
  })
})
