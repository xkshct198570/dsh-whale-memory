/**
 * 分层词汇唯一真源：shared/layers.js 定义 LAYERS/validLayer，writer 门面只是再导出同一函数。
 *
 * 为什么锁函数同一性：白名单若在 decide/process/backend 各抄一份，加层或改口径就会
 * 出现"能写不能读/读不到刚写的层"这类漂移；这里用引用相等把实现钉死在一处。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LAYERS, validLayer } from '../../src/shared/layers.js'
import { validLayer as facadeValidLayer } from '../../src/core/writer.js'

test('LAYERS：三值词汇固定（v7）', () => {
  assert.deepEqual([...LAYERS], ['fact', 'lesson', 'user'])
})

test('validLayer：只放行三值，其余一律 NULL', () => {
  for (const layer of LAYERS) assert.equal(validLayer(layer), layer)
  for (const bad of [null, undefined, '', 'topic', 'USER', 0, 'fact ']) {
    assert.equal(validLayer(bad), null, `非法值不得落库：${String(bad)}`)
  }
})

test('writer 门面的 validLayer 与 shared 是同一实现（非第二份判据）', () => {
  assert.equal(facadeValidLayer, validLayer)
})
