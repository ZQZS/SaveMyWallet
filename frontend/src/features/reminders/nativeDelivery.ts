import { invoke, isTauri } from '@tauri-apps/api/core'

async function deliver(command: string, args: Record<string, unknown>) {
  if (!isTauri()) throw new Error('REMINDER_UNAVAILABLE')
  try {
    await invoke<void>(command, args)
  } catch (error) {
    const code = error instanceof Error ? error.message : String(error)
    throw new Error(['REMINDER_PERMISSION', 'REMINDER_TIME', 'REMINDER_UNAVAILABLE'].includes(code)
      ? code : 'REMINDER_DELIVERY')
  }
}

export const nativeDelivery = {
  schedule(id: number, at: number, title: string, body: string, requestPermission = true) {
    return deliver('reminder_schedule', { id, at, title, body, requestPermission })
  },
  cancel(id: number) {
    return deliver('reminder_cancel', { id })
  },
  notify(id: number, title: string, body: string, requestPermission = true) {
    return deliver('reminder_notify', { id, title, body, requestPermission })
  },
}
