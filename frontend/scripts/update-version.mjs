import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const frontend = fileURLToPath(new URL('../', import.meta.url))
const tauriConfig = 'src-tauri/tauri.conf.json'
const parseJson = text => JSON.parse(text.replace(/^\uFEFF/, ''))
const rootVersion = data => data.version

async function askVersion() {
  const lines = createInterface({ input: process.stdin, output: process.stdout, crlfDelay: Infinity })
  const prompt = '请输入新版本号（如 0.4.4，直接回车取消）：'
  try {
    process.stdout.write(prompt)
    for await (const line of lines) {
      const version = line.trim()
      if (!version) return
      if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
        console.log('请使用主版本.次版本.修订号，每段为不带前导零的非负整数。')
      } else {
        const parts = version.split('.').map(Number)
        const androidCode = parts[0] * 1_000_000 + parts[1] * 1_000 + parts[2]
        if (parts.every(n => n <= 65_535) && androidCode >= 1 && androidCode <= 2_100_000_000) return version
        console.log('该版本号超出 Windows 或 Android 安装包支持的范围。')
      }
      process.stdout.write(prompt)
    }
  } finally {
    lines.close()
  }
}

function updateJson(text, getVersion, version) {
  const previous = getVersion(parseJson(text))
  if (typeof previous !== 'string') throw new Error('找不到应用版本字段')
  if (previous === version) return text
  // 检查替换是否命中指定 JSON 路径，同时保留原文件的换行、缩进和第三方依赖。
  for (const match of text.matchAll(/"version"\s*:\s*"([^"\r\n]*)"/g)) {
    if (match[1] !== previous) continue
    const end = match.index + match[0].length - 1
    const candidate = text.slice(0, end - previous.length) + version + text.slice(end)
    if (getVersion(parseJson(candidate)) === version) return candidate
  }
  throw new Error('无法定位应用版本字段')
}

function updateMarker(text, pattern, version) {
  let count = 0
  const updated = text.replace(pattern, (_, prefix) => {
    count++
    return prefix + version
  })
  if (count !== 1) throw new Error('需要恰好一个应用版本标记，实际找到 ' + count + ' 个')
  return updated
}

function updateCargo(text, header, version) {
  const sections = text.split(/(?=^\[)/m)
  const packages = sections.filter(section =>
    header.test(section) && /^name[ \t]*=[ \t]*"save-my-wallet"[ \t]*(?:#.*)?\r?$/m.test(section))
  if (packages.length !== 1) throw new Error('无法唯一确定 save-my-wallet 包')
  const index = sections.indexOf(packages[0])
  sections[index] = updateMarker(sections[index], /^(version[ \t]*=[ \t]*")[^"\r\n]+(?=")/gm, version)
  return sections.join('')
}

const targets = [
  [tauriConfig, (text, v) => updateJson(text, rootVersion, v)],
  ['package.json', (text, v) => updateJson(text, rootVersion, v)],
  ['package-lock.json', (text, v) => updateJson(updateJson(text, rootVersion, v), data => data.packages?.['']?.version, v)],
  ['src-tauri/Cargo.toml', (text, v) => updateCargo(text, /^\[package\][ \t]*\r?\n/, v)],
  ['src-tauri/Cargo.lock', (text, v) => updateCargo(text, /^\[\[package\]\][ \t]*\r?\n/, v)],
  ['../README.md', (text, v) => updateMarker(text, /^(## 当前客户端版本[ \t]*·[ \t]*)\d+\.\d+\.\d+(?=[ \t]*\r?$)/gm, v)],
  ['AGENTS.md', (text, v) => updateMarker(text, /(当前应用版本为[ \t]*)\d+\.\d+\.\d+(?=，)/g, v)],
]

function replaceFile(path, expected, next) {
  const temp = path + '.' + randomUUID() + '.tmp'
  try {
    writeFileSync(temp, next, { flag: 'wx', mode: statSync(path).mode })
    if (readFileSync(path, 'utf8') !== expected) throw new Error('文件已被其他操作修改：' + path)
    renameSync(temp, path)
  } finally {
    rmSync(temp, { force: true })
  }
}

async function main() {
  const current = rootVersion(parseJson(readFileSync(resolve(frontend, tauriConfig), 'utf8')))
  if (typeof current !== 'string') throw new Error(tauriConfig + ' 缺少客户端版本')
  console.log('当前客户端版本：' + current)
  const version = await askVersion()
  if (!version) {
    console.log('已取消。')
    return
  }

  const changes = targets.map(([file, update]) => {
    const path = resolve(frontend, file)
    const before = readFileSync(path, 'utf8')
    try {
      return { path, before, after: update(before, version) }
    } catch (error) {
      throw new Error(file + '：' + error.message)
    }
  }).filter(change => change.before !== change.after)
  const written = []
  try {
    for (const change of changes) {
      replaceFile(change.path, change.before, change.after)
      written.push(change)
    }
  } catch (error) {
    for (const change of written.reverse()) {
      try {
        replaceFile(change.path, change.after, change.before)
      } catch (rollbackError) {
        console.error('无法还原 ' + change.path + '：' + rollbackError.message)
      }
    }
    throw error
  }
  console.log(changes.length ? '客户端版本已同步为 ' + version + '。' : '客户端版本已是 ' + version + '。')
}

main().catch(error => {
  console.error('版本更新失败：' + error.message)
  process.exitCode = 1
})
