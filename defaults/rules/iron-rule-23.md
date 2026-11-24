---
key: iron-rule-23
type: iron-rule
number: 23
priority: P0
scope: global
role: ""
modality: must
action: 按职责与体量预算拆分
object: 代码
conditions: [新增或修改手写源码, 文件将越过体量阈值, "新增 UI 页签或业务域"]
exceptions: ["生成块与 vendored 第三方由生成器或上游负责，但必须源拆分与可重现", "DSH 运行时要求单文件 bundle 时，源必须拆分并由构建生成产物", "字节等价搬家期职责登记在构建清单，分片首行不写注释"]
status: active
merged_into: ""
superseded_by: ""
created: 2026-11-24
updated: 2026-11-24
version: 3
origin: manual:1246277257
---

何时：新增或修改手写源码、UI 页签、业务域，或文件将越过体量阈值。做什么：按职责拆独立模块，入口只做装配；源与构建产物分离，生成器／构建脚本是唯一入口；存量超限文件先拆再上功能。怎么判：手写源码 >800 行须有拆分计划，>1200 行禁止新增功能，>2000 行先拆再做非修 bug 改动；单文件不得承担 ≥2 个页签／业务域；构建产物必须由源码可复现且 CI 校验一致；新增文件首行写职责与依赖方向；重构须有表征测试与产物对比。生成块、vendored 第三方、运行时单文件 bundle 不计手写行，但必须源拆分＋构建。 测试与脚本同计手写行；字节等价搬家期职责登记在构建清单，分片首行不写注释。
