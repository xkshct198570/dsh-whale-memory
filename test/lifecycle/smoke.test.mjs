import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('../..', import.meta.url).pathname
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

test('manifest：包名/版本/engines/patch 就位', () => {
  assert.equal(pkg.name, 'dsh-whale-memory')
  // 允许 SemVer 预发布后缀：S1 收口按计划打 0.8.0-beta1（不发布、不推市场）。
  assert.match(pkg.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
  assert.match(pkg.engines.dsh, /^>=/)
  assert.equal(pkg.private, undefined)
  assert.ok(existsSync(join(root, pkg.dsh.bundle.patch)))
})

test('exports：入口与 client 产物存在', () => {
  assert.ok(existsSync(join(root, 'index.js')))
  assert.ok(existsSync(join(root, 'lib/client.js')))
  assert.equal(pkg.exports['./client'], './lib/client.js')
})

test('patch：恰一行 insert（id=whale-memory）', () => {
  const yaml = readFileSync(join(root, pkg.dsh.bundle.patch), 'utf8')
  assert.equal((yaml.match(/- insert:/g) || []).length, 1)
  assert.match(yaml, /id: whale-memory/)
})
