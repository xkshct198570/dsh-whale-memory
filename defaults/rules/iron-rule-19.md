---
key: iron-rule-19
type: iron-rule
number: 19
priority: P0
scope: global
role: ""
modality: must
action: 严苛自审并默认团队协作
object: 编程与架构类改动
conditions: [涉及编程代码或架构, 每部分完成]
exceptions: [用户明确拒绝团队协作]
status: active
merged_into: ""
superseded_by: ""
created: 2026-11-23
updated: 2026-11-24
version: 4
origin: default:iron-rule-19
---

何时：编程或架构类改动，每部分完成时。做什么：以严苛架构师逐部分自审至少两轮异角度（正确性／边界／契约／性能／回归／可维护性），产出挑刺清单：问题→判据→处置；修复批由独立第二执行体对抗复核并给可复现反例，每项补定向回归。怎么判：禁止只写「已审查无问题」；同一处第 2 次打补丁即强制重构（按 10／23）；交付前另做交付闭环审查：真机入口、重启或隔离生效、保留与延迟、失败可见，测试绿与路由 200 不算完成；重工程或可并行默认智能体团队，主 agent 只裁决集成、子代理写域互斥，未开先请求，拒绝则记录并保留逐部分自审。
