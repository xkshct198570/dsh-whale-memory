---
key: iron-rule-16
type: iron-rule
number: 16
priority: P0
scope: global
role: ""
modality: must
action: 命名与注解并同步文档
object: 公开符号与核心改动
conditions: []
exceptions: []
status: active
merged_into: ""
superseded_by: ""
created: 2026-11-22
updated: 2026-11-22
version: 1
origin: default:iron-rule-16
---

命名必须表达意图，禁止 a／b／tmp／data 类无意义名；公开函数／类／接口必须有类型注解与 Docstring（做什么·参数·返回·异常）；注释只解释 Why（约束／坑／取舍），不复述 What；核心改动（接口／数据／流程／行为）必须同轮更新对应 Markdown 文档与台账；判据：新增公开符号无 Docstring／类型注解＝未生效，核心改动缺同步文档＝未完成；生效初期只做记忆写入＋台账挂账，不扫描／重构存量。
