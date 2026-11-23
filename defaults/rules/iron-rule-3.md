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
conditions: ["异步动作（排队／冷却／补发／重试）"]
exceptions: []
status: active
merged_into: ""
superseded_by: ""
created: 2026-11-22
updated: 2026-11-24
version: 2
origin: default:iron-rule-3
---

何时：任何排队／冷却／补发／重试类异步动作。做什么：动作落 SQLite 并配后台守护协程续跑。怎么判：禁止只靠内存队列、进程内 sleep 或内存定时器；杀进程重启后未完成项仍被续跑，库中状态行与日志可逐条对账。
