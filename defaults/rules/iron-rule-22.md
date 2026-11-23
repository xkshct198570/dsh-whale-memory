---
key: iron-rule-22
type: iron-rule
number: 22
priority: P0
scope: global
role: ""
modality: must_not
action: "静默失败（fail-open／降级／跳过）"
object: ""
conditions: ["catch 后返回空值或默认值", 跳过写入或任务, 失败后流程继续]
exceptions: []
status: active
merged_into: ""
superseded_by: ""
created: 2026-11-24
updated: 2026-11-24
version: 2
origin: manual:
---

禁止静默失败：fail-open、降级或跳过必须留可判定证据（计数、日志、health 或断言），并让调用方知道结果不是成功。何时：catch 后返回空值／默认值、跳过写入、任务失败但流程继续。怎么判：故障注入后能在日志、面板或计数中看到该失败；禁止 ready 恒真、零命中无日志、失败仍标 done、保留死开关。
