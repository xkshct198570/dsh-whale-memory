---
key: iron-rule-21
type: iron-rule
number: 21
priority: P0
scope: global
role: ""
modality: must
action: 隔离验证并备份
object: "运行中 DSH 的插件／客户端／配置／规则改动"
conditions: ["准备改变 live 行为", "落 live 前"]
exceptions: ["用户明确要求在 live 直接试且已确认备份"]
status: active
merged_into: ""
superseded_by: ""
created: 2026-11-24
updated: 2026-11-24
version: 3
origin: manual:
---

何时：任何会改变 live 行为的 DSH 改动——插件、客户端、配置、规则；落 live 前一律先隔离验证。做什么：在临时 DSH_HOME 与临时 dataDir 完成安装、启动、关键路由验证，再落 live；落 live 前备份对应库或配置。怎么判：有隔离 home 的安装／启动／取证记录与 live 备份文件；测试与探针一律用临时目录，用后删除。特别注意：HMR 只热更 client bundle，host 侧（index/src）改动必须重启宿主才生效；重启由用户执行，重启前 live 只标「待重启生效」，不得记已修复或已生效。
