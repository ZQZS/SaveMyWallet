import { onBeforeUnmount, ref } from 'vue'
import { displayError } from '../../i18n'

export function useAssistantRequest() {
  const pending = ref(false)
  const error = ref('')
  let active: AbortController | undefined

  function cancel() {
    active?.abort()
    active = undefined
    pending.value = false
    error.value = ''
  }

  async function run<T>(request: (signal: AbortSignal) => Promise<T>, accept: (value: T) => void) {
    if (active) return
    const controller = new AbortController()
    active = controller
    pending.value = true
    error.value = ''
    try {
      const value = await request(controller.signal)
      if (!controller.signal.aborted) accept(value)
    } catch (cause) {
      if (!controller.signal.aborted) error.value = displayError(cause)
    } finally {
      if (active === controller) {
        active = undefined
        pending.value = false
      }
    }
  }

  onBeforeUnmount(cancel)
  return { pending, error, run, cancel }
}
