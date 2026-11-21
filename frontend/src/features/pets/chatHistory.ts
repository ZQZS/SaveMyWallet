import { reactive } from 'vue'
import { chatStorage, compareChatFences, type ChatOperation, type ChatScope, type ChatSnapshot, type StoredConversation } from './chatStorage.ts'

function emptyChat(id: number): StoredConversation {
  return { id, draft: '', exchanges: [] }
}

function freshId() {
  const [high, low] = crypto.getRandomValues(new Uint32Array(2))
  return 2 + (high & 0xfffff) * 0x100000000 + low
}

type QueuedWrite = { op: ChatOperation; finish?: (success: boolean) => void }
const histories = new Map<string, ReturnType<typeof createHistory>>()

export function openChatHistory(scope: ChatScope) {
  const key = JSON.stringify([scope.mode, scope.petId, scope.month])
  let history = histories.get(key)
  if (!history) {
    history = createHistory(scope, () => { if (histories.get(key) === history) histories.delete(key) })
    histories.set(key, history)
  }
  history.retain()
  return history
}

export async function flushChatHistory() {
  await Promise.all(Array.from(histories.values(), history => history.flush()))
}

function createHistory(scope: ChatScope, dispose: () => void) {
  const state = reactive({
    chats: [emptyChat(1)], selectedId: 1, ready: false, storageError: '', generation: 0,
  })
  const invalidations = new Set<(id?: number) => void>()
  const flights = new Map<number, number>()
  const deleting = new Set<number>()
  const writes: QueuedWrite[] = []
  const remoteDrafts = new Set<number>()
  let users = 0
  let unsubscribe: (() => void) | undefined
  let fence: string | undefined
  let refresh = true
  let running: Promise<void> | undefined
  const find = (id: number) => state.chats.find(chat => chat.id === id)

  function onResume() {
    if (document.visibilityState !== 'visible') return
    refresh = true
    void start()
  }

  function releaseIfIdle() {
    if (!users && !flights.size && !writes.length && !running) {
      unsubscribe?.()
      unsubscribe = undefined
      if (typeof window !== 'undefined') {
        window.removeEventListener('pageshow', onResume)
        window.removeEventListener('focus', onResume)
        document.removeEventListener('visibilitychange', onResume)
      }
      dispose()
    }
  }

  function invalidate(id?: number) {
    for (const callback of invalidations) callback(id)
  }

  function clearState() {
    state.generation++
    invalidate()
    for (const write of writes.splice(0)) write.finish?.(false)
    deleting.clear()
    remoteDrafts.clear()
    state.chats = [emptyChat(1)]
    state.selectedId = 1
    state.ready = false
    state.storageError = ''
    fence = undefined
    refresh = true
  }

  function install(snapshot: ChatSnapshot) {
    const chats = snapshot.chats.length ? snapshot.chats : [emptyChat(1)]
    // Restore the last saved selection on open. An already open window keeps its own thread.
    const selected = state.ready && chats.some(chat => chat.id === state.selectedId)
      ? state.selectedId : snapshot.selectedId || chats[0].id
    if (state.selectedId !== selected) invalidate(state.selectedId)
    // Keep conversation identities stable for requests completed after an external draft edit.
    state.chats = chats.map(saved => {
      const existing = find(saved.id)
      if (!existing) return saved
      Object.assign(existing, saved)
      return existing
    })
    for (const id of deleting) if (!find(id)) deleting.delete(id)
    state.selectedId = selected
    state.ready = true
    fence = snapshot.fence
  }

  function applyDeletion(id: number, replacementId: number) {
    const index = state.chats.findIndex(chat => chat.id === id)
    if (index < 0) return
    state.chats.splice(index, 1)
    if (!state.chats.length) state.chats.push(emptyChat(replacementId))
    if (state.selectedId === id) state.selectedId = state.chats[Math.max(0, index - 1)].id
  }

  async function drain() {
    while (refresh || writes.length || remoteDrafts.size) {
      if (fence !== undefined && !refresh && !writes.length && remoteDrafts.size) {
        const id = remoteDrafts.values().next().value!
        remoteDrafts.delete(id)
        const generation = state.generation
        try {
          const text = await chatStorage.loadDraft(scope, fence, id)
          const thread = find(id)
          if (generation === state.generation && thread && !writes.some(write => write.op.id === id)) thread.draft = text
        } catch (cause) {
          if (generation !== state.generation) continue
          if (cause instanceof Error && cause.message === 'CHAT_CACHE_CHANGED') refresh = true
          else { state.storageError = 'CHAT_CACHE_STORAGE'; return }
        }
        continue
      }
      if (fence === undefined || !writes.length) {
        refresh = false
        remoteDrafts.clear()
        const generation = state.generation
        try {
          const snapshot = await chatStorage.load(scope)
          if (generation !== state.generation) continue
          if (fence !== undefined && fence !== snapshot.fence) clearState()
          // Edits made while a background read was running must be committed before repainting.
          if (writes.length && state.ready) { refresh = true; continue }
          install(snapshot)
        } catch {
          if (generation !== state.generation) continue
          state.storageError = 'CHAT_CACHE_STORAGE'
          return
        }
        continue
      }
      const head = writes[0]
      try {
        await chatStorage.write(scope, fence, head.op)
        if (writes[0] !== head) continue
        writes.shift()
        if (head.op.type === 'delete') applyDeletion(head.op.id, head.op.replacementId)
        head.finish?.(true)
      } catch (cause) {
        if (writes[0] !== head) continue
        if (cause instanceof Error && cause.message === 'CHAT_CACHE_CHANGED') {
          // A concurrent clear or deletion wins over stale work. Other threads' writes
          // still carry the original fence until they commit or are rejected themselves.
          writes.shift()
          head.finish?.(false)
          refresh = true
          continue
        }
        state.storageError = 'CHAT_CACHE_STORAGE'
        // Keep recoverable drafts and replies for a retry. A failed destructive action
        // must be requested again explicitly, even if an earlier queued write failed.
        for (let i = writes.length - 1; i >= 0; i--) {
          if (writes[i].op.type === 'delete') writes.splice(i, 1)[0].finish?.(false)
        }
        return
      }
    }
    state.storageError = ''
  }

  function start() {
    if (!running) running = drain().finally(() => {
      running = undefined
      // A change can land after drain resolves and before this cleanup microtask.
      if (!state.storageError && (refresh || writes.length || remoteDrafts.size)) void start()
      else releaseIfIdle()
    })
    return running
  }

  async function flush() {
    if (!writes.length) return
    await start()
    if (writes.length && state.storageError) throw new Error(state.storageError)
    if (writes.length) await flush()
  }

  function enqueue(op: ChatOperation, finish?: QueuedWrite['finish']) {
    const previous = writes.at(-1)
    if (op.type === 'draft' && previous && previous !== writes[0]
      && previous.op.type === 'draft' && previous.op.id === op.id) previous.op = op
    else writes.push({ op, finish })
    void start()
  }

  function retain() {
    users++
    if (!unsubscribe && typeof window !== 'undefined') {
      window.addEventListener('pageshow', onResume)
      window.addEventListener('focus', onResume)
      document.addEventListener('visibilitychange', onResume)
    }
    unsubscribe ??= chatStorage.subscribe(change => {
      const age = change.fence && fence ? compareChatFences(change.fence, fence) : undefined
      if (!change.scope) {
        if (change.petId !== undefined && change.petId !== scope.petId) return
        if (age !== undefined && age <= 0) return
        clearState()
      } else {
        if (change.scope.mode !== scope.mode || change.scope.month !== scope.month || change.scope.petId !== scope.petId) return
        if (age !== undefined && age < 0) return
        if (age !== undefined && age > 0) clearState()
        else if (change.op?.type === 'select' && state.ready) return
        else if (change.op?.type === 'draft' && state.ready && find(change.op.id)) remoteDrafts.add(change.op.id)
        else {
          if (change.op?.type === 'delete') {
            deleting.add(change.op.id)
            invalidate(change.op.id)
          }
          refresh = true
        }
      }
      void start()
    })
    if (!state.ready) refresh = true
    void start()
  }

  function beginTurn(id: number) {
    flights.set(id, (flights.get(id) ?? 0) + 1)
    return () => {
      const remaining = (flights.get(id) ?? 1) - 1
      if (remaining) flights.set(id, remaining)
      else flights.delete(id)
      releaseIfIdle()
    }
  }

  function newChat() {
    if (!state.ready) return
    const empty = state.chats.find(chat => !chat.draft && !chat.exchanges.length && !flights.has(chat.id) && !deleting.has(chat.id))
    if (empty) { selectChat(empty.id); return }
    const id = freshId()
    invalidate(state.selectedId)
    state.chats.push(emptyChat(id))
    state.selectedId = id
    enqueue({ type: 'create', id })
  }

  function selectChat(id: number) {
    if (!state.ready || state.selectedId === id || !find(id) || deleting.has(id)) return
    invalidate(state.selectedId)
    state.selectedId = id
    enqueue({ type: 'select', id })
  }

  async function deleteChat(id: number) {
    if (!state.ready || !find(id) || deleting.has(id)) return false
    deleting.add(id)
    invalidate(id)
    try {
      return await new Promise<boolean>(finish => enqueue({ type: 'delete', id, replacementId: freshId() }, finish))
    } finally { deleting.delete(id) }
  }

  function setDraft(id: number, text: string) {
    const chat = find(id)
    if (!state.ready || !chat || deleting.has(id) || chat.draft === text) return
    chat.draft = text
    enqueue({ type: 'draft', id, text })
  }

  async function retryStorage() {
    refresh = true
    await start()
  }

  return {
    state, find, enqueue, beginTurn, newChat, selectChat, deleteChat, setDraft, retryStorage, flush, retain,
    isLive: (id: number, generation: number) => state.generation === generation && !deleting.has(id) && Boolean(find(id)),
    release() { users--; releaseIfIdle() },
    onInvalidate(callback: (id?: number) => void) {
      invalidations.add(callback)
      return () => invalidations.delete(callback)
    },
  }
}
