import type { ImportedPetCard } from './cardImport'

export interface SavedPetCard extends ImportedPetCard {
  id: number
}

// Keep artwork as a Blob in device storage, outside both the ledger and its backups.
function run<T>(mode: IDBTransactionMode, request: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('savemywallet.pets', 1)
    open.onupgradeneeded = () => open.result.createObjectStore('characters', { keyPath: 'id', autoIncrement: true })
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result
      try {
        const tx = db.transaction('characters', mode)
        const operation = request(tx.objectStore('characters'))
        tx.oncomplete = () => {
          db.close()
          resolve(operation.result)
        }
        tx.onabort = () => {
          db.close()
          reject(tx.error)
        }
      } catch (error) {
        db.close()
        reject(error)
      }
    }
  })
}

export const petStorage = {
  list: (): Promise<SavedPetCard[]> => run('readonly', store => store.getAll()),
  add: async (card: ImportedPetCard): Promise<number> => Number(await run('readwrite', store => store.add(card))),
  remove: (id: number) => run('readwrite', store => store.delete(id)),
}
