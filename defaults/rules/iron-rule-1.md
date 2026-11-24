---
key: iron-rule-1
type: iron-rule
number: 1
priority: P0
scope: global
role: ""
modality: must
action: 验证
object: 真机全链路消费端产物
conditions: [改动落盘后, 记录已修复前]
exceptions: []
status: active
merged_into: ""
superseded_by: ""
created: 2026-11-22
updated: 2026-11-24
version: 3
origin: default:iron-rule-1
---

何时：改动落盘后、记「已修复」或收尾前。做什么：从真实入口发起，追到消费端产物（库表行／文件字节／回执），并覆盖重启或隔离装载后的生效路径。怎么判：中间层 200、测试绿、隔离路由 200 都不算；无真实 payload 日志＝未验证；失败必须报「未生效＋原因」，不得记已修复。
