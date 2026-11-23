---
key: iron-rule-2
type: iron-rule
number: 2
priority: P0
scope: global
role: ""
modality: must_not
action: 内嵌领域特定逻辑
object: 至主流程文件
conditions: [新增或修改主流程文件]
exceptions: []
status: active
merged_into: ""
superseded_by: ""
created: 2026-11-22
updated: 2026-11-24
version: 2
origin: default:iron-rule-2
---

何时：新增或修改主流程文件时。做什么：通用能力抽独立 Util（如 core/text-guard.mjs），主流程只做调用。怎么判：主流程禁止出现领域特定正则、分支表、特例清单，出现任一即算内嵌，不论行数多少；同一逻辑出现第 2 处必须抽 Util。
