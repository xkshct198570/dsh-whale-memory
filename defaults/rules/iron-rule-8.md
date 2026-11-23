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
conditions: [发现封存载体]
exceptions: []
status: active
merged_into: iron-rule-7
superseded_by: ""
created: 2026-11-22
updated: 2026-11-24
version: 2
origin: default:iron-rule-8
---

被架构演进替代的旧代码／插件／规则禁止用 enabled:false 或注释保留封存。何时：发现封存载体时。做什么：立刻 git rm，同轮把其中有效判据并入新实现。怎么判：本条已并入铁律 7（iron-rule-7.md），执行口径与 grep 清单只认铁律 7，禁止在别处复制第二份判据。
