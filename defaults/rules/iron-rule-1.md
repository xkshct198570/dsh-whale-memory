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
version: 2
origin: default:iron-rule-1
---

何时：改动落盘后、记「已修复」前。做什么：从真实 HTTP 入口发起，追到消费端产物（ComfyUI /history、whale.db 落库行、发送回执），证据给首行日志／库表行／文件字节。怎么判：中间层返回 200 不算断言成立；无真实 payload 日志＝未验证；不得拿「没报错」当通过，不得记「已修复」。
