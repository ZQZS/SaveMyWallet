import { Agent, type AgentTool } from '@earendil-works/pi-agent-core'
import type { AssistantMessage, Message, ToolCall } from '@earendil-works/pi-ai'
import { DEEPSEEK_MODELS } from '@earendil-works/pi-ai/providers/deepseek.models'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream'
import { contentText } from '@earendil-works/pi-ai/utils/text'
import { validateToolCall } from '@earendil-works/pi-ai/utils/validation'
import actionDefinitions from '../../../resources/ai/ledger-action-tools.json' with { type: 'json' }
import type { LedgerActionName } from '../../features/ai/ledgerActions.ts'
import { isReminderAction, type ReminderActionName } from '../../features/reminders/reminderActions.ts'
import { petChatDetailsPayload, type PetChatDetails } from '../../features/pets/petChatDetails.ts'
import { requestAgentTurn, type PetChatInput } from './deepseek.ts'

export type AgentChatInput = Omit<PetChatInput, 'character'> & (
  | { mode: 'pet'; character: PetChatInput['character'] }
  | { mode: 'persona'; character: PetChatInput['character'] & { scenario?: string } }
  | { mode: 'general'; character?: never }
)

export interface AgentTurn {
  text: string
  calls: Pick<ToolCall, 'id' | 'name' | 'arguments'>[]
}

export interface ToolRound extends AgentTurn {
  results: { id: string; content: string }[]
}

export interface LedgerActionResult {
  status: 'applied' | 'partial' | 'cancelled' | 'failed' | 'unavailable' | 'saved_pending_refresh' | 'unchanged'
  message: string
}

// This local callback owns the selection IDs and user confirmation. The IPC request carries only the enabled flag.
type ChatActionName = LedgerActionName | ReminderActionName | 'manage_reminder'
export type RunLedgerAction = (name: ChatActionName, args: Record<string, unknown>, signal: AbortSignal) => Promise<LedgerActionResult>

const model = DEEPSEEK_MODELS['deepseek-flash']

function largestBills(entries: PetChatDetails['entries']) {
  if (!entries.length) return null
  const amountCents = entries.reduce((max, entry) => Math.max(max, entry.amountCents), 0)
  return {
    amountCents,
    bills: entries.filter(entry => entry.amountCents === amountCents)
      .map(({ title, platform }) => ({ title, platform })),
  }
}

function inspectSelectedBills(details: PetChatDetails): AgentTool {
  return {
    name: 'inspect_selected_bills',
    label: '查询勾选账单',
    description: 'Read the currently selected bills, confirmed unpaid total, estimates, and largest bills in cents.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      const { month, entries } = details
      const active = entries.filter(entry => !entry.voided)
      const due = active.filter(entry => entry.status === 'due')
      const estimated = active.filter(entry => entry.status === 'estimated')
      const result = {
        month, entries: entries.map((entry, index) => ({ row: index + 1, ...entry })),
        dueCount: due.length,
        dueCents: due.reduce((sum, entry) => sum + entry.amountCents, 0),
        estimatedCount: estimated.length,
        estimatedCents: estimated.reduce((sum, entry) => sum + entry.amountCents, 0),
        largestDue: largestBills(due),
        largestSelected: largestBills(active),
      }
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: undefined }
    },
  }
}

// Human turns have already been filtered for this send's sharing scope. Only tool
// rounds from the current prompt are appended to that history at the native boundary.
function toolRounds(messages: Message[]): ToolRound[] {
  const rounds: ToolRound[] = []
  for (const message of messages) {
    if (message.role === 'assistant') {
      const calls = message.content.filter(part => part.type === 'toolCall')
      if (calls.length) rounds.push({
        text: contentText(message.content),
        calls: calls.map(({ id, name, arguments: args }) => ({ id, name, arguments: args })),
        results: [],
      })
    } else if (message.role === 'toolResult') {
      const round = rounds.at(-1)
      if (!round || message.isError) throw new Error('AI_BAD_RESPONSE')
      round.results.push({ id: message.toolCallId, content: contentText(message.content) })
    }
  }
  return rounds
}

// The native client completes one provider request at a time. Pi consumes the
// completed message as one event and owns the tool execution and follow-up turn.
function completedTurn({ text, calls }: AgentTurn) {
  const stopReason = calls.length ? 'toolUse' : 'stop'
  const message: AssistantMessage = {
    role: 'assistant', api: model.api, provider: model.provider, model: model.id,
    stopReason, timestamp: Date.now(), content: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  }
  if (text) message.content.push({ type: 'text', text })
  for (const call of calls) message.content.push({ ...call, type: 'toolCall' })
  const stream = createAssistantMessageEventStream()
  stream.push({ type: 'done', reason: stopReason, message })
  return stream
}

