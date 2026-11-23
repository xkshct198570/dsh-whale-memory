---
key: iron-rule-safety
type: iron-rule
number: 0
priority: P0
scope: global
role: ""
modality: only
action: 存放
object: "认证凭据（token）"
conditions: [认证凭据存用, "动 whale.db 前"]
exceptions: []
status: active
merged_into: ""
superseded_by: ""
created: 2026-11-22
updated: 2026-11-24
version: 2
origin: default:iron-rule-safety
---

认证凭据（token／API 凭据）只能走环境变量或 DPAPI。何时：任何凭据存用、以及动 whale.db 前。做什么：凭据只进环境变量或 DPAPI，禁止明文落台账／脚本／日志；动库前先 VACUUM INTO data/backup/whale-<ts>.db。怎么判：仓库与日志 grep 无明文凭据，备份文件存在且时间戳新。
