import { useRouter } from 'vue-router'
import { useLedgerSession } from './ledgerSession'

/** Show a completed form's receipt on the destination page. */
export function useReturnToLedger() {
  const router = useRouter()
  const { notice } = useLedgerSession()
  return async (successNotice = '') => {
    const failure = await router.push({ name: 'ledger' })
    if (!failure) notice.value = successNotice
  }
}
