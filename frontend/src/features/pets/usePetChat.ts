import { computed, onScopeDispose, ref, toRef } from 'vue'
import { t, type AppLocale } from '../../i18n/index.ts'
import type { ReminderFacts } from '../../integrations/ai/capabilities.ts'
import type { AgentChatInput, RunLedgerAction } from '../../integrations/ai/agentChat.ts'
import type { PetChatMessage } from '../../integrations/ai/deepseek.ts'
import type { PetCharacter } from './catalog.ts'
import { clipCharacterText } from './cardImport.ts'
import { petChatDetailsPayload, type PetChatDetails } from './petChatDetails.ts'
import { openChatHistory } from './chatHistory.ts'
import { chatStorage, type StoredExchange } from './chatStorage.ts'

export const MAX_PET_MESSAGE_LENGTH = 1000
export const MAX_MENU_MESSAGE_LENGTH = 32_768
const MENU_CONTEXT_LENGTH = 131_072

export function forgetPetChats(petId: string) {
  return chatStorage.clear(petId)
}

function messagesFor(exchanges: StoredExchange[], forModel = false): PetChatMessage[] {
  return exchanges.flatMap(({ question, reply, contextReply }) => [
    { role: 'user' as const, content: question },
    { role: 'assistant' as const, content: forModel ? contextReply ?? reply : reply },
  ])
}

async function requestAgent(input: AgentChatInput, signal: AbortSignal, runAction?: RunLedgerAction) {
  const { chatWithAgent } = await import('../../integrations/ai/agentChat.ts')
  return chatWithAgent(input, signal, runAction)
}

export function usePetChat(pet: PetCharacter, month: string, request = requestAgent) {
  return useCharacterChat('pet', pet, month, request)
}

export function usePersonaChat(pet: PetCharacter, month: string, request = requestAgent) {
  return useCharacterChat('persona', pet, month, request)
}

function useCharacterChat(mode: 'pet' | 'persona', pet: PetCharacter, month: string, request: typeof requestAgent) {
  const fullPage = mode === 'persona'
  const opening = clipCharacterText(pet.greetings[0] || '', fullPage ? 8192 : 1000)
  const voiceSample = clipCharacterText(pet.dialogueExample || opening, fullPage ? 8192 : 500)
  const character = {
    name: clipCharacterText(pet.name, 128),
    description: clipCharacterText(pet.description, fullPage ? 16_384 : 2000),
    ...(fullPage && pet.scenario && { scenario: clipCharacterText(pet.scenario, 8192) }),
    voiceSample, ...(opening && opening !== voiceSample ? { opening } : {}),
  }
  return useConversation(mode, month, pet.id, (input, signal, runAction) => request({ ...input, mode, character }, signal, runAction))
}

export function useGeneralChat(month: string, request = requestAgent) {
  return useConversation('general', month, null, (input, signal, runAction) => request({ ...input, mode: 'general' }, signal, runAction))
}

