import { computed, onScopeDispose, reactive, ref } from 'vue'
import type { AppLocale } from '../../i18n/index.ts'
import type { ReminderFacts } from '../../integrations/ai/capabilities.ts'
import { chatWithPet, type PetChatMessage } from '../../integrations/ai/deepseek.ts'
import type { PetCharacter } from './catalog.ts'
import { clipCharacterText } from './cardImport.ts'
import { petChatDetailsPayload, type PetChatDetails } from './petChatDetails.ts'

export const MAX_PET_MESSAGE_LENGTH = 1000
const MAX_CONTEXT_TURNS = 5

interface Exchange {
  question: string
  reply: string
  sharedSummary: boolean
  sharedRows?: Map<string, number>
}

interface Conversation {
  id: number
  draft: string
  exchanges: Exchange[]
}

function emptyChat(id: number): Conversation {
  return { id, draft: '', exchanges: [] }
}

function newChatList() {
  return reactive({ chats: [emptyChat(1)], selectedIndex: 0 })
}

// Each pet and month has its own in-memory list and remembers the last open chat.
const chatLists = new Map<string, ReturnType<typeof newChatList>>()

function messagesFor(exchanges: Exchange[]): PetChatMessage[] {
  return exchanges.flatMap(({ question, reply }) => [
    { role: 'user' as const, content: question },
    { role: 'assistant' as const, content: reply },
  ])
}

export function usePetChat(pet: PetCharacter, month: string, request = chatWithPet) {
  const key = JSON.stringify([pet.id, month])
  const list = chatLists.get(key) ?? newChatList()
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
  const opening = clipCharacterText(pet.greetings[0] || '', 1000)
  const voiceSample = clipCharacterText(pet.dialogueExample || opening, 500)
  const character = {
    name: clipCharacterText(pet.name, 128), description: clipCharacterText(pet.description, 2000),
    voiceSample, ...(opening && opening !== voiceSample ? { opening } : {}),
  }
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
  onScopeDispose(stop)

  function newChat() {
    stop()
    list.chats.push(emptyChat(list.chats.length + 1))
    list.selectedIndex = list.chats.length - 1
  }

  function selectChat(id: number) {
    const index = list.chats.findIndex(chat => chat.id === id)
    if (index < 0 || index === list.selectedIndex) return
    stop()
    list.selectedIndex = index
  }

  async function send(language: AppLocale, facts?: ReminderFacts, details?: PetChatDetails): Promise<boolean> {
    const question = draft.value.trim()
    if (active || !question) return false
    if (Array.from(question).length > MAX_PET_MESSAGE_LENGTH || (facts && facts.month !== month)
        || (details && (!facts || details.month !== month || !details.entries.length))) {
      error.value = 'AI_INVALID_INPUT'
      return false
    }
    const attachment = details && petChatDetailsPayload(details)
    const sharedRows = attachment && countSharedRows(attachment)
    const conversation = current.value
    const recent = conversation.exchanges.slice(-MAX_CONTEXT_TURNS)
    let first = recent.length
    while (first > 0 && canResend(recent[first - 1], Boolean(facts), sharedRows)) first--
    const context = messagesFor(recent.slice(first))
    context.push({ role: 'user', content: question })
    const controller = new AbortController()
    active = controller
    pendingQuestion.value = question
    error.value = ''
    try {
      const response = await request({
        character, messages: context, language,
        ...(facts && { facts: { month, balanceCents: facts.balanceCents, dueCents: facts.dueCents, warningFloorCents: facts.warningFloorCents } }),
        ...(attachment && { details: attachment }),
      }, controller.signal)
      if (controller.signal.aborted || conversation !== current.value) return false
      if (typeof response !== 'string' || !response.trim()) throw new Error('AI_BAD_RESPONSE')
      conversation.exchanges.push({ question, reply: response.trim(), sharedSummary: Boolean(facts), sharedRows })
      // Older exchanges stay visible, but their bill details can no longer be sent as context.
      const expired = conversation.exchanges.at(-MAX_CONTEXT_TURNS - 1)
      if (expired) delete expired.sharedRows
      if (conversation.draft.trim() === question) conversation.draft = ''
      return true
    } catch (cause) {
      if (!controller.signal.aborted) error.value = cause instanceof Error ? cause.message : 'AI_UNAVAILABLE'
      return false
    } finally {
      if (active === controller) {
        active = undefined
        pendingQuestion.value = ''
      }
    }
  }

  return { conversations, activeConversationId, newChat, selectChat, draft, messages, pending, error, send, stop }
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
