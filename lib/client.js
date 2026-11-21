/**
 * dsh-whale-memory Client 半（S3）。
 *
 * 五个页签：概览 / 记忆库 / 召回 / 写入与关系 / 设置。
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

    const TABS = [
      ['overview', 'tab.overview'],
      ['memory', 'tab.memory'],
      ['recall', 'tab.recall'],
      ['writes', 'tab.writes'],
      ['settings', 'tab.settings'],
    ]

    const dict = {
      zh: {
        'meta.title': '鲸忆记忆中枢',
        'meta.description': '本地长期记忆：节点、召回与写入审计。',

        'tab.overview': '概览',
        'tab.memory': '记忆库',
        'tab.recall': '召回',
        'tab.writes': '写入与关系',
        'tab.settings': '设置',

        'common.dash': '—',
        'common.retry': '重试',
        'common.refresh': '刷新',
        'common.loading': '读取中…',
        'common.empty': '暂无数据',
        'common.close': '关闭',
        'common.save': '保存',
        'common.saving': '保存中…',
        'common.cancel': '取消',
        'common.search': '搜索',
        'common.prev': '上一页',
        'common.next': '下一页',
        'common.pageInfo': '第 {from}–{to} 条 / 共 {total} 条',
        'common.total': '共 {total} 条',
        'common.now': '刚刚',
        'common.yes': '是',
        'common.no': '否',
        'common.charCount': '{n} / {max} 字',

        'state.loading': '读取中…',
        'state.error': '加载失败',
        'state.empty': '暂无数据',

        'health.db': 'DB',
        'health.migration': '迁移',
        'health.pending': 'pending',
        'health.job': 'job',
        'health.ok': '正常',
        'health.offline': '离线',
        'health.running': '运行中',
        'health.idle': '空闲',

        'overview.title': '概览',
        'overview.offlineTitle': '后端未连接',
        'overview.offlineDesc': '记忆服务当前不可达。确认 DSH 已启动；恢复后可重试。',
        'overview.recent': '最近 3 条召回',
        'overview.recentEmpty': '暂无召回记录',
        'overview.health': '健康状态',
        'overview.kpiNodes': '节点总数',
        'overview.kpiActive': '活跃节点',
        'overview.kpiRecalls': '今日召回',
        'overview.kpiEdges': '关系边',
        'overview.injected': '注入 {n} 字',
        'overview.injectedNone': '未注入',
        'overview.refreshed': '更新于 {time}',
        'overview.hits': '命中 {n}',
        'overview.injectedBadge': '已注入',
        'overview.notInjectedBadge': '未注入',

        'memory.title': '记忆库',
        'memory.searchPlaceholder': '输入关键词检索（防抖 300ms）…',
        'memory.searching': '检索中…',
        'memory.noResults': '没有命中',
        'memory.emptyTitle': '记忆库还是空的',
        'memory.emptyDesc': '先写第一条记忆，或从 JSONL 文件导入。',
        'memory.writeFirst': '写第一条',
        'memory.importJsonl': '导入 JSONL',
        'memory.newTitle': '新增记忆',
        'memory.writePlaceholder': '输入要记住的内容（≤500 字）…',
        'memory.writeLevel': '层级',
        'memory.writeType': '类型',
        'memory.writeTags': '标签（逗号分隔）',
        'memory.writeSubmit': '写入',
        'memory.written': '已写入：{id}',
        'memory.colText': '正文',
        'memory.colLevel': '层级',
        'memory.colType': '类型',
        'memory.colStatus': '状态',
        'memory.colScore': '分数',
        'memory.colSource': '来源',
        'memory.pageEmpty': '本页没有记录',
        'memory.searchMeta': '命中 {count} 条（低于阈值的候选 {below} 条）',
        'memory.searchMetaNoBelow': '命中 {count} 条',

        'detail.title': '记忆详情',
        'detail.text': '正文',
        'detail.level': '层级',
        'detail.status': '状态',
        'detail.tags': '标签',
        'detail.tagsPlaceholder': '逗号分隔',
        'detail.source': '来源',
        'detail.type': '类型',
        'detail.created': '创建时间',
        'detail.updated': '更新时间',
        'detail.bitemporal': '双时态',
        'detail.validAt': '生效时间',
        'detail.invalidAt': '失效时间',
        'detail.expiredAt': '过期时间',
        'detail.supersededBy': '被替代为',
        'detail.archive': '归档',
        'detail.archived': '已归档',
        'detail.saveEdit': '保存编辑',
        'detail.saved': '已保存',
        'detail.loadFailed': '读取详情失败',
        'detail.invalidText': '正文需为 1–500 字',

        'recall.title': '召回',
        'recall.recent': '最近召回（只读）',
        'recall.colTime': '时间',
        'recall.colQuery': '查询',
        'recall.colHits': '命中',
        'recall.colChars': '字数',
        'recall.colElapsed': '耗时',
        'recall.colInjected': '是否注入',
        'recall.colUsed': '采纳',
        'recall.injectedYes': '已注入',
        'recall.injectedNo': '未注入',
        'recall.usedYes': '已采纳',
        'recall.usedNo': '未采纳',
        'recall.testTitle': '纯检索测试',
        'recall.testNote': '只调用检索接口；不调模型、不写库、不产生召回副作用。',
        'recall.testPlaceholder': '输入要测试的词…',
        'recall.runTest': '检索',
        'recall.testEmpty': '没有命中（低于最小相关度）',
        'recall.testMeta': '返回 {count} 条 · {ms} ms',
        'recall.testError': '检索失败',
        'recall.recentEmpty': '暂无召回记录',

        'writes.title': '写入与关系',
        'writes.recent': '最近写入审计（只读）',
        'writes.colTime': '时间',
        'writes.colAction': '动作',
        'writes.colNode': '节点',
        'writes.colReason': '原因',
        'writes.edges': '关系边',
        'writes.recentCount': '最近写入',
        'writes.note': '本页只读；写入由记忆接口与召回注入产生。',
        'writes.empty': '暂无写入记录',

        'settings.title': '设置',
        'settings.groupBackend': '接入',
        'settings.groupRecall': '注入',
        'settings.groupWrite': '写入',
        'settings.groupPanel': '面板',
        'settings.groupAdvanced': '高级',
        'settings.backendMode': '后端模式',
        'settings.backendUrl': '外部服务地址',
        'settings.backendTimeout': '请求超时（ms）',
        'settings.recallEnabled': '启用召回注入',
        'settings.maxHits': '最多命中条数',
        'settings.charBudget': '注入字数上限',
        'settings.minRel': '最小相关度（0–1）',
        'settings.recallTimeout': '召回超时（ms）',
        'settings.writeEnabled': '启用写入',
        'settings.reviewMode': '写入审核',
        'settings.maxChars': '单条字数上限',
        'settings.pollMs': '面板轮询间隔（ms）',
        'settings.allowRemote': '允许非回环访问',
        'settings.logLevel': '日志级别',
        'settings.worker': '使用 worker 执行检索',
        'settings.save': '保存设置',
        'settings.saved': '已保存（{time}）',
        'settings.saveFailed': '保存失败',
        'settings.loadFailed': '读取配置失败',
        'settings.defaultsNote': '配置未回显的分组按默认值展示；保存会整体提交上述场景。',
        'settings.restartNote': '接入与 worker 变更通常需要重载插件后生效。',
        'settings.allowRemoteWarn': '放开后局域网内其他设备可访问本面板 API。',
        'settings.readonlyUnavailable': '当前运行环境不支持保存配置（只读）。',
        'settings.invalidValue': '存在超出范围或非数字的取值，请修正后再保存。',

        'import.reading': '正在读取文件…',
        'import.uploading': '正在导入…',
        'import.tooLarge': '文件超过 4 MB，请拆分后导入。',
        'import.readFailed': '文件读取失败。',
        'import.smallDone': '导入完成：新增 {added} · 跳过 {skipped} · 错误 {errors}',
        'import.progress': '导入中 {done}/{total} · 新增 {added} · 跳过 {skipped} · 错误 {errors}',
        'import.done': '导入完成：新增 {added} · 跳过 {skipped} · 错误 {errors}',
        'import.failed': '导入失败',
        'import.total': '共 {total} 行',
        'import.button': '导入 JSONL',
        'import.export': '导出',
        'import.accept': '.jsonl,.txt,text/plain',

        'status.active': '活跃',
        'status.archived': '已归档',
        'status.stale': '陈旧',
        'status.superseded': '已替代',
        'level.core': '核心',
        'level.important': '重要',
        'level.normal': '普通',
        'type.semantic': '语义',
        'type.procedural': '流程',
        'type.episodic': '事件',
        'type.mixed': '混合',
        'source.owner': '主人',
        'source.self': '自身',
        'source.group': '群组',
        'source.web': '网页',
        'source.tool': '工具',
        'source.import': '导入',

        'err.network': '网络不可达，请确认 DSH 运行中。',
        'err.backend_unreachable': '记忆后端不可达。',
        'err.backend_unavailable': '记忆后端未提供该能力。',
        'err.backend_error': '记忆后端返回错误。',
        'err.invalid_query': '查询词不能为空。',
        'err.invalid_text': '正文不合法（1–500 字）。',
        'err.invalid_level': '层级取值不合法。',
        'err.invalid_memory_type': '记忆类型不合法。',
        'err.invalid_tags': '标签格式不合法。',
        'err.identity_required': '缺少身份键，无法读写。',
        'err.write_disabled': '写入已关闭。',
        'err.duplicate': '内容已存在，已跳过。',
        'err.node_not_found': '找不到该记忆节点。',
        'err.job_not_found': '找不到该导入任务。',
        'err.invalid_job_id': '导入任务 id 不合法。',
        'err.config_save_unavailable': '当前环境不支持保存配置（只读）。',
        'err.config_save_failed': '配置保存失败。',
        'err.invalid_config': '配置内容不合法。',
        'err.invalid_value': '存在超出范围的取值。',
        'err.payload_too_large': '请求体过大（上限 4 MB）。',
        'err.invalid_jsonl': 'JSONL 内容不合法。',
        'err.method_not_allowed': '接口不支持该请求方法。',
        'err.not_found': '接口不存在。',
        'err.not_loopback': '仅允许本机回环访问。',
        'err.file_too_large': '文件超过 4 MB，请拆分后导入。',
        'err.read_error': '文件读取失败。',
        'err.unknown': '未知错误。',
      },
      en: {
        'meta.title': 'Whale Memory',
        'meta.description': 'Local long-term memory: nodes, recall and write audit.',

        'tab.overview': 'Overview',
        'tab.memory': 'Memory',
        'tab.recall': 'Recall',
        'tab.writes': 'Writes & edges',
        'tab.settings': 'Settings',

        'common.dash': '—',
        'common.retry': 'Retry',
        'common.refresh': 'Refresh',
        'common.loading': 'Loading…',
        'common.empty': 'No data',
        'common.close': 'Close',
        'common.save': 'Save',
        'common.saving': 'Saving…',
        'common.cancel': 'Cancel',
        'common.search': 'Search',
        'common.prev': 'Previous',
        'common.next': 'Next',
        'common.pageInfo': '{from}–{to} of {total}',
        'common.total': '{total} total',
        'common.now': 'just now',
        'common.yes': 'Yes',
        'common.no': 'No',
        'common.charCount': '{n} / {max} chars',

        'state.loading': 'Loading…',
        'state.error': 'Failed to load',
        'state.empty': 'No data',

        'health.db': 'DB',
        'health.migration': 'Migration',
        'health.pending': 'pending',
        'health.job': 'job',
        'health.ok': 'OK',
        'health.offline': 'Offline',
        'health.running': 'Running',
        'health.idle': 'Idle',

        'overview.title': 'Overview',
        'overview.offlineTitle': 'Backend unreachable',
        'overview.offlineDesc': 'The memory service is not reachable. Confirm DSH is running, then retry.',
        'overview.recent': 'Latest 3 recalls',
        'overview.recentEmpty': 'No recall records yet',
        'overview.health': 'Health',
        'overview.kpiNodes': 'Total nodes',
        'overview.kpiActive': 'Active nodes',
        'overview.kpiRecalls': 'Recalls today',
        'overview.kpiEdges': 'Edges',
        'overview.injected': '{n} chars injected',
        'overview.injectedNone': 'not injected',
        'overview.refreshed': 'Updated {time}',
        'overview.hits': '{n} hits',
        'overview.injectedBadge': 'Injected',
        'overview.notInjectedBadge': 'Not injected',

        'memory.title': 'Memory',
        'memory.searchPlaceholder': 'Search keywords (300 ms debounce)…',
        'memory.searching': 'Searching…',
        'memory.noResults': 'No matches',
        'memory.emptyTitle': 'Memory is empty',
        'memory.emptyDesc': 'Write the first memory, or import a JSONL file.',
        'memory.writeFirst': 'Write first memory',
        'memory.importJsonl': 'Import JSONL',
        'memory.newTitle': 'New memory',
        'memory.writePlaceholder': 'Text to remember (max 500 chars)…',
        'memory.writeLevel': 'Level',
        'memory.writeType': 'Type',
        'memory.writeTags': 'Tags (comma separated)',
        'memory.writeSubmit': 'Write',
        'memory.written': 'Written: {id}',
        'memory.colText': 'Text',
        'memory.colLevel': 'Level',
        'memory.colType': 'Type',
        'memory.colStatus': 'Status',
        'memory.colScore': 'Score',
        'memory.colSource': 'Source',
        'memory.pageEmpty': 'No records on this page',
        'memory.searchMeta': '{count} matches ({below} candidates below threshold)',
        'memory.searchMetaNoBelow': '{count} matches',

        'detail.title': 'Memory detail',
        'detail.text': 'Text',
        'detail.level': 'Level',
        'detail.status': 'Status',
        'detail.tags': 'Tags',
        'detail.tagsPlaceholder': 'comma separated',
        'detail.source': 'Source',
        'detail.type': 'Type',
        'detail.created': 'Created',
        'detail.updated': 'Updated',
        'detail.bitemporal': 'Bi-temporal',
        'detail.validAt': 'Valid from',
        'detail.invalidAt': 'Invalid at',
        'detail.expiredAt': 'Expired at',
        'detail.supersededBy': 'Superseded by',
        'detail.archive': 'Archive',
        'detail.archived': 'Archived',
        'detail.saveEdit': 'Save edits',
        'detail.saved': 'Saved',
        'detail.loadFailed': 'Failed to load detail',
        'detail.invalidText': 'Text must be 1–500 chars',

        'recall.title': 'Recall',
        'recall.recent': 'Recent recalls (read-only)',
        'recall.colTime': 'Time',
        'recall.colQuery': 'Query',
        'recall.colHits': 'Hits',
        'recall.colChars': 'Chars',
        'recall.colElapsed': 'Elapsed',
        'recall.colInjected': 'Injected',
        'recall.colUsed': 'Adopted',
        'recall.injectedYes': 'Injected',
        'recall.injectedNo': 'Not injected',
        'recall.usedYes': 'Adopted',
        'recall.usedNo': 'Not adopted',
        'recall.testTitle': 'Search-only test',
        'recall.testNote': 'Calls the search endpoint only; no model call, no writes, no recall side effects.',
        'recall.testPlaceholder': 'Keyword to test…',
        'recall.runTest': 'Search',
        'recall.testEmpty': 'No matches (below minimum relevance)',
        'recall.testMeta': '{count} results · {ms} ms',
        'recall.testError': 'Search failed',
        'recall.recentEmpty': 'No recall records yet',

        'writes.title': 'Writes & edges',
        'writes.recent': 'Recent write audit (read-only)',
        'writes.colTime': 'Time',
        'writes.colAction': 'Action',
        'writes.colNode': 'Node',
        'writes.colReason': 'Reason',
        'writes.edges': 'Edges',
        'writes.recentCount': 'Recent writes',
        'writes.note': 'This page is read-only; writes come from the memory API and recall injection.',
        'writes.empty': 'No write records yet',

        'settings.title': 'Settings',
        'settings.groupBackend': 'Backend',
        'settings.groupRecall': 'Injection',
        'settings.groupWrite': 'Write',
        'settings.groupPanel': 'Panel',
        'settings.groupAdvanced': 'Advanced',
        'settings.backendMode': 'Backend mode',
        'settings.backendUrl': 'External service URL',
        'settings.backendTimeout': 'Request timeout (ms)',
        'settings.recallEnabled': 'Enable recall injection',
        'settings.maxHits': 'Max hits',
        'settings.charBudget': 'Injected char budget',
        'settings.minRel': 'Minimum relevance (0–1)',
        'settings.recallTimeout': 'Recall timeout (ms)',
        'settings.writeEnabled': 'Enable writes',
        'settings.reviewMode': 'Write review',
        'settings.maxChars': 'Max chars per memory',
        'settings.pollMs': 'Panel poll interval (ms)',
        'settings.allowRemote': 'Allow non-loopback access',
        'settings.logLevel': 'Log level',
        'settings.worker': 'Run search in worker',
        'settings.save': 'Save settings',
        'settings.saved': 'Saved ({time})',
        'settings.saveFailed': 'Save failed',
        'settings.loadFailed': 'Failed to load configuration',
        'settings.defaultsNote': 'Groups absent from the config echo are shown with defaults; saving submits all groups above.',
        'settings.restartNote': 'Backend and worker changes usually take effect after reloading the plugin.',
        'settings.allowRemoteWarn': 'When enabled, other devices on the LAN can reach this panel API.',
        'settings.readonlyUnavailable': 'Config saving is unavailable in this runtime (read-only).',
        'settings.invalidValue': 'Some values are out of range or not numeric; fix them before saving.',

        'import.reading': 'Reading file…',
        'import.uploading': 'Importing…',
        'import.tooLarge': 'File exceeds 4 MB; split it before importing.',
        'import.readFailed': 'Failed to read the file.',
        'import.smallDone': 'Import finished: added {added} · skipped {skipped} · errors {errors}',
        'import.progress': 'Importing {done}/{total} · added {added} · skipped {skipped} · errors {errors}',
        'import.done': 'Import finished: added {added} · skipped {skipped} · errors {errors}',
        'import.failed': 'Import failed',
        'import.total': '{total} lines',
        'import.button': 'Import JSONL',
        'import.export': 'Export',
        'import.accept': '.jsonl,.txt,text/plain',

        'status.active': 'Active',
        'status.archived': 'Archived',
        'status.stale': 'Stale',
        'status.superseded': 'Superseded',
        'level.core': 'Core',
        'level.important': 'Important',
        'level.normal': 'Normal',
        'type.semantic': 'Semantic',
        'type.procedural': 'Procedural',
        'type.episodic': 'Episodic',
        'type.mixed': 'Mixed',
        'source.owner': 'Owner',
        'source.self': 'Self',
        'source.group': 'Group',
        'source.web': 'Web',
        'source.tool': 'Tool',
        'source.import': 'Import',

        'err.network': 'Network unreachable; confirm DSH is running.',
        'err.backend_unreachable': 'Memory backend is unreachable.',
        'err.backend_unavailable': 'Memory backend does not provide this capability.',
        'err.backend_error': 'Memory backend returned an error.',
        'err.invalid_query': 'Query must not be empty.',
        'err.invalid_text': 'Text is invalid (1–500 chars).',
        'err.invalid_level': 'Invalid level.',
        'err.invalid_memory_type': 'Invalid memory type.',
        'err.invalid_tags': 'Invalid tags.',
        'err.identity_required': 'Identity keys are missing; cannot read or write.',
        'err.write_disabled': 'Writes are disabled.',
        'err.duplicate': 'Content already exists; skipped.',
        'err.node_not_found': 'Memory node not found.',
        'err.job_not_found': 'Import job not found.',
        'err.invalid_job_id': 'Invalid import job id.',
        'err.config_save_unavailable': 'Config saving is unavailable in this runtime (read-only).',
        'err.config_save_failed': 'Failed to save configuration.',
        'err.invalid_config': 'Invalid configuration.',
        'err.invalid_value': 'A value is out of range.',
        'err.payload_too_large': 'Request body too large (4 MB limit).',
        'err.invalid_jsonl': 'Invalid JSONL content.',
        'err.method_not_allowed': 'Method not allowed.',
        'err.not_found': 'Endpoint not found.',
        'err.not_loopback': 'Loopback access only.',
        'err.file_too_large': 'File exceeds 4 MB; split it before importing.',
        'err.read_error': 'Failed to read the file.',
        'err.unknown': 'Unknown error.',
      },
    }

    // ---------------------------------------------------------------- runtime

    /** Locale face captured at apply time; UI hooks read the active language from it. */
    let localeService = null

    function localeTag(active) {
      const id = String(active || 'zh')
      if (id.toLowerCase().startsWith('zh')) return 'zh-CN'
      if (id.toLowerCase().startsWith('en')) return 'en-US'
      return id
    }

    function useActiveLocale() {
      const read = () => (localeService && typeof localeService.getSnapshot === 'function'
        ? localeService.getSnapshot().active
        : 'zh')
      const [active, setActive] = useState(read)
      useEffect(() => {
        if (!localeService || typeof localeService.subscribe !== 'function') return undefined
        return localeService.subscribe(() => setActive(read()))
      }, [])
      return active
    }

    function useVisible() {
      const read = () => (typeof document === 'undefined' ? true : document.visibilityState !== 'hidden')
      const [visible, setVisible] = useState(read)
      useEffect(() => {
        if (typeof document === 'undefined') return undefined
        const onChange = () => setVisible(read())
        document.addEventListener('visibilitychange', onChange)
        return () => document.removeEventListener('visibilitychange', onChange)
      }, [])
      return visible
    }

    // ------------------------------------------------------------------ fetch

    function statusCode(status) {
      if (status === 400) return 'invalid_config'
      if (status === 404) return 'not_found'
      if (status === 413) return 'payload_too_large'
      if (status === 405) return 'method_not_allowed'
      if (status === 501) return 'config_save_unavailable'
      if (status === 502 || status === 503) return 'backend_error'
      return 'unknown_error'
    }

    async function callJson(path, opts) {
      let res
      try {
        res = await fetch(API + path, opts)
      } catch (cause) {
        const err = new Error('network_error')
        err.code = 'network_error'
        err.cause = cause
        throw err
      }
      const body = await res.json().catch(() => null)
      if (!res.ok || body === null || body.ok === false) {
        const code = (body && typeof body.error === 'string' && body.error) || statusCode(res.status)
        const err = new Error(code)
        err.code = code
        err.status = res.status
        err.offline = Boolean(body && body.offline)
        err.body = body
        throw err
      }
      return body
    }

    function hasKey(key) {
      return Object.prototype.hasOwnProperty.call(dict.zh, key)
        || Object.prototype.hasOwnProperty.call(dict.en, key)
    }

    function errText(t, err) {
      const code = String((err && (err.code || err.message)) || 'unknown')
      return t(hasKey('err.' + code) ? 'err.' + code : 'err.unknown')
    }

    // ------------------------------------------------------------- formatting

    function toDate(ts) {
      if (ts === null || ts === undefined || ts === '') return null
      const n = Number(ts)
      if (Number.isFinite(n) && n > 0) {
        const ms = n < 1e11 ? n * 1000 : n
        const d = new Date(ms)
        return Number.isNaN(d.getTime()) ? null : d
      }
      const d = new Date(String(ts))
      return Number.isNaN(d.getTime()) ? null : d
    }

    function fmtNum(value, locale) {
      const n = Number(value)
      if (value === null || value === undefined || value === '' || !Number.isFinite(n)) return '—'
      try {
        return new Intl.NumberFormat(localeTag(locale)).format(n)
      } catch {
        return String(n)
      }
    }

    function fmtScore(value, locale) {
      const n = Number(value)
      if (!Number.isFinite(n)) return '—'
      try {
        return new Intl.NumberFormat(localeTag(locale), {
          minimumFractionDigits: 3, maximumFractionDigits: 3,
        }).format(n)
      } catch {
        return n.toFixed(3)
      }
    }

    function fmtTime(ts, locale) {
      const d = toDate(ts)
      if (!d) return '—'
      try {
        return new Intl.DateTimeFormat(localeTag(locale), {
          dateStyle: 'short', timeStyle: 'medium',
        }).format(d)
      } catch {
        return d.toISOString()
      }
    }

    function sameLocalDay(a, b) {
      return a.getFullYear() === b.getFullYear()
        && a.getMonth() === b.getMonth()
        && a.getDate() === b.getDate()
    }

    function pick() {
      for (let i = 0; i < arguments.length; i += 1) {
        const v = arguments[i]
        if (v !== undefined && v !== null && v !== '') return v
      }
      return null
    }

    function numOrNull(v) {
      const n = Number(v)
      return Number.isFinite(n) ? n : null
    }

    function parseTags(value) {
      if (Array.isArray(value)) return value.filter((x) => typeof x === 'string')
      if (typeof value === 'string' && value.trim()) {
        try {
          const parsed = JSON.parse(value)
          if (Array.isArray(parsed)) return parsed.filter((x) => typeof x === 'string')
        } catch {
          return value.split(',').map((s) => s.trim()).filter(Boolean)
        }
      }
      return []
    }

    function statusLabel(t, value) {
      return hasKey('status.' + value) ? t('status.' + value) : (value || '—')
    }

    function levelLabel(t, value) {
      return hasKey('level.' + value) ? t('level.' + value) : (value || '—')
    }

    function typeLabel(t, value) {
      return hasKey('type.' + value) ? t('type.' + value) : (value || '—')
    }

    function sourceLabel(t, value) {
      return hasKey('source.' + value) ? t('source.' + value) : (value || '—')
    }

    function todayRecalls(items) {
      if (!Array.isArray(items)) return null
      const today = new Date()
      let count = 0
      let chars = 0
      for (const item of items) {
        const d = toDate(item && item.ts)
        if (d && sameLocalDay(d, today)) {
          count += 1
          if (item.injected) chars += Number(item.chars) || 0
        }
      }
      return { count, chars }
    }

    // --------------------------------------------------------------- elements

    function Card(props) {
      return h('section', { style: css.card }, props.children)
    }

    function SectionTitle(props) {
      return h('div', { style: css.cardTitle }, props.children)
    }

    function Muted(props) {
      return h('div', { style: css.muted }, props.children)
    }

    function Note(props) {
      return h('div', { style: css.note }, props.children)
    }

    function StateBlock(props) {
      const { t, status, err, onRetry, empty } = props
      if (status === 'loading') return h('div', { style: css.muted }, t('state.loading'))
      if (status === 'error') {
        return h('div', { style: css.errorBox },
          h('div', { style: css.error }, errText(t, err)),
          onRetry ? h('button', { style: css.button, onClick: onRetry }, t('common.retry')) : null)
      }
      return h('div', { style: css.tertiary }, empty || t('state.empty'))
    }

    function Kpi(props) {
      return h('div', { style: css.kpi },
        h('div', { style: css.kpiLabel }, props.label),
        h('div', { style: css.kpiValue }, props.value),
        props.sub ? h('div', { style: css.kpiSub }, props.sub) : null)
    }

    function HealthPill(props) {
      const { label, value, tone } = props
      const color = tone === 'error'
        ? 'var(--dsw-alias-state-error-primary)'
        : tone === 'ok'
          ? 'var(--dsw-alias-state-success-primary)'
          : tone === 'warn'
            ? 'var(--dsw-alias-state-warn-primary)'
            : 'var(--dsw-alias-label-tertiary)'
      return h('span', { style: css.pill, title: `${label}: ${value}` },
        h('span', { style: { ...css.dot, background: color } }),
        h('span', { style: css.pillLabel }, label),
        h('span', { style: { ...css.pillValue, color: tone === 'muted' ? 'var(--dsw-alias-label-secondary)' : 'var(--dsw-alias-label-primary)' } }, value))
    }

    function Switch(props) {
      const { checked, onChange, label } = props
      return h('label', { style: css.switchRow },
        h('input', {
          type: 'checkbox', checked: Boolean(checked), style: css.checkbox,
          onChange: (e) => onChange(e.target.checked),
        }),
        h('span', { style: css.switchLabel }, label))
    }

    function TextField(props) {
      const { label, value, onChange, placeholder } = props
      return h('label', { style: css.field },
        h('span', { style: css.fieldLabel }, label),
        h('input', {
          style: css.input, value: value === null || value === undefined ? '' : String(value),
          placeholder: placeholder || '', onChange: (e) => onChange(e.target.value),
        }))
    }

    function NumField(props) {
      const { label, value, min, max, step, onChange } = props
      return h('label', { style: css.field },
        h('span', { style: css.fieldLabel }, label),
        h('input', {
          style: css.input, type: 'number', value: value === undefined || value === null ? '' : value,
          min, max, step: step || 1,
          onChange: (e) => onChange(e.target.value === '' ? '' : Number(e.target.value)),
        }))
    }

    function SelectField(props) {
      const { label, value, options, onChange } = props
      return h('label', { style: css.field },
        h('span', { style: css.fieldLabel }, label),
        h('select', { style: css.select, value, onChange: (e) => onChange(e.target.value) },
          options.map(([v, l]) => h('option', { key: v, value: v }, l))))
    }

    // ------------------------------------------------------------------ panel

    function PanelIcon(props) {
      const size = Number(props.size) || 18
      const color = props.active
        ? 'var(--dsw-alias-brand-primary)'
        : 'var(--dsw-alias-label-secondary)'
      return h('span', {
        style: { width: size, height: size, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color },
        'aria-hidden': 'true',
      }, h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
      },
      h('rect', { x: 6, y: 6, width: 12, height: 12, rx: 2 }),
      h('path', { d: 'M9 6V3M15 6V3M9 21v-3M15 21v-3M6 9H3M6 15H3M21 9h-3M21 15h-3' }),
      h('path', { d: 'M9.5 12h5M12 9.5v5' })))
    }

    function Panel(props) {
      const t = props.t
      const locale = useActiveLocale()
      const visible = useVisible()
      const [tab, setTab] = useState('overview')
      const [version, setVersion] = useState(0)
      const [pollMs, setPollMs] = useState(60000)
      const [importState, setImportState] = useState(null)
      const fileRef = useRef(null)

      useEffect(() => {
        let alive = true
        callJson('/config').then((body) => {
          const value = Number(body && body.config && body.config.panel && body.config.panel.pollMs)
          if (alive && Number.isFinite(value) && value > 0) setPollMs(value)
        }).catch(() => { /* 面板轮询回退默认值 */ })
        return () => { alive = false }
      }, [])

      // 202 后的导入任务进度；页面隐藏时暂停轮询，回到前台续上。
      useEffect(() => {
        if (!visible) return undefined
        if (!importState || importState.status !== 'running') return undefined
        const jobId = importState.jobId
        let alive = true
        let timer = null
        const poll = async () => {
          try {
            const body = await callJson('/import/status?id=' + encodeURIComponent(jobId))
            if (!alive) return
            const job = (body && body.job) || body || {}
            const total = Number(job.total || importState.total || 0)
            const added = Number(job.added) || 0
            const skipped = Number(job.skipped) || 0
            const errors = Number(job.errors) || 0
            const state = String(job.state || '')
            const finished = state === 'done' || state === 'completed' || state === 'failed' || state === 'error'
              || (total > 0 && added + skipped + errors >= total)
            if (finished) {
              setImportState({ status: 'done', jobId, total, added, skipped, errors, state })
              setVersion((v) => v + 1)
            } else {
              setImportState((prev) => (prev && prev.status === 'running'
                ? { ...prev, total, added, skipped, errors, state }
                : prev))
              timer = setTimeout(poll, 600)
            }
          } catch (err) {
            if (alive) setImportState({ status: 'error', jobId, code: (err && err.code) || 'unknown_error' })
          }
        }
        timer = setTimeout(poll, 300)
        return () => { alive = false; if (timer) clearTimeout(timer) }
      }, [visible, importState && importState.status, importState && importState.jobId])

      const onFile = async (event) => {
        const file = event.target.files && event.target.files[0]
        event.target.value = ''
        if (!file) return
        if (Number(file.size) > MAX_IMPORT_BYTES) {
          setImportState({ status: 'error', code: 'file_too_large' })
          return
        }
        setImportState({ status: 'reading', name: file.name })
        let text = ''
        try {
          text = await file.text()
        } catch (err) {
          setImportState({ status: 'error', code: 'read_error' })
          return
        }
        setImportState({ status: 'uploading', name: file.name })
        try {
          const body = await callJson('/import', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonl: text }),
          })
          if (body && body.async === true && body.jobId !== undefined) {
            setImportState({
              status: 'running', jobId: body.jobId, total: Number(body.total) || 0,
              added: 0, skipped: 0, errors: 0,
            })
          } else {
            const added = Number(body && body.added) || 0
            const skipped = Number(body && body.skipped) || 0
            const errors = Number(body && body.errors) || 0
            setImportState({ status: 'done', added, skipped, errors, total: added + skipped + errors })
            setVersion((v) => v + 1)
          }
        } catch (err) {
          setImportState({ status: 'error', code: (err && err.code) || 'unknown_error' })
        }
      }

      const onSaved = (draft) => {
        const value = Number(draft && draft.panel && draft.panel.pollMs)
        if (Number.isFinite(value) && value >= 5000) setPollMs(value)
      }

      const viewProps = { t, locale, version, refreshKey: version }
      let view
      if (tab === 'memory') view = h(MemoryTab, { ...viewProps, onImport: () => { if (fileRef.current) fileRef.current.click() } })
      else if (tab === 'recall') view = h(RecallTab, viewProps)
      else if (tab === 'writes') view = h(WritesTab, viewProps)
      else if (tab === 'settings') view = h(SettingsTab, { t, locale, onSaved })
      else view = h(Overview, { ...viewProps, pollMs })

      let importCard = null
      if (importState) {
        const close = () => setImportState(null)
        if (importState.status === 'error') {
          importCard = h(Card, null,
            h('div', { style: css.error }, t('import.failed') + ' — ' + t('err.' + (hasKey('err.' + importState.code) ? importState.code : 'unknown'))),
            h('button', { style: css.button, onClick: close }, t('common.close')))
        } else if (importState.status === 'done') {
          importCard = h(Card, null,
            h('div', { style: css.ok }, t('import.done', {
              added: fmtNum(importState.added, locale),
              skipped: fmtNum(importState.skipped, locale),
              errors: fmtNum(importState.errors, locale),
            })),
            h('div', { style: css.muted }, t('import.total', { total: fmtNum(importState.total, locale) })),
            h('button', { style: css.button, onClick: close }, t('common.close')))
        } else if (importState.status === 'running') {
          const done = importState.added + importState.skipped + importState.errors
          const total = importState.total || 0
          const pct = total > 0 ? Math.min(100, (done / total) * 100) : 0
          importCard = h(Card, null,
            h('div', { style: css.cardTitle }, t('import.progress', {
              done: fmtNum(done, locale), total: fmtNum(total, locale),
              added: fmtNum(importState.added, locale),
              skipped: fmtNum(importState.skipped, locale),
              errors: fmtNum(importState.errors, locale),
            })),
            h('div', { style: css.progress }, h('div', { style: { ...css.progressFill, width: pct + '%' } })),
            h('button', { style: css.button, onClick: close }, t('common.close')))
        } else {
          importCard = h(Card, null,
            h('div', { style: css.muted }, importState.status === 'reading' ? t('import.reading') : t('import.uploading')))
        }
      }

      return h('div', { style: css.panel },
        h('header', { style: css.header },
          h('div', { style: css.headerText },
            h('div', { style: css.title }, t('meta.title')),
            h('div', { style: css.desc }, t('meta.description'))),
          h('div', { style: css.actions },
            h('button', { style: css.buttonPrimary, onClick: () => { if (fileRef.current) fileRef.current.click() } },
              t('import.button')),
            h('a', { style: css.linkButton, href: API + '/export', download: 'whale-memory.jsonl' }, t('import.export')),
            h('button', { style: css.button, onClick: () => setVersion((v) => v + 1) }, t('common.refresh')),
            h('input', {
              ref: fileRef, type: 'file', accept: t('import.accept'),
              style: { display: 'none' }, onChange: onFile,
            }))),
        importCard,
        h('nav', { style: css.tabs }, TABS.map(([key, labelKey]) => h('button', {
          key,
          style: key === tab ? css.tabActive : css.tab,
          onClick: () => setTab(key),
        }, t(labelKey)))),
        h('main', { style: css.main }, view))
    }

    // --------------------------------------------------------------- overview

    function Overview(props) {
      const { t, locale, pollMs, version } = props
      const visible = useVisible()
      const [stats, setStats] = useState(null)
      const [statsErr, setStatsErr] = useState(null)
      const [recent, setRecent] = useState({ status: 'loading', items: [] })
      const [recalls, setRecalls] = useState({ status: 'loading', items: [] })
      const [reloadKey, setReloadKey] = useState(0)

      useEffect(() => {
        if (!visible) return undefined
        let alive = true
        const load = async () => {
          try {
            const body = await callJson('/stats')
            if (alive) {
              setStats((body && body.stats) || body)
              setStatsErr(null)
            }
          } catch (err) {
            if (alive) setStatsErr(err)
          }
          try {
            const body = await callJson('/recent?limit=3')
            if (alive) setRecent({ status: 'ok', items: Array.isArray(body.items) ? body.items : [] })
          } catch (err) {
            if (alive) setRecent({ status: 'error', err, items: [] })
          }
          try {
            const body = await callJson('/recalls?limit=100')
            if (alive) setRecalls({ status: 'ok', items: Array.isArray(body.items) ? body.items : [] })
          } catch (err) {
            if (alive) setRecalls({ status: 'error', err, items: [] })
          }
        }
        load()
        const every = Math.max(5000, Number(pollMs) || 60000)
        const timer = setInterval(load, every)
        return () => { alive = false; clearInterval(timer) }
      }, [visible, pollMs, version, reloadKey])

      if (!stats && !statsErr) {
        return h(Card, null, h(StateBlock, { t, status: 'loading' }))
      }

      const s = stats || {}
      const totals = (s && s.totals) || s || {}
      const nodesTotal = pick(totals.nodes_total, s.nodes_total)
      const nodesActive = pick(totals.nodes_active, s.nodes_active)
      const edges = pick(totals.edges, s.edges)
      const schemaVersion = pick(s.schema_version, stats && stats.schema_version)
      const pending = pick(
        s.pending, s.pending_nodes, s.vector_pending, s.pending_jobs,
        totals.pending, totals.pending_nodes,
      )
      const jobRaw = pick(s.active_job, s.active_jobs, s.jobs, s.job, totals.jobs)
      let jobText = '—'
      if (jobRaw !== null) {
        if (typeof jobRaw === 'number') jobText = fmtNum(jobRaw, locale)
        else if (typeof jobRaw === 'object') {
          const state = String(jobRaw.state || '')
          jobText = state ? (state === 'running' ? t('health.running') : state) : '—'
        } else jobText = String(jobRaw)
      }

      const today = recalls.status === 'ok' ? todayRecalls(recalls.items) : null
      const recallKpi = pick(totals.recalls_today, today && today.count)
      const injected = pick(totals.injected_chars_today, today && today.chars)
      const offline = Boolean(statsErr)
      const dbTone = offline ? 'error' : stats ? 'ok' : 'muted'

      const recentRows = recent.items.map((item, index) => h('div', {
        key: index, style: css.row,
      },
      h('span', { style: css.muted }, fmtTime(item && item.ts, locale)),
      h('span', null, t('overview.hits', { n: fmtNum(item && item.hits, locale) })),
      h('span', null, fmtNum(item && item.chars, locale) + ' ' + t('recall.colChars').toLowerCase()),
      h('span', null, fmtNum(item && item.elapsed_ms, locale) + ' ms'),
      h('span', { style: item && item.injected ? css.ok : css.tertiary },
        item && item.injected ? t('overview.injectedBadge') : t('overview.notInjectedBadge'))))

      return h('div', { style: css.stack },
        offline ? h(Card, null,
          h('div', { style: css.cardTitle }, t('overview.offlineTitle')),
          h('div', { style: css.note }, t('overview.offlineDesc')),
          h('div', { style: css.error }, errText(t, statsErr)),
          h('button', { style: css.button, onClick: () => setReloadKey((k) => k + 1) }, t('common.retry'))) : null,
        h('div', { style: css.kpiGrid },
          h(Kpi, { label: t('overview.kpiNodes'), value: fmtNum(nodesTotal, locale) }),
          h(Kpi, { label: t('overview.kpiActive'), value: fmtNum(nodesActive, locale) }),
          h(Kpi, {
            label: t('overview.kpiRecalls'),
            value: fmtNum(recallKpi, locale),
            sub: injected !== null ? t('overview.injected', { n: fmtNum(injected, locale) }) : '—',
          }),
          h(Kpi, { label: t('overview.kpiEdges'), value: fmtNum(edges, locale) })),
        h(Card, null,
          h(SectionTitle, null, t('overview.health')),
          h('div', { style: css.healthRow },
            h(HealthPill, { label: t('health.db'), value: offline ? t('health.offline') : stats ? t('health.ok') : '—', tone: dbTone }),
            h(HealthPill, { label: t('health.migration'), value: schemaVersion !== null ? 'v' + String(schemaVersion) : '—', tone: schemaVersion !== null ? 'ok' : 'muted' }),
            h(HealthPill, { label: t('health.pending'), value: pending !== null ? fmtNum(pending, locale) : '—', tone: pending !== null ? 'warn' : 'muted' }),
            h(HealthPill, { label: t('health.job'), value: jobText, tone: jobText === '—' ? 'muted' : 'warn' })),
          h('div', { style: css.tertiary }, t('overview.refreshed', { time: fmtTime(Date.now(), locale) }))),
        h(Card, null,
          h(SectionTitle, null, t('overview.recent')),
          recent.status === 'loading' ? h('div', { style: css.muted }, t('state.loading'))
            : recent.status === 'error' ? h('div', { style: css.error }, errText(t, recent.err))
              : recent.items.length === 0 ? h('div', { style: css.tertiary }, t('overview.recentEmpty'))
                : h('div', { style: css.stack }, recentRows)),
        recalls.status === 'error' ? h('div', { style: css.tertiary }, t('overview.kpiRecalls') + ': ' + errText(t, recalls.err)) : null)
    }

    // ----------------------------------------------------------------- memory

    function MemoryTab(props) {
      const { t, locale, version, onImport } = props
      const [query, setQuery] = useState('')
      const [search, setSearch] = useState({ status: 'idle', items: [], count: 0, below: 0 })
      const [page, setPage] = useState(0)
      const [nodes, setNodes] = useState({ status: 'loading', items: [], total: 0 })
      const [detailId, setDetailId] = useState(null)
      const [reload, setReload] = useState(0)
      const [notice, setNotice] = useState(null)
      const [writeOpen, setWriteOpen] = useState(false)
      const searchSeq = useRef(0)
      const [searchTick, setSearchTick] = useState(0)

      useEffect(() => {
        let alive = true
        setNodes((prev) => ({ ...prev, status: 'loading' }))
        callJson('/nodes?limit=' + PAGE_SIZE + '&offset=' + (page * PAGE_SIZE)).then((body) => {
          if (!alive) return
          setNodes({
            status: 'ok',
            items: Array.isArray(body.items) ? body.items : [],
            total: Number(body.total) || 0,
          })
        }).catch((err) => {
          if (!alive) return
          setNodes({ status: 'error', items: [], total: 0, err })
        })
        return () => { alive = false }
      }, [page, version, reload])

      useEffect(() => {
        const q = query.trim()
        searchSeq.current += 1
        const seq = searchSeq.current
        if (!q) {
          setSearch({ status: 'idle', items: [], count: 0, below: 0 })
          return undefined
        }
        setSearch((prev) => ({ ...prev, status: 'loading' }))
        const timer = setTimeout(async () => {
          try {
            const body = await callJson('/search', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ query: q, limit: PAGE_SIZE }),
            })
            if (searchSeq.current !== seq) return
            setSearch({
              status: 'ok',
              items: Array.isArray(body.hits) ? body.hits : [],
              count: Number(body.count) || 0,
              below: Number(body.below_min_n) || 0,
            })
          } catch (err) {
            if (searchSeq.current !== seq) return
            setSearch({ status: 'error', items: [], err })
          }
        }, 300)
        return () => clearTimeout(timer)
      }, [query, searchTick])

      const searching = query.trim().length > 0
      const rows = searching ? search.items : nodes.items
      const total = nodes.total
      const from = total === 0 ? 0 : page * PAGE_SIZE + 1
      const to = Math.min(total, page * PAGE_SIZE + rows.length)
      const canPrev = page > 0
      const canNext = !searching && (page + 1) * PAGE_SIZE < total

      const onWritten = (id) => {
        setWriteOpen(false)
        setNotice(t('memory.written', { id: String(id) }))
        setReload((v) => v + 1)
      }

      let listBody = null
      if (searching) {
        if (search.status === 'loading') listBody = h(StateBlock, { t, status: 'loading' })
        else if (search.status === 'error') listBody = h(StateBlock, { t, status: 'error', err: search.err, onRetry: () => setSearchTick((v) => v + 1) })
        else if (search.status === 'ok' && search.items.length === 0) listBody = h(StateBlock, { t, status: 'empty', empty: t('memory.noResults') })
        else if (search.status === 'ok') {
          listBody = h('div', null,
            h('div', { style: css.muted }, search.below > 0
              ? t('memory.searchMeta', { count: fmtNum(search.count, locale), below: fmtNum(search.below, locale) })
              : t('memory.searchMetaNoBelow', { count: fmtNum(search.count, locale) })),
            h(MemoryTable, { t, locale, items: search.items, searching: true, onOpen: setDetailId }))
        } else listBody = h(StateBlock, { t, status: 'empty' })
      } else {
        if (nodes.status === 'loading') listBody = h(StateBlock, { t, status: 'loading' })
        else if (nodes.status === 'error') listBody = h(StateBlock, { t, status: 'error', err: nodes.err, onRetry: () => setReload((v) => v + 1) })
        else if (nodes.total === 0) {
          listBody = h('div', { style: css.guide },
            h('div', { style: css.cardTitle }, t('memory.emptyTitle')),
            h('div', { style: css.note }, t('memory.emptyDesc')),
            h('div', { style: css.inline },
              h('button', { style: css.buttonPrimary, onClick: () => setWriteOpen(true) }, t('memory.writeFirst')),
              h('button', { style: css.button, onClick: onImport }, t('memory.importJsonl'))))
        } else if (nodes.items.length === 0) listBody = h(StateBlock, { t, status: 'empty', empty: t('memory.pageEmpty') })
        else listBody = h(MemoryTable, { t, locale, items: nodes.items, searching: false, onOpen: setDetailId })
      }

      return h('div', { style: css.stack },
        h(Card, null,
          h('div', { style: css.inline },
            h('input', {
              style: css.input, value: query,
              placeholder: t('memory.searchPlaceholder'),
              onChange: (e) => setQuery(e.target.value),
            }),
            searching ? h('button', { style: css.button, onClick: () => setQuery('') }, t('common.close')) : null,
            !searching ? h('button', { style: css.buttonPrimary, onClick: () => setWriteOpen((v) => !v) }, t('memory.newTitle')) : null),
          notice ? h('div', { style: css.ok }, notice) : null,
          listBody,
          !searching && nodes.status === 'ok' && nodes.total > 0
            ? h('div', { style: css.pagination },
              h('button', { style: canPrev ? css.button : css.buttonDisabled, disabled: !canPrev, onClick: () => setPage((p) => Math.max(0, p - 1)) }, t('common.prev')),
              h('span', null, t('common.pageInfo', {
                from: fmtNum(from, locale), to: fmtNum(to, locale), total: fmtNum(total, locale),
              })),
              h('button', { style: canNext ? css.button : css.buttonDisabled, disabled: !canNext, onClick: () => setPage((p) => p + 1) }, t('common.next')))
            : null),
        writeOpen ? h(WriteForm, { t, locale, onDone: onWritten, onCancel: () => setWriteOpen(false) }) : null,
        detailId ? h(DetailDrawer, {
          t, locale, id: detailId,
          onClose: () => setDetailId(null),
          onChanged: () => setReload((v) => v + 1),
        }) : null)
    }

    function MemoryTable(props) {
      const { t, locale, items, searching, onOpen } = props
      return h('table', { style: css.table },
        h('thead', null, h('tr', null,
          h('th', { style: css.th }, t('memory.colText')),
          h('th', { style: css.th }, t('memory.colLevel')),
          h('th', { style: css.th }, t('memory.colType')),
          h('th', { style: css.th }, t('memory.colStatus')),
          h('th', { style: css.th }, t('memory.colScore')))),
        h('tbody', null, items.map((item, index) => h('tr', {
          key: (item && item.id) || index,
          style: css.clickRow,
          onClick: () => onOpen(item && item.id),
        },
        h('td', { style: css.td },
          h('div', { style: css.cellText }, String((item && item.text) || '').slice(0, 160)),
          item && item.source ? h('div', { style: css.tertiary }, sourceLabel(t, item.source)) : null),
        h('td', { style: css.td }, levelLabel(t, item && item.level)),
        h('td', { style: css.td }, typeLabel(t, item && (item.type || item.memory_type))),
        h('td', { style: css.td }, item && item.status ? statusLabel(t, item.status) : '—'),
        h('td', { style: css.td }, searching ? fmtScore(item && item.score, locale) : '—')))))
    }

    function WriteForm(props) {
      const { t, locale, onDone, onCancel } = props
      const [text, setText] = useState('')
      const [level, setLevel] = useState('normal')
      const [type, setType] = useState('semantic')
      const [tags, setTags] = useState('')
      const [state, setState] = useState({ status: 'idle', code: '' })

      const submit = async () => {
        const body = text.trim()
        if (!body || body.length > 500) {
          setState({ status: 'error', code: 'invalid_text' })
          return
        }
        setState({ status: 'saving' })
        try {
          const result = await callJson('/write', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              text: body, level, memory_type: type,
              tags: tags.split(',').map((s) => s.trim()).filter(Boolean),
            }),
          })
          onDone(result.id)
        } catch (err) {
          setState({ status: 'error', code: (err && err.code) || 'unknown_error' })
        }
      }

      return h(Card, null,
        h(SectionTitle, null, t('memory.newTitle')),
        h('textarea', {
          style: css.textarea, value: text, maxLength: 500,
          placeholder: t('memory.writePlaceholder'),
          onChange: (e) => setText(e.target.value),
        }),
        h('div', { style: css.tertiary }, t('common.charCount', { n: fmtNum(text.length, locale), max: fmtNum(500, locale) })),
        h('div', { style: css.inline },
          h(SelectField, {
            label: t('memory.writeLevel'), value: level,
            options: [['core', levelLabel(t, 'core')], ['important', levelLabel(t, 'important')], ['normal', levelLabel(t, 'normal')]],
            onChange: setLevel,
          }),
          h(SelectField, {
            label: t('memory.writeType'), value: type,
            options: [['semantic', typeLabel(t, 'semantic')], ['procedural', typeLabel(t, 'procedural')], ['episodic', typeLabel(t, 'episodic')], ['mixed', typeLabel(t, 'mixed')]],
            onChange: setType,
          }),
          h(TextField, { label: t('memory.writeTags'), value: tags, placeholder: t('detail.tagsPlaceholder'), onChange: setTags })),
        state.status === 'error' ? h('div', { style: css.error }, errText(t, { code: state.code })) : null,
        h('div', { style: css.inline },
          h('button', {
            style: state.status === 'saving' ? css.buttonDisabled : css.buttonPrimary,
            disabled: state.status === 'saving', onClick: submit,
          }, state.status === 'saving' ? t('common.saving') : t('memory.writeSubmit')),
          h('button', { style: css.button, onClick: onCancel }, t('common.cancel'))))
    }

    function DetailDrawer(props) {
      const { t, locale, id, onClose, onChanged } = props
      const [loaded, setLoaded] = useState({ status: 'loading' })
      const [text, setText] = useState('')
      const [level, setLevel] = useState('normal')
      const [status, setStatus] = useState('active')
      const [tags, setTags] = useState('')
      const [save, setSave] = useState({ status: 'idle', code: '' })

      useEffect(() => {
        let alive = true
        setLoaded({ status: 'loading' })
        setSave({ status: 'idle', code: '' })
        callJson('/nodes/' + encodeURIComponent(id)).then((body) => {
          if (!alive) return
          const node = (body && body.node) || body || {}
          setLoaded({ status: 'ok', node })
          setText(String(node.text || ''))
          setLevel(node.level || 'normal')
          setStatus(node.status || 'active')
          setTags(parseTags(node.tags).join(', '))
        }).catch((err) => {
          if (alive) setLoaded({ status: 'error', err })
        })
        return () => { alive = false }
      }, [id])

      const sendPatch = async (patch) => {
        setSave({ status: 'saving', code: '' })
        try {
          await callJson('/nodes/' + encodeURIComponent(id), {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ patch }),
          })
          setSave({ status: 'ok', code: '' })
          if (patch.status) setStatus(patch.status)
          onChanged()
        } catch (err) {
          setSave({ status: 'error', code: (err && err.code) || 'unknown_error' })
        }
      }

      const saveEdit = () => {
        const body = text.trim()
        if (!body || body.length > 500) {
          setSave({ status: 'error', code: 'invalid_text' })
          return
        }
        sendPatch({ text: body, level, status, tags: tags.split(',').map((s) => s.trim()).filter(Boolean) })
      }

      let body = null
      if (loaded.status === 'loading') body = h(StateBlock, { t, status: 'loading' })
      else if (loaded.status === 'error') body = h(StateBlock, { t, status: 'error', err: loaded.err })
      else {
        const node = loaded.node || {}
        body = h('div', { style: css.stack },
          h('label', { style: css.field },
            h('span', { style: css.fieldLabel }, t('detail.text')),
            h('textarea', {
              style: css.textarea, value: text, maxLength: 500,
              onChange: (e) => setText(e.target.value),
            })),
          h('div', { style: css.tertiary }, t('common.charCount', { n: fmtNum(text.length, locale), max: fmtNum(500, locale) })),
          h('div', { style: css.inline },
            h(SelectField, {
              label: t('detail.level'), value: level,
              options: [['core', levelLabel(t, 'core')], ['important', levelLabel(t, 'important')], ['normal', levelLabel(t, 'normal')]],
              onChange: setLevel,
            }),
            h(SelectField, {
              label: t('detail.status'), value: status,
              options: [['active', statusLabel(t, 'active')], ['archived', statusLabel(t, 'archived')], ['stale', statusLabel(t, 'stale')], ['superseded', statusLabel(t, 'superseded')]],
              onChange: setStatus,
            })),
          h(TextField, { label: t('detail.tags'), value: tags, placeholder: t('detail.tagsPlaceholder'), onChange: setTags }),
          h('div', { style: css.metaGrid },
            h(Row, { k: t('detail.source'), v: sourceLabel(t, node.source) }),
            h(Row, { k: t('detail.type'), v: typeLabel(t, node.memory_type) }),
            h(Row, { k: t('detail.created'), v: fmtTime(node.created_at, locale) }),
            h(Row, { k: t('detail.updated'), v: fmtTime(node.updated_at, locale) })),
          h(SectionTitle, null, t('detail.bitemporal')),
          h('div', { style: css.metaGrid },
            h(Row, { k: t('detail.validAt'), v: fmtTime(node.valid_at, locale) }),
            h(Row, { k: t('detail.invalidAt'), v: fmtTime(node.invalid_at, locale) }),
            h(Row, { k: t('detail.expiredAt'), v: fmtTime(node.expired_at, locale) }),
            h(Row, { k: t('detail.supersededBy'), v: pick(node.superseded_by) || '—' })),
          save.status === 'error' ? h('div', { style: css.error }, errText(t, { code: save.code })) : null,
          save.status === 'ok' ? h('div', { style: css.ok }, t('detail.saved')) : null,
          h('div', { style: css.inline },
            h('button', {
              style: save.status === 'saving' ? css.buttonDisabled : css.buttonPrimary,
              disabled: save.status === 'saving', onClick: saveEdit,
            }, save.status === 'saving' ? t('common.saving') : t('detail.saveEdit')),
            h('button', {
              style: status === 'archived' ? css.buttonDisabled : css.buttonWarn,
              disabled: status === 'archived' || save.status === 'saving',
              onClick: () => sendPatch({ status: 'archived' }),
            }, status === 'archived' ? t('detail.archived') : t('detail.archive')),
            h('button', { style: css.button, onClick: onClose }, t('common.close'))))
      }

      return h('div', { style: css.drawerMask, onClick: onClose },
        h('aside', { style: css.drawer, onClick: (e) => e.stopPropagation() },
          h('div', { style: css.inline },
            h('div', { style: { flex: 1, fontSize: '14px', fontWeight: 600 } }, t('detail.title')),
            h('button', { style: css.button, onClick: onClose }, t('common.close'))),
          h('div', { style: css.tertiary }, String(id)),
          body))
    }

    function Row(props) {
      return h('div', { style: css.row },
        h('span', { style: css.muted }, props.k),
        h('span', { style: css.rowValue }, String(props.v)))
    }

    // ----------------------------------------------------------------- recall

    function RecallTab(props) {
      const { t, locale } = props
      const [recent, setRecent] = useState({ status: 'loading', items: [] })
      const [reload, setReload] = useState(0)
      const [query, setQuery] = useState('')
      const [test, setTest] = useState({ status: 'idle', items: [], count: 0, ms: 0 })

      useEffect(() => {
        let alive = true
        setRecent((prev) => ({ ...prev, status: 'loading' }))
        callJson('/recalls?limit=20').then((body) => {
          if (!alive) return
          setRecent({ status: 'ok', items: Array.isArray(body.items) ? body.items : [] })
        }).catch((err) => {
          if (alive) setRecent({ status: 'error', items: [], err })
        })
        return () => { alive = false }
      }, [reload])

      const runTest = async () => {
        const q = query.trim()
        if (!q) return
        setTest({ status: 'loading', items: [], count: 0, ms: 0 })
        const started = Date.now()
        try {
          const body = await callJson('/search', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ query: q, limit: 10 }),
          })
          setTest({
            status: 'ok',
            items: Array.isArray(body.hits) ? body.hits : [],
            count: Number(body.count) || 0,
            ms: Number(body.elapsed_ms) || (Date.now() - started),
          })
        } catch (err) {
          setTest({ status: 'error', items: [], err })
        }
      }

      let recentBody = null
      if (recent.status === 'loading') recentBody = h(StateBlock, { t, status: 'loading' })
      else if (recent.status === 'error') recentBody = h(StateBlock, { t, status: 'error', err: recent.err, onRetry: () => setReload((v) => v + 1) })
      else if (recent.items.length === 0) recentBody = h(StateBlock, { t, status: 'empty', empty: t('recall.recentEmpty') })
      else {
        recentBody = h('div', { style: { overflowX: 'auto' } },
          h('table', { style: css.table },
            h('thead', null, h('tr', null,
              h('th', { style: css.th }, t('recall.colTime')),
              h('th', { style: css.th }, t('recall.colQuery')),
              h('th', { style: css.th }, t('recall.colHits')),
              h('th', { style: css.th }, t('recall.colChars')),
              h('th', { style: css.th }, t('recall.colElapsed')),
              h('th', { style: css.th }, t('recall.colInjected')),
              h('th', { style: css.th }, t('recall.colUsed')))),
            h('tbody', null, recent.items.map((item, index) => h('tr', { key: (item && item.id) || index },
              h('td', { style: css.td }, fmtTime(item && item.ts, locale)),
              h('td', { style: css.td }, String((item && item.query) || '').slice(0, 80)),
              h('td', { style: css.td }, fmtNum(item && item.hits, locale)),
              h('td', { style: css.td }, fmtNum(item && item.chars, locale)),
              h('td', { style: css.td }, fmtNum(item && item.elapsed_ms, locale) + ' ms'),
              h('td', { style: css.td }, item && item.injected ? t('recall.injectedYes') : t('recall.injectedNo')),
              h('td', { style: css.td }, item && item.used ? t('recall.usedYes') : t('recall.usedNo')))))))
      }

      let testBody = null
      if (test.status === 'loading') testBody = h(StateBlock, { t, status: 'loading' })
      else if (test.status === 'error') testBody = h(StateBlock, { t, status: 'error', err: test.err, onRetry: runTest })
      else if (test.status === 'ok') {
        testBody = h('div', null,
          h('div', { style: css.muted }, t('recall.testMeta', { count: fmtNum(test.count, locale), ms: fmtNum(test.ms, locale) })),
          test.items.length === 0
            ? h(StateBlock, { t, status: 'empty', empty: t('recall.testEmpty') })
            : h('div', { style: css.stack }, test.items.map((item, index) => h('div', {
              key: (item && item.id) || index, style: css.resultItem,
            },
            h('div', { style: css.cellText }, String((item && item.text) || '')),
            h('div', { style: css.tertiary },
              (item && item.level ? levelLabel(t, item.level) : '—') + ' · '
              + (item && item.type ? typeLabel(t, item.type) : '—') + ' · '
              + (item && item.source ? sourceLabel(t, item.source) : '—') + ' · '
              + 'score ' + fmtScore(item && item.score, locale) + ' · '
              + 'rel ' + fmtScore(item && item.rel, locale))))))
      }

      return h('div', { style: css.stack },
        h(Card, null,
          h(SectionTitle, null, t('recall.recent')),
          h('div', { style: css.inline },
            h('button', { style: css.button, onClick: () => setReload((v) => v + 1) }, t('common.refresh'))),
          recentBody),
        h(Card, null,
          h(SectionTitle, null, t('recall.testTitle')),
          h(Note, null, t('recall.testNote')),
          h('div', { style: css.inline },
            h('input', {
              style: css.input, value: query, placeholder: t('recall.testPlaceholder'),
              onChange: (e) => setQuery(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') runTest() },
            }),
            h('button', { style: test.status === 'loading' ? css.buttonDisabled : css.buttonPrimary, disabled: test.status === 'loading', onClick: runTest }, t('recall.runTest'))),
          testBody))
    }

    // ----------------------------------------------------------------- writes

    function WritesTab(props) {
      const { t, locale, version } = props
      const [writes, setWrites] = useState({ status: 'loading', items: [] })
      const [stats, setStats] = useState(null)

      useEffect(() => {
        let alive = true
        setWrites((prev) => ({ ...prev, status: 'loading' }))
        callJson('/writes?limit=20').then((body) => {
          if (alive) setWrites({ status: 'ok', items: Array.isArray(body.items) ? body.items : [] })
        }).catch((err) => {
          if (alive) setWrites({ status: 'error', items: [], err })
        })
        callJson('/stats').then((body) => {
          if (alive) setStats((body && body.stats) || body)
        }).catch(() => { if (alive) setStats(null) })
        return () => { alive = false }
      }, [version])

      const totals = (stats && stats.totals) || stats || {}
      const edges = pick(totals.edges, stats && stats.edges)

      let body = null
      if (writes.status === 'loading') body = h(StateBlock, { t, status: 'loading' })
      else if (writes.status === 'error') body = h(StateBlock, { t, status: 'error', err: writes.err })
      else if (writes.items.length === 0) body = h(StateBlock, { t, status: 'empty', empty: t('writes.empty') })
      else {
        body = h('div', { style: { overflowX: 'auto' } },
          h('table', { style: css.table },
            h('thead', null, h('tr', null,
              h('th', { style: css.th }, t('writes.colTime')),
              h('th', { style: css.th }, t('writes.colAction')),
              h('th', { style: css.th }, t('writes.colNode')),
              h('th', { style: css.th }, t('writes.colReason')))),
            h('tbody', null, writes.items.map((item, index) => h('tr', { key: (item && item.id) || index },
              h('td', { style: css.td }, fmtTime(item && item.ts, locale)),
              h('td', { style: css.td }, String((item && item.action) || '—')),
              h('td', { style: css.td }, String((item && item.node_id) || '—').slice(0, 32)),
              h('td', { style: css.td }, String((item && item.reason) || '—').slice(0, 120)))))))
      }

      return h('div', { style: css.stack },
        h('div', { style: css.kpiGrid },
          h(Kpi, { label: t('writes.edges'), value: stats ? fmtNum(edges, locale) : '—' }),
          h(Kpi, { label: t('writes.recentCount'), value: fmtNum(writes.status === 'ok' ? writes.items.length : null, locale) })),
        h(Card, null,
          h(SectionTitle, null, t('writes.recent')),
          h(Note, null, t('writes.note')),
          body))
    }

    // --------------------------------------------------------------- settings

    function normalizeConfig(config) {
      const cfg = config || {}
      const backend = cfg.backend || {}
      const recall = cfg.recall || {}
      const write = cfg.write || {}
      const panel = cfg.panel || {}
      const advanced = cfg.advanced || {}
      const n = (value, fallback) => {
        const x = Number(value)
        return Number.isFinite(x) ? x : fallback
      }
      return {
        backend: {
          mode: backend.mode || 'local',
          url: backend.url || '',
          timeoutMs: n(backend.timeoutMs, 3000),
        },
        recall: {
          enabled: recall.enabled !== false,
          maxHits: n(recall.maxHits, 5),
          charBudget: n(recall.charBudget, 1500),
          minRel: n(recall.minRel, 0.34),
          timeoutMs: n(recall.timeoutMs, 2000),
        },
        write: {
          enabled: write.enabled !== false,
          reviewMode: write.reviewMode || 'shadow',
          maxChars: n(write.maxChars, 500),
        },
        panel: {
          pollMs: n(panel.pollMs, 60000),
          allowRemote: panel.allowRemote === true,
        },
        advanced: {
          logLevel: advanced.logLevel || 'warn',
          worker: advanced.worker !== false,
        },
      }
    }

    function configIssue(draft) {
      const checks = [
        [draft.backend.timeoutMs, 200, 30000],
        [draft.recall.maxHits, 0, 20],
        [draft.recall.charBudget, 0, 8000],
        [draft.recall.minRel, 0, 1],
        [draft.recall.timeoutMs, 100, 10000],
        [draft.write.maxChars, 20, 500],
        [draft.panel.pollMs, 5000, 600000],
      ]
      return checks.some(([value, min, max]) => {
        const x = Number(value)
        return !Number.isFinite(x) || x < min || x > max
      })
    }

    function SettingsTab(props) {
      const { t, locale, onSaved } = props
      const [load, setLoad] = useState({ status: 'loading' })
      const [draft, setDraft] = useState(null)
      const [save, setSave] = useState({ status: 'idle', code: '', at: 0 })

      const reload = () => {
        setLoad({ status: 'loading' })
        callJson('/config').then((body) => {
          const next = normalizeConfig(body && body.config)
          setDraft(next)
          setLoad({ status: 'ok' })
        }).catch((err) => setLoad({ status: 'error', err }))
      }

      useEffect(() => { reload() }, [])

      const patch = (group, key, value) => {
        setDraft((prev) => (prev ? { ...prev, [group]: { ...prev[group], [key]: value } } : prev))
        setSave((prev) => (prev.status === 'ok' || prev.status === 'error' ? { status: 'idle', code: '', at: 0 } : prev))
      }

      const submit = async () => {
        if (!draft) return
        if (configIssue(draft)) {
          setSave({ status: 'error', code: 'invalid_value', at: 0 })
          return
        }
        setSave({ status: 'saving', code: '', at: 0 })
        try {
          await callJson('/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ config: draft }),
          })
          setSave({ status: 'ok', code: '', at: Date.now() })
          if (onSaved) onSaved(draft)
        } catch (err) {
          setSave({ status: 'error', code: (err && err.code) || 'unknown_error', at: 0 })
        }
      }

      if (load.status === 'loading') return h(Card, null, h(StateBlock, { t, status: 'loading' }))
      if (load.status === 'error') {
        return h(Card, null,
          h(StateBlock, { t, status: 'error', err: load.err, onRetry: reload }))
      }
      if (!draft) return h(Card, null, h(StateBlock, { t, status: 'empty' }))

      const modeOptions = [['local', 'local'], ['http', 'http'], ['hybrid', 'hybrid']]
      const reviewOptions = [['shadow', 'shadow'], ['auto', 'auto']]
      const logOptions = [['error', 'error'], ['warn', 'warn'], ['info', 'info'], ['debug', 'debug']]

      return h('div', { style: css.stack },
        h(Note, null, t('settings.defaultsNote')),
        h('div', { style: css.groupGrid },
          h(Card, null,
            h(SectionTitle, null, t('settings.groupBackend')),
            h(SelectField, { label: t('settings.backendMode'), value: draft.backend.mode, options: modeOptions, onChange: (v) => patch('backend', 'mode', v) }),
            h(TextField, { label: t('settings.backendUrl'), value: draft.backend.url, placeholder: 'http://127.0.0.1:8080', onChange: (v) => patch('backend', 'url', v) }),
            h(NumField, { label: t('settings.backendTimeout'), value: draft.backend.timeoutMs, min: 200, max: 30000, onChange: (v) => patch('backend', 'timeoutMs', v) })),
          h(Card, null,
            h(SectionTitle, null, t('settings.groupRecall')),
            h(Switch, { label: t('settings.recallEnabled'), checked: draft.recall.enabled, onChange: (v) => patch('recall', 'enabled', v) }),
            h(NumField, { label: t('settings.maxHits'), value: draft.recall.maxHits, min: 0, max: 20, onChange: (v) => patch('recall', 'maxHits', v) }),
            h(NumField, { label: t('settings.charBudget'), value: draft.recall.charBudget, min: 0, max: 8000, onChange: (v) => patch('recall', 'charBudget', v) }),
            h(NumField, { label: t('settings.minRel'), value: draft.recall.minRel, min: 0, max: 1, step: 0.01, onChange: (v) => patch('recall', 'minRel', v) }),
            h(NumField, { label: t('settings.recallTimeout'), value: draft.recall.timeoutMs, min: 100, max: 10000, onChange: (v) => patch('recall', 'timeoutMs', v) })),
          h(Card, null,
            h(SectionTitle, null, t('settings.groupWrite')),
            h(Switch, { label: t('settings.writeEnabled'), checked: draft.write.enabled, onChange: (v) => patch('write', 'enabled', v) }),
            h(SelectField, { label: t('settings.reviewMode'), value: draft.write.reviewMode, options: reviewOptions, onChange: (v) => patch('write', 'reviewMode', v) }),
            h(NumField, { label: t('settings.maxChars'), value: draft.write.maxChars, min: 20, max: 500, onChange: (v) => patch('write', 'maxChars', v) })),
          h(Card, null,
            h(SectionTitle, null, t('settings.groupPanel')),
            h(NumField, { label: t('settings.pollMs'), value: draft.panel.pollMs, min: 5000, max: 600000, step: 1000, onChange: (v) => patch('panel', 'pollMs', v) }),
            h(Switch, { label: t('settings.allowRemote'), checked: draft.panel.allowRemote, onChange: (v) => patch('panel', 'allowRemote', v) }),
            draft.panel.allowRemote ? h('div', { style: css.warn }, t('settings.allowRemoteWarn')) : null),
          h(Card, null,
            h(SectionTitle, null, t('settings.groupAdvanced')),
            h(SelectField, { label: t('settings.logLevel'), value: draft.advanced.logLevel, options: logOptions, onChange: (v) => patch('advanced', 'logLevel', v) }),
            h(Switch, { label: t('settings.worker'), checked: draft.advanced.worker, onChange: (v) => patch('advanced', 'worker', v) }),
            h(Note, null, t('settings.restartNote')))),
        save.status === 'error'
          ? h('div', { style: css.errorBox },
            h('div', { style: css.error }, t('settings.saveFailed') + ' — ' + errText(t, { code: save.code })),
            save.code === 'config_save_unavailable' || save.code === 'config_save_failed'
              ? h('div', { style: css.note }, t('settings.readonlyUnavailable')) : null)
          : null,
        save.status === 'ok'
          ? h('div', { style: css.ok }, t('settings.saved', { time: fmtTime(save.at, locale) })) : null,
        h('div', { style: css.inline },
          h('button', {
            style: save.status === 'saving' ? css.buttonDisabled : css.buttonPrimary,
            disabled: save.status === 'saving', onClick: submit,
          }, save.status === 'saving' ? t('common.saving') : t('settings.save')),
          h('button', { style: css.button, onClick: reload }, t('common.refresh'))))
    }

    // ------------------------------------------------------------------- css

    const css = {
      panel: {
        position: 'relative', padding: '16px', minHeight: '100%', boxSizing: 'border-box',
        background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)',
        display: 'flex', flexDirection: 'column', gap: '12px',
      },
      header: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' },
      headerText: { display: 'flex', flexDirection: 'column', gap: '2px' },
      title: { fontSize: '16px', fontWeight: 600 },
      desc: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px' },
      actions: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      tabs: {
        display: 'flex', gap: '4px', flexWrap: 'wrap',
        borderBottom: '1px solid var(--dsw-alias-border-l1)', paddingBottom: '8px',
      },
      tab: {
        background: 'transparent', border: 'none', color: 'var(--dsw-alias-label-secondary)',
        padding: '4px 8px', cursor: 'pointer', fontFamily: 'inherit', fontSize: '13px',
      },
      tabActive: {
        background: 'var(--dsw-alias-bg-layer-2)', border: 'none',
        color: 'var(--dsw-alias-label-primary)', borderRadius: '6px', padding: '4px 8px',
        cursor: 'pointer', fontFamily: 'inherit', fontSize: '13px',
      },
      main: { display: 'flex', flexDirection: 'column', gap: '12px' },
      stack: { display: 'flex', flexDirection: 'column', gap: '10px' },
      card: {
        background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '10px', padding: '12px', display: 'flex', flexDirection: 'column', gap: '8px',
      },
      cardTitle: { fontSize: '13px', fontWeight: 600 },
      kpiGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '8px' },
      kpi: {
        background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '10px', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '4px',
      },
      kpiLabel: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
      kpiValue: { fontSize: '22px', fontWeight: 650, lineHeight: 1.15 },
      kpiSub: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' },
      healthRow: { display: 'flex', gap: '6px', flexWrap: 'wrap' },
      pill: {
        display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px',
        padding: '3px 8px', borderRadius: '999px', background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)',
      },
      pillLabel: { color: 'var(--dsw-alias-label-secondary)' },
      pillValue: { fontWeight: 600 },
      dot: { width: '7px', height: '7px', borderRadius: '50%' },
      row: {
        display: 'flex', justifyContent: 'space-between', gap: '12px',
        fontSize: '13px', padding: '4px 0', borderTop: '1px solid var(--dsw-alias-border-l1)',
      },
      rowValue: { textAlign: 'right', wordBreak: 'break-all' },
      inline: { display: 'flex', gap: '8px', alignItems: 'flex-end', flexWrap: 'wrap' },
      input: {
        flex: '1 1 220px', minWidth: '160px', background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)', border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '6px', padding: '6px 8px', fontSize: '13px', fontFamily: 'inherit',
      },
      textarea: {
        width: '100%', minHeight: '96px', resize: 'vertical', background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)', border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '6px', padding: '8px', fontSize: '13px', fontFamily: 'inherit', boxSizing: 'border-box',
      },
      select: {
        background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)',
        border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '6px', padding: '5px 8px',
        fontSize: '13px', fontFamily: 'inherit',
      },
      button: {
        fontSize: '12px', padding: '6px 10px', borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)', cursor: 'pointer', fontFamily: 'inherit',
      },
      buttonPrimary: {
        fontSize: '12px', padding: '6px 10px', borderRadius: '6px',
        border: '1px solid var(--dsw-alias-button-primary-fill)',
        background: 'var(--dsw-alias-button-primary-fill)',
        color: 'var(--dsw-alias-label-on-color)', cursor: 'pointer', fontFamily: 'inherit',
      },
      buttonWarn: {
        fontSize: '12px', padding: '6px 10px', borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-l1)', background: 'transparent',
        color: 'var(--dsw-alias-state-warn-primary)', cursor: 'pointer', fontFamily: 'inherit',
      },
      buttonDisabled: {
        fontSize: '12px', padding: '6px 10px', borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-tertiary)', cursor: 'not-allowed', fontFamily: 'inherit', opacity: 0.6,
      },
      linkButton: {
        fontSize: '12px', padding: '6px 10px', borderRadius: '6px', textDecoration: 'none',
        border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)', display: 'inline-block',
      },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: '12px' },
      th: {
        textAlign: 'left', fontWeight: 600, color: 'var(--dsw-alias-label-secondary)',
        padding: '6px 8px', borderBottom: '1px solid var(--dsw-alias-border-l1)', whiteSpace: 'nowrap',
      },
      td: {
        padding: '6px 8px', borderBottom: '1px solid var(--dsw-alias-border-l1)',
        verticalAlign: 'top', color: 'var(--dsw-alias-label-primary)',
      },
      cellText: { lineHeight: 1.5, wordBreak: 'break-word' },
      clickRow: { cursor: 'pointer' },
      resultItem: {
        borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: '6px',
        display: 'flex', flexDirection: 'column', gap: '4px',
      },
      muted: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px' },
      tertiary: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px' },
      warn: { color: 'var(--dsw-alias-state-warn-primary)', fontSize: '12px' },
      error: { color: 'var(--dsw-alias-state-error-primary)', fontSize: '12px' },
      ok: { color: 'var(--dsw-alias-state-success-primary)', fontSize: '12px' },
      errorBox: {
        display: 'flex', flexDirection: 'column', gap: '6px', alignItems: 'flex-start',
        border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '8px', padding: '8px 10px',
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      note: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', lineHeight: 1.5 },
      guide: { display: 'flex', flexDirection: 'column', gap: '8px', alignItems: 'flex-start', padding: '8px 0' },
      pagination: {
        display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px',
        color: 'var(--dsw-alias-label-secondary)', flexWrap: 'wrap',
      },
      drawerMask: {
        position: 'fixed', inset: 0, background: 'var(--dsw-alias-bg-mask-1)',
        display: 'flex', justifyContent: 'flex-end', zIndex: 60,
      },
      drawer: {
        width: 'min(440px, 92vw)', height: '100%', overflowY: 'auto',
        background: 'var(--dsw-alias-bg-layer-2)', borderLeft: '1px solid var(--dsw-alias-border-l1)',
        padding: '16px', display: 'flex', flexDirection: 'column', gap: '10px', boxSizing: 'border-box',
      },
      field: { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: '140px' },
      fieldLabel: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
      metaGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0 12px' },
      groupGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '10px' },
      switchRow: {
        display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px',
        color: 'var(--dsw-alias-label-primary)',
      },
      switchLabel: { flex: 1 },
      checkbox: { accentColor: 'var(--dsw-alias-brand-primary)' },
      progress: {
        height: '6px', borderRadius: '999px', background: 'var(--dsw-alias-bg-layer-3)',
        overflow: 'hidden', width: '100%',
      },
      progressFill: { height: '100%', background: 'var(--dsw-alias-brand-primary)' },
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        localeService = ctx.locale
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, dict), 'whale-memory: locale')
        ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 25,
          locale: NS,
          label: () => t('meta.title'),
        }, PanelIcon)), 'whale-memory: sidebar')
        ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
        }, Panel)), 'whale-memory: panel')
      },
    }
  },
})
