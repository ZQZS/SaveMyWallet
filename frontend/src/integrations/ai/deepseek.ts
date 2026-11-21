import { invoke } from '@tauri-apps/api/core'
import type { AppLocale } from '../../i18n/index.ts'
import type { LedgerSearchFilters } from '../../features/ai/ledgerSearch.ts'
import type { NoticeDraft } from '../../features/ai/noticeMatch.ts'
import type { ReminderFacts } from './capabilities.ts'
import type { PetChatDetails } from '../../features/pets/petChatDetails.ts'
import { readBillDrafts } from './visionDrafts.ts'

export interface SelectedAiImage {
  imageToken: string
  previewUrl: string
}

export interface ScenarioDraft {
  startMonth: string | null
  amountCents: number | null
  installmentCount: number | null
}

export function isNativeAiAvailable(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

async function callNative<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isNativeAiAvailable()) throw new Error('NATIVE_ONLY')
  try {
    return await invoke<T>(command, args)
  } catch (error) {
    // Only display error codes. Native platform errors can include private data.
    const code = typeof error === 'string' ? error : ''
    throw new Error(/^(AI_[A-Z_]+|FILE_READ)$/.test(code) ? code : 'AI_UNAVAILABLE')
  }
}

export const getAiKeyStatus = () => callNative<boolean>('ai_key_status')
export const saveAiKey = (key: string) => callNative<void>('ai_save_key', { key })
export const removeAiKey = () => callNative<void>('ai_remove_key')
export const testAiConnection = () => callNative<void>('ai_test_key')
export const chooseAiImage = () => callNative<SelectedAiImage | null>('ai_choose_image')
export const releaseAiImage = (imageToken: string) => callNative<void>('ai_release_image', { imageToken })

async function request<T>(command: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw new Error('AI_CANCELLED')
  const requestId = crypto.randomUUID()
  const onAbort = () => { void callNative<void>('ai_cancel', { requestId }).catch(() => {}) }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const result = await callNative<T>(command, { ...args, requestId })
    if (signal?.aborted) throw new Error('AI_CANCELLED')
    return result
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}

export function explainMonth(facts: ReminderFacts, language: AppLocale, signal?: AbortSignal) {
  return request<string>('ai_explain', { facts, language }, signal)
}

export interface PetChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface PetChatInput {
  character: { name: string; description: string; voiceSample: string; opening?: string }
  messages: PetChatMessage[]
  language: AppLocale
  facts?: ReminderFacts
  details?: PetChatDetails
}

export function chatWithPet(input: PetChatInput, signal: AbortSignal) {
  return request<string>('ai_pet_chat', { ...input }, signal)
}

export function parseScenario(message: string, referenceMonth: string, signal?: AbortSignal) {
  return request<ScenarioDraft>('ai_parse_scenario', { message, referenceMonth }, signal)
}

export function parseNotice(source: { text: string } | { imageToken: string }, referenceMonth: string, signal?: AbortSignal) {
  const input = 'text' in source ? { message: source.text } : { imageToken: source.imageToken }
  return request<NoticeDraft>('ai_parse_notice', { ...input, referenceMonth }, signal)
}

export function parseLedgerSearch(message: string, referenceMonth: string, signal?: AbortSignal) {
  return request<LedgerSearchFilters & { supported: boolean }>('ai_parse_search', { message, referenceMonth }, signal)
}

export async function recognizeAiBills(imageToken: string, signal?: AbortSignal) {
  const result = await request<unknown>('ai_recognize', { imageToken }, signal)
  try {
    return readBillDrafts(result)
  } catch {
    throw new Error('AI_BAD_RESPONSE')
  }
}
