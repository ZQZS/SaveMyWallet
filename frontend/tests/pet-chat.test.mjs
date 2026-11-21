import assert from 'node:assert/strict'
import test from 'node:test'
import { effectScope } from 'vue'
import { MAX_PET_MESSAGE_LENGTH, usePetChat } from '../src/features/pets/usePetChat.ts'

const month = '2026-11'
const pet = { name: '测试狐', description: '好奇', greetings: ['一起查线索？'] }

function openChat(t, character, request, selectedMonth = month) {
  const scope = effectScope()
  t.after(() => scope.stop())
  const chat = scope.run(() => usePetChat(character, selectedMonth, request))
  return { ...chat, close: () => scope.stop() }
}

function ask(chat, question, facts) {
  chat.draft.value = question
  return chat.send('zh-CN', facts)
}

test('勾选只附四个汇总字段，取消勾选后历史中引用的金额留在本机', async t => {
  const calls = []
  const chat = openChat(t, { ...pet, id: 'summary' }, async input => {
    calls.push(input)
    return input.facts ? '预计结余 777.77 元。' : '继续聊。'
  })
  const facts = { month, balanceCents: 77777, dueCents: 20000, warningFloorCents: 10000 }
  assert.equal(await ask(chat, '你好'), true)
  assert.ok(!Object.hasOwn(calls[0], 'facts'))
  assert.equal(await ask(chat, '我的结余呢？', { ...facts, entries: ['私密明细'] }), true)
  assert.deepEqual(calls[1].facts, facts)
  assert.deepEqual(calls[1].messages.map(item => item.role), ['user', 'assistant', 'user'])
  assert.equal(await ask(chat, '讲个故事'), true)
  assert.deepEqual(calls[2].messages, [{ role: 'user', content: '讲个故事' }])
  assert.ok(!Object.hasOwn(calls[2], 'facts'))
  assert.equal(await ask(chat, '然后呢？'), true)
  assert.deepEqual(calls[3].messages.map(item => item.content), ['讲个故事', '继续聊。', '然后呢？'])
  assert.ok(chat.messages.value.some(item => item.content.includes('777.77')))
  assert.equal(await ask(chat, '换个摘要', { ...facts, month: '2026-12' }), false)
  assert.equal(chat.error.value, 'AI_INVALID_INPUT')
  assert.equal(calls.length, 4)
})

test('多轮对话只发送最近五对问答及当前问题，界面保留完整对话', async t => {
  const inputs = []
  const chat = openChat(t, { ...pet, id: 'bounded-history' }, async input => {
    inputs.push(input)
    return '答' + inputs.length
  })
  for (let i = 1; i <= 8; i++) assert.equal(await ask(chat, '问' + i), true)
  const expected = []
  for (let i = 3; i <= 7; i++) {
    expected.push({ role: 'user', content: '问' + i }, { role: 'assistant', content: '答' + i })
  }
  expected.push({ role: 'user', content: '问8' })
  assert.deepEqual(inputs[7].messages, expected)
  assert.equal(chat.messages.value.length, 16)
})

test('停止、网络失败和迟到回复均可恢复，同一提问只成功记入一次', async t => {
  const attempts = []
  const chat = openChat(t, { ...pet, id: 'retry' }, (_input, signal) => {
    const deferred = Promise.withResolvers()
    attempts.push({ ...deferred, signal })
    return deferred.promise
  })
  const stopped = ask(chat, '一起看看？')
  assert.equal(chat.pending.value, true)
  assert.equal(await chat.send('zh-CN'), false)
  assert.equal(attempts.length, 1)
  chat.stop()
  assert.equal(attempts[0].signal.aborted, true)
  assert.equal(chat.messages.value.length, 0)
  assert.equal(chat.draft.value, '一起看看？')
  const next = chat.send('zh-CN')
  attempts[0].resolve('迟到回复')
  assert.equal(await stopped, false)
  assert.equal(chat.pending.value, true)
  attempts[1].reject(new Error('AI_NETWORK'))
  assert.equal(await next, false)
  assert.equal(chat.error.value, 'AI_NETWORK')
  assert.equal(chat.draft.value, '一起看看？')
  const retry = chat.send('zh-CN')
  attempts[2].resolve('好。')
  assert.equal(await retry, true)
  assert.deepEqual(chat.messages.value.map(item => item.content), ['一起看看？', '好。'])
  assert.equal(chat.error.value, '')
  assert.equal(chat.draft.value, '')
})

test('按角色和月份隔离，关闭会取消正在发送的消息，重开保留对话和草稿', async t => {
  const character = { ...pet, id: 'reopen' }
  const first = openChat(t, character, async () => '十一月见。')
  await ask(first, '你好')
  first.close()
  const pending = Promise.withResolvers()
  let signal
  const second = openChat(t, character, (_input, requestSignal) => {
    signal = requestSignal
    return pending.promise
  })
  const closing = ask(second, '草稿')
  second.close()
  assert.equal(signal.aborted, true)
  for (const [id, selectedMonth] of [['other', month], [character.id, '2026-12']]) {
    const other = openChat(t, { ...pet, id }, async () => '', selectedMonth)
    assert.deepEqual(other.messages.value, [])
    assert.equal(other.draft.value, '')
  }
  const reopened = openChat(t, character, async () => '再见。')
  pending.resolve('已关闭窗口的回复')
  assert.equal(await closing, false)
  assert.deepEqual(reopened.messages.value.map(item => item.content), ['你好', '十一月见。'])
  assert.equal(reopened.draft.value, '草稿')
})

test('长酒馆资料和用户消息按 Unicode 码点计数，只发送当前角色的展示字段', async t => {
  const glyph = '🦊'
  const long = glyph.repeat(2100)
  const imported = { ...pet, id: 'tavern-limits', name: long, description: long, greetings: ['首句', '备选'], dialogueExample: long,
    avatar: 'blob:local-portrait', imported: true, system_prompt: '卡片指令' }
  const inputs = []
  const chat = openChat(t, imported, async input => { inputs.push(input); return 'Hello' })
  chat.draft.value = glyph.repeat(MAX_PET_MESSAGE_LENGTH + 1)
  assert.equal(await chat.send('en-US'), false)
  assert.equal(inputs.length, 0)
  chat.draft.value = glyph.repeat(MAX_PET_MESSAGE_LENGTH)
  assert.equal(await chat.send('en-US'), true)
  assert.equal(inputs[0].language, 'en-US')
  assert.deepEqual(Object.keys(inputs[0].character).sort(), ['description', 'name', 'opening', 'voiceSample'])
  assert.equal(inputs[0].character.opening, '首句')
  for (const [field, limit] of Object.entries({ name: 128, description: 2000, voiceSample: 500 })) {
    assert.equal(inputs[0].character[field], glyph.repeat(limit), field)
  }
  assert.equal(inputs[0].messages[0].content, glyph.repeat(MAX_PET_MESSAGE_LENGTH))
  const fallback = openChat(t, { ...imported, id: 'no-dialogue-example', dialogueExample: undefined },
    async input => { inputs.push(input); return '你好' })
  assert.equal(await ask(fallback, '你好'), true)
  assert.equal(inputs[1].character.voiceSample, '首句')
  assert.ok(!Object.hasOwn(inputs[1].character, 'opening'))
})
