---
key: iron-rule-14
type: iron-rule
number: 14
priority: P0
scope: global
role: ""
modality: must
action: 同轮产出四件
object: 网络通路交付
conditions: [交付网络通路]
exceptions: ["net.sh pin 显式登记的真身 IP 须带复核命令与失效判据"]
status: active
merged_into: ""
superseded_by: ""
created: 2026-11-22
updated: 2026-11-24
version: 2
origin: default:iron-rule-14
---

何时：交付网络通路（单站／域名／下载源／通道）时。做什么：同轮产出四件——①自证命令 ②带实测日期的基线记录 ③≥2 级回退链 ④交接文档。怎么判：当场能跑出自证结果；基线只证明哪天测的，不得当现行事实引用，拿旧基线未复测即断言能通＝违规；禁止把单一 IP／解析源／镜像写成唯一通路；回退链任一级断不得整体失效；唯一例外＝net.sh pin 登记的真身 IP，须带复核命令与失效判据；pin 表以外 grep 无硬编码 IP。
