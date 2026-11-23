---
key: iron-rule-7
type: iron-rule
number: 7
priority: P0
scope: global
role: ""
modality: must
action: 物理删除
object: "被替代的代码／插件／规则"
conditions: [实现被替代, 收尾复核]
exceptions: []
status: active
merged_into: ""
superseded_by: ""
created: 2026-11-22
updated: 2026-11-24
version: 2
origin: default:iron-rule-7
---

何时：任何实现被替代时，以及收尾复核时。做什么：先提炼旧载体中仍有效的判据融入新实现，再物理删除旧载体（git rm／卸包／删脚本），旧代码／插件／规则一律适用。怎么判：禁止 return next() 直通垫片、enabled:false、整段注释保留、.bak 式复活入口；收尾 grep enabled:\s*false、整段注释掉的可执行块、return next()、.bak，命中即处置或给出保留判据。
