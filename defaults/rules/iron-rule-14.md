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
conditions: [交付网络通路时]
exceptions: ["net.sh pin 显式登记的真身 IP 须带复核命令与失效判据"]
status: active
merged_into: ""
superseded_by: ""
created: 2026-11-22
updated: 2026-11-22
version: 1
origin: default:iron-rule-14
---

交付网络通路（单站／域名／下载源／通道）必须同轮产出四件：①自证命令（当场可复测还通不通）②带实测日期的基线记录（只证明哪天测的，不得当现行事实引用）③多级回退链（任一链断不得导致整体失效）④交接文档（新会话／换 AI 可凭它接管）；禁止把单一 IP／单一解析源／单一镜像写成唯一通路；唯一例外＝net.sh pin 显式登记的真身 IP，须带复核命令与失效判据；判据：能当场跑出自证结果／基线文件含实测日期／回退链 ≥2 级／pin 表以外 grep 无硬编码 IP；拿旧基线未复测就断言能通＝违规。
