import { shallowRef } from 'vue'
import type { LedgerSession } from '../../app/ledgerSession.ts'
import { displayError, t } from '../../i18n/index.ts'
import type { LedgerActionResult, RunLedgerAction } from '../../integrations/ai/agentChat.ts'
import { createLedgerActionScope, type PreparedLedgerAction } from './ledgerActions.ts'

export function useLedgerActionReview(session: LedgerSession) {
  const review = shallowRef<PreparedLedgerAction | null>(null)
  let decide: ((approved: boolean) => void) | undefined

  function confirm() { decide?.(true) }
  function decline() { decide?.(false) }

  function ask(action: PreparedLedgerAction, signal: AbortSignal): Promise<boolean> {
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
    return async (name, args, signal): Promise<LedgerActionResult> => {
      const action = t('chat.action.' + name)
      const cancelled = () => ({ status: 'cancelled' as const, message: t('chat.action.cancelled', { action }) })
      if (signal.aborted) return cancelled()
      try {
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
