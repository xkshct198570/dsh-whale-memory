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
conditions: [新增公开符号或核心改动]
exceptions: []
status: active
merged_into: ""
superseded_by: ""
created: 2026-11-22
updated: 2026-11-24
version: 2
origin: default:iron-rule-16
---

何时：新增公开符号，或核心改动（接口／数据／流程／行为）时。做什么：命名表达意图；公开函数／类／接口带类型注解与 Docstring（做什么·参数·返回·异常）；注释只解释 Why（约束／坑／取舍），不复述 What；同轮更新对应 Markdown 文档与台账。怎么判：禁止 a／b／tmp／data 类无意义名；无 Docstring／类型注解＝未生效；核心改动缺同步文档＝未完成。
