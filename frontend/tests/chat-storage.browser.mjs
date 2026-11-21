import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const browser = process.env.SMW_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/chromium', '/usr/bin/google-chrome',
].find(existsSync)

// Exercise the real transaction, structured-clone and BroadcastChannel semantics using two separate clients.
async function browserScenario() {
  const { chatStorage: first, compareChatFences } = await import('/chat.js?first')
  const { chatStorage: other } = await import('/chat.js?other')
  const general = { mode: 'general', petId: null, month: '2026-12' }
  const cat = { ...general, mode: 'persona', petId: 'test-cat' }
  const popup = { ...cat, mode: 'pet', month: '2027-01' }
  const unseen = { ...cat, month: '2027-02' }
  function check(value, message) { if (!value) throw Error(message) }
  async function stale(work) {
    try { await work } catch (error) { check(error.message === 'CHAT_CACHE_CHANGED', String(error)); return }
    throw Error('A retired thread or cleared scope accepted a stale write')
  }
  const events = []
  let notify
  const stop = other.subscribe(change => { events.push(change); notify?.(change) })
  try {
    const { fence } = await first.load(general)
    const roleFence = (await first.load(cat)).fence
    const popupFence = (await first.load(popup)).fence
    const unseenFence = (await first.load(unseen)).fence
    const notified = new Promise(resolve => { notify = resolve })
    await first.write(general, fence, { type: 'draft', id: 1, text: 'synthetic question' })
    const event = await notified
    check(event.fence === fence, 'operation broadcast has no matching generation')
    check(event.scope.month === general.month && !JSON.stringify(event).includes('synthetic question'), 'broadcast disclosed the draft')
    const turn = { question: 'synthetic question', reply: 'test reply', sharedSummary: true, sharedRows: new Map([['test row', 2]]) }
    await first.write(general, fence, { type: 'exchange', id: 1, exchangeId: 'turn-a', exchange: turn })
    await other.write(general, fence, { type: 'create', id: 83 })
    await Promise.all([
      first.write(general, fence, { type: 'exchange', id: 1, exchangeId: 'turn-a', exchange: { ...turn, reply: 'final receipt', contextReply: 'local action' } }),
      other.write(general, fence, { type: 'draft', id: 83, text: 'another draft' }),
    ])
    const list = await first.load(general)
    const [a, b] = list.chats
    check(list.selectedId === 83 && a.draft === '' && b.draft === 'another draft', 'selection or draft lost')
    check((await other.loadDraft(general, fence, 83)) === b.draft, 'draft-only reload missed a concurrent edit')
    check(a.exchanges.length === 1 && a.exchanges[0].reply === 'final receipt' && a.exchanges[0].contextReply === 'local action', 'receipts duplicated')
    check(a.exchanges[0].sharedRows.get('test row') === 2, 'lost sharing scope')
    await first.write(general, fence, { type: 'delete', id: 83, replacementId: 84 })
    await stale(other.write(general, fence, { type: 'draft', id: 83, text: 'late typing' }))
    await stale(other.loadDraft(general, fence, 83))
    check((await other.load(general)).selectedId === 1, 'deleting selected thread lost selection')
    await first.write(cat, roleFence, { type: 'draft', id: 1, text: 'role draft' })
    await first.write(popup, popupFence, { type: 'draft', id: 1, text: 'pet draft' })
    for (let i = 0; i < 6; i++) await other.write(popup, popupFence, { type: 'exchange', id: 1, exchangeId: 'row' + i, exchange: turn })
    const petTurns = (await first.load(popup)).chats[0].exchanges
    check(!petTurns[0].sharedRows && petTurns[1].sharedRows.get('test row') === 2, 'old sharing metadata not pruned')
    await first.clear(cat.petId)
    check(!(await other.load(cat)).chats.length && !(await other.load(popup)).chats.length, 'role clear missed a mode or month')
    await stale(other.write(unseen, unseenFence, { type: 'draft', id: 1, text: 'never persisted scope' }))
    check((await other.load(general)).chats[0].exchanges.length === 1, 'role clear removed general chat')
    await other.write(general, fence, { type: 'delete', id: 1, replacementId: 85 })
    check((await first.load(general)).selectedId === 85, 'last deletion should select a fresh thread')
    await stale(first.write(general, fence, { type: 'exchange', id: 1, exchangeId: 'late', exchange: turn }))
    await first.clear()
    await stale(other.write(general, fence, { type: 'draft', id: 85, text: 'old global generation' }))
    const fresh = await other.load(general)
    check(!fresh.chats.length && !fresh.selectedId, 'all clear left visible chats')
    await other.write(general, fresh.fence, { type: 'draft', id: 1, text: 'new' })
    await other.clear(null)
    check(events.some(change => !change.scope && change.petId === null), 'local clear was not announced')
    for (let i = 0; i < 12; i++) await other.clear(cat.petId)
    const oldClear = events.at(-1)
    check(oldClear.fence === (await first.load(cat)).fence && oldClear.petId === cat.petId, 'role clear epoch differs from the stored generation')
    await other.clear()
    const globalClear = events.at(-1)
    check(globalClear.fence === (await first.load(cat)).fence && globalClear.petId === undefined, 'global clear epoch differs from the stored generation')
    check(compareChatFences(globalClear.fence, oldClear.fence) > 0, 'delayed role clear could erase new draft after global clear')
    await other.clear(cat.petId)
    const newerRole = events.at(-1)
    check(compareChatFences(newerRole.fence, globalClear.fence) > 0, 'delayed global clear could erase newer role generation')
    check(compareChatFences(newerRole.fence, event.fence) > 0, 'old operation could supersede reused conversation ID')
  } finally { stop() }
}

