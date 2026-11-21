import { computed, onScopeDispose, reactive, ref } from 'vue'
import { t, type AppLocale } from '../../i18n/index.ts'
import type { ReminderFacts } from '../../integrations/ai/capabilities.ts'
import type { AgentChatInput, RunLedgerAction } from '../../integrations/ai/agentChat.ts'
import type { PetChatMessage } from '../../integrations/ai/deepseek.ts'
import type { PetCharacter } from './catalog.ts'
import { clipCharacterText } from './cardImport.ts'
import { petChatDetailsPayload, type PetChatDetails } from './petChatDetails.ts'

export const MAX_PET_MESSAGE_LENGTH = 1000
export const MAX_MENU_MESSAGE_LENGTH = 32_768
const MENU_CONTEXT_LENGTH = 131_072

interface Exchange {
  question: string
  reply: string
  contextReply?: string
  sharedSummary: boolean
  sharedRows?: Map<string, number>
}

interface Conversation {
  id: number
  draft: string
  exchanges: Exchange[]
  inFlight: number
}

function emptyChat(id: number): Conversation {
  return { id, draft: '', exchanges: [], inFlight: 0 }
}

function unusedChat(chat: Conversation) {
  return !chat.draft && !chat.exchanges.length && !chat.inFlight
}

function newChatList(petId: string | null) {
  return reactive({ petId, chats: [emptyChat(1)], selectedIndex: 0, openViews: 0 })
}

// A pet's modal and its full-page chat have independent histories and sharing scopes.
const chatLists = new Map<string, ReturnType<typeof newChatList>>()

export function forgetPetChats(petId: string) {
  for (const [key, list] of chatLists) {
    if (list.petId === petId) chatLists.delete(key)
  }
}

function messagesFor(exchanges: Exchange[], forModel = false): PetChatMessage[] {
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
  const key = JSON.stringify([mode, petId, month])
  const maxMessageLength = mode === 'pet' ? MAX_PET_MESSAGE_LENGTH : MAX_MENU_MESSAGE_LENGTH
  const maxContextTurns = mode === 'pet' ? 5 : 16
  const list = chatLists.get(key) ?? newChatList(petId)
  list.openViews++
  chatLists.set(key, list)
  const current = computed(() => list.chats[list.selectedIndex])
  const activeConversationId = computed(() => current.value.id)
  const conversations = computed(() => list.chats.map(chat => ({
    id: chat.id,
    title: clipCharacterText((chat.exchanges[0]?.question || chat.draft).trim(), 36).replace(/\s+/g, ' '),
  })).reverse())
  const draft = computed({
    get: () => current.value.draft,
    set: (text: string) => { current.value.draft = text },
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

  function stop() {
    active?.abort()
    active = undefined
    pendingQuestion.value = ''
    error.value = ''
  }
  function releaseEmptyList() {
    if (!list.openViews && list.chats.every(unusedChat) && chatLists.get(key) === list) chatLists.delete(key)
  }
  onScopeDispose(() => {
    stop()
    list.openViews--
    releaseEmptyList()
  })

  function newChat() {
    stop()
    const emptyIndex = list.chats.findIndex(unusedChat)
    if (emptyIndex >= 0) {
      list.selectedIndex = emptyIndex
      return
    }
    list.chats.push(emptyChat(list.chats.length + 1))
    list.selectedIndex = list.chats.length - 1
  }

  function selectChat(id: number) {
    const index = list.chats.findIndex(chat => chat.id === id)
    if (index < 0 || index === list.selectedIndex) return
    stop()
    list.selectedIndex = index
  }

  async function send(language: AppLocale, facts?: ReminderFacts, details?: PetChatDetails, runAction?: RunLedgerAction): Promise<boolean> {
    const question = draft.value.trim()
    if (active || !question) return false
    const questionLength = Array.from(question).length
    if (questionLength > maxMessageLength || (facts && facts.month !== month)
        || (details && (!facts || details.month !== month || !details.entries.length))) {
      error.value = 'AI_INVALID_INPUT'
      return false
    }
    const attachment = details && petChatDetailsPayload(details)
    const sharedRows = attachment && countSharedRows(attachment)
    const conversation = current.value
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
    conversation.inFlight++
    active = controller
    pendingQuestion.value = question
    error.value = ''
    const receipts: string[] = []
    const contextReceipts: string[] = []
    let savedExchange: Exchange | undefined
    function record(reply: string) {
      const contextReply = contextReceipts.length
        ? clipCharacterText([...new Set(contextReceipts)].join('\n'), 2000) : undefined
      if (savedExchange) {
        savedExchange.reply = reply
        savedExchange.contextReply = contextReply
        return
      }
      conversation.exchanges.push({ question, reply, sharedSummary: Boolean(facts), sharedRows,
        contextReply })
      savedExchange = conversation.exchanges.at(-1)
      // Older exchanges stay visible, but their bill details can no longer be sent as context.
      const expired = conversation.exchanges.at(-maxContextTurns - 1)
      if (expired) delete expired.sharedRows
      if (conversation.draft.trim() === question) conversation.draft = ''
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
      if (controller.signal.aborted || conversation !== current.value) return false
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
      conversation.inFlight--
      releaseEmptyList()
      if (active === controller) {
        active = undefined
        pendingQuestion.value = ''
      }
    }
  }

  return { conversations, activeConversationId, newChat, selectChat, maxMessageLength, draft, messages, pending, error, send, stop }
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

function canResend(turn: Exchange, shareSummary: boolean, rows?: Map<string, number>): boolean {
  if (turn.sharedSummary && !shareSummary) return false
  if (!turn.sharedRows) return true
  if (!rows) return false
  for (const [key, count] of turn.sharedRows) {
    if ((rows.get(key) ?? 0) < count) return false
  }
  return true
}