export async function chatWithAgent(input: AgentChatInput, signal: AbortSignal, runAction?: RunLedgerAction): Promise<string> {
  if (signal.aborted) throw new Error('AI_CANCELLED')
  const question = input.messages.at(-1)
  if (!question || question.role !== 'user') throw new Error('AI_INVALID_INPUT')
  const details = input.details && petChatDetailsPayload(input.details)
  const hasSelection = Boolean(details?.entries.length)
  const tools: AgentTool[] = details?.entries.length ? [inspectSelectedBills(details)] : []
  const receipts = new Map<string, LedgerActionResult>()
  if (runAction) {
    for (const definition of actionDefinitions) {
      if (definition.requiresSelection && !hasSelection) continue
      tools.push({
        name: definition.name, label: definition.name, description: definition.description,
        parameters: definition.parameters, executionMode: 'sequential', replay: 'never',
        async execute(_id, inputArgs) {
          if (signal.aborted) throw new Error('AI_CANCELLED')
          const args = inputArgs as Record<string, unknown>
          // The provider may repeat a call with a different ID, shuffled rows, or a blank subject.
          const normalized = isReminderAction(definition.name)
            ? { ...args, text: typeof args.text === 'string' ? args.text.trim() : '' }
            : definition.name === 'manage_reminder' && typeof args.subject === 'string'
              ? { ...args, subject: args.subject.trim() } : args
          const fields = Object.keys(normalized).sort().map(key => {
            const value = normalized[key]
            if (key === 'recurrence') {
              // Dedupe the model's request before the approval card obtains a device-generated seed.
              const rule = value as Record<string, unknown>
              return [key, Object.keys(rule).sort().map(field => [field, rule[field]])]
            }
            return [key, key === 'rows' && Array.isArray(value) ? [...value].sort((a, b) => a - b) : value]
          })
          const key = JSON.stringify([definition.name, fields])
          let result = receipts.get(key)
          if (!result) {
            result = await runAction(definition.name as ChatActionName, args, signal)
            receipts.set(key, result)
          }
          return { content: [{ type: 'text', text: result.status }], details: undefined, terminate: true }
        },
      })
    }
  }
  const agent = new Agent({
    initialState: { model, tools },
    // Mixed read/write batches also end locally. A successful write must not depend on another model request.
    finishTurn: () => receipts.size ? { action: 'end' } : undefined,
    streamFn: async (_model, context, options) => {
      const rounds = toolRounds(context.messages)
      const reply = await requestAgentTurn({ ...input, details }, rounds, Boolean(runAction), options?.signal)
      if (reply.calls.length && rounds.length >= 4) throw new Error('AI_BAD_RESPONSE')
      // Validate the whole batch before a valid sibling is allowed to start a write.
      try {
        for (const call of reply.calls) {
          const args = validateToolCall(tools, { ...call, type: 'toolCall' })
          if (isReminderAction(call.name) && args.recurrence?.frequency === 'randomWindow'
              && args.recurrence.startTime === args.recurrence.endTime) throw new Error('REMINDER_INVALID_TIME')
        }
      } catch {
        throw new Error('AI_BAD_RESPONSE')
      }
      return completedTurn(reply)
    },
  })
  const abort = () => agent.abort()
  signal.addEventListener('abort', abort, { once: true })
  try {
    await agent.prompt(question.content)
    if (receipts.size) return Array.from(receipts.values(), result => result.message).join('\n')
    if (signal.aborted) throw new Error('AI_CANCELLED')
    const last = agent.state.messages.at(-1)
    if (last?.role !== 'assistant') throw new Error('AI_BAD_RESPONSE')
    if (last.stopReason === 'error' || last.stopReason === 'aborted') {
      const code = last.errorMessage ?? ''
      throw new Error(/^(AI_[A-Z_]+|NATIVE_ONLY)$/.test(code) ? code : 'AI_UNAVAILABLE')
    }
    const answer = contentText(last.content).trim()
    if (!answer || last.stopReason !== 'stop') throw new Error('AI_BAD_RESPONSE')
    return answer
  } finally {
    signal.removeEventListener('abort', abort)
  }
}