test('local chat storage preserves concurrent threads and rejects writes after deletion or clearing', {
  skip: browser ? false : 'Set SMW_TEST_BROWSER to a Chromium executable to run IndexedDB tests',
  timeout: 35_000,
}, async () => {
  const js = stripTypeScriptTypes(await readFile(new URL('../src/features/pets/chatStorage.ts', import.meta.url), 'utf8'))
  const profile = await mkdtemp(path.join(tmpdir(), 'smw-chat-store-'))
  const outcome = Promise.withResolvers()
  const endpoint = createServer(async (request, response) => {
    if (request.url.startsWith('/chat.js')) response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(js)
    else if (request.url === '/report' && request.method === 'POST') {
      const data = []
      for await (const part of request) data.push(part)
      response.end()
      const why = Buffer.concat(data).toString()
      if (why === 'ok') outcome.resolve(); else outcome.reject(Error(why))
    } else if (request.url === '/') {
      const source = '(' + browserScenario.toString() + ')().then(() => "ok", e => e.stack || String(e)).then(body => fetch("/report", {method:"POST", body}))'
      response.writeHead(200, { 'Content-Type': 'text/html' }).end('<script type="module">' + source + '</script>')
    } else response.writeHead(404).end()
  })
  let child
  let exited
  const timeout = setTimeout(() => outcome.reject(Error('Chromium did not report a result')), 25_000)
  try {
    endpoint.listen(0, '127.0.0.1')
    await once(endpoint, 'listening')
    child = spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--disable-background-networking', '--disable-sync', '--disable-extensions',
      ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []),
      '--user-data-dir=' + profile, 'http://127.0.0.1:' + endpoint.address().port], { windowsHide: true, stdio: 'ignore' })
    exited = once(child, 'exit')
    await Promise.race([outcome.promise, exited.then(() => { throw Error('Chromium exited before reporting') })])
  } finally {
    clearTimeout(timeout)
    child?.kill()
    if (exited) await exited.catch(() => {})
    endpoint.closeAllConnections()
    endpoint.close()
    const dir = path.resolve(profile)
    assert.equal(path.dirname(dir), path.resolve(tmpdir()))
    assert.match(path.basename(dir), /^smw-chat-store-[\w-]+$/)
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
