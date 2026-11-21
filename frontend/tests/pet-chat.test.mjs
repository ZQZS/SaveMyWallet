import assert from 'node:assert/strict'
import test from 'node:test'
import { effectScope } from 'vue'
import { chatStorage } from '../src/features/pets/chatStorage.ts'
import { flushChatHistory } from '../src/features/pets/chatHistory.ts'
import { forgetPetChats, MAX_MENU_MESSAGE_LENGTH, MAX_PET_MESSAGE_LENGTH, useGeneralChat, usePersonaChat, usePetChat } from '../src/features/pets/usePetChat.ts'

const month = '2026-11'
const pet = { name: '测试狐', description: '好奇', greetings: ['一起查线索？'] }

// Keep the asynchronous repository boundary in these composable tests. Each open view can be
// disposed completely and rehydrated from stored rows without using the user's WebView profile.
function memoryRepository() {
  const saved = new Map()
  const listeners = new Set()
  const epochs = new Map()
  let globalEpoch = 0
  const key = scope => JSON.stringify(scope)
  const fence = scope => JSON.stringify([globalEpoch, epochs.get(scope.petId) ?? 0])
  const blank = id => ({ id, draft: '', exchanges: [] })
  const emit = change => { for (const listener of listeners) listener(change) }
  return {
    emit,
    async load(scope) {
      const row = saved.get(key(scope))
      return { ...structuredClone(row ?? { chats: [], selectedId: 0 }), fence: fence(scope) }
    },
    async loadDraft(scope, expected, id) {
      const chat = saved.get(key(scope))?.chats.find(item => item.id === id)
      if (fence(scope) !== expected || !chat) throw new Error('CHAT_CACHE_CHANGED')
      return chat.draft
    },
    async write(scope, expected, op) {
      if (fence(scope) !== expected) throw new Error('CHAT_CACHE_CHANGED')
      const row = saved.get(key(scope)) ?? { chats: [blank(1)], selectedId: 1 }
      saved.set(key(scope), row)
      if (op.type === 'create') {
        row.chats.push(blank(op.id))
        row.selectedId = op.id
        return
      }
      const index = row.chats.findIndex(chat => chat.id === op.id)
      if (index < 0) throw new Error('CHAT_CACHE_CHANGED')
      const thread = row.chats[index]
      if (op.type === 'select') row.selectedId = op.id
      if (op.type === 'draft') thread.draft = op.text
      if (op.type === 'exchange') {
        const old = thread.exchanges.find(turn => turn.exchangeId === op.exchangeId)
        const exchange = structuredClone(op.exchange)
        if (old) Object.assign(old, exchange)
        else thread.exchanges.push(exchange)
        if (thread.draft.trim() === exchange.question) thread.draft = ''
      }
      if (op.type === 'delete') {
        row.chats.splice(index, 1)
        if (!row.chats.length) row.chats.push(blank(op.replacementId))
        if (row.selectedId === op.id) row.selectedId = row.chats[Math.max(0, index - 1)].id
      }
    },
    async clear(petId) {
      for (const key of saved.keys()) if (petId === undefined || JSON.parse(key).petId === petId) saved.delete(key)
      if (petId === undefined) globalEpoch++
      else epochs.set(petId, (epochs.get(petId) ?? 0) + 1)
      emit({ petId })
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
  }
}

let storage
test.beforeEach(t => {
  storage = memoryRepository()
  for (const method of ['load', 'loadDraft', 'write', 'clear', 'subscribe']) t.mock.method(chatStorage, method, storage[method])
})
test.afterEach(() => flushChatHistory())

async function whenReady(chat) {
  if (!chat.ready.value) await chat.retryStorage()
  assert.equal(chat.ready.value, true)
  return chat
}

async function openChat(t, character, request, selectedMonth = month, enter = usePetChat) {
  const scope = effectScope()
  t.after(() => scope.stop())
  const chat = scope.run(() => enter(character, selectedMonth, request))
  await whenReady(chat)
  return { ...chat, close: () => scope.stop() }
}

function ask(chat, question, facts, details) {
  chat.draft.value = question
  return chat.send('zh-CN', facts, details)
}

test('重复新建只保留一个空白聊天，草稿和对话仍可从另一个窗口继续', async t => {
  const character = { ...pet, id: 'reuse-empty' }
  const request = async () => '收到。'
  const first = await openChat(t, character, request)
  const second = await openChat(t, character, request)
  first.close()
  const original = second.activeConversationId.value
  for (let i = 0; i < 50; i++) second.newChat()
  assert.equal(second.conversations.value.length, 1)
  await ask(second, '保留的对话')
  second.newChat()
  second.draft.value = '保留的草稿'
  const draftId = second.activeConversationId.value
  second.newChat()
  const emptyId = second.activeConversationId.value
  for (let i = 0; i < 50; i++) {
    second.selectChat(original)
    second.newChat()
    assert.equal(second.activeConversationId.value, emptyId)
  }
  assert.equal(second.conversations.value.length, 3)
  second.close()
  const reopened = await openChat(t, character, request)
  reopened.selectChat(original)
  assert.equal(reopened.messages.value.length, 2)
  reopened.selectChat(draftId)
  assert.equal(reopened.draft.value, '保留的草稿')
})

test('移除角色释放所有月份聊天，其他角色和通用聊天的草稿仍保留', async t => {
  const character = { ...pet, id: 'imported-forgotten' }
  const request = async () => '收到。'
  for (const selectedMonth of [month, '2028-01']) {
    const pane = await openChat(t, character, request, selectedMonth)
    await ask(pane, '合成账单')
    pane.close()
  }
  const other = await openChat(t, { ...pet, id: 'other-preserved' }, request)
  other.draft.value = '其他角色'
  const scope = effectScope()
  t.after(() => scope.stop())
  const general = await whenReady(scope.run(() => useGeneralChat(month, request)))
  general.draft.value = '通用聊天草稿'
  await forgetPetChats(character.id)
  for (const selectedMonth of [month, '2028-01']) {
    assert.deepEqual((await openChat(t, character, request, selectedMonth)).messages.value, [])
  }
  assert.equal((await openChat(t, { ...pet, id: 'other-preserved' }, request)).draft.value, '其他角色')
  assert.equal(scope.run(() => useGeneralChat(month, request)).draft.value, '通用聊天草稿')
})

test('待确认写入期间关闭空白窗口，重开后能收到同一笔写入的回执', async t => {
  const character = { ...pet, id: 'pending-reopen-receipt' }
  const saved = Promise.withResolvers()
  const request = async (_input, signal, run) => {
    await run('create_bill', {}, signal)
    throw new Error('AI_CANCELLED')
  }
  const chat = await openChat(t, character, request)
  chat.draft.value = '合成账单'
  const pending = chat.send('zh-CN', undefined, undefined, () => saved.promise)
  chat.draft.value = ''
  chat.close()
  const reopened = await openChat(t, character, request)
  saved.resolve({ status: 'applied', message: '已保存' })
  assert.equal(await pending, true)
  assert.deepEqual(reopened.messages.value.map(item => item.content), ['合成账单', '已保存'])
})

test('a confirmed write that finishes after switching threads leaves the receipt in its original chat', async t => {
  const saved = Promise.withResolvers()
  const chat = await openChat(t, { ...pet, id: 'receipt-after-switch' }, async (_input, signal, run) => {
    await run('create_bill', {}, signal)
    throw new Error('AI_CANCELLED')
  })
  chat.draft.value = '添加账单'
  const pending = chat.send('zh-CN', undefined, undefined, () => saved.promise)
  const original = chat.activeConversationId.value
  chat.newChat()
  saved.resolve({ status: 'saved_pending_refresh', message: '已保存，请重新读取。' })
  assert.equal(await pending, true)
  assert.deepEqual(chat.messages.value, [])
  chat.selectChat(original)
  assert.deepEqual(chat.messages.value.map(item => item.content), ['添加账单', '已保存，请重新读取。'])
  assert.equal(chat.draft.value, '')
})

test('several action results share one transcript entry and native error details stay in the visible chat', async t => {
  const calls = []
  const chat = await openChat(t, { ...pet, id: 'mixed-receipt' }, async (input, signal, run) => {
    calls.push(input)
    if (!run) return 'OK'
    await run('create_platform', {}, signal)
    await run('update_budget', {}, signal)
    return 'tool batch'
  })
  chat.draft.value = '新增平台并调整预算'
  await chat.send('zh-CN', undefined, undefined, async name => name === 'create_platform'
    ? { status: 'applied', message: '平台已创建。' }
    : { status: 'failed', message: '写入失败，包含仅本机可见字段。' })
  assert.deepEqual(chat.messages.value.map(item => item.content), ['新增平台并调整预算', '平台已创建。\n写入失败，包含仅本机可见字段。'])
  await ask(chat, '上次成功了吗？')
  assert.ok(calls[1].messages[1].content.includes('平台已创建。'))
  assert.ok(!JSON.stringify(calls[1]).includes('仅本机可见'))
})

test('勾选只附四个汇总字段，取消勾选后历史中引用的金额留在本机', async t => {
  const calls = []
  const chat = await openChat(t, { ...pet, id: 'summary' }, async input => {
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
  const chat = await openChat(t, { ...pet, id: 'bounded-history' }, async input => {
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
  const chat = await openChat(t, { ...pet, id: 'retry' }, (_input, signal) => {
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
  const first = await openChat(t, character, async () => '十一月见。')
  await ask(first, '你好')
  first.close()
  const pending = Promise.withResolvers()
  let signal
  const second = await openChat(t, character, (_input, requestSignal) => {
    signal = requestSignal
    return pending.promise
  })
  const closing = ask(second, '草稿')
  second.close()
  assert.equal(signal.aborted, true)
  for (const [id, selectedMonth] of [['other', month], [character.id, '2026-12']]) {
    const other = await openChat(t, { ...pet, id }, async () => '', selectedMonth)
    assert.deepEqual(other.messages.value, [])
    assert.equal(other.draft.value, '')
  }
  const reopened = await openChat(t, character, async () => '再见。')
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
  const chat = await openChat(t, imported, async input => { inputs.push(input); return 'Hello' })
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
  const fallback = await openChat(t, { ...imported, id: 'no-dialogue-example', dialogueExample: undefined },
    async input => { inputs.push(input); return '你好' })
  assert.equal(await ask(fallback, '你好'), true)
  assert.equal(inputs[1].character.voiceSample, '首句')
  assert.ok(!Object.hasOwn(inputs[1].character, 'opening'))
})

test('同一个角色和月份可以保留多个聊天的独立草稿与上下文，重开继续当前聊天', async t => {
  const character = { ...pet, id: 'separate-topics' }
  const calls = []
  const request = async input => { calls.push(input); return '回复' + calls.length }
  const chat = await openChat(t, character, request)
  const first = chat.activeConversationId.value
  assert.equal(typeof first, 'number')
  assert.equal(await ask(chat, '第一段问题'), true)
  chat.draft.value = '第一段草稿'
  chat.newChat()
  const second = chat.activeConversationId.value
  assert.notEqual(first, second)
  assert.deepEqual(chat.messages.value, [])
  assert.equal(chat.draft.value, '')
  assert.equal(await ask(chat, '第二段问题'), true)
  assert.deepEqual(calls[1].messages, [{ role: 'user', content: '第二段问题' }])
  chat.draft.value = '第二段草稿'
  assert.deepEqual(new Set(chat.conversations.value.map(item => item.id)), new Set([first, second]))
  assert.ok(chat.conversations.value.every(item => typeof item.title === 'string' && item.title.trim()))
  chat.selectChat(first)
  assert.equal(chat.draft.value, '第一段草稿')
  assert.deepEqual(chat.messages.value.map(item => item.content), ['第一段问题', '回复1'])
  assert.equal(await chat.send('zh-CN'), true)
  assert.deepEqual(calls[2].messages.map(item => item.content), ['第一段问题', '回复1', '第一段草稿'])
  chat.selectChat(second)
  chat.close()
  const reopened = await openChat(t, character, request)
  assert.equal(reopened.activeConversationId.value, second)
  assert.equal(reopened.draft.value, '第二段草稿')
  assert.deepEqual(reopened.messages.value.map(item => item.content), ['第二段问题', '回复2'])
})

test('新建或切换聊天会中止请求，迟到结果不会进入任一对话或覆盖草稿', async t => {
  const calls = []
  const chat = await openChat(t, { ...pet, id: 'switch-while-pending' }, (_input, signal) => {
    const deferred = Promise.withResolvers()
    calls.push({ signal, ...deferred })
    return deferred.promise
  })
  const first = chat.activeConversationId.value
  const inFirst = ask(chat, '第一段待发送')
  chat.newChat()
  const second = chat.activeConversationId.value
  assert.equal(calls[0].signal.aborted, true)
  assert.equal(chat.pending.value, false)
  const inSecond = ask(chat, '第二段待发送')
  calls[0].resolve('第一段迟到回复')
  assert.equal(await inFirst, false)
  assert.equal(chat.pending.value, true)
  chat.selectChat(first)
  assert.equal(calls[1].signal.aborted, true)
  assert.equal(chat.pending.value, false)
  calls[1].reject(new Error('AI_NETWORK'))
  assert.equal(await inSecond, false)
  assert.equal(chat.error.value, '')
  assert.deepEqual(chat.messages.value, [])
  assert.equal(chat.draft.value, '第一段待发送')
  chat.selectChat(second)
  assert.deepEqual(chat.messages.value, [])
  assert.equal(chat.draft.value, '第二段待发送')
})

test('明细要求同月汇总和非空选择，只发送所选行的展示字段', async t => {
  const calls = []
  const chat = await openChat(t, { ...pet, id: 'detail-validation' }, async input => { calls.push(input); return '好。' })
  const facts = { month, balanceCents: 75000, dueCents: 5000, warningFloorCents: 60000 }
  const estimate = { platform: '平台甲', title: '待补款', kind: 'estimate', status: 'estimated', amountCents: 6000, depositCents: 1500 }
  const installment = { platform: '平台乙', title: '分期', kind: 'installment', status: 'due', amountCents: 5000, installmentIndex: 2, installmentCount: 6 }
  const details = { month, entries: [estimate, installment] }
  for (const [summary, selection] of [
    [undefined, details],
    [{ ...facts, month: '2026-12' }, details],
    [facts, { ...details, month: '2026-12' }],
    [facts, { month, entries: [] }],
  ]) {
    assert.equal(await ask(chat, '核对明细', summary, selection), false)
    assert.equal(chat.error.value, 'AI_INVALID_INPUT')
  }
  assert.equal(calls.length, 0)
  const localEntries = details.entries.map(row => ({ ...row, id: '本地记录ID', notes: '私有备注' }))
  assert.equal(await ask(chat, '核对明细', facts, { month, entries: localEntries, other: '额外字段' }), true)
  assert.deepEqual(calls[0].details, details)
  assert.deepEqual(calls[0].facts, facts)
})

test('相同明细选择允许追问，收窄到其他子集、汇总或关闭共享时排除之前的敏感历史', async t => {
  const calls = []
  const chat = await openChat(t, { ...pet, id: 'detail-history' }, async input => {
    calls.push(input)
    return input.details ? input.details.entries.map(row => row.title).join('和') : '聊别的。'
  })
  const facts = { month, balanceCents: 20000, dueCents: 1000, warningFloorCents: 5000 }
  const first = { platform: '平台甲', title: '合成条目甲', kind: 'single', status: 'due', amountCents: 600 }
  const second = { platform: '平台甲', title: '合成条目乙', kind: 'single', status: 'due', amountCents: 400 }
  const both = { month, entries: [first, second] }
  const subset = { month, entries: [second] }
  assert.equal(await ask(chat, '看这两笔', facts, both), true)
  assert.equal(await ask(chat, '再解释一下', facts, structuredClone(both)), true)
  assert.deepEqual(calls[1].messages.map(item => item.content), ['看这两笔', '合成条目甲和合成条目乙', '再解释一下'])
  assert.equal(await ask(chat, '只看这一笔', facts, subset), true)
  assert.deepEqual(calls[2].messages, [{ role: 'user', content: '只看这一笔' }])
  assert.ok(!JSON.stringify(calls[2]).includes(first.title))
  assert.equal(await ask(chat, '只聊汇总', facts), true)
  assert.ok(!Object.hasOwn(calls[3], 'details'))
  assert.deepEqual(calls[3].messages, [{ role: 'user', content: '只聊汇总' }])
  assert.equal(await ask(chat, '再看一笔', facts, subset), true)
  assert.equal(await ask(chat, '换个话题'), true)
  assert.ok(!Object.hasOwn(calls[5], 'facts'))
  assert.ok(!Object.hasOwn(calls[5], 'details'))
  assert.deepEqual(calls[5].messages, [{ role: 'user', content: '换个话题' }])
})

test('扩大明细选择可继续追问，减少完全相同的账目笔数也会截断历史', async t => {
  const calls = []
  const chat = await openChat(t, { ...pet, id: 'detail-multiplicity' }, async input => {
    calls.push(input)
    return '刚才选择了 ' + input.details.entries.length + ' 笔。'
  })
  const facts = { month, balanceCents: 90000, dueCents: 1600, warningFloorCents: 5000 }
  const identical = { platform: '平台', title: '两条完全相同的账', kind: 'single', status: 'due', amountCents: 500 }
  const another = { ...identical, title: '另一条账', amountCents: 600 }
  assert.equal(await ask(chat, '看这两笔', facts, { month, entries: [identical, { ...identical }] }), true)
  assert.equal(await ask(chat, '加一笔', facts, { month, entries: [another, identical, { ...identical }] }), true)
  assert.deepEqual(calls[1].messages.map(item => item.content), ['看这两笔', '刚才选择了 2 笔。', '加一笔'])
  assert.equal(await ask(chat, '从重复的两笔中取消一笔', facts, { month, entries: [identical, another] }), true)
  assert.deepEqual(calls[2].messages, [{ role: 'user', content: '从重复的两笔中取消一笔' }])
})

test('通用聊天可独立发送日常话题，按月份保存对话，收窄分享时截断账务历史', async t => {
  const scope = effectScope()
  t.after(() => scope.stop())
  const calls = []
  const request = async input => {
    calls.push(input)
    return input.details ? '这笔待还 12 元。' : '下雨的傍晚，我们出发了。'
  }
  const selectedMonth = '2027-04'
  const general = await whenReady(scope.run(() => useGeneralChat(selectedMonth, request)))
  const petChat = await openChat(t, { ...pet, id: 'general' }, request, selectedMonth)
  assert.equal(await ask(petChat, '你好，小狐！'), true)
  assert.equal(calls[0].mode, 'pet')
  assert.deepEqual(general.messages.value, [])
  assert.equal(await ask(general, '帮我写一句短篇故事的开头'), true)
  assert.equal(calls[1].mode, 'general')
  assert.ok(!Object.hasOwn(calls[1], 'character'))
  assert.ok(!Object.hasOwn(calls[1], 'facts'))
  assert.ok(!Object.hasOwn(calls[1], 'details'))

  const facts = { month: selectedMonth, balanceCents: 10000, dueCents: 1200, warningFloorCents: 0 }
  const details = { month: selectedMonth, entries: [{ platform: '合成平台', title: '合成账目', kind: 'single', status: 'due', amountCents: 1200 }] }
  assert.equal(await ask(general, '选中的账单待还多少？', facts, details), true)
  assert.deepEqual(calls[2].details, details)
  assert.equal(await ask(general, '继续写故事'), true)
  assert.deepEqual(calls[3].messages, [{ role: 'user', content: '继续写故事' }])
  assert.equal(petChat.messages.value.length, 2)

  general.draft.value = '没写完的问题'
  const reopened = await whenReady(scope.run(() => useGeneralChat(selectedMonth, request)))
  assert.equal(reopened.draft.value, '没写完的问题')
  assert.equal(reopened.messages.value.length, 6)
  const otherMonth = await whenReady(scope.run(() => useGeneralChat('2027-05', request)))
  assert.deepEqual(otherMonth.messages.value, [])
  assert.equal(otherMonth.draft.value, '')
})

test('full-page personas carry their card and keep separate conversations from the pet window and each other', async t => {
  const calls = []
  const request = async input => { calls.push(input); return '我们可以接着讨论。' }
  const selectedMonth = '2029-01'
  const profile = { ...pet, id: 'role-one', description: '设'.repeat(5100), scenario: '潮湿的雨夜',
    dialogueExample: '声'.repeat(6100), greetings: ['开'.repeat(5000)] }
  const menu = await openChat(t, profile, request, selectedMonth, usePersonaChat)
  const modal = await openChat(t, profile, request, selectedMonth)
  const other = await openChat(t, { ...pet, id: 'role-two' }, request, selectedMonth, usePersonaChat)
  const question = '🧭'.repeat(MAX_MENU_MESSAGE_LENGTH)
  assert.equal(await ask(menu, question), true)
  assert.equal(calls[0].mode, 'persona')
  assert.deepEqual(calls[0].character, { name: pet.name, description: profile.description,
    scenario: profile.scenario, opening: profile.greetings[0], voiceSample: profile.dialogueExample })
  assert.equal(calls[0].facts, undefined)
  assert.equal(calls[0].details, undefined)
  menu.draft.value = '还没写完的小说'
  modal.draft.value = '桌宠草稿'
  other.draft.value = '另一个人设'
  assert.deepEqual(modal.messages.value, [])
  assert.deepEqual(other.messages.value, [])
  menu.close()
  const back = await openChat(t, profile, request, selectedMonth, usePersonaChat)
  assert.equal(back.messages.value[0].content, question)
  assert.equal(back.draft.value, '还没写完的小说')
  assert.equal(await ask(back, question + '字'), false)
  assert.equal(await ask(modal, question), false)
  assert.equal(await ask(modal, '你好呀'), true)
  assert.equal(calls.at(-1).mode, 'pet')
  assert.equal(calls.at(-1).character.scenario, undefined)
  assert.equal(calls.at(-1).character.description.length, 2000)
  assert.equal(calls.at(-1).character.voiceSample.length, 500)
  back.close()
  modal.close()
  await forgetPetChats(profile.id)
  assert.deepEqual((await openChat(t, profile, request, selectedMonth, usePersonaChat)).messages.value, [])
  assert.deepEqual((await openChat(t, profile, request, selectedMonth)).messages.value, [])
  assert.equal(other.draft.value, '另一个人设')
})

test('menu chat resends whole, permitted exchanges within the shared character budget', async t => {
  const scope = effectScope()
  t.after(() => scope.stop())
  const calls = []
  const content = '🦊'.repeat(MAX_MENU_MESSAGE_LENGTH)
  const chat = await whenReady(scope.run(() => useGeneralChat('2029-02', async input => {
    calls.push(input)
    return input.messages.at(-1).content === content ? content : '答'
  })))
  for (let i = 0; i < 18; i++) await ask(chat, '问' + i)
  assert.equal(calls.at(-1).messages.length, 33)
  assert.equal(calls.at(-1).messages[0].content, '问1')
  for (let i = 0; i < 3; i++) assert.equal(await ask(chat, content), true)
  assert.equal(calls.at(-1).messages.length, 3)
  assert.ok(calls.at(-1).messages.every(item => item.content === content))
  assert.equal(chat.messages.value.length, 42)
  const facts = { month: '2029-02', balanceCents: 123, dueCents: 0, warningFloorCents: 0 }
  await ask(chat, '分享汇总', facts)
  await ask(chat, '切回日常聊天')
  assert.deepEqual(calls.at(-1).messages, [{ role: 'user', content: '切回日常聊天' }])
})

test('switching out of a persona aborts the old request and a late response cannot enter another conversation', async t => {
  let signal
  const pending = Promise.withResolvers()
  const selectedMonth = '2029-03'
  const role = { ...pet, id: 'role-awaiting' }
  const old = await openChat(t, role, (_input, control) => { signal = control; return pending.promise }, selectedMonth, usePersonaChat)
  const result = ask(old, '给我一个故事')
  old.close()
  assert.equal(signal.aborted, true)
  const other = await openChat(t, { ...pet, id: 'other-role' }, async () => '新的回复', selectedMonth, usePersonaChat)
  pending.resolve('过期回复')
  assert.equal(await result, false)
  assert.deepEqual(other.messages.value, [])
  const back = await openChat(t, role, async () => '', selectedMonth, usePersonaChat)
  assert.equal(back.draft.value, '给我一个故事')
  assert.deepEqual(back.messages.value, [])
})

test('disposing the last view unloads it and restart restores selected conversation, drafts and scoped context', async t => {
  const role = { ...pet, id: 'stored-restart' }
  const sent = []
  const request = async input => { sent.push(input); return input.facts ? '待还 123 元' : '好的' }
  const first = await openChat(t, role, request, month, usePersonaChat)
  const original = first.activeConversationId.value
  await ask(first, '核对合成账单', { month, balanceCents: 0, dueCents: 12300, warningFloorCents: 0 })
  first.draft.value = '用于续聊的草稿'
  first.newChat()
  first.draft.value = '另一个独立草稿'
  const selected = first.activeConversationId.value
  await flushChatHistory()
  first.close()
  const reads = chatStorage.load.mock.callCount()
  const restored = await openChat(t, role, request, month, usePersonaChat)
  assert.ok(chatStorage.load.mock.callCount() > reads)
  assert.equal(restored.activeConversationId.value, selected)
  assert.equal(restored.draft.value, '另一个独立草稿')
  restored.selectChat(original)
  assert.equal(restored.messages.value[1].content, '待还 123 元')
  assert.equal(restored.draft.value, '用于续聊的草稿')
  await ask(restored, '继续聊天')
  assert.deepEqual(sent.at(-1).messages, [{ role: 'user', content: '继续聊天' }])
  assert.equal(restored.storageError.value, '')
})

test('deleting an active conversation cancels review and a late confirmed receipt cannot recreate it', async t => {
  const role = { ...pet, id: 'delete-one' }
  const gate = Promise.withResolvers()
  let signal
  const chat = await openChat(t, role, async (_input, control, run) => {
    signal = control
    await run('create_bill', {}, control)
    return '回执'
  })
  const first = chat.activeConversationId.value
  chat.draft.value = '保留其他一段'
  chat.newChat()
  const deleted = chat.activeConversationId.value
  chat.draft.value = '新增账单'
  const response = chat.send('zh-CN', undefined, undefined, () => gate.promise)
  assert.equal(await chat.deleteChat(deleted), true)
  assert.equal(signal.aborted, true)
  assert.equal(chat.activeConversationId.value, first)
  gate.resolve({ status: 'applied', message: '迟到回执' })
  await response
  await flushChatHistory()
  chat.close()
  const reopened = await openChat(t, role, async () => '你好')
  assert.equal(reopened.draft.value, '保留其他一段')
  assert.deepEqual(reopened.conversations.value.map(c => c.id), [first])
  assert.equal(await reopened.deleteChat(first), true)
  assert.notEqual(reopened.activeConversationId.value, first)
  assert.equal(reopened.draft.value, '')
  assert.deepEqual(reopened.messages.value, [])
})

test('role and all-cache clears invalidate open views across modes and reject stale writes', async t => {
  const role = { ...pet, id: 'clear-role' }
  const waiting = Promise.withResolvers()
  let signal
  const menu = await openChat(t, role, async (_input, control) => { signal = control; return waiting.promise }, month, usePersonaChat)
  const popup = await openChat(t, role, async () => '好', '2030-01')
  const other = await openChat(t, { ...pet, id: 'keep-role' }, async () => '好')
  const gs = effectScope()
  t.after(() => gs.stop())
  const general = await whenReady(gs.run(() => useGeneralChat('2030-01', async () => '好')))
  popup.draft.value = '桌宠草稿'
  other.draft.value = '另一个角色'
  general.draft.value = '独立通用草稿'
  const pending = ask(menu, '等待读取')
  await chatStorage.clear(role.id)
  assert.equal(signal.aborted, true)
  waiting.resolve('已经清除的回复')
  assert.equal(await pending, false)
  await menu.retryStorage()
  await popup.retryStorage()
  assert.equal(menu.draft.value, '')
  assert.equal(menu.scopeGeneration.value, 1)
  assert.deepEqual(menu.messages.value, [])
  assert.equal(popup.draft.value, '')
  assert.equal(general.draft.value, '独立通用草稿')
  assert.equal(other.draft.value, '另一个角色')
  await chatStorage.clear(null)
  assert.equal(general.draft.value, '')
  assert.equal(other.draft.value, '另一个角色')
  await chatStorage.clear()
  assert.equal(other.draft.value, '')
})

test('failed draft and deletion show storage errors, retry saves outstanding changes without retrying deletion', async t => {
  const role = { ...pet, id: 'retry-chat-storage' }
  const chat = await openChat(t, role, async () => '好')
  await ask(chat, '保留这段问答')
  await flushChatHistory()
  const id = chat.activeConversationId.value
  chatStorage.write.mock.mockImplementation(async () => { throw new Error('CHAT_CACHE_STORAGE') })
  chat.draft.value = '暂时无法写入草稿'
  assert.equal(await chat.deleteChat(id), false)
  assert.equal(chat.storageError.value, 'CHAT_CACHE_STORAGE')
  assert.equal(chat.activeConversationId.value, id)
  await assert.rejects(flushChatHistory(), /CHAT_CACHE_STORAGE/)
  chatStorage.write.mock.mockImplementation(storage.write)
  await chat.retryStorage()
  assert.equal(chat.storageError.value, '')
  chat.close()
  const reopened = await openChat(t, role, async () => '好')
  assert.equal(reopened.activeConversationId.value, id)
  assert.equal(reopened.draft.value, '暂时无法写入草稿')
  assert.deepEqual(reopened.messages.value.map(message => message.content), ['保留这段问答', '好'])
})

test('remote draft changes read only the thread, and a concurrent local draft wins over a delayed read', async t => {
  const role = { ...pet, id: 'two-drafts' }
  const scope = { mode: 'pet', petId: role.id, month }
  const chat = await openChat(t, role, async () => '好')
  chat.draft.value = '本机首个草稿'
  await flushChatHistory()
  const reads = chatStorage.load.mock.callCount()
  const id = chat.activeConversationId.value
  const { fence } = await storage.load(scope)
  await storage.write(scope, fence, { type: 'draft', id, text: '另一窗口' })
  const read = Promise.withResolvers()
  chatStorage.loadDraft.mock.mockImplementation(() => read.promise)
  storage.emit({ scope, op: { type: 'draft', id } })
  chat.draft.value = '比远端更新的草稿'
  read.resolve('另一窗口')
  await flushChatHistory()
  assert.equal(chatStorage.load.mock.callCount(), reads)
  assert.equal(chat.draft.value, '比远端更新的草稿')
  assert.equal(await storage.loadDraft(scope, fence, id), chat.draft.value)
})

test('a delayed clear or delete broadcast cannot affect a draft in the new generation', async t => {
  const role = { ...pet, id: 'delayed-broadcast' }
  const scope = { mode: 'pet', petId: role.id, month }
  const chat = await openChat(t, role, async () => '好')
  const before = (await storage.load(scope)).fence
  await chatStorage.clear(role.id)
  await chat.retryStorage()
  const after = (await storage.load(scope)).fence
  const generation = chat.scopeGeneration.value
  chat.draft.value = '新的草稿'
  storage.emit({ scope, fence: before, op: { type: 'delete', id: 1 } })
  storage.emit({ petId: role.id, fence: after })
  assert.equal(chat.scopeGeneration.value, generation)
  assert.equal(chat.draft.value, '新的草稿')
  await flushChatHistory()
  assert.equal(await storage.loadDraft(scope, after, 1), '新的草稿')
})

test('an external selection is remembered for restart without interrupting the current window', async t => {
  const role = { ...pet, id: 'independent-window-selection' }
  const scope = { mode: 'pet', petId: role.id, month }
  const chat = await openChat(t, role, async () => '好')
  const current = chat.activeConversationId.value
  chat.draft.value = '手边的草稿'
  await flushChatHistory()
  const { fence } = await storage.load(scope)
  await storage.write(scope, fence, { type: 'create', id: 85 })
  storage.emit({ scope, fence, op: { type: 'create', id: 85 } })
  await chat.retryStorage()
  assert.equal(chat.activeConversationId.value, current)
  assert.equal(chat.draft.value, '手边的草稿')
  assert.deepEqual(chat.conversations.value.map(item => item.id), [85, current])
  chat.close()
  const reopened = await openChat(t, role, async () => '好')
  assert.equal(reopened.activeConversationId.value, 85)
})
