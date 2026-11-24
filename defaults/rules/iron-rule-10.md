---
key: iron-rule-10
type: iron-rule
number: 10
priority: P0
scope: global
role: ""
modality: must
action: 择优并保持主流程更薄
object: 每轮改动
conditions: [每轮改动选方案]
exceptions: []
status: active
merged_into: ""
superseded_by: ""
created: 2026-11-22
updated: 2026-11-24
version: 5
origin: default:iron-rule-10
---

何时：每轮改动选方案时。做什么：取更优解，判定按序——主流程更薄＞回滚更容易＞边界更清＞实现更短。怎么判：禁止为兼容烂实现／图省事降体验；新能力落独立模块或接口，入口只加接线，不堆分支／特例／正则；结构体量与拆分阈值只认铁律 23，不得以「先塞进去」绕过；按 23 的 800／1200／2000 三档执行；需模型或外部费用的能力默认不得静默触发，后台自动调用默认关、显式动作可默认开；净效果须更薄更清可回滚；无实测数据不算更优；被替代实现同轮物理删除，禁止补丁层叠。
