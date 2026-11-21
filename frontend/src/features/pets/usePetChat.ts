import { computed, onScopeDispose, ref } from 'vue'
import type { AppLocale } from '../../i18n/index.ts'
import type { ReminderFacts } from '../../integrations/ai/capabilities.ts'
import { chatWithPet, type PetChatMessage } from '../../integrations/ai/deepseek.ts'
import type { PetCharacter } from './catalog.ts'
import { clipCharacterText } from './cardImport.ts'

export const MAX_PET_MESSAGE_LENGTH = 1000

interface Exchange {
  question: string
  reply: string
  sharedSummary: boolean
}

function newConversation() {
  return { draft: ref(''), exchanges: ref<Exchange[]>([]) }
}

// Chats live in memory for this run of the app. The same companion can discuss different months.
const conversations = new Map<string, ReturnType<typeof newConversation>>()

function messagesFor(exchanges: Exchange[]): PetChatMessage[] {
  return exchanges.flatMap(({ question, reply }) => [
    { role: 'user' as const, content: question },
    { role: 'assistant' as const, content: reply },
  ])
}

export function usePetChat(pet: PetCharacter, month: string, request = chatWithPet) {
  const key = JSON.stringify([pet.id, month])
  const conversation = conversations.get(key) ?? newConversation()
  conversations.set(key, conversation)
  const { draft, exchanges } = conversation
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
    const history = messagesFor(exchanges.value)
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

  async function send(language: AppLocale, facts?: ReminderFacts): Promise<boolean> {
    const question = draft.value.trim()
    if (active || !question) return false
    if (Array.from(question).length > MAX_PET_MESSAGE_LENGTH || (facts && facts.month !== month)) {
      error.value = 'AI_INVALID_INPUT'
      return false
    }
    const recent = exchanges.value.slice(-5)
    // With sharing off, even an earlier reply quoting a balance must stay out of this request.
    const lastShared = facts ? -1 : recent.map(turn => turn.sharedSummary).lastIndexOf(true)
    const context = messagesFor(recent.slice(lastShared + 1))
    context.push({ role: 'user', content: question })
    const controller = new AbortController()
    active = controller
    pendingQuestion.value = question
    error.value = ''
    try {
      const response = await request({
        character, messages: context, language,
        ...(facts && { facts: { month, balanceCents: facts.balanceCents, dueCents: facts.dueCents, warningFloorCents: facts.warningFloorCents } }),
      }, controller.signal)
      if (controller.signal.aborted) return false
      if (typeof response !== 'string' || !response.trim()) throw new Error('AI_BAD_RESPONSE')
      exchanges.value.push({ question, reply: response.trim(), sharedSummary: Boolean(facts) })
      if (draft.value.trim() === question) draft.value = ''
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

  return { draft, messages, pending, error, send, stop }
}
