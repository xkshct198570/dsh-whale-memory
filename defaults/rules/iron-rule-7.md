---
key: iron-rule-7
type: iron-rule
number: 7
priority: P0
scope: global
role: ""
modality: must
action: 物理删除
object: "被替代的代码／插件"
conditions: [收尾]
exceptions: []
status: active
merged_into: ""
superseded_by: ""
created: 2026-11-22
updated: 2026-11-22
version: 1
origin: default:iron-rule-7
---

被替代的代码／插件必须物理删除（git rm／卸包／删脚本）；禁止 return next()、enabled:false、注释保留；收尾 grep 清单：enabled:\s*false、整段注释掉的可执行块、return next() 直通垫片、\.bak 式复活入口——命中即须处置或说明理由。
