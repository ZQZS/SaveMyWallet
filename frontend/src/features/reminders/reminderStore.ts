import type { ReminderChanges, ReminderStatus, ReminderStore, ReminderTask } from './reminderService.ts'

const storeName = 'tasks'

function transaction<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore, setResult: (value: T) => void) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const fail = () => reject(new Error('REMINDER_STORAGE'))
    let open: IDBOpenDBRequest
    try {
      open = indexedDB.open('savemywallet.reminders', 1)
    } catch {
      fail()
      return
    }
    let blocked = false
    open.onblocked = () => {
      blocked = true
      fail()
    }
    open.onerror = fail
    open.onupgradeneeded = () => {
      open.result.createObjectStore(storeName, { keyPath: 'id', autoIncrement: true })
    }
    open.onsuccess = () => {
      const db = open.result
      db.onversionchange = () => db.close()
      if (blocked) {
        db.close()
        return
      }
      let tx: IDBTransaction | undefined
      try {
        tx = db.transaction(storeName, mode)
        let result: T
        tx.oncomplete = () => {
          db.close()
          resolve(result)
        }
        tx.onabort = () => {
          db.close()
          fail()
        }
        work(tx.objectStore(storeName), value => { result = value })
      } catch {
        tx?.abort()
        db.close()
        fail()
      }
    }
  })
}

export const reminderStore: ReminderStore = {
  list() {
    return transaction<ReminderTask[]>('readonly', (store, finish) => {
      const request = store.getAll()
      request.onsuccess = () => finish(request.result)
    })
  },
  add(task: Omit<ReminderTask, 'id'>) {
    const record = { ...task }
    return transaction<ReminderTask>('readwrite', (store, finish) => {
      const request = store.add(record)
      request.onsuccess = () => {
        const id = request.result
        // System notification IDs use signed 32-bit integers on Android.
        if (typeof id !== 'number' || !Number.isInteger(id) || id < 1 || id > 0x7fffffff) {
          store.transaction.abort()
          return
        }
        finish({ ...record, id })
      }
    })
  },
  transition(id: number, from: ReminderStatus, to: ReminderStatus, error?: string, changes?: ReminderChanges,
    expected?: { at: number; revision: number }) {
    return transaction<ReminderTask | null>('readwrite', (store, finish) => {
      const request = store.get(id)
      request.onsuccess = () => {
        const task: ReminderTask | undefined = request.result
        if (!task || task.status !== from || (expected &&
            (task.at !== expected.at || (task.revision ?? 0) !== expected.revision))) return finish(null)
        Object.assign(task, changes)
        task.status = to
        if (error === undefined) delete task.error
        else task.error = error
        store.put(task)
        finish(task)
      }
    })
  },
  remove(id: number, from: ReminderStatus, expectedRevision?: number) {
    return transaction<boolean>('readwrite', (store, finish) => {
      const request = store.get(id)
      request.onsuccess = () => {
        const task: ReminderTask | undefined = request.result
        if (!task || task.status !== from || (expectedRevision !== undefined && (task.revision ?? 0) !== expectedRevision)) return finish(false)
        store.delete(id)
        finish(true)
      }
    })
  },
}
