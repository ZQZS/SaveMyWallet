import { computed, readonly, shallowRef } from 'vue'

export const themeBases = ['paper', 'tide', 'night'] as const
export const backgrounds = ['plain', 'dots', 'grid', 'photo'] as const
export const accentColors = ['#174e3a', '#246687', '#88cbbb', '#85509d', '#ae5358', '#9b651d'] as const
export type ThemeBase = typeof themeBases[number]
export type ThemeBackground = typeof backgrounds[number]
export interface ThemeStyle {
  base: ThemeBase
  accent: string
  background: ThemeBackground
  photo?: string
}
interface SavedTheme { id: string; name: string; style: ThemeStyle }
interface AppearanceState { activeId: string; style: ThemeStyle; customThemes: SavedTheme[] }

export const MAX_THEME_NAME_LENGTH = 32
export const MAX_CUSTOM_THEMES = 24
export const MAX_THEME_PHOTO_BYTES = 512 * 1024
const photoPrefix = 'data:image/jpeg;base64,'
const storageKey = 'savemywallet.appearance.v1'
const palettes = {
  paper: { paper: '#f6f5ef', surface: '#fffef9', ink: '#202e27', sub: '#58645d', line: '#d9ddd3', soft: '#eaf0e7' },
  tide: { paper: '#edf4f7', surface: '#fbfeff', ink: '#182f40', sub: '#485f70', line: '#c7d8e0', soft: '#dfecf2' },
  night: { paper: '#151c24', surface: '#202a35', ink: '#edf3f8', sub: '#b4c2ce', line: '#40505f', soft: '#2b3743' },
}
const presets: Record<ThemeBase, ThemeStyle> = {
  paper: { base: 'paper', accent: accentColors[0], background: 'plain' },
  tide: { base: 'tide', accent: accentColors[1], background: 'grid' },
  night: { base: 'night', accent: accentColors[2], background: 'dots' },
}

export function presetStyle(base: ThemeBase): ThemeStyle { return { ...presets[base] } }

function isBase(value: unknown): value is ThemeBase { return themeBases.some(base => base === value) }
function isBackground(value: unknown): value is ThemeBackground { return backgrounds.some(item => item === value) }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null }

function normalizeColor(value: unknown): string | null {
  if (typeof value !== 'string' || !/^#(?:[a-f\d]{3}|[a-f\d]{6})$/i.test(value)) return null
  return (value.length === 4 ? '#' + [...value.slice(1)].map(c => c + c).join('') : value).toLowerCase()
}

export function normalizeThemeName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const name = value.trim().normalize('NFC')
  return name && [...name].length <= MAX_THEME_NAME_LENGTH && !/[\p{Cc}\p{Bidi_Control}]/u.test(name) ? name : null
}

function isPhoto(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith(photoPrefix) ||
      value.length > photoPrefix.length + 4 * Math.ceil(MAX_THEME_PHOTO_BYTES / 3)) return false
  const encoded = value.slice(photoPrefix.length)
  if (encoded.length < 8 || encoded.length % 4 || !/^\/9j\/[A-Za-z\d+/]*={0,2}$/.test(encoded)) return false
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0
  return encoded.length * 3 / 4 - padding <= MAX_THEME_PHOTO_BYTES && atob(encoded.slice(-8)).endsWith('\xff\xd9')
}

function readStyle(value: unknown): ThemeStyle | null {
  if (!isRecord(value) || !isBase(value.base) || !isBackground(value.background)) return null
  const accent = normalizeColor(value.accent)
  if (!accent || (value.photo !== undefined && !isPhoto(value.photo)) ||
      (value.background === 'photo' && !value.photo)) return null
  return { base: value.base, accent, background: value.background, ...(typeof value.photo === 'string' && { photo: value.photo }) }
}

function channels(hex: string): number[] {
  return [1, 3, 5].map(start => parseInt(hex.slice(start, start + 2), 16))
}

function mix(color: string, target: string, fraction: number): string {
  const end = channels(target)
  return '#' + channels(color).map((value, i) =>
    Math.round(value + fraction * (end[i] - value)).toString(16).padStart(2, '0')).join('')
}

function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map(value => {
    const v = value / 255
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: number, b: number): number { return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) }

function readableColor(color: string, target: string, surfaces: number[], minimum: number): string {
  for (let step = 0; step < 20; step++) {
    const candidate = step === 0 ? color : mix(color, target, step / 20)
    const light = luminance(candidate)
    if (surfaces.every(background => contrast(light, background) >= minimum)) return candidate
  }
  return target
}

function foreground(background: string) {
  const light = luminance(background)
  return contrast(0, light) > contrast(1, light) ? '#000000' : '#ffffff'
}