function useConversation(
  mode: AgentChatInput['mode'], month: string, petId: string | null,
  request: (input: Omit<AgentChatInput, 'mode' | 'character'>, signal: AbortSignal, runAction?: RunLedgerAction) => Promise<string>,
) {
  const maxMessageLength = mode === 'pet' ? MAX_PET_MESSAGE_LENGTH : MAX_MENU_MESSAGE_LENGTH
  const maxContextTurns = mode === 'pet' ? 5 : 16
  const history = openChatHistory({ mode, petId, month })
  const { state, newChat, selectChat, deleteChat, retryStorage } = history
  const current = computed(() => history.find(state.selectedId)!)
  const activeConversationId = toRef(state, 'selectedId')
  const conversations = computed(() => state.chats.map((chat, index) => ({
    id: chat.id, number: index + 1,
    title: clipCharacterText((chat.exchanges[0]?.question || chat.draft).trim(), 36).replace(/\s+/g, ' '),
  })).reverse())
  const draft = computed({
    get: () => current.value.draft,
    set: (text: string) => { history.setDraft(state.selectedId, text) },
  })
  const pendingQuestion = ref('')
  const pending = computed(() => pendingQuestion.value !== '')
  const error = ref('')
  const messages = computed(() => {
    const history = messagesFor(current.value.exchanges)
    if (pending.value) history.push({ role: 'user', content: pendingQuestion.value })
    return history
  })
  let active: AbortController | undefined
  let activeThread: number | undefined

  function stop() {
    active?.abort()
    active = undefined
    activeThread = undefined
    pendingQuestion.value = ''
    error.value = ''
  }
  const unsubscribe = history.onInvalidate(id => { if (id === undefined || id === activeThread) stop() })
  onScopeDispose(() => {
    stop()
    unsubscribe()
    history.release()
  })

  async function send(language: AppLocale, facts?: ReminderFacts, details?: PetChatDetails, runAction?: RunLedgerAction): Promise<boolean> {
    const question = draft.value.trim()
    if (!state.ready || active || !question) return false
    const questionLength = Array.from(question).length
    if (questionLength > maxMessageLength || (facts && facts.month !== month)
        || (details && (!facts || details.month !== month || !details.entries.length))) {
      error.value = 'AI_INVALID_INPUT'
      return false
    }
    const attachment = details && petChatDetailsPayload(details)
    const sharedRows = attachment && countSharedRows(attachment)
    const conversation = current.value
    const generation = state.generation
    const threadId = conversation.id
    const recent = conversation.exchanges.slice(-maxContextTurns)
    let remaining = MENU_CONTEXT_LENGTH - questionLength
    let first = recent.length
    while (first > 0) {
      const turn = recent[first - 1]
      if (!canResend(turn, Boolean(facts), sharedRows)) break
      remaining -= Array.from(turn.question).length + Array.from(turn.contextReply ?? turn.reply).length
      if (remaining < 0) break
      first--
    }
    const context = messagesFor(recent.slice(first), true)
    context.push({ role: 'user', content: question })
    const controller = new AbortController()
    const endTurn = history.beginTurn(threadId)
    active = controller
    activeThread = threadId
    pendingQuestion.value = question
    error.value = ''
    const receipts: string[] = []
    const contextReceipts: string[] = []
    const exchangeId = crypto.randomUUID()
    let recorded = false
    function record(reply: string) {
      if (!history.isLive(threadId, generation)) return
      const target = history.find(threadId)!
      const contextReply = contextReceipts.length
        ? clipCharacterText([...new Set(contextReceipts)].join('\n'), 2000) : undefined
      const exchange = { exchangeId, question, reply, sharedSummary: Boolean(facts), sharedRows, contextReply }
      const savedExchange = recorded && target.exchanges.find(item => item.exchangeId === exchangeId)
      if (savedExchange) {
        if (savedExchange.reply === reply && savedExchange.contextReply === contextReply) return
        Object.assign(savedExchange, exchange)
      } else target.exchanges.push(exchange)
      recorded = true
      // Older exchanges stay visible, but their bill details can no longer be sent as context.
      const expired = target.exchanges.at(-maxContextTurns - 1)
      if (expired) delete expired.sharedRows
      if (target.draft.trim() === question) target.draft = ''
      history.enqueue({ type: 'exchange', id: threadId, exchangeId, exchange })
    }
    let wrote = false
    const handleAction: RunLedgerAction | undefined = runAction && (async (name, args, signal) => {
      const result = await runAction(name, args, signal)
      receipts.push(result.message)
      // Error details and the count of changed periods in a full plan belong to the local transcript.
      const action = t('chat.action.' + name)
      if (result.status === 'failed' || result.status === 'unavailable') {
        contextReceipts.push(t('chat.action.failedContext', { action }))
      } else if (result.status === 'partial') {
        contextReceipts.push(t('chat.action.partialContext', { action }))
      } else {
        contextReceipts.push(result.message)
      }
      if (result.status === 'applied' || result.status === 'partial' || result.status === 'saved_pending_refresh') wrote = true
      // A confirmed write can finish after this window has closed or switched threads.
      if (wrote && controller.signal.aborted) record(receipts.join('\n'))
      return result
    })
    try {
      const response = await request({
        messages: context, language,
        ...(facts && { facts: { month, balanceCents: facts.balanceCents, dueCents: facts.dueCents, warningFloorCents: facts.warningFloorCents } }),
        ...(attachment && { details: attachment }),
      }, controller.signal, handleAction)
      if (wrote) {
        record(receipts.join('\n'))
        return true
      }
      if (controller.signal.aborted || !history.isLive(threadId, generation) || threadId !== state.selectedId) return false
      if (typeof response !== 'string' || !response.trim()) throw new Error('AI_BAD_RESPONSE')
      record(response.trim())
      return true
    } catch (cause) {
      if (wrote) {
        record(receipts.join('\n'))
        return true
      }
      if (!controller.signal.aborted) error.value = cause instanceof Error ? cause.message : 'AI_UNAVAILABLE'
      return false
    } finally {
      endTurn()
      if (active === controller) {
        active = undefined
        activeThread = undefined
        pendingQuestion.value = ''
      }
    }
  }

  return { conversations, activeConversationId, newChat, selectChat, deleteChat, retryStorage,
    ready: toRef(state, 'ready'), scopeGeneration: toRef(state, 'generation'), storageError: toRef(state, 'storageError'),
    maxMessageLength, draft, messages, pending, error, send, stop }
}

// The same purchase can appear twice. Removing either copy should also withhold earlier replies about the pair.
function countSharedRows(details: PetChatDetails): Map<string, number> {
  const counts = new Map<string, number>()
  for (const row of details.entries) {
    const key = JSON.stringify(row)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

function canResend(turn: StoredExchange, shareSummary: boolean, rows?: Map<string, number>): boolean {
  if (turn.sharedSummary && !shareSummary) return false
  if (!turn.sharedRows) return true
  if (!rows) return false
  for (const [key, count] of turn.sharedRows) {
    if ((rows.get(key) ?? 0) < count) return false
  }
  return true
}
