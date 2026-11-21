import { isTauri } from '@tauri-apps/api/core'
import { t } from '../../i18n'
import { flushChatHistory } from './chatHistory'

export function startChatPersistence() {
  const flush = () => { void flushChatHistory().catch(() => { /* The chat view offers a retry. */ }) }
  const visibility = () => { if (document.visibilityState === 'hidden') flush() }
  document.addEventListener('visibilitychange', visibility)
  window.addEventListener('pagehide', flush)

  let stopped = false
  let closing = false
  let unlisten: (() => void) | undefined
  if (isTauri() && /Windows/i.test(navigator.userAgent)) {
    void import('@tauri-apps/api/window').then(({ getCurrentWindow }) =>
      getCurrentWindow().onCloseRequested(async event => {
        if (closing) { event.preventDefault(); return }
        closing = true
        let timer: number | undefined
        try {
          // Wait for local writes only. A blocked database must still allow the user to leave.
          await Promise.race([flushChatHistory(), new Promise<void>((_, reject) => {
            timer = window.setTimeout(() => reject(new Error('CHAT_CACHE_STORAGE')), 5000)
          })])
        } catch {
          if (!window.confirm(t('app.exitWithUnsavedChat'))) event.preventDefault()
        } finally {
          window.clearTimeout(timer)
          closing = false
        }
      }),
    ).then(stop => {
      if (stopped) stop()
      else unlisten = stop
    }).catch(() => { /* Drafts still save on input and when the page is hidden. */ })
  }
  return () => {
    stopped = true
    unlisten?.()
    document.removeEventListener('visibilitychange', visibility)
    window.removeEventListener('pagehide', flush)
  }
}