export function themeVariables(style: ThemeStyle): Record<string, string> {
  const base = isBase(style.base) ? style.base : 'paper'
  const palette = palettes[base]
  const accent = normalizeColor(style.accent) ?? presets[base].accent
  const surfaces = [palette.paper, palette.surface, palette.soft]
  let image = 'none'
  let size = 'auto'
  const pattern = mix(palette.paper, palette.ink, 0.13)
  if (style.background === 'dots') {
    image = 'radial-gradient(circle, ' + pattern + ' 1px, transparent 1.2px)'
    size = '18px 18px'
  } else if (style.background === 'grid') {
    image = 'linear-gradient(to right, ' + pattern + ' 1px, transparent 1px), linear-gradient(to bottom, ' + pattern + ' 1px, transparent 1px)'
    size = '24px 24px'
  } else if (style.background === 'photo' && isPhoto(style.photo)) {
    // Account for the darkest/lightest possible pixel below the 80% paper overlay.
    surfaces.push(mix(palette.paper, base === 'night' ? '#ffffff' : '#000000', 0.2))
    const veil = palette.paper + 'cc'
    image = 'linear-gradient(' + veil + ', ' + veil + '), url("' + style.photo + '")'
    size = 'cover'
  }
  if (style.background === 'dots' || style.background === 'grid') surfaces.push(pattern)
  const levels = surfaces.map(luminance)
  const green = readableColor(accent, palette.ink, levels, 4.5)
  const solid = readableColor(accent, palette.ink, levels, 3)
  return {
    '--paper': palette.paper, '--surface': palette.surface, '--ink': palette.ink,
    '--sub': readableColor(palette.sub, palette.ink, levels, 4.5), '--line': palette.line, '--soft': palette.soft,
    '--green': green, '--accent-solid': solid, '--on-accent': foreground(solid),
    '--focus-ring': green, '--hero-bg': accent, '--hero-ink': foreground(accent),
    '--page-background-image': image, '--page-background-size': size,
  }
}

function defaultState(): AppearanceState {
  return { activeId: 'paper', style: presetStyle('paper'), customThemes: [] }
}

function selectedStyle(id: string, customThemes: SavedTheme[]): ThemeStyle | undefined {
  return isBase(id) ? presetStyle(id) : customThemes.find(theme => theme.id === id)?.style
}

// A photo shared by a draft and several saved themes uses a single local-storage slot in the photo list.
function encodeState(state: AppearanceState): string {
  const photos: string[] = []
  function encodeStyle(style: ThemeStyle) {
    if (!style.photo) return style
    let index = photos.indexOf(style.photo)
    if (index < 0) index = photos.push(style.photo) - 1
    return { ...style, photo: index }
  }
  const style = encodeStyle(state.style)
  const customThemes = state.customThemes.map(theme => ({ ...theme, style: encodeStyle(theme.style) }))
  return JSON.stringify({ activeId: state.activeId, style, customThemes, photos })
}

function decodeState(raw: string | null): AppearanceState {
  if (!raw) return defaultState()
  const value: unknown = JSON.parse(raw)
  if (!isRecord(value)) return defaultState()
  const photos = Array.isArray(value.photos) ? value.photos : []
  function decodeStyle(style: unknown) {
    if (isRecord(style) && typeof style.photo === 'number') {
      if (!Number.isInteger(style.photo) || typeof photos[style.photo] !== 'string') return null
      return readStyle({ ...style, photo: photos[style.photo] })
    }
    return readStyle(style)
  }
  const customThemes: SavedTheme[] = []
  for (const theme of Array.isArray(value.customThemes) ? value.customThemes.slice(0, MAX_CUSTOM_THEMES) : []) {
    if (!isRecord(theme) || typeof theme.id !== 'string' || !/^custom-[1-9]\d{0,6}$/.test(theme.id)) continue
    const name = normalizeThemeName(theme.name)
    const style = decodeStyle(theme.style)
    if (name && style && !customThemes.some(item => item.id === theme.id || item.name.toLowerCase() === name.toLowerCase())) {
      customThemes.push({ id: theme.id, name, style })
    }
  }
  if (typeof value.activeId !== 'string') return { ...defaultState(), customThemes }
  const template = selectedStyle(value.activeId, customThemes)
  return template ? { activeId: value.activeId, style: decodeStyle(value.style) ?? template, customThemes } : { ...defaultState(), customThemes }
}

export function createAppearance(storage?: Pick<Storage, 'getItem' | 'setItem'>) {
  let initial: AppearanceState
  try { initial = decodeState((storage ?? globalThis.localStorage).getItem(storageKey)) }
  catch { initial = defaultState() }
  const state = shallowRef(initial)
  const view = readonly(state)

  function persist(next: AppearanceState): boolean {
    try { (storage ?? globalThis.localStorage).setItem(storageKey, encodeState(next)) }
    catch { return false }
    state.value = next
    return true
  }

  function selectTheme(id: string): boolean {
    const style = selectedStyle(id, state.value.customThemes)
    return !!style && persist({ ...state.value, activeId: id, style })
  }

  function updateStyle(patch: Partial<ThemeStyle>): boolean {
    const style = readStyle({ ...state.value.style, ...patch })
    return !!style && persist({ ...state.value, style })
  }

  function saveTheme(value: string, input: ThemeStyle): boolean {
    const name = normalizeThemeName(value)
    const style = readStyle(input)
    const themes = state.value.customThemes
    if (!name || !style || themes.length >= MAX_CUSTOM_THEMES || themes.some(item => item.name.toLowerCase() === name.toLowerCase())) return false
    let number = 1
    while (themes.some(theme => theme.id === 'custom-' + number)) number++
    const id = 'custom-' + number
    return persist({ activeId: id, style, customThemes: [...themes, { id, name, style }] })
  }

  function removeTheme(id: string): boolean {
    const theme = state.value.customThemes.find(item => item.id === id)
    if (!theme) return false
    const next = { ...state.value, customThemes: state.value.customThemes.filter(item => item.id !== id) }
    if (id === next.activeId) {
      next.activeId = theme.style.base
      next.style = presetStyle(theme.style.base)
    }
    return persist(next)
  }

  return { style: computed(() => view.value.style), activeId: computed(() => view.value.activeId),
    customThemes: computed(() => view.value.customThemes), selectTheme, updateStyle, saveTheme, removeTheme }
}

let appearance: ReturnType<typeof createAppearance> | undefined
export function useAppearance() { return appearance ??= createAppearance() }
