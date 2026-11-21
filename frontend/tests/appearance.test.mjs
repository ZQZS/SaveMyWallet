import assert from 'node:assert/strict'
import test from 'node:test'
import { isReadonly } from 'vue'
import { accentColors, backgrounds, createAppearance, MAX_CUSTOM_THEMES, MAX_THEME_NAME_LENGTH,
  MAX_THEME_PHOTO_BYTES, normalizeThemeName, presetStyle, themeBases, themeVariables } from '../src/features/appearance/appearance.ts'

// A one-pixel grayscale JPEG.
const photo = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAB//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8Af3//2Q=='

function memoryStorage() {
  return {
    raw: null, full: false,
    getItem() { return this.raw },
    setItem(_key, value) {
      if (this.full) throw new Error('QuotaExceededError')
      this.raw = value
    },
  }
}

test('预设、自定义主题与实时修改独立保存，重启能够还原当前草稿', () => {
  const storage = memoryStorage()
  const ui = createAppearance(storage)
  assert.deepEqual(ui.style.value, presetStyle('paper'))
  assert.ok(isReadonly(ui.style.value) && isReadonly(ui.customThemes.value))
  assert.equal(ui.selectTheme('tide'), true)
  assert.equal(ui.updateStyle({ accent: '#f30', background: 'photo', photo }), true)
  const original = { ...presetStyle('tide'), accent: '#ff3300', background: 'photo', photo }
  assert.equal(ui.activeId.value, 'tide')
  assert.deepEqual(ui.style.value, original)
  assert.deepEqual(createAppearance(storage).style.value, original)
  assert.equal(ui.saveTheme('  海边  ', ui.style.value), true)
  const id = ui.activeId.value
  assert.equal(ui.updateStyle({ accent: '#ffffff', background: 'dots' }), true)
  assert.equal(ui.activeId.value, id)
  assert.deepEqual(ui.customThemes.value, [{ id, name: '海边', style: original }])
  assert.equal(storage.raw.split(photo).length - 1, 1)
  const restored = createAppearance(storage)
  assert.equal(restored.style.value.accent, '#ffffff')
  assert.equal(restored.selectTheme(id), true)
  assert.deepEqual(restored.style.value, original)
  assert.equal(restored.selectTheme('tide'), true)
  assert.deepEqual(restored.style.value, presetStyle('tide'))
  assert.equal(restored.selectTheme(id), true)
  assert.equal(restored.removeTheme('night'), false)
  assert.equal(restored.removeTheme(id), true)
  assert.equal(restored.activeId.value, 'tide')
  assert.deepEqual(restored.style.value, presetStyle('tide'))
  assert.deepEqual(restored.customThemes.value, [])
  assert.equal(storage.raw.includes(photo), false)
})

test('设备存储不可写时四种操作都保留当前状态与已有模板', () => {
  const storage = memoryStorage()
  const ui = createAppearance(storage)
  assert.equal(ui.saveTheme('夜间', presetStyle('night')), true)
  const id = ui.activeId.value, raw = storage.raw
  storage.full = true
  assert.equal(ui.selectTheme('paper'), false)
  assert.equal(ui.updateStyle({ accent: '#fff' }), false)
  assert.equal(ui.saveTheme('新建', presetStyle('paper')), false)
  assert.equal(ui.removeTheme(id), false)
  assert.equal(storage.raw, raw)
  assert.equal(ui.activeId.value, id)
  assert.deepEqual(ui.style.value, presetStyle('night'))
  assert.deepEqual(ui.customThemes.value.map(theme => theme.id), [id])
  storage.full = false
  assert.equal(ui.removeTheme(id), true)
})

