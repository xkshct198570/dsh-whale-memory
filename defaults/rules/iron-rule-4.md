---
key: iron-rule-4
type: iron-rule
number: 4
priority: P0
scope: global
role: ""
modality: must
action: 断言
object: "真实 payload 映射与落库产物"
conditions: [写或改测试断言]
exceptions: [契约变更确需重写断言时须在交接写明改哪条与为什么]
status: active
merged_into: ""
superseded_by: ""
created: 2026-11-22
updated: 2026-11-24
version: 2
origin: default:iron-rule-4
---

何时：写或改测试断言时。做什么：断言真实 payload 映射与落库产物；改动只准增断言。怎么判：禁止只测 200／mock；契约变更确需重写断言时，在交接写明改哪条、为什么、旧断言为何失效，不得静默删。
