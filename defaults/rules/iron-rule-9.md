---
key: iron-rule-9
type: iron-rule
number: 9
priority: P0
scope: global
role: ""
modality: must_not
action: 写历史与占位
object: 文档
conditions: [写或改文档与台账]
exceptions: [编号占用与墓碑只允许一行现状记录, "history 与 manifest 为审计数据"]
status: active
merged_into: ""
superseded_by: ""
created: 2026-11-22
updated: 2026-11-24
version: 3
origin: default:iron-rule-9
---

何时：写或改任何文档、台账时。做什么：只写「现在是什么／接下来做什么」。怎么判：禁止写「曾经是什么」；已失效条目从正文物理删除，禁止打勾／划线／留「已过期／降级／已合并」横幅；完成项只在台账 §8 留一行（一句＋提交号）；同一事实只写一处，发现副本即删副本；禁止「证据见备份」类占位；代码／流程一改即同会话更新受影响文档。 例外：编号占用与墓碑只允许一行现状记录（作废号／承接条）；history 与 manifest 属审计数据，不按本文档口径裁剪。
