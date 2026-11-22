---
key: iron-rule-3
type: iron-rule
number: 3
priority: P0
scope: global
role: ""
modality: must
action: 落库并挂后台守护
object: "异步动作（排队／冷却／补发／重试）"
conditions: [异步动作]
exceptions: []
status: active
merged_into: ""
superseded_by: ""
created: 2026-11-22
updated: 2026-11-22
version: 1
origin: default:iron-rule-3
---

异步动作（排队／冷却／补发／重试）必须落 SQLite 并配后台守护协程；禁止只靠内存、进程内 sleep 或内存队列；判据：进程重启后未完成项仍被续跑。
