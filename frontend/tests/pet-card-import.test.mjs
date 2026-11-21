import assert from 'node:assert/strict'
import test from 'node:test'
import { crc32, deflateSync } from 'node:zlib'
import { parsePetCard, PetCardImportError } from '../src/features/pets/cardImport.ts'

const character = { name: '猫头鹰🦉', description: '山里的会计', personality: '干练', first_mes: '我是 {{char}}。' }
const jsonFile = value => new Blob(['\uFEFF  ', JSON.stringify(value)])
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const compressedPixel = deflateSync(Buffer.from([0, 255, 255, 255, 255]))
const imageEnd = chunk('IEND', Buffer.alloc(0))

function chunk(type, contents) {
  const frame = Buffer.alloc(12 + contents.length)
  frame.writeUInt32BE(contents.length)
  frame.write(type, 4)
  contents.copy(frame, 8)
  frame.writeUInt32BE(crc32(frame.subarray(4, -4)), frame.length - 4)
  return frame
}

function png(metadata = [], width = 1, height = 1, imageParts = [compressedPixel]) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  return new Blob([signature, chunk('IHDR', header), ...imageParts.map(data => chunk('IDAT', data)), ...metadata, imageEnd])
}

function cardChunk(key, data) {
  const encoded = Buffer.from(JSON.stringify(data)).toString('base64')
  return chunk('tEXt', Buffer.from(key + '\0' + encoded))
}

const hasError = code => error => error instanceof PetCardImportError && error.code === code

test('menu persona imports retain the setting and longer dialogue without splitting Unicode characters', async () => {
  const text = '🦉'.repeat(600) + ' 记得那座灯塔。'
  const data = { ...character, scenario: '{{char}}与{{user}}在灯塔值班。', mes_example: text }
  const card = await parsePetCard(jsonFile({ spec: 'chara_card_v2', data }))
  assert.equal(card.scenario, character.name + '与{{user}}在灯塔值班。')
  assert.equal(card.dialogueExample, text)
  const oversized = await parsePetCard(jsonFile({ ...character, scenario: '🦊'.repeat(8200), mes_example: '🦉'.repeat(8200) }))
  assert.equal(oversized.scenario, '🦊'.repeat(8192))
  assert.equal(oversized.dialogueExample, '🦉'.repeat(8192))
})

test('flat V1 JSON and nested V2/V3 cards retain authored text and only the supported fields', async () => {
  assert.deepEqual(await parsePetCard(jsonFile(character)), {
    name: '猫头鹰🦉', description: '山里的会计', personality: '干练', greetings: ['我是 猫头鹰🦉。'],
  })
  const withDialogue = await parsePetCard(jsonFile({ ...character, mes_example: '{{char}}：你好，{{user}}！' }))
  assert.equal(withDialogue.dialogueExample, character.name + '：你好，{{user}}！')
  for (const version of [2, 3]) {
    const data = { ...character, nickname: '小账', alternate_greetings: ['你好，{{user}}', '', '你好，{{user}}', 5],
      avatar: 'https://example.org/image.png', assets: [{ type: 'icon', uri: 'https://example.org/other.png' }],
      system_prompt: 'system instructions', character_book: { entries: [] }, extensions: { extra: true } }
    const result = await parsePetCard(jsonFile({ name: '兼容用旧名字', spec: 'chara_card_v' + version, data }))
    assert.deepEqual(result, { name: character.name, description: character.description, personality: character.personality,
      greetings: [`我是 ${version === 3 ? '小账' : character.name}。`, '你好，{{user}}'] })
  }
})

test('SillyTavern PNG metadata prefers ccv3 in either order and preserves just the still image', async () => {
  const v2 = cardChunk('ChArA', { spec: 'chara_card_v2', data: character })
  const v3 = cardChunk('ccv3', { spec: 'chara_card_v3', data: { ...character, name: '侦探狐🦊' } })
  const plainImage = Buffer.from(await png().arrayBuffer())
  for (const metadata of [[v2], [v2, v3], [v3, v2]]) {
    const result = await parsePetCard(png(metadata))
    assert.equal(result.name, metadata.length === 1 ? character.name : '侦探狐🦊')
    assert.deepEqual(result.greetings, [`我是 ${result.name}。`])
    assert.equal(result.avatar.type, 'image/png')
    assert.deepEqual(Buffer.from(await result.avatar.arrayBuffer()), plainImage)
  }
})

test('PNG accepts split zlib headers and rejects malformed IDAT streams even with valid chunk CRCs', async () => {
  const meta = [cardChunk('chara', character)]
  const split = [compressedPixel.subarray(0, 1), Buffer.alloc(0), compressedPixel.subarray(1)]
  const card = await parsePetCard(png(meta, 1, 1, split))
  assert.deepEqual(Buffer.from(await card.avatar.arrayBuffer()), Buffer.from(await png([], 1, 1, split).arrayBuffer()))
  for (const parts of [
    [Buffer.from('broken pixels')],
    [compressedPixel.subarray(0, 2)],
    [Buffer.from([0x78]), Buffer.from([0x9d]), compressedPixel.subarray(2)],
    [Buffer.from([0x78, 0x20]), compressedPixel.subarray(2)], // preset dictionary
    [Buffer.from([0x88, 0x1c]), compressedPixel.subarray(2)], // window larger than 32 KiB
  ]) {
    await assert.rejects(parsePetCard(png(meta, 1, 1, parts)), hasError('invalid'))
  }
})

test('missing cards, malformed PNG metadata, invalid envelopes and excessive sizes return import errors', async () => {
  await assert.rejects(parsePetCard(png()), hasError('noCard'))
  await assert.rejects(parsePetCard(jsonFile({ name: '不是角色卡' })), hasError('noCard'))
  await assert.rejects(parsePetCard(jsonFile({ spec: 'chara_card_v9', data: character })), hasError('unsupported'))
  await assert.rejects(parsePetCard(jsonFile({ spec: 'chara_card_v2', data: [] })), hasError('invalid'))
  await assert.rejects(parsePetCard(jsonFile({ ...character, name: ' ' })), hasError('invalid'))
  await assert.rejects(parsePetCard(new Blob(['{'])), hasError('invalid'))
  await assert.rejects(parsePetCard(png([chunk('tEXt', Buffer.from('chara\0**'))])), hasError('invalid'))
  const image = png([cardChunk('chara', character)])
  await assert.rejects(parsePetCard(image.slice(0, -5)), hasError('invalid'))
  await assert.rejects(parsePetCard(png([], 5000, 5000)), hasError('tooLarge'))
  await assert.rejects(parsePetCard(new Blob([new Uint8Array(16 * 1024 * 1024 + 1)])), hasError('tooLarge'))
})