test('模板名称、数量与不可信配置在写入和恢复时校验', () => {
  const storage = memoryStorage()
  const ui = createAppearance(storage)
  assert.equal(normalizeThemeName('  🐳  '), '🐳')
  assert.equal(normalizeThemeName('🐳'.repeat(MAX_THEME_NAME_LENGTH)), '🐳'.repeat(MAX_THEME_NAME_LENGTH))
  for (const value of ['   ', '账单\u0000设置', 'r\u202Ele', '🐳'.repeat(MAX_THEME_NAME_LENGTH + 1)]) {
    assert.equal(ui.saveTheme(value, ui.style.value), false)
  }
  assert.equal(ui.saveTheme('First', ui.style.value), true)
  assert.equal(ui.saveTheme(' first ', ui.style.value), false)
  for (let i = 1; i < MAX_CUSTOM_THEMES; i++) assert.equal(ui.saveTheme(String(i), ui.style.value), true)
  assert.equal(ui.saveTheme('Extra', ui.style.value), false)
  assert.equal(ui.selectTheme('__proto__'), false)
  for (const patch of [{ base: 'unknown' }, { background: 'url(x)' }, { accent: 'red' }, { accent: '#123456; color:red' }]) {
    assert.equal(ui.updateStyle(patch), false)
  }
  const corrupt = JSON.parse(storage.raw)
  corrupt.activeId = '__proto__'
  corrupt.style = { ...ui.style.value, accent: '#123456;' }
  corrupt.customThemes[0].style = { ...ui.style.value, background: 'photo', photo: 'https://example.test/p.jpg' }
  storage.raw = JSON.stringify(corrupt)
  const repaired = createAppearance(storage)
  assert.equal(repaired.activeId.value, 'paper')
  assert.deepEqual(repaired.style.value, presetStyle('paper'))
  assert.equal(repaired.customThemes.value.length, MAX_CUSTOM_THEMES - 1)
  storage.raw = 'broken'
  assert.deepEqual(createAppearance(storage).style.value, presetStyle('paper'))
})

test('照片只接受容量内的本地 JPEG，非法值不能进入背景 CSS', () => {
  const ui = createAppearance(memoryStorage())
  const bad = [undefined, 'https://example.test/image.jpg', 'data:image/svg+xml;base64,AAAA',
    'data:image/jpeg;base64,abcd', 'data:image/jpeg;base64,/9j/AAAA', photo + '")',
    'data:image/jpeg;base64,/9j/' + 'A'.repeat(Math.ceil(MAX_THEME_PHOTO_BYTES / 3) * 4)]
  for (const value of bad) {
    const style = { ...presetStyle('night'), background: 'photo', photo: value }
    assert.equal(ui.updateStyle(style), false)
    assert.equal(themeVariables(style)['--page-background-image'], 'none')
  }
  assert.equal(ui.updateStyle({ background: 'photo', photo }), true)
  const css = themeVariables(ui.style.value)
  assert.ok(css['--page-background-image'].startsWith('linear-gradient('))
  assert.ok(css['--page-background-image'].endsWith('url("' + photo + '")'))
  assert.equal(css['--page-background-size'], 'cover')
})

function rgb(hex) { return hex.slice(1).match(/../g).map(channel => parseInt(channel, 16)) }
function ratio(a, b) {
  function brightness(channels) {
    const [r, g, b] = channels.map(value => value / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const lo = Math.min(brightness(a), brightness(b)), hi = Math.max(brightness(a), brightness(b))
  return (hi + 0.05) / (lo + 0.05)
}

test('结余和聊天使用所选主题色原值，并按底色亮度切换文字颜色', () => {
  for (const base of themeBases) {
    for (const [accent, fill, ink] of [
      ['#fed', '#ffeedd', '#000000'],
      ['#32134A', '#32134a', '#ffffff'],
      ['#88cbbb', '#88cbbb', '#000000'],
    ]) {
      const css = themeVariables({ ...presetStyle(base), accent })
      assert.equal(css['--hero-bg'], fill)
      assert.equal(css['--hero-ink'], ink)
    }
  }
})

test('三套主题以及极浅、极深与明亮强调色在照片和纹理上都有足够对比度', () => {
  for (const base of themeBases) for (const background of backgrounds) {
    for (const accent of [...accentColors, '#000', '#fff', '#00ff00', '#eee011', '#0000ff', '#777']) {
      const css = themeVariables({ base, accent, background, photo })
      const levels = ['--paper', '--soft', '--surface'].map(key => rgb(css[key]))
      if (background === 'photo') {
        for (const extreme of [0, 255]) levels.push(rgb(css['--paper']).map(v => Math.round(v * 0.8 + extreme * 0.2)))
      } else if (background !== 'plain') levels.push(rgb(css['--page-background-image'].match(/#[a-f0-9]{6}/)[0]))
      for (const level of levels) {
        for (const key of ['--green', '--ink', '--sub']) assert.ok(ratio(rgb(css[key]), level) >= 4.5, [base, background, accent, key].join(' '))
        assert.ok(ratio(rgb(css['--accent-solid']), level) >= 3)
        assert.ok(ratio(rgb(css['--focus-ring']), level) >= 3)
      }
      assert.ok(ratio(rgb(css['--on-accent']), rgb(css['--accent-solid'])) >= 4.5)
      assert.ok(ratio(rgb(css['--hero-ink']), rgb(css['--hero-bg'])) >= 4.5)
    }
  }
})
