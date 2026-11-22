---
key: iron-rule-10
type: iron-rule
number: 10
priority: P0
scope: global
role: ""
modality: must
action: 择优并保持主流程更薄
object: 每轮改动
conditions: [每轮改动]
exceptions: []
status: active
merged_into: ""
superseded_by: ""
created: 2026-11-22
updated: 2026-11-22
version: 1
origin: default:iron-rule-10
---

改动只选更优解：禁止为兼容烂实现、图省事或省一次重构而降低体验；新能力必须落在独立模块／接口，主流程只加接线，不堆分支／特例／正则；每轮改动净效果须为主流程更薄、边界更清、回滚更容易，做不到先重构再上功能；更优解判定按序：主流程更薄＞回滚更容易＞边界更清＞实现更短；无实测数据的优化不算更优；被替代实现同轮物理删除，禁止补丁层叠。
