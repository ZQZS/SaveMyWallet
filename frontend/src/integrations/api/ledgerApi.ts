import axios, { type AxiosInstance } from 'axios'
import type { LedgerRepository } from '../../data/repository'
import type { BillInput, LedgerData } from '../../domain/ledger'

export function createApiClient(baseURL: string): AxiosInstance {
  return axios.create({ baseURL, timeout: 15_000 })
}

export function createApiLedgerRepository(client: AxiosInstance) {
  return {
    async load() {
      const { data } = await client.get<LedgerData>('/ledger')
      return data
    },
    async createPlatform(name) {
      const { data } = await client.post<{ id: string }>('/platforms', { name })
      return data.id
    },
    async createBill(input: BillInput, operationId: string = crypto.randomUUID()) {
      // An online caller retrying a logical submission passes its original operation ID.
      await client.post('/bills', input, { headers: { 'Idempotency-Key': operationId } })
    },
    async confirmEstimate(input) {
      const { id, ...changes } = input
      await client.post('/bills/' + encodeURIComponent(id) + '/confirm', changes)
    },
    async setEntryVoided(id: string, voided: boolean, operationId: string = crypto.randomUUID()) {
      await client.put('/bills/' + encodeURIComponent(id) + '/voided', { voided }, {
        headers: { 'Idempotency-Key': operationId },
      })
    },
    async setInstallmentVoided(id: string, voided: boolean, operationId: string = crypto.randomUUID()) {
      const { data } = await client.put<{ changedIds: string[] }>(
        '/bills/' + encodeURIComponent(id) + '/installment/voided', { voided },
        { headers: { 'Idempotency-Key': operationId } },
      )
      return data.changedIds
    },
    async setPayment(ids, paid) {
      const { data } = await client.patch<{ changedIds: string[] }>('/payments', { ids, paid })
      return data.changedIds
    },
    async saveBudget(input) {
      await client.put('/budget', input)
    },
  } satisfies LedgerRepository
}
