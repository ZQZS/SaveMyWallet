import { computed, readonly, ref, shallowRef } from 'vue'
import { locale } from '../../i18n/index.ts'
import { builtinPets, type PetCharacter } from './catalog.ts'
import { parsePetCard, PetCardImportError } from './cardImport.ts'
import { petStorage, type SavedPetCard } from './petStorage.ts'
import { forgetPetChats } from './usePetChat.ts'

const preferenceKey = 'savemywallet.pets.preferences'
const storageError = ref(false)
const preferenceError = ref(false)

function readPreferences(): { enabled: boolean; selectedId: string } {
  try {
    const saved = JSON.parse(localStorage.getItem(preferenceKey) ?? 'null')
    return { enabled: saved?.enabled === true, selectedId: typeof saved?.selectedId === 'string' ? saved.selectedId : 'wallet-cat' }
  } catch {
    return { enabled: false, selectedId: 'wallet-cat' }
  }
}

const preferences = ref(readPreferences())
const enabled = computed(() => preferences.value.enabled)

function remember() {
  try {
    localStorage.setItem(preferenceKey, JSON.stringify(preferences.value))
    preferenceError.value = false
  } catch {
    // A committed card import remains usable even if the preference store is full.
    preferenceError.value = true
  }
}

const ready = ref(false)
type DisplayCard = Omit<SavedPetCard, 'avatar'> & { avatar: string }
const imported = shallowRef<DisplayCard[]>([])
let loading: Promise<void> | undefined

function displayCard({ avatar, ...card }: SavedPetCard): DisplayCard {
  return { ...card, avatar: avatar ? URL.createObjectURL(avatar) : '' }
}

function importedId(key: number) {
  return 'imported-' + key
}

function loadCards(): Promise<void> {
  loading ??= petStorage.list().then(cards => {
    imported.value = cards.map(displayCard)
    storageError.value = false
  }).catch(() => {
    storageError.value = true
    loading = undefined // A later visit or import can retry a temporarily unavailable store.
    throw new Error('pets.import.storage')
  }).finally(() => { ready.value = true })
  return loading
}

const characters = computed<PetCharacter[]>(() => {
  const english = locale.value === 'en-US'
  const defaults = builtinPets(locale.value)
  const userName = english ? 'you' : '你'
  const personalize = (text: string) => text.replace(/\{\{user\}\}/gi, userName)
  return [...defaults, ...imported.value.map(card => {
    const greetings = card.greetings.map(personalize)
    const fallback = english ? `Hello, I’m ${card.name}.` : `你好，我是${card.name}。`
    return {
      id: importedId(card.id), name: card.name, avatar: card.avatar, imported: true,
      description: [card.personality, card.description].filter(Boolean).map(personalize).join('\n'),
      scenario: card.scenario && personalize(card.scenario),
      dialogueExample: card.dialogueExample && personalize(card.dialogueExample),
      greetings: greetings.length ? greetings : [fallback],
      preview: greetings[0] || fallback,
    }
  })]
})
const activePet = computed(() => characters.value.find(pet => pet.id === preferences.value.selectedId) ?? characters.value[0])

export async function selectedPetForReminder(): Promise<PetCharacter> {
  const selectedId = preferences.value.selectedId
  if (selectedId.startsWith('imported-')) {
    try { await loadCards() } catch { /* The built-in companion also works without local storage. */ }
  }
  return characters.value.find(pet => pet.id === selectedId) ?? characters.value[0]
}

function setEnabled(value: boolean) {
  preferences.value.enabled = value
  remember()
}

function selectPet(id: string) {
  if (!characters.value.some(pet => pet.id === id)) return
  preferences.value.selectedId = id
  remember()
}

async function thumbnail(avatar: Blob): Promise<Blob> {
  let image: ImageBitmap | undefined
  try {
    image = await createImageBitmap(avatar)
    const scale = Math.min(1, 256 / Math.max(image.width, image.height))
    if (scale === 1) return avatar
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(image.width * scale))
    canvas.height = Math.max(1, Math.round(image.height * scale))
    const context = canvas.getContext('2d')
    if (!context) throw new Error()
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error()), 'image/png')
    })
  } catch {
    throw new Error('pets.import.invalidImage')
  } finally {
    image?.close()
  }
}

async function importPet(file: File): Promise<string> {
  const parsed = await parsePetCard(file).catch((error: unknown) => {
    const code = error instanceof PetCardImportError ? error.code : 'invalid'
    throw new Error('pets.import.' + (code === 'noCard' ? 'missingData' : code))
  })
  await loadCards()
  if (parsed.avatar) parsed.avatar = await thumbnail(parsed.avatar)
  let key: number
  try {
    key = await petStorage.add(parsed)
  } catch {
    throw new Error('pets.import.storage')
  }
  imported.value = [...imported.value, displayCard({ ...parsed, id: key })]
  const id = importedId(key)
  selectPet(id)
  return id
}

async function removePet(id: string): Promise<void> {
  const card = imported.value.find(item => importedId(item.id) === id)
  if (!card) return
  try {
    await petStorage.remove(card.id)
  } catch {
    throw new Error('pets.import.storage')
  }
  imported.value = imported.value.filter(item => item.id !== card.id)
  forgetPetChats(id)
  if (card.avatar) URL.revokeObjectURL(card.avatar)
  if (preferences.value.selectedId === id) selectPet('wallet-cat')
}

if (import.meta.hot) import.meta.hot.dispose(() => {
  for (const card of imported.value) if (card.avatar) URL.revokeObjectURL(card.avatar)
})

export function usePets() {
  void loadCards().catch(() => { /* Built-in characters also work without IndexedDB. */ })
  return { enabled, ready: readonly(ready), storageError: readonly(storageError), preferenceError: readonly(preferenceError),
    activePet, characters, setEnabled, selectPet, importPet, removePet }
}
