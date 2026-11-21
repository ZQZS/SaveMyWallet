export interface ChatScope {
  mode: 'general' | 'persona' | 'pet'
  petId: string | null
  month: string
}

export interface StoredExchange {
  exchangeId?: string
  question: string
  reply: string
  contextReply?: string
  sharedSummary: boolean
  sharedRows?: Map<string, number>
}

export interface StoredConversation {
  id: number
  draft: string
  exchanges: StoredExchange[]
}

export interface ChatSnapshot {
  chats: StoredConversation[]
  selectedId: number
  fence: string
}

export type ChatOperation =
  | { type: 'draft'; id: number; text: string }
  | { type: 'create' | 'select'; id: number }
  | { type: 'exchange'; id: number; exchangeId: string; exchange: StoredExchange }
  | { type: 'delete'; id: number; replacementId: number }

export interface ChatStorageChange {
  fence?: string
  scope?: ChatScope
  op?: { type: ChatOperation['type']; id: number }
  petId?: string | null
}

interface ScopeRow {
  key: string
  owner: string
  ids: number[]
  selectedId: number
}

interface ThreadRow {
  scope: string
  id: number
  draft: string
  turns: number
}

interface TurnRow {
  scope: string
  id: number
  exchangeId: string
  order: number
  exchange: StoredExchange
}

const databaseName = 'savemywallet.chat'
const stores = ['epochs', 'scopes', 'threads', 'turns']
const changed = () => new Error('CHAT_CACHE_CHANGED')
const unavailable = () => new Error('CHAT_CACHE_STORAGE')
const scopeKey = ({ mode, petId, month }: ChatScope) => JSON.stringify([mode, petId, month])
const ownerKey = (petId: string | null) => JSON.stringify(petId)
const prefix = (...keys: (number | string)[]) => IDBKeyRange.bound(keys, [...keys, []])

const listeners = new Set<(change: ChatStorageChange) => void>()
let database: IDBDatabase | undefined
let opening: Promise<IDBDatabase> | undefined
let channel: BroadcastChannel | undefined

function closeDatabase(db: IDBDatabase) {
  if (database === db) database = undefined
  db.close()
}

function openDatabase(): Promise<IDBDatabase> {
  if (database) return Promise.resolve(database)
  if (opening) return opening
  opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1)
    let blocked = false
    request.onblocked = () => { blocked = true; reject(unavailable()) }
    request.onerror = () => reject(unavailable())
    request.onupgradeneeded = () => {
      const db = request.result
      db.createObjectStore('epochs')
      db.createObjectStore('scopes', { keyPath: 'key' }).createIndex('owner', 'owner')
      db.createObjectStore('threads', { keyPath: ['scope', 'id'] })
      db.createObjectStore('turns', { keyPath: ['scope', 'id', 'exchangeId'] })
        .createIndex('byOrder', ['scope', 'id', 'order'], { unique: true })
    }
    request.onsuccess = () => {
      const db = request.result
      if (blocked) { db.close(); return }
      database = db
      db.onversionchange = () => closeDatabase(db)
      db.onclose = () => { if (database === db) database = undefined }
      resolve(db)
    }
  }).finally(() => { opening = undefined })
  return opening
}

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(unavailable())
  })
}

let activeTransactions = 0

async function transact<T>(mode: IDBTransactionMode, work: (tx: IDBTransaction) => Promise<T>): Promise<T> {
  activeTransactions++
  try {
    const db = await openDatabase()
    const tx = db.transaction(stores, mode)
    let failure: unknown
    const committed = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onabort = () => reject(failure ?? unavailable())
    })
    const value = work(tx).catch(error => {
      failure = error
      try { tx.abort() } catch { /* A failed request may already have aborted the transaction. */ }
      throw error
    })
    return (await Promise.all([value, committed]))[0]
  } catch (error) {
    if (error instanceof Error && error.message === 'CHAT_CACHE_CHANGED') throw error
    throw unavailable()
  } finally {
    activeTransactions--
    if (!activeTransactions && !listeners.size && database) closeDatabase(database)
  }
}

async function fenceFor(tx: IDBTransaction, owner: string): Promise<string> {
  const epochs = tx.objectStore('epochs')
  const [all, role] = await Promise.all([result(epochs.get('*')), result(epochs.get(owner))])
  return JSON.stringify([all ?? 0, role ?? 0])
}

// Globally clearing the cache starts all role counters at zero again. Compare the global epoch first.
export function compareChatFences(a: string, b: string): number {
  const [globalA, roleA]: number[] = JSON.parse(a)
  const [globalB, roleB]: number[] = JSON.parse(b)
  return globalA === globalB ? roleA - roleB : globalA - globalB
}

function emptyThread(scope: string, id: number): ThreadRow {
  return { scope, id, draft: '', turns: 0 }
}

async function load(scope: ChatScope): Promise<ChatSnapshot> {
  const key = scopeKey(scope)
  return transact('readonly', async tx => {
    const [fence, head, threads, turns]: [string, ScopeRow | undefined, ThreadRow[], TurnRow[]] = await Promise.all([
      fenceFor(tx, ownerKey(scope.petId)), result(tx.objectStore('scopes').get(key)),
      result(tx.objectStore('threads').getAll(prefix(key))),
      result(tx.objectStore('turns').index('byOrder').getAll(prefix(key))),
    ])
    if (!head) return { chats: [], selectedId: 0, fence }
    const byId = new Map<number, StoredConversation>()
    for (const thread of threads) byId.set(thread.id, { id: thread.id, draft: thread.draft, exchanges: [] })
    for (const turn of turns) byId.get(turn.id)!.exchanges.push({ ...turn.exchange, exchangeId: turn.exchangeId })
    return { chats: head.ids.map(id => byId.get(id)!), selectedId: head.selectedId, fence }
  })
}

