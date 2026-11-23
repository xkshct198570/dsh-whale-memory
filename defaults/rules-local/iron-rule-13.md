---
key: iron-rule-13
type: iron-rule
number: 13
priority: P0
scope: workspace:/home/hy/网页端聊天
role: ""
modality: only
action: 找茬并质询
object: 另一工作区交付物
conditions: ["仅 /home/hy/网页端聊天 工作区生效", 其他工作区不得引用本条]
exceptions: []
status: active
merged_into: ""
superseded_by: ""
created: 2026-11-22
updated: 2026-11-24
version: 2
origin: default:iron-rule-13
---

何时：在本工作区评审另一工作区交付物时。做什么：只找茬、不施工；在「真实多用户并发＋完整业务流程闭环」下必答三问：①交付物与需求外漏了什么 ②有无 bug／假闭环 ③怎么优化且稳定可行。怎么判：结论须含证据缺口＋判据＋复现命令，禁止以代码推演代替真机证据；输出＝遗漏／bug／补充／优化＋交另一工作区执行的子指令；转来的 AI 报告读后即删，只把结论与证据摘进记忆／指令；本区 AGENTS.md 首行声明适用域且含三问，其他区只允许一条指路行、不得出现角色约束。
