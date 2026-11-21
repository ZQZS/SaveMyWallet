import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks'
import { setLocale } from '../src/i18n/index.ts'
import { builtinPets } from '../src/features/pets/catalog.ts'
import { usePets } from '../src/features/pets/usePets.ts'
import { prepareReminderText } from '../src/features/reminders/reminderWording.ts'

globalThis.window = {}
afterEach(() => {
  clearMocks()
  setLocale('zh-CN')
  usePets().selectPet('wallet-cat')
})

test('without AI each built-in gives a localized reminder even when no subject is supplied', async () => {
  mockIPC(() => Promise.reject('AI_KEY_MISSING'))
  setLocale('en-US')
  const lines = new Set()
  for (const pet of builtinPets('en-US')) {
    usePets().selectPet(pet.id)
    const response = await prepareReminderText('')
    assert.deepEqual(response, { petId: pet.id, petName: pet.name, message: pet.reminderLine })
    lines.add(response.message)
  }
  assert.equal(lines.size, 3)
})

test('AI supplies the whole message for a blank subject and receives the selected card and language', async () => {
  const pet = {
    id: 'imported-5', name: '时钟匠', description: '总想知道齿轮转了几圈。', dialogueExample: '咔嗒，搭档！',
    avatar: 'blob:local-avatar', greetings: ['你好！'], preview: '只在本地显示', imported: true,
  }
  let nativeCall
  mockIPC((command, args) => {
    nativeCall = { command, args }
    return '咔嗒，搭档，该伸个懒腰了。'
  })
  const response = await prepareReminderText('   ', pet)
  assert.deepEqual(response, { petId: pet.id, petName: pet.name, message: '咔嗒，搭档，该伸个懒腰了。' })
  const { requestId, ...input } = nativeCall.args
  assert.equal(nativeCall.command, 'ai_pet_reminder_line')
  assert.ok(requestId)
  assert.deepEqual(input, {
    character: { name: pet.name, description: pet.description, voiceSample: pet.dialogueExample },
    subject: '', language: 'zh-CN',
  })
})

test('the original subject stays first with generated, unavailable, or malformed wording', async () => {
  const pet = builtinPets('zh-CN')[0]
  const subject = '11 月 24 日 15:00 带钥匙🔑'
  mockIPC((_command, args) => args.subject === subject ? '让我替你看着时间，喵。' : '')
  assert.equal((await prepareReminderText(subject, pet)).message, subject + '\n让我替你看着时间，喵。')
  for (const line of ['', '不应出现\n两行', '长'.repeat(101)]) {
    mockIPC(() => line)
    assert.equal((await prepareReminderText(subject, pet)).message, subject + '\n' + pet.reminderLine)
  }
  mockIPC(() => Promise.reject('AI_NETWORK'))
  const imported = { ...pet, reminderLine: undefined, greetings: ['长'.repeat(205), '咔嗒，搭档！'] }
  assert.equal((await prepareReminderText(subject, imported)).message, subject + '\n咔嗒，搭档！')
})

test('long imported card names still fit a native notification title without breaking emoji', async () => {
  const pet = { ...builtinPets('zh-CN')[0], name: '🌙'.repeat(220) }
  const snapshot = await prepareReminderText('', pet, Date.now())
  assert.equal(snapshot.petName, '🌙'.repeat(200))
})

test('an imminent delivery keeps the deadline and cancels a slow native generation by request ID', async () => {
  const pet = builtinPets('zh-CN')[1]
  const calls = []
  const completion = Promise.withResolvers()
  mockIPC((command, args) => {
    calls.push([command, args.requestId])
    if (command === 'ai_cancel') return completion.resolve('已经晚了')
    return completion.promise
  })
  assert.equal((await prepareReminderText('', pet, Date.now())).message, pet.reminderLine)
  assert.equal(calls.length, 0)
  assert.equal((await prepareReminderText('', pet, Date.now() + 350)).message, pet.reminderLine)
  assert.deepEqual(calls.map(([command]) => command), ['ai_pet_reminder_line', 'ai_cancel'])
  assert.equal(calls[0][1], calls[1][1])
})