async function loadDraft(scope: ChatScope, fence: string, id: number): Promise<string> {
  return transact('readonly', async tx => {
    const [currentFence, thread]: [string, ThreadRow | undefined] = await Promise.all([
      fenceFor(tx, ownerKey(scope.petId)), result(tx.objectStore('threads').get([scopeKey(scope), id])),
    ])
    if (currentFence !== fence || !thread) throw changed()
    return thread.draft
  })
}

function announce(change: ChatStorageChange) {
  try {
    if (channel) channel.postMessage(change)
    else if (typeof BroadcastChannel !== 'undefined') {
      const out = new BroadcastChannel(databaseName)
      try { out.postMessage(change) } finally { out.close() }
    }
  } catch { /* Storage is authoritative even if another window cannot be notified. */ }
  if (!change.scope) for (const listener of listeners) listener(change)
}

function subscribe(listener: (change: ChatStorageChange) => void): () => void {
  listeners.add(listener)
  if (!channel && typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel(databaseName)
    channel.onmessage = event => { for (const callback of listeners) callback(event.data) }
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size) return
    channel?.close()
    channel = undefined
    if (!activeTransactions && database) closeDatabase(database)
  }
}

async function recordTurn(tx: IDBTransaction, thread: ThreadRow, op: Extract<ChatOperation, { type: 'exchange' }>, limit: number) {
  const { scope, id } = thread
  const turns = tx.objectStore('turns')
  const old: TurnRow | undefined = await result(turns.get([scope, id, op.exchangeId]))
  const { question, reply, contextReply, sharedSummary, sharedRows } = op.exchange
  const exchange: StoredExchange = { question, reply, contextReply, sharedSummary }
  if (sharedRows && (!old || old.order > thread.turns - limit)) exchange.sharedRows = new Map(sharedRows)
  const order = old?.order ?? ++thread.turns
  turns.put({ scope, id, exchangeId: op.exchangeId, order, exchange })
  if (!old && order > limit) {
    const expired: TurnRow | undefined = await result(turns.index('byOrder').get([scope, id, order - limit]))
    if (expired?.exchange.sharedRows) {
      delete expired.exchange.sharedRows
      turns.put(expired)
    }
  }
  if (!old && thread.draft.trim() === question) thread.draft = ''
  tx.objectStore('threads').put(thread)
}

async function write(scope: ChatScope, fence: string, op: ChatOperation): Promise<void> {
  const key = scopeKey(scope)
  const owner = ownerKey(scope.petId)
  await transact('readwrite', async tx => {
    const heads = tx.objectStore('scopes')
    const threads = tx.objectStore('threads')
    if (await fenceFor(tx, owner) !== fence) throw changed()
    const previous: ScopeRow | undefined = await result(heads.get(key))
    const head: ScopeRow = previous ?? { key, owner, ids: [1], selectedId: 1 }
    if (!previous) {
      threads.add(emptyThread(key, 1))
      heads.add(head)
    }
    if (op.type === 'create') {
      if (head.ids.includes(op.id)) throw changed()
      threads.add(emptyThread(key, op.id))
      head.ids.push(op.id)
      head.selectedId = op.id
      heads.put(head)
      return
    }
    const index = head.ids.indexOf(op.id)
    if (index < 0) throw changed()
    if (op.type === 'select') {
      head.selectedId = op.id
      heads.put(head)
    } else if (op.type === 'delete') {
      tx.objectStore('turns').delete(prefix(key, op.id))
      threads.delete([key, op.id])
      head.ids.splice(index, 1)
      if (!head.ids.length) {
        if (op.replacementId === op.id || op.replacementId === 1) throw changed()
        threads.add(emptyThread(key, op.replacementId))
        head.ids.push(op.replacementId)
      }
      if (head.selectedId === op.id) head.selectedId = head.ids[Math.max(0, index - 1)]
      heads.put(head)
    } else {
      const thread: ThreadRow | undefined = await result(threads.get([key, op.id]))
      if (!thread) throw changed()
      if (op.type === 'draft') {
        thread.draft = op.text
        threads.put(thread)
      } else if (op.type === 'exchange') {
        await recordTurn(tx, thread, op, scope.mode === 'pet' ? 5 : 16)
      }
    }
  })
  announce({ scope, op: { type: op.type, id: op.id }, fence })
}

async function clear(petId?: string | null): Promise<void> {
  const fence = await transact('readwrite', async tx => {
    const epochs = tx.objectStore('epochs')
    const owner = petId === undefined ? '*' : ownerKey(petId)
    const next = ((await result(epochs.get(owner))) ?? 0) + 1
    if (petId === undefined) {
      for (const name of stores) tx.objectStore(name).clear()
    } else {
      const heads = tx.objectStore('scopes')
      const keys = await result(heads.index('owner').getAllKeys(owner)) as string[]
      for (const key of keys) {
        tx.objectStore('threads').delete(prefix(key))
        tx.objectStore('turns').delete(prefix(key))
        heads.delete(key)
      }
    }
    // Advance even for a previously empty scope: a pending first message can belong to the erased generation.
    epochs.put(next, owner)
    if (petId === undefined) return JSON.stringify([next, 0])
    return JSON.stringify([await result(epochs.get('*')) ?? 0, next])
  })
  announce({ petId, fence })
}

export const chatStorage = { load, loadDraft, write, clear, subscribe }
