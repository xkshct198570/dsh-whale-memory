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
version: 4
origin: default:iron-rule-4
---

何时：写或改测试断言；UI／组件改动；重构或抽取模块。做什么：断言真实 payload 与落库产物；UI 必须有组件级渲染冒烟或真机验证；重构先加表征测试锁住旧行为，再动结构。怎么判：禁止只测 200／mock；白屏／渲染异常要能被用例红出来；只按源码字符串断言不算；契约变更写清改哪条、为什么、旧断言为何失效，不得静默删；重构前后行为对比或产物一致。
