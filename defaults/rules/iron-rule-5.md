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
conditions: []
exceptions: []
status: active
merged_into: ""
superseded_by: ""
created: 2026-11-22
updated: 2026-11-22
version: 1
origin: default:iron-rule-5
---

入站 message_id 必须贯穿两处：①日志——每条相关日志首行即打 message_id（含 trace），收帧解析成功即打首行，坏帧不得打假 id；②库表——msg_id 与 trace 两列齐且与日志同值；判据：同一单能按 msg_id 反查日志行与库行，两处值一致。
