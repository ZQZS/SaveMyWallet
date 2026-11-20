import { ref } from 'vue'
import { t } from '../../i18n'
import { useLedgerSession } from '../../app/ledgerSession'

export function usePlatformCreation() {
  const { data, busy, commit, notice, repository } = useLedgerSession()
  const name = ref('')
  const errorKey = ref('')

  function reset() {
    name.value = ''
    errorKey.value = ''
  }

  function submit(select?: (id: string) => void) {
    if (busy.value || !data.value) return
    const trimmed = name.value.trim()
    if (!trimmed || Array.from(trimmed).length > 40) {
      errorKey.value = 'forms.platformNameError'
      return
    }

    const existing = data.value.platforms.find(platform => platform.name.toLowerCase() === trimmed.toLowerCase())
    if (existing) {
      if (select) {
        reset()
        select(existing.id)
      } else {
        errorKey.value = 'forms.platformExists'
      }
      return
    }

    errorKey.value = ''
    return commit(() => repository.createPlatform(trimmed), id => {
      reset()
      notice.value = t('forms.platformSaved', { name: trimmed })
      select?.(id)
    })
  }

  return { name, errorKey, reset, submit }
}
