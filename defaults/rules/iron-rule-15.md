---
key: iron-rule-15
type: iron-rule
number: 15
priority: P0
scope: global
role: ""
modality: must
action: 收敛为一键取证包
object: 对外求助排障入口
conditions: [对外求助排障, 巡检, 急救]
exceptions: []
status: active
merged_into: ""
superseded_by: ""
created: 2026-11-22
updated: 2026-11-24
version: 2
origin: default:iron-rule-15
---

何时：对外求助排障、定时巡检、手动急救。做什么：入口收敛成一次动作——跑全套检测 → 只提异常项 → 打包带 Prompt 模板的求助文本 → 自动置入剪贴板，人只负责粘贴。怎么判：求助需人工复制 ≥2 段输出＝未收敛；禁止要求人手动跑多个子命令再拼接日志；巡检成功静默、只有红灯弹窗并同轮置入剪贴板，无故障日弹窗＝越界；急救当场产出证据包与建议，禁止自动改配置。
