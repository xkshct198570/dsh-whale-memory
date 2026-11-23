---
key: iron-rule-17
type: iron-rule
number: 17
priority: P0
scope: global
role: ""
modality: must
action: 删除
object: AI报告/过程稿/中间产物
conditions: [默认一次性]
exceptions: [用户原件, 最终交付件, 明确要求保留, 正被文档引用, 法务/合规要求留存]
status: active
merged_into: ""
superseded_by: ""
created: 2026-11-22
updated: 2026-11-22
version: 2
origin: default:iron-rule-17
---

AI 生成或转交的报告、过程稿、中间产物默认一次性——先提炼结论与证据进记忆或台账（记录原文件名、sha256、结论落点），再删除源文件；删除前核绝对路径；git 跟踪件走 git rm，未跟踪件 mv 到 _归档/ 或 trash/（不直接 rm）；此类临时件不得进入灾备包。例外：用户原件、最终交付件、明确要求保留、正被文档引用、法务/合规要求留存。
