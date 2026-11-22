---
key: iron-rule-12
type: iron-rule
number: 12
priority: P0
scope: global
role: ""
modality: must
action: 更新
object: 收尾四件套交接文档
conditions: [会话收尾]
exceptions: []
status: active
merged_into: ""
superseded_by: ""
created: 2026-11-22
updated: 2026-11-22
version: 1
origin: default:iron-rule-12
---

会话收尾不论改动大小必须当场更新四份交接文档：①docs/新会话启动Prompt.txt（≤500 字：基线／待办／红线／坑）②docs/会话交接摘要-一页.md（进程表＋已封板 commit＋剩余待办＋红线）③docs/当前进度快照与待办清单.md（现役计数／开关／端口）④Router-lite_全量未完成事项清单_v4.md（完成项从正文删、计数同步）；基线钉 HEAD 短号＋最新灾备包名＋实测 PID；真无变化的份逐份说明「已核对」并给依据；判据：四份进本会话改动（diff／mtime 晚于会话起点），wc -m ≤500，基线三项与实测一致。
