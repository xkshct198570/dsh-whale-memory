---
key: iron-rule-5
type: iron-rule
number: 5
priority: P0
scope: global
role: ""
modality: must
action: 贯穿日志与库表
object: "入站 message_id／trace"
conditions: [入站链路新增日志或库表字段]
exceptions: []
status: active
merged_into: ""
superseded_by: ""
created: 2026-11-22
updated: 2026-11-24
version: 2
origin: default:iron-rule-5
---

何时：入站链路新增日志或库表字段时。做什么：message_id＋trace 贯穿两处。怎么判：①日志每条相关首行即打 message_id（解析成功即打，坏帧不得打假 id）；②库表 msg_id 与 trace 两列齐且与日志同值；同一单能按 msg_id 反查日志行与库行，两处值一致。
