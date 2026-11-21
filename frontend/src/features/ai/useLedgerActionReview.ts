import { shallowRef } from 'vue'
import type { LedgerSession } from '../../app/ledgerSession.ts'
import { displayError, t } from '../../i18n/index.ts'
import type { LedgerActionResult, RunLedgerAction } from '../../integrations/ai/agentChat.ts'
import { isReminderAction, prepareReminderAction, type CreateReminder, type ReminderActionName } from '../reminders/reminderActions.ts'
import { createLedgerActionScope, type PreparedLedgerAction } from './ledgerActions.ts'

type ActionPreview = { name: PreparedLedgerAction['name'] | ReminderActionName; lines: string[] }

export function useLedgerActionReview(session: LedgerSession, createReminder?: CreateReminder) {
  const review = shallowRef<ActionPreview | null>(null)
  let decide: ((approved: boolean) => void) | undefined

  function confirm() { decide?.(true) }
  function decline() { decide?.(false) }

  function ask(action: ActionPreview, signal: AbortSignal): Promise<boolean> {
    return new Promise(resolve => {
      if (signal.aborted || decide) return resolve(false)
      const abort = () => finish(false)
      function finish(approved: boolean) {
        signal.removeEventListener('abort', abort)
        decide = undefined
        review.value = null
        resolve(approved)
      }
      decide = finish
      review.value = action
      signal.addEventListener('abort', abort, { once: true })
    })
  }

  function forTurn(month: string, selectedIds: readonly string[]): RunLedgerAction {
    const scope = createLedgerActionScope(session, month, selectedIds)
    const requestedAt = Date.now()
    return async (name, args, signal): Promise<LedgerActionResult> => {
      const action = t('chat.action.' + name)
      const cancelled = () => ({ status: 'cancelled' as const, message: t('chat.action.cancelled', { action }) })
      if (signal.aborted) return cancelled()
      try {
        if (isReminderAction(name)) {
          if (!createReminder) throw new Error('REMINDER_STORAGE')
          const prepared = prepareReminderAction(name, args, requestedAt)
          if (!await ask(prepared, signal) || signal.aborted) return cancelled()
          return { status: 'applied', message: await prepared.apply(createReminder) }
        }
        const prepared = scope.prepare(name, args)
        if (!await ask(prepared, signal) || signal.aborted) return cancelled()
        const status = await prepared.apply()
        if (status === 'refreshPending') return { status: 'saved_pending_refresh', message: t('chat.action.refreshPending', { action }) }
        if (status === 'partial') return { status, message: t('chat.action.partial', { action, count: prepared.changedCount ?? 0 }) }
        return { status, message: t('chat.action.' + status, { action }) }
      } catch (cause) {
        return { status: 'failed', message: t('chat.action.failed', { action, reason: displayError(cause) }) }
      }
    }
  }

  return { review, confirm, decline, forTurn }
}
