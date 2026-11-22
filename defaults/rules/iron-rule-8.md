---
key: iron-rule-8
type: iron-rule
number: 8
priority: P0
scope: global
role: ""
modality: must_not
action: "用 enabled:false／注释保留封存"
object: "被架构演进替代的旧代码／插件／规则"
conditions: [架构演进替代旧载体时]
exceptions: []
status: active
merged_into: ""
superseded_by: ""
created: 2026-11-22
updated: 2026-11-22
version: 1
origin: default:iron-rule-8
---

被架构演进替代的旧代码／旧插件／旧规则禁止用 enabled: false 或注释保留封存；必须先提炼精华融入新系统，再彻底物理删除；一经发现立刻 git rm；收尾按铁律 7 的 grep 清单复核，命中项须能指出已物理删除的提交号或为什么留。
