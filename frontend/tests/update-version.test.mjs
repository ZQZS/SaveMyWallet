import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const project = fileURLToPath(new URL('../../', import.meta.url))
const config = 'frontend/src-tauri/tauri.conf.json'
const manifest = 'frontend/package.json'
const npmLock = 'frontend/package-lock.json'
const cargo = 'frontend/src-tauri/Cargo.toml'
const cargoLock = 'frontend/src-tauri/Cargo.lock'
const readme = 'README.md'
const agents = 'frontend/AGENTS.md'
const versionFiles = [config, manifest, npmLock, cargo, cargoLock, readme, agents]
const script = 'frontend/scripts/update-version.mjs'
const launcher = 'frontend/update-version.cmd'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'SaveMyWallet version '))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const file of [...versionFiles, script, launcher]) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    copyFileSync(join(project, file), join(root, file))
  }
  return root
}

const read = (root, file) => readFileSync(join(root, file), 'utf8')
const write = (root, file, value) => writeFileSync(join(root, file), value, 'utf8')
const snapshot = root => versionFiles.map(file => read(root, file))

function run(root, input) {
  const windows = process.platform === 'win32'
  const result = spawnSync(
    windows ? process.env.ComSpec || 'cmd.exe' : process.execPath,
    windows ? ['/d', '/c', '..\\update-version.cmd'] : [join(root, script)],
    { cwd: join(root, 'frontend/src-tauri'), encoding: 'utf8', input, timeout: 10_000, windowsHide: true },
  )
  assert.ifError(result.error)
  assert.equal(result.signal, null)
  return result
}

test('显示 Tauri 当前版本，允许修正输入，并同步八处应用版本', t => {
  const root = fixture(t)
  const current = JSON.parse(read(root, config)).version
  const next = current === '1.5.2' ? '1.5.1' : '1.5.2'
  // 模拟另一个版本遗留的清单，以及碰巧使用当前应用版本的依赖。
  const pkg = JSON.parse(read(root, manifest))
  pkg.version = '2.7.1'
  pkg.dependencies['example-dependency'] = current
  write(root, manifest, JSON.stringify(pkg, null, 2) + '\n')
  const lock = JSON.parse(read(root, npmLock))
  lock.version = '2.7.2'
  lock.packages[''].version = '2.7.3'
  lock.packages['node_modules/example-dependency'] = { version: current }
  write(root, npmLock, JSON.stringify(lock, null, 2) + '\n')
  const otherCrate = '\n[[package]]\nname = "example-dependency"\nversion = "' + current + '"\n'
  write(root, cargoLock, read(root, cargoLock) + otherCrate)

  const result = run(root, ['1.05.2', '1.5', '99999999.0.0', next, ''].join('\n'))
  assert.equal(result.status, 0, result.stderr)
  assert.ok(result.stdout.includes(current))
  assert.equal(JSON.parse(read(root, config)).version, next)
  pkg.version = next
  assert.deepEqual(JSON.parse(read(root, manifest)), pkg)
  lock.version = next
  lock.packages[''].version = next
  assert.deepEqual(JSON.parse(read(root, npmLock)), lock)
  for (const file of [cargo, cargoLock]) {
    assert.equal(read(root, file).match(/^name = "save-my-wallet"\r?\nversion = "([^"]+)"/m)?.[1], next)
  }
  assert.ok(read(root, cargoLock).endsWith(otherCrate))
  assert.ok(read(root, readme).includes('## 当前客户端版本 · ' + next))
  assert.ok(read(root, agents).includes('当前应用版本为 ' + next + '，'))
})

test('空行、输入结束和相同版本均保留原文件内容', t => {
  const root = fixture(t)
  const current = JSON.parse(read(root, config)).version
  const before = snapshot(root)
  for (const input of ['\n', '', current + '\n']) {
    const result = run(root, input)
    assert.equal(result.status, 0, result.stderr)
    assert.ok(result.stdout.includes(current))
    assert.deepEqual(snapshot(root), before)
  }
})

test('再次输入当前版本也会修复不一致的 npm 清单', t => {
  const root = fixture(t)
  const current = JSON.parse(read(root, config)).version
  const pkg = JSON.parse(read(root, manifest))
  pkg.version = current === '2.3.4' ? '2.3.3' : '2.3.4'
  write(root, manifest, JSON.stringify(pkg, null, 2) + '\n')
  assert.equal(run(root, current + '\n').status, 0)
  assert.equal(JSON.parse(read(root, manifest)).version, current)
})

test('缺少应用的 Cargo.lock 条目时不写入任何版本文件', t => {
  const root = fixture(t)
  write(root, cargoLock, read(root, cargoLock).replace('name = "save-my-wallet"', 'name = "another-crate"'))
  const before = snapshot(root)
  const result = run(root, '1.2.3\n')
  assert.notEqual(result.status, 0)
  assert.deepEqual(snapshot(root), before)
})
