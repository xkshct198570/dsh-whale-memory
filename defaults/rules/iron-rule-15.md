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
conditions: [对外求助]
exceptions: []
status: active
merged_into: ""
superseded_by: ""
created: 2026-11-22
updated: 2026-11-22
version: 1
origin: default:iron-rule-15
---

对外求助的排障入口必须收敛成一次动作：跑全套检测 → 只提异常项 → 打包成带 Prompt 模板的求助文本 → 自动置入剪贴板，人只负责粘贴给 AI；禁止要求人手动跑多个子命令再自己拼接日志；巡检＝定时无人值守，成功必须静默，只有红灯弹窗，且弹窗同轮把报告置入剪贴板；急救＝人手动触发，当场产出证据包与建议，不自动改配置；判据：求助需人工复制 ≥2 段输出＝未收敛；巡检在无故障日弹窗＝越界；急救脚本不能一键产出可粘贴文本＝不合格。
