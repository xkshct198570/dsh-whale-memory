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
conditions: [认证凭据存用]
exceptions: []
status: active
merged_into: ""
superseded_by: ""
created: 2026-11-22
updated: 2026-11-22
version: 1
origin: default:iron-rule-safety
---

认证凭据（token／API 凭据）只准走环境变量或 DPAPI；禁止落在台账／脚本／日志明文里；动 whale.db 前必须先 VACUUM INTO data/backup/whale-<ts>.db；判据：仓库与日志 grep 无明文凭据，备份文件存在且时间戳新。
