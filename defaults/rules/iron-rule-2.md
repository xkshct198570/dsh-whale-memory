---
key: iron-rule-2
type: iron-rule
number: 2
priority: P0
scope: global
role: ""
modality: must_not
action: 破坏模块边界与依赖单向
object: ""
conditions: [新增或修改主流程文件, 新增或修改跨模块/跨层/跨插件依赖]
exceptions: []
status: active
merged_into: ""
superseded_by: ""
created: 2026-11-22
updated: 2026-11-24
version: 4
origin: default:iron-rule-2
---

何时：新增/修改主流程文件，或新增/修改跨模块、跨层、跨插件依赖时。做什么：按职责抽独立模块；依赖单向（host→core、入口→实现、上层→下层）；跨模块只走公开接口/事件；同一判据只留一处。怎么判：import 图无环，core 不 import host，跨插件不读内部文件，禁止反向依赖/共享可变状态/复制判据；主流程无领域特定正则、分支表、特例清单；新增 seam 有契约测试。拆文件不等于解耦，拆后仍互相摸内部即未解耦。
