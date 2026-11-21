import { locale, type AppLocale } from '../../i18n/index.ts'
import { generatePetReminderLine } from '../../integrations/ai/deepseek.ts'
import { clipCharacterText } from '../pets/cardImport.ts'
import type { PetCharacter } from '../pets/catalog.ts'
import { selectedPetForReminder, usePets } from '../pets/usePets.ts'

function shortLine(value: string | undefined): string {
  const line = value?.trim() ?? ''
  return line.length <= 200 && Array.from(line).length <= 100 && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(line) ? line : ''
}

function defaultLine(pet: PetCharacter, language: AppLocale): string {
  return shortLine(pet.reminderLine) || pet.greetings.find(line => shortLine(line))?.trim()
    || (language === 'zh-CN' ? '你的提醒到了。' : 'Your reminder is here.')
}

// Take the role and wording once, while the app is open. OS timers only need the resulting text.
export async function prepareReminderText(text: string, selectedPet?: PetCharacter, dueAt?: number) {
  const language = locale.value
  const subject = text.trim()
  let pet = selectedPet ?? usePets().activePet.value
  function result(line: string) {
    // Keep the user's actual instruction visible even when a notification preview is truncated.
    const message = subject && subject !== line ? `${subject}\n${line}` : line
    const petName = clipCharacterText(pet.name.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').trim(), 200)
      || (language === 'zh-CN' ? '桌宠' : 'Pet')
    return { petId: pet.id, petName, message }
  }

  const waitMs = dueAt === undefined ? 3000 : Math.min(3000, dueAt - Date.now() - 300)
  if (waitMs <= 0) return result(defaultLine(pet, language))
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  async function compose() {
    if (!selectedPet) pet = await selectedPetForReminder()
    const fallback = defaultLine(pet, language)
    if (controller.signal.aborted) return result(fallback)
    try {
      const character = {
        name: clipCharacterText(pet.name, 128),
        description: clipCharacterText(pet.description, 2000),
        voiceSample: clipCharacterText(pet.dialogueExample || pet.greetings[0] || '', 500),
      }
      const line = await generatePetReminderLine(character, subject, language, controller.signal)
      return result(shortLine(line) || fallback)
    } catch {
      return result(fallback)
    }
  }
  try {
    return await Promise.race([
      compose(),
      new Promise<ReturnType<typeof result>>(resolve => {
        timer = setTimeout(() => {
          controller.abort()
          resolve(result(defaultLine(pet, language)))
        }, waitMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
