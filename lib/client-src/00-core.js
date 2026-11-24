/**
 * dsh-whale-memory Client 半（S3）。
 *
 * 六个页签：概览 / 记忆库 / 规则 / 召回 / 写入与关系 / 设置。
 * 规则页＝规则文件（~/.dsh/rules）的只读视图：git 三态、列表、详情/历史/diff；
 * 写操作（重建镜像/导入铁律）一律二次确认；回滚/编辑在 R3b 接入前只读展示。
 * 零构建：本文件即最终产物，只用 React.createElement。
 * 边界：只展示与触发"记忆"操作；不引用宿主 Client 包，不写 document.body，不用 iframe。
 */
window.__ModuleLoader__.load({
  id: 'dsh-whale-memory',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useMemo, useRef, useState } = React

    const NS = 'dsh-whale-memory'
    const PANEL_ID = 'whale-memory'
    const API = '/whale-memory/api'
    const PAGE_SIZE = 20
    const MAX_IMPORT_BYTES = 4 * 1024 * 1024
    /** 试用样例标记：清理时按 id 归档，tag 只作人肉识别（不参与机器逻辑）。 */
    const SAMPLE_TAG = 'whale-memory-sample'

    const TABS = [
      ['overview', 'tab.overview'],
      ['memory', 'tab.memory'],
      ['rules', 'tab.rules'],
      ['recall', 'tab.recall'],
      ['writes', 'tab.writes'],
      ['settings', 'tab.settings'],
    ]

