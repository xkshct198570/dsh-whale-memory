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
    /** 试用样例标记：清理时按 id 归档，tag 只作人肉识别（不参与机器逻辑）。 */
    const SAMPLE_TAG = 'whale-memory-sample'

    const TABS = [
      ['overview', 'tab.overview'],
      ['memory', 'tab.memory'],
      ['recall', 'tab.recall'],
      ['writes', 'tab.writes'],
      ['settings', 'tab.settings'],
    ]

    // >>> locale:generated（由 scripts/i18n-check.mjs --write 生成，勿手改）
    const dict = {
      "zh": {
        "meta.title": "鲸忆记忆中枢",
        "meta.description": "本地长期记忆：节点、召回与写入审计；默认本地 SQLite，可选外部服务。",
        "meta.detail": "docs/DETAIL.md",
        "tab.overview": "概览",
        "tab.memory": "记忆库",
        "tab.recall": "召回",
        "tab.writes": "写入与关系",
        "tab.settings": "设置",
        "common.dash": "—",
        "common.retry": "重试",
        "common.refresh": "刷新",
        "common.loading": "读取中…",
        "common.empty": "暂无数据",
        "common.close": "关闭",
        "common.save": "保存",
        "common.saving": "保存中…",
        "common.cancel": "取消",
        "common.search": "搜索",
        "common.prev": "上一页",
        "common.next": "下一页",
        "common.pageInfo": "第 {from}–{to} 条 / 共 {total} 条",
        "common.total": "共 {total} 条",
        "common.now": "刚刚",
        "common.yes": "是",
        "common.no": "否",
        "common.charCount": "{n} / {max} 字",
        "state.loading": "读取中…",
        "state.error": "加载失败",
        "state.empty": "暂无数据",
        "health.db": "DB",
        "health.migration": "迁移",
        "health.pending": "pending",
        "health.job": "job",
        "health.ok": "正常",
        "health.offline": "离线",
        "health.running": "运行中",
        "health.idle": "空闲",
        "overview.title": "概览",
        "overview.offlineTitle": "后端未连接",
        "overview.offlineDesc": "记忆服务当前不可达。确认 DSH 已启动；恢复后可重试。",
        "overview.recent": "最近 3 条召回",
        "overview.recentEmpty": "暂无召回记录",
        "overview.health": "健康状态",
        "overview.kpiNodes": "节点总数",
        "overview.kpiActive": "活跃节点",
        "overview.kpiRecalls": "今日召回",
        "overview.kpiEdges": "关系边",
        "overview.injected": "注入 {n} 字",
        "overview.injectedNone": "未注入",
        "overview.refreshed": "更新于 {time}",
        "overview.hits": "命中 {n}",
        "overview.injectedBadge": "已注入",
        "overview.notInjectedBadge": "未注入",
        "overview.kpiZeroInjection": "零注入率",
        "overview.kpiAdoption": "采纳率",
        "overview.kpiJobSuccess": "作业成功率（7 日）",
        "overview.kpiDbSize": "库大小",
        "overview.targetMet": "达标 · 目标 {target}",
        "overview.targetMissed": "未达标 · 目标 {target}",
        "overview.trend": "7 日曲线",
        "overview.trendEmpty": "暂无 7 日数据",
        "overview.trendInjected": "注入率",
        "overview.trendZeroHit": "零命中占比",
        "overview.trendToday": "今天",
        "overview.trendTip": "{day}：召回 {recalls} · 命中 {withHits} · 注入 {injected} · 采纳 {adopted} · 零命中 {zeroHit}",
        "overview.failures": "最近失败",
        "overview.failuresEmpty": "近 24h 无失败作业",
        "overview.failureAttempts": "尝试 {n}",
        "memory.title": "记忆库",
        "memory.searchPlaceholder": "输入关键词检索（防抖 300ms）…",
        "memory.searching": "检索中…",
        "memory.noResults": "没有命中",
        "memory.emptyTitle": "记忆库还是空的",
        "memory.emptyDesc": "先写第一条记忆，或从 JSONL 文件导入。",
        "memory.writeFirst": "写第一条",
        "memory.importJsonl": "导入 JSONL",
        "memory.newTitle": "新增记忆",
        "memory.writePlaceholder": "输入要记住的内容（≤500 字）…",
        "memory.writeLevel": "层级",
        "memory.writeType": "类型",
        "memory.writeTags": "标签（逗号分隔）",
        "memory.writeSubmit": "写入",
        "memory.written": "已写入：{id}",
        "memory.colText": "正文",
        "memory.colLevel": "层级",
        "memory.colType": "类型",
        "memory.colStatus": "状态",
        "memory.colScore": "分数",
        "memory.colSource": "来源",
        "memory.pageEmpty": "本页没有记录",
        "memory.searchMeta": "命中 {count} 条（低于阈值的候选 {below} 条）",
        "memory.searchMetaNoBelow": "命中 {count} 条",
        "detail.title": "记忆详情",
        "detail.text": "正文",
        "detail.level": "层级",
        "detail.status": "状态",
        "detail.tags": "标签",
        "detail.tagsPlaceholder": "逗号分隔",
        "detail.source": "来源",
        "detail.type": "类型",
        "detail.created": "创建时间",
        "detail.updated": "更新时间",
        "detail.bitemporal": "双时态",
        "detail.validAt": "生效时间",
        "detail.invalidAt": "失效时间",
        "detail.expiredAt": "过期时间",
        "detail.supersededBy": "被替代为",
        "detail.archive": "归档",
        "detail.archived": "已归档",
        "detail.saveEdit": "保存编辑",
        "detail.saved": "已保存",
        "detail.loadFailed": "读取详情失败",
        "detail.invalidText": "正文需为 1–500 字",
        "recall.title": "召回",
        "recall.recent": "最近召回（只读）",
        "recall.colTime": "时间",
        "recall.colQuery": "查询",
        "recall.colHits": "命中",
        "recall.colChars": "字数",
        "recall.colElapsed": "耗时",
        "recall.colInjected": "是否注入",
        "recall.colUsed": "采纳",
        "recall.injectedYes": "已注入",
        "recall.injectedNo": "未注入",
        "recall.usedYes": "已采纳",
        "recall.usedNo": "未采纳",
        "recall.testTitle": "纯检索测试",
        "recall.testNote": "只调用检索接口；不调模型、不写库、不产生召回副作用。",
        "recall.testPlaceholder": "输入要测试的词…",
        "recall.runTest": "检索",
        "recall.testEmpty": "没有命中（低于最小相关度）",
        "recall.testMeta": "返回 {count} 条 · {ms} ms",
        "recall.testError": "检索失败",
        "recall.recentEmpty": "暂无召回记录",
        "writes.title": "写入与关系",
        "writes.pendingTitle": "待审核的写入候选（shadow）",
        "writes.pendingNote": "shadow 模式只记录候选、不落记忆库；接受后才写入，拒绝会留审计理由。",
        "writes.colText": "候选文本",
        "writes.accept": "接受",
        "writes.reject": "拒绝",
        "writes.reviewDone": "已审核，列表已刷新",
        "writes.reviewFailed": "审核失败",
        "writes.recent": "最近写入审计（只读）",
        "writes.colTime": "时间",
        "writes.colAction": "动作",
        "writes.colNode": "节点",
        "writes.colReason": "原因",
        "writes.edges": "关系边",
        "writes.recentCount": "最近写入",
        "writes.note": "本页只读；写入由记忆接口与召回注入产生。",
        "writes.empty": "暂无写入记录",
        "settings.title": "设置",
        "settings.groupBackend": "接入",
        "settings.groupRecall": "注入",
        "settings.groupWrite": "写入",
        "settings.groupPanel": "面板",
        "settings.groupAdvanced": "高级",
        "settings.backendMode": "后端模式",
        "settings.backendUrl": "外部服务地址",
        "settings.backendTimeout": "请求超时（ms）",
        "settings.recallEnabled": "启用召回注入",
        "settings.maxHits": "最多命中条数",
        "settings.charBudget": "注入字数上限",
        "settings.intentBudget": "按意图分配注入预算（画图 0 注入）",
        "settings.minRel": "最小相关度（0–1）",
        "settings.recallTimeout": "召回超时（ms）",
        "settings.writeEnabled": "启用写入",
        "settings.reviewMode": "写入审核",
        "settings.maxChars": "单条字数上限",
        "settings.searchFeed": "搜索摘要写入记忆（24h TTL）",
        "settings.reflectEnabled": "启用空闲反思",
        "settings.syncEnabled": "与网关同步记忆",
        "settings.pollMs": "面板轮询间隔（ms）",
        "settings.allowRemote": "允许非回环访问",
        "settings.logLevel": "日志级别",
        "settings.worker": "使用 worker 执行检索",
        "settings.save": "保存设置",
        "settings.saved": "已保存（{time}）",
        "settings.saveFailed": "保存失败",
        "settings.loadFailed": "读取配置失败",
        "settings.defaultsNote": "配置未回显的分组按默认值展示；保存会整体提交上述场景。",
        "settings.restartNote": "接入与 worker 变更通常需要重载插件后生效。",
        "settings.allowRemoteWarn": "放开后局域网内其他设备可访问本面板 API。",
        "settings.readonlyUnavailable": "当前运行环境不支持保存配置（只读）。",
        "settings.invalidValue": "存在超出范围或非数字的取值，请修正后再保存。",
        "import.reading": "正在读取文件…",
        "import.uploading": "正在导入…",
        "import.tooLarge": "文件超过 4 MB，请拆分后导入。",
        "import.readFailed": "文件读取失败。",
        "import.smallDone": "导入完成：新增 {added} · 跳过 {skipped} · 错误 {errors}",
        "import.progress": "导入中 {done}/{total} · 新增 {added} · 跳过 {skipped} · 错误 {errors}",
        "import.done": "导入完成：新增 {added} · 跳过 {skipped} · 错误 {errors}",
        "import.failed": "导入失败",
        "import.total": "共 {total} 行",
        "import.button": "导入 JSONL",
        "sync.button": "与网关同步记忆",
        "sync.dryTitle": "同步预演（未写入）",
        "sync.pull": "拉取：新增 {added} / 跳过 {skipped} / 错误 {errors} / 行 {lines}",
        "sync.push": "推送：{lines} 行",
        "sync.confirm": "确认同步",
        "sync.done": "同步完成",
        "sync.busy": "同步中…",
        "reflect.button": "反思",
        "reflect.done": "反思完成：新增 {added} 条（素材 {material}）",
        "reflect.busy": "反思中…",
        "reflect.disabled": "反思未启用：去设置打开 reflect.enabled",
        "import.export": "导出",
        "import.accept": ".jsonl,.txt,text/plain",
        "status.active": "活跃",
        "status.archived": "已归档",
        "status.stale": "陈旧",
        "status.superseded": "已替代",
        "level.core": "核心",
        "level.important": "重要",
        "level.normal": "普通",
        "type.semantic": "语义",
        "type.procedural": "流程",
        "type.episodic": "事件",
        "type.mixed": "混合",
        "source.owner": "主人",
        "source.self": "自身",
        "source.group": "群组",
        "source.web": "网页",
        "source.tool": "工具",
        "source.import": "导入",
        "err.network": "网络不可达，请确认 DSH 运行中。",
        "err.backend_unreachable": "记忆后端不可达。",
        "err.backend_unavailable": "记忆后端未提供该能力。",
        "err.backend_error": "记忆后端返回错误。",
        "err.invalid_query": "查询词不能为空。",
        "err.invalid_text": "正文不合法（1–500 字）。",
        "err.invalid_level": "层级取值不合法。",
        "err.invalid_memory_type": "记忆类型不合法。",
        "err.invalid_tags": "标签格式不合法。",
        "err.identity_required": "缺少身份键，无法读写。",
        "err.write_disabled": "写入已关闭。",
        "err.duplicate": "内容已存在，已跳过。",
        "err.node_not_found": "找不到该记忆节点。",
        "err.job_not_found": "找不到该导入任务。",
        "err.invalid_job_id": "导入任务 id 不合法。",
        "err.config_save_unavailable": "当前环境不支持保存配置（只读）。",
        "err.config_save_failed": "配置保存失败。",
        "err.invalid_config": "配置内容不合法。",
        "err.invalid_value": "存在超出范围的取值。",
        "err.payload_too_large": "请求体过大（上限 4 MB）。",
        "err.invalid_jsonl": "JSONL 内容不合法。",
        "err.method_not_allowed": "接口不支持该请求方法。",
        "err.not_found": "接口不存在。",
        "err.not_loopback": "仅允许本机回环访问。",
        "err.file_too_large": "文件超过 4 MB，请拆分后导入。",
        "err.read_error": "文件读取失败。",
        "err.unknown": "未知错误。",
        "settings.groupIdentity": "身份",
        "settings.groupReflect": "反思",
        "settings.groupConsolidate": "巩固",
        "settings.groupEmbed": "向量",
        "settings.groupPrivacy": "隐私",
        "settings.groupEdges": "关系",
        "settings.groupSync": "同步",
        "settings.groupDanger": "危险区",
        "settings.groupBackground": "后台与同步",
        "settings.identityMode": "身份模式",
        "settings.identityModeDesc": "auto 由宿主会话推导身份；fixed 使用下方填写值。",
        "settings.identityRoleIdDesc": "留空表示不限定角色。",
        "settings.identityWorkspaceDesc": "留空表示当前工作区。",
        "settings.reflectEnabledDesc": "空闲时调用模型整理记忆。",
        "settings.syncEnabledDesc": "与网关双向同步记忆；桥地址由 profile 注入。",
        "settings.identityUserId": "userId",
        "settings.identityRoleId": "roleId",
        "settings.identityWorkspace": "workspace",
        "settings.identityAutoNote": "auto：userId 由宿主会话推导；当前版本回落 local。",
        "settings.identityFixedNote": "fixed：使用下方填写值；userId 为空会导致读写失败。",
        "settings.injectLevels": "允许注入的层级（逗号分隔）",
        "settings.injectLevelsDesc": "例如 core,important；留空表示不限。",
        "settings.showSources": "注入文本中显示来源",
        "settings.showSourcesDesc": "在注入文本中附带节点来源。",
        "settings.dailyCap": "每日写入上限",
        "settings.dailyCapDesc": "每日写入条数上限。",
        "settings.searchTtlHours": "搜索摘要 TTL（小时）",
        "settings.searchTtlHoursDesc": "搜索摘要记忆的过期时间。",
        "settings.judge": "写入判定器",
        "settings.judgeDesc": "rules 走规则；llm 调模型判定。",
        "settings.ignorePatterns": "忽略规则（每行一条）",
        "settings.ignorePatternsDesc": "命中任一正则的文本不写入。",
        "settings.writeModel": "写入判定模型（judge=llm 时使用）",
        "settings.writeModelDesc": "留空使用当前默认模型。",
        "settings.reflectModel": "反思模型",
        "settings.reflectModelDesc": "留空使用当前默认模型。",
        "settings.idleMinutes": "空闲触发（分钟）",
        "settings.idleMinutesDesc": "用户空闲达到该时长后触发。",
        "settings.maxItems": "单次最多新增",
        "settings.maxItemsDesc": "每次反思最多新增的记忆条数。",
        "settings.maxRunsPerDay": "每日最多运行",
        "settings.maxRunsPerDayDesc": "每日反思运行次数上限。",
        "settings.consolidateEnabled": "启用巩固",
        "settings.consolidateEnabledDesc": "定时合并重复与过期节点。",
        "settings.consolidateInterval": "巩固间隔（小时）",
        "settings.consolidateIntervalDesc": "两次巩固之间的间隔。",
        "settings.embedEnabled": "启用向量检索",
        "settings.embedEnabledDesc": "需要外部向量服务；本机默认未接。",
        "settings.embedEndpoint": "向量服务地址",
        "settings.embedEndpointDesc": "兼容 OpenAI embeddings 的服务地址。",
        "settings.embedModel": "向量模型",
        "settings.embedModelDesc": "向量模型名。",
        "settings.embedBatch": "向量批大小",
        "settings.embedBatchDesc": "单批向量化条数。",
        "settings.embedNote": "本机未接 provider；开启后 job 返回 unavailable。",
        "settings.privacyRedact": "写入前脱敏",
        "settings.privacyRedactDesc": "写入前替换敏感字段。",
        "settings.privacyRetention": "归档保留天数（0=永久）",
        "settings.privacyRetentionDesc": "0 表示永久保留。",
        "settings.privacyDanger": "retentionDays>0 会物理删除过期归档。",
        "settings.edgesDiffusion": "开启 1 跳关系扩散",
        "settings.edgesDiffusionDesc": "召回时沿关系边扩一跳。",
        "settings.edgesMinConf": "边的最小置信度",
        "settings.edgesMinConfDesc": "低于该置信度的边不参与扩散。",
        "settings.syncMode": "同步方向",
        "settings.syncModeDesc": "off 关闭；push/pull/both 选择方向。",
        "settings.syncInterval": "同步间隔（分钟）",
        "settings.syncIntervalDesc": "定时同步的间隔。",
        "settings.syncHttpTimeout": "同步超时（ms）",
        "settings.syncHttpTimeoutDesc": "同步 HTTP 请求超时。",
        "settings.syncBatch": "同步批大小",
        "settings.syncBatchDesc": "单批同步条数。",
        "settings.syncBridgeNote": "bridgeUrl 由 profile 注入，不在此编辑。",
        "settings.panelTab": "默认页签",
        "settings.panelTabDesc": "打开面板时默认选中的页签。",
        "settings.pollMsDesc": "概览页自动刷新间隔。",
        "settings.allowRemoteDesc": "仅本机回环默认可访问。",
        "settings.traceId": "traceId（链路标记）",
        "settings.traceIdDesc": "写入审计与日志的链路标记。",
        "settings.logLevelDesc": "插件日志级别。",
        "settings.workerDesc": "检索在 worker 线程执行，避免阻塞主线程。",
        "settings.exportMemory": "导出记忆（下载 JSONL）",
        "settings.dangerNote": "清空/重置接口未提供，当前版本无破坏性操作。",
        "settings.dataDir": "数据目录（只读）",
        "settings.dataDirDesc": "由宿主 profile 决定。",
        "settings.readonlyTag": "只读",
        "settings.effectInstant": "即时",
        "settings.effectReload": "重挂",
        "settings.effectLabel": "生效",
        "settings.savedButReloadFailed": "已保存，但重新读取配置失败。",
        "settings.backendModeDesc": "本地 SQLite 为默认；http/hybrid 走外部服务。",
        "settings.backendUrlDesc": "仅 backend.mode 非 local 时使用。",
        "settings.backendTimeoutDesc": "外部服务单次请求超时。",
        "settings.recallEnabledDesc": "关闭后不注入任何记忆。",
        "settings.maxHitsDesc": "每次召回最多注入条数。",
        "settings.charBudgetDesc": "注入正文总字数上限；0=关闭注入（不注入任何记忆）。",
        "settings.intentBudgetDesc": "画图等意图 0 注入。",
        "settings.minRelDesc": "低于该相关度的候选被过滤。",
        "settings.recallTimeoutDesc": "召回超时后 fail-open，不阻塞本轮。",
        "settings.writeEnabledDesc": "关闭后写入与候选审核都停止。",
        "settings.reviewModeDesc": "shadow 只记候选，auto 直接落库。",
        "settings.maxCharsDesc": "单条记忆正文硬顶。",
        "settings.searchFeedDesc": "搜索摘要作为记忆写入。",
        "recall.explain": "可解释性",
        "recall.explainHint": "展开查看评分分解",
        "recall.colRel": "rel",
        "recall.colMult": "mult",
        "recall.colGain": "gain",
        "recall.colEffWeight": "effWeight",
        "recall.colPath": "命中路径",
        "recall.colMatched": "命中词",
        "recall.pathFallback": "L1/L2",
        "recall.belowMin": "另有 {n} 条未过门",
        "recall.noComponents": "该命中未返回评分分解",
        "writes.pendingEmpty": "暂无待审",
        "writes.edgesTitle": "关系边统计",
        "writes.edgesEmpty": "暂无关系边",
        "writes.evolutionTitle": "最近演化",
        "writes.evolutionEmpty": "暂无演化记录",
        "writes.colType": "类型",
        "writes.colCount": "数量",
        "writes.colFromTo": "关系",
        "writes.colField": "字段",
        "memory.candidateQueued": "已入待审队列（去写入页审核）",
        "sync.disabled": "同步未启用：去设置打开 sync.enabled。",
        "header.identity": "身份",
        "header.identityTip": "当前记忆身份：{workspace} / {userId} / {roleId}",
        "err.sync_disabled": "同步未启用（sync.enabled=false）。",
        "err.sync_bridge_unset": "同步桥地址未配置（由 profile 注入 bridgeUrl）。",
        "err.confirm_required": "真跑同步需要 confirm=true。",
        "err.invalid_direction": "同步方向不合法（pull/push/both）。",
        "err.busy": "已有同类任务在运行，请稍后再试。",
        "err.reflect_unavailable": "反思调度器不可用。",
        "err.candidate_not_found": "找不到该待审候选。",
        "err.invalid_review": "审核参数不合法。",
        "err.privacy": "内容触发隐私规则，已拒绝写入。",
        "err.daily_cap": "已达到每日写入上限。",
        "err.text_too_long": "正文超过字数上限。",
        "err.unknown_error": "未知错误。",
        "err.network_error": "网络不可达，请确认 DSH 运行中。",
        "settings.defaultValue": "默认：{value}",
        "settings.defaultOn": "开",
        "settings.defaultOff": "关",
        "settings.defaultEmpty": "空",
        "settings.badgeGeneral": "通用",
        "settings.badgeLocal": "本机",
        "settings.badgeNeedsConfig": "需配置",
        "settings.depUnmet": "依赖未满足：{reason}",
        "settings.depBackendUrl": "仅 backend.mode 非 local 时生效",
        "settings.depWriteModel": "仅 judge=llm 时使用",
        "settings.depEmbed": "需先启用向量检索",
        "settings.depSync": "需先启用同步",
        "settings.depPanelRemote": "仅当允许非回环访问时对外生效",
        "settings.effectDaily": "每日",
        "settings.groupBackendDesc": "选本地库还是外部记忆服务；只有外部服务才需要地址与超时。",
        "settings.groupIdentityDesc": "决定每条记忆归属谁、哪个工作区；auto 跟随宿主会话。",
        "settings.groupRecallDesc": "每轮对话注入多少、多相关、哪些层级；直接影响回答的记性。",
        "settings.groupWriteDesc": "决定什么内容会被记住、写前如何审核、单条与每日上限。",
        "settings.groupReflectDesc": "空闲时让模型整理记忆；默认关闭，需要模型可用。",
        "settings.groupConsolidateDesc": "定时合并重复与过期节点，避免库无限膨胀；默认开启。",
        "settings.groupEmbedDesc": "接外部向量服务做语义检索；本机未接时保持关闭即可。",
        "settings.groupPrivacyDesc": "写入前脱敏与归档保留期；保留期到期会物理删除。",
        "settings.groupEdgesDesc": "召回时沿关系边扩一跳，并过滤低置信边。",
        "settings.groupSyncDesc": "与网关双向同步记忆；桥地址由 profile 注入。",
        "settings.groupPanelDesc": "本面板的刷新节奏、默认页签与访问范围。",
        "settings.groupAdvancedDesc": "日志与检索线程等排障项；一般无需改动。",
        "settings.groupDangerDesc": "导出备份入口；当前版本没有清空/重置接口，不提供破坏性按钮。",
        "settings.backendId": "后端标识",
        "settings.backendIdDesc": "服务注册与排障用的稳定标识；本机模式可留空。",
        "settings.syncBridgeUrl": "同步桥地址",
        "settings.syncBridgeUrlDesc": "由 profile 注入；此处手改的值会在下次加载配置时被覆盖。",
        "settings.syncDryRun": "同步默认预演",
        "settings.syncDryRunDesc": "开启时只比对差异，不写远端；真跑仍需在页头二次确认。",
        "settings.charBudgetZeroConfirm": "charBudget=0 会关闭注入：本轮不再注入任何记忆。确定保存？",
        "settings.sectionLabel": "记忆中枢",
        "header.backendStatus": "后端：{mode} · 协议 {protocol} · outbox {outbox}",
        "header.backendStatusTip": "来自 GET /version；接口不可用时各项显示 —",
        "header.protocolOk": "OK",
        "header.protocolMismatch": "不兼容",
        "health.backend": "后端",
        "health.protocol": "协议",
        "health.outbox": "outbox",
        "overview.migrationTitle": "迁移状态",
        "overview.migrationPending": "迁移待确认",
        "overview.migrationPendingDesc": "身份/数据迁移尚未确认；请到设置页检查后保存。",
        "overview.migrationFrom": "迁移来源",
        "overview.migrationAt": "迁移时间",
        "overview.openSettings": "去设置页",
        "overview.offlineBackendTitle": "未连接外部服务",
        "overview.offlineBackendDesc": "后端为 http/hybrid，但外部服务地址为空；可一键切回本地库。",
        "overview.switchLocal": "改用本地库",
        "overview.switchLocalDone": "已切换到本地库",
        "overview.switchLocalFailed": "切换失败",
        "memory.sampleTitle": "试用样例",
        "memory.sampleDesc": "写入 3 条示例记忆，随后可一键清理。",
        "memory.sampleWrite": "写入样例",
        "memory.sampleCleanup": "清理样例",
        "memory.sampleCleanupConfirm": "清理会归档这 3 条样例（不删除历史，保留审计）。确定？",
        "memory.sampleDone": "已写入 3 条样例",
        "memory.sampleCandidate": "影子模式下样例进入待审队列，未直接写入",
        "memory.sampleCleaned": "样例已归档",
        "memory.sample1": "鲸忆记忆中枢默认使用本地 SQLite，不把记忆上传到云端。",
        "memory.sample2": "每轮对话开始前，插件会按相关度召回少量记忆并注入上下文。",
        "memory.sample3": "写入默认走 shadow 审核：候选先落审计，确认后才成为记忆。",
        "recall.budgetTitle": "注入预算",
        "recall.budgetLine": "字数上限 {chars} · 最多 {hits} 条 · 意图档 {intent}",
        "recall.budgetIntentOn": "开",
        "recall.budgetIntentOff": "关",
        "recall.budgetZero": "0 字 = 关闭注入（不注入任何记忆）",
        "recall.filterLabel": "筛选",
        "recall.filterAll": "全部",
        "recall.filterUnused": "未采纳",
        "recall.filterZero": "零命中",
        "recall.colSource": "来源",
        "writes.rejectReason": "拒绝理由（可选）",
        "writes.rewrite": "改写正文（可选）",
        "writes.rewriteHint": "留空按原文接受；填写后先接受再改写该节点正文。",
        "writes.confirmReview": "提交审核",
        "writes.reviewFormTitle": "审核候选",
        "writes.actionAdd": "新增",
        "writes.actionNoop": "无操作",
        "writes.actionMerge": "合并",
        "writes.actionSupersede": "取代",
        "writes.actionReject": "拒绝",
        "writes.actionCandidate": "候选",
        "writes.oldValue": "旧值",
        "writes.newValue": "新值",
        "detail.origin": "证据（origin）",
        "detail.originUnavailable": "未提供",
        "detail.edges": "1 跳邻居边",
        "detail.edgesUnavailable": "未提供（/nodes/:id 未返回 edges）",
        "detail.edgesEmpty": "暂无邻居边",
        "detail.archiveConfirm": "归档不可撤销（审计可追溯）。确定归档这条记忆？",
        "detail.saveConfirm": "编辑会改写正文并留下审计记录。确定保存？",
        "header.rolePrefix": "角色：{roleId}"
      },
      "en": {
        "meta.title": "Whale Memory",
        "meta.description": "Local long-term memory: nodes, recall and write audit; local SQLite by default, optional external service.",
        "meta.detail": "docs/DETAIL.md",
        "tab.overview": "Overview",
        "tab.memory": "Memory",
        "tab.recall": "Recall",
        "tab.writes": "Writes & edges",
        "tab.settings": "Settings",
        "common.dash": "—",
        "common.retry": "Retry",
        "common.refresh": "Refresh",
        "common.loading": "Loading…",
        "common.empty": "No data",
        "common.close": "Close",
        "common.save": "Save",
        "common.saving": "Saving…",
        "common.cancel": "Cancel",
        "common.search": "Search",
        "common.prev": "Previous",
        "common.next": "Next",
        "common.pageInfo": "{from}–{to} of {total}",
        "common.total": "{total} total",
        "common.now": "just now",
        "common.yes": "Yes",
        "common.no": "No",
        "common.charCount": "{n} / {max} chars",
        "state.loading": "Loading…",
        "state.error": "Failed to load",
        "state.empty": "No data",
        "health.db": "DB",
        "health.migration": "Migration",
        "health.pending": "pending",
        "health.job": "job",
        "health.ok": "OK",
        "health.offline": "Offline",
        "health.running": "Running",
        "health.idle": "Idle",
        "overview.title": "Overview",
        "overview.offlineTitle": "Backend unreachable",
        "overview.offlineDesc": "The memory service is not reachable. Confirm DSH is running, then retry.",
        "overview.recent": "Latest 3 recalls",
        "overview.recentEmpty": "No recall records yet",
        "overview.health": "Health",
        "overview.kpiNodes": "Total nodes",
        "overview.kpiActive": "Active nodes",
        "overview.kpiRecalls": "Recalls today",
        "overview.kpiEdges": "Edges",
        "overview.injected": "{n} chars injected",
        "overview.injectedNone": "not injected",
        "overview.refreshed": "Updated {time}",
        "overview.hits": "{n} hits",
        "overview.injectedBadge": "Injected",
        "overview.notInjectedBadge": "Not injected",
        "overview.kpiZeroInjection": "Zero-injection rate",
        "overview.kpiAdoption": "Adoption rate",
        "overview.kpiJobSuccess": "Job success (7d)",
        "overview.kpiDbSize": "DB size",
        "overview.targetMet": "On target · {target}",
        "overview.targetMissed": "Below target · {target}",
        "overview.trend": "7-day trend",
        "overview.trendEmpty": "No 7-day data yet",
        "overview.trendInjected": "Injection rate",
        "overview.trendZeroHit": "Zero-hit share",
        "overview.trendToday": "Today",
        "overview.trendTip": "{day}: recalls {recalls} · hits {withHits} · injected {injected} · adopted {adopted} · zero-hit {zeroHit}",
        "overview.failures": "Recent failures",
        "overview.failuresEmpty": "No failed jobs in the last 24h",
        "overview.failureAttempts": "attempts {n}",
        "memory.title": "Memory",
        "memory.searchPlaceholder": "Search keywords (300 ms debounce)…",
        "memory.searching": "Searching…",
        "memory.noResults": "No matches",
        "memory.emptyTitle": "Memory is empty",
        "memory.emptyDesc": "Write the first memory, or import a JSONL file.",
        "memory.writeFirst": "Write first memory",
        "memory.importJsonl": "Import JSONL",
        "memory.newTitle": "New memory",
        "memory.writePlaceholder": "Text to remember (max 500 chars)…",
        "memory.writeLevel": "Level",
        "memory.writeType": "Type",
        "memory.writeTags": "Tags (comma separated)",
        "memory.writeSubmit": "Write",
        "memory.written": "Written: {id}",
        "memory.colText": "Text",
        "memory.colLevel": "Level",
        "memory.colType": "Type",
        "memory.colStatus": "Status",
        "memory.colScore": "Score",
        "memory.colSource": "Source",
        "memory.pageEmpty": "No records on this page",
        "memory.searchMeta": "{count} matches ({below} candidates below threshold)",
        "memory.searchMetaNoBelow": "{count} matches",
        "detail.title": "Memory detail",
        "detail.text": "Text",
        "detail.level": "Level",
        "detail.status": "Status",
        "detail.tags": "Tags",
        "detail.tagsPlaceholder": "comma separated",
        "detail.source": "Source",
        "detail.type": "Type",
        "detail.created": "Created",
        "detail.updated": "Updated",
        "detail.bitemporal": "Bi-temporal",
        "detail.validAt": "Valid from",
        "detail.invalidAt": "Invalid at",
        "detail.expiredAt": "Expired at",
        "detail.supersededBy": "Superseded by",
        "detail.archive": "Archive",
        "detail.archived": "Archived",
        "detail.saveEdit": "Save edits",
        "detail.saved": "Saved",
        "detail.loadFailed": "Failed to load detail",
        "detail.invalidText": "Text must be 1–500 chars",
        "recall.title": "Recall",
        "recall.recent": "Recent recalls (read-only)",
        "recall.colTime": "Time",
        "recall.colQuery": "Query",
        "recall.colHits": "Hits",
        "recall.colChars": "Chars",
        "recall.colElapsed": "Elapsed",
        "recall.colInjected": "Injected",
        "recall.colUsed": "Adopted",
        "recall.injectedYes": "Injected",
        "recall.injectedNo": "Not injected",
        "recall.usedYes": "Adopted",
        "recall.usedNo": "Not adopted",
        "recall.testTitle": "Search-only test",
        "recall.testNote": "Calls the search endpoint only; no model call, no writes, no recall side effects.",
        "recall.testPlaceholder": "Keyword to test…",
        "recall.runTest": "Search",
        "recall.testEmpty": "No matches (below minimum relevance)",
        "recall.testMeta": "{count} results · {ms} ms",
        "recall.testError": "Search failed",
        "recall.recentEmpty": "No recall records yet",
        "writes.title": "Writes & edges",
        "writes.pendingTitle": "Pending write candidates (shadow)",
        "writes.pendingNote": "Shadow mode records candidates only; accept to store, reject keeps an audit reason.",
        "writes.colText": "Candidate text",
        "writes.accept": "Accept",
        "writes.reject": "Reject",
        "writes.reviewDone": "Reviewed; list refreshed",
        "writes.reviewFailed": "Review failed",
        "writes.recent": "Recent write audit (read-only)",
        "writes.colTime": "Time",
        "writes.colAction": "Action",
        "writes.colNode": "Node",
        "writes.colReason": "Reason",
        "writes.edges": "Edges",
        "writes.recentCount": "Recent writes",
        "writes.note": "This page is read-only; writes come from the memory API and recall injection.",
        "writes.empty": "No write records yet",
        "settings.title": "Settings",
        "settings.groupBackend": "Backend",
        "settings.groupRecall": "Injection",
        "settings.groupWrite": "Write",
        "settings.groupBackground": "Background & sync",
        "settings.groupPanel": "Panel",
        "settings.groupAdvanced": "Advanced",
        "settings.backendMode": "Backend mode",
        "settings.backendUrl": "External service URL",
        "settings.backendTimeout": "Request timeout (ms)",
        "settings.recallEnabled": "Enable recall injection",
        "settings.maxHits": "Max hits",
        "settings.charBudget": "Injected char budget",
        "settings.intentBudget": "Per-intent injection budget (0 for image prompts)",
        "settings.minRel": "Minimum relevance (0–1)",
        "settings.recallTimeout": "Recall timeout (ms)",
        "settings.writeEnabled": "Enable writes",
        "settings.reviewMode": "Write review",
        "settings.maxChars": "Max chars per memory",
        "settings.searchFeed": "Save search summaries as memories (24h TTL)",
        "settings.reflectEnabled": "Enable idle reflection",
        "settings.syncEnabled": "Sync with gateway",
        "settings.pollMs": "Panel poll interval (ms)",
        "settings.allowRemote": "Allow non-loopback access",
        "settings.logLevel": "Log level",
        "settings.worker": "Run search in worker",
        "settings.save": "Save settings",
        "settings.saved": "Saved ({time})",
        "settings.saveFailed": "Save failed",
        "settings.loadFailed": "Failed to load configuration",
        "settings.defaultsNote": "Groups absent from the config echo are shown with defaults; saving submits all groups above.",
        "settings.restartNote": "Backend and worker changes usually take effect after reloading the plugin.",
        "settings.allowRemoteWarn": "When enabled, other devices on the LAN can reach this panel API.",
        "settings.readonlyUnavailable": "Config saving is unavailable in this runtime (read-only).",
        "settings.invalidValue": "Some values are out of range or not numeric; fix them before saving.",
        "import.reading": "Reading file…",
        "import.uploading": "Importing…",
        "import.tooLarge": "File exceeds 4 MB; split it before importing.",
        "import.readFailed": "Failed to read the file.",
        "import.smallDone": "Import finished: added {added} · skipped {skipped} · errors {errors}",
        "import.progress": "Importing {done}/{total} · added {added} · skipped {skipped} · errors {errors}",
        "import.done": "Import finished: added {added} · skipped {skipped} · errors {errors}",
        "import.failed": "Import failed",
        "import.total": "{total} lines",
        "import.button": "Import JSONL",
        "sync.button": "Sync with gateway",
        "sync.dryTitle": "Sync dry-run (nothing written)",
        "sync.pull": "Pull: +{added} / skipped {skipped} / errors {errors} / lines {lines}",
        "sync.push": "Push: {lines} lines",
        "sync.confirm": "Confirm sync",
        "sync.done": "Sync complete",
        "sync.busy": "Syncing…",
        "reflect.button": "Reflect",
        "reflect.done": "Reflected: +{added} (material {material})",
        "reflect.busy": "Reflecting…",
        "reflect.disabled": "Reflect disabled: enable reflect.enabled in settings",
        "import.export": "Export",
        "import.accept": ".jsonl,.txt,text/plain",
        "status.active": "Active",
        "status.archived": "Archived",
        "status.stale": "Stale",
        "status.superseded": "Superseded",
        "level.core": "Core",
        "level.important": "Important",
        "level.normal": "Normal",
        "type.semantic": "Semantic",
        "type.procedural": "Procedural",
        "type.episodic": "Episodic",
        "type.mixed": "Mixed",
        "source.owner": "Owner",
        "source.self": "Self",
        "source.group": "Group",
        "source.web": "Web",
        "source.tool": "Tool",
        "source.import": "Import",
        "err.network": "Network unreachable; confirm DSH is running.",
        "err.backend_unreachable": "Memory backend is unreachable.",
        "err.backend_unavailable": "Memory backend does not provide this capability.",
        "err.backend_error": "Memory backend returned an error.",
        "err.invalid_query": "Query must not be empty.",
        "err.invalid_text": "Text is invalid (1–500 chars).",
        "err.invalid_level": "Invalid level.",
        "err.invalid_memory_type": "Invalid memory type.",
        "err.invalid_tags": "Invalid tags.",
        "err.identity_required": "Identity keys are missing; cannot read or write.",
        "err.write_disabled": "Writes are disabled.",
        "err.duplicate": "Content already exists; skipped.",
        "err.node_not_found": "Memory node not found.",
        "err.job_not_found": "Import job not found.",
        "err.invalid_job_id": "Invalid import job id.",
        "err.config_save_unavailable": "Config saving is unavailable in this runtime (read-only).",
        "err.config_save_failed": "Failed to save configuration.",
        "err.invalid_config": "Invalid configuration.",
        "err.invalid_value": "A value is out of range.",
        "err.payload_too_large": "Request body too large (4 MB limit).",
        "err.invalid_jsonl": "Invalid JSONL content.",
        "err.method_not_allowed": "Method not allowed.",
        "err.not_found": "Endpoint not found.",
        "err.not_loopback": "Loopback access only.",
        "err.file_too_large": "File exceeds 4 MB; split it before importing.",
        "err.read_error": "Failed to read the file.",
        "err.unknown": "Unknown error.",
        "settings.groupIdentity": "Identity",
        "settings.groupReflect": "Reflection",
        "settings.groupConsolidate": "Consolidation",
        "settings.groupEmbed": "Embeddings",
        "settings.groupPrivacy": "Privacy",
        "settings.groupEdges": "Edges",
        "settings.groupSync": "Sync",
        "settings.groupDanger": "Danger zone",
        "settings.identityMode": "Identity mode",
        "settings.identityModeDesc": "auto derives identity from the host session; fixed uses the values below.",
        "settings.identityRoleIdDesc": "Empty means no role restriction.",
        "settings.identityWorkspaceDesc": "Empty means the current workspace.",
        "settings.reflectEnabledDesc": "Reflects and reorganizes memories when idle.",
        "settings.syncEnabledDesc": "Syncs memories with the gateway; the bridge URL is injected by the profile.",
        "settings.identityUserId": "userId",
        "settings.identityRoleId": "roleId",
        "settings.identityWorkspace": "workspace",
        "settings.identityAutoNote": "auto: userId is derived from the host session; currently falls back to \"local\".",
        "settings.identityFixedNote": "fixed: uses the values below; an empty userId makes reads and writes fail.",
        "settings.injectLevels": "Levels allowed in injection (comma separated)",
        "settings.injectLevelsDesc": "e.g. core,important; leave empty for no limit.",
        "settings.showSources": "Show sources in injected text",
        "settings.showSourcesDesc": "Append node sources to injected text.",
        "settings.dailyCap": "Daily write cap",
        "settings.dailyCapDesc": "Daily write count cap.",
        "settings.searchTtlHours": "Search-summary TTL (hours)",
        "settings.searchTtlHoursDesc": "TTL for search-summary memories.",
        "settings.judge": "Write judge",
        "settings.judgeDesc": "rules uses heuristics; llm calls a model.",
        "settings.ignorePatterns": "Ignore patterns (one per line)",
        "settings.ignorePatternsDesc": "Text matching any pattern is not written.",
        "settings.writeModel": "Write judge model (used when judge=llm)",
        "settings.writeModelDesc": "Empty means the current default model.",
        "settings.reflectModel": "Reflection model",
        "settings.reflectModelDesc": "Empty means the current default model.",
        "settings.idleMinutes": "Idle trigger (minutes)",
        "settings.idleMinutesDesc": "Triggered after the user is idle for this long.",
        "settings.maxItems": "Max items per run",
        "settings.maxItemsDesc": "Max new memories per reflection run.",
        "settings.maxRunsPerDay": "Max runs per day",
        "settings.maxRunsPerDayDesc": "Daily reflection run cap.",
        "settings.consolidateEnabled": "Enable consolidation",
        "settings.consolidateEnabledDesc": "Periodically merges duplicates and expired nodes.",
        "settings.consolidateInterval": "Consolidation interval (hours)",
        "settings.consolidateIntervalDesc": "Interval between consolidation runs.",
        "settings.embedEnabled": "Enable vector search",
        "settings.embedEnabledDesc": "Requires an external vector service; not wired by default here.",
        "settings.embedEndpoint": "Vector service endpoint",
        "settings.embedEndpointDesc": "Endpoint compatible with OpenAI embeddings.",
        "settings.embedModel": "Embedding model",
        "settings.embedModelDesc": "Embedding model name.",
        "settings.embedBatch": "Embedding batch size",
        "settings.embedBatchDesc": "Items per embedding batch.",
        "settings.embedNote": "No provider is wired on this machine; jobs return \"unavailable\" when enabled.",
        "settings.privacyRedact": "Redact before writing",
        "settings.privacyRedactDesc": "Sensitive fields are replaced before writing.",
        "settings.privacyRetention": "Archived retention days (0 = forever)",
        "settings.privacyRetentionDesc": "0 keeps archives forever.",
        "settings.privacyDanger": "retentionDays > 0 physically deletes expired archives.",
        "settings.edgesDiffusion": "Enable 1-hop edge diffusion",
        "settings.edgesDiffusionDesc": "Expands one hop along edges during recall.",
        "settings.edgesMinConf": "Minimum edge confidence",
        "settings.edgesMinConfDesc": "Edges below this confidence are not diffused.",
        "settings.syncMode": "Sync direction",
        "settings.syncModeDesc": "off disables; push/pull/both select directions.",
        "settings.syncInterval": "Sync interval (minutes)",
        "settings.syncIntervalDesc": "Interval for scheduled sync.",
        "settings.syncHttpTimeout": "Sync timeout (ms)",
        "settings.syncHttpTimeoutDesc": "HTTP timeout for sync requests.",
        "settings.syncBatch": "Sync batch size",
        "settings.syncBatchDesc": "Items per sync batch.",
        "settings.syncBridgeNote": "bridgeUrl is injected by the profile and is not edited here.",
        "settings.panelTab": "Default tab",
        "settings.panelTabDesc": "Tab selected when the panel opens.",
        "settings.pollMsDesc": "Auto-refresh interval on the overview tab.",
        "settings.allowRemoteDesc": "Only loopback access is allowed by default.",
        "settings.traceId": "traceId (trace marker)",
        "settings.traceIdDesc": "Trace marker for write audit and logs.",
        "settings.logLevelDesc": "Plugin log level.",
        "settings.workerDesc": "Search runs in a worker thread to avoid blocking the main thread.",
        "settings.exportMemory": "Export memory (download JSONL)",
        "settings.dangerNote": "No clear/reset endpoint is provided; this version has no destructive actions.",
        "settings.dataDir": "Data directory (read-only)",
        "settings.dataDirDesc": "Determined by the host profile.",
        "settings.readonlyTag": "read-only",
        "settings.effectInstant": "Instant",
        "settings.effectReload": "Reload",
        "settings.effectLabel": "Effect",
        "settings.savedButReloadFailed": "Saved, but reloading the config failed.",
        "settings.backendModeDesc": "Local SQLite by default; http/hybrid use the external service.",
        "settings.backendUrlDesc": "Only used when backend.mode is not local.",
        "settings.backendTimeoutDesc": "Per-request timeout for the external service.",
        "settings.recallEnabledDesc": "No memories are injected when disabled.",
        "settings.maxHitsDesc": "Max hits injected per recall.",
        "settings.charBudgetDesc": "Total injected character budget; 0 = injection off (no memory is injected).",
        "settings.intentBudgetDesc": "Image-prompt intents get 0 injection.",
        "settings.minRelDesc": "Candidates below this relevance are filtered.",
        "settings.recallTimeoutDesc": "Recall fails open after timeout and does not block the turn.",
        "settings.writeEnabledDesc": "Writes and candidate review stop when disabled.",
        "settings.reviewModeDesc": "shadow records candidates only; auto writes directly.",
        "settings.maxCharsDesc": "Hard limit per memory text.",
        "settings.searchFeedDesc": "Search summaries are saved as memories.",
        "recall.explain": "Explainability",
        "recall.explainHint": "Expand to see score breakdown",
        "recall.colRel": "rel",
        "recall.colMult": "mult",
        "recall.colGain": "gain",
        "recall.colEffWeight": "effWeight",
        "recall.colPath": "Hit path",
        "recall.colMatched": "Matched terms",
        "recall.pathFallback": "L1/L2",
        "recall.belowMin": "{n} more candidates below the gate",
        "recall.noComponents": "This hit returned no score breakdown",
        "writes.pendingEmpty": "No pending candidates",
        "writes.edgesTitle": "Edge statistics",
        "writes.edgesEmpty": "No edges yet",
        "writes.evolutionTitle": "Recent evolution",
        "writes.evolutionEmpty": "No evolution records",
        "writes.colType": "Type",
        "writes.colCount": "Count",
        "writes.colFromTo": "Relation",
        "writes.colField": "Field",
        "memory.candidateQueued": "Added to the review queue (review it on the Writes tab)",
        "sync.disabled": "Sync disabled: enable sync.enabled in settings.",
        "header.identity": "Identity",
        "header.identityTip": "Current memory identity: {workspace} / {userId} / {roleId}",
        "err.sync_disabled": "Sync is disabled (sync.enabled=false).",
        "err.sync_bridge_unset": "Sync bridge URL is not configured (the profile injects bridgeUrl).",
        "err.confirm_required": "A real sync requires confirm=true.",
        "err.invalid_direction": "Invalid sync direction (pull/push/both).",
        "err.busy": "A task of this kind is already running; try again later.",
        "err.reflect_unavailable": "The reflection scheduler is unavailable.",
        "err.candidate_not_found": "The pending candidate was not found.",
        "err.invalid_review": "Invalid review parameters.",
        "err.privacy": "The content triggered privacy rules and was not written.",
        "err.daily_cap": "The daily write cap has been reached.",
        "err.text_too_long": "Text exceeds the character limit.",
        "err.unknown_error": "Unknown error.",
        "err.network_error": "Network unreachable; confirm DSH is running.",
        "settings.defaultValue": "Default: {value}",
        "settings.defaultOn": "On",
        "settings.defaultOff": "Off",
        "settings.defaultEmpty": "empty",
        "settings.badgeGeneral": "General",
        "settings.badgeLocal": "Local",
        "settings.badgeNeedsConfig": "Needs config",
        "settings.depUnmet": "Dependency unmet: {reason}",
        "settings.depBackendUrl": "Only used when backend.mode is not local",
        "settings.depWriteModel": "Only used when judge=llm",
        "settings.depEmbed": "Enable vector search first",
        "settings.depSync": "Enable sync first",
        "settings.depPanelRemote": "Only effective when non-loopback access is allowed",
        "settings.effectDaily": "Daily",
        "settings.groupBackendDesc": "Choose the local database or an external memory service; only the external path needs a URL and timeout.",
        "settings.groupIdentityDesc": "Decides who and which workspace each memory belongs to; auto follows the host session.",
        "settings.groupRecallDesc": "How much, how relevant and which levels are injected each turn; this directly shapes how much the assistant remembers.",
        "settings.groupWriteDesc": "What gets remembered, how writes are reviewed, and the per-memory / daily limits.",
        "settings.groupReflectDesc": "Let the model reorganize memories while idle; off by default and needs a model.",
        "settings.groupConsolidateDesc": "Merge duplicates and expired nodes on a schedule so the store does not grow forever; on by default.",
        "settings.groupEmbedDesc": "Connect an external vector service for semantic search; leave it off when this machine has none.",
        "settings.groupPrivacyDesc": "Redaction before writing and archive retention; expired archives are physically deleted.",
        "settings.groupEdgesDesc": "Expand one hop along edges during recall and filter out low-confidence edges.",
        "settings.groupSyncDesc": "Sync memories both ways with the gateway; the bridge URL is injected by the profile.",
        "settings.groupPanelDesc": "Refresh cadence, default tab and access scope of this panel.",
        "settings.groupAdvancedDesc": "Logging and search-thread diagnostics; rarely needs changing.",
        "settings.groupDangerDesc": "Export backup entry; this version ships no clear/reset endpoint, so no destructive buttons.",
        "settings.backendId": "Backend id",
        "settings.backendIdDesc": "Stable identifier for service registration and diagnostics; may stay empty in local mode.",
        "settings.syncBridgeUrl": "Sync bridge URL",
        "settings.syncBridgeUrlDesc": "Injected by the profile; a manual value is overwritten on the next config load.",
        "settings.syncDryRun": "Default sync to dry-run",
        "settings.syncDryRunDesc": "When on, sync only compares differences and writes nothing; a real run still needs confirmation in the header.",
        "settings.charBudgetZeroConfirm": "charBudget=0 disables injection: no memory will be injected into this turn. Save anyway?",
        "settings.sectionLabel": "Memory hub",
        "header.backendStatus": "Backend: {mode} · protocol {protocol} · outbox {outbox}",
        "header.backendStatusTip": "From GET /version; values show — when the endpoint is unavailable",
        "header.protocolOk": "OK",
        "header.protocolMismatch": "incompatible",
        "health.backend": "Backend",
        "health.protocol": "Protocol",
        "health.outbox": "outbox",
        "overview.migrationTitle": "Migration",
        "overview.migrationPending": "Migration awaiting confirmation",
        "overview.migrationPendingDesc": "Identity/data migration is not confirmed yet; review it on the settings tab, then save.",
        "overview.migrationFrom": "Migrated from",
        "overview.migrationAt": "Migrated at",
        "overview.openSettings": "Open settings",
        "overview.offlineBackendTitle": "External service not connected",
        "overview.offlineBackendDesc": "The backend is http/hybrid but the external service URL is empty; switch back to the local store in one click.",
        "overview.switchLocal": "Switch to local",
        "overview.switchLocalDone": "Switched to the local store",
        "overview.switchLocalFailed": "Switch failed",
        "memory.sampleTitle": "Sample memories",
        "memory.sampleDesc": "Write 3 sample memories; they can be cleaned up in one click.",
        "memory.sampleWrite": "Write samples",
        "memory.sampleCleanup": "Clean up samples",
        "memory.sampleCleanupConfirm": "Cleanup archives these 3 samples (history is kept, audit trail preserved). Continue?",
        "memory.sampleDone": "3 samples written",
        "memory.sampleCandidate": "In shadow mode the samples queued for review instead of being written",
        "memory.sampleCleaned": "Samples archived",
        "memory.sample1": "Whale Memory keeps its store in local SQLite by default and never uploads memories to the cloud.",
        "memory.sample2": "Before each turn the plugin recalls a few relevant memories and injects them into context.",
        "memory.sample3": "Writes go through shadow review by default: candidates are audited first and only become memories after approval.",
        "recall.budgetTitle": "Injection budget",
        "recall.budgetLine": "{chars} chars · up to {hits} hits · intent tier {intent}",
        "recall.budgetIntentOn": "On",
        "recall.budgetIntentOff": "Off",
        "recall.budgetZero": "0 chars = injection off (no memory injected)",
        "recall.filterLabel": "Filter",
        "recall.filterAll": "All",
        "recall.filterUnused": "Not adopted",
        "recall.filterZero": "Zero hits",
        "recall.colSource": "Source",
        "writes.rejectReason": "Reject reason (optional)",
        "writes.rewrite": "Rewrite text (optional)",
        "writes.rewriteHint": "Leave empty to accept as-is; a rewritten text is applied to the node after acceptance.",
        "writes.confirmReview": "Submit review",
        "writes.reviewFormTitle": "Review candidate",
        "writes.actionAdd": "Add",
        "writes.actionNoop": "No-op",
        "writes.actionMerge": "Merge",
        "writes.actionSupersede": "Supersede",
        "writes.actionReject": "Reject",
        "writes.actionCandidate": "Candidate",
        "writes.oldValue": "Old",
        "writes.newValue": "New",
        "detail.origin": "Evidence (origin)",
        "detail.originUnavailable": "Not provided",
        "detail.edges": "1-hop neighbour edges",
        "detail.edgesUnavailable": "Not provided (/nodes/:id returned no edges)",
        "detail.edgesEmpty": "No neighbour edges",
        "detail.archiveConfirm": "Archiving is not reversible (the audit trail is kept). Archive this memory?",
        "detail.saveConfirm": "Editing rewrites the text and keeps an audit record. Save?",
        "header.rolePrefix": "role: {roleId}"
      },
      "ja": {
        "meta.title": "ホエールメモリ",
        "meta.description": "ローカル長期記憶：ノード、想起、書き込み監査；既定はローカル SQLite、任意で外部サービス。",
        "meta.detail": "docs/DETAIL.md",
        "tab.overview": "Overview",
        "tab.memory": "Memory",
        "tab.recall": "Recall",
        "tab.writes": "Writes & edges",
        "tab.settings": "Settings",
        "common.dash": "—",
        "common.retry": "Retry",
        "common.refresh": "Refresh",
        "common.loading": "Loading…",
        "common.empty": "No data",
        "common.close": "Close",
        "common.save": "Save",
        "common.saving": "Saving…",
        "common.cancel": "Cancel",
        "common.search": "Search",
        "common.prev": "Previous",
        "common.next": "Next",
        "common.pageInfo": "{from}–{to} of {total}",
        "common.total": "{total} total",
        "common.now": "just now",
        "common.yes": "Yes",
        "common.no": "No",
        "common.charCount": "{n} / {max} chars",
        "state.loading": "Loading…",
        "state.error": "Failed to load",
        "state.empty": "No data",
        "health.db": "DB",
        "health.migration": "Migration",
        "health.pending": "pending",
        "health.job": "job",
        "health.ok": "OK",
        "health.offline": "Offline",
        "health.running": "Running",
        "health.idle": "Idle",
        "overview.title": "Overview",
        "overview.offlineTitle": "Backend unreachable",
        "overview.offlineDesc": "The memory service is not reachable. Confirm DSH is running, then retry.",
        "overview.recent": "Latest 3 recalls",
        "overview.recentEmpty": "No recall records yet",
        "overview.health": "Health",
        "overview.kpiNodes": "Total nodes",
        "overview.kpiActive": "Active nodes",
        "overview.kpiRecalls": "Recalls today",
        "overview.kpiEdges": "Edges",
        "overview.injected": "{n} chars injected",
        "overview.injectedNone": "not injected",
        "overview.refreshed": "Updated {time}",
        "overview.hits": "{n} hits",
        "overview.injectedBadge": "Injected",
        "overview.notInjectedBadge": "Not injected",
        "overview.kpiZeroInjection": "ゼロ注入率",
        "overview.kpiAdoption": "採択率",
        "overview.kpiJobSuccess": "ジョブ成功率（7日）",
        "overview.kpiDbSize": "DB サイズ",
        "overview.targetMet": "達成 · 目標 {target}",
        "overview.targetMissed": "未達 · 目標 {target}",
        "overview.trend": "7日トレンド",
        "overview.trendEmpty": "7日データがありません",
        "overview.trendInjected": "注入率",
        "overview.trendZeroHit": "ゼロヒット比率",
        "overview.trendToday": "今日",
        "overview.trendTip": "{day}：想起 {recalls} · ヒット {withHits} · 注入 {injected} · 採択 {adopted} · ゼロヒット {zeroHit}",
        "overview.failures": "最近の失敗",
        "overview.failuresEmpty": "直近24時間に失敗ジョブはありません",
        "overview.failureAttempts": "試行 {n}",
        "memory.title": "Memory",
        "memory.searchPlaceholder": "Search keywords (300 ms debounce)…",
        "memory.searching": "Searching…",
        "memory.noResults": "No matches",
        "memory.emptyTitle": "Memory is empty",
        "memory.emptyDesc": "Write the first memory, or import a JSONL file.",
        "memory.writeFirst": "Write first memory",
        "memory.importJsonl": "Import JSONL",
        "memory.newTitle": "New memory",
        "memory.writePlaceholder": "Text to remember (max 500 chars)…",
        "memory.writeLevel": "Level",
        "memory.writeType": "Type",
        "memory.writeTags": "Tags (comma separated)",
        "memory.writeSubmit": "Write",
        "memory.written": "Written: {id}",
        "memory.colText": "Text",
        "memory.colLevel": "Level",
        "memory.colType": "Type",
        "memory.colStatus": "Status",
        "memory.colScore": "Score",
        "memory.colSource": "Source",
        "memory.pageEmpty": "No records on this page",
        "memory.searchMeta": "{count} matches ({below} candidates below threshold)",
        "memory.searchMetaNoBelow": "{count} matches",
        "detail.title": "Memory detail",
        "detail.text": "Text",
        "detail.level": "Level",
        "detail.status": "Status",
        "detail.tags": "Tags",
        "detail.tagsPlaceholder": "comma separated",
        "detail.source": "Source",
        "detail.type": "Type",
        "detail.created": "Created",
        "detail.updated": "Updated",
        "detail.bitemporal": "Bi-temporal",
        "detail.validAt": "Valid from",
        "detail.invalidAt": "Invalid at",
        "detail.expiredAt": "Expired at",
        "detail.supersededBy": "Superseded by",
        "detail.archive": "Archive",
        "detail.archived": "Archived",
        "detail.saveEdit": "Save edits",
        "detail.saved": "Saved",
        "detail.loadFailed": "Failed to load detail",
        "detail.invalidText": "Text must be 1–500 chars",
        "recall.title": "Recall",
        "recall.recent": "Recent recalls (read-only)",
        "recall.colTime": "Time",
        "recall.colQuery": "Query",
        "recall.colHits": "Hits",
        "recall.colChars": "Chars",
        "recall.colElapsed": "Elapsed",
        "recall.colInjected": "Injected",
        "recall.colUsed": "Adopted",
        "recall.injectedYes": "Injected",
        "recall.injectedNo": "Not injected",
        "recall.usedYes": "Adopted",
        "recall.usedNo": "Not adopted",
        "recall.testTitle": "Search-only test",
        "recall.testNote": "Calls the search endpoint only; no model call, no writes, no recall side effects.",
        "recall.testPlaceholder": "Keyword to test…",
        "recall.runTest": "Search",
        "recall.testEmpty": "No matches (below minimum relevance)",
        "recall.testMeta": "{count} results · {ms} ms",
        "recall.testError": "Search failed",
        "recall.recentEmpty": "No recall records yet",
        "writes.title": "Writes & edges",
        "writes.pendingTitle": "Pending write candidates (shadow)",
        "writes.pendingNote": "Shadow mode records candidates only; accept to store, reject keeps an audit reason.",
        "writes.colText": "Candidate text",
        "writes.accept": "Accept",
        "writes.reject": "Reject",
        "writes.reviewDone": "Reviewed; list refreshed",
        "writes.reviewFailed": "Review failed",
        "writes.recent": "Recent write audit (read-only)",
        "writes.colTime": "Time",
        "writes.colAction": "Action",
        "writes.colNode": "Node",
        "writes.colReason": "Reason",
        "writes.edges": "Edges",
        "writes.recentCount": "Recent writes",
        "writes.note": "This page is read-only; writes come from the memory API and recall injection.",
        "writes.empty": "No write records yet",
        "settings.title": "Settings",
        "settings.groupBackend": "Backend",
        "settings.groupRecall": "Injection",
        "settings.groupWrite": "Write",
        "settings.groupBackground": "Background & sync",
        "settings.groupPanel": "Panel",
        "settings.groupAdvanced": "Advanced",
        "settings.backendMode": "Backend mode",
        "settings.backendUrl": "External service URL",
        "settings.backendTimeout": "Request timeout (ms)",
        "settings.recallEnabled": "Enable recall injection",
        "settings.maxHits": "Max hits",
        "settings.charBudget": "Injected char budget",
        "settings.intentBudget": "Per-intent injection budget (0 for image prompts)",
        "settings.minRel": "Minimum relevance (0–1)",
        "settings.recallTimeout": "Recall timeout (ms)",
        "settings.writeEnabled": "Enable writes",
        "settings.reviewMode": "Write review",
        "settings.maxChars": "Max chars per memory",
        "settings.searchFeed": "Save search summaries as memories (24h TTL)",
        "settings.reflectEnabled": "Enable idle reflection",
        "settings.syncEnabled": "Sync with gateway",
        "settings.pollMs": "Panel poll interval (ms)",
        "settings.allowRemote": "Allow non-loopback access",
        "settings.logLevel": "Log level",
        "settings.worker": "Run search in worker",
        "settings.save": "Save settings",
        "settings.saved": "Saved ({time})",
        "settings.saveFailed": "Save failed",
        "settings.loadFailed": "Failed to load configuration",
        "settings.defaultsNote": "Groups absent from the config echo are shown with defaults; saving submits all groups above.",
        "settings.restartNote": "Backend and worker changes usually take effect after reloading the plugin.",
        "settings.allowRemoteWarn": "When enabled, other devices on the LAN can reach this panel API.",
        "settings.readonlyUnavailable": "Config saving is unavailable in this runtime (read-only).",
        "settings.invalidValue": "Some values are out of range or not numeric; fix them before saving.",
        "import.reading": "Reading file…",
        "import.uploading": "Importing…",
        "import.tooLarge": "File exceeds 4 MB; split it before importing.",
        "import.readFailed": "Failed to read the file.",
        "import.smallDone": "Import finished: added {added} · skipped {skipped} · errors {errors}",
        "import.progress": "Importing {done}/{total} · added {added} · skipped {skipped} · errors {errors}",
        "import.done": "Import finished: added {added} · skipped {skipped} · errors {errors}",
        "import.failed": "Import failed",
        "import.total": "{total} lines",
        "import.button": "Import JSONL",
        "sync.button": "Sync with gateway",
        "sync.dryTitle": "Sync dry-run (nothing written)",
        "sync.pull": "Pull: +{added} / skipped {skipped} / errors {errors} / lines {lines}",
        "sync.push": "Push: {lines} lines",
        "sync.confirm": "Confirm sync",
        "sync.done": "Sync complete",
        "sync.busy": "Syncing…",
        "reflect.button": "Reflect",
        "reflect.done": "Reflected: +{added} (material {material})",
        "reflect.busy": "Reflecting…",
        "reflect.disabled": "Reflect disabled: enable reflect.enabled in settings",
        "import.export": "Export",
        "import.accept": ".jsonl,.txt,text/plain",
        "status.active": "Active",
        "status.archived": "Archived",
        "status.stale": "Stale",
        "status.superseded": "Superseded",
        "level.core": "Core",
        "level.important": "Important",
        "level.normal": "Normal",
        "type.semantic": "Semantic",
        "type.procedural": "Procedural",
        "type.episodic": "Episodic",
        "type.mixed": "Mixed",
        "source.owner": "Owner",
        "source.self": "Self",
        "source.group": "Group",
        "source.web": "Web",
        "source.tool": "Tool",
        "source.import": "Import",
        "err.network": "Network unreachable; confirm DSH is running.",
        "err.backend_unreachable": "Memory backend is unreachable.",
        "err.backend_unavailable": "Memory backend does not provide this capability.",
        "err.backend_error": "Memory backend returned an error.",
        "err.invalid_query": "Query must not be empty.",
        "err.invalid_text": "Text is invalid (1–500 chars).",
        "err.invalid_level": "Invalid level.",
        "err.invalid_memory_type": "Invalid memory type.",
        "err.invalid_tags": "Invalid tags.",
        "err.identity_required": "Identity keys are missing; cannot read or write.",
        "err.write_disabled": "Writes are disabled.",
        "err.duplicate": "Content already exists; skipped.",
        "err.node_not_found": "Memory node not found.",
        "err.job_not_found": "Import job not found.",
        "err.invalid_job_id": "Invalid import job id.",
        "err.config_save_unavailable": "Config saving is unavailable in this runtime (read-only).",
        "err.config_save_failed": "Failed to save configuration.",
        "err.invalid_config": "Invalid configuration.",
        "err.invalid_value": "A value is out of range.",
        "err.payload_too_large": "Request body too large (4 MB limit).",
        "err.invalid_jsonl": "Invalid JSONL content.",
        "err.method_not_allowed": "Method not allowed.",
        "err.not_found": "Endpoint not found.",
        "err.not_loopback": "Loopback access only.",
        "err.file_too_large": "File exceeds 4 MB; split it before importing.",
        "err.read_error": "Failed to read the file.",
        "err.unknown": "Unknown error.",
        "settings.groupIdentity": "Identity",
        "settings.groupReflect": "Reflection",
        "settings.groupConsolidate": "Consolidation",
        "settings.groupEmbed": "Embeddings",
        "settings.groupPrivacy": "Privacy",
        "settings.groupEdges": "Edges",
        "settings.groupSync": "Sync",
        "settings.groupDanger": "Danger zone",
        "settings.identityMode": "Identity mode",
        "settings.identityModeDesc": "auto derives identity from the host session; fixed uses the values below.",
        "settings.identityRoleIdDesc": "Empty means no role restriction.",
        "settings.identityWorkspaceDesc": "Empty means the current workspace.",
        "settings.reflectEnabledDesc": "Reflects and reorganizes memories when idle.",
        "settings.syncEnabledDesc": "Syncs memories with the gateway; the bridge URL is injected by the profile.",
        "settings.identityUserId": "userId",
        "settings.identityRoleId": "roleId",
        "settings.identityWorkspace": "workspace",
        "settings.identityAutoNote": "auto: userId is derived from the host session; currently falls back to \"local\".",
        "settings.identityFixedNote": "fixed: uses the values below; an empty userId makes reads and writes fail.",
        "settings.injectLevels": "Levels allowed in injection (comma separated)",
        "settings.injectLevelsDesc": "e.g. core,important; leave empty for no limit.",
        "settings.showSources": "Show sources in injected text",
        "settings.showSourcesDesc": "Append node sources to injected text.",
        "settings.dailyCap": "Daily write cap",
        "settings.dailyCapDesc": "Daily write count cap.",
        "settings.searchTtlHours": "Search-summary TTL (hours)",
        "settings.searchTtlHoursDesc": "TTL for search-summary memories.",
        "settings.judge": "Write judge",
        "settings.judgeDesc": "rules uses heuristics; llm calls a model.",
        "settings.ignorePatterns": "Ignore patterns (one per line)",
        "settings.ignorePatternsDesc": "Text matching any pattern is not written.",
        "settings.writeModel": "Write judge model (used when judge=llm)",
        "settings.writeModelDesc": "Empty means the current default model.",
        "settings.reflectModel": "Reflection model",
        "settings.reflectModelDesc": "Empty means the current default model.",
        "settings.idleMinutes": "Idle trigger (minutes)",
        "settings.idleMinutesDesc": "Triggered after the user is idle for this long.",
        "settings.maxItems": "Max items per run",
        "settings.maxItemsDesc": "Max new memories per reflection run.",
        "settings.maxRunsPerDay": "Max runs per day",
        "settings.maxRunsPerDayDesc": "Daily reflection run cap.",
        "settings.consolidateEnabled": "Enable consolidation",
        "settings.consolidateEnabledDesc": "Periodically merges duplicates and expired nodes.",
        "settings.consolidateInterval": "Consolidation interval (hours)",
        "settings.consolidateIntervalDesc": "Interval between consolidation runs.",
        "settings.embedEnabled": "Enable vector search",
        "settings.embedEnabledDesc": "Requires an external vector service; not wired by default here.",
        "settings.embedEndpoint": "Vector service endpoint",
        "settings.embedEndpointDesc": "Endpoint compatible with OpenAI embeddings.",
        "settings.embedModel": "Embedding model",
        "settings.embedModelDesc": "Embedding model name.",
        "settings.embedBatch": "Embedding batch size",
        "settings.embedBatchDesc": "Items per embedding batch.",
        "settings.embedNote": "No provider is wired on this machine; jobs return \"unavailable\" when enabled.",
        "settings.privacyRedact": "Redact before writing",
        "settings.privacyRedactDesc": "Sensitive fields are replaced before writing.",
        "settings.privacyRetention": "Archived retention days (0 = forever)",
        "settings.privacyRetentionDesc": "0 keeps archives forever.",
        "settings.privacyDanger": "retentionDays > 0 physically deletes expired archives.",
        "settings.edgesDiffusion": "Enable 1-hop edge diffusion",
        "settings.edgesDiffusionDesc": "Expands one hop along edges during recall.",
        "settings.edgesMinConf": "Minimum edge confidence",
        "settings.edgesMinConfDesc": "Edges below this confidence are not diffused.",
        "settings.syncMode": "Sync direction",
        "settings.syncModeDesc": "off disables; push/pull/both select directions.",
        "settings.syncInterval": "Sync interval (minutes)",
        "settings.syncIntervalDesc": "Interval for scheduled sync.",
        "settings.syncHttpTimeout": "Sync timeout (ms)",
        "settings.syncHttpTimeoutDesc": "HTTP timeout for sync requests.",
        "settings.syncBatch": "Sync batch size",
        "settings.syncBatchDesc": "Items per sync batch.",
        "settings.syncBridgeNote": "bridgeUrl is injected by the profile and is not edited here.",
        "settings.panelTab": "Default tab",
        "settings.panelTabDesc": "Tab selected when the panel opens.",
        "settings.pollMsDesc": "Auto-refresh interval on the overview tab.",
        "settings.allowRemoteDesc": "Only loopback access is allowed by default.",
        "settings.traceId": "traceId (trace marker)",
        "settings.traceIdDesc": "Trace marker for write audit and logs.",
        "settings.logLevelDesc": "Plugin log level.",
        "settings.workerDesc": "Search runs in a worker thread to avoid blocking the main thread.",
        "settings.exportMemory": "Export memory (download JSONL)",
        "settings.dangerNote": "No clear/reset endpoint is provided; this version has no destructive actions.",
        "settings.dataDir": "Data directory (read-only)",
        "settings.dataDirDesc": "Determined by the host profile.",
        "settings.readonlyTag": "read-only",
        "settings.effectInstant": "Instant",
        "settings.effectReload": "Reload",
        "settings.effectLabel": "Effect",
        "settings.savedButReloadFailed": "Saved, but reloading the config failed.",
        "settings.backendModeDesc": "Local SQLite by default; http/hybrid use the external service.",
        "settings.backendUrlDesc": "Only used when backend.mode is not local.",
        "settings.backendTimeoutDesc": "Per-request timeout for the external service.",
        "settings.recallEnabledDesc": "No memories are injected when disabled.",
        "settings.maxHitsDesc": "Max hits injected per recall.",
        "settings.charBudgetDesc": "注入本文の合計文字上限。0 = 注入オフ（どの記憶も注入されません）。",
        "settings.intentBudgetDesc": "Image-prompt intents get 0 injection.",
        "settings.minRelDesc": "Candidates below this relevance are filtered.",
        "settings.recallTimeoutDesc": "Recall fails open after timeout and does not block the turn.",
        "settings.writeEnabledDesc": "Writes and candidate review stop when disabled.",
        "settings.reviewModeDesc": "shadow records candidates only; auto writes directly.",
        "settings.maxCharsDesc": "Hard limit per memory text.",
        "settings.searchFeedDesc": "Search summaries are saved as memories.",
        "recall.explain": "Explainability",
        "recall.explainHint": "Expand to see score breakdown",
        "recall.colRel": "rel",
        "recall.colMult": "mult",
        "recall.colGain": "gain",
        "recall.colEffWeight": "effWeight",
        "recall.colPath": "Hit path",
        "recall.colMatched": "Matched terms",
        "recall.pathFallback": "L1/L2",
        "recall.belowMin": "{n} more candidates below the gate",
        "recall.noComponents": "This hit returned no score breakdown",
        "writes.pendingEmpty": "No pending candidates",
        "writes.edgesTitle": "Edge statistics",
        "writes.edgesEmpty": "No edges yet",
        "writes.evolutionTitle": "Recent evolution",
        "writes.evolutionEmpty": "No evolution records",
        "writes.colType": "Type",
        "writes.colCount": "Count",
        "writes.colFromTo": "Relation",
        "writes.colField": "Field",
        "memory.candidateQueued": "Added to the review queue (review it on the Writes tab)",
        "sync.disabled": "Sync disabled: enable sync.enabled in settings.",
        "header.identity": "Identity",
        "header.identityTip": "現在の記憶アイデンティティ：{workspace} / {userId} / {roleId}",
        "err.sync_disabled": "Sync is disabled (sync.enabled=false).",
        "err.sync_bridge_unset": "Sync bridge URL is not configured (the profile injects bridgeUrl).",
        "err.confirm_required": "A real sync requires confirm=true.",
        "err.invalid_direction": "Invalid sync direction (pull/push/both).",
        "err.busy": "A task of this kind is already running; try again later.",
        "err.reflect_unavailable": "The reflection scheduler is unavailable.",
        "err.candidate_not_found": "The pending candidate was not found.",
        "err.invalid_review": "Invalid review parameters.",
        "err.privacy": "The content triggered privacy rules and was not written.",
        "err.daily_cap": "The daily write cap has been reached.",
        "err.text_too_long": "Text exceeds the character limit.",
        "err.unknown_error": "Unknown error.",
        "err.network_error": "Network unreachable; confirm DSH is running.",
        "settings.defaultValue": "既定：{value}",
        "settings.defaultOn": "オン",
        "settings.defaultOff": "オフ",
        "settings.defaultEmpty": "空",
        "settings.badgeGeneral": "共通",
        "settings.badgeLocal": "ローカル",
        "settings.badgeNeedsConfig": "設定が必要",
        "settings.depUnmet": "依存条件を満たしていません：{reason}",
        "settings.depBackendUrl": "backend.mode が local 以外のときのみ有効",
        "settings.depWriteModel": "judge=llm のときのみ使用",
        "settings.depEmbed": "先にベクトル検索を有効にしてください",
        "settings.depSync": "先に同期を有効にしてください",
        "settings.depPanelRemote": "非ループバックアクセスを許可した場合のみ有効",
        "settings.effectDaily": "毎日",
        "settings.groupBackendDesc": "ローカル DB か外部メモリサービスかを選びます。外部サービスのみ URL とタイムアウトが必要です。",
        "settings.groupIdentityDesc": "各記憶が誰・どのワークスペースに属するかを決めます。auto はホストのセッションに従います。",
        "settings.groupRecallDesc": "毎ターンどれだけ・どの程度関連する・どの階層を注入するかを決め、回答の「記憶力」に直結します。",
        "settings.groupWriteDesc": "何を記憶するか、書き込み前の審査、1 件あたりと 1 日あたりの上限を決めます。",
        "settings.groupReflectDesc": "アイドル時にモデルへ記憶を整理させます。既定はオフで、モデルが必要です。",
        "settings.groupConsolidateDesc": "重複と期限切れノードを定期的に統合し、庫が無限に膨らむのを防ぎます。既定はオンです。",
        "settings.groupEmbedDesc": "外部ベクトルサービスで意味検索を行います。本機に無い場合はオフのままで構いません。",
        "settings.groupPrivacyDesc": "書き込み前のマスクとアーカイブ保持期間。期限切れは物理削除されます。",
        "settings.groupEdgesDesc": "召回時にリレーション辺を 1 ホップ辿り、低信頼の辺を除外します。",
        "settings.groupSyncDesc": "ゲートウェイと双方向で記憶を同期します。ブリッジ URL は profile が注入します。",
        "settings.groupPanelDesc": "このパネルの更新間隔・既定タブ・アクセス範囲です。",
        "settings.groupAdvancedDesc": "ログや検索スレッドなどのトラブルシュート項目。通常は変更不要です。",
        "settings.groupDangerDesc": "エクスポートの入口。この版にはクリア/リセット API が無いため破壊的ボタンは置きません。",
        "settings.backendId": "バックエンド ID",
        "settings.backendIdDesc": "サービス登録と障害調査用の固定識別子。ローカルモードでは空で構いません。",
        "settings.syncBridgeUrl": "同期ブリッジ URL",
        "settings.syncBridgeUrlDesc": "profile が注入します。手で変更した値は次回の設定読込で上書きされます。",
        "settings.syncDryRun": "同期の既定をドライランにする",
        "settings.syncDryRunDesc": "オンのときは差分比較のみでリモートに書きません。本実行はヘッダーで再確認が必要です。",
        "settings.charBudgetZeroConfirm": "charBudget=0 は注入を停止します：このターンはどの記憶も注入されません。保存しますか？",
        "settings.sectionLabel": "記憶ハブ",
        "header.backendStatus": "バックエンド：{mode} · プロトコル {protocol} · outbox {outbox}",
        "header.backendStatusTip": "GET /version より取得。利用できない場合は各項目が — になります",
        "header.protocolOk": "OK",
        "header.protocolMismatch": "非互換",
        "health.backend": "バックエンド",
        "health.protocol": "プロトコル",
        "health.outbox": "outbox",
        "overview.migrationTitle": "移行状態",
        "overview.migrationPending": "移行の確認待ち",
        "overview.migrationPendingDesc": "ID/データ移行が未確認です。設定タブで確認して保存してください。",
        "overview.migrationFrom": "移行元",
        "overview.migrationAt": "移行日時",
        "overview.openSettings": "設定へ",
        "overview.offlineBackendTitle": "外部サービス未接続",
        "overview.offlineBackendDesc": "バックエンドが http/hybrid ですが外部サービスの URL が空です。ワンクリックでローカル庫に戻せます。",
        "overview.switchLocal": "ローカルに切り替え",
        "overview.switchLocalDone": "ローカル庫に切り替えました",
        "overview.switchLocalFailed": "切り替え失敗",
        "memory.sampleTitle": "サンプル記憶",
        "memory.sampleDesc": "サンプル記憶を 3 件書き込みます。あとでワンクリックで片付けられます。",
        "memory.sampleWrite": "サンプルを書き込む",
        "memory.sampleCleanup": "サンプルを片付ける",
        "memory.sampleCleanupConfirm": "片付けはこの 3 件をアーカイブします（履歴は削除せず、監査は保持）。続行しますか？",
        "memory.sampleDone": "サンプル 3 件を書き込みました",
        "memory.sampleCandidate": "シャドーモードのためサンプルは審査待ちに入り、直接書き込まれていません",
        "memory.sampleCleaned": "サンプルをアーカイブしました",
        "memory.sample1": "Whale Memory は既定でローカル SQLite を使い、記憶をクラウドへ送りません。",
        "memory.sample2": "各ターンの開始前に、関連する記憶を少しだけ召回してコンテキストへ注入します。",
        "memory.sample3": "書き込みは既定で shadow 審査を通り、候補が監査に残り、承認後に記憶になります。",
        "recall.budgetTitle": "注入予算",
        "recall.budgetLine": "文字上限 {chars} · 最大 {hits} 件 · 意図枠 {intent}",
        "recall.budgetIntentOn": "オン",
        "recall.budgetIntentOff": "オフ",
        "recall.budgetZero": "0 文字 = 注入オフ（どの記憶も注入されません）",
        "recall.filterLabel": "絞り込み",
        "recall.filterAll": "すべて",
        "recall.filterUnused": "未採用",
        "recall.filterZero": "ゼロヒット",
        "recall.colSource": "ソース",
        "writes.rejectReason": "却下理由（任意）",
        "writes.rewrite": "本文の書き換え（任意）",
        "writes.rewriteHint": "空なら原文のまま承認。入力すると承認後にそのノード本文を書き換えます。",
        "writes.confirmReview": "審査を送信",
        "writes.reviewFormTitle": "候補を審査",
        "writes.actionAdd": "追加",
        "writes.actionNoop": "変更なし",
        "writes.actionMerge": "マージ",
        "writes.actionSupersede": "置換",
        "writes.actionReject": "却下",
        "writes.actionCandidate": "候補",
        "writes.oldValue": "旧値",
        "writes.newValue": "新値",
        "detail.origin": "証拠（origin）",
        "detail.originUnavailable": "提供なし",
        "detail.edges": "1 ホップ隣接辺",
        "detail.edgesUnavailable": "提供なし（/nodes/:id が edges を返していません）",
        "detail.edgesEmpty": "隣接辺なし",
        "detail.archiveConfirm": "アーカイブは取り消せません（監査は追跡可能）。この記憶をアーカイブしますか？",
        "detail.saveConfirm": "編集は本文を書き換え、監査記録を残します。保存しますか？",
        "header.rolePrefix": "ロール：{roleId}"
      }
    }
    // <<< locale:generated

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
      if (status === 403) return 'not_loopback'
      if (status === 404) return 'not_found'
      if (status === 409) return 'busy'
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
      return Object.keys(dict).some((lang) => Object.prototype.hasOwnProperty.call(dict[lang], key))
    }

    /** 二次确认：宿主无 window 时（测试/SSR）不阻断，视为确认。 */
    function askConfirm(message) {
      if (typeof window === 'undefined' || typeof window.confirm !== 'function') return true
      return window.confirm(message)
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

    // ------------------------------------------------------- observability
    // 概览观测块（指标卡 / 7 日曲线 / 最近失败）只依赖入参：数值→文案、结构→行。
    // test/client.test.mjs 直接抽取本标记块执行降级断言，因此这里不得引用 t()、css 或组件。
    // >>> observability:pure
    const METRIC_DIRECTIONS = {
      zero_injection_rate: 'lower',
      write_reject_rate: 'lower',
      pending_age_max_min: 'lower',
      idle_rate: 'lower',
      db_size_bytes: 'lower',
      adoption_rate: 'higher',
      job_success_7d: 'higher',
      precision_at_3: 'higher',
      ident_hit_rate: 'higher',
    }

    function safeNumber(value) {
      if (value === null || value === undefined || value === '') return null
      const n = Number(value)
      return Number.isFinite(n) ? n : null
    }

    /** 比例统一到 0–1（后端约定为 0–1，也接受已经乘过 100 的旧口径）。 */
    function ratioOrNull(value) {
      const n = safeNumber(value)
      if (n === null || n < 0) return null
      return n > 1 && n <= 100 ? n / 100 : n
    }

    function fmtPercent(value, locale) {
      const ratio = ratioOrNull(value)
      if (ratio === null) return '—'
      try {
        return new Intl.NumberFormat(localeTag(locale), {
          style: 'percent', maximumFractionDigits: 1,
        }).format(ratio)
      } catch {
        return (Math.round(ratio * 1000) / 10) + '%'
      }
    }

    /** 库大小人类可读：B/KB/MB/GB，缺值返回「—」。 */
    function fmtBytes(value) {
      const n = safeNumber(value)
      if (n === null || n < 0) return '—'
      const units = ['B', 'KB', 'MB', 'GB', 'TB']
      let scaled = n
      let unit = 0
      while (scaled >= 1024 && unit < units.length - 1) {
        scaled /= 1024
        unit += 1
      }
      const shown = unit === 0 ? Math.round(scaled) : scaled >= 100 ? Math.round(scaled) : Math.round(scaled * 10) / 10
      return shown + ' ' + units[unit]
    }

    /** 'met' | 'missed' | null：缺值或缺目标时不给判断，宁可不显示。 */
    function targetState(name, value, target) {
      const got = safeNumber(value)
      const goal = safeNumber(target)
      if (got === null || goal === null) return null
      const direction = METRIC_DIRECTIONS[name] === 'lower' ? 'lower' : 'higher'
      if (direction === 'lower') return got <= goal ? 'met' : 'missed'
      return got >= goal ? 'met' : 'missed'
    }

    function barPercent(ratio) {
      const n = safeNumber(ratio)
      if (n === null || n <= 0) return '0%'
      return Math.min(100, Math.round(n * 100)) + '%'
    }

    function dayKey(value) {
      const d = value instanceof Date ? value : new Date(value === undefined ? Date.now() : value)
      if (Number.isNaN(d.getTime())) return ''
      const mm = String(d.getMonth() + 1).padStart(2, '0')
      const dd = String(d.getDate()).padStart(2, '0')
      return d.getFullYear() + '-' + mm + '-' + dd
    }

    /** series → 每行展示数据；今天按 day 匹配（契约保证最后一项是今天，无法匹配时取末项）。 */
    function trendPoints(series, today) {
      if (!Array.isArray(series)) return []
      const rows = []
      for (const raw of series) {
        if (!raw || typeof raw !== 'object') continue
        const day = raw.day === null || raw.day === undefined ? '' : String(raw.day)
        const recalls = safeNumber(raw.recalls)
        const withHits = safeNumber(raw.withHits)
        const injected = safeNumber(raw.injected)
        rows.push({
          key: day || 'row-' + rows.length,
          day,
          label: day.length >= 10 ? day.slice(5) : day || '—',
          recalls,
          withHits,
          injected,
          adopted: safeNumber(raw.adopted),
          zeroHit: safeNumber(raw.zeroHit),
          injectRatio: withHits && withHits > 0 && injected !== null ? injected / withHits : 0,
          zeroRatio: recalls && recalls > 0 && safeNumber(raw.zeroHit) !== null ? safeNumber(raw.zeroHit) / recalls : 0,
        })
      }
      const matched = today ? rows.findIndex((row) => row.day === today) : -1
      const todayIndex = matched >= 0 ? matched : rows.length - 1
      rows.forEach((row, index) => { row.isToday = index === todayIndex })
      return rows
    }

    /** health.jobs → 失败行；旧后端没有该字段时返回空数组，不报错。 */
    function failureRows(jobs, limit) {
      const list = jobs && Array.isArray(jobs.recent_failures) ? jobs.recent_failures : []
      const max = safeNumber(limit) || 5
      const rows = []
      for (const raw of list) {
        if (!raw || typeof raw !== 'object') continue
        const error = raw.last_error === null || raw.last_error === undefined ? '' : String(raw.last_error)
        rows.push({
          key: raw.id === null || raw.id === undefined || raw.id === '' ? 'fail-' + rows.length : String(raw.id),
          id: raw.id === null || raw.id === undefined ? '' : String(raw.id),
          kind: raw.kind === null || raw.kind === undefined || raw.kind === '' ? '—' : String(raw.kind),
          state: raw.state === null || raw.state === undefined ? '' : String(raw.state),
          attempts: safeNumber(raw.attempts),
          error,
          errorShort: error.length > 120 ? error.slice(0, 117) + '…' : error,
          at: raw.updated_at === undefined ? null : raw.updated_at,
        })
        if (rows.length >= max) break
      }
      return rows
    }
    // <<< observability:pure

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

    /** 页头身份徽标用短 id：保留尾部 8 位，避免长 user_id 撑爆标题栏。 */
    function shortId(value) {
      const s = String(value || '').trim()
      if (!s) return ''
      return s.length > 10 ? '…' + s.slice(-8) : s
    }

    // >>> backend-status:pure
    /**
     * 页头后端状态：`GET /version` → `{mode, protocol{ok,expected}, outbox}`。
     * 兼容 Host 尚未提供 /version 的形态（字段缺失即 null，UI 显示「—」），
     * 因此测试可直接抽取本块运行，不依赖 React 或 t()。
     */
    function backendStatusView(body) {
      const b = body && typeof body === 'object' ? body : {}
      const nest = b.backend && typeof b.backend === 'object' ? b.backend : {}
      const rawMode = b.mode ?? nest.mode ?? b.backendMode ?? b.backend_mode
      const mode = typeof rawMode === 'string' && rawMode.trim() ? rawMode.trim() : null
      const proto = b.protocol && typeof b.protocol === 'object'
        ? b.protocol
        : (b.protocolStatus && typeof b.protocolStatus === 'object' ? b.protocolStatus : null)
      let protocol = null
      if (proto) {
        if (proto.ok === true) protocol = 'ok'
        else if (proto.ok === false || proto.mismatch) protocol = 'mismatch'
      } else if (typeof b.protocol === 'string') {
        const expected = typeof b.expected === 'string' ? b.expected : ''
        protocol = expected ? (b.protocol === expected ? 'ok' : 'mismatch') : 'ok'
      } else if (b.protocol_ok === true) protocol = 'ok'
      else if (b.protocol_ok === false) protocol = 'mismatch'
      const box = b.outbox && typeof b.outbox === 'object' ? b.outbox : null
      const rawOutbox = box
        ? (box.queued ?? box.pending ?? box.n ?? (Number(box.running || 0) + Number(box.queued || 0)))
        : b.outbox
      const outboxNum = Number(rawOutbox)
      const outbox = Number.isFinite(outboxNum) && outboxNum >= 0 ? outboxNum : null
      return { checked: true, mode, protocol, outbox }
    }
    // <<< backend-status:pure

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

    /** 写入决策 action 本地化：ADD/NOOP/MERGE/SUPERSEDE/REJECT/CANDIDATE。 */
    const WRITE_ACTION_KEYS = {
      ADD: 'writes.actionAdd',
      NOOP: 'writes.actionNoop',
      MERGE: 'writes.actionMerge',
      SUPERSEDE: 'writes.actionSupersede',
      REJECT: 'writes.actionReject',
      CANDIDATE: 'writes.actionCandidate',
    }

    function actionLabel(t, value) {
      const key = WRITE_ACTION_KEYS[String(value || '').toUpperCase()]
      return key ? t(key) : (value || '—')
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
      const { checked, onChange, label, id, describedBy, disabled } = props
      return h('label', { style: css.switchRow, htmlFor: id },
        h('input', {
          id, type: 'checkbox', checked: Boolean(checked), disabled: Boolean(disabled),
          style: css.checkbox, 'aria-describedby': describedBy,
          onChange: (e) => onChange(e.target.checked),
        }),
        h('span', { style: css.switchLabel }, label))
    }

    function TextInput(props) {
      const { id, value, onChange, placeholder, describedBy, disabled, type } = props
      return h('input', {
        id, style: css.input, type: type || 'text',
        value: value === null || value === undefined ? '' : String(value),
        placeholder: placeholder || '', disabled: Boolean(disabled),
        'aria-describedby': describedBy,
        onChange: (e) => onChange(e.target.value),
      })
    }

    function NumberInput(props) {
      const { id, value, min, max, step, onChange, describedBy, disabled } = props
      return h('input', {
        id, style: css.input, type: 'number',
        value: value === undefined || value === null ? '' : value,
        min, max, step: step || 1, disabled: Boolean(disabled),
        'aria-describedby': describedBy,
        onChange: (e) => onChange(e.target.value === '' ? '' : Number(e.target.value)),
      })
    }

    function SelectInput(props) {
      const { id, value, options, onChange, describedBy, disabled } = props
      return h('select', {
        id, style: css.select, value, disabled: Boolean(disabled),
        'aria-describedby': describedBy,
        onChange: (e) => onChange(e.target.value),
      }, options.map(([v, l]) => h('option', { key: v, value: v }, l)))
    }

    function TextAreaInput(props) {
      const { id, value, onChange, placeholder, describedBy, disabled, rows } = props
      return h('textarea', {
        id, style: css.textarea, rows: rows || 3,
        value: value === null || value === undefined ? '' : String(value),
        placeholder: placeholder || '', disabled: Boolean(disabled),
        'aria-describedby': describedBy,
        onChange: (e) => onChange(e.target.value),
      })
    }

    function TextField(props) {
      const { label } = props
      return h('label', { style: css.field },
        h('span', { style: css.fieldLabel }, label),
        h(TextInput, props))
    }

    function NumField(props) {
      const { label } = props
      return h('label', { style: css.field },
        h('span', { style: css.fieldLabel }, label),
        h(NumberInput, props))
    }

    function SelectField(props) {
      const { label } = props
      return h('label', { style: css.field },
        h('span', { style: css.fieldLabel }, label),
        h(SelectInput, props))
    }

    /** 设置卡公共副行：默认值 + 通用/本机/需配置徽标；依赖不满足时给出原因。 */
    function SettingMetaLine(props) {
      const { defaultValue, badge, depReason } = props
      if (!defaultValue && !badge && !depReason) return null
      return h('div', { style: css.settingMeta },
        defaultValue ? h('span', null, defaultValue) : null,
        badge ? h('span', { style: css.badgeChip }, badge) : null,
        depReason ? h('span', { style: css.metaDep, role: 'note' }, depReason) : null)
    }

    /**
     * 设置项卡片：标签 + 说明小字 + 生效方式徽标 + 默认值 + 依赖；danger 用红框标出不可逆项。
     * 说明文字用 aria-describedby 与控件关联（无障碍）。
     */
    function SwitchCard(props) {
      const {
        id, label, desc, note, effect, danger, checked, onChange,
        disabled, defaultValue, badge, depReason, dependsOn,
      } = props
      const descId = (desc || note) ? id + '-desc' : undefined
      const locked = Boolean(disabled) || Boolean(depReason)
      return h('div', {
        style: danger ? css.settingCardDanger : (locked ? css.settingCardLocked : css.settingCard),
        'aria-disabled': locked || undefined,
      },
      h('div', { style: css.settingHead },
        h(Switch, { id, label, checked, onChange, disabled: locked, describedBy: descId }),
        effect ? h('span', { style: css.effectBadge, title: effect }, effect) : null),
      (desc || note)
        ? h('div', { id: descId, style: css.fieldDesc }, [desc, note].filter(Boolean).join(' '))
        : null,
      h(SettingMetaLine, { defaultValue, badge, depReason }))
    }

    /**
     * 字段卡片：children 可以是元素，也可以是 (describedBy) => 元素，保证控件与说明关联。
     */
    function FieldCard(props) {
      const {
        id, label, desc, note, effect, danger, children,
        disabled, defaultValue, badge, depReason, dependsOn,
      } = props
      const descId = (desc || note) ? id + '-desc' : undefined
      const locked = Boolean(disabled) || Boolean(depReason)
      return h('div', {
        style: danger ? css.settingCardDanger : (locked ? css.settingCardLocked : css.settingCard),
        'aria-disabled': locked || undefined,
      },
      h('label', { style: css.field, htmlFor: id },
        h('div', { style: css.settingHead },
          h('span', { style: css.fieldLabel }, label),
          effect ? h('span', { style: css.effectBadge, title: effect }, effect) : null),
        typeof children === 'function' ? children(descId) : children),
      (desc || note)
        ? h('div', { id: descId, style: css.fieldDesc }, [desc, note].filter(Boolean).join(' '))
        : null,
      h(SettingMetaLine, { defaultValue, badge, depReason }))
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
      const [identity, setIdentity] = useState(null)
      const [caps, setCaps] = useState(null)
      const [importState, setImportState] = useState(null)
      const [opState, setOpState] = useState(null)
      const [backendCfg, setBackendCfg] = useState({ mode: '', url: '' })
      const [backendStatus, setBackendStatus] = useState({ checked: false, protocol: null, outbox: null })
      const [recallCfg, setRecallCfg] = useState(null)
      const [switchLocal, setSwitchLocal] = useState(null)
      const fileRef = useRef(null)

      useEffect(() => {
        let alive = true
        callJson('/config').then((body) => {
          const cfg = (body && body.config) || {}
          if (!alive) return
          const value = Number(cfg.panel && cfg.panel.pollMs)
          if (Number.isFinite(value) && value > 0) setPollMs(value)
          setIdentity({
            userId: String((cfg.identity && cfg.identity.userId) || ''),
            roleId: String((cfg.identity && cfg.identity.roleId) || ''),
            workspace: String((cfg.identity && cfg.identity.workspace) || ''),
          })
          setCaps({
            syncEnabled: cfg.sync ? cfg.sync.enabled === true : true,
            reflectEnabled: cfg.reflect ? cfg.reflect.enabled === true : true,
          })
          setBackendCfg({
            mode: String((cfg.backend && cfg.backend.mode) || ''),
            url: String((cfg.backend && cfg.backend.url) || ''),
          })
          setRecallCfg({
            charBudget: Number(cfg.recall && cfg.recall.charBudget),
            maxHits: Number(cfg.recall && cfg.recall.maxHits),
            intentBudget: cfg.recall ? cfg.recall.intentBudget !== false : true,
          })
          const wanted = String((cfg.panel && cfg.panel.tab) || '')
          if (TABS.some(([key]) => key === wanted)) setTab(wanted)
        }).catch(() => { /* 面板轮询回退默认值 */ })
        return () => { alive = false }
      }, [])

      // 后端状态：GET /version 由 Host 提供；缺失/失败时页头按「—」降级，不阻断面板。
      useEffect(() => {
        let alive = true
        callJson('/version').then((body) => {
          if (alive) setBackendStatus(backendStatusView(body))
        }).catch(() => {
          if (alive) setBackendStatus({ checked: true, protocol: null, outbox: null })
        })
        return () => { alive = false }
      }, [version])

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
        if (draft && draft.identity) {
          setIdentity({
            userId: String(draft.identity.userId || ''),
            workspace: String(draft.identity.workspace || ''),
          })
        }
        if (draft && draft.sync) {
          setCaps({
            syncEnabled: draft.sync.enabled === true,
            reflectEnabled: Boolean(draft.reflect && draft.reflect.enabled === true),
          })
        }
        if (draft && draft.identity) {
          setIdentity({
            userId: String(draft.identity.userId || ''),
            roleId: String(draft.identity.roleId || ''),
            workspace: String(draft.identity.workspace || ''),
          })
        }
        if (draft && draft.backend) {
          setBackendCfg({
            mode: String(draft.backend.mode || ''),
            url: String(draft.backend.url || ''),
          })
        }
        if (draft && draft.recall) {
          setRecallCfg({
            charBudget: Number(draft.recall.charBudget),
            maxHits: Number(draft.recall.maxHits),
            intentBudget: draft.recall.intentBudget !== false,
          })
        }
        // panel.tab 是「即时」项：保存后当前面板立刻切过去（否则只有重挂才生效）。
        const wantedTab = draft && draft.panel ? String(draft.panel.tab || '') : ''
        if (TABS.some(([key]) => key === wantedTab)) setTab(wantedTab)
      }

      // 后端未配置（http/hybrid 但 url 为空）的一键兜底：只提交 backend.mode 叶子。
      const onSwitchLocal = async () => {
        setSwitchLocal({ status: 'saving' })
        try {
          await callJson('/config', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ config: { backend: { mode: 'local' } } }),
          })
          setBackendCfg((prev) => ({ ...prev, mode: 'local' }))
          setSwitchLocal({ status: 'ok' })
          setVersion((v) => v + 1)
        } catch (err) {
          setSwitchLocal({ status: 'error', code: (err && err.code) || 'unknown_error' })
        }
      }

      const runSyncDry = async () => {
        setOpState({ kind: 'sync', phase: 'busy' })
        try {
          const body = await callJson('/sync', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ direction: 'both', dryRun: true }),
          })
          setOpState({ kind: 'sync', phase: 'dry', body })
        } catch (err) { setOpState({ kind: 'sync', phase: 'error', code: (err && err.code) || 'unknown_error' }) }
      }
      const runSyncReal = async () => {
        setOpState({ kind: 'sync', phase: 'busy' })
        try {
          const body = await callJson('/sync', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ direction: 'both', dryRun: false, confirm: true }),
          })
          setOpState({ kind: 'sync', phase: 'done', body })
          setVersion((v) => v + 1)
        } catch (err) { setOpState({ kind: 'sync', phase: 'error', code: (err && err.code) || 'unknown_error' }) }
      }
      const runReflect = async () => {
        setOpState({ kind: 'reflect', phase: 'busy' })
        try {
          const body = await callJson('/reflect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
          setOpState({ kind: 'reflect', phase: 'done', body })
          setVersion((v) => v + 1)
        } catch (err) { setOpState({ kind: 'reflect', phase: 'error', code: (err && err.code) || 'unknown_error' }) }
      }

      const viewProps = { t, locale, version, refreshKey: version }
      const overviewProps = {
        ...viewProps, pollMs, backendMode: backendCfg.mode, backendUrl: backendCfg.url,
        backendStatus, recallCfg, switchLocal,
        onSwitchLocal, onOpenSettings: () => setTab('settings'),
      }
      let view
      if (tab === 'memory') {
        view = h(MemoryTab, {
          ...viewProps,
          onImport: () => { if (fileRef.current) fileRef.current.click() },
          onOpenSettings: () => setTab('settings'),
        })
      } else if (tab === 'recall') view = h(RecallTab, { ...viewProps, recallCfg })
      else if (tab === 'writes') view = h(WritesTab, viewProps)
      else if (tab === 'settings') view = h(SettingsTab, { t, locale, onSaved })
      else view = h(Overview, overviewProps)

      let opCard = null
      if (opState) {
        const close = () => setOpState(null)
        if (opState.phase === 'dry') {
          const pull = (opState.body && opState.body.pull) || {}
          const push = (opState.body && opState.body.push) || {}
          opCard = h(Card, null,
            h('div', { style: css.cardTitle }, t('sync.dryTitle')),
            h('div', { style: css.muted }, t('sync.pull', {
              added: fmtNum(pull.added, locale), skipped: fmtNum(pull.skipped, locale),
              errors: fmtNum(pull.errors, locale), lines: fmtNum(pull.lines, locale),
            })),
            h('div', { style: css.muted }, t('sync.push', { lines: fmtNum(push.lines, locale) })),
            h('div', { style: css.actions },
              h('button', { style: css.buttonPrimary, onClick: runSyncReal }, t('sync.confirm')),
              h('button', { style: css.button, onClick: close }, t('common.close'))))
        } else if (opState.phase === 'done') {
          const pull = (opState.body && opState.body.pull) || {}
          opCard = h(Card, null,
            h('div', { style: css.ok }, opState.kind === 'reflect'
              ? t('reflect.done', { added: fmtNum(opState.body && opState.body.result && opState.body.result.added, locale),
                material: fmtNum(opState.body && opState.body.result && opState.body.result.material, locale) })
              : t('sync.done')),
            opState.kind === 'sync' ? h('div', { style: css.muted }, t('sync.pull', {
              added: fmtNum(pull.added, locale), skipped: fmtNum(pull.skipped, locale),
              errors: fmtNum(pull.errors, locale), lines: fmtNum(pull.lines, locale),
            })) : null,
            h('button', { style: css.button, onClick: close }, t('common.close')))
        } else if (opState.phase === 'error') {
          opCard = h(Card, null,
            h('div', { style: css.error }, errText(t, { code: opState.code })),
            h('button', { style: css.button, onClick: close }, t('common.close')))
        }
      }

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

      const syncBusy = Boolean(opState && opState.kind === 'sync' && opState.phase === 'busy')
      const reflectBusy = Boolean(opState && opState.kind === 'reflect' && opState.phase === 'busy')
      const syncDisabled = Boolean(caps) && !caps.syncEnabled
      const reflectDisabled = Boolean(caps) && !caps.reflectEnabled
      const identityLabel = identity
        ? [
          identity.workspace,
          shortId(identity.userId),
          identity.roleId ? t('header.rolePrefix', { roleId: identity.roleId }) : '',
        ].filter(Boolean).join(' · ')
        : ''
      const protocolText = backendStatus && backendStatus.protocol === 'ok'
        ? t('header.protocolOk')
        : backendStatus && backendStatus.protocol === 'mismatch'
          ? t('header.protocolMismatch')
          : t('common.dash')
      const outboxText = backendStatus && backendStatus.outbox !== null && backendStatus.outbox !== undefined
        ? fmtNum(backendStatus.outbox, locale)
        : t('common.dash')
      const modeText = (backendStatus && backendStatus.mode) || backendCfg.mode || t('common.dash')
      const statusWarn = Boolean(backendStatus && backendStatus.protocol === 'mismatch')

      return h('div', { style: css.panel },
        h('header', { style: css.header },
          h('div', { style: css.headerText },
            h('div', { style: css.title }, t('meta.title')),
            h('div', { style: css.desc }, t('meta.description')),
            h('div', {
              style: statusWarn ? { ...css.backendStatus, ...css.backendStatusWarn } : css.backendStatus,
              title: t('header.backendStatusTip'),
            }, t('header.backendStatus', { mode: modeText, protocol: protocolText, outbox: outboxText })),
            identityLabel
              ? h('div', {
                style: css.identityBadge,
                title: t('header.identityTip', {
                  workspace: (identity && identity.workspace) || '—',
                  userId: (identity && identity.userId) || '—',
                  roleId: (identity && identity.roleId) || '—',
                }),
              },
              h('span', { style: css.identityDot }),
              identityLabel)
              : null),
          h('div', { style: css.actions },
            h('button', { style: css.buttonPrimary, onClick: () => { if (fileRef.current) fileRef.current.click() } },
              t('import.button')),
            h('button', {
              style: syncDisabled || syncBusy ? css.buttonDisabled : css.button,
              disabled: syncDisabled || syncBusy,
              title: syncDisabled ? t('sync.disabled') : undefined,
              onClick: runSyncDry,
            }, syncBusy ? t('sync.busy') : t('sync.button')),
            h('button', {
              style: reflectDisabled || reflectBusy ? css.buttonDisabled : css.button,
              disabled: reflectDisabled || reflectBusy,
              title: reflectDisabled ? t('reflect.disabled') : undefined,
              onClick: runReflect,
            }, reflectBusy ? t('reflect.busy') : t('reflect.button')),
            h('a', { style: css.linkButton, href: API + '/export', download: 'whale-memory.jsonl' }, t('import.export')),
            h('button', { style: css.button, onClick: () => setVersion((v) => v + 1) }, t('common.refresh')),
            h('input', {
              ref: fileRef, type: 'file', accept: t('import.accept'),
              style: { display: 'none' }, onChange: onFile,
            }))),
        opCard,
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
      const {
        t, locale, pollMs, version,
        backendMode, backendUrl, backendStatus, switchLocal, onSwitchLocal, onOpenSettings,
      } = props
      const visible = useVisible()
      const [stats, setStats] = useState(null)
      const [statsErr, setStatsErr] = useState(null)
      const [meta, setMeta] = useState({ identity: null, migration: null })
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
              setMeta({
                identity: (body && body.identity) || null,
                migration: (body && body.migration) || null,
              })
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
      const health = (s && s.health) || {}
      const pending = pick(health.vector_pending, s.pending, s.vector_pending, totals.pending)
      const jobsInfo = health.jobs && typeof health.jobs === 'object' ? health.jobs : null
      let jobText = '—'
      if (jobsInfo) {
        const running = Number(jobsInfo.running || 0)
        const queued = Number(jobsInfo.queued || 0)
        const failed = Number(jobsInfo.failed || 0)
        jobText = running > 0
          ? t('health.running') + ' ' + running + '/' + (running + queued)
          : t('health.idle') + (failed > 0 ? ' · ' + failed + ' !' : '')
      } else {
        const jobRaw = pick(s.active_job, s.jobs, totals.jobs)
        if (typeof jobRaw === 'number') jobText = fmtNum(jobRaw, locale)
        else if (jobRaw && typeof jobRaw === 'object' && jobRaw.state) {
          jobText = String(jobRaw.state) === 'running' ? t('health.running') : String(jobRaw.state)
        }
      }

      const today = recalls.status === 'ok' ? todayRecalls(recalls.items) : null
      const recallKpi = pick(totals.recalls_today, today && today.count)
      const injected = pick(totals.injected_chars_today, today && today.chars)
      const offline = Boolean(statsErr)
      const dbTone = offline ? 'error' : health.fts_aligned === false ? 'warn' : stats ? 'ok' : 'muted'

      // 观测块：后端契约 metrics{values,targets} / series[] / health.jobs.recent_failures；
      // 任何一段缺失都降级为「—」或空态，绝不在渲染里出现 NaN/undefined。
      const metrics = s.metrics && typeof s.metrics === 'object' ? s.metrics : null
      const metricValues = metrics && metrics.values && typeof metrics.values === 'object' ? metrics.values : null
      const metricTargets = metrics && metrics.targets && typeof metrics.targets === 'object' ? metrics.targets : null
      const metricValue = (name) => (metricValues ? metricValues[name] : undefined)
      const metricSub = (name) => {
        const state = targetState(name, metricValue(name), metricTargets ? metricTargets[name] : undefined)
        if (state === null) return null
        const goal = name === 'db_size_bytes' ? fmtBytes(metricTargets[name]) : fmtPercent(metricTargets[name], locale)
        return h('span', { style: state === 'met' ? css.ok : css.warn },
          t(state === 'met' ? 'overview.targetMet' : 'overview.targetMissed', { target: goal }))
      }
      const trendRows = trendPoints(s.series, dayKey())
      const failures = failureRows(jobsInfo, 5)

      // 后端状态：/version（页头同源）优先，缺值时回落到 /stats.outbox。
      const protoText = backendStatus && backendStatus.protocol === 'ok'
        ? t('header.protocolOk')
        : backendStatus && backendStatus.protocol === 'mismatch'
          ? t('header.protocolMismatch')
          : t('common.dash')
      const statsOutbox = s.outbox && typeof s.outbox === 'object'
        ? (Number(s.outbox.queued || 0) + Number(s.outbox.running || 0))
        : s.outbox
      const outboxRaw = backendStatus && backendStatus.outbox !== null && backendStatus.outbox !== undefined
        ? backendStatus.outbox
        : statsOutbox
      const outboxText = outboxRaw === null || outboxRaw === undefined ? t('common.dash') : fmtNum(outboxRaw, locale)
      const modeText = (backendStatus && backendStatus.mode) || backendMode || t('common.dash')

      // 迁移只读视图：/stats.migration{migratedFrom,migratedAt,pending}。
      const migration = meta.migration
      const migrationKnown = Boolean(migration && (migration.pending || migration.migratedFrom || migration.migratedAt))
      const migrationPending = Boolean(migration && migration.pending)
      const identityView = meta.identity
      const offlineBackend = Boolean(backendMode && backendMode !== 'local' && !backendUrl)

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
        offlineBackend ? h(Card, null,
          h('div', { style: css.cardTitle }, t('overview.offlineBackendTitle')),
          h('div', { style: css.note }, t('overview.offlineBackendDesc')),
          switchLocal && switchLocal.status === 'ok'
            ? h('div', { style: css.ok }, t('overview.switchLocalDone'))
            : h('div', { style: css.inline },
              h('button', {
                style: switchLocal && switchLocal.status === 'saving' ? css.buttonDisabled : css.buttonPrimary,
                disabled: Boolean(switchLocal && switchLocal.status === 'saving'),
                onClick: onSwitchLocal,
              }, switchLocal && switchLocal.status === 'saving' ? t('common.saving') : t('overview.switchLocal'))),
          switchLocal && switchLocal.status === 'error'
            ? h('div', { style: css.error }, t('overview.switchLocalFailed') + ' — ' + errText(t, { code: switchLocal.code }))
            : null) : null,
        migrationKnown ? h(Card, null,
          h(SectionTitle, null, t('overview.migrationTitle')),
          migrationPending
            ? h('div', { style: css.warnBox }, t('overview.migrationPending') + ' — ' + t('overview.migrationPendingDesc'))
            : null,
          h('div', { style: css.metaGrid },
            h(Row, { k: t('overview.migrationFrom'), v: pick(migration && migration.migratedFrom) || '—' }),
            h(Row, { k: t('overview.migrationAt'), v: fmtTime(migration && migration.migratedAt, locale) })),
          migrationPending && onOpenSettings
            ? h('div', { style: css.inline },
              h('button', { style: css.buttonPrimary, onClick: onOpenSettings }, t('overview.openSettings')))
            : null) : null,
        h('div', { style: css.kpiGrid },
          h(Kpi, { label: t('overview.kpiNodes'), value: fmtNum(nodesTotal, locale) }),
          h(Kpi, { label: t('overview.kpiActive'), value: fmtNum(nodesActive, locale) }),
          h(Kpi, {
            label: t('overview.kpiRecalls'),
            value: fmtNum(recallKpi, locale),
            sub: injected !== null ? t('overview.injected', { n: fmtNum(injected, locale) }) : '—',
          }),
          h(Kpi, { label: t('overview.kpiEdges'), value: fmtNum(edges, locale) }),
          h(Kpi, {
            label: t('overview.kpiZeroInjection'),
            value: fmtPercent(metricValue('zero_injection_rate'), locale),
            sub: metricSub('zero_injection_rate'),
          }),
          h(Kpi, {
            label: t('overview.kpiAdoption'),
            value: fmtPercent(metricValue('adoption_rate'), locale),
            sub: metricSub('adoption_rate'),
          }),
          h(Kpi, {
            label: t('overview.kpiJobSuccess'),
            value: fmtPercent(metricValue('job_success_7d'), locale),
            sub: metricSub('job_success_7d'),
          }),
          h(Kpi, {
            label: t('overview.kpiDbSize'),
            value: fmtBytes(metricValue('db_size_bytes')),
            sub: metricSub('db_size_bytes'),
          })),
        h(Card, null,
          h(SectionTitle, null, t('overview.trend')),
          h('div', { style: css.trendLegend },
            h('span', { style: css.legendItem },
              h('span', { style: css.legendDotBrand }),
              t('overview.trendInjected')),
            h('span', { style: css.legendItem },
              h('span', { style: css.legendDotWarn }),
              t('overview.trendZeroHit'))),
          trendRows.length === 0
            ? h('div', { style: css.tertiary }, t('overview.trendEmpty'))
            : h('div', { style: css.trendScroll },
              h('div', { style: css.trendList }, trendRows.map((row) => h('div', {
                key: row.key,
                style: css.trendRow,
                title: t('overview.trendTip', {
                  day: row.day || '—',
                  recalls: fmtNum(row.recalls, locale),
                  withHits: fmtNum(row.withHits, locale),
                  injected: fmtNum(row.injected, locale),
                  adopted: fmtNum(row.adopted, locale),
                  zeroHit: fmtNum(row.zeroHit, locale),
                }),
              },
              h('div', { style: css.trendDay },
                h('span', null, row.label),
                row.isToday ? h('span', { style: css.trendToday }, t('overview.trendToday')) : null),
              h('div', { style: css.trendBars },
                h('div', { style: css.trendBarLine },
                  h('span', { style: css.barTrack },
                    h('span', { style: { ...css.barFillBrand, width: barPercent(row.injectRatio) } })),
                  h('span', { style: css.trendPct }, fmtPercent(row.injectRatio, locale))),
                h('div', { style: css.trendBarLine },
                  h('span', { style: css.barTrack },
                    h('span', { style: { ...css.barFillWarn, width: barPercent(row.zeroRatio) } })),
                  h('span', { style: css.trendPct }, fmtPercent(row.zeroRatio, locale))))))))),
        h(Card, null,
          h(SectionTitle, null, t('overview.health')),
          h('div', { style: css.healthRow },
            h(HealthPill, { label: t('health.db'), value: offline ? t('health.offline') : stats ? t('health.ok') : '—', tone: dbTone }),
            h(HealthPill, { label: t('health.backend'), value: modeText, tone: modeText === '—' ? 'muted' : 'ok' }),
            h(HealthPill, {
              label: t('health.protocol'), value: protoText,
              tone: !backendStatus || backendStatus.protocol === null ? 'muted'
                : backendStatus.protocol === 'ok' ? 'ok' : 'error',
            }),
            h(HealthPill, { label: t('health.outbox'), value: outboxText, tone: outboxText === '—' ? 'muted' : 'warn' }),
            h(HealthPill, { label: t('health.migration'), value: schemaVersion !== null ? 'v' + String(schemaVersion) : '—', tone: schemaVersion !== null ? 'ok' : 'muted' }),
            h(HealthPill, { label: t('health.pending'), value: pending !== null ? fmtNum(pending, locale) : '—', tone: pending !== null ? 'warn' : 'muted' }),
            h(HealthPill, { label: t('health.job'), value: jobText, tone: jobText === '—' ? 'muted' : 'warn' })),
          identityView
            ? h('div', { style: css.tertiary },
              t('header.identity') + ': '
              + [identityView.workspace, identityView.userId, identityView.roleId].filter(Boolean).join(' · '))
            : null,
          h('div', { style: css.tertiary }, t('overview.refreshed', { time: fmtTime(Date.now(), locale) }))),
        jobsInfo ? h(Card, null,
          h(SectionTitle, null, t('overview.failures')),
          failures.length === 0
            ? h('div', { style: css.tertiary }, t('overview.failuresEmpty'))
            : h('div', { style: css.stack }, failures.map((row) => h('div', { key: row.key, style: css.failureRow },
              h('div', { style: css.failureHead },
                h('span', { style: css.failureKind }, row.kind),
                row.state ? h('span', { style: css.tertiary }, row.state) : null,
                h('span', { style: css.tertiary }, t('overview.failureAttempts', { n: fmtNum(row.attempts, locale) })),
                h('span', { style: css.muted }, fmtTime(row.at, locale))),
              row.errorShort ? h('div', { style: css.failureError, title: row.error }, row.errorShort) : null)))) : null,
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
      const [sample, setSample] = useState(null)
      const searchSeq = useRef(0)
      const [searchTick, setSearchTick] = useState(0)

      // §11.4 首次安装：写入 3 条示例（不自动写），随后可按记录的 id 一键归档清理。
      const writeSamples = async () => {
        setSample({ status: 'saving', ids: [] })
        const ids = []
        let queued = 0
        try {
          for (const text of [t('memory.sample1'), t('memory.sample2'), t('memory.sample3')]) {
            const result = await callJson('/write', {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                text, level: 'normal', memory_type: 'semantic', tags: [SAMPLE_TAG],
              }),
            })
            if (result && result.id !== null && result.id !== undefined) ids.push(result.id)
            else if (result && result.candidate === true) queued += 1
          }
          if (ids.length > 0) {
            setSample({ status: 'ok', ids })
            setReload((v) => v + 1)
          } else if (queued > 0) {
            setSample({ status: 'candidate', ids: [] })
          } else {
            setSample({ status: 'error', code: 'unknown_error', ids: [] })
          }
        } catch (err) {
          setSample({ status: 'error', code: (err && err.code) || 'unknown_error', ids: [] })
        }
      }

      const cleanupSamples = async () => {
        if (!sample || !Array.isArray(sample.ids) || sample.ids.length === 0) return
        if (!askConfirm(t('memory.sampleCleanupConfirm'))) return
        setSample({ status: 'cleaning', ids: sample.ids })
        try {
          for (const id of sample.ids) {
            await callJson('/nodes/' + encodeURIComponent(id), {
              method: 'PATCH', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ patch: { status: 'archived' } }),
            })
          }
          setSample({ status: 'cleaned', ids: [] })
          setReload((v) => v + 1)
        } catch (err) {
          setSample({ status: 'error', code: (err && err.code) || 'unknown_error', ids: sample.ids })
        }
      }

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

      // shadow 候选：宿主返回 {ok:true,candidate:true,id:null}，这不是"已写入"。
      const onCandidate = () => {
        setWriteOpen(false)
        setNotice(t('memory.candidateQueued'))
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
          const sampleBusy = Boolean(sample && (sample.status === 'saving' || sample.status === 'cleaning'))
          const sampleIds = sample && Array.isArray(sample.ids) ? sample.ids : []
          listBody = h('div', { style: css.guide },
            h('div', { style: css.cardTitle }, t('memory.emptyTitle')),
            h('div', { style: css.note }, t('memory.emptyDesc')),
            h('div', { style: css.inline },
              h('button', { style: css.buttonPrimary, onClick: () => setWriteOpen(true) }, t('memory.writeFirst')),
              h('button', { style: css.button, onClick: onImport }, t('memory.importJsonl'))),
            h('div', { style: css.sampleBox },
              h('div', { style: css.cardTitle }, t('memory.sampleTitle')),
              h('div', { style: css.note }, t('memory.sampleDesc')),
              h('div', { style: css.inline },
                h('button', {
                  style: sampleBusy ? css.buttonDisabled : css.button,
                  disabled: sampleBusy, onClick: writeSamples,
                }, sample && sample.status === 'saving' ? t('common.saving') : t('memory.sampleWrite')),
                sampleIds.length > 0
                  ? h('button', {
                    style: sampleBusy ? css.buttonDisabled : css.button,
                    disabled: sampleBusy, onClick: cleanupSamples,
                  }, sample.status === 'cleaning' ? t('common.saving') : t('memory.sampleCleanup'))
                  : null),
              sample && sample.status === 'ok' ? h('div', { style: css.ok }, t('memory.sampleDone')) : null,
              sample && sample.status === 'candidate' ? h('div', { style: css.warn }, t('memory.sampleCandidate')) : null,
              sample && sample.status === 'cleaned' ? h('div', { style: css.ok }, t('memory.sampleCleaned')) : null,
              sample && sample.status === 'error'
                ? h('div', { style: css.error }, errText(t, { code: sample.code })) : null))
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
        writeOpen ? h(WriteForm, {
          t, locale, onDone: onWritten, onCandidate,
          onCancel: () => setWriteOpen(false),
        }) : null,
        detailId ? h(DetailDrawer, {
          t, locale, id: detailId,
          onClose: () => setDetailId(null),
          onChanged: () => setReload((v) => v + 1),
        }) : null)
    }

    function MemoryTable(props) {
      const { t, locale, items, searching, onOpen } = props
      // 390px 窄屏下表格不横向溢出：外层滚动容器，表格保持最小可读宽度。
      return h('div', { style: { overflowX: 'auto' } },
        h('table', { style: css.table },
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
          h('td', { style: css.td }, searching ? fmtScore(item && item.score, locale) : '—'))))))
    }

    function WriteForm(props) {
      const { t, locale, onDone, onCandidate, onCancel } = props
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
          if (result && (result.candidate === true || result.id === null || result.id === undefined)) {
            if (onCandidate) onCandidate()
            else onDone(null)
            return
          }
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
          // /nodes/:id 是否带 edges 由 Host 决定；没带就显式「未提供」，不伪造空态。
          const edges = Array.isArray(body && body.edges)
            ? body.edges
            : Array.isArray(node.edges) ? node.edges : null
          setLoaded({ status: 'ok', node, edges })
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
        if (!askConfirm(t('detail.saveConfirm'))) return
        sendPatch({ text: body, level, status, tags: tags.split(',').map((s) => s.trim()).filter(Boolean) })
      }

      const archiveNode = () => {
        if (!askConfirm(t('detail.archiveConfirm'))) return
        sendPatch({ status: 'archived' })
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
          h('div', { style: css.metaBlock },
            h(SectionTitle, null, t('detail.origin')),
            node.origin
              ? h('div', { style: css.row },
                h('span', { style: css.muted }, t('detail.origin')),
                h('span', { style: css.rowValue }, String(node.origin)))
              : h('div', { style: css.tertiary }, t('detail.originUnavailable'))),
          h('div', { style: css.metaBlock },
            h(SectionTitle, null, t('detail.edges')),
            loaded.edges === null
              ? h('div', { style: css.tertiary }, t('detail.edgesUnavailable'))
              : loaded.edges.length === 0
                ? h('div', { style: css.tertiary }, t('detail.edgesEmpty'))
                : h('div', { style: css.stack }, loaded.edges.slice(0, 10).map((edge, index) => h('div', {
                  key: (edge && edge.id) || index, style: css.row,
                },
                h('span', null, String((edge && edge.etype) || '—')),
                h('span', { style: css.tertiary },
                  shortId(edge && edge.from_id) + ' → ' + shortId(edge && edge.to_id)
                  + (edge && edge.conf !== undefined ? ' · ' + fmtScore(edge.conf, locale) : '')))))),
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
              onClick: archiveNode,
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

    /** 召回命中的评分分解：rel/mult/gain/effWeight + 命中路径 + 命中词。 */
    function HitExplain(props) {
      const { t, locale, item } = props
      const raw = (item && item.components) || null
      if (!raw) return h('div', { style: css.tertiary }, t('recall.noComponents'))
      const hops = Number(raw.hops)
      const via = raw.via === undefined || raw.via === null ? '' : String(raw.via)
      let path = raw.path ? String(raw.path) : t('recall.pathFallback')
      if (raw.path && Number.isFinite(hops) && hops > 1) path += ' ×' + hops
      if (via) path += ' via ' + shortId(via)
      const matched = Array.isArray(raw.matched)
        ? raw.matched.join(', ')
        : (raw.matched === undefined || raw.matched === null || raw.matched === '' ? '—' : String(raw.matched))
      return h('div', { style: css.metaGrid },
        h(Row, { k: t('recall.colRel'), v: fmtScore(raw.rel, locale) }),
        h(Row, { k: t('recall.colMult'), v: fmtScore(raw.mult, locale) }),
        h(Row, { k: t('recall.colGain'), v: fmtScore(raw.gain, locale) }),
        h(Row, { k: t('recall.colEffWeight'), v: fmtScore(raw.effWeight, locale) }),
        h(Row, { k: t('recall.colPath'), v: path }),
        h(Row, { k: t('recall.colMatched'), v: matched }))
    }

    function RecallTab(props) {
      const { t, locale, recallCfg } = props
      const [recent, setRecent] = useState({ status: 'loading', items: [] })
      const [reload, setReload] = useState(0)
      const [filter, setFilter] = useState('')
      const [query, setQuery] = useState('')
      const [test, setTest] = useState({ status: 'idle', items: [], count: 0, ms: 0, below: 0 })

      useEffect(() => {
        let alive = true
        setRecent((prev) => ({ ...prev, status: 'loading' }))
        // 过滤走服务端白名单：filter=unused（已注入未采纳）/zero（零命中）。
        const suffix = filter === 'unused' || filter === 'zero' ? '&filter=' + filter : ''
        callJson('/recalls?limit=20' + suffix).then((body) => {
          if (!alive) return
          setRecent({ status: 'ok', items: Array.isArray(body.items) ? body.items : [] })
        }).catch((err) => {
          if (alive) setRecent({ status: 'error', items: [], err })
        })
        return () => { alive = false }
      }, [reload, filter])

      const runTest = async () => {
        const q = query.trim()
        if (!q) return
        setTest({ status: 'loading', items: [], count: 0, ms: 0, below: 0 })
        const started = Date.now()
        try {
          // 纯检索：/recall-test 不写库、不产生召回 trace；不要打 /search。
          const body = await callJson('/recall-test', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ query: q, maxHits: 10 }),
          })
          setTest({
            status: 'ok',
            items: Array.isArray(body.hits) ? body.hits : [],
            count: Number(body.count) || 0,
            ms: Number(body.elapsed_ms) || (Date.now() - started),
            below: Number(body.below_min_n) || 0,
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
              h('th', { style: css.th }, t('recall.colSource')),
              h('th', { style: css.th }, t('recall.colHits')),
              h('th', { style: css.th }, t('recall.colChars')),
              h('th', { style: css.th }, t('recall.colElapsed')),
              h('th', { style: css.th }, t('recall.colInjected')),
              h('th', { style: css.th }, t('recall.colUsed')))),
            h('tbody', null, recent.items.map((item, index) => h('tr', { key: (item && item.id) || index },
              h('td', { style: css.td }, fmtTime(item && item.ts, locale)),
              h('td', { style: css.td }, String((item && item.query) || '').slice(0, 80)),
              h('td', { style: css.td }, item && item.source ? String(item.source) : '—'),
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
          test.below > 0
            ? h('div', { style: css.tertiary }, t('recall.belowMin', { n: fmtNum(test.below, locale) }))
            : null,
          test.items.length === 0
            ? h(StateBlock, { t, status: 'empty', empty: t('recall.testEmpty') })
            : h('div', { style: css.stack }, test.items.map((item, index) => h('details', {
              key: (item && item.id) || index, style: css.resultItem,
            },
            h('summary', { style: css.resultSummary },
              h('span', { style: css.cellText }, String((item && item.text) || '')),
              h('span', { style: css.tertiary }, t('recall.explainHint'))),
            h('div', { style: css.tertiary },
              (item && item.level ? levelLabel(t, item.level) : '—') + ' · '
              + (item && item.type ? typeLabel(t, item.type) : '—') + ' · '
              + (item && item.source ? sourceLabel(t, item.source) : '—') + ' · '
              + 'score ' + fmtScore(item && item.score, locale) + ' · '
              + 'rel ' + fmtScore(item && item.rel, locale)),
            h(HitExplain, { t, locale, item })))))
      }

      const intentText = recallCfg && recallCfg.intentBudget
        ? t('recall.budgetIntentOn') : t('recall.budgetIntentOff')
      const budgetText = recallCfg
        ? t('recall.budgetLine', {
          chars: fmtNum(recallCfg.charBudget, locale),
          hits: fmtNum(recallCfg.maxHits, locale),
          intent: intentText,
        })
        : t('common.dash')
      const filters = [['', 'recall.filterAll'], ['unused', 'recall.filterUnused'], ['zero', 'recall.filterZero']]

      return h('div', { style: css.stack },
        h(Card, null,
          h(SectionTitle, null, t('recall.budgetTitle')),
          h('div', { style: css.note }, budgetText),
          recallCfg && recallCfg.charBudget === 0 ? h('div', { style: css.warn }, t('recall.budgetZero')) : null),
        h(Card, null,
          h(SectionTitle, null, t('recall.recent')),
          h('div', { style: css.inline },
            h('div', { style: css.tertiary }, t('recall.filterLabel')),
            filters.map(([value, labelKey]) => h('button', {
              key: value || 'all',
              style: filter === value ? css.buttonPrimary : css.button,
              onClick: () => setFilter(value),
            }, t(labelKey))),
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
      const [candidates, setCandidates] = useState({ status: 'loading', items: [] })
      const [writes, setWrites] = useState({ status: 'loading', items: [] })
      const [edges, setEdges] = useState({ status: 'loading', data: null })
      const [evolution, setEvolution] = useState({ status: 'loading', items: [] })
      const [review, setReview] = useState({
        status: 'idle', id: null, code: '', openId: null, action: 'accept', reason: '', rewrite: '',
      })
      const [reloadTick, setReloadTick] = useState(0)

      useEffect(() => {
        let alive = true
        // 候选只查 action=CANDIDATE（宿主支持服务端过滤），不再前端过滤最近 50 条。
        setCandidates((prev) => ({ ...prev, status: 'loading' }))
        callJson('/writes?action=CANDIDATE&limit=100').then((body) => {
          if (alive) setCandidates({ status: 'ok', items: Array.isArray(body.items) ? body.items : [] })
        }).catch((err) => {
          if (alive) setCandidates({ status: 'error', items: [], err })
        })
        setWrites((prev) => ({ ...prev, status: 'loading' }))
        callJson('/writes?limit=50').then((body) => {
          if (alive) setWrites({ status: 'ok', items: Array.isArray(body.items) ? body.items : [] })
        }).catch((err) => {
          if (alive) setWrites({ status: 'error', items: [], err })
        })
        setEdges((prev) => ({ ...prev, status: 'loading' }))
        callJson('/edges').then((body) => {
          if (alive) setEdges({ status: 'ok', data: body })
        }).catch((err) => {
          if (alive) setEdges({ status: 'error', data: null, err })
        })
        setEvolution((prev) => ({ ...prev, status: 'loading' }))
        callJson('/evolution?limit=10').then((body) => {
          if (alive) setEvolution({ status: 'ok', items: Array.isArray(body.items) ? body.items : [] })
        }).catch((err) => {
          if (alive) setEvolution({ status: 'error', items: [], err })
        })
        return () => { alive = false }
      }, [version, reloadTick])

      const openReview = (item, action) => {
        setReview({
          status: 'idle', id: item && item.id, code: '',
          openId: item && item.id, action,
          reason: '',
          rewrite: action === 'accept' ? String((item && item.after_text) || '') : '',
        })
      }

      const closeReview = () => setReview({
        status: 'idle', id: null, code: '', openId: null, action: 'accept', reason: '', rewrite: '',
      })

      // 审核提交：reject 带理由；accept 可带改写正文（接受后用 PATCH 落到节点上，留审计）。
      const submitReview = async () => {
        const id = review.openId
        if (id === null || id === undefined) return
        const action = review.action === 'reject' ? 'reject' : 'accept'
        setReview((prev) => ({ ...prev, status: 'saving', id, code: '' }))
        try {
          const body = await callJson('/write/review', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id, decision: action, reason: String(review.reason || '').slice(0, 200) }),
          })
          const candidate = candidates.items.find((item) => item && item.id === id)
          const original = String((candidate && candidate.after_text) || '')
          const rewritten = String(review.rewrite || '').trim()
          const nodeId = body && body.id !== undefined && body.id !== null ? body.id : null
          if (action === 'accept' && nodeId !== null && rewritten && rewritten !== original) {
            if (rewritten.length > 500) throw Object.assign(new Error('text_too_long'), { code: 'text_too_long' })
            await callJson('/nodes/' + encodeURIComponent(nodeId), {
              method: 'PATCH',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ patch: { text: rewritten } }),
            })
          }
          setReview((prev) => ({ ...prev, status: 'ok', id, code: '' }))
          setReloadTick((x) => x + 1)
        } catch (err) {
          setReview((prev) => ({ ...prev, status: 'error', id, code: (err && err.code) || 'unknown_error' }))
        }
      }

      let pendingBody = null
      if (candidates.status === 'loading') pendingBody = h(StateBlock, { t, status: 'loading' })
      else if (candidates.status === 'error') pendingBody = h(StateBlock, { t, status: 'error', err: candidates.err })
      else if (candidates.items.length === 0) {
        pendingBody = h(StateBlock, { t, status: 'empty', empty: t('writes.pendingEmpty') })
      } else {
        pendingBody = h('div', { style: { overflowX: 'auto' } },
          h('table', { style: css.table },
            h('thead', null, h('tr', null,
              h('th', { style: css.th }, t('writes.colTime')),
              h('th', { style: css.th }, t('writes.colText')),
              h('th', { style: css.th }, t('writes.colReason')))),
            h('tbody', null, candidates.items.map((item, index) => h('tr', { key: (item && item.id) || index },
              h('td', { style: css.td }, fmtTime(item && item.ts, locale)),
              h('td', { style: css.td }, String((item && item.after_text) || '—').slice(0, 140)),
              h('td', { style: css.td },
                h('div', { style: css.inline },
                  h('button', {
                    style: review.status === 'saving' && review.id === item.id ? css.buttonDisabled : css.buttonPrimary,
                    disabled: review.status === 'saving',
                    onClick: () => openReview(item, 'accept'),
                  }, t('writes.accept')),
                  h('button', {
                    style: review.status === 'saving' && review.id === item.id ? css.buttonDisabled : css.button,
                    disabled: review.status === 'saving',
                    onClick: () => openReview(item, 'reject'),
                  }, t('writes.reject')))))))))
      }

      const pendingCard = h(Card, null,
        h(SectionTitle, null, t('writes.pendingTitle')),
        h(Note, null, t('writes.pendingNote')),
        pendingBody,
        review.status === 'error' ? h('div', { style: css.error }, t('writes.reviewFailed') + ' — ' + errText(t, { code: review.code })) : null,
        review.status === 'ok' ? h('div', { style: css.ok }, t('writes.reviewDone')) : null)

      const openCandidate = review.openId === null || review.openId === undefined
        ? null
        : candidates.items.find((item) => item && item.id === review.openId)
      const reviewCard = openCandidate
        ? h(Card, null,
          h(SectionTitle, null, t('writes.reviewFormTitle')),
          h('div', { style: css.muted }, String(openCandidate.after_text || '—').slice(0, 200)),
          h('label', { style: css.field },
            h('span', { style: css.fieldLabel }, t('writes.rewrite')),
            h('textarea', {
              style: css.textarea, rows: 3, value: review.rewrite,
              disabled: review.action !== 'accept',
              onChange: (e) => setReview((prev) => ({ ...prev, rewrite: e.target.value })),
            })),
          h('div', { style: css.tertiary }, t('writes.rewriteHint')),
          h('label', { style: css.field },
            h('span', { style: css.fieldLabel }, t('writes.rejectReason')),
            h('input', {
              style: css.input, value: review.reason,
              onChange: (e) => setReview((prev) => ({ ...prev, reason: e.target.value })),
            })),
          h('div', { style: css.inline },
            h('button', {
              style: review.status === 'saving' ? css.buttonDisabled : (review.action === 'reject' ? css.buttonWarn : css.buttonPrimary),
              disabled: review.status === 'saving', onClick: submitReview,
            }, review.status === 'saving' ? t('common.saving') : t('writes.confirmReview')),
            h('button', { style: css.button, onClick: closeReview }, t('common.cancel'))))
        : null

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
              h('td', { style: css.td }, actionLabel(t, item && item.action)),
              h('td', { style: css.td }, String((item && item.node_id) || '—').slice(0, 32)),
              h('td', { style: css.td }, String((item && item.reason) || '—').slice(0, 120)))))))
      }

      const edgeStats = edges.status === 'ok' ? edges.data : null
      const byType = edgeStats && Array.isArray(edgeStats.by_type) ? edgeStats.by_type : []
      let edgesBody = null
      if (edges.status === 'loading') edgesBody = h(StateBlock, { t, status: 'loading' })
      else if (edges.status === 'error') edgesBody = h(StateBlock, { t, status: 'error', err: edges.err })
      else if (byType.length === 0) edgesBody = h(StateBlock, { t, status: 'empty', empty: t('writes.edgesEmpty') })
      else {
        edgesBody = h('div', { style: { overflowX: 'auto' } },
          h('table', { style: css.table },
            h('thead', null, h('tr', null,
              h('th', { style: css.th }, t('writes.colType')),
              h('th', { style: css.th }, t('writes.colCount')))),
            h('tbody', null, byType.map((row, index) => h('tr', { key: (row && row.etype) || index },
              h('td', { style: css.td }, String((row && row.etype) || '—')),
              h('td', { style: css.td }, fmtNum(row && row.n, locale)))))))
      }
      const edgesCard = h(Card, null,
        h(SectionTitle, null, t('writes.edgesTitle')),
        h('div', { style: css.tertiary }, t('common.total', { total: fmtNum(edgeStats ? edgeStats.edges : null, locale) })),
        edgesBody)

      let evolutionBody = null
      if (evolution.status === 'loading') evolutionBody = h(StateBlock, { t, status: 'loading' })
      else if (evolution.status === 'error') evolutionBody = h(StateBlock, { t, status: 'error', err: evolution.err })
      else if (evolution.items.length === 0) evolutionBody = h(StateBlock, { t, status: 'empty', empty: t('writes.evolutionEmpty') })
      else {
        evolutionBody = h('div', { style: css.stack }, evolution.items.slice(0, 10).map((item, index) => h('div', {
          key: (item && item.id) || index, style: css.row,
        },
        h('span', { style: css.muted }, fmtTime(item && item.ts, locale)),
        h('span', { style: css.rowValue },
          shortId(item && item.from_id) + ' → ' + shortId(item && item.to_id)
          + (item && item.field ? ' · ' + String(item.field) : '')),
        item && (item.old_value !== undefined || item.new_value !== undefined)
          ? h('div', { style: css.tertiary },
            t('writes.oldValue') + ': ' + String(item.old_value ?? '—').slice(0, 80)
            + ' · ' + t('writes.newValue') + ': ' + String(item.new_value ?? '—').slice(0, 80))
          : null)))
      }
      const evolutionCard = h(Card, null,
        h(SectionTitle, null, t('writes.evolutionTitle')),
        evolutionBody)

      return h('div', { style: css.stack },
        h('div', { style: css.kpiGrid },
          h(Kpi, { label: t('writes.edges'), value: edgeStats ? fmtNum(edgeStats.edges, locale) : '—' }),
          h(Kpi, { label: t('writes.recentCount'), value: fmtNum(writes.status === 'ok' ? writes.items.length : null, locale) })),
        pendingCard,
        reviewCard,
        h(Card, null,
          h(SectionTitle, null, t('writes.recent')),
          h(Note, null, t('writes.note')),
          body),
        edgesCard,
        evolutionCard)
    }

    // --------------------------------------------------------------- settings

    // >>> settings:contract
    // 设置项单一元数据表：默认值 / 生效方式 / 徽标 / 依赖。UI 与 client 契约测试共用。
    // effect: instant=即时，reload=重挂，daily=每日；badge: general/local/needsConfig。
    // 默认值以 src/host/config.js 的 `.default(...)` 为基线；effect 以 `.volatile()` 为准，
    // 例外：privacy.retentionDays 由每日 job 消费（daily），panel.tab 保存后由面板立即切换。
    const SETTINGS_META = {
      dataDir: { def: '', effect: 'reload', badge: 'local' },
      'backend.id': { def: '', effect: 'reload', badge: 'general' },
      'backend.mode': { def: 'local', effect: 'reload', badge: 'general' },
      'backend.url': {
        def: '', effect: 'reload', badge: 'needsConfig',
        dependsOn: { group: 'backend', key: 'mode', notEquals: 'local', reasonKey: 'settings.depBackendUrl' },
      },
      'backend.timeoutMs': { def: 3000, effect: 'reload', badge: 'needsConfig' },
      'identity.mode': { def: 'auto', effect: 'instant', badge: 'general' },
      'identity.userId': { def: '', effect: 'instant', badge: 'general' },
      'identity.roleId': { def: '', effect: 'instant', badge: 'general' },
      'identity.workspace': { def: '', effect: 'instant', badge: 'general' },
      'recall.enabled': { def: true, effect: 'instant', badge: 'general' },
      'recall.maxHits': { def: 5, effect: 'instant', badge: 'general' },
      'recall.charBudget': { def: 1500, effect: 'instant', badge: 'general' },
      'recall.intentBudget': { def: true, effect: 'instant', badge: 'general' },
      'recall.minRel': { def: 0.34, effect: 'instant', badge: 'general' },
      'recall.timeoutMs': { def: 2000, effect: 'reload', badge: 'general' },
      'recall.injectLevels': { def: ['core', 'important'], effect: 'instant', badge: 'general' },
      'recall.showSources': { def: true, effect: 'instant', badge: 'general' },
      'write.enabled': { def: true, effect: 'instant', badge: 'general' },
      'write.reviewMode': { def: 'shadow', effect: 'instant', badge: 'general' },
      'write.maxChars': { def: 500, effect: 'instant', badge: 'general' },
      'write.dailyCap': { def: 200, effect: 'instant', badge: 'general' },
      'write.judge': { def: 'rules', effect: 'instant', badge: 'general' },
      'write.searchFeed': { def: false, effect: 'instant', badge: 'general' },
      'write.searchTtlHours': { def: 24, effect: 'instant', badge: 'general' },
      'write.model': {
        def: '', effect: 'reload', badge: 'general',
        dependsOn: { group: 'write', key: 'judge', equals: 'llm', reasonKey: 'settings.depWriteModel' },
      },
      'write.ignorePatterns': { def: [], effect: 'reload', badge: 'general' },
      'reflect.enabled': { def: false, effect: 'reload', badge: 'general' },
      'reflect.model': { def: '', effect: 'reload', badge: 'general' },
      'reflect.idleMinutes': { def: 30, effect: 'reload', badge: 'general' },
      'reflect.maxItems': { def: 8, effect: 'instant', badge: 'general' },
      'reflect.maxRunsPerDay': { def: 24, effect: 'reload', badge: 'general' },
      'consolidate.enabled': { def: true, effect: 'instant', badge: 'general' },
      'consolidate.intervalHours': { def: 6, effect: 'reload', badge: 'general' },
      'embed.enabled': { def: false, effect: 'reload', badge: 'needsConfig' },
      'embed.endpoint': {
        def: '', effect: 'reload', badge: 'needsConfig',
        dependsOn: { group: 'embed', key: 'enabled', equals: true, reasonKey: 'settings.depEmbed' },
      },
      'embed.model': {
        def: '', effect: 'reload', badge: 'needsConfig',
        dependsOn: { group: 'embed', key: 'enabled', equals: true, reasonKey: 'settings.depEmbed' },
      },
      'embed.batch': {
        def: 16, effect: 'reload', badge: 'needsConfig',
        dependsOn: { group: 'embed', key: 'enabled', equals: true, reasonKey: 'settings.depEmbed' },
      },
      'privacy.redact': { def: true, effect: 'instant', badge: 'general' },
      'privacy.retentionDays': { def: 0, effect: 'daily', badge: 'local' },
      'edges.diffusion': { def: true, effect: 'instant', badge: 'general' },
      'edges.minConf': { def: 0.6, effect: 'instant', badge: 'general' },
      'sync.enabled': { def: false, effect: 'instant', badge: 'needsConfig' },
      'sync.mode': {
        def: 'off', effect: 'instant', badge: 'needsConfig',
        dependsOn: { group: 'sync', key: 'enabled', equals: true, reasonKey: 'settings.depSync' },
      },
      'sync.intervalMin': {
        def: 15, effect: 'reload', badge: 'needsConfig',
        dependsOn: { group: 'sync', key: 'enabled', equals: true, reasonKey: 'settings.depSync' },
      },
      'sync.httpTimeoutMs': {
        def: 800, effect: 'instant', badge: 'needsConfig',
        dependsOn: { group: 'sync', key: 'enabled', equals: true, reasonKey: 'settings.depSync' },
      },
      'sync.batch': {
        def: 100, effect: 'instant', badge: 'needsConfig',
        dependsOn: { group: 'sync', key: 'enabled', equals: true, reasonKey: 'settings.depSync' },
      },
      'sync.bridgeUrl': {
        def: '', effect: 'reload', badge: 'needsConfig',
        dependsOn: { group: 'sync', key: 'enabled', equals: true, reasonKey: 'settings.depSync' },
      },
      'sync.dryRun': {
        def: true, effect: 'instant', badge: 'needsConfig',
        dependsOn: { group: 'sync', key: 'enabled', equals: true, reasonKey: 'settings.depSync' },
      },
      'panel.allowRemote': { def: false, effect: 'instant', badge: 'local' },
      'panel.pollMs': { def: 60000, effect: 'instant', badge: 'local' },
      'panel.tab': { def: 'overview', effect: 'instant', badge: 'local' },
      'advanced.traceId': { def: '', effect: 'instant', badge: 'general' },
      'advanced.logLevel': { def: 'warn', effect: 'instant', badge: 'general' },
      'advanced.worker': { def: true, effect: 'instant', badge: 'local' },
    }
    // <<< settings:contract

    /** id → 元数据：设置卡 id 与 `wm-<group>-<key>` 一一对应（dataDir 例外）。 */
    const SETTINGS_META_BY_ID = (() => {
      const out = {}
      for (const [key, meta] of Object.entries(SETTINGS_META)) {
        const dot = key.indexOf('.')
        out[dot < 0 ? 'wm-' + key : 'wm-' + key.slice(0, dot) + '-' + key.slice(dot + 1)] = meta
      }
      return out
    })()

    /** 设置项默认值的展示文本：布尔/空串/数组走本地化，数字用 locale 格式。 */
    function defaultText(value, t, locale) {
      if (value === true) return t('settings.defaultOn')
      if (value === false) return t('settings.defaultOff')
      if (value === '' || value === null || value === undefined) return t('settings.defaultEmpty')
      if (Array.isArray(value)) return value.length === 0 ? t('settings.defaultEmpty') : value.join(', ')
      if (typeof value === 'number') return fmtNum(value, locale)
      return String(value)
    }

    /** 生效方式徽标：即时 / 重挂 / 每日。 */
    function effectText(token, t) {
      if (token === 'instant') return t('settings.effectInstant')
      if (token === 'daily') return t('settings.effectDaily')
      return t('settings.effectReload')
    }

    /** 通用 / 本机 / 需配置 徽标。 */
    function badgeText(token, t) {
      if (token === 'local') return t('settings.badgeLocal')
      if (token === 'needsConfig') return t('settings.badgeNeedsConfig')
      return t('settings.badgeGeneral')
    }

    function normalizeConfig(config) {
      const cfg = config || {}
      const backend = cfg.backend || {}
      const identity = cfg.identity || {}
      const recall = cfg.recall || {}
      const write = cfg.write || {}
      const reflect = cfg.reflect || {}
      const consolidate = cfg.consolidate || {}
      const embed = cfg.embed || {}
      const privacy = cfg.privacy || {}
      const edges = cfg.edges || {}
      const sync = cfg.sync || {}
      const panel = cfg.panel || {}
      const advanced = cfg.advanced || {}
      const n = (value, fallback) => {
        const x = Number(value)
        return Number.isFinite(x) ? x : fallback
      }
      const oneOf = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback)
      const list = (value, fallback, split) => {
        if (Array.isArray(value)) return value.filter((item) => typeof item === 'string')
        if (typeof value === 'string' && value.trim()) {
          return value.split(split || ',').map((item) => item.trim()).filter(Boolean)
        }
        return fallback.slice()
      }
      const levels = list(recall.injectLevels, ['core', 'important'])
        .filter((item) => ['core', 'important', 'normal'].includes(item))
      return {
        dataDir: typeof cfg.dataDir === 'string' ? cfg.dataDir : '',
        backend: {
          id: backend.id || '',
          mode: oneOf(backend.mode, ['local', 'http', 'hybrid'], 'local'),
          url: backend.url || '',
          timeoutMs: n(backend.timeoutMs, 3000),
        },
        identity: {
          mode: oneOf(identity.mode, ['auto', 'fixed'], 'auto'),
          userId: identity.userId || '',
          roleId: identity.roleId || '',
          workspace: identity.workspace || '',
        },
        recall: {
          enabled: recall.enabled !== false,
          maxHits: n(recall.maxHits, 5),
          charBudget: n(recall.charBudget, 1500),
          intentBudget: recall.intentBudget !== false,
          minRel: n(recall.minRel, 0.34),
          timeoutMs: n(recall.timeoutMs, 2000),
          injectLevels: levels,
          showSources: recall.showSources !== false,
        },
        write: {
          enabled: write.enabled !== false,
          reviewMode: oneOf(write.reviewMode, ['shadow', 'auto'], 'shadow'),
          maxChars: n(write.maxChars, 500),
          dailyCap: n(write.dailyCap, 200),
          judge: oneOf(write.judge, ['rules', 'llm'], 'rules'),
          searchFeed: write.searchFeed === true,
          searchTtlHours: n(write.searchTtlHours, 24),
          model: write.model || '',
          ignorePatterns: list(write.ignorePatterns, [], '\n'),
        },
        reflect: {
          enabled: reflect.enabled === true,
          model: reflect.model || '',
          idleMinutes: n(reflect.idleMinutes, 30),
          maxItems: n(reflect.maxItems, 8),
          maxRunsPerDay: n(reflect.maxRunsPerDay, 24),
        },
        consolidate: {
          enabled: consolidate.enabled !== false,
          intervalHours: n(consolidate.intervalHours, 6),
        },
        embed: {
          enabled: embed.enabled === true,
          endpoint: embed.endpoint || '',
          model: embed.model || '',
          batch: n(embed.batch, 16),
        },
        privacy: {
          redact: privacy.redact !== false,
          retentionDays: n(privacy.retentionDays, 0),
        },
        edges: {
          diffusion: edges.diffusion !== false,
          minConf: n(edges.minConf, 0.6),
        },
        sync: {
          enabled: sync.enabled === true,
          mode: oneOf(sync.mode, ['off', 'push', 'pull', 'both'], 'off'),
          intervalMin: n(sync.intervalMin, 15),
          httpTimeoutMs: n(sync.httpTimeoutMs, 800),
          batch: n(sync.batch, 100),
          bridgeUrl: sync.bridgeUrl || '',
          dryRun: sync.dryRun !== false,
        },
        panel: {
          pollMs: n(panel.pollMs, 60000),
          allowRemote: panel.allowRemote === true,
          tab: oneOf(panel.tab, TABS.map(([key]) => key), 'overview'),
        },
        advanced: {
          logLevel: oneOf(advanced.logLevel, ['error', 'warn', 'info', 'debug'], 'warn'),
          worker: advanced.worker !== false,
          traceId: advanced.traceId || '',
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
        [draft.write.dailyCap, 1, 2000],
        [draft.write.searchTtlHours, 1, 720],
        [draft.reflect.idleMinutes, 5, 1440],
        [draft.reflect.maxItems, 1, 32],
        [draft.reflect.maxRunsPerDay, 1, 96],
        [draft.consolidate.intervalHours, 1, 168],
        [draft.embed.batch, 1, 128],
        [draft.privacy.retentionDays, 0, 3650],
        [draft.edges.minConf, 0, 1],
        [draft.sync.intervalMin, 1, 10080],
        [draft.sync.httpTimeoutMs, 200, 30000],
        [draft.sync.batch, 1, 500],
        [draft.panel.pollMs, 5000, 600000],
      ]
      return checks.some(([value, min, max]) => {
        const x = Number(value)
        return !Number.isFinite(x) || x < min || x > max
      })
    }

    /** 设置分组卡：标题 + 一句「这组什么时候用」+ 子卡片。 */
    function GroupCard(props) {
      return h(Card, null,
        h(SectionTitle, null, props.title),
        props.desc ? h('div', { style: css.groupDesc }, props.desc) : null,
        props.children)
    }

    function SettingsTab(props) {
      const activeLocale = useActiveLocale()
      const { t, onSaved } = props
      // 设置分区（settings.section）只注入 t；locale 由当前语言派生，保证与面板一致。
      const locale = props.locale || activeLocale
      const [load, setLoad] = useState({ status: 'loading' })
      const [draft, setDraft] = useState(null)
      const [save, setSave] = useState({ status: 'idle', code: '', at: 0, refreshFailed: false })

      // 保存后 GET /config 回读时，宿主尚未回显的叶子沿用本地值，避免 draft 被默认值冲掉。
      const carryConfig = (prev, fetched) => {
        const next = normalizeConfig(fetched)
        if (!prev) return next
        const raw = fetched && typeof fetched === 'object' ? fetched : {}
        for (const group of Object.keys(next)) {
          if (group === 'dataDir') continue
          if (raw[group] && typeof raw[group] === 'object') {
            for (const key of Object.keys(next[group])) {
              if (raw[group][key] === undefined && prev[group] && prev[group][key] !== undefined) {
                next[group][key] = prev[group][key]
              }
            }
          } else if (prev[group]) {
            next[group] = prev[group]
          }
        }
        if (typeof raw.dataDir !== 'string' && prev.dataDir) next.dataDir = prev.dataDir
        return next
      }

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
        setSave((prev) => (prev.status === 'ok' || prev.status === 'error'
          ? { status: 'idle', code: '', at: 0, refreshFailed: false }
          : prev))
      }

      const submit = async () => {
        if (!draft) return
        const injectLevels = (draft.recall.injectLevels || [])
          .map((item) => String(item).trim()).filter(Boolean)
        const badLevel = injectLevels.some((item) => !['core', 'important', 'normal'].includes(item))
        const payload = {
          ...draft,
          recall: { ...draft.recall, injectLevels },
          write: {
            ...draft.write,
            ignorePatterns: (draft.write.ignorePatterns || [])
              .map((line) => String(line).trim()).filter(Boolean),
          },
        }
        // charBudget=0 是「关闭注入」而不是「不限制」：保存前必须二次确认。
        if (Number(payload.recall && payload.recall.charBudget) === 0) {
          if (!askConfirm(t('settings.charBudgetZeroConfirm'))) return
        }
        if (badLevel || configIssue(payload)) {
          setSave({ status: 'error', code: 'invalid_value', at: 0, refreshFailed: false })
          return
        }
        setSave({ status: 'saving', code: '', at: 0, refreshFailed: false })
        try {
          await callJson('/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ config: payload }),
          })
        } catch (err) {
          setSave({ status: 'error', code: (err && err.code) || 'unknown_error', at: 0, refreshFailed: false })
          return
        }
        let next = payload
        let refreshFailed = false
        try {
          const body = await callJson('/config')
          next = carryConfig(payload, body && body.config)
          setDraft(next)
        } catch {
          refreshFailed = true
          setDraft(next)
        }
        setSave({ status: 'ok', code: '', at: Date.now(), refreshFailed })
        if (onSaved) onSaved(next)
      }

      if (load.status === 'loading') return h(Card, null, h(StateBlock, { t, status: 'loading' }))
      if (load.status === 'error') {
        return h(Card, null,
          h(StateBlock, { t, status: 'error', err: load.err, onRetry: reload }))
      }
      if (!draft) return h(Card, null, h(StateBlock, { t, status: 'empty' }))

      const idOf = (group, key) => 'wm-' + group + '-' + key
      /** 依赖判定：依赖未满足 → 返回原因文案（卡片置灰），满足 → null。 */
      const depReasonOf = (meta) => {
        const dep = meta && meta.dependsOn
        if (!dep) return null
        const current = draft && draft[dep.group] ? draft[dep.group][dep.key] : undefined
        const ok = Object.prototype.hasOwnProperty.call(dep, 'notEquals')
          ? current !== dep.notEquals
          : current === dep.equals
        return ok ? null : t('settings.depUnmet', { reason: t(dep.reasonKey) })
      }
      /** 卡片元数据：效果/默认值/徽标/依赖全部来自单处定义 SETTINGS_META。 */
      const cardMeta = (id) => {
        const meta = SETTINGS_META_BY_ID[id] || null
        const depReason = depReasonOf(meta)
        return {
          effect: effectText(meta ? meta.effect : 'reload', t),
          defaultValue: meta ? t('settings.defaultValue', { value: defaultText(meta.def, t, locale) }) : undefined,
          badge: meta ? badgeText(meta.badge, t) : undefined,
          depReason,
          dependsOn: meta ? meta.dependsOn : undefined,
          disabled: Boolean(depReason),
        }
      }
      const numCard = (id, label, desc, _effect, value, min, max, onChange, opt = {}) => {
        const meta = cardMeta(id)
        return h(FieldCard, {
          id, label, desc, note: opt.note, danger: opt.danger,
          effect: meta.effect, defaultValue: meta.defaultValue, badge: meta.badge,
          depReason: meta.depReason, dependsOn: meta.dependsOn, disabled: meta.disabled,
          children: (describedBy) => h(NumberInput, {
            id, describedBy, value, min, max, step: opt.step,
            disabled: Boolean(opt.disabled) || meta.disabled, onChange,
          }),
        })
      }
      const textCard = (id, label, desc, _effect, value, onChange, opt = {}) => {
        const meta = cardMeta(id)
        return h(FieldCard, {
          id, label, desc, note: opt.note, danger: opt.danger,
          effect: meta.effect, defaultValue: meta.defaultValue, badge: meta.badge,
          depReason: meta.depReason, dependsOn: meta.dependsOn, disabled: meta.disabled,
          children: (describedBy) => h(TextInput, {
            id, describedBy, value, placeholder: opt.placeholder,
            disabled: Boolean(opt.disabled) || meta.disabled, onChange,
          }),
        })
      }
      const selectCard = (id, label, desc, _effect, value, options, onChange, opt = {}) => {
        const meta = cardMeta(id)
        return h(FieldCard, {
          id, label, desc, note: opt.note, danger: opt.danger,
          effect: meta.effect, defaultValue: meta.defaultValue, badge: meta.badge,
          depReason: meta.depReason, dependsOn: meta.dependsOn, disabled: meta.disabled,
          children: (describedBy) => h(SelectInput, {
            id, describedBy, value, options,
            disabled: Boolean(opt.disabled) || meta.disabled, onChange,
          }),
        })
      }
      const areaCard = (id, label, desc, _effect, value, onChange) => {
        const meta = cardMeta(id)
        return h(FieldCard, {
          id, label, desc,
          effect: meta.effect, defaultValue: meta.defaultValue, badge: meta.badge,
          depReason: meta.depReason, dependsOn: meta.dependsOn, disabled: meta.disabled,
          children: (describedBy) => h(TextAreaInput, {
            id, describedBy, value, rows: 4, onChange,
          }),
        })
      }
      const switchCard = (id, label, desc, note, _effect, danger, checked, onChange, disabled) => {
        const meta = cardMeta(id)
        return h(SwitchCard, {
          id, label, desc, note, danger, checked, onChange,
          effect: meta.effect, defaultValue: meta.defaultValue, badge: meta.badge,
          depReason: meta.depReason, dependsOn: meta.dependsOn,
          disabled: Boolean(disabled) || meta.disabled,
        })
      }

      const modeOptions = [['local', 'local'], ['http', 'http'], ['hybrid', 'hybrid']]
      const identityOptions = [['auto', 'auto'], ['fixed', 'fixed']]
      const reviewOptions = [['shadow', 'shadow'], ['auto', 'auto']]
      const judgeOptions = [['rules', 'rules'], ['llm', 'llm']]
      const syncModeOptions = [['off', 'off'], ['push', 'push'], ['pull', 'pull'], ['both', 'both']]
      const tabOptions = TABS.map(([key, labelKey]) => [key, t(labelKey)])
      const logOptions = [['error', 'error'], ['warn', 'warn'], ['info', 'info'], ['debug', 'debug']]

      return h('div', { style: css.stack },
        h(Note, null, t('settings.defaultsNote')),
        h('div', { style: css.groupGrid },
          h(GroupCard, {
            title: t('settings.groupBackend'), desc: t('settings.groupBackendDesc'),
          },
          selectCard(idOf('backend', 'mode'), t('settings.backendMode'), t('settings.backendModeDesc'), null,
            draft.backend.mode, modeOptions, (v) => patch('backend', 'mode', v)),
          textCard(idOf('backend', 'id'), t('settings.backendId'), t('settings.backendIdDesc'), null,
            draft.backend.id, (v) => patch('backend', 'id', v), { placeholder: 'whale-local' }),
          textCard(idOf('backend', 'url'), t('settings.backendUrl'), t('settings.backendUrlDesc'), null,
            draft.backend.url, (v) => patch('backend', 'url', v), { placeholder: 'http://127.0.0.1:8080' }),
          numCard(idOf('backend', 'timeoutMs'), t('settings.backendTimeout'), t('settings.backendTimeoutDesc'), null,
            draft.backend.timeoutMs, 200, 30000, (v) => patch('backend', 'timeoutMs', v))),
          h(GroupCard, {
            title: t('settings.groupIdentity'), desc: t('settings.groupIdentityDesc'),
          },
          selectCard(idOf('identity', 'mode'), t('settings.identityMode'), t('settings.identityModeDesc'), null,
            draft.identity.mode, identityOptions, (v) => patch('identity', 'mode', v)),
          textCard(idOf('identity', 'userId'), t('settings.identityUserId'), '', null,
            draft.identity.userId, (v) => patch('identity', 'userId', v), {
              disabled: draft.identity.mode === 'auto',
              note: draft.identity.mode === 'auto'
                ? t('settings.identityAutoNote')
                : t('settings.identityFixedNote'),
            }),
          textCard(idOf('identity', 'roleId'), t('settings.identityRoleId'), t('settings.identityRoleIdDesc'), null,
            draft.identity.roleId, (v) => patch('identity', 'roleId', v)),
          textCard(idOf('identity', 'workspace'), t('settings.identityWorkspace'), t('settings.identityWorkspaceDesc'), null,
            draft.identity.workspace, (v) => patch('identity', 'workspace', v))),
          h(GroupCard, {
            title: t('settings.groupRecall'), desc: t('settings.groupRecallDesc'),
          },
          switchCard(idOf('recall', 'enabled'), t('settings.recallEnabled'), t('settings.recallEnabledDesc'),
            null, null, false, draft.recall.enabled, (v) => patch('recall', 'enabled', v)),
          numCard(idOf('recall', 'maxHits'), t('settings.maxHits'), t('settings.maxHitsDesc'), null,
            draft.recall.maxHits, 0, 20, (v) => patch('recall', 'maxHits', v)),
          numCard(idOf('recall', 'charBudget'), t('settings.charBudget'), t('settings.charBudgetDesc'), null,
            draft.recall.charBudget, 0, 8000, (v) => patch('recall', 'charBudget', v)),
          switchCard(idOf('recall', 'intentBudget'), t('settings.intentBudget'), t('settings.intentBudgetDesc'),
            null, null, false, draft.recall.intentBudget, (v) => patch('recall', 'intentBudget', v)),
          numCard(idOf('recall', 'minRel'), t('settings.minRel'), t('settings.minRelDesc'), null,
            draft.recall.minRel, 0, 1, (v) => patch('recall', 'minRel', v), { step: 0.01 }),
          numCard(idOf('recall', 'timeoutMs'), t('settings.recallTimeout'), t('settings.recallTimeoutDesc'), null,
            draft.recall.timeoutMs, 100, 10000, (v) => patch('recall', 'timeoutMs', v)),
          textCard(idOf('recall', 'injectLevels'), t('settings.injectLevels'), t('settings.injectLevelsDesc'), null,
            (draft.recall.injectLevels || []).join(', '), (v) => patch('recall', 'injectLevels',
              v.split(',').map((item) => item.trim()))),
          switchCard(idOf('recall', 'showSources'), t('settings.showSources'), t('settings.showSourcesDesc'),
            null, null, false, draft.recall.showSources, (v) => patch('recall', 'showSources', v))),
          h(GroupCard, {
            title: t('settings.groupWrite'), desc: t('settings.groupWriteDesc'),
          },
          switchCard(idOf('write', 'enabled'), t('settings.writeEnabled'), t('settings.writeEnabledDesc'),
            null, null, false, draft.write.enabled, (v) => patch('write', 'enabled', v)),
          selectCard(idOf('write', 'reviewMode'), t('settings.reviewMode'), t('settings.reviewModeDesc'), null,
            draft.write.reviewMode, reviewOptions, (v) => patch('write', 'reviewMode', v)),
          numCard(idOf('write', 'maxChars'), t('settings.maxChars'), t('settings.maxCharsDesc'), null,
            draft.write.maxChars, 20, 500, (v) => patch('write', 'maxChars', v)),
          numCard(idOf('write', 'dailyCap'), t('settings.dailyCap'), t('settings.dailyCapDesc'), null,
            draft.write.dailyCap, 1, 2000, (v) => patch('write', 'dailyCap', v)),
          switchCard(idOf('write', 'searchFeed'), t('settings.searchFeed'), t('settings.searchFeedDesc'),
            null, null, false, draft.write.searchFeed, (v) => patch('write', 'searchFeed', v)),
          numCard(idOf('write', 'searchTtlHours'), t('settings.searchTtlHours'), t('settings.searchTtlHoursDesc'), null,
            draft.write.searchTtlHours, 1, 720, (v) => patch('write', 'searchTtlHours', v)),
          selectCard(idOf('write', 'judge'), t('settings.judge'), t('settings.judgeDesc'), null,
            draft.write.judge, judgeOptions, (v) => patch('write', 'judge', v)),
          areaCard(idOf('write', 'ignorePatterns'), t('settings.ignorePatterns'), t('settings.ignorePatternsDesc'), null,
            (draft.write.ignorePatterns || []).join('\n'), (v) => patch('write', 'ignorePatterns',
              v.split(/\r?\n/).map((line) => line.trim()))),
          textCard(idOf('write', 'model'), t('settings.writeModel'), t('settings.writeModelDesc'), null,
            draft.write.model, (v) => patch('write', 'model', v))),
          h(GroupCard, {
            title: t('settings.groupReflect'), desc: t('settings.groupReflectDesc'),
          },
          switchCard(idOf('reflect', 'enabled'), t('settings.reflectEnabled'), t('settings.reflectEnabledDesc'),
            null, null, false, draft.reflect.enabled, (v) => patch('reflect', 'enabled', v)),
          textCard(idOf('reflect', 'model'), t('settings.reflectModel'), t('settings.reflectModelDesc'), null,
            draft.reflect.model, (v) => patch('reflect', 'model', v)),
          numCard(idOf('reflect', 'idleMinutes'), t('settings.idleMinutes'), t('settings.idleMinutesDesc'), null,
            draft.reflect.idleMinutes, 5, 1440, (v) => patch('reflect', 'idleMinutes', v)),
          numCard(idOf('reflect', 'maxItems'), t('settings.maxItems'), t('settings.maxItemsDesc'), null,
            draft.reflect.maxItems, 1, 32, (v) => patch('reflect', 'maxItems', v)),
          numCard(idOf('reflect', 'maxRunsPerDay'), t('settings.maxRunsPerDay'), t('settings.maxRunsPerDayDesc'), null,
            draft.reflect.maxRunsPerDay, 1, 96, (v) => patch('reflect', 'maxRunsPerDay', v))),
          h(GroupCard, {
            title: t('settings.groupConsolidate'), desc: t('settings.groupConsolidateDesc'),
          },
          switchCard(idOf('consolidate', 'enabled'), t('settings.consolidateEnabled'), t('settings.consolidateEnabledDesc'),
            null, null, false, draft.consolidate.enabled, (v) => patch('consolidate', 'enabled', v)),
          numCard(idOf('consolidate', 'intervalHours'), t('settings.consolidateInterval'), t('settings.consolidateIntervalDesc'), null,
            draft.consolidate.intervalHours, 1, 168, (v) => patch('consolidate', 'intervalHours', v))),
          h(GroupCard, {
            title: t('settings.groupEmbed'), desc: t('settings.groupEmbedDesc'),
          },
          switchCard(idOf('embed', 'enabled'), t('settings.embedEnabled'), t('settings.embedEnabledDesc'),
            t('settings.embedNote'), null, false, draft.embed.enabled, (v) => patch('embed', 'enabled', v)),
          textCard(idOf('embed', 'endpoint'), t('settings.embedEndpoint'), t('settings.embedEndpointDesc'), null,
            draft.embed.endpoint, (v) => patch('embed', 'endpoint', v)),
          textCard(idOf('embed', 'model'), t('settings.embedModel'), t('settings.embedModelDesc'), null,
            draft.embed.model, (v) => patch('embed', 'model', v)),
          numCard(idOf('embed', 'batch'), t('settings.embedBatch'), t('settings.embedBatchDesc'), null,
            draft.embed.batch, 1, 128, (v) => patch('embed', 'batch', v))),
          h(GroupCard, {
            title: t('settings.groupPrivacy'), desc: t('settings.groupPrivacyDesc'),
          },
          switchCard(idOf('privacy', 'redact'), t('settings.privacyRedact'), t('settings.privacyRedactDesc'),
            null, null, false, draft.privacy.redact, (v) => patch('privacy', 'redact', v)),
          numCard(idOf('privacy', 'retentionDays'), t('settings.privacyRetention'), t('settings.privacyRetentionDesc'), null,
            draft.privacy.retentionDays, 0, 3650, (v) => patch('privacy', 'retentionDays', v),
            { danger: true, note: t('settings.privacyDanger') })),
          h(GroupCard, {
            title: t('settings.groupEdges'), desc: t('settings.groupEdgesDesc'),
          },
          switchCard(idOf('edges', 'diffusion'), t('settings.edgesDiffusion'), t('settings.edgesDiffusionDesc'),
            null, null, false, draft.edges.diffusion, (v) => patch('edges', 'diffusion', v)),
          numCard(idOf('edges', 'minConf'), t('settings.edgesMinConf'), t('settings.edgesMinConfDesc'), null,
            draft.edges.minConf, 0, 1, (v) => patch('edges', 'minConf', v), { step: 0.01 })),
          h(GroupCard, {
            title: t('settings.groupSync'), desc: t('settings.groupSyncDesc'),
          },
          switchCard(idOf('sync', 'enabled'), t('settings.syncEnabled'), t('settings.syncEnabledDesc'),
            null, null, false, draft.sync.enabled, (v) => patch('sync', 'enabled', v)),
          selectCard(idOf('sync', 'mode'), t('settings.syncMode'), t('settings.syncModeDesc'), null,
            draft.sync.mode, syncModeOptions, (v) => patch('sync', 'mode', v)),
          numCard(idOf('sync', 'intervalMin'), t('settings.syncInterval'), t('settings.syncIntervalDesc'), null,
            draft.sync.intervalMin, 1, 10080, (v) => patch('sync', 'intervalMin', v)),
          numCard(idOf('sync', 'httpTimeoutMs'), t('settings.syncHttpTimeout'), t('settings.syncHttpTimeoutDesc'), null,
            draft.sync.httpTimeoutMs, 200, 30000, (v) => patch('sync', 'httpTimeoutMs', v)),
          numCard(idOf('sync', 'batch'), t('settings.syncBatch'), t('settings.syncBatchDesc'), null,
            draft.sync.batch, 1, 500, (v) => patch('sync', 'batch', v)),
          textCard(idOf('sync', 'bridgeUrl'), t('settings.syncBridgeUrl'), t('settings.syncBridgeUrlDesc'), null,
            draft.sync.bridgeUrl, (v) => patch('sync', 'bridgeUrl', v), { placeholder: 'http://127.0.0.1:3099' }),
          switchCard(idOf('sync', 'dryRun'), t('settings.syncDryRun'), t('settings.syncDryRunDesc'),
            null, null, false, draft.sync.dryRun, (v) => patch('sync', 'dryRun', v))),
          h(GroupCard, {
            title: t('settings.groupPanel'), desc: t('settings.groupPanelDesc'),
          },
          numCard(idOf('panel', 'pollMs'), t('settings.pollMs'), t('settings.pollMsDesc'), null,
            draft.panel.pollMs, 5000, 600000, (v) => patch('panel', 'pollMs', v), { step: 1000 }),
          switchCard(idOf('panel', 'allowRemote'), t('settings.allowRemote'), t('settings.allowRemoteDesc'),
            draft.panel.allowRemote ? t('settings.allowRemoteWarn') : null, null, false,
            draft.panel.allowRemote, (v) => patch('panel', 'allowRemote', v)),
          selectCard(idOf('panel', 'tab'), t('settings.panelTab'), t('settings.panelTabDesc'), null,
            draft.panel.tab, tabOptions, (v) => patch('panel', 'tab', v))),
          h(GroupCard, {
            title: t('settings.groupAdvanced'), desc: t('settings.groupAdvancedDesc'),
          },
          selectCard(idOf('advanced', 'logLevel'), t('settings.logLevel'), t('settings.logLevelDesc'), null,
            draft.advanced.logLevel, logOptions, (v) => patch('advanced', 'logLevel', v)),
          switchCard(idOf('advanced', 'worker'), t('settings.worker'), t('settings.workerDesc'),
            null, null, false, draft.advanced.worker, (v) => patch('advanced', 'worker', v)),
          textCard(idOf('advanced', 'traceId'), t('settings.traceId'), t('settings.traceIdDesc'), null,
            draft.advanced.traceId, (v) => patch('advanced', 'traceId', v)),
          h(Note, null, t('settings.restartNote')))),
        h(GroupCard, {
          title: t('settings.groupDanger'), desc: t('settings.groupDangerDesc'),
        },
          h('div', { style: css.inline },
            h('a', {
              style: css.buttonPrimary,
              href: API + '/export',
              download: 'whale-memory.jsonl',
            }, t('settings.exportMemory'))),
          h('div', { style: css.note }, t('settings.dangerNote')),
          h('div', { style: css.metaGrid },
            h(Row, { k: t('settings.dataDir'), v: draft.dataDir || '—' }),
            h('div', { style: css.tertiary }, t('settings.readonlyTag')))),
        save.status === 'error'
          ? h('div', { style: css.errorBox },
            h('div', { style: css.error }, t('settings.saveFailed') + ' [' + save.code + '] — ' + errText(t, { code: save.code })),
            save.code === 'config_save_unavailable' || save.code === 'config_save_failed'
              ? h('div', { style: css.note }, t('settings.readonlyUnavailable')) : null)
          : null,
        save.status === 'ok'
          ? h('div', { style: css.ok }, t('settings.saved', { time: fmtTime(save.at, locale) })) : null,
        save.status === 'ok' && save.refreshFailed
          ? h('div', { style: css.warn }, t('settings.savedButReloadFailed')) : null,
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
      identityBadge: {
        display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '11px',
        color: 'var(--dsw-alias-label-secondary)', background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '999px',
        padding: '2px 8px', marginTop: '4px', maxWidth: '100%', wordBreak: 'break-all',
      },
      identityDot: { width: '6px', height: '6px', borderRadius: '50%', background: 'var(--dsw-alias-brand-primary)' },
      settingCard: {
        border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '8px', padding: '8px',
        background: 'var(--dsw-alias-bg-layer-2)', display: 'flex', flexDirection: 'column', gap: '4px',
      },
      settingCardDanger: {
        border: '1px solid var(--dsw-alias-state-error-primary)', borderRadius: '8px', padding: '8px',
        background: 'var(--dsw-alias-bg-layer-2)', display: 'flex', flexDirection: 'column', gap: '4px',
      },
      settingCardLocked: {
        border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '8px', padding: '8px',
        background: 'var(--dsw-alias-bg-layer-2)', display: 'flex', flexDirection: 'column', gap: '4px',
        opacity: 0.65,
      },
      settingHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' },
      settingMeta: {
        display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap',
        fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)',
      },
      badgeChip: {
        fontSize: '10px', padding: '1px 6px', borderRadius: '999px', whiteSpace: 'nowrap',
        color: 'var(--dsw-alias-label-secondary)', background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)',
      },
      metaDep: { fontSize: '11px', color: 'var(--dsw-alias-state-warn-primary)', lineHeight: 1.4 },
      groupDesc: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', lineHeight: 1.5, marginTop: '-2px' },
      backendStatus: {
        display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '11px',
        color: 'var(--dsw-alias-label-secondary)', marginTop: '2px', wordBreak: 'break-word',
      },
      backendStatusWarn: { color: 'var(--dsw-alias-state-warn-primary)' },
      sampleBox: {
        borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: '8px',
        display: 'flex', flexDirection: 'column', gap: '6px',
      },
      metaBlock: {
        borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: '6px',
        display: 'flex', flexDirection: 'column', gap: '2px',
      },
      effectBadge: {
        fontSize: '10px', padding: '1px 6px', borderRadius: '999px', whiteSpace: 'nowrap',
        color: 'var(--dsw-alias-label-secondary)', background: 'var(--dsw-alias-bg-layer-3)',
        border: '1px solid var(--dsw-alias-border-l1)',
      },
      fieldDesc: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', lineHeight: 1.5 },
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
      trendLegend: {
        display: 'flex', gap: '12px', flexWrap: 'wrap', fontSize: '12px',
        color: 'var(--dsw-alias-label-secondary)',
      },
      legendItem: { display: 'inline-flex', alignItems: 'center', gap: '4px' },
      legendDotBrand: { width: '8px', height: '8px', borderRadius: '50%', background: 'var(--dsw-alias-brand-primary)' },
      legendDotWarn: { width: '8px', height: '8px', borderRadius: '50%', background: 'var(--dsw-alias-state-warn-primary)' },
      trendScroll: { overflowX: 'auto' },
      trendList: { display: 'flex', flexDirection: 'column', gap: '6px', minWidth: '340px' },
      trendRow: { display: 'flex', alignItems: 'center', gap: '10px', fontSize: '12px' },
      trendDay: {
        display: 'flex', alignItems: 'center', gap: '4px', flex: '0 0 88px',
        color: 'var(--dsw-alias-label-secondary)', fontVariantNumeric: 'tabular-nums',
      },
      trendToday: { fontSize: '11px', color: 'var(--dsw-alias-state-success-primary)' },
      trendBars: { display: 'flex', flexDirection: 'column', gap: '3px', flex: 1, minWidth: '120px' },
      trendBarLine: { display: 'flex', alignItems: 'center', gap: '6px' },
      barTrack: {
        flex: 1, height: '6px', borderRadius: '999px',
        background: 'var(--dsw-alias-bg-layer-3)', overflow: 'hidden',
      },
      barFillBrand: {
        display: 'block', height: '100%', borderRadius: '999px',
        background: 'var(--dsw-alias-brand-primary)',
      },
      barFillWarn: {
        display: 'block', height: '100%', borderRadius: '999px',
        background: 'var(--dsw-alias-state-warn-primary)',
      },
      trendPct: {
        flex: '0 0 52px', textAlign: 'right', color: 'var(--dsw-alias-label-secondary)',
        fontVariantNumeric: 'tabular-nums',
      },
      failureRow: {
        display: 'flex', flexDirection: 'column', gap: '3px', padding: '5px 0',
        borderTop: '1px solid var(--dsw-alias-border-l1)',
      },
      failureHead: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'baseline', fontSize: '12px' },
      failureKind: { fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      failureError: {
        fontSize: '12px', color: 'var(--dsw-alias-state-error-primary)',
        wordBreak: 'break-word', lineHeight: 1.4,
      },
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
      resultSummary: { display: 'flex', flexDirection: 'column', gap: '2px', cursor: 'pointer' },
      muted: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px' },
      tertiary: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px' },
      warn: { color: 'var(--dsw-alias-state-warn-primary)', fontSize: '12px' },
      error: { color: 'var(--dsw-alias-state-error-primary)', fontSize: '12px' },
      ok: { color: 'var(--dsw-alias-state-success-primary)', fontSize: '12px' },
      warnBox: {
        border: '1px solid var(--dsw-alias-state-warn-primary)', borderRadius: '8px',
        padding: '6px 8px', fontSize: '12px', color: 'var(--dsw-alias-state-warn-primary)',
        background: 'var(--dsw-alias-bg-layer-2)', lineHeight: 1.5,
      },
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
        // 设置页「记忆中枢」分区：复用同一个 SettingsTab，只做入口，不复制开关逻辑。
        ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: PANEL_ID,
          order: 30,
          locale: NS,
          label: () => t('settings.sectionLabel'),
          inject: () => ({ t }),
        }, (ownerProps = {}) => h(SettingsTab, { t: ownerProps.t || t }))), 'whale-memory: settings section')
      },
    }
  },
})
