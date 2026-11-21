export interface ImportedPetCard {
  name: string
  description: string
  personality: string
  scenario?: string
  greetings: string[]
  dialogueExample?: string
  avatar?: Blob
}

type ImportErrorCode = 'tooLarge' | 'unsupported' | 'invalid' | 'noCard'

export class PetCardImportError extends Error {
  readonly code: ImportErrorCode

  constructor(code: ImportErrorCode) {
    super(code)
    this.name = 'PetCardImportError'
    this.code = code
  }
}

const maxFileBytes = 16 * 1024 * 1024
const maxTextCharacters = 1024 * 1024
const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10]
const staticImageChunks = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'sRGB', 'gAMA', 'cHRM'])
const ascii = new TextDecoder('ascii')
const utf8 = new TextDecoder('utf-8', { fatal: true })

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function plainText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

// Limit even large imported profiles by Unicode code point without splitting an emoji.
export function clipCharacterText(text: string, limit: number): string {
  return Array.from(text.slice(0, limit * 2)).slice(0, limit).join('')
}

function readCharacter(json: string): ImportedPetCard {
  const envelope: unknown = JSON.parse(json)
  if (!isRecord(envelope)) throw new PetCardImportError('noCard')
  let data = envelope
  if (envelope.spec === 'chara_card_v2' || envelope.spec === 'chara_card_v3') {
    if (!isRecord(envelope.data)) throw new PetCardImportError('invalid')
    data = envelope.data
  } else if (envelope.spec !== undefined) {
    throw new PetCardImportError('unsupported')
  } else if (!['description', 'personality', 'scenario', 'first_mes', 'mes_example'].some(key => typeof data[key] === 'string')) {
    throw new PetCardImportError('noCard')
  }

  const name = plainText(data.name)
  if (!name) throw new PetCardImportError('invalid')
  const speaker = (envelope.spec === 'chara_card_v3' && plainText(data.nickname)) || name
  if (name.length > 512 || speaker.length > 512) throw new PetCardImportError('tooLarge')

  // Only the speaker name is substituted. All other text is inert display text.
  let remaining = maxTextCharacters
  function displayText(value: unknown): string {
    const text = plainText(value)
    let length = text.length
    if (length > remaining) throw new PetCardImportError('tooLarge')
    const result = text.replace(/\{\{char\}\}|<char>|<bot>/gi, match => {
      length += speaker.length - match.length
      if (length > remaining) throw new PetCardImportError('tooLarge')
      return speaker
    })
    remaining -= length
    return result
  }

  const greetings = new Set<string>()
  const first = displayText(data.first_mes)
  if (first) greetings.add(first)
  if (Array.isArray(data.alternate_greetings)) {
    for (const item of data.alternate_greetings) {
      const greeting = displayText(item)
      if (greeting) greetings.add(greeting)
      if (greetings.size > 256) throw new PetCardImportError('tooLarge')
    }
  }
  const card: ImportedPetCard = { name, description: displayText(data.description), personality: displayText(data.personality), greetings: [...greetings] }
  function profileExcerpt(value: unknown): string {
    const excerpt = clipCharacterText(plainText(value), 8192)
    return clipCharacterText(excerpt.replace(/\{\{char\}\}|<char>|<bot>/gi, () => speaker), 8192)
  }
  const scenario = profileExcerpt(data.scenario)
  if (scenario) card.scenario = scenario
  const sample = profileExcerpt(data.mes_example)
  if (sample) card.dialogueExample = sample
  return card
}

function readPng(bytes: Uint8Array<ArrayBuffer>): ImportedPetCard {
  const view = new DataView(bytes.buffer)
  const avatarParts: BlobPart[] = [bytes.subarray(0, 8)]
  let chara: Uint8Array | undefined
  let ccv3: Uint8Array | undefined
  const zlibHeader: number[] = []
  let imageBytes = 0
  let chunkCount = 0
  for (let offset = 8; offset + 12 <= bytes.length;) {
    if (++chunkCount > 65_536) throw new PetCardImportError('tooLarge')
    const length = view.getUint32(offset)
    const type = ascii.decode(bytes.subarray(offset + 4, offset + 8))
    const start = offset + 8
    const end = start + length
    if (end + 4 > bytes.length) throw new PetCardImportError('invalid')
    if (offset === 8 && type !== 'IHDR') throw new PetCardImportError('invalid')
    if (type === 'IHDR') {
      if (offset !== 8 || length !== 13) throw new PetCardImportError('invalid')
      const width = view.getUint32(start)
      const height = view.getUint32(start + 4)
      if (!width || !height) throw new PetCardImportError('invalid')
      if (width > 8192 || height > 8192 || width * height > 16_777_216) throw new PetCardImportError('tooLarge')
    }
    if (type === 'tEXt') {
      const keywordLength = bytes.subarray(start, Math.min(start + 80, end)).indexOf(0)
      if (keywordLength > 0) {
        const keyword = ascii.decode(bytes.subarray(start, start + keywordLength)).toLowerCase()
        if (keyword === 'ccv3') ccv3 ??= bytes.subarray(start + keywordLength + 1, end)
        if (keyword === 'chara') chara ??= bytes.subarray(start + keywordLength + 1, end)
      }
    }
    if (type === 'IDAT') {
      // IDAT boundaries can split the zlib header, even between its two bytes.
      for (let pos = start; pos < end && zlibHeader.length < 2; pos++) zlibHeader.push(bytes[pos])
      imageBytes += length
    }
    // Keep only the still portrait. Text, embedded assets and APNG frames are unused.
    if (staticImageChunks.has(type)) avatarParts.push(bytes.subarray(offset, end + 4))
    if (type === 'IEND') {
      if (length || imageBytes < 8) throw new PetCardImportError('invalid')
      const [method, flags] = zlibHeader
      // PNG requires zlib/deflate, a window <= 32 KiB, and no preset dictionary.
      if ((method & 15) !== 8 || (method >> 4) > 7 || (flags & 32) || (method * 256 + flags) % 31 !== 0) {
        throw new PetCardImportError('invalid')
      }
      const payload = ccv3 ?? chara
      if (!payload) throw new PetCardImportError('noCard')
      const binary = atob(ascii.decode(payload))
      const jsonBytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) jsonBytes[i] = binary.charCodeAt(i)
      return { ...readCharacter(utf8.decode(jsonBytes)), avatar: new Blob(avatarParts, { type: 'image/png' }) }
    }
    offset = end + 4
  }
  throw new PetCardImportError('invalid')
}

export async function parsePetCard(file: Blob): Promise<ImportedPetCard> {
  if (file.size > maxFileBytes) throw new PetCardImportError('tooLarge')
  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    if (pngSignature.every((byte, index) => bytes[index] === byte)) return readPng(bytes)
    // A UTF-8 BOM and leading JSON whitespace are legal in cards from desktop editors.
    const json = utf8.decode(bytes).trimStart()
    if (!json.startsWith('{') && !json.startsWith('[')) throw new PetCardImportError('unsupported')
    return readCharacter(json)
  } catch (error) {
    if (error instanceof PetCardImportError) throw error
    throw new PetCardImportError('invalid')
  }
}
