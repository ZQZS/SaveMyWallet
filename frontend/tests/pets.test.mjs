import assert from 'node:assert/strict'
import { readdir, readFile, stat } from 'node:fs/promises'
import test from 'node:test'
import { assetForState } from '../src/features/pets/manifest.ts'
import { builtinPets } from '../src/features/pets/catalog.ts'

const packsRoot = new URL('../resources/pets/', import.meta.url)

test('内置伙伴切换语言后保留身份，提醒台词使用相同账务字段', async () => {
  const ids = ['wallet-cat', 'ledger-owl', 'detective-fox']
  for (const locale of ['zh-CN', 'en-US']) {
    const pets = builtinPets(locale)
    assert.deepEqual(pets.map(pet => pet.id), ids)
    assert.equal(new Set(pets.map(pet => pet.preview)).size, pets.length)
    for (const pet of pets) {
      assert.ok(pet.greetings.length >= 2 && pet.greetings.every(line => line.trim()))
      assert.match(pet.lowBalance, /\{month\}/)
      assert.match(pet.lowBalance, /\{amount\}/)
      assert.match(pet.pendingEstimates, /\{month\}/)
      assert.match(pet.pendingEstimates, /\{count\}/)
      assert.doesNotMatch(pet.preview, /\{\w+\}/)
      for (const url of [pet.avatar, pet.greetAvatar]) assert.ok((await stat(new URL(url))).isFile())
    }
  }
})

test('角色清单与本地素材匹配，缺省动作回退到待机图', async () => {
  const folders = (await readdir(packsRoot, { withFileTypes: true })).filter(entry => entry.isDirectory())
  assert.ok(folders.length > 0)
  for (const folder of folders) {
    const packRoot = new URL(folder.name + '/', packsRoot)
    const manifest = JSON.parse(await readFile(new URL('manifest.json', packRoot), 'utf8'))
    assert.equal(manifest.version, 1)
    assert.equal(manifest.id, folder.name)
    assert.ok(manifest.displayName.trim())
    assert.ok(manifest.artworkSource.trim())
    assert.ok(manifest.states.idle)
    for (const [state, file] of Object.entries(manifest.states)) {
      assert.ok(['idle', 'greet', 'remind'].includes(state), state)
      const asset = new URL(file, packRoot)
      assert.ok(asset.href.startsWith(packRoot.href), file)
      assert.ok((await stat(asset)).isFile(), file)
      assert.equal(assetForState(manifest, state), file)
    }
    const idleOnly = { ...manifest, states: { idle: manifest.states.idle } }
    assert.equal(assetForState(idleOnly, 'greet'), manifest.states.idle)
    assert.equal(assetForState(idleOnly, 'remind'), manifest.states.idle)
  }
})
