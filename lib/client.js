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

    // >>> locale:generated（由 scripts/i18n-check.mjs --write 生成，勿手改）
    const dict = {"zh":{"meta.title":"鲸忆记忆中枢","meta.description":"本地长期记忆中枢：把重要事实/规则存进本机 SQLite，对话前按身份召回并注入；面板可查、改、审核写入。默认不发任何外部请求；只有把后端切到 http/hybrid 时，才向配置的 URL 发 /stats /recent /search /recall /write /version。关掉插件＝不再召回/写入，库留在 ~/.dsh/whale-memory。；规则（铁律）以 ~/.dsh/rules 的 Markdown 为真源，git 版本化，提案经你确认后写入，数据库只做检索镜像。","meta.detail":"docs/DETAIL.zh.md","tab.overview":"概览","tab.memory":"记忆库","tab.recall":"召回","tab.writes":"写入与关系","tab.settings":"设置","common.dash":"—","common.retry":"重试","common.refresh":"刷新","common.loading":"读取中…","common.empty":"暂无数据","common.close":"关闭","common.save":"保存","common.saving":"保存中…","common.cancel":"取消","common.search":"搜索","common.prev":"上一页","common.next":"下一页","common.pageInfo":"第 {from}–{to} 条 / 共 {total} 条","common.total":"共 {total} 条","common.now":"刚刚","common.yes":"是","common.no":"否","common.charCount":"{n} / {max} 字","state.loading":"读取中…","state.error":"加载失败","state.empty":"暂无数据","health.db":"DB","health.migration":"迁移","health.pending":"pending","health.job":"job","health.ok":"正常","health.offline":"离线","health.running":"运行中","health.idle":"空闲","overview.title":"概览","overview.offlineTitle":"后端未连接","overview.offlineDesc":"记忆服务当前不可达。确认 DSH 已启动；恢复后可重试。","overview.recent":"最近 3 条召回","overview.recentEmpty":"暂无召回记录","overview.health":"健康状态","overview.scopeAll":"概览 KPI 为全库统计；记忆库页签按当前工作区展示。","overview.kpiNodes":"节点总数","overview.kpiActive":"活跃节点","overview.kpiRecalls":"今日召回","overview.kpiEdges":"关系边","overview.injected":"注入 {n} 字","overview.injectedNone":"未注入","overview.refreshed":"更新于 {time}","overview.hits":"命中 {n}","overview.injectedBadge":"已注入","overview.notInjectedBadge":"未注入","overview.kpiZeroInjection":"零注入率","overview.kpiAdoption":"采纳率","overview.kpiJobSuccess":"作业成功率（7 日）","overview.kpiDbSize":"库大小","overview.targetMet":"达标 · 目标 {target}","overview.targetMissed":"未达标 · 目标 {target}","overview.trend":"7 日曲线","overview.trendEmpty":"暂无 7 日数据","overview.trendInjected":"注入率","overview.trendZeroHit":"零命中占比","overview.trendToday":"今天","overview.trendTip":"{day}：召回 {recalls} · 命中 {withHits} · 注入 {injected} · 采纳 {adopted} · 零命中 {zeroHit}","overview.failures":"最近失败","overview.failuresEmpty":"近 24h 无失败作业","overview.failureAttempts":"尝试 {n}","memory.title":"记忆库","memory.searchPlaceholder":"输入关键词检索（防抖 300ms）…","memory.searching":"检索中…","memory.noResults":"没有命中","memory.emptyTitle":"记忆库还是空的","memory.emptyDesc":"先写第一条记忆，或从 JSONL 文件导入。","memory.writeFirst":"写第一条","memory.importJsonl":"导入 JSONL","memory.newTitle":"新增记忆","memory.writePlaceholder":"输入要记住的内容（≤500 字）…","memory.writeLevel":"层级","memory.writeType":"类型","memory.writeTags":"标签（逗号分隔）","memory.writeSubmit":"写入","memory.written":"已写入：{id}","memory.colText":"正文","memory.colLevel":"层级","memory.colType":"类型","memory.colStatus":"状态","memory.colScore":"分数","memory.colSource":"来源","memory.pageEmpty":"本页没有记录","memory.searchMeta":"命中 {count} 条（低于阈值的候选 {below} 条）","memory.searchMetaNoBelow":"命中 {count} 条","detail.title":"记忆详情","detail.text":"正文","detail.level":"层级","detail.status":"状态","detail.tags":"标签","detail.tagsPlaceholder":"逗号分隔","detail.source":"来源","detail.type":"类型","detail.created":"创建时间","detail.updated":"更新时间","detail.bitemporal":"双时态","detail.validAt":"生效时间","detail.invalidAt":"失效时间","detail.expiredAt":"过期时间","detail.supersededBy":"被替代为","detail.archive":"归档","detail.archived":"已归档","detail.saveEdit":"保存编辑","detail.saved":"已保存","detail.loadFailed":"读取详情失败","detail.invalidText":"正文需为 1–500 字","recall.title":"召回","recall.recent":"最近召回（只读）","recall.colTime":"时间","recall.colQuery":"查询","recall.colHits":"命中","recall.colChars":"字数","recall.colElapsed":"耗时","recall.colInjected":"是否注入","recall.colUsed":"采纳","recall.injectedYes":"已注入","recall.injectedNo":"未注入","recall.usedYes":"已采纳","recall.usedNo":"未采纳","recall.testTitle":"纯检索测试","recall.testNote":"只调用检索接口；不调模型、不写库、不产生召回副作用。","recall.testPlaceholder":"输入要测试的词…","recall.runTest":"检索","recall.testEmpty":"没有命中（低于最小相关度）","recall.testMeta":"返回 {count} 条 · {ms} ms","recall.testError":"检索失败","recall.recentEmpty":"暂无召回记录","writes.title":"写入与关系","writes.pendingTitle":"待审核的写入候选（shadow）","writes.pendingNote":"shadow 模式只记录候选、不落记忆库；接受后才写入，拒绝会留审计理由。","writes.colText":"候选文本","writes.accept":"接受","writes.reject":"拒绝","writes.reviewDone":"已审核，列表已刷新","writes.reviewFailed":"审核失败","writes.recent":"最近写入审计（只读）","writes.colTime":"时间","writes.colAction":"动作","writes.colNode":"节点","writes.colReason":"原因","writes.edges":"关系边","writes.recentCount":"最近写入","writes.note":"本页只读；写入由记忆接口与召回注入产生。","writes.empty":"暂无写入记录","settings.title":"设置","settings.groupBackend":"接入","settings.groupRecall":"注入","settings.groupWrite":"写入","settings.groupTools":"模型工具","settings.groupPanel":"面板","settings.groupAdvanced":"高级","settings.backendMode":"后端模式","settings.backendUrl":"外部服务地址","settings.backendTimeout":"请求超时（ms）","settings.recallEnabled":"启用召回注入","settings.maxHits":"最多命中条数","settings.charBudget":"注入字数上限","settings.intentBudget":"按意图分配注入预算（画图 0 注入）","settings.minRel":"最小相关度（0–1）","settings.recallTimeout":"召回超时（ms）","settings.writeEnabled":"启用写入","settings.toolsEnabled":"启用模型记忆工具","settings.reviewMode":"写入审核","settings.maxChars":"单条字数上限","settings.toolsMaxWritesPerTurn":"每回合写类工具上限","settings.searchFeed":"搜索摘要写入记忆（24h TTL）","settings.reflectEnabled":"启用空闲反思","settings.syncEnabled":"与网关同步记忆","settings.pollMs":"面板轮询间隔（ms）","settings.allowRemote":"允许非回环访问","settings.logLevel":"日志级别","settings.worker":"使用 worker 执行检索","settings.save":"保存设置","settings.saved":"已保存（{time}）","settings.saveFailed":"保存失败","settings.loadFailed":"读取配置失败","settings.defaultsNote":"只保存你改过的项；未回显的分组按默认值展示，不会写进配置。","settings.restartNote":"接入与 worker 变更通常需要重载插件后生效。","settings.allowRemoteWarn":"放开后只额外放行 webServer 绑定地址（读请求）；身份覆盖参数对非回环无效。","settings.readonlyUnavailable":"当前运行环境不支持保存配置（只读）。","settings.invalidValue":"存在超出范围或非数字的取值，请修正后再保存。","import.reading":"正在读取文件…","import.uploading":"正在导入…","import.tooLarge":"文件超过 4 MB，请拆分后导入。","import.readFailed":"文件读取失败。","import.smallDone":"导入完成：新增 {added} · 跳过 {skipped} · 错误 {errors}","import.progress":"导入中 {done}/{total} · 新增 {added} · 跳过 {skipped} · 错误 {errors}","import.done":"导入完成：新增 {added} · 跳过 {skipped} · 错误 {errors}","import.failed":"导入失败","import.total":"共 {total} 行","import.button":"导入 JSONL","sync.button":"与网关同步记忆","sync.dryTitle":"同步预演（未写入）","sync.pull":"拉取：新增 {added} / 跳过 {skipped} / 错误 {errors} / 行 {lines}","sync.push":"推送：{lines} 行","sync.confirm":"确认同步","sync.done":"同步完成","sync.busy":"同步中…","reflect.button":"反思","reflect.done":"反思完成：新增 {added} 条（素材 {material}）","reflect.busy":"反思中…","reflect.disabled":"反思未启用：去设置打开 reflect.enabled","import.export":"导出","import.accept":".jsonl,.txt,text/plain","status.active":"活跃","status.archived":"已归档","status.stale":"陈旧","status.superseded":"已替代","level.core":"核心","level.important":"重要","level.normal":"普通","type.semantic":"语义","type.procedural":"流程","type.episodic":"事件","type.mixed":"混合","source.owner":"主人","source.self":"自身","source.group":"群组","source.web":"网页","source.tool":"工具","source.import":"导入","err.network":"网络不可达，请确认 DSH 运行中。","err.backend_unreachable":"记忆后端不可达。","err.backend_unavailable":"记忆后端未提供该能力。","err.backend_error":"记忆后端返回错误。","err.invalid_query":"查询词不能为空。","err.invalid_text":"正文不合法（1–500 字）。","err.invalid_level":"层级取值不合法。","err.invalid_memory_type":"记忆类型不合法。","err.invalid_tags":"标签格式不合法。","err.identity_required":"缺少身份键，无法读写。","err.identity_mismatch":"身份与当前会话/配置不一致，已拒绝。","err.write_disabled":"写入已关闭。","err.duplicate":"内容已存在，已跳过。","err.node_not_found":"找不到该记忆节点。","err.job_not_found":"找不到该导入任务。","err.invalid_job_id":"导入任务 id 不合法。","err.config_save_unavailable":"当前环境不支持保存配置（只读）。","err.config_save_failed":"配置保存失败。","err.invalid_config":"配置内容不合法。","err.invalid_value":"存在超出范围的取值。","err.payload_too_large":"请求体过大（上限 4 MB）。","err.invalid_jsonl":"JSONL 内容不合法。","err.method_not_allowed":"接口不支持该请求方法。","err.not_found":"接口不存在。","err.not_loopback":"仅允许本机回环访问。","err.file_too_large":"文件超过 4 MB，请拆分后导入。","err.read_error":"文件读取失败。","err.unknown":"未知错误。","settings.groupIdentity":"身份","settings.groupReflect":"反思","settings.groupConsolidate":"巩固","settings.groupEmbed":"向量","settings.groupPrivacy":"隐私","settings.groupEdges":"关系","settings.groupSync":"同步","settings.groupDanger":"危险区","settings.groupBackground":"后台与同步","settings.identityMode":"身份模式","settings.identityModeDesc":"auto 由宿主会话推导身份；fixed 使用下方填写值。","settings.identityRoleIdDesc":"留空表示不限定角色。","settings.identityWorkspaceDesc":"留空表示当前工作区。","settings.reflectEnabledDesc":"空闲时调用模型整理记忆。","settings.syncEnabledDesc":"与网关双向同步记忆；桥地址由 profile 注入。","settings.identityUserId":"userId","settings.identityRoleId":"roleId","settings.identityWorkspace":"workspace","settings.identityAutoNote":"auto：userId 由宿主会话推导；当前版本回落 local。","settings.identityFixedNote":"fixed：使用下方填写值；userId 为空会导致读写失败。","settings.injectLevels":"允许注入的层级（逗号分隔）","settings.injectLevelsDesc":"例如 core,important；留空表示不限。","settings.showSources":"注入文本中显示来源","settings.showSourcesDesc":"在注入文本中附带节点来源。","settings.dailyCap":"每日写入上限","settings.dailyCapDesc":"每日写入条数上限。","settings.searchTtlHours":"搜索摘要 TTL（小时）","settings.searchTtlHoursDesc":"搜索摘要记忆的过期时间。","settings.judge":"写入判定器","settings.judgeDesc":"rules 走规则；llm 调模型判定。","settings.ignorePatterns":"忽略规则（每行一条）","settings.ignorePatternsDesc":"命中任一正则的文本不写入。","settings.writeModel":"写入判定模型（judge=llm 时使用）","settings.writeModelDesc":"留空使用当前默认模型。","settings.reflectModel":"反思模型","settings.reflectModelDesc":"留空使用当前默认模型。","settings.idleMinutes":"空闲触发（分钟）","settings.idleMinutesDesc":"用户空闲达到该时长后触发。","settings.maxItems":"单次最多新增","settings.maxItemsDesc":"每次反思最多新增的记忆条数。","settings.maxRunsPerDay":"每日最多运行","settings.maxRunsPerDayDesc":"每日反思运行次数上限。","settings.consolidateEnabled":"启用巩固","settings.consolidateEnabledDesc":"定时合并重复与过期节点。","settings.consolidateInterval":"巩固间隔（小时）","settings.consolidateIntervalDesc":"两次巩固之间的间隔。","settings.embedEnabled":"启用向量检索","settings.embedEnabledDesc":"需要外部向量服务；本机默认未接。","settings.embedEndpoint":"向量服务地址","settings.embedEndpointDesc":"兼容 OpenAI embeddings 的服务地址。","settings.embedModel":"向量模型","settings.embedModelDesc":"向量模型名。","settings.embedBatch":"向量批大小","settings.embedBatchDesc":"单批向量化条数。","settings.embedNote":"本机未接 provider；开启后 job 返回 unavailable。","settings.privacyRedact":"写入前脱敏","settings.privacyRedactDesc":"写入前替换敏感字段。","settings.privacyRetention":"归档保留天数（0=永久）","settings.privacyRetentionDesc":"0 表示永久保留。","settings.privacyDanger":"retentionDays>0 会物理删除过期归档。","settings.edgesDiffusion":"开启 1 跳关系扩散","settings.edgesDiffusionDesc":"召回时沿关系边扩一跳。","settings.edgesMinConf":"边的最小置信度","settings.edgesMinConfDesc":"低于该置信度的边不参与扩散。","settings.syncMode":"同步方向","settings.syncModeDesc":"off 关闭；push/pull/both 选择方向。","settings.syncInterval":"同步间隔（分钟）","settings.syncIntervalDesc":"定时同步的间隔。","settings.syncHttpTimeout":"同步超时（ms）","settings.syncHttpTimeoutDesc":"同步 HTTP 请求超时。","settings.syncBatch":"同步批大小","settings.syncBatchDesc":"单批同步条数。","settings.syncBridgeNote":"bridgeUrl 由 profile 注入，不在此编辑。","settings.panelTab":"默认页签","settings.panelTabDesc":"打开面板时默认选中的页签。","settings.pollMsDesc":"概览页自动刷新间隔。","settings.allowRemoteDesc":"仅本机回环默认可访问；打开后只额外放行绑定地址。","settings.traceId":"traceId（链路标记）","settings.traceIdDesc":"写入审计与日志的链路标记。","settings.logLevelDesc":"插件日志级别。","settings.workerDesc":"检索在 worker 线程执行，避免阻塞主线程。","settings.exportMemory":"导出记忆（下载 JSONL）","settings.dangerNote":"清空/重置接口未提供，当前版本无破坏性操作。","settings.dataDir":"数据目录（只读）","settings.dataDirDesc":"由宿主 profile 决定。","settings.readonlyTag":"只读","settings.effectInstant":"即时","settings.effectReload":"重挂","settings.effectLabel":"生效","settings.savedButReloadFailed":"已保存，但重新读取配置失败。","settings.backendModeDesc":"本地 SQLite 为默认；http/hybrid 走外部服务。","settings.backendUrlDesc":"仅 backend.mode 非 local 时使用。","settings.backendTimeoutDesc":"外部服务单次请求超时。","settings.recallEnabledDesc":"关闭后不注入任何记忆。","settings.maxHitsDesc":"每次召回最多注入条数。","settings.charBudgetDesc":"注入正文总字数上限；0=关闭注入（不注入任何记忆）。","settings.intentBudgetDesc":"画图等意图 0 注入。","settings.minRelDesc":"低于该相关度的候选被过滤。","settings.recallTimeoutDesc":"召回超时后 fail-open，不阻塞本轮。","settings.writeEnabledDesc":"关闭后写入与候选审核都停止。","settings.toolsEnabledDesc":"关闭后模型工具不出现在工具集里；面板写入与收尾入库不受影响。","settings.reviewModeDesc":"shadow 只记候选，auto 直接落库。","settings.maxCharsDesc":"单条记忆正文硬顶。","settings.toolsMaxWritesPerTurnDesc":"每个回合 remember/update/forget 的尝试次数上限，超限返回 RATE_LIMITED；只限模型工具，不影响收尾入库。","settings.searchFeedDesc":"搜索摘要作为记忆写入。","recall.explain":"可解释性","recall.explainHint":"展开查看评分分解","recall.colRel":"rel","recall.colMult":"mult","recall.colGain":"gain","recall.colEffWeight":"effWeight","recall.colPath":"命中路径","recall.colMatched":"命中词","recall.pathFallback":"L1/L2","recall.belowMin":"另有 {n} 条未过门","recall.noComponents":"该命中未返回评分分解","writes.pendingEmpty":"暂无待审","writes.edgesTitle":"关系边统计","writes.edgesEmpty":"暂无关系边","writes.evolutionTitle":"最近演化","writes.evolutionEmpty":"暂无演化记录","writes.colType":"类型","writes.colCount":"数量","writes.colFromTo":"关系","writes.colField":"字段","memory.candidateQueued":"已入待审队列（去写入页审核）","sync.disabled":"同步未启用：去设置打开 sync.enabled。","header.identity":"身份","header.identityTip":"当前记忆身份：{workspace} / {userId} / {roleId}","err.sync_disabled":"同步未启用（sync.enabled=false）。","err.sync_bridge_unset":"同步桥地址未配置（由 profile 注入 bridgeUrl）。","err.confirm_required":"缺少二次确认：同步需 confirm=true；彻底删除需 confirmKey 等于规则 key。","err.invalid_direction":"同步方向不合法（pull/push/both）。","err.busy":"已有同类任务在运行，请稍后再试。","err.reflect_unavailable":"反思调度器不可用。","err.candidate_not_found":"找不到该待审候选。","err.invalid_review":"审核参数不合法。","err.privacy":"内容触发隐私规则，已拒绝写入。","err.daily_cap":"已达到每日写入上限。","err.text_too_long":"正文超过字数上限。","err.unknown_error":"未知错误。","err.network_error":"网络不可达，请确认 DSH 运行中。","settings.defaultValue":"默认：{value}","settings.defaultOn":"开","settings.defaultOff":"关","settings.defaultEmpty":"空","settings.badgeGeneral":"通用","settings.badgeLocal":"本机","settings.badgeNeedsConfig":"需配置","settings.depUnmet":"依赖未满足：{reason}","settings.depBackendUrl":"仅 backend.mode 非 local 时生效","settings.depWriteModel":"仅 judge=llm 时使用","settings.depEmbed":"需先启用向量检索","settings.depSync":"需先启用同步","settings.depPanelRemote":"仅当允许非回环访问时对外生效","settings.effectDaily":"每日","settings.groupBackendDesc":"选本地库还是外部记忆服务；只有外部服务才需要地址与超时。","settings.groupIdentityDesc":"决定每条记忆归属谁、哪个工作区；auto 跟随宿主会话。","settings.groupRecallDesc":"每轮对话注入多少、多相关、哪些层级；直接影响回答的记性。","settings.groupWriteDesc":"决定什么内容会被记住、写前如何审核、单条与每日上限。","settings.groupToolsDesc":"模型侧记忆工具（memory_remember / memory_search / memory_read / memory_update / memory_forget）是否可见，以及每回合写类工具的尝试上限。","settings.groupReflectDesc":"空闲时让模型整理记忆；默认关闭，需要模型可用。","settings.groupConsolidateDesc":"定时合并重复与过期节点，避免库无限膨胀；默认开启。","settings.groupEmbedDesc":"接外部向量服务做语义检索；本机未接时保持关闭即可。","settings.groupPrivacyDesc":"写入前脱敏与归档保留期；保留期到期会物理删除。","settings.groupEdgesDesc":"召回时沿关系边扩一跳，并过滤低置信边。","settings.groupSyncDesc":"与网关双向同步记忆；桥地址由 profile 注入。","settings.groupPanelDesc":"本面板的刷新节奏、默认页签与访问范围。","settings.groupAdvancedDesc":"日志与检索线程等排障项；一般无需改动。","settings.groupDangerDesc":"导出备份入口；当前版本没有清空/重置接口，不提供破坏性按钮。","settings.backendId":"后端标识","settings.backendIdDesc":"服务注册与排障用的稳定标识；本机模式可留空。","settings.syncBridgeUrl":"同步桥地址","settings.syncBridgeUrlDesc":"由 profile 注入；此处手改的值会在下次加载配置时被覆盖。","settings.syncDryRun":"同步默认预演","settings.syncDryRunDesc":"开启时只比对差异，不写远端；真跑仍需在页头二次确认。","settings.charBudgetZeroConfirm":"charBudget=0 会关闭注入：本轮不再注入任何记忆。确定保存？","settings.sectionLabel":"记忆中枢","header.backendStatus":"后端：{mode} · 协议 {protocol} · outbox {outbox}","header.backendStatusTip":"来自 GET /version；接口不可用时各项显示 —","header.protocolOk":"OK","header.protocolMismatch":"不兼容","health.backend":"后端","health.protocol":"协议","health.outbox":"outbox","overview.migrationTitle":"迁移状态","overview.migrationPending":"迁移待确认","overview.migrationPendingDesc":"身份/数据迁移尚未确认；请到设置页检查后保存。","overview.migrationFrom":"迁移来源","overview.migrationAt":"迁移时间","overview.openSettings":"去设置页","overview.offlineBackendTitle":"未连接外部服务","overview.offlineBackendDesc":"后端为 http/hybrid，但外部服务地址为空；可一键切回本地库。","overview.switchLocal":"改用本地库","overview.switchLocalDone":"已切换到本地库","overview.switchLocalFailed":"切换失败","memory.sampleTitle":"试用样例","memory.sampleDesc":"写入 3 条示例记忆，随后可一键清理。","memory.sampleWrite":"写入样例","memory.sampleCleanup":"清理样例","memory.sampleCleanupConfirm":"清理会归档这 3 条样例（不删除历史，保留审计）。确定？","memory.sampleDone":"已写入 3 条样例","memory.sampleCandidate":"影子模式下样例进入待审队列，未直接写入","memory.sampleCleaned":"样例已归档","memory.sample1":"鲸忆记忆中枢默认使用本地 SQLite，不把记忆上传到云端。","memory.sample2":"每轮对话开始前，插件会按相关度召回少量记忆并注入上下文。","memory.sample3":"写入默认走 shadow 审核：候选先落审计，确认后才成为记忆。","recall.budgetTitle":"注入预算","recall.budgetLine":"字数上限 {chars} · 最多 {hits} 条 · 意图档 {intent}","recall.budgetIntentOn":"开","recall.budgetIntentOff":"关","recall.budgetZero":"0 字 = 关闭注入（不注入任何记忆）","recall.filterLabel":"筛选","recall.filterAll":"全部","recall.filterUnused":"未采纳","recall.filterZero":"零命中","recall.colSource":"来源","writes.rejectReason":"拒绝理由（可选）","writes.rewrite":"改写正文（可选）","writes.rewriteHint":"留空按原文接受；填写后先接受再改写该节点正文。","writes.confirmReview":"提交审核","writes.reviewFormTitle":"审核候选","writes.actionAdd":"新增","writes.actionNoop":"无操作","writes.actionMerge":"合并","writes.actionSupersede":"取代","writes.actionReject":"拒绝","writes.actionCandidate":"候选","writes.oldValue":"旧值","writes.newValue":"新值","detail.origin":"证据（origin）","detail.originUnavailable":"未提供","detail.edges":"1 跳邻居边","detail.edgesUnavailable":"未提供（/nodes/:id 未返回 edges）","detail.edgesEmpty":"暂无邻居边","detail.archiveConfirm":"归档不可撤销（审计可追溯）。确定归档这条记忆？","detail.saveConfirm":"编辑会改写正文并留下审计记录。确定保存？","header.rolePrefix":"角色：{roleId}","tab.rules":"规则","rules.intro":"规则＝可版本化的行为约束；铁律编号稳定、永不复用。","rules.gitTitle":"Git 版本库","rules.gitOk":"git {version}","rules.gitMissing":"未安装 git","rules.gitBroken":"git 状态异常","rules.gitUnknown":"git 状态未知","rules.gitRequiredHint":"设置要求 git：缺失时规则功能不可用","rules.gitChecked":"检查于 {time}","rules.gitGuide":"查看安装指引","rules.gitRefresh":"刷新 git 状态","rules.gitGuideTitle":"安装 git（可选）","rules.gitGuideIntro":"规则文件本身就是纯文本；git 只用于版本历史、diff 与回滚。按平台选一条命令：","rules.gitGuideBrew":"macOS（Homebrew）","rules.gitGuideApt":"Debian / Ubuntu","rules.gitGuideWinget":"Windows（winget）","rules.gitGuideDownload":"也可以从 git-scm.com/downloads 下载安装包","rules.gitGuideSnapshot":"未安装 git 时，历史 / diff / 回滚仍可用本地快照；只是没有提交记录，差异按快照逐行比较。","rules.dirLabel":"规则目录","rules.copyDir":"复制路径","rules.copied":"已复制","rules.copyFailed":"复制失败","rules.rebuildMirror":"重建镜像","rules.rebuilding":"重建中…","rules.rebuildConfirm":"重建镜像会把规则文件重新写入记忆库（供召回注入），不改动任何规则文件。确定继续？","rules.rebuildDone":"镜像已重建","rules.mirrorNote":"镜像＝规则文件在库里的副本，供面板检索；对话召回不读它。重建只读文件、不改文件。","rules.importLegacy":"从记忆库导入铁律","rules.importing":"导入中…","rules.importConfirm":"会把记忆库里的铁律节点复制成规则文件（编号稳定、不复用已有编号）。原记忆节点保持不变。确定继续？","rules.importDone":"已导入铁律","rules.importCount":"共 {n} 条","rules.filterLabel":"筛选","rules.filterAll":"全部","rules.filterIron":"铁律","rules.filterNormal":"普通规则","rules.filterCandidate":"候选","rules.filterRetired":"已退役","rules.searchPlaceholder":"按编号 / 标题 / 正文过滤…","rules.listMeta":"显示 {shown} / {total} 条","rules.colNumber":"编号","rules.colType":"类型","rules.colPriority":"优先级","rules.colScope":"作用域","rules.colStatus":"状态","rules.colUpdated":"更新时间","rules.colExcerpt":"摘要","rules.colOps":"操作","rules.detail":"详情","rules.detailTitle":"规则详情","rules.tableEmpty":"当前筛选没有规则","rules.proposalsTitle":"待确认 {n} 条","rules.proposalsEmpty":"暂无待确认提案","rules.emptyTitle":"规则文件还是空的","rules.emptyWhy":"为什么需要规则：它把「必须这么做」落成可 diff、可回滚的文本，聊天气泡里的约定不会再丢。","rules.emptyStepImport":"点「从记忆库导入铁律」，把现有铁律节点落成规则文件。","rules.emptyStepEdit":"规则文件在 ~/.dsh/rules（设置里可改目录），可用任意文本编辑器直接改。","rules.emptyStepRefresh":"改完回来点刷新即可；开启「镜像自动重建」后，面板读到的是最新文件。","rules.statusActive":"生效","rules.statusCandidate":"候选","rules.statusRetired":"已退役","rules.statusMerged":"已合并","rules.statusSuperseded":"已取代","rules.statusDraft":"草稿","rules.statusProposed":"待确认","rules.typeIron":"铁律","rules.typeNormal":"普通规则","rules.fieldNumber":"编号","rules.fieldType":"类型","rules.fieldPriority":"优先级","rules.fieldScope":"作用域","rules.fieldRole":"角色","rules.fieldStatus":"状态","rules.fieldCreated":"创建","rules.fieldUpdated":"更新","rules.fieldVersion":"版本","rules.fieldOrigin":"来源","rules.fieldPath":"文件路径","rules.fieldMergedInto":"合并到","rules.fieldSupersededBy":"被取代为","rules.bodyTitle":"完整正文","rules.conditions":"条件","rules.exceptions":"例外","rules.none":"暂无","rules.history":"历史版本","rules.historyEmpty":"暂无历史版本","rules.historySourceGit":"git","rules.historySourceSnapshot":"快照","rules.historyHint":"选中一个版本，与当前正文逐行对比","rules.diff":"版本对比","rules.diffOld":"旧","rules.diffNew":"新","rules.diffEmpty":"这个版本与当前正文一致","rules.rollback":"回滚到此版本","rules.edit":"编辑","rules.fieldKey":"标识（key）","rules.editTitle":"编辑规则","rules.editHint":"只改正文与结构化字段；保存会写规则文件、生成新版本，历史可回滚。","rules.editImmutableNote":"key、类型与编号只读，不可修改（编号稳定、永不复用）。","rules.editTextLabel":"正文（≤500 字）","rules.editConditionsLabel":"条件（每行一条）","rules.editExceptionsLabel":"例外（每行一条）","rules.editScopeLabel":"作用域","rules.editScopeValueLabel":"作用域值","rules.editScopeGlobal":"全局","rules.editScopeWorkspace":"工作区","rules.editScopeRole":"角色","rules.editScopeOther":"其他（保留原值）","rules.editScopeWorkspacePlaceholder":"工作区绝对路径，如 /srv/project","rules.editScopeRolePlaceholder":"角色 id（不含空格）","rules.editScopeInvalid":"作用域值不合法：工作区需绝对路径，角色 id 不能含空格。","rules.editPriorityLabel":"优先级","rules.editStatusLabel":"状态","rules.editStatusActive":"生效（active）","rules.editStatusRetired":"退役（retired）","rules.editRetiredHint":"退役＝不再注入，但文件与历史完整保留。","rules.editRetireConfirm":"退役后这条规则不再注入，但文件与历史完整保留。确定退役？","rules.editPreview":"预览变更","rules.editPreviewTitle":"变更预览","rules.editPreviewFieldText":"正文","rules.editPreviewFieldConditions":"条件","rules.editPreviewFieldExceptions":"例外","rules.editPreviewFieldScope":"作用域","rules.editPreviewFieldPriority":"优先级","rules.editPreviewFieldStatus":"状态","rules.editDiffServerNote":"diff 基线取自服务端认定的当前正文。","rules.editDiffLocalNote":"没有可用的当前版本信息，已改为本地逐行对比。","rules.editDiffFieldsOnly":"正文没有变化，只改结构化字段","rules.editBack":"返回修改","rules.editSubmit":"确认提交","rules.editConfirm":"提交会写入规则文件、生成新版本（历史保留），并刷新 AGENTS 摘要。确定提交？","rules.editDone":"规则已保存","rules.editNoChange":"没有可提交的改动","rules.editInvalidText":"正文需为 1–500 字","rules.agentsSynced":"AGENTS 摘要随后同步（规则文件为真源）","rules.currentRev":"当前","rules.currentRevHint":"该版本就是当前版本，回滚已禁用。","rules.rollbackHint":"回滚会以该版本内容生成新版本，历史不删除。","rules.rollbackSelectHint":"先在历史里选中一个版本","rules.rollbackCurrentHint":"当前版本无需回滚","rules.revertConfirm":"回滚会把该版本内容写成新版本（提交历史全部保留，不删除任何记录）。确定回滚？","rules.revertDone":"已回滚到该版本","rules.revertBusy":"回滚中…","rules.diffServerFail":"服务端 diff 不可用，已退回本地逐行对比。","rules.diffLoading":"读取 diff…","rules.errGitHint":"安装 git（见规则页「安装指引」），或在设置里关闭「必须有 git」。","rules.errInvalidDetail":"字段提示：{detail}","rules.opFailed":"操作失败","settings.groupRules":"规则","settings.groupRulesDesc":"规则文件的目录、git 门控、提案节奏与镜像；关掉规则＝不检测、不注入、不提案，文件仍可管理。","settings.rulesEnabled":"规则功能","settings.rulesEnabledDesc":"关闭＝不检测 / 不注入 / 不提案；规则文件仍可在「规则」页管理。","settings.rulesDir":"规则目录","settings.rulesDirDesc":"留空＝~/.dsh/rules；改目录后需重建镜像。","settings.rulesRequireGit":"必须有 git","settings.rulesRequireGitDesc":"打开后 git 缺失时规则功能禁用（历史 / diff / 回滚也不可用）；默认关，用本地快照兜底。","settings.rulesAskMode":"提案询问方式","settings.rulesAskModeDesc":"panel+chat＝面板与对话都可询问；panel＝仅面板；off＝不主动询问。","settings.rulesAskPanelChat":"面板 + 对话","settings.rulesAskPanel":"仅面板","settings.rulesAskOff":"关闭","settings.rulesLlm":"用模型润色规则","settings.rulesLlmDesc":"打开后用模型把候选提案写成规则句式；默认关，避免额外模型调用与费用。","settings.rulesMaxProposals":"提案上限","settings.rulesMaxProposalsDesc":"同时保留的待确认提案上限（超出按时间淘汰）。","settings.rulesGuardStrict":"严格守卫","settings.rulesGuardStrictDesc":"注入前按规则强校验，冲突即拦截；关闭＝只告警。","settings.rulesMirrorAuto":"自动重建镜像","settings.rulesMirrorAutoDesc":"规则文件变化后自动同步进 DB 供召回；关闭＝手动点「重建镜像」。","settings.rulesAskCooldownDays":"询问冷却（天）","settings.rulesAskCooldownDaysDesc":"同一规则再次询问的最短间隔，0＝每次都问。","settings.rulesConfigLayerNote":"另有四个只在配置文件层生效的键（面板不提供开关）：rules.renderAgents（是否重渲染 AGENTS 摘要）、rules.injectChars（每轮注入字符预算，0=关闭）、rules.createAgentsIfMissing（空机是否自动创建 AGENTS 管理块）、rules.summaryBudgetChars（摘要总预算码点，默认 6000）。改它们需编辑插件配置并重启宿主。","settings.depRulesEnabled":"规则功能已关闭，此项不生效","rules.typeCandidate":"候选规则","rules.importSkipped":"该铁律已存在，未重复导入","err.rules_disabled":"规则功能已关闭（设置 → 规则）","err.git_required":"设置要求 git，但未检测到可用的 git：请安装 git，或关闭「必须有 git」（rules.requireGit）","err.rule_not_found":"规则不存在（可能已删除或改名）","err.invalid_patch":"提交的修改内容不合法","err.immutable_field":"该字段不可修改（key / 类型 / 编号 只读）","err.invalid_rule":"规则校验未通过","err.rev_not_found":"该版本不存在或已被清理","err.rule_guard_failed":"规则守卫未通过","err.rule_proposal_not_found":"提案不存在或已处理","err.rule_proposal_expired":"提案已过期","err.invalid_acknowledge":"确认丢弃的子句格式不合规：必须逐条列出（规则 key + 子句），不接受整条规则一键放行。","rules.gitMissingDetail":"无 git 时仍可用本地快照做历史 / diff / 回滚","rules.proposalsCount":"待确认 {n}","rules.proposalsJump":"跳到待确认提案","rules.proposalLoading":"读取提案中…","rules.proposalError":"提案读取失败","rules.relNew":"新规则","rules.relDuplicate":"重复","rules.relRefine":"细化","rules.relMerge":"合并","rules.relConflict":"冲突","rules.relUnrelated":"无关","rules.proposalStatusPending":"待确认","rules.proposalStatusNeedsManual":"需人工","rules.proposalStatusAccepted":"已收录","rules.proposalStatusRejected":"已拒绝","rules.proposalStatusExpired":"已过期","rules.proposalSource":"来源片段","rules.proposalMeta":"编号 {number} · 优先级 {priority} · 作用域 {scope}","rules.proposalAffected":"受影响旧规则","rules.proposalOld":"旧","rules.proposalNew":"新","rules.proposalChanged":"有改动","rules.proposalPreserved":"保留子句","rules.proposalDropped":"丢弃子句","rules.proposalGuardFailed":"守卫未通过","rules.proposalRiskTitle":"高风险操作","rules.proposalRiskGuard":"守卫校验未通过，服务端可能拒绝收录。","rules.proposalRiskDropped":"本次收录会丢弃 {n} 条子句。","rules.proposalAckDropped":"我已确认删除这些子句","rules.proposalAckHint":"先勾选「我已确认删除这些子句」再收录","rules.proposalApply":"收录","rules.proposalRewrite":"改写","rules.proposalReject":"拒绝","rules.proposalRejectReason":"理由（可选）","rules.proposalRejectPlaceholder":"一句话说明为什么拒绝…","rules.proposalRejectConfirm":"确认拒绝这条提案？30 天内不会再问同一条。","rules.proposalRejectConfirmAction":"确认拒绝","rules.proposalApplyConfirm":"收录会写入规则文件、创建 git commit、渲染 AGENTS.md 并重建记忆镜像。确定继续？","rules.proposalApplied":"已收录","rules.proposalRejected":"已拒绝","rules.proposalCooldown":"30 天内不会再问同一条","rules.proposalCooling":"冷却中：同一条提案暂不会再生成","rules.proposalExpand":"展开全文","rules.proposalCollapse":"收起","rules.proposalRewriteTitle":"改写提案正文","rules.proposalRewriteHint":"正文/条件/例外/作用域都可改；提交后按新正文收录。","rules.proposalRewriteNote":"条件/例外/作用域会作为正文片段提交（服务端按单条正文决策）。","rules.proposalRewriteSubmit":"按此文收录","rules.proposalRewriteEmpty":"正文不能为空","rules.proposalEditorText":"正文","rules.proposalEditorConditions":"条件（每行一条）","rules.proposalEditorExceptions":"例外（每行一条）","rules.proposalEditorScope":"作用域","rules.proposalManualTitle":"手动提案","rules.proposalManualHint":"贴一段要求，服务端会编译成候选规则，确认后才会落文件。","rules.proposalManualPlaceholder":"例如：以后网关改口必须带编号与日期……","rules.proposalManualSubmit":"提交提案","rules.proposalManualDone":"提案已创建，见上方待确认区","rules.new":"新建规则","rules.newTitle":"新建规则","rules.newHint":"填正文与结构化字段；编号与 key 由服务端分配。保存会写规则文件并留 git 历史。","rules.newTypeLabel":"类型","rules.newAutoAssign":"保存后自动分配","rules.newAutoAssignNote":"编号与 key 只读：铁律编号稳定、永不复用；普通规则也会自动分配编号。","rules.newActionLabel":"动作（可选）","rules.newObjectLabel":"对象（可选）","rules.newActionPlaceholder":"留空则从正文自动抽取","rules.newObjectPlaceholder":"留空则从正文自动抽取","rules.newTextPlaceholder":"用一句祈使句写清必须怎么做…","rules.newConfirm":"保存会：写入规则文件、创建 git commit、重建记忆镜像、渲染 AGENTS 摘要。确定创建这条规则？","rules.newSubmit":"确认创建","rules.newDone":"规则已创建","rules.newTypeInvalid":"规则类型不合法（铁律 / 普通规则）","rules.newPriorityInvalid":"优先级不合法（P0–P3）","rules.retire":"停用","rules.retireConfirm":"停用后这条规则不再注入/生效；规则文件、历史版本与编号全部保留，可随时重新启用。确定停用？","rules.retireDefaultHint":"这是默认铁律，停用后本机不再生效；可用同编号历史重新启用。","rules.retiredBadge":"已停用","rules.reactivate":"重新启用","rules.reactivateConfirm":"重新启用后这条规则恢复注入/生效；编号、文件与历史都不变。确定重新启用？","rules.retireDone":"规则已停用","rules.reactivateDone":"规则已重新启用","rules.toggleUnavailable":"只有生效或已停用的规则可以切换状态","rules.purge":"删除","rules.purgeHint":"彻底删除规则文件（不可撤销；编号作废、永不复用；历史快照仍可追溯）","rules.purgeKeyLabel":"输入规则 key「{key}」才能删除（输入不符不会发请求）","rules.purgeKeyPlaceholder":"在此输入 key","rules.purgeConfirm":"彻底删除会物理删除这条规则文件，不可撤销；它的编号作废、永不复用（不会分配给以后新建的规则）。删除前的最后一版正文会留在历史快照里，仍可在 git 与 history 目录追溯。确定彻底删除？","rules.purgeDefaultHint":"这是安装自带的默认铁律：删除后不会自动恢复（默认播种只执行一次）。确需恢复时，可从历史快照或备份中人工找回。","rules.purgeDone":"规则已彻底删除（文件已删除，编号已作废）","rules.purgeNumberRetired":"编号 #{number} 作废、永不复用；下一个编号 #{next}","rules.defaultBadge":"默认","rules.defaultOriginNote":"安装自带默认铁律：由插件在安装/升级时写入，可修改、停用或删除；编号保留、历史可回滚。","rules.defaultNotice":"插件自带默认铁律（安装时已写入）。你可以修改、停用或删除；编号保留、历史可回滚。","rules.emptyNoActive":"没有生效中的规则，去『已退役』筛选可重新启用","err.already_retired":"这条规则已经是停用状态，无需重复停用","err.not_retired":"这条规则当前是生效状态，无需重新启用","err.invalid_draft":"规则草稿不合法（正文 / 类型 / 优先级 / 作用域），请检查后重试","err.duplicate_rule":"同样正文的普通规则已存在（key 重复）；请改正文，或直接编辑已有规则。","err.proposal_not_found":"提案不存在或已处理","err.proposal_not_pending":"提案已不在可处理状态（可能已被收录或拒绝）","err.rule_locked":"规则文件正被其他写入占用，请稍后重试","err.diff_too_large":"版本过大无法逐行对比（超过 5000 行）","err.needs_manual":"候选项需要人工改写后重试","err.llm_unavailable":"面板没有可用模型，请改写措辞后重试","err.llm_unparseable":"模型返回的措辞无法解析，请改写后重试","err.llm_error":"模型调用失败，请改写后重试","err.commit_failed":"git 提交失败，改动已回滚","err.write_failed":"规则文件写入失败","err.affected_write_failed":"受影响规则写入失败，改动已回滚","err.invalid_json":"请求体不是合法 JSON","err.invalid_key":"规则 key 不合法（只允许小写字母、数字与连字符）","err.invalid_mode":"动作模式不合法（只允许 retire / reactivate / purge）","err.invalid_rev":"版本标识不合法","err.empty_text":"正文不能为空","err.ensure_failed":"规则仓库初始化失败（检查目录权限与 git）","err.proposal_corrupt":"提案内容损坏（缺少 key），无法应用","err.plan_unavailable":"应用计划能力尚未上线（core plan 未导出）","err.restore_unavailable":"恢复默认能力尚未上线","err.plan_failed":"生成应用计划失败","err.restore_failed":"恢复默认规则失败","err.unsupported_media_type":"写接口只接受 Content-Type: application/json","err.cross_origin_denied":"拒绝跨源写入：只允许本机 GUI / 本机 curl","err.no_markers":"AGENTS 里没有摘要标记块，未写入（需要手动放标记）","err.render_failed":"AGENTS 摘要渲染失败","rules.proposalNeedsManual":"这条候选项需要人工处理：自动改写未通过守卫，可改写正文后重试。","rules.proposalNeedsManualCode":"失败码：{code}","rules.proposalRewriteRetry":"改写后重试","rules.restoreDefault":"恢复默认","rules.restoreDefaultConfirm":"将用安装自带默认正文覆盖这条规则并生成新版本（历史保留）。继续？","rules.restoreDefaultDone":"已恢复为默认正文 · AGENTS 摘要随后同步","rules.emptyRetiredAction":"查看已退役","err.render_disabled":"AGENTS 摘要渲染已关闭（设置 → 规则 → 渲染 AGENTS 摘要）","err.plan_hash_mismatch":"计划已过期（planHash 不一致），请重新生成计划再应用","err.plan_stale":"计划已落后于磁盘改动，请重新生成计划","err.number_retired":"目标编号已进墓碑、永不复用，不能再分配","err.target_conflict":"目标规则在计划生成后被改动，请重新计划","err.target_missing":"目标规则已不存在，请重新提案","err.affected_missing":"受影响规则已不存在，请刷新候选后重试","err.affected_inactive":"受影响规则已停用（文件仍在），先启用或改选受影响规则","err.number_exhausted":"1–999 已无可用铁律编号","err.lock_failed":"规则仓库锁占用超时，请稍后重试","err.txn_failed":"应用事务写入失败，改动已回滚","err.repo_locked":"规则仓库正被其他写入占用，请稍后重试（不会自动抢占活进程的锁）","err.git_unavailable":"git 不可用：写操作已降级为「文件已写、未提交」，请检查 git 安装或关闭「必须有 git」","err.manifest_failed":"manifest 写入失败，本次改动已回滚（文件/墓碑/索引均已恢复）","err.tombstone_failed":"墓碑写入失败，彻底删除未执行（规则文件仍在）","err.unprocessable":"请求无法处理（参数或状态不合法）","err.server_error":"服务端处理失败，请稍后重试或查看日志","rules.proposalNumberAdjusted":"编号已顺延：#{from} → #{to}","rules.proposalSemantic":"语义稿","rules.proposalRefining":"提炼中","err.duplicate_active":"已有相同内容的活跃记忆。","err.node_changed":"这条记忆刚被其他操作修改，请刷新后重试。","err.target_not_active":"目标记忆已失效，不能执行该操作。","settings.firstRunTitle":"推荐配置（首次使用）","settings.firstRunDesc":"下面这些是本地、可逆的开关。点击后会只写入与你当前值不同的项；需要模型或地址的项可以暂时不选。","settings.firstRunApply":"应用推荐","settings.firstRunLater":"暂不设置","settings.firstRunLocalOn":"已开箱启用","settings.firstRunReflect":"开启反思（需要默认模型）","settings.firstRunReflectNote":"空闲时用 DSH 默认模型把近期经历提炼成记忆；没有可用模型时不会产出。","settings.firstRunSync":"开启记忆同步（已配置桥地址）","settings.firstRunSyncNote":"先以预演（dry-run）模式运行，只记录待同步项，不改远端；确认无影响后再关闭预演。","settings.firstRunSyncUnset":"同步需要先填桥地址（设置 → 同步），当前未配置。","settings.firstRunSafety":"写入默认是影子模式：先记账、不生效；可在设置里改成自动。","settings.recommend":"推荐开启","settings.collapse":"收起","settings.expand":"展开","settings.manualLink":"看不懂名词？打开使用说明的术语表","manual.button":"使用说明","manual.title":"鲸忆使用说明","manual.close":"关闭","manual.zhOnly":"本手册当前为中文版（随插件离线携带）。","err.ignored":"命中忽略规则，未写入","overview.wrapTitle":"会话收尾","overview.wrapNow":"立即收尾","overview.wrapBusy":"收尾中…","overview.wrapEmpty":"还没有收尾记录。说完一段后点「立即收尾」，或在对话里说「收尾」。","overview.wrapUnsupported":"当前后端模式不支持收尾（需要 local/hybrid 本地库）。","overview.wrapLoadFailed":"收尾状态读取失败","overview.wrapCandidates":"待审","overview.wrapIngested":"入库","overview.wrapSkippedCount":"跳过","overview.wrapProposals":"规则提案","overview.wrapOpenLoops":"待办","overview.wrapSwitchReady":"可切会话","overview.wrapReadyYes":"是","overview.wrapReadyNo":"否","overview.wrapBlockers":"未就绪：{list}","overview.wrapLastError":"最近错误","overview.wrapSkipped":"最近跳过：{reason}","overview.wrapQueued":"已入队：run {id}","overview.wrapFailed":"收尾失败","overview.wrapShowReport":"查看报告","overview.wrapHideReport":"收起报告","overview.wrapReportFailed":"报告读取失败","wrap.stateQueued":"排队中","wrap.stateRunning":"运行中","wrap.stateDone":"已完成","wrap.stateFailed":"失败","wrap.stateSkipped":"已跳过","wrap.triggerExplicit":"显式收尾","wrap.triggerIdle":"空闲触发","wrap.triggerDisposed":"会话关闭","wrap.triggerManual":"面板触发","writes.filterWrap":"只看收尾候选（{n}）","writes.pendingNoWrap":"当前没有收尾候选","writes.originSessionWrap":"收尾","settings.groupWrap":"收尾沉淀","settings.groupWrapDesc":"会话结束时提炼教训/决策/待办，写 shadow 候选与规则提案；默认不自动接受。","settings.wrapEnabled":"启用会话收尾","settings.wrapEnabledDesc":"满足触发条件时运行一次有界提炼。","settings.wrapCostNote":"会花模型 token（每次至多一次调用，受每日上限约束）。","settings.wrapExplicit":"显式收尾","settings.wrapExplicitDesc":"对话里说「收尾/换会话/记一下这次教训」后，回合结束入队。","settings.wrapIdle":"空闲收尾","settings.wrapIdleDesc":"默认关。无进行中的回合且超过空闲分钟数时入队；同一段材料只跑一次。","settings.wrapDisposed":"会话关闭收尾","settings.wrapDisposedDesc":"默认关。会话被关闭/归档时把缓冲落 spool 并入队。","settings.wrapIdleMinutes":"空闲分钟数","settings.wrapIdleMinutesDesc":"默认 10 分钟；太短容易在长任务中途误触发。","settings.wrapMaxItems":"最多条目","settings.wrapMaxItemsDesc":"一次提炼最多保留多少条候选/提案。","settings.wrapMaxRunsPerDay":"每日自动上限","settings.wrapMaxRunsPerDayDesc":"只限制空闲/关闭触发；显式收尾是人工动作，不受此限。","settings.wrapIngestMode":"普通记忆入库","settings.wrapIngestModeDesc":"auto：通过价值闸的长期规则直接入库；review：全部进审核候选（=0.7.3 回退，永不自动落库）。","settings.wrapIngestAuto":"auto（自动入库）","settings.wrapIngestReview":"review（全部审核）","settings.wrapIngestMinConfidence":"最低置信度","settings.wrapIngestMinConfidenceDesc":"收尾模型未给 confidence 时按 0.5 计；低于此值转人工审核。","settings.wrapIngestDropTask":"任务句直接拒绝","settings.wrapIngestDropTaskDesc":"开：任务指令不入长期库；关：任务句转审核候选（仍不入库）。","settings.wrapReport":"写收尾报告","settings.wrapReportDesc":"在数据目录 reports/ 生成不含原始对话的 Markdown 报告。","settings.wrapModel":"收尾模型","settings.wrapModelDesc":"空=用当前默认模型；填写则覆盖模型 id（provider 仍取默认选择）。","settings.wrapMaxMaterialChars":"材料字数上限","settings.wrapMaxMaterialCharsDesc":"只取最近对话，超过按整轮丢弃；默认 12000 码点。","settings.wrapSpoolTtlHours":"spool 保留小时","settings.wrapSpoolTtlHoursDesc":"失败/无模型时保留原始材料供重试；超时自动删除，不进灾备。","settings.wrapTimeoutMs":"模型超时毫秒","settings.wrapTimeoutMsDesc":"单次提炼的硬超时；超时按失败重试，不阻塞对话。","settings.wrapNote":"候选默认 shadow；规则只生成提案，不自动改规则文件。","settings.firstRunWrap":"启用会话收尾沉淀","settings.firstRunWrapNote":"显式说「收尾」时调用模型提炼，消耗 token；空闲/关闭自动收尾默认关，可在设置里打开。","err.wrap_unavailable":"收尾服务未安装","err.wrap_disabled":"会话收尾已关闭","err.no_material":"没有可收尾的会话材料","err.turn_in_progress":"当前回合未结束，稍后再试","err.unsupported_backend":"当前后端模式不支持收尾","err.rate_limited":"今日自动收尾已达上限","err.same_material":"同一段材料已收尾","err.report_missing":"收尾报告不存在","err.report_path_outside":"报告路径越界，已拒绝","overview.wrapDisabled":"会话收尾已关闭；到「设置 → 收尾沉淀」启用。","err.busy_wrap":"已有收尾任务在跑，稍后再试（可能在别的会话）","settings.wrapRetentionDays":"台账/报告保留天数","settings.wrapRetentionDaysDesc":"默认 180 天；0=永久。只清理已结束的收尾记录与不再被引用的报告，排队/运行中的不删。","health.queued":"排队","overview.wrapSessionLabel":"会话","overview.wrapSessionRecent":"最近有材料的会话","overview.wrapSessionSelected":"已选会话 · {turns} 轮","overview.wrapSessionOption":"{turns} 轮 · {state}","overview.wrapSessionRunning":"进行中","overview.wrapNoSession":"当前没有已采集的会话；聊几句再回来。","overview.wrapEmptyGuide":"选一个会话点「立即收尾」，或在对话里说「收尾」。","overview.wrapQueuedPosition":"已排队，请稍等（第 {n} 位）","overview.wrapExisting":"这段正在收尾/已收尾过（有新对话才会重跑）","overview.wrapWarnings":"提醒：{list}","overview.wrapRetryable":"可重试","overview.wrapFailureCount":"最近失败 {n} 条 · 展开","overview.wrapFailureHide":"收起失败","overview.wrapReportEmpty":"还没有报告内容。","overview.wrapErrorTurn":"当前会话正在回复，等它结束或换一个会话","overview.wrapErrorNoMaterial":"这个会话还没有可收尾的对话","overview.wrapErrorDisabled":"收尾功能已关闭","overview.wrapErrorUnsupported":"当前后端不支持本地收尾","overview.wrapErrorNoSession":"会话已不存在，刷新后再选","overview.wrapErrorSame":"这段已经收尾过了（有新对话才会重跑）","overview.wrapErrorBusy":"队列已满，请稍后重试","overview.wrapErrorSessionBusy":"本会话已有一条排队，完成后再试","overview.wrapErrorCapture":"采集器未就绪，稍后再试","overview.wrapErrorDb":"记忆库读写失败，稍后重试","overview.wrapErrorBadJson":"模型输出不是 JSON，已重试仍失败","overview.wrapErrorTimeout":"模型调用超时","overview.wrapErrorSpool":"会话材料丢失，请重试","overview.wrapErrorWrite":"候选写入失败","overview.wrapProgress":"收尾进度","overview.wrapPhaseQueued":"排队","overview.wrapPhaseCapture":"采集","overview.wrapPhaseDistill":"蒸馏","overview.wrapPhaseDispatch":"分流","overview.wrapPhaseReport":"报告","overview.wrapRetrying":"正在重试 {n}/{max}","overview.wrapSkipCleared":"队列已清理，如需收尾请再点","overview.wrapSkipTimeout":"排队超时已取消，请重试","overview.wrapSkipDisposed":"会话已关闭，排队取消","overview.wrapSkipBusy":"已有任务在跑，本次跳过","overview.wrapSkipRate":"已达今日自动收尾上限","err.queue_cleared":"收尾队列已随重启清理，请重新发起","err.session_queue_full":"本会话已有一条排队，完成后再试","err.busy_queue_full":"收尾队列已满，请稍后重试","overview.wrapAuto":"自动收尾","overview.wrapAutoDesc":"空闲 {n} 分钟触发 · 会花 token","overview.wrapSkipAuto":"跳过自动收尾","overview.wrapSkipAutoDesc":"只影响空闲/关闭自动触发，手动仍可收尾","overview.wrapSessionSkipped":"已跳过自动","err.invalid_session":"会话 id 不合法","overview.wrapPhaseReconcile":"整合","overview.wrapCopyReport":"复制报告","overview.wrapDownloadReport":"下载 .md","overview.wrapSessionLoadFailed":"会话列表读取失败"},"en":{"meta.title":"Whale Memory","meta.description":"Local long-term memory: stores important facts/rules in a local SQLite database, recalls and injects them by identity before each turn, and lets the panel inspect, edit and review writes. No external requests by default; only with backend=http/hybrid does it call the configured URL (/stats /recent /search /recall /write /version). Disable the plugin to stop recall/writes; the database stays in ~/.dsh/whale-memory. Rules (iron laws) live as Markdown under ~/.dsh/rules with git versioning; proposals are written only after your confirmation, and the database is a search mirror.","meta.detail":"docs/DETAIL.en.md","tab.overview":"Overview","tab.memory":"Memory","tab.recall":"Recall","tab.writes":"Writes & edges","tab.settings":"Settings","common.dash":"—","common.retry":"Retry","common.refresh":"Refresh","common.loading":"Loading…","common.empty":"No data","common.close":"Close","common.save":"Save","common.saving":"Saving…","common.cancel":"Cancel","common.search":"Search","common.prev":"Previous","common.next":"Next","common.pageInfo":"{from}–{to} of {total}","common.total":"{total} total","common.now":"just now","common.yes":"Yes","common.no":"No","common.charCount":"{n} / {max} chars","state.loading":"Loading…","state.error":"Failed to load","state.empty":"No data","health.db":"DB","health.migration":"Migration","health.pending":"pending","health.job":"job","health.ok":"OK","health.offline":"Offline","health.running":"Running","health.idle":"Idle","overview.title":"Overview","overview.offlineTitle":"Backend unreachable","overview.offlineDesc":"The memory service is not reachable. Confirm DSH is running, then retry.","overview.recent":"Latest 3 recalls","overview.recentEmpty":"No recall records yet","overview.health":"Health","overview.scopeAll":"Overview KPIs are all-partition totals; the Memory tab is scoped to the current workspace.","overview.kpiNodes":"Total nodes","overview.kpiActive":"Active nodes","overview.kpiRecalls":"Recalls today","overview.kpiEdges":"Edges","overview.injected":"{n} chars injected","overview.injectedNone":"not injected","overview.refreshed":"Updated {time}","overview.hits":"{n} hits","overview.injectedBadge":"Injected","overview.notInjectedBadge":"Not injected","overview.kpiZeroInjection":"Zero-injection rate","overview.kpiAdoption":"Adoption rate","overview.kpiJobSuccess":"Job success (7d)","overview.kpiDbSize":"DB size","overview.targetMet":"On target · {target}","overview.targetMissed":"Below target · {target}","overview.trend":"7-day trend","overview.trendEmpty":"No 7-day data yet","overview.trendInjected":"Injection rate","overview.trendZeroHit":"Zero-hit share","overview.trendToday":"Today","overview.trendTip":"{day}: recalls {recalls} · hits {withHits} · injected {injected} · adopted {adopted} · zero-hit {zeroHit}","overview.failures":"Recent failures","overview.failuresEmpty":"No failed jobs in the last 24h","overview.failureAttempts":"attempts {n}","memory.title":"Memory","memory.searchPlaceholder":"Search keywords (300 ms debounce)…","memory.searching":"Searching…","memory.noResults":"No matches","memory.emptyTitle":"Memory is empty","memory.emptyDesc":"Write the first memory, or import a JSONL file.","memory.writeFirst":"Write first memory","memory.importJsonl":"Import JSONL","memory.newTitle":"New memory","memory.writePlaceholder":"Text to remember (max 500 chars)…","memory.writeLevel":"Level","memory.writeType":"Type","memory.writeTags":"Tags (comma separated)","memory.writeSubmit":"Write","memory.written":"Written: {id}","memory.colText":"Text","memory.colLevel":"Level","memory.colType":"Type","memory.colStatus":"Status","memory.colScore":"Score","memory.colSource":"Source","memory.pageEmpty":"No records on this page","memory.searchMeta":"{count} matches ({below} candidates below threshold)","memory.searchMetaNoBelow":"{count} matches","detail.title":"Memory detail","detail.text":"Text","detail.level":"Level","detail.status":"Status","detail.tags":"Tags","detail.tagsPlaceholder":"comma separated","detail.source":"Source","detail.type":"Type","detail.created":"Created","detail.updated":"Updated","detail.bitemporal":"Bi-temporal","detail.validAt":"Valid from","detail.invalidAt":"Invalid at","detail.expiredAt":"Expired at","detail.supersededBy":"Superseded by","detail.archive":"Archive","detail.archived":"Archived","detail.saveEdit":"Save edits","detail.saved":"Saved","detail.loadFailed":"Failed to load detail","detail.invalidText":"Text must be 1–500 chars","recall.title":"Recall","recall.recent":"Recent recalls (read-only)","recall.colTime":"Time","recall.colQuery":"Query","recall.colHits":"Hits","recall.colChars":"Chars","recall.colElapsed":"Elapsed","recall.colInjected":"Injected","recall.colUsed":"Adopted","recall.injectedYes":"Injected","recall.injectedNo":"Not injected","recall.usedYes":"Adopted","recall.usedNo":"Not adopted","recall.testTitle":"Search-only test","recall.testNote":"Calls the search endpoint only; no model call, no writes, no recall side effects.","recall.testPlaceholder":"Keyword to test…","recall.runTest":"Search","recall.testEmpty":"No matches (below minimum relevance)","recall.testMeta":"{count} results · {ms} ms","recall.testError":"Search failed","recall.recentEmpty":"No recall records yet","writes.title":"Writes & edges","writes.pendingTitle":"Pending write candidates (shadow)","writes.pendingNote":"Shadow mode records candidates only; accept to store, reject keeps an audit reason.","writes.colText":"Candidate text","writes.accept":"Accept","writes.reject":"Reject","writes.reviewDone":"Reviewed; list refreshed","writes.reviewFailed":"Review failed","writes.recent":"Recent write audit (read-only)","writes.colTime":"Time","writes.colAction":"Action","writes.colNode":"Node","writes.colReason":"Reason","writes.edges":"Edges","writes.recentCount":"Recent writes","writes.note":"This page is read-only; writes come from the memory API and recall injection.","writes.empty":"No write records yet","settings.title":"Settings","settings.groupBackend":"Backend","settings.groupRecall":"Injection","settings.groupWrite":"Write","settings.groupTools":"Model tools","settings.groupBackground":"Background & sync","settings.groupPanel":"Panel","settings.groupAdvanced":"Advanced","settings.backendMode":"Backend mode","settings.backendUrl":"External service URL","settings.backendTimeout":"Request timeout (ms)","settings.recallEnabled":"Enable recall injection","settings.maxHits":"Max hits","settings.charBudget":"Injected char budget","settings.intentBudget":"Per-intent injection budget (0 for image prompts)","settings.minRel":"Minimum relevance (0–1)","settings.recallTimeout":"Recall timeout (ms)","settings.writeEnabled":"Enable writes","settings.toolsEnabled":"Enable model memory tools","settings.reviewMode":"Write review","settings.maxChars":"Max chars per memory","settings.toolsMaxWritesPerTurn":"Write-tool attempts per turn","settings.searchFeed":"Save search summaries as memories (24h TTL)","settings.reflectEnabled":"Enable idle reflection","settings.syncEnabled":"Sync with gateway","settings.pollMs":"Panel poll interval (ms)","settings.allowRemote":"Allow non-loopback access","settings.logLevel":"Log level","settings.worker":"Run search in worker","settings.save":"Save settings","settings.saved":"Saved ({time})","settings.saveFailed":"Save failed","settings.loadFailed":"Failed to load configuration","settings.defaultsNote":"Only the items you changed are saved; groups absent from the echo are shown with defaults and are not written to config.","settings.restartNote":"Backend and worker changes usually take effect after reloading the plugin.","settings.allowRemoteWarn":"When enabled, only the webServer.host bind address is additionally allowed (reads); identity override params are ignored for non-loopback requests.","settings.readonlyUnavailable":"Config saving is unavailable in this runtime (read-only).","settings.invalidValue":"Some values are out of range or not numeric; fix them before saving.","import.reading":"Reading file…","import.uploading":"Importing…","import.tooLarge":"File exceeds 4 MB; split it before importing.","import.readFailed":"Failed to read the file.","import.smallDone":"Import finished: added {added} · skipped {skipped} · errors {errors}","import.progress":"Importing {done}/{total} · added {added} · skipped {skipped} · errors {errors}","import.done":"Import finished: added {added} · skipped {skipped} · errors {errors}","import.failed":"Import failed","import.total":"{total} lines","import.button":"Import JSONL","sync.button":"Sync with gateway","sync.dryTitle":"Sync dry-run (nothing written)","sync.pull":"Pull: +{added} / skipped {skipped} / errors {errors} / lines {lines}","sync.push":"Push: {lines} lines","sync.confirm":"Confirm sync","sync.done":"Sync complete","sync.busy":"Syncing…","reflect.button":"Reflect","reflect.done":"Reflected: +{added} (material {material})","reflect.busy":"Reflecting…","reflect.disabled":"Reflect disabled: enable reflect.enabled in settings","import.export":"Export","import.accept":".jsonl,.txt,text/plain","status.active":"Active","status.archived":"Archived","status.stale":"Stale","status.superseded":"Superseded","level.core":"Core","level.important":"Important","level.normal":"Normal","type.semantic":"Semantic","type.procedural":"Procedural","type.episodic":"Episodic","type.mixed":"Mixed","source.owner":"Owner","source.self":"Self","source.group":"Group","source.web":"Web","source.tool":"Tool","source.import":"Import","err.network":"Network unreachable; confirm DSH is running.","err.backend_unreachable":"Memory backend is unreachable.","err.backend_unavailable":"Memory backend does not provide this capability.","err.backend_error":"Memory backend returned an error.","err.invalid_query":"Query must not be empty.","err.invalid_text":"Text is invalid (1–500 chars).","err.invalid_level":"Invalid level.","err.invalid_memory_type":"Invalid memory type.","err.invalid_tags":"Invalid tags.","err.identity_required":"Identity keys are missing; cannot read or write.","err.identity_mismatch":"Identity does not match the current session/config; request rejected.","err.write_disabled":"Writes are disabled.","err.duplicate":"Content already exists; skipped.","err.node_not_found":"Memory node not found.","err.job_not_found":"Import job not found.","err.invalid_job_id":"Invalid import job id.","err.config_save_unavailable":"Config saving is unavailable in this runtime (read-only).","err.config_save_failed":"Failed to save configuration.","err.invalid_config":"Invalid configuration.","err.invalid_value":"A value is out of range.","err.payload_too_large":"Request body too large (4 MB limit).","err.invalid_jsonl":"Invalid JSONL content.","err.method_not_allowed":"Method not allowed.","err.not_found":"Endpoint not found.","err.not_loopback":"Loopback access only.","err.file_too_large":"File exceeds 4 MB; split it before importing.","err.read_error":"Failed to read the file.","err.unknown":"Unknown error.","settings.groupIdentity":"Identity","settings.groupReflect":"Reflection","settings.groupConsolidate":"Consolidation","settings.groupEmbed":"Embeddings","settings.groupPrivacy":"Privacy","settings.groupEdges":"Edges","settings.groupSync":"Sync","settings.groupDanger":"Danger zone","settings.identityMode":"Identity mode","settings.identityModeDesc":"auto derives identity from the host session; fixed uses the values below.","settings.identityRoleIdDesc":"Empty means no role restriction.","settings.identityWorkspaceDesc":"Empty means the current workspace.","settings.reflectEnabledDesc":"Reflects and reorganizes memories when idle.","settings.syncEnabledDesc":"Syncs memories with the gateway; the bridge URL is injected by the profile.","settings.identityUserId":"userId","settings.identityRoleId":"roleId","settings.identityWorkspace":"workspace","settings.identityAutoNote":"auto: userId is derived from the host session; currently falls back to \"local\".","settings.identityFixedNote":"fixed: uses the values below; an empty userId makes reads and writes fail.","settings.injectLevels":"Levels allowed in injection (comma separated)","settings.injectLevelsDesc":"e.g. core,important; leave empty for no limit.","settings.showSources":"Show sources in injected text","settings.showSourcesDesc":"Append node sources to injected text.","settings.dailyCap":"Daily write cap","settings.dailyCapDesc":"Daily write count cap.","settings.searchTtlHours":"Search-summary TTL (hours)","settings.searchTtlHoursDesc":"TTL for search-summary memories.","settings.judge":"Write judge","settings.judgeDesc":"rules uses heuristics; llm calls a model.","settings.ignorePatterns":"Ignore patterns (one per line)","settings.ignorePatternsDesc":"Text matching any pattern is not written.","settings.writeModel":"Write judge model (used when judge=llm)","settings.writeModelDesc":"Empty means the current default model.","settings.reflectModel":"Reflection model","settings.reflectModelDesc":"Empty means the current default model.","settings.idleMinutes":"Idle trigger (minutes)","settings.idleMinutesDesc":"Triggered after the user is idle for this long.","settings.maxItems":"Max items per run","settings.maxItemsDesc":"Max new memories per reflection run.","settings.maxRunsPerDay":"Max runs per day","settings.maxRunsPerDayDesc":"Daily reflection run cap.","settings.consolidateEnabled":"Enable consolidation","settings.consolidateEnabledDesc":"Periodically merges duplicates and expired nodes.","settings.consolidateInterval":"Consolidation interval (hours)","settings.consolidateIntervalDesc":"Interval between consolidation runs.","settings.embedEnabled":"Enable vector search","settings.embedEnabledDesc":"Requires an external vector service; not wired by default here.","settings.embedEndpoint":"Vector service endpoint","settings.embedEndpointDesc":"Endpoint compatible with OpenAI embeddings.","settings.embedModel":"Embedding model","settings.embedModelDesc":"Embedding model name.","settings.embedBatch":"Embedding batch size","settings.embedBatchDesc":"Items per embedding batch.","settings.embedNote":"No provider is wired on this machine; jobs return \"unavailable\" when enabled.","settings.privacyRedact":"Redact before writing","settings.privacyRedactDesc":"Sensitive fields are replaced before writing.","settings.privacyRetention":"Archived retention days (0 = forever)","settings.privacyRetentionDesc":"0 keeps archives forever.","settings.privacyDanger":"retentionDays > 0 physically deletes expired archives.","settings.edgesDiffusion":"Enable 1-hop edge diffusion","settings.edgesDiffusionDesc":"Expands one hop along edges during recall.","settings.edgesMinConf":"Minimum edge confidence","settings.edgesMinConfDesc":"Edges below this confidence are not diffused.","settings.syncMode":"Sync direction","settings.syncModeDesc":"off disables; push/pull/both select directions.","settings.syncInterval":"Sync interval (minutes)","settings.syncIntervalDesc":"Interval for scheduled sync.","settings.syncHttpTimeout":"Sync timeout (ms)","settings.syncHttpTimeoutDesc":"HTTP timeout for sync requests.","settings.syncBatch":"Sync batch size","settings.syncBatchDesc":"Items per sync batch.","settings.syncBridgeNote":"bridgeUrl is injected by the profile and is not edited here.","settings.panelTab":"Default tab","settings.panelTabDesc":"Tab selected when the panel opens.","settings.pollMsDesc":"Auto-refresh interval on the overview tab.","settings.allowRemoteDesc":"Loopback only by default; when enabled, only the bind address is additionally allowed.","settings.traceId":"traceId (trace marker)","settings.traceIdDesc":"Trace marker for write audit and logs.","settings.logLevelDesc":"Plugin log level.","settings.workerDesc":"Search runs in a worker thread to avoid blocking the main thread.","settings.exportMemory":"Export memory (download JSONL)","settings.dangerNote":"No clear/reset endpoint is provided; this version has no destructive actions.","settings.dataDir":"Data directory (read-only)","settings.dataDirDesc":"Determined by the host profile.","settings.readonlyTag":"read-only","settings.effectInstant":"Instant","settings.effectReload":"Reload","settings.effectLabel":"Effect","settings.savedButReloadFailed":"Saved, but reloading the config failed.","settings.backendModeDesc":"Local SQLite by default; http/hybrid use the external service.","settings.backendUrlDesc":"Only used when backend.mode is not local.","settings.backendTimeoutDesc":"Per-request timeout for the external service.","settings.recallEnabledDesc":"No memories are injected when disabled.","settings.maxHitsDesc":"Max hits injected per recall.","settings.charBudgetDesc":"Total injected character budget; 0 = injection off (no memory is injected).","settings.intentBudgetDesc":"Image-prompt intents get 0 injection.","settings.minRelDesc":"Candidates below this relevance are filtered.","settings.recallTimeoutDesc":"Recall fails open after timeout and does not block the turn.","settings.writeEnabledDesc":"Writes and candidate review stop when disabled.","settings.toolsEnabledDesc":"When off, the model tools no longer appear in the tool set; panel writes and session-wrap ingestion are unaffected.","settings.reviewModeDesc":"shadow records candidates only; auto writes directly.","settings.maxCharsDesc":"Hard limit per memory text.","settings.toolsMaxWritesPerTurnDesc":"Upper bound on remember/update/forget attempts in one turn; beyond it the tool returns RATE_LIMITED. Applies only to model tools, not session-wrap ingestion.","settings.searchFeedDesc":"Search summaries are saved as memories.","recall.explain":"Explainability","recall.explainHint":"Expand to see score breakdown","recall.colRel":"rel","recall.colMult":"mult","recall.colGain":"gain","recall.colEffWeight":"effWeight","recall.colPath":"Hit path","recall.colMatched":"Matched terms","recall.pathFallback":"L1/L2","recall.belowMin":"{n} more candidates below the gate","recall.noComponents":"This hit returned no score breakdown","writes.pendingEmpty":"No pending candidates","writes.edgesTitle":"Edge statistics","writes.edgesEmpty":"No edges yet","writes.evolutionTitle":"Recent evolution","writes.evolutionEmpty":"No evolution records","writes.colType":"Type","writes.colCount":"Count","writes.colFromTo":"Relation","writes.colField":"Field","memory.candidateQueued":"Added to the review queue (review it on the Writes tab)","sync.disabled":"Sync disabled: enable sync.enabled in settings.","header.identity":"Identity","header.identityTip":"Current memory identity: {workspace} / {userId} / {roleId}","err.sync_disabled":"Sync is disabled (sync.enabled=false).","err.sync_bridge_unset":"Sync bridge URL is not configured (the profile injects bridgeUrl).","err.confirm_required":"Confirmation missing: sync needs confirm=true; permanent delete needs confirmKey equal to the rule key.","err.invalid_direction":"Invalid sync direction (pull/push/both).","err.busy":"A task of this kind is already running; try again later.","err.reflect_unavailable":"The reflection scheduler is unavailable.","err.candidate_not_found":"The pending candidate was not found.","err.invalid_review":"Invalid review parameters.","err.privacy":"The content triggered privacy rules and was not written.","err.daily_cap":"The daily write cap has been reached.","err.text_too_long":"Text exceeds the character limit.","err.unknown_error":"Unknown error.","err.network_error":"Network unreachable; confirm DSH is running.","settings.defaultValue":"Default: {value}","settings.defaultOn":"On","settings.defaultOff":"Off","settings.defaultEmpty":"empty","settings.badgeGeneral":"General","settings.badgeLocal":"Local","settings.badgeNeedsConfig":"Needs config","settings.depUnmet":"Dependency unmet: {reason}","settings.depBackendUrl":"Only used when backend.mode is not local","settings.depWriteModel":"Only used when judge=llm","settings.depEmbed":"Enable vector search first","settings.depSync":"Enable sync first","settings.depPanelRemote":"Only effective when non-loopback access is allowed","settings.effectDaily":"Daily","settings.groupBackendDesc":"Choose the local database or an external memory service; only the external path needs a URL and timeout.","settings.groupIdentityDesc":"Decides who and which workspace each memory belongs to; auto follows the host session.","settings.groupRecallDesc":"How much, how relevant and which levels are injected each turn; this directly shapes how much the assistant remembers.","settings.groupWriteDesc":"What gets remembered, how writes are reviewed, and the per-memory / daily limits.","settings.groupToolsDesc":"Whether the model-facing memory tools (memory_remember / memory_search / memory_read / memory_update / memory_forget) are visible, and how many write-tool attempts are allowed per turn.","settings.groupReflectDesc":"Let the model reorganize memories while idle; off by default and needs a model.","settings.groupConsolidateDesc":"Merge duplicates and expired nodes on a schedule so the store does not grow forever; on by default.","settings.groupEmbedDesc":"Connect an external vector service for semantic search; leave it off when this machine has none.","settings.groupPrivacyDesc":"Redaction before writing and archive retention; expired archives are physically deleted.","settings.groupEdgesDesc":"Expand one hop along edges during recall and filter out low-confidence edges.","settings.groupSyncDesc":"Sync memories both ways with the gateway; the bridge URL is injected by the profile.","settings.groupPanelDesc":"Refresh cadence, default tab and access scope of this panel.","settings.groupAdvancedDesc":"Logging and search-thread diagnostics; rarely needs changing.","settings.groupDangerDesc":"Export backup entry; this version ships no clear/reset endpoint, so no destructive buttons.","settings.backendId":"Backend id","settings.backendIdDesc":"Stable identifier for service registration and diagnostics; may stay empty in local mode.","settings.syncBridgeUrl":"Sync bridge URL","settings.syncBridgeUrlDesc":"Injected by the profile; a manual value is overwritten on the next config load.","settings.syncDryRun":"Default sync to dry-run","settings.syncDryRunDesc":"When on, sync only compares differences and writes nothing; a real run still needs confirmation in the header.","settings.charBudgetZeroConfirm":"charBudget=0 disables injection: no memory will be injected into this turn. Save anyway?","settings.sectionLabel":"Memory hub","header.backendStatus":"Backend: {mode} · protocol {protocol} · outbox {outbox}","header.backendStatusTip":"From GET /version; values show — when the endpoint is unavailable","header.protocolOk":"OK","header.protocolMismatch":"incompatible","health.backend":"Backend","health.protocol":"Protocol","health.outbox":"outbox","overview.migrationTitle":"Migration","overview.migrationPending":"Migration awaiting confirmation","overview.migrationPendingDesc":"Identity/data migration is not confirmed yet; review it on the settings tab, then save.","overview.migrationFrom":"Migrated from","overview.migrationAt":"Migrated at","overview.openSettings":"Open settings","overview.offlineBackendTitle":"External service not connected","overview.offlineBackendDesc":"The backend is http/hybrid but the external service URL is empty; switch back to the local store in one click.","overview.switchLocal":"Switch to local","overview.switchLocalDone":"Switched to the local store","overview.switchLocalFailed":"Switch failed","memory.sampleTitle":"Sample memories","memory.sampleDesc":"Write 3 sample memories; they can be cleaned up in one click.","memory.sampleWrite":"Write samples","memory.sampleCleanup":"Clean up samples","memory.sampleCleanupConfirm":"Cleanup archives these 3 samples (history is kept, audit trail preserved). Continue?","memory.sampleDone":"3 samples written","memory.sampleCandidate":"In shadow mode the samples queued for review instead of being written","memory.sampleCleaned":"Samples archived","memory.sample1":"Whale Memory keeps its store in local SQLite by default and never uploads memories to the cloud.","memory.sample2":"Before each turn the plugin recalls a few relevant memories and injects them into context.","memory.sample3":"Writes go through shadow review by default: candidates are audited first and only become memories after approval.","recall.budgetTitle":"Injection budget","recall.budgetLine":"{chars} chars · up to {hits} hits · intent tier {intent}","recall.budgetIntentOn":"On","recall.budgetIntentOff":"Off","recall.budgetZero":"0 chars = injection off (no memory injected)","recall.filterLabel":"Filter","recall.filterAll":"All","recall.filterUnused":"Not adopted","recall.filterZero":"Zero hits","recall.colSource":"Source","writes.rejectReason":"Reject reason (optional)","writes.rewrite":"Rewrite text (optional)","writes.rewriteHint":"Leave empty to accept as-is; a rewritten text is applied to the node after acceptance.","writes.confirmReview":"Submit review","writes.reviewFormTitle":"Review candidate","writes.actionAdd":"Add","writes.actionNoop":"No-op","writes.actionMerge":"Merge","writes.actionSupersede":"Supersede","writes.actionReject":"Reject","writes.actionCandidate":"Candidate","writes.oldValue":"Old","writes.newValue":"New","detail.origin":"Evidence (origin)","detail.originUnavailable":"Not provided","detail.edges":"1-hop neighbour edges","detail.edgesUnavailable":"Not provided (/nodes/:id returned no edges)","detail.edgesEmpty":"No neighbour edges","detail.archiveConfirm":"Archiving is not reversible (the audit trail is kept). Archive this memory?","detail.saveConfirm":"Editing rewrites the text and keeps an audit record. Save?","header.rolePrefix":"role: {roleId}","tab.rules":"Rules","rules.intro":"Rules are versionable behavior constraints; iron-law numbers are stable and never reused.","rules.gitTitle":"Git repository","rules.gitOk":"git {version}","rules.gitMissing":"git not installed","rules.gitBroken":"git state broken","rules.gitUnknown":"git state unknown","rules.gitRequiredHint":"Settings require git; rules are disabled without it","rules.gitChecked":"checked {time}","rules.gitGuide":"Install guide","rules.gitRefresh":"Refresh git status","rules.gitGuideTitle":"Install git (optional)","rules.gitGuideIntro":"Rule files are plain text; git only provides history, diff and rollback. Pick one command for your platform:","rules.gitGuideBrew":"macOS (Homebrew)","rules.gitGuideApt":"Debian / Ubuntu","rules.gitGuideWinget":"Windows (winget)","rules.gitGuideDownload":"Or download an installer from git-scm.com/downloads","rules.gitGuideSnapshot":"Without git, history / diff / rollback still work from local snapshots; you only lose commit records, and diffs compare snapshot lines.","rules.dirLabel":"Rules dir","rules.copyDir":"Copy path","rules.copied":"Copied","rules.copyFailed":"Copy failed","rules.rebuildMirror":"Rebuild mirror","rules.rebuilding":"Rebuilding…","rules.rebuildConfirm":"Rebuilding rewrites rule files into the memory DB for recall injection and will not modify any rule file. Continue?","rules.rebuildDone":"Mirror rebuilt","rules.mirrorNote":"The mirror is a DB copy of rule files for panel search; chat recall does not read it. Rebuilding only reads files and never changes them.","rules.importLegacy":"Import iron laws from memory","rules.importing":"Importing…","rules.importConfirm":"This copies iron-law memory nodes into rule files (numbers stay stable and are never reused). Memory nodes are left untouched. Continue?","rules.importDone":"Iron laws imported","rules.importCount":"{n} total","rules.filterLabel":"Filter","rules.filterAll":"All","rules.filterIron":"Iron laws","rules.filterNormal":"Rules","rules.filterCandidate":"Candidates","rules.filterRetired":"Retired","rules.searchPlaceholder":"Filter by number / title / body…","rules.listMeta":"Showing {shown} / {total}","rules.colNumber":"No.","rules.colType":"Type","rules.colPriority":"Priority","rules.colScope":"Scope","rules.colStatus":"Status","rules.colUpdated":"Updated","rules.colExcerpt":"Summary","rules.colOps":"Actions","rules.detail":"Detail","rules.detailTitle":"Rule detail","rules.tableEmpty":"No rules match this filter","rules.proposalsTitle":"Pending confirmation: {n}","rules.proposalsEmpty":"No pending proposals","rules.emptyTitle":"No rule files yet","rules.emptyWhy":"Why rules: they turn \"always do this\" into text you can diff and roll back, so commitments made in chat are never lost.","rules.emptyStepImport":"Click \"Import iron laws from memory\" to turn existing iron-law nodes into rule files.","rules.emptyStepEdit":"Rule files live in ~/.dsh/rules (configurable in settings) and any text editor can edit them.","rules.emptyStepRefresh":"Come back and refresh; with \"auto rebuild mirror\" on, the panel reads the latest files.","rules.statusActive":"Active","rules.statusCandidate":"Candidate","rules.statusRetired":"Retired","rules.statusMerged":"Merged","rules.statusSuperseded":"Superseded","rules.statusDraft":"Draft","rules.statusProposed":"Pending","rules.typeIron":"Iron law","rules.typeNormal":"Rule","rules.fieldNumber":"Number","rules.fieldType":"Type","rules.fieldPriority":"Priority","rules.fieldScope":"Scope","rules.fieldRole":"Role","rules.fieldStatus":"Status","rules.fieldCreated":"Created","rules.fieldUpdated":"Updated","rules.fieldVersion":"Version","rules.fieldOrigin":"Origin","rules.fieldPath":"File path","rules.fieldMergedInto":"Merged into","rules.fieldSupersededBy":"Superseded by","rules.bodyTitle":"Full text","rules.conditions":"Conditions","rules.exceptions":"Exceptions","rules.none":"None","rules.history":"History","rules.historyEmpty":"No history yet","rules.historySourceGit":"git","rules.historySourceSnapshot":"snapshot","rules.historyHint":"Select a version to compare it with the current text line by line","rules.diff":"Version diff","rules.diffOld":"Old","rules.diffNew":"New","rules.diffEmpty":"This version matches the current text","rules.rollback":"Roll back to this version","rules.edit":"Edit","rules.fieldKey":"Key","rules.editTitle":"Edit rule","rules.editHint":"Only the body and structured fields change; saving writes the rule file and creates a new version you can roll back.","rules.editImmutableNote":"Key, type and number are read-only: numbers are stable and never reused.","rules.editTextLabel":"Body (≤500 chars)","rules.editConditionsLabel":"Conditions (one per line)","rules.editExceptionsLabel":"Exceptions (one per line)","rules.editScopeLabel":"Scope","rules.editScopeValueLabel":"Scope value","rules.editScopeGlobal":"Global","rules.editScopeWorkspace":"Workspace","rules.editScopeRole":"Role","rules.editScopeOther":"Other (keep value)","rules.editScopeWorkspacePlaceholder":"Absolute workspace path, e.g. /srv/project","rules.editScopeRolePlaceholder":"Role id (no spaces)","rules.editScopeInvalid":"Invalid scope: a workspace needs an absolute path; a role id cannot contain spaces.","rules.editPriorityLabel":"Priority","rules.editStatusLabel":"Status","rules.editStatusActive":"Active","rules.editStatusRetired":"Retired","rules.editRetiredHint":"Retired means it is no longer injected, while file and history are kept.","rules.editRetireConfirm":"Once retired this rule is no longer injected, while its file and history are kept. Retire it?","rules.editPreview":"Preview changes","rules.editPreviewTitle":"Change preview","rules.editPreviewFieldText":"Body","rules.editPreviewFieldConditions":"Conditions","rules.editPreviewFieldExceptions":"Exceptions","rules.editPreviewFieldScope":"Scope","rules.editPreviewFieldPriority":"Priority","rules.editPreviewFieldStatus":"Status","rules.editDiffServerNote":"Diff baseline is the current body reported by the server.","rules.editDiffLocalNote":"No usable current revision info; comparing line by line locally.","rules.editDiffFieldsOnly":"The body is unchanged; only structured fields change","rules.editBack":"Back to edit","rules.editSubmit":"Confirm and save","rules.editConfirm":"Saving writes the rule file, creates a new version (history kept) and refreshes the AGENTS digest. Save?","rules.editDone":"Rule saved","rules.editNoChange":"Nothing to submit","rules.editInvalidText":"Body must be 1–500 characters","rules.agentsSynced":"The AGENTS digest follows the rule file (the file is the source of truth)","rules.currentRev":"Current","rules.currentRevHint":"This revision is the current one; rollback is disabled.","rules.rollbackHint":"Rollback creates a new version from this revision; history is never deleted.","rules.rollbackSelectHint":"Select a revision in the history first","rules.rollbackCurrentHint":"The current revision needs no rollback","rules.revertConfirm":"Rollback writes this revision’s content as a new version (all commit history is kept; nothing is deleted). Roll back?","rules.revertDone":"Rolled back to that revision","rules.revertBusy":"Rolling back…","rules.diffServerFail":"Server diff unavailable; fell back to local line-by-line comparison.","rules.diffLoading":"Loading diff…","rules.errGitHint":"Install git (see the install guide on the rules page), or turn off “Require git” in settings.","rules.errInvalidDetail":"Field hint: {detail}","rules.opFailed":"Operation failed","settings.groupRules":"Rules","settings.groupRulesDesc":"Rules dir, git gate, proposal pace and mirror; off = no detection, no injection, no proposals, files still manageable.","settings.rulesEnabled":"Rules feature","settings.rulesEnabledDesc":"Off = no detection / injection / proposals; rule files stay manageable on the Rules tab.","settings.rulesDir":"Rules directory","settings.rulesDirDesc":"Empty = ~/.dsh/rules; rebuild the mirror after changing it.","settings.rulesRequireGit":"Require git","settings.rulesRequireGitDesc":"When on, rules are disabled without git (history / diff / rollback too); default off, local snapshots still work.","settings.rulesAskMode":"How to ask for proposals","settings.rulesAskModeDesc":"panel+chat = ask from panel and chat; panel = panel only; off = never ask proactively.","settings.rulesAskPanelChat":"Panel + chat","settings.rulesAskPanel":"Panel only","settings.rulesAskOff":"Off","settings.rulesLlm":"Polish rules with model","settings.rulesLlmDesc":"Use the model to phrase proposal candidates as rules; off by default to avoid extra model calls and cost.","settings.rulesMaxProposals":"Proposal cap","settings.rulesMaxProposalsDesc":"Maximum pending proposals kept at once (oldest are dropped beyond it).","settings.rulesGuardStrict":"Strict guard","settings.rulesGuardStrictDesc":"Enforce rules before injection and block conflicts; off = warn only.","settings.rulesMirrorAuto":"Auto rebuild mirror","settings.rulesMirrorAutoDesc":"Sync rule files into the DB for recall after changes; off = manual \"Rebuild mirror\".","settings.rulesAskCooldownDays":"Ask cooldown (days)","settings.rulesAskCooldownDaysDesc":"Minimum gap before asking about the same rule again; 0 = ask every time.","settings.rulesConfigLayerNote":"Four keys only work at the config-file layer (no panel switch): rules.renderAgents, rules.injectChars (per-turn injection budget; 0 disables), rules.createAgentsIfMissing (create a minimal AGENTS block on a blank machine) and rules.summaryBudgetChars (AGENTS digest budget in code points; default 6000). Edit the plugin config and restart the host to change them.","settings.depRulesEnabled":"Rules feature is off, so this setting has no effect","rules.typeCandidate":"Candidate rule","rules.importSkipped":"Iron law already exists; skipped","err.rules_disabled":"Rules feature is off (Settings → Rules)","err.git_required":"Settings require git, but no usable git was found: install git, or turn off “Require git” (rules.requireGit)","err.rule_not_found":"Rule not found (it may have been deleted or renamed)","err.invalid_patch":"The submitted changes are invalid","err.immutable_field":"That field cannot be changed (key, type and number are read-only)","err.invalid_rule":"Rule validation failed","err.rev_not_found":"That revision does not exist or was cleaned up","err.rule_guard_failed":"Rule guard failed","err.rule_proposal_not_found":"Proposal not found or already handled","err.rule_proposal_expired":"Proposal expired","err.invalid_acknowledge":"Invalid acknowledge payload: list dropped clauses per rule (key + clause); whole-rule acknowledgement is not accepted.","rules.gitMissingDetail":"Without git, local snapshots still cover history / diff / rollback","rules.proposalsCount":"Pending: {n}","rules.proposalsJump":"Jump to pending proposals","rules.proposalLoading":"Loading proposals…","rules.proposalError":"Failed to load proposals","rules.relNew":"New rule","rules.relDuplicate":"Duplicate","rules.relRefine":"Refine","rules.relMerge":"Merge","rules.relConflict":"Conflict","rules.relUnrelated":"Unrelated","rules.proposalStatusPending":"Pending","rules.proposalStatusNeedsManual":"Needs manual","rules.proposalStatusAccepted":"Accepted","rules.proposalStatusRejected":"Rejected","rules.proposalStatusExpired":"Expired","rules.proposalSource":"Source snippet","rules.proposalMeta":"Number {number} · priority {priority} · scope {scope}","rules.proposalAffected":"Affected existing rules","rules.proposalOld":"Old","rules.proposalNew":"New","rules.proposalChanged":"Changed","rules.proposalPreserved":"Preserved clauses","rules.proposalDropped":"Dropped clauses","rules.proposalGuardFailed":"Guard failed","rules.proposalRiskTitle":"High-risk action","rules.proposalRiskGuard":"Guard checks failed; the server may reject this apply.","rules.proposalRiskDropped":"Applying drops {n} clause(s).","rules.proposalAckDropped":"I confirm deleting these clauses","rules.proposalAckHint":"Tick “I confirm deleting these clauses” before applying","rules.proposalApply":"Apply","rules.proposalRewrite":"Rewrite","rules.proposalReject":"Reject","rules.proposalRejectReason":"Reason (optional)","rules.proposalRejectPlaceholder":"One line on why you reject it…","rules.proposalRejectConfirm":"Reject this proposal? It won't be asked again for 30 days.","rules.proposalRejectConfirmAction":"Confirm reject","rules.proposalApplyConfirm":"Applying writes the rule file, creates a git commit, renders AGENTS.md and rebuilds the memory mirror. Continue?","rules.proposalApplied":"Applied","rules.proposalRejected":"Rejected","rules.proposalCooldown":"It won't be asked again for 30 days","rules.proposalCooling":"Cooling down: this proposal won't be regenerated for now","rules.proposalExpand":"Show full text","rules.proposalCollapse":"Collapse","rules.proposalRewriteTitle":"Rewrite proposal","rules.proposalRewriteHint":"Edit body/clauses/scope; the new text is what gets applied.","rules.proposalRewriteNote":"Conditions/exceptions/scope are submitted as body clauses (the server decides on one text).","rules.proposalRewriteSubmit":"Apply this text","rules.proposalRewriteEmpty":"Body cannot be empty","rules.proposalEditorText":"Body","rules.proposalEditorConditions":"Conditions (one per line)","rules.proposalEditorExceptions":"Exceptions (one per line)","rules.proposalEditorScope":"Scope","rules.proposalManualTitle":"Propose manually","rules.proposalManualHint":"Paste a requirement; the server compiles it into a candidate. Nothing is written before you confirm.","rules.proposalManualPlaceholder":"e.g. Gateway restarts must cite a ticket id and date…","rules.proposalManualSubmit":"Submit proposal","rules.proposalManualDone":"Proposal created — see pending proposals above","rules.new":"New rule","rules.newTitle":"New rule","rules.newHint":"Fill in the body and structured fields; the server assigns the number and key. Saving writes the rule file and keeps git history.","rules.newTypeLabel":"Type","rules.newAutoAssign":"Assigned after save","rules.newAutoAssignNote":"Number and key are read-only: iron-rule numbers are stable and never reused; normal rules also get an automatic number.","rules.newActionLabel":"Action (optional)","rules.newObjectLabel":"Object (optional)","rules.newActionPlaceholder":"Leave blank to extract from the body","rules.newObjectPlaceholder":"Leave blank to extract from the body","rules.newTextPlaceholder":"Write the requirement as one imperative sentence…","rules.newConfirm":"Saving will: write the rule file, create a git commit, rebuild the memory mirror, and render the AGENTS digest. Create this rule?","rules.newSubmit":"Create rule","rules.newDone":"Rule created","rules.newTypeInvalid":"Invalid rule type (iron rule / normal rule)","rules.newPriorityInvalid":"Invalid priority (P0–P3)","rules.retire":"Retire","rules.retireConfirm":"After retiring, this rule is no longer injected or in effect; the rule file, history, and number are all kept, and you can reactivate it at any time. Retire it?","rules.retireDefaultHint":"This is a default iron rule. It will stop taking effect on this machine; you can reactivate it from the history under the same number.","rules.retiredBadge":"Retired","rules.reactivate":"Reactivate","rules.reactivateConfirm":"Reactivating restores injection and effect for this rule; the number, file, and history stay unchanged. Reactivate it?","rules.retireDone":"Rule retired","rules.reactivateDone":"Rule reactivated","rules.toggleUnavailable":"Only active or retired rules can switch status","rules.purge":"Delete","rules.purgeHint":"Permanently delete the rule file (cannot be undone; the number is retired and never reused; history snapshots remain traceable)","rules.purgeKeyLabel":"Type the rule key \"{key}\" to enable deletion (no request is sent unless it matches)","rules.purgeKeyPlaceholder":"Type the key here","rules.purgeConfirm":"Permanent delete removes the rule file from disk and cannot be undone. Its number is retired and will never be reused (future rules will not get it). The last version before deletion stays in history snapshots and remains traceable in git and the history directory. Delete permanently?","rules.purgeDefaultHint":"This is a built-in default iron rule: after deletion it will not come back automatically (default seeding runs only once). If you truly need it, restore it manually from a history snapshot or backup.","rules.purgeDone":"Rule permanently deleted (file removed, number retired)","rules.purgeNumberRetired":"Number #{number} is retired and never reused; the next number is #{next}","rules.defaultBadge":"Default","rules.defaultOriginNote":"Built-in default iron rule: written by the plugin at install/upgrade time. You can edit, retire, or delete it; the number is kept and history can be rolled back.","rules.defaultNotice":"The plugin ships with default iron rules (written at install). You can edit, retire, or delete them; numbers are kept and history can be rolled back.","rules.emptyNoActive":"No rules in effect; open the \"Retired\" filter to reactivate one","err.already_retired":"This rule is already retired; no need to retire it again","err.not_retired":"This rule is currently active; no need to reactivate it","err.invalid_draft":"Invalid rule draft (body / type / priority / scope). Check it and retry","err.duplicate_rule":"A normal rule with the same body already exists (duplicate key); change the body or edit the existing rule.","err.proposal_not_found":"Proposal not found or already handled","err.proposal_not_pending":"Proposal is no longer actionable (already applied or rejected)","err.rule_locked":"Rule file is locked by another write; retry shortly","err.diff_too_large":"Too large to diff line by line (over 5000 lines)","err.needs_manual":"Proposal needs a manual rewrite before retry","err.llm_unavailable":"No model available in the panel; rewrite the wording and retry","err.llm_unparseable":"The model output could not be parsed; rewrite and retry","err.llm_error":"Model call failed; rewrite and retry","err.commit_failed":"git commit failed; changes were rolled back","err.write_failed":"Failed to write the rule file","err.affected_write_failed":"Failed to write an affected rule; changes were rolled back","err.invalid_json":"Request body is not valid JSON","err.invalid_key":"Invalid rule key (lowercase letters, digits and dashes only)","err.invalid_mode":"Invalid mode (retire / reactivate / purge only)","err.invalid_rev":"Invalid revision identifier","err.empty_text":"Body text cannot be empty","err.ensure_failed":"Failed to initialize the rule repository (check permissions and git)","err.proposal_corrupt":"Proposal is corrupt (missing key) and cannot be applied","err.plan_unavailable":"Apply-plan capability is not available yet (core plan not exported)","err.restore_unavailable":"Restore-default capability is not available yet","err.plan_failed":"Failed to build the apply plan","err.restore_failed":"Failed to restore the default rule","err.unsupported_media_type":"Write endpoints require Content-Type: application/json","err.cross_origin_denied":"Cross-origin write denied: local GUI / local curl only","err.no_markers":"No digest markers found in AGENTS; nothing written","err.render_failed":"Failed to render the AGENTS digest","rules.proposalNeedsManual":"This proposal needs manual work: the automatic rewrite failed the guard. Rewrite the body and retry.","rules.proposalNeedsManualCode":"Failure code: {code}","rules.proposalRewriteRetry":"Rewrite and retry","rules.restoreDefault":"Restore default","rules.restoreDefaultConfirm":"Overwrite this rule with the bundled default text and create a new version (history kept). Continue?","rules.restoreDefaultDone":"Restored to the default text · AGENTS digest follows","rules.emptyRetiredAction":"View retired rules","err.render_disabled":"AGENTS digest rendering is off (Settings → Rules → render AGENTS digest)","err.plan_hash_mismatch":"Plan is stale (planHash mismatch); regenerate the plan before applying","err.plan_stale":"Plan is behind on-disk changes; regenerate it","err.number_retired":"Target number is tombstoned and never reusable","err.target_conflict":"Target rule changed after the plan was built; regenerate the plan","err.target_missing":"Target rule no longer exists; propose again","err.affected_missing":"An affected rule no longer exists; refresh the proposal and retry","err.affected_inactive":"An affected rule is inactive (file still on disk); reactivate it or pick another affected rule","err.number_exhausted":"No iron-rule number left in 1–999","err.lock_failed":"Rule repository lock timed out; retry shortly","err.txn_failed":"Apply transaction write failed; changes were rolled back","err.repo_locked":"The rule repository is busy with another write; retry shortly (a live process lock is never taken over)","err.git_unavailable":"git unavailable: writes degrade to file-only (no commit); install git or turn off require-git","err.manifest_failed":"manifest write failed; this change was rolled back (file/tombstone/index restored)","err.tombstone_failed":"tombstone write failed; permanent delete did not run (the rule file is still there)","err.unprocessable":"The request cannot be processed (invalid parameters or state)","err.server_error":"Server-side failure; retry shortly or check the logs","rules.proposalNumberAdjusted":"Number adjusted: #{from} → #{to}","rules.proposalSemantic":"semantic draft","rules.proposalRefining":"refining","err.duplicate_active":"An active memory with the same text already exists.","err.node_changed":"This memory was changed by another action; refresh and retry.","err.target_not_active":"The target memory is no longer active.","settings.firstRunTitle":"Recommended setup (first run)","settings.firstRunDesc":"These switches are local and reversible. Applying writes only values that differ from yours; items needing a model or address are optional.","settings.firstRunApply":"Apply recommendations","settings.firstRunLater":"Not now","settings.firstRunLocalOn":"On out of the box","settings.firstRunReflect":"Enable reflection (needs a default model)","settings.firstRunReflectNote":"When idle, uses the DSH default model to distill recent activity into memories; produces nothing when no model is available.","settings.firstRunSync":"Enable memory sync (bridge URL configured)","settings.firstRunSyncNote":"Starts in dry-run: it only records pending items and never changes the remote; turn dry-run off after verifying.","settings.firstRunSyncUnset":"Sync needs a bridge URL (Settings → Sync); none is configured yet.","settings.firstRunSafety":"Writes default to shadow mode: recorded but not applied; switch to auto in Settings.","settings.recommend":"Recommended","settings.collapse":"Collapse","settings.expand":"Expand","settings.manualLink":"Not sure about a term? Open the glossary in the manual","manual.button":"Manual","manual.title":"Whale Memory manual","manual.close":"Close","manual.zhOnly":"This manual ships offline in Chinese.","err.ignored":"Matched an ignore rule; not written","overview.wrapTitle":"Session wrap","overview.wrapNow":"Wrap now","overview.wrapBusy":"Wrapping…","overview.wrapEmpty":"No wrap yet. After a stretch of work, click Wrap now or say “wrap up” in the chat.","overview.wrapUnsupported":"This backend mode does not support wrapping (local or hybrid storage is required).","overview.wrapLoadFailed":"Failed to load wrap status","overview.wrapCandidates":"Pending review","overview.wrapIngested":"Ingested","overview.wrapSkippedCount":"Skipped","overview.wrapProposals":"Rule proposals","overview.wrapOpenLoops":"Open loops","overview.wrapSwitchReady":"Ready to switch","overview.wrapReadyYes":"Yes","overview.wrapReadyNo":"No","overview.wrapBlockers":"Not ready: {list}","overview.wrapLastError":"Last error","overview.wrapSkipped":"Last skip: {reason}","overview.wrapQueued":"Queued: run {id}","overview.wrapFailed":"Wrap failed","overview.wrapShowReport":"View report","overview.wrapHideReport":"Hide report","overview.wrapReportFailed":"Failed to load report","wrap.stateQueued":"Queued","wrap.stateRunning":"Running","wrap.stateDone":"Done","wrap.stateFailed":"Failed","wrap.stateSkipped":"Skipped","wrap.triggerExplicit":"Explicit","wrap.triggerIdle":"Idle","wrap.triggerDisposed":"Session closed","wrap.triggerManual":"Panel","writes.filterWrap":"Wrap candidates only ({n})","writes.pendingNoWrap":"No wrap candidates right now","writes.originSessionWrap":"Wrap","settings.groupWrap":"Session wrap","settings.groupWrapDesc":"Distil lessons, decisions and open loops when a session ends; writes shadow candidates and rule proposals, never auto-accepts by default.","settings.wrapEnabled":"Enable session wrap","settings.wrapEnabledDesc":"Run one bounded distillation when a trigger fires.","settings.wrapCostNote":"Uses model tokens: at most one call per wrap, bounded by the daily cap.","settings.wrapExplicit":"Explicit wrap","settings.wrapExplicitDesc":"After phrases like “wrap up” or “switch session”, enqueue at turn end.","settings.wrapIdle":"Idle wrap","settings.wrapIdleDesc":"Off by default. Enqueues after the idle minutes pass with no open turn; the same material runs once.","settings.wrapDisposed":"Wrap on session close","settings.wrapDisposedDesc":"Off by default. Spools the buffer and enqueues when a session is closed or archived.","settings.wrapIdleMinutes":"Idle minutes","settings.wrapIdleMinutesDesc":"Default 10. Too short risks firing mid-task.","settings.wrapMaxItems":"Max items","settings.wrapMaxItemsDesc":"Maximum candidates or proposals kept from one distillation.","settings.wrapMaxRunsPerDay":"Daily auto cap","settings.wrapMaxRunsPerDayDesc":"Limits idle and close triggers only; explicit wrap is a human action and is not capped.","settings.wrapIngestMode":"Auto-ingest memories","settings.wrapIngestModeDesc":"auto: durable rules that pass the value gate go straight into memory; review: everything stays a review candidate (=0.7.3 rollback, never auto-lands).","settings.wrapIngestAuto":"auto (auto-ingest)","settings.wrapIngestReview":"review (review all)","settings.wrapIngestMinConfidence":"Minimum confidence","settings.wrapIngestMinConfidenceDesc":"Distilled items without confidence are treated as 0.5; below this threshold they go to review.","settings.wrapIngestDropTask":"Reject task sentences","settings.wrapIngestDropTaskDesc":"On: task instructions never enter long-term memory; off: they become review candidates (still not stored).","settings.wrapReport":"Write wrap report","settings.wrapReportDesc":"Write a Markdown report without raw conversation under reports/ in the data directory.","settings.wrapModel":"Wrap model","settings.wrapModelDesc":"Empty uses the current default model; a value overrides the model id (provider still comes from the default selection).","settings.wrapMaxMaterialChars":"Material char limit","settings.wrapMaxMaterialCharsDesc":"Only recent conversation is used; whole turns are dropped beyond the limit (default 12000 code points).","settings.wrapSpoolTtlHours":"Spool retention hours","settings.wrapSpoolTtlHoursDesc":"Failed or model-less runs keep raw material for retry; it is deleted after the TTL and is never backed up.","settings.wrapTimeoutMs":"Model timeout (ms)","settings.wrapTimeoutMsDesc":"Hard timeout for one distillation; timeouts retry as failures and never block the chat.","settings.wrapNote":"Candidates stay in shadow by default; rules only become proposals and never edit rule files automatically.","settings.firstRunWrap":"Enable session wrap","settings.firstRunWrapNote":"Calls the model when you explicitly say “wrap up”, spending tokens; idle/close auto wrap stays off until you enable it in Settings.","err.wrap_unavailable":"Wrap service is not installed","err.wrap_disabled":"Session wrap is disabled","err.no_material":"No session material to wrap","err.turn_in_progress":"The current turn is still running; try later","err.unsupported_backend":"This backend mode does not support wrapping","err.rate_limited":"Daily automatic wrap limit reached","err.same_material":"This material was already wrapped","err.report_missing":"Wrap report not found","err.report_path_outside":"Report path outside the reports directory; refused","overview.wrapDisabled":"Session wrap is off. Enable it under Settings → Session wrap.","err.busy_wrap":"A wrap run is already queued or running; try again shortly (possibly another session)","settings.wrapRetentionDays":"Run/report retention (days)","settings.wrapRetentionDaysDesc":"Default 180; 0 keeps forever. Only finished runs and unreferenced reports are removed; queued/running runs are never deleted.","health.queued":"Queued","overview.wrapSessionLabel":"Session","overview.wrapSessionRecent":"Most recent session with material","overview.wrapSessionSelected":"Selected session · {turns} turns","overview.wrapSessionOption":"{turns} turns · {state}","overview.wrapSessionRunning":"in progress","overview.wrapNoSession":"No captured session yet; chat a little and come back.","overview.wrapEmptyGuide":"Pick a session and click Wrap now, or say \"wrap\" in chat.","overview.wrapQueuedPosition":"Queued, please wait (position {n})","overview.wrapExisting":"This segment is wrapping/was wrapped (new dialogue triggers a rerun)","overview.wrapWarnings":"Warnings: {list}","overview.wrapRetryable":"retryable","overview.wrapFailureCount":"{n} recent failure(s) · expand","overview.wrapFailureHide":"Collapse failures","overview.wrapReportEmpty":"No report content yet.","overview.wrapErrorTurn":"This session is replying; wait for it to finish or pick another session","overview.wrapErrorNoMaterial":"This session has no dialogue to wrap yet","overview.wrapErrorDisabled":"Session wrap is disabled","overview.wrapErrorUnsupported":"The current backend does not support local wrap","overview.wrapErrorNoSession":"Session no longer exists; refresh and pick again","overview.wrapErrorSame":"This segment was already wrapped (new dialogue triggers a rerun)","overview.wrapErrorBusy":"Queue is full; try again later","overview.wrapErrorSessionBusy":"This session already has one queued run; retry after it finishes","overview.wrapErrorCapture":"Capture is not ready; try again later","overview.wrapErrorDb":"Memory database read/write failed; retry later","overview.wrapErrorBadJson":"Model output was not JSON; the retry also failed","overview.wrapErrorTimeout":"Model call timed out","overview.wrapErrorSpool":"Session material is missing; retry","overview.wrapErrorWrite":"Candidate write failed","overview.wrapProgress":"Wrap progress","overview.wrapPhaseQueued":"Queued","overview.wrapPhaseCapture":"Capture","overview.wrapPhaseDistill":"Distill","overview.wrapPhaseDispatch":"Dispatch","overview.wrapPhaseReport":"Report","overview.wrapRetrying":"Retrying {n}/{max}","overview.wrapSkipCleared":"Queue was cleared after restart; click wrap again if needed","overview.wrapSkipTimeout":"Queue wait timed out; please retry","overview.wrapSkipDisposed":"The session was closed; queued run cancelled","overview.wrapSkipBusy":"Another run is active; skipped this time","overview.wrapSkipRate":"Daily auto-wrap limit reached","err.queue_cleared":"The wrap queue was cleared by restart; start again","err.session_queue_full":"This session already has one queued run","err.busy_queue_full":"The wrap queue is full; try again later","overview.wrapAuto":"Auto wrap","overview.wrapAutoDesc":"After {n} min idle · uses model tokens","overview.wrapSkipAuto":"Skip auto wrap","overview.wrapSkipAutoDesc":"Only affects idle/dispose triggers; manual still works","overview.wrapSessionSkipped":"auto skipped","err.invalid_session":"Invalid session id","overview.wrapPhaseReconcile":"Reconcile","overview.wrapCopyReport":"Copy report","overview.wrapDownloadReport":"Download .md","overview.wrapSessionLoadFailed":"Failed to load session list"},"ja":{"meta.title":"ホエールメモリ","meta.description":"ローカル長期記憶：重要な事実・ルールをローカル SQLite に保存し、毎ターンの前にアイデンティティ別に想起・注入します。パネルで検索・編集・書き込み審査が可能。既定では外部リクエストを送りません（backend=http/hybrid のときだけ設定 URL に /stats /recent /search /recall /write /version）。無効化すると想起・書き込みが止まり、DB は ~/.dsh/whale-memory に残ります。ルール（鉄律）の真実源は ~/.dsh/rules の Markdown で、git で管理します。提案はあなたの確認後にのみ書き込まれ、DB は検索用ミラーです。","meta.detail":"docs/DETAIL.ja.md","tab.overview":"概要","tab.memory":"メモリ","tab.recall":"想起","tab.writes":"書き込みとエッジ","tab.settings":"設定","common.dash":"—","common.retry":"再試行する","common.refresh":"更新する","common.loading":"読み込み中…","common.empty":"データなし","common.close":"閉じる","common.save":"保存する","common.saving":"保存しています…","common.cancel":"キャンセル","common.search":"検索する","common.prev":"前へ","common.next":"次へ","common.pageInfo":"{total} 件のうち {from}–{to}","common.total":"全部で {total} 件","common.now":"たった今","common.yes":"はい","common.no":"いいえ","common.charCount":"{n} / {max} 文字まで","state.loading":"読み込み中…","state.error":"読み込みに失敗しました","state.empty":"データなし","health.db":"DB","health.migration":"移行","health.pending":"保留中","health.job":"ジョブ","health.ok":"OK","health.offline":"オフライン","health.running":"稼働しています","health.idle":"待機しています","overview.title":"概要","overview.offlineTitle":"バックエンドに接続できません","overview.offlineDesc":"記憶サービスに接続できません。DSH が稼働しているか確認してから再試行してください。","overview.recent":"直近 3 件の想起","overview.recentEmpty":"想起記録はまだありません","overview.health":"ヘルス","overview.scopeAll":"概要 KPI は全庫の集計です。メモリタブは現在のワークスペース単位で表示します。","overview.kpiNodes":"ノード総数","overview.kpiActive":"有効ノード数","overview.kpiRecalls":"本日の想起回数","overview.kpiEdges":"エッジ数","overview.injected":"{n} 文字を注入","overview.injectedNone":"注入なし","overview.refreshed":"{time} に更新","overview.hits":"{n} ヒット","overview.injectedBadge":"注入済み","overview.notInjectedBadge":"注入なし","overview.kpiZeroInjection":"ゼロ注入率","overview.kpiAdoption":"採択率","overview.kpiJobSuccess":"ジョブ成功率（7 日間）","overview.kpiDbSize":"DB サイズ","overview.targetMet":"目標 {target} を達成","overview.targetMissed":"目標 {target} に未達","overview.trend":"7 日間のトレンド","overview.trendEmpty":"7 日分のデータがありません","overview.trendInjected":"注入率","overview.trendZeroHit":"ゼロヒット比率","overview.trendToday":"今日","overview.trendTip":"{day}：想起 {recalls} · ヒット {withHits} · 注入 {injected} · 採択 {adopted} · ゼロヒット {zeroHit}","overview.failures":"最近の失敗","overview.failuresEmpty":"直近 24 時間に失敗ジョブはありません","overview.failureAttempts":"試行 {n}","memory.title":"メモリ","memory.searchPlaceholder":"キーワードで検索（300 ms デバウンス）…","memory.searching":"検索しています…","memory.noResults":"一致なし","memory.emptyTitle":"記憶が空です","memory.emptyDesc":"最初の記憶を書き込むか、JSONL ファイルをインポートしてください。","memory.writeFirst":"最初の記憶を書き込む","memory.importJsonl":"JSONL をインポート","memory.newTitle":"新しい記憶","memory.writePlaceholder":"記憶する本文（最大 500 文字）…","memory.writeLevel":"レベル","memory.writeType":"タイプ","memory.writeTags":"タグ（カンマ区切り）","memory.writeSubmit":"書き込む","memory.written":"書き込み完了：{id}","memory.colText":"テキスト","memory.colLevel":"レベル","memory.colType":"タイプ","memory.colStatus":"ステータス","memory.colScore":"スコア","memory.colSource":"ソース","memory.pageEmpty":"このページにレコードはありません","memory.searchMeta":"{count} 件が一致（しきい値未満の候補 {below} 件）","memory.searchMetaNoBelow":"{count} 件が一致","detail.title":"記憶の詳細","detail.text":"テキスト","detail.level":"レベル","detail.status":"ステータス","detail.tags":"タグ","detail.tagsPlaceholder":"カンマ区切り","detail.source":"ソース","detail.type":"タイプ","detail.created":"作成日時","detail.updated":"更新日時","detail.bitemporal":"バイテンポラル","detail.validAt":"有効期間の開始","detail.invalidAt":"無効になった日時","detail.expiredAt":"失効した日時","detail.supersededBy":"置換したノード","detail.archive":"アーカイブ","detail.archived":"アーカイブ済み","detail.saveEdit":"編集を保存","detail.saved":"保存しました","detail.loadFailed":"詳細の読み込みに失敗しました","detail.invalidText":"本文は 1〜500 文字にしてください","recall.title":"想起","recall.recent":"直近の想起（読み取り専用）","recall.colTime":"時刻","recall.colQuery":"クエリ","recall.colHits":"ヒット数","recall.colChars":"文字の数","recall.colElapsed":"かかった時間","recall.colInjected":"注入","recall.colUsed":"採用","recall.injectedYes":"注入済み","recall.injectedNo":"注入なし","recall.usedYes":"採用済み","recall.usedNo":"採用なし","recall.testTitle":"検索のみのテスト","recall.testNote":"検索エンドポイントだけを呼びます。モデル呼び出し・書き込み・想起の副作用はありません。","recall.testPlaceholder":"テストするキーワード…","recall.runTest":"検索する","recall.testEmpty":"一致なし（関連度が下限未満）","recall.testMeta":"{count} 件 · {ms} ms","recall.testError":"検索に失敗しました","recall.recentEmpty":"想起記録はまだありません","writes.title":"書き込みとエッジ","writes.pendingTitle":"審査待ちの書き込み候補（シャドー）","writes.pendingNote":"シャドーモードでは候補を記録するだけです。承認すると保存され、却下すると理由が監査に残ります。","writes.colText":"候補の本文","writes.accept":"承認する","writes.reject":"却下する","writes.reviewDone":"審査を送信しました（一覧を更新済み）","writes.reviewFailed":"審査に失敗しました","writes.recent":"直近の書き込み監査（読み取り専用）","writes.colTime":"時刻","writes.colAction":"アクション","writes.colNode":"ノード","writes.colReason":"理由","writes.edges":"エッジ","writes.recentCount":"直近の書き込み","writes.note":"このページは読み取り専用です。書き込みは記憶 API と想起時の注入から発生します。","writes.empty":"書き込み記録はまだありません","settings.title":"設定","settings.groupBackend":"バックエンド","settings.groupRecall":"注入","settings.groupWrite":"書き込み","settings.groupTools":"モデルツール","settings.groupBackground":"バックグラウンドと同期","settings.groupPanel":"パネル","settings.groupAdvanced":"詳細オプション","settings.backendMode":"バックエンドモード","settings.backendUrl":"外部サービスの URL","settings.backendTimeout":"リクエストタイムアウト（ms）","settings.recallEnabled":"想起時の注入を有効化","settings.maxHits":"最大ヒット数","settings.charBudget":"注入の文字数上限","settings.intentBudget":"意図別の注入枠（画像プロンプトは 0）","settings.minRel":"関連度の下限（0–1）","settings.recallTimeout":"想起のタイムアウト（ms）","settings.writeEnabled":"書き込みを有効化","settings.toolsEnabled":"モデル記憶ツールを有効化","settings.reviewMode":"書き込みの審査","settings.maxChars":"1 件あたりの最大文字数","settings.toolsMaxWritesPerTurn":"1 ターンの書き込み系ツール上限","settings.searchFeed":"検索要約を記憶として保存（24 時間 TTL）","settings.reflectEnabled":"アイドル時の内省を有効化","settings.syncEnabled":"ゲートウェイと同期","settings.pollMs":"パネルの更新間隔（ms）","settings.allowRemote":"非ループバックからのアクセスを許可","settings.logLevel":"ログレベル","settings.worker":"検索をワーカーで実行","settings.save":"設定を保存","settings.saved":"保存しました（{time}）","settings.saveFailed":"保存に失敗しました","settings.loadFailed":"設定の読み込みに失敗しました","settings.defaultsNote":"変更した項目だけを保存します。返却されないグループは既定値で表示され、設定には書き込まれません。","settings.restartNote":"バックエンドとワーカーの変更は、通常プラグインを再読み込みすると反映されます。","settings.allowRemoteWarn":"有効にすると webServer.host のバインドアドレスのみ追加許可されます（読み取り）。非ループバックでは身份上書き引数は無視されます。","settings.readonlyUnavailable":"この実行環境では設定を保存できません（読み取り専用）。","settings.invalidValue":"範囲外または数値でない値があります。修正してから保存してください。","import.reading":"ファイルを読み込み中…","import.uploading":"インポート中…","import.tooLarge":"ファイルが 4 MB を超えています。分割してからインポートしてください。","import.readFailed":"ファイルの読み込みに失敗しました。","import.smallDone":"インポート完了：追加 {added} · スキップ {skipped} · エラー {errors}","import.progress":"インポート中 {done}/{total} · 追加 {added} · スキップ {skipped} · エラー {errors}","import.done":"インポート完了：追加 {added} · スキップ {skipped} · エラー {errors}","import.failed":"インポートに失敗しました","import.total":"{total} 行のデータ","import.button":"JSONL をインポート","sync.button":"ゲートウェイと同期","sync.dryTitle":"同期のドライラン（何も書き込みません）","sync.pull":"プル：+{added} / スキップ {skipped} / エラー {errors} / {lines} 行","sync.push":"プッシュ：{lines} 行","sync.confirm":"同期を確認","sync.done":"同期が完了しました","sync.busy":"同期しています…","reflect.button":"内省を実行","reflect.done":"内省しました：+{added}（素材 {material}）","reflect.busy":"内省しています…","reflect.disabled":"内省は無効です：設定で reflect.enabled を有効にしてください","import.export":"エクスポート","import.accept":".jsonl,.txt,text/plain","status.active":"アクティブ","status.archived":"アーカイブ済み","status.stale":"古くなった","status.superseded":"置換済み","level.core":"コア","level.important":"重要","level.normal":"ノーマル","type.semantic":"セマンティック","type.procedural":"手続き","type.episodic":"エピソード","type.mixed":"ミックス","source.owner":"オーナー","source.self":"セルフ","source.group":"グループ","source.web":"ウェブ","source.tool":"ツール","source.import":"インポート","err.network":"ネットワークに接続できません。DSH が稼働しているか確認してください。","err.backend_unreachable":"記憶バックエンドに接続できません。","err.backend_unavailable":"記憶バックエンドはこの機能を提供していません。","err.backend_error":"記憶バックエンドがエラーを返しました。","err.invalid_query":"クエリを空にできません。","err.invalid_text":"本文が不正です（1〜500 文字）。","err.invalid_level":"レベルが不正です。","err.invalid_memory_type":"記憶の種類が不正です。","err.invalid_tags":"タグが不正です。","err.identity_required":"アイデンティティのキーが不足しているため、読み書きできません。","err.identity_mismatch":"アイデンティティが現在のセッション/設定と一致しないため拒否しました。","err.write_disabled":"書き込みは無効です。","err.duplicate":"同じ内容が既に存在するためスキップしました。","err.node_not_found":"記憶ノードが見つかりません。","err.job_not_found":"インポートジョブが見つかりません。","err.invalid_job_id":"インポートジョブ ID が不正です。","err.config_save_unavailable":"この実行環境では設定を保存できません（読み取り専用）。","err.config_save_failed":"設定の保存に失敗しました。","err.invalid_config":"設定が不正です。","err.invalid_value":"値が範囲外です。","err.payload_too_large":"リクエスト本文が大きすぎます（上限 4 MB）。","err.invalid_jsonl":"JSONL の内容が不正です。","err.method_not_allowed":"このメソッドは許可されていません。","err.not_found":"エンドポイントが見つかりません。","err.not_loopback":"ループバックからのアクセスのみ許可されています。","err.file_too_large":"ファイルが 4 MB を超えています。分割してからインポートしてください。","err.read_error":"ファイルの読み込みに失敗しました。","err.unknown":"不明なエラーです。","settings.groupIdentity":"アイデンティティ","settings.groupReflect":"内省","settings.groupConsolidate":"統合","settings.groupEmbed":"ベクトル埋め込み","settings.groupPrivacy":"プライバシー","settings.groupEdges":"エッジ","settings.groupSync":"同期","settings.groupDanger":"危険な操作","settings.identityMode":"アイデンティティモード","settings.identityModeDesc":"auto はホストのセッションからアイデンティティを決めます。fixed は下の値を使います。","settings.identityRoleIdDesc":"空ならロールの制限なし。","settings.identityWorkspaceDesc":"空なら現在のワークスペース。","settings.reflectEnabledDesc":"アイドル時に記憶を内省して整理します。","settings.syncEnabledDesc":"ゲートウェイと記憶を同期します。ブリッジ URL は profile が注入します。","settings.identityUserId":"ユーザー ID（userId）","settings.identityRoleId":"ロール ID（roleId）","settings.identityWorkspace":"ワークスペース（workspace）","settings.identityAutoNote":"auto：userId はホストのセッションから決まります。現在は「local」にフォールバックしています。","settings.identityFixedNote":"fixed：下の値を使います。userId が空だと読み書きに失敗します。","settings.injectLevels":"注入を許可するレベル（カンマ区切り）","settings.injectLevelsDesc":"例：core,important。空なら制限なし。","settings.showSources":"注入本文にソースを表示","settings.showSourcesDesc":"注入本文の末尾にノードのソースを付けます。","settings.dailyCap":"1 日の書き込み上限","settings.dailyCapDesc":"1 日の書き込み件数の上限です。","settings.searchTtlHours":"検索要約の TTL（時間）","settings.searchTtlHoursDesc":"検索要約の記憶の TTL です。","settings.judge":"書き込み判定","settings.judgeDesc":"rules はヒューリスティック、llm はモデルを呼びます。","settings.ignorePatterns":"無視パターン（1 行に 1 件）","settings.ignorePatternsDesc":"いずれかのパターンに一致する本文は書き込みません。","settings.writeModel":"書き込み判定モデル（judge=llm のときに使用）","settings.writeModelDesc":"空なら現在の既定モデル。","settings.reflectModel":"内省モデル","settings.reflectModelDesc":"空なら現在の既定モデル。","settings.idleMinutes":"アイドル判定（分）","settings.idleMinutesDesc":"ユーザーがこの時間アイドルになると実行します。","settings.maxItems":"1 回あたりの最大件数","settings.maxItemsDesc":"1 回の内省で作る新しい記憶の上限です。","settings.maxRunsPerDay":"1 日の最大実行回数","settings.maxRunsPerDayDesc":"1 日の内省実行回数の上限です。","settings.consolidateEnabled":"統合を有効化","settings.consolidateEnabledDesc":"重複ノードと期限切れノードを定期的に統合します。","settings.consolidateInterval":"統合の間隔（時間）","settings.consolidateIntervalDesc":"統合を実行する間隔です。","settings.embedEnabled":"ベクトル検索を有効化","settings.embedEnabledDesc":"外部のベクトルサービスが必要です。既定では本機に接続されていません。","settings.embedEndpoint":"ベクトルサービスのエンドポイント","settings.embedEndpointDesc":"OpenAI embeddings 互換のエンドポイントです。","settings.embedModel":"埋め込みモデル","settings.embedModelDesc":"埋め込みモデル名です。","settings.embedBatch":"埋め込みのバッチサイズ","settings.embedBatchDesc":"1 バッチあたりの件数です。","settings.embedNote":"本機にはプロバイダが接続されていません。有効にするとジョブは「unavailable」を返します。","settings.privacyRedact":"書き込み前に伏字化","settings.privacyRedactDesc":"書き込み前に機密フィールドを置換します。","settings.privacyRetention":"アーカイブの保持日数（0 = 無期限）","settings.privacyRetentionDesc":"0 ならアーカイブを無期限に保持します。","settings.privacyDanger":"retentionDays > 0 のとき、期限切れのアーカイブを物理削除します。","settings.edgesDiffusion":"1 ホップのエッジ拡散を有効化","settings.edgesDiffusionDesc":"想起時にエッジを 1 ホップ辿って候補を広げます。","settings.edgesMinConf":"エッジの最小信頼度","settings.edgesMinConfDesc":"この信頼度未満のエッジは拡散しません。","settings.syncMode":"同期の方向","settings.syncModeDesc":"off は無効、push/pull/both は方向を選びます。","settings.syncInterval":"同期の間隔（分）","settings.syncIntervalDesc":"定期同期の間隔です。","settings.syncHttpTimeout":"同期のタイムアウト（ms）","settings.syncHttpTimeoutDesc":"同期リクエストの HTTP タイムアウトです。","settings.syncBatch":"同期のバッチサイズ","settings.syncBatchDesc":"1 バッチあたりの件数です。","settings.syncBridgeNote":"bridgeUrl は profile が注入するため、ここでは編集できません。","settings.panelTab":"既定のタブ","settings.panelTabDesc":"パネルを開いたときに選択されるタブです。","settings.pollMsDesc":"概要タブの自動更新間隔です。","settings.allowRemoteDesc":"既定ではループバックのみ。有効化するとバインドアドレスのみ追加許可。","settings.traceId":"traceId（トレース識別子）","settings.traceIdDesc":"書き込み監査とログに付けるトレース識別子です。","settings.logLevelDesc":"プラグインのログレベルです。","settings.workerDesc":"メインスレッドを止めないよう、検索はワーカースレッドで実行します。","settings.exportMemory":"記憶をエクスポート（JSONL をダウンロード）","settings.dangerNote":"クリア／リセットのエンドポイントはありません。この版に破壊的な操作はありません。","settings.dataDir":"データディレクトリ（読み取り専用）","settings.dataDirDesc":"ホストの profile によって決まります。","settings.readonlyTag":"読み取り専用","settings.effectInstant":"すぐに反映","settings.effectReload":"再読み込み","settings.effectLabel":"反映タイミング","settings.savedButReloadFailed":"保存しましたが、設定の再読み込みに失敗しました。","settings.backendModeDesc":"既定はローカルの SQLite です。http/hybrid では外部サービスを使います。","settings.backendUrlDesc":"backend.mode が local 以外のときだけ使います。","settings.backendTimeoutDesc":"外部サービスへのリクエストごとのタイムアウトです。","settings.recallEnabledDesc":"無効にするとどの記憶も注入されません。","settings.maxHitsDesc":"1 回の想起で注入するヒット数の上限です。","settings.charBudgetDesc":"注入本文の合計文字上限。0 = 注入オフ（どの記憶も注入されません）。","settings.intentBudgetDesc":"画像プロンプトの意図には注入しません（0）。","settings.minRelDesc":"この関連度未満の候補は除外されます。","settings.recallTimeoutDesc":"想起はタイムアウト後にフェイルオープンし、ターンを止めません。","settings.writeEnabledDesc":"無効にすると書き込みと候補の審査が止まります。","settings.toolsEnabledDesc":"オフにするとモデルツールはツール一覧に出なくなります。パネルからの書き込みとセッション締めの取り込みには影響しません。","settings.reviewModeDesc":"shadow は候補を記録するだけ、auto は直接書き込みます。","settings.maxCharsDesc":"記憶の本文 1 件あたりの上限です。","settings.toolsMaxWritesPerTurnDesc":"1 ターン内に remember/update/forget を試行できる回数の上限です。超えると RATE_LIMITED を返します。対象はモデルツールだけで、セッション締めの取り込みには影響しません。","settings.searchFeedDesc":"検索要約を記憶として保存します。","recall.explain":"内訳の説明","recall.explainHint":"展開するとスコアの内訳を表示します","recall.colRel":"関連度","recall.colMult":"倍率","recall.colGain":"利得","recall.colEffWeight":"実効重み","recall.colPath":"ヒット経路","recall.colMatched":"一致した語","recall.pathFallback":"L1/L2","recall.belowMin":"しきい値未満の候補がほか {n} 件","recall.noComponents":"このヒットにはスコアの内訳がありません","writes.pendingEmpty":"審査待ちの候補はありません","writes.edgesTitle":"エッジの統計","writes.edgesEmpty":"エッジはまだありません","writes.evolutionTitle":"直近の変化","writes.evolutionEmpty":"変化の記録はありません","writes.colType":"タイプ","writes.colCount":"件数","writes.colFromTo":"リレーション","writes.colField":"フィールド","memory.candidateQueued":"審査キューに追加しました（「書き込みとエッジ」タブで審査してください）","sync.disabled":"同期は無効です：設定で sync.enabled を有効にしてください。","header.identity":"アイデンティティ","header.identityTip":"現在の記憶アイデンティティ：{workspace} / {userId} / {roleId}","err.sync_disabled":"同期は無効です（sync.enabled=false）。","err.sync_bridge_unset":"同期ブリッジ URL が未設定です（profile が bridgeUrl を注入します）。","err.confirm_required":"確認が不足しています：同期は confirm=true、完全削除は confirmKey にルール key が必要です。","err.invalid_direction":"同期方向が不正です（pull/push/both）。","err.busy":"同じ種類の処理が実行中です。しばらくして再試行してください。","err.reflect_unavailable":"内省スケジューラは利用できません。","err.candidate_not_found":"審査待ちの候補が見つかりません。","err.invalid_review":"審査のパラメータが不正です。","err.privacy":"内容がプライバシールールに該当したため書き込みませんでした。","err.daily_cap":"1 日の書き込み上限に達しました。","err.text_too_long":"本文が文字数上限を超えています。","err.unknown_error":"不明なエラーです。","err.network_error":"ネットワークに接続できません。DSH が稼働しているか確認してください。","settings.defaultValue":"デフォルト：{value}","settings.defaultOn":"オン","settings.defaultOff":"オフ","settings.defaultEmpty":"なし","settings.badgeGeneral":"共通","settings.badgeLocal":"ローカル","settings.badgeNeedsConfig":"設定が必要","settings.depUnmet":"依存条件を満たしていません：{reason}","settings.depBackendUrl":"backend.mode が local 以外のときのみ有効","settings.depWriteModel":"judge=llm のときのみ使用","settings.depEmbed":"先にベクトル検索を有効にしてください","settings.depSync":"先に同期を有効にしてください","settings.depPanelRemote":"非ループバックアクセスを許可した場合のみ有効","settings.effectDaily":"毎日","settings.groupBackendDesc":"ローカル DB か外部メモリサービスかを選びます。外部サービスのみ URL とタイムアウトが必要です。","settings.groupIdentityDesc":"各記憶が誰・どのワークスペースに属するかを決めます。auto はホストのセッションに従います。","settings.groupRecallDesc":"毎ターンどれだけ・どの程度関連する・どのレベルを注入するかを決め、回答の「記憶力」に直結します。","settings.groupWriteDesc":"何を記憶するか、書き込み前の審査、1 件あたりと 1 日あたりの上限を決めます。","settings.groupToolsDesc":"モデル側の記憶ツール（memory_remember / memory_search / memory_read / memory_update / memory_forget）を表示するか、1 ターンあたりの書き込み系ツールの試行上限を決めます。","settings.groupReflectDesc":"アイドル時にモデルへ記憶を整理させます。既定はオフで、モデルが必要です。","settings.groupConsolidateDesc":"重複と期限切れノードを定期的に統合し、庫が無限に膨らむのを防ぎます。既定はオンです。","settings.groupEmbedDesc":"外部ベクトルサービスで意味検索を行います。本機に無い場合はオフのままで構いません。","settings.groupPrivacyDesc":"書き込み前のマスクとアーカイブ保持期間。期限切れは物理削除されます。","settings.groupEdgesDesc":"想起時にリレーションエッジを 1 ホップ辿り、低信頼のエッジを除外します。","settings.groupSyncDesc":"ゲートウェイと双方向で記憶を同期します。ブリッジ URL は profile が注入します。","settings.groupPanelDesc":"このパネルの更新間隔・既定タブ・アクセス範囲です。","settings.groupAdvancedDesc":"ログや検索スレッドなどのトラブルシュート項目。通常は変更不要です。","settings.groupDangerDesc":"エクスポートの入口。この版にはクリア/リセット API が無いため破壊的ボタンは置きません。","settings.backendId":"バックエンド ID","settings.backendIdDesc":"サービス登録と障害調査用の固定識別子。ローカルモードでは空で構いません。","settings.syncBridgeUrl":"同期ブリッジ URL","settings.syncBridgeUrlDesc":"profile が注入します。手で変更した値は次回の設定読込で上書きされます。","settings.syncDryRun":"同期の既定をドライランにする","settings.syncDryRunDesc":"オンのときは差分比較のみでリモートに書きません。本実行はヘッダーで再確認が必要です。","settings.charBudgetZeroConfirm":"charBudget=0 は注入を停止します：このターンはどの記憶も注入されません。保存しますか？","settings.sectionLabel":"記憶ハブ","header.backendStatus":"バックエンド：{mode} · プロトコル {protocol} · outbox {outbox}","header.backendStatusTip":"GET /version より取得。利用できない場合は各項目が — になります","header.protocolOk":"OK","header.protocolMismatch":"互換性なし","health.backend":"バックエンド","health.protocol":"プロトコル","health.outbox":"アウトボックス","overview.migrationTitle":"移行の状態","overview.migrationPending":"移行の確認待ち","overview.migrationPendingDesc":"ID/データ移行が未確認です。設定タブで確認して保存してください。","overview.migrationFrom":"移行元","overview.migrationAt":"移行した日時","overview.openSettings":"設定へ","overview.offlineBackendTitle":"外部サービス未接続","overview.offlineBackendDesc":"バックエンドが http/hybrid ですが外部サービスの URL が空です。ワンクリックでローカル庫に戻せます。","overview.switchLocal":"ローカルに切り替え","overview.switchLocalDone":"ローカル庫に切り替えました","overview.switchLocalFailed":"切り替え失敗","memory.sampleTitle":"サンプル記憶","memory.sampleDesc":"サンプル記憶を 3 件書き込みます。あとでワンクリックで片付けられます。","memory.sampleWrite":"サンプルを書き込む","memory.sampleCleanup":"サンプルを片付ける","memory.sampleCleanupConfirm":"片付けはこの 3 件をアーカイブします（履歴は削除せず、監査は保持）。続行しますか？","memory.sampleDone":"サンプル 3 件を書き込みました","memory.sampleCandidate":"シャドーモードのためサンプルは審査待ちに入り、直接書き込まれていません","memory.sampleCleaned":"サンプルをアーカイブしました","memory.sample1":"Whale Memory は既定でローカル SQLite を使い、記憶をクラウドへ送りません。","memory.sample2":"各ターンの開始前に、関連する記憶を少しだけ想起してコンテキストへ注入します。","memory.sample3":"書き込みは既定で shadow 審査を通り、候補が監査に残り、承認後に記憶になります。","recall.budgetTitle":"注入の予算","recall.budgetLine":"上限 {chars} 文字 · 最大 {hits} 件まで · 意図枠 {intent}","recall.budgetIntentOn":"オン","recall.budgetIntentOff":"オフ","recall.budgetZero":"0 文字 = 注入オフ（どの記憶も注入されません）","recall.filterLabel":"絞り込み","recall.filterAll":"すべて","recall.filterUnused":"未採用","recall.filterZero":"ゼロヒット","recall.colSource":"ソース","writes.rejectReason":"却下の理由（任意）","writes.rewrite":"本文の書き換え（任意）","writes.rewriteHint":"空なら原文のまま承認。入力すると承認後にそのノード本文を書き換えます。","writes.confirmReview":"審査を送信","writes.reviewFormTitle":"候補を審査","writes.actionAdd":"追加する","writes.actionNoop":"変更なし","writes.actionMerge":"マージ","writes.actionSupersede":"置換する","writes.actionReject":"却下する","writes.actionCandidate":"候補","writes.oldValue":"以前の値","writes.newValue":"新しい値","detail.origin":"エビデンス（origin）","detail.originUnavailable":"提供なし","detail.edges":"1 ホップ隣接エッジ","detail.edgesUnavailable":"提供なし（/nodes/:id が edges を返していません）","detail.edgesEmpty":"隣接エッジなし","detail.archiveConfirm":"アーカイブは取り消せません（監査は追跡可能）。この記憶をアーカイブしますか？","detail.saveConfirm":"編集は本文を書き換え、監査記録を残します。保存しますか？","header.rolePrefix":"ロール：{roleId}","tab.rules":"ルール","rules.intro":"ルール＝バージョン管理できる行動制約。鉄律の番号は固定で、再利用しません。","rules.gitTitle":"Git リポジトリ","rules.gitOk":"git {version}","rules.gitMissing":"git 未インストール","rules.gitBroken":"git 状態が異常","rules.gitUnknown":"git の状態が不明","rules.gitRequiredHint":"設定で git 必須のため、無いとルール機能は無効です","rules.gitChecked":"{time} に確認","rules.gitGuide":"インストール手順","rules.gitRefresh":"git 状態を更新","rules.gitGuideTitle":"git のインストール（任意）","rules.gitGuideIntro":"ルールファイルはプレーンテキストです。git は履歴・diff・ロールバックのためだけに使います。環境に合うコマンドを1つ選んでください：","rules.gitGuideBrew":"macOS（Homebrew）","rules.gitGuideApt":"Debian / Ubuntu","rules.gitGuideWinget":"Windows（winget）","rules.gitGuideDownload":"git-scm.com/downloads からインストーラーを取得しても可","rules.gitGuideSnapshot":"git が無くても、履歴 / diff / ロールバックはローカルスナップショットで利用できます。コミット記録が無いだけで、差分はスナップショットの行比較です。","rules.dirLabel":"ルールディレクトリ","rules.copyDir":"パスをコピー","rules.copied":"コピーしました","rules.copyFailed":"コピー失敗","rules.rebuildMirror":"ミラーを再構築","rules.rebuilding":"再構築しています…","rules.rebuildConfirm":"ミラー再構築はルールファイルを記憶 DB へ書き込み（想起注入用）ます。ルールファイルは変更しません。続行しますか？","rules.rebuildDone":"ミラーを再構築しました","rules.mirrorNote":"ミラーはルールファイルの DB コピーで、パネル検索用です。会話の想起では読みません。再構築はファイルを読むだけで変更しません。","rules.importLegacy":"記憶から鉄律をインポート","rules.importing":"インポート中…","rules.importConfirm":"記憶にある鉄律ノードをルールファイルへ複製します（番号は固定で再利用しません）。記憶ノードは変更しません。続行しますか？","rules.importDone":"鉄律をインポートしました","rules.importCount":"全部で {n} 件","rules.filterLabel":"絞り込み","rules.filterAll":"すべて","rules.filterIron":"鉄律","rules.filterNormal":"通常ルール","rules.filterCandidate":"候補","rules.filterRetired":"退役済み","rules.searchPlaceholder":"番号 / タイトル / 本文で絞り込み…","rules.listMeta":"{shown} / {total} 件を表示","rules.colNumber":"番号","rules.colType":"タイプ","rules.colPriority":"優先度","rules.colScope":"スコープ","rules.colStatus":"ステータス","rules.colUpdated":"更新日時","rules.colExcerpt":"ダイジェスト","rules.colOps":"アクション","rules.detail":"詳細を見る","rules.detailTitle":"ルール詳細","rules.tableEmpty":"この絞り込みに一致するルールはありません","rules.proposalsTitle":"未確認の提案 {n} 件","rules.proposalsEmpty":"未確認の提案はありません","rules.emptyTitle":"ルールファイルはまだ空です","rules.emptyWhy":"ルールが必要な理由：「必ずこうする」を diff・ロールバックできるテキストにし、チャット内の約束を失わないため。","rules.emptyStepImport":"「記憶から鉄律をインポート」を押すと、既存の鉄律ノードがルールファイルになります。","rules.emptyStepEdit":"ルールファイルは ~/.dsh/rules（設定で変更可）にあり、任意のテキストエディタで直接編集できます。","rules.emptyStepRefresh":"編集後に戻って更新してください。「ミラー自動再構築」が有効なら最新ファイルを読みます。","rules.statusActive":"アクティブ","rules.statusCandidate":"候補","rules.statusRetired":"退役","rules.statusMerged":"統合済み","rules.statusSuperseded":"置換済み","rules.statusDraft":"下書き","rules.statusProposed":"未確認","rules.typeIron":"鉄律","rules.typeNormal":"通常ルール","rules.fieldNumber":"番号","rules.fieldType":"タイプ","rules.fieldPriority":"優先度","rules.fieldScope":"スコープ","rules.fieldRole":"ロール","rules.fieldStatus":"ステータス","rules.fieldCreated":"作成","rules.fieldUpdated":"更新","rules.fieldVersion":"バージョン","rules.fieldOrigin":"出所","rules.fieldPath":"ファイルパス","rules.fieldMergedInto":"統合先ノード","rules.fieldSupersededBy":"置換先ノード","rules.bodyTitle":"全文","rules.conditions":"条件","rules.exceptions":"例外","rules.none":"なし","rules.history":"履歴","rules.historyEmpty":"履歴はありません","rules.historySourceGit":"git","rules.historySourceSnapshot":"スナップショット","rules.historyHint":"バージョンを選ぶと現在の本文と行単位で比較します","rules.diff":"バージョン比較","rules.diffOld":"旧","rules.diffNew":"新","rules.diffEmpty":"このバージョンは現在の本文と同じです","rules.rollback":"このバージョンへ戻す","rules.edit":"編集","rules.fieldKey":"キー（key）","rules.editTitle":"ルールを編集","rules.editHint":"本文と構造化フィールドのみ変更します。保存するとルールファイルを書き込み、ロールバック可能な新しい版を作成します。","rules.editImmutableNote":"key・種別・番号は読み取り専用です（番号は固定で再利用しません）。","rules.editTextLabel":"テキスト（500 文字以内）","rules.editConditionsLabel":"条件（1 行に 1 件）","rules.editExceptionsLabel":"例外（1 行に 1 件）","rules.editScopeLabel":"スコープ","rules.editScopeValueLabel":"スコープ値","rules.editScopeGlobal":"グローバル","rules.editScopeWorkspace":"ワークスペース","rules.editScopeRole":"ロール","rules.editScopeOther":"その他（現在値を保持）","rules.editScopeWorkspacePlaceholder":"ワークスペースの絶対パス（例 /srv/project）","rules.editScopeRolePlaceholder":"ロール id（空白なし）","rules.editScopeInvalid":"スコープ値が不正です：ワークスペースは絶対パス、ロール id に空白は使えません。","rules.editPriorityLabel":"優先度","rules.editStatusLabel":"ステータス","rules.editStatusActive":"アクティブ（active）","rules.editStatusRetired":"退役（retired）","rules.editRetiredHint":"退役＝以降は注入しませんが、ファイルと履歴は保持します。","rules.editRetireConfirm":"退役後はこのルールを注入しませんが、ファイルと履歴は保持されます。退役しますか？","rules.editPreview":"変更をプレビュー","rules.editPreviewTitle":"変更プレビュー","rules.editPreviewFieldText":"テキスト","rules.editPreviewFieldConditions":"条件","rules.editPreviewFieldExceptions":"例外","rules.editPreviewFieldScope":"スコープ","rules.editPreviewFieldPriority":"優先度","rules.editPreviewFieldStatus":"ステータス","rules.editDiffServerNote":"diff の基準はサーバーが返す現在の本文です。","rules.editDiffLocalNote":"利用できる現在のバージョン情報がないため、ローカルで行単位に比較しました。","rules.editDiffFieldsOnly":"本文は変わらず、構造化フィールドのみ変更します","rules.editBack":"編集に戻る","rules.editSubmit":"確定して保存","rules.editConfirm":"保存するとルールファイルを書き込み、新しい版を作成し（履歴は保持）、AGENTS 摘要を更新します。保存しますか？","rules.editDone":"ルールを保存しました","rules.editNoChange":"送信する変更がありません","rules.editInvalidText":"本文は 1〜500 字にしてください","rules.agentsSynced":"AGENTS 摘要はルールファイルに追従します（ファイルが真源）","rules.currentRev":"現在の版","rules.currentRevHint":"この版が現在の版です。ロールバックは無効です。","rules.rollbackHint":"ロールバックはその版の内容で新しい版を作成します（履歴は削除しません）。","rules.rollbackSelectHint":"先に履歴から版を選択してください","rules.rollbackCurrentHint":"現在の版にロールバックは不要です","rules.revertConfirm":"ロールバックはその版の内容を新しい版として書き込みます（履歴はすべて保持し、削除しません）。実行しますか？","rules.revertDone":"その版へ戻しました","rules.revertBusy":"ロールバック中…","rules.diffServerFail":"サーバーの diff が使えないため、ローカル比較に切り替えました。","rules.diffLoading":"diff を読み込み中…","rules.errGitHint":"git をインストールする（ルールページのインストール案内）か、設定の「git 必須」をオフにしてください。","rules.errInvalidDetail":"フィールドの指摘：{detail}","rules.opFailed":"操作に失敗","settings.groupRules":"ルール","settings.groupRulesDesc":"ルールファイルのディレクトリ、git ゲート、提案ペース、ミラー。オフ＝検出 / 注入 / 提案なし、ファイル管理は可。","settings.rulesEnabled":"ルール機能","settings.rulesEnabledDesc":"オフ＝検出 / 注入 / 提案を行わない。ルールファイルは「ルール」タブで管理できます。","settings.rulesDir":"ルールディレクトリ","settings.rulesDirDesc":"空＝~/.dsh/rules。変更後はミラー再構築が必要です。","settings.rulesRequireGit":"git を必須にする","settings.rulesRequireGitDesc":"オンにすると git が無い場合ルール機能を無効化（履歴 / diff / ロールバックも不可）。既定はオフでローカルスナップショットを使用。","settings.rulesAskMode":"提案の確認方法","settings.rulesAskModeDesc":"panel+chat＝パネルとチャット両方で確認；panel＝パネルのみ；off＝自発的に確認しない。","settings.rulesAskPanelChat":"パネル + チャット","settings.rulesAskPanel":"パネルのみ","settings.rulesAskOff":"オフ","settings.rulesLlm":"モデルでルールを整文","settings.rulesLlmDesc":"オンにするとモデルが候補提案をルール文に整えます。既定オフ（追加のモデル呼び出しと費用を避ける）。","settings.rulesMaxProposals":"提案の上限","settings.rulesMaxProposalsDesc":"同時に保持する未確認提案の上限（超過分は古い順に破棄）。","settings.rulesGuardStrict":"厳格ガード","settings.rulesGuardStrictDesc":"注入前にルールで強制検証し、競合は遮断。オフ＝警告のみ。","settings.rulesMirrorAuto":"ミラー自動再構築","settings.rulesMirrorAutoDesc":"ルールファイル変更後に DB へ自動同期（想起用）。オフ＝手動で「ミラーを再構築」。","settings.rulesAskCooldownDays":"確認クールダウン（日）","settings.rulesAskCooldownDaysDesc":"同じルールを再確認する最短間隔。0＝毎回確認。","settings.rulesConfigLayerNote":"次の4つのキーは設定ファイル層でのみ有効です（パネルにスイッチはありません）：rules.renderAgents（AGENTS 要約を再描画するか）、rules.injectChars（毎ターンの注入文字予算、0=無効）、rules.createAgentsIfMissing（空の環境で AGENTS 管理ブロックを自動作成するか）、rules.summaryBudgetChars（要約の総予算・コードポイント、既定 6000）。変更するにはプラグイン設定を編集してホストを再起動してください。","settings.depRulesEnabled":"ルール機能がオフのため、この項目は無効です","rules.typeCandidate":"候補ルール","rules.importSkipped":"既に存在するためスキップしました","err.rules_disabled":"ルール機能がオフです（設定 → ルール）","err.git_required":"設定で git が必須ですが、利用できる git が見つかりません：git をインストールするか、「git 必須」（rules.requireGit）をオフにしてください","err.rule_not_found":"ルールが見つかりません（削除または改名された可能性）","err.invalid_patch":"送信した変更内容が不正です","err.immutable_field":"そのフィールドは変更できません（key・種別・番号は読み取り専用）","err.invalid_rule":"ルール検証に失敗しました","err.rev_not_found":"その版は存在しないか削除済みです","err.rule_guard_failed":"ルールガードに失敗しました","err.rule_proposal_not_found":"提案が見つからないか処理済みです","err.rule_proposal_expired":"提案の有効期限が切れています","err.invalid_acknowledge":"破棄確認の形式が不正です：ルールごとに破棄する条項（key + 条項）を列挙してください。ルール単位の一括承認は受け付けません。","rules.gitMissingDetail":"git が無くてもローカルスナップショットで履歴 / diff / ロールバック可","rules.proposalsCount":"未確認の提案 {n} 件","rules.proposalsJump":"未確認の提案へ移動","rules.proposalLoading":"提案を読み込み中…","rules.proposalError":"提案の読み込みに失敗しました","rules.relNew":"新規ルール","rules.relDuplicate":"重複あり","rules.relRefine":"細分化する","rules.relMerge":"統合する","rules.relConflict":"競合あり","rules.relUnrelated":"無関係","rules.proposalStatusPending":"未確認","rules.proposalStatusNeedsManual":"手動での確認","rules.proposalStatusAccepted":"採用済み","rules.proposalStatusRejected":"却下済み","rules.proposalStatusExpired":"期限切れ","rules.proposalSource":"出典スニペット","rules.proposalMeta":"番号 {number} · 優先度 {priority} · スコープ {scope}","rules.proposalAffected":"影響を受ける既存ルール","rules.proposalOld":"旧","rules.proposalNew":"新","rules.proposalChanged":"変更あり","rules.proposalPreserved":"保持する条項","rules.proposalDropped":"破棄する条項","rules.proposalGuardFailed":"ガード未通過","rules.proposalRiskTitle":"高リスク操作","rules.proposalRiskGuard":"ガード検証に失敗しました。サーバーが採用を拒否する可能性があります。","rules.proposalRiskDropped":"この採用で {n} 件の条項を破棄します。","rules.proposalAckDropped":"これらの条項の削除を確認しました","rules.proposalAckHint":"「条項の削除を確認しました」にチェックしてから採用してください","rules.proposalApply":"採用する","rules.proposalRewrite":"書き換え","rules.proposalReject":"却下する","rules.proposalRejectReason":"却下の理由（任意）","rules.proposalRejectPlaceholder":"却下理由を一行で…","rules.proposalRejectConfirm":"この提案を却下しますか？30 日間は同じ提案を再確認しません。","rules.proposalRejectConfirmAction":"却下する","rules.proposalApplyConfirm":"採用するとルールファイルへの書き込み、git commit の作成、AGENTS.md の再生成、記憶ミラーの再構築を行います。続行しますか？","rules.proposalApplied":"採用しました","rules.proposalRejected":"却下しました","rules.proposalCooldown":"30 日間は同じ提案を再確認しません","rules.proposalCooling":"クールダウン中：同じ提案は当面再生成されません","rules.proposalExpand":"全文を表示","rules.proposalCollapse":"折りたたむ","rules.proposalRewriteTitle":"提案本文を書き換え","rules.proposalRewriteHint":"本文・条件・例外・スコープを編集できます。新しい本文で採用します。","rules.proposalRewriteNote":"条件/例外/スコープは本文の条項として送信されます（サーバーは単一本文で判定）。","rules.proposalRewriteSubmit":"この本文で採用","rules.proposalRewriteEmpty":"本文は空にできません","rules.proposalEditorText":"テキスト","rules.proposalEditorConditions":"条件（1 行に 1 件）","rules.proposalEditorExceptions":"例外（1 行に 1 件）","rules.proposalEditorScope":"スコープ","rules.proposalManualTitle":"手動での提案","rules.proposalManualHint":"要件を貼り付けると、サーバーが候補ルールに変換します。確認するまでファイルには書き込みません。","rules.proposalManualPlaceholder":"例：ゲートウェイの改口には必ず番号と日付を付ける…","rules.proposalManualSubmit":"提案を送信","rules.proposalManualDone":"提案を作成しました（上の未確認欄を参照）","rules.new":"新規ルール","rules.newTitle":"新規ルール","rules.newHint":"本文と構造化フィールドを入力してください。番号と key はサーバーが割り当てます。保存するとルールファイルを書き込み、git 履歴を残します。","rules.newTypeLabel":"タイプ","rules.newAutoAssign":"保存後に自動割り当て","rules.newAutoAssignNote":"番号と key は読み取り専用：鉄律の番号は安定し、再利用されません。通常ルールにも番号が自動割り当てされます。","rules.newActionLabel":"動作（オプション）","rules.newObjectLabel":"対象（オプション）","rules.newActionPlaceholder":"空欄なら本文から自動抽出","rules.newObjectPlaceholder":"空欄なら本文から自動抽出","rules.newTextPlaceholder":"必須の行動を命令文で一文に…","rules.newConfirm":"保存すると：ルールファイルへの書き込み、git commit の作成、記憶ミラーの再構築、AGENTS 摘要の描画を行います。このルールを作成しますか？","rules.newSubmit":"作成する","rules.newDone":"ルールを作成しました","rules.newTypeInvalid":"ルール種類が不正です（鉄律 / 通常ルール）","rules.newPriorityInvalid":"優先度が不正です（P0–P3）","rules.retire":"停止する","rules.retireConfirm":"停止するとこのルールは注入/適用されなくなりますが、ルールファイル・履歴・番号はすべて保持され、いつでも再有効化できます。停止しますか？","rules.retireDefaultHint":"これは既定の鉄律です。停止すると本機では適用されなくなります。同じ番号の履歴から再有効化できます。","rules.retiredBadge":"停止しています","rules.reactivate":"再有効化する","rules.reactivateConfirm":"再有効化するとこのルールの注入/適用が復帰します。番号・ファイル・履歴は変わりません。再有効化しますか？","rules.retireDone":"ルールを停止しました","rules.reactivateDone":"ルールを再有効化しました","rules.toggleUnavailable":"有効または停止中のルールのみ状態を切り替えできます","rules.purge":"削除する","rules.purgeHint":"ルールファイルを完全に削除します（取り消し不可。番号は失効し再利用されません。履歴スナップショットは追跡可能）","rules.purgeKeyLabel":"削除するにはルール key「{key}」を入力してください（一致しない場合は送信されません）","rules.purgeKeyPlaceholder":"ここに key を入力","rules.purgeConfirm":"完全削除はルールファイルを物理削除し、取り消せません。番号は失効し、今後再利用されません（新しいルールに割り当てられません）。削除前の最終版は履歴スナップショットに残り、git と history ディレクトリで追跡できます。完全に削除しますか？","rules.purgeDefaultHint":"これはインストール同梱の既定鉄律です。削除後に自動復元されることはありません（既定の播种は一度だけ）。本当に必要なら履歴スナップショットやバックアップから手動で復元してください。","rules.purgeDone":"ルールを完全に削除しました（ファイル削除済み・番号失効）","rules.purgeNumberRetired":"番号 #{number} は失効し再利用されません。次の番号は #{next} です","rules.defaultBadge":"デフォルト","rules.defaultOriginNote":"インストール同梱の既定鉄律：プラグインがインストール/アップグレード時に書き込みます。編集・停止・削除が可能で、番号は保持され履歴はロールバックできます。","rules.defaultNotice":"プラグインには既定の鉄律が同梱されています（インストール時に書き込み済み）。編集・停止・削除が可能で、番号は保持され履歴はロールバックできます。","rules.emptyNoActive":"適用中のルールがありません。「停止中」フィルタから再有効化できます","err.already_retired":"このルールはすでに停止中です。再度停止する必要はありません","err.not_retired":"このルールは現在有効です。再有効化する必要はありません","err.invalid_draft":"ルール草案が不正です（本文 / 種類 / 優先度 / スコープ）。確認して再試行してください","err.duplicate_rule":"同じ本文の通常ルールがすでに存在します（key 重複）。本文を変更するか、既存ルールを編集してください。","err.proposal_not_found":"提案が見つからないか処理済みです","err.proposal_not_pending":"提案は処理可能な状態ではありません（適用済みまたは却下済み）","err.rule_locked":"ルールファイルが他の書き込みで使用中です。しばらくして再試行してください","err.diff_too_large":"大きすぎて行単位の差分を取れません（5000 行超）","err.needs_manual":"候補は手動で書き換えてから再試行が必要です","err.llm_unavailable":"パネルに利用可能なモデルがありません。文言を書き換えて再試行してください","err.llm_unparseable":"モデルの出力を解析できません。書き換えて再試行してください","err.llm_error":"モデル呼び出しに失敗しました。書き換えて再試行してください","err.commit_failed":"git コミットに失敗したため、変更をロールバックしました","err.write_failed":"ルールファイルの書き込みに失敗しました","err.affected_write_failed":"影響を受けるルールの書き込みに失敗したため、変更をロールバックしました","err.invalid_json":"リクエスト本文が正しい JSON ではありません","err.invalid_key":"ルール key が不正です（小文字英数字とハイフンのみ）","err.invalid_mode":"モードが不正です（retire / reactivate / purge のみ）","err.invalid_rev":"リビジョン識別子が不正です","err.empty_text":"本文を空にできません","err.ensure_failed":"ルールリポジトリの初期化に失敗しました（権限と git を確認）","err.proposal_corrupt":"提案が破損しています（key 欠落）","err.plan_unavailable":"適用計画機能は未提供です（core plan 未エクスポート）","err.restore_unavailable":"デフォルト復元機能は未提供です","err.plan_failed":"適用計画の生成に失敗しました","err.restore_failed":"デフォルトルールの復元に失敗しました","err.unsupported_media_type":"書き込み API は Content-Type: application/json のみ受け付けます","err.cross_origin_denied":"クロスオリジンの書き込みを拒否しました（ローカル GUI / ローカル curl のみ）","err.no_markers":"AGENTS にダイジェストのマーカーがなく、書き込みませんでした","err.render_failed":"AGENTS ダイジェストの描画に失敗しました","rules.proposalNeedsManual":"この候補は手動対応が必要です：自動書き換えがガードを通りませんでした。本文を書き換えて再試行してください。","rules.proposalNeedsManualCode":"失敗コード：{code}","rules.proposalRewriteRetry":"書き換えて再試行","rules.restoreDefault":"デフォルトに戻す","rules.restoreDefaultConfirm":"同梱のデフォルト本文でこのルールを上書きし、新しいバージョンを作成します（履歴は保持）。続行しますか？","rules.restoreDefaultDone":"デフォルト本文に戻しました · AGENTS ダイジェストを後続同期","rules.emptyRetiredAction":"停止済みを表示","err.render_disabled":"AGENTS ダイジェストの描画は無効です（設定 → ルール → AGENTS ダイジェスト描画）","err.plan_hash_mismatch":"計画が古いため適用できません（planHash 不一致）。再生成してください","err.plan_stale":"計画がディスク変更より古いため再生成してください","err.number_retired":"対象番号は墓碑済みで再利用できません","err.target_conflict":"計画生成後に対象ルールが変更されました。再計画してください","err.target_missing":"対象ルールが存在しません。再提案してください","err.affected_missing":"影響ルールが存在しません。候補を更新して再試行してください","err.affected_inactive":"影響ルールが停用中です（ファイルは残っています）。有効化するか別の影響ルールを選んでください","err.number_exhausted":"1–999 に利用可能な鉄律番号がありません","err.lock_failed":"ルールリポジトリのロックがタイムアウトしました。後で再試行してください","err.txn_failed":"適用トランザクションの書き込みに失敗し、変更をロールバックしました","err.repo_locked":"ルールリポジトリが他の書き込みで使用中です。後で再試行してください（生きているプロセスのロックは奪いません）","err.git_unavailable":"git が利用できません：書き込みはファイルのみ（未コミット）に縮退します。git を導入するか「git 必須」を解除してください","err.manifest_failed":"manifest の書き込みに失敗したため、今回の変更をロールバックしました（ファイル・墓碑・索引を復元）","err.tombstone_failed":"墓碑の書き込みに失敗したため、完全削除は実行されていません（ルールファイルは残っています）","err.unprocessable":"リクエストを処理できません（パラメータまたは状態が不正）","err.server_error":"サーバー側の処理に失敗しました。後で再試行するかログを確認してください","rules.proposalNumberAdjusted":"番号を繰り下げました：#{from} → #{to}","rules.proposalSemantic":"意味の草案","rules.proposalRefining":"整理しています","err.duplicate_active":"同じ内容の有効な記憶が既にあります。","err.node_changed":"この記憶は別の操作で変更されました。再読み込みして再試行してください。","err.target_not_active":"対象の記憶は既に無効です。","settings.firstRunTitle":"推奨設定（初回）","settings.firstRunDesc":"以下はローカルで取り消せるスイッチです。適用すると現在値と違う項目だけを書き込みます。モデルやアドレスが必要な項目は選ばなくても構いません。","settings.firstRunApply":"推奨設定を適用","settings.firstRunLater":"あとで","settings.firstRunLocalOn":"初期状態で有効","settings.firstRunReflect":"振り返りを有効化（既定モデルが必要）","settings.firstRunReflectNote":"アイドル時に DSH の既定モデルで最近の出来事を記憶に整理します。利用できるモデルがない場合は何も生成しません。","settings.firstRunSync":"記憶同期を有効化（ブリッジ URL 設定済み）","settings.firstRunSyncNote":"まずドライランで動作し、同期待ち項目を記録するだけでリモートは変更しません。影響がないことを確認してからドライランを解除してください。","settings.firstRunSyncUnset":"同期にはブリッジ URL が必要です（設定 → 同期）。まだ設定されていません。","settings.firstRunSafety":"書き込みは既定でシャドウモードです。記録のみで反映されません。設定で自動に変更できます。","settings.recommend":"推奨","settings.collapse":"折りたたむ","settings.expand":"展開","settings.manualLink":"用語が分からないときは、マニュアルの用語集を開く","manual.button":"マニュアル","manual.title":"Whale Memory マニュアル","manual.close":"閉じる","manual.zhOnly":"このマニュアルは中国語版のみをオフラインで同梱しています。","err.ignored":"無視ルールに一致したため書き込みませんでした","overview.wrapTitle":"セッション締め","overview.wrapNow":"今すぐ締める","overview.wrapBusy":"締め処理中…","overview.wrapEmpty":"まだ締め記録がありません。区切りがついたら「今すぐ締める」を押すか、会話で「締め」と言ってください。","overview.wrapUnsupported":"このバックエンド構成では締め処理を使えません（local または hybrid のローカル DB が必要です）。","overview.wrapLoadFailed":"締め状態を読み込めませんでした","overview.wrapCandidates":"審査待ち","overview.wrapIngested":"保存済み","overview.wrapSkippedCount":"スキップ","overview.wrapProposals":"ルール提案","overview.wrapOpenLoops":"未完了の用事","overview.wrapSwitchReady":"切り替え可能","overview.wrapReadyYes":"はい","overview.wrapReadyNo":"いいえ","overview.wrapBlockers":"未完了：{list}","overview.wrapLastError":"直近のエラー","overview.wrapSkipped":"直近のスキップ：{reason}","overview.wrapQueued":"受付済み：run {id}","overview.wrapFailed":"締め処理に失敗","overview.wrapShowReport":"レポートを見る","overview.wrapHideReport":"レポートを閉じる","overview.wrapReportFailed":"レポートを読み込めませんでした","wrap.stateQueued":"待機中","wrap.stateRunning":"実行中","wrap.stateDone":"完了","wrap.stateFailed":"失敗","wrap.stateSkipped":"スキップ","wrap.triggerExplicit":"明示的な締め","wrap.triggerIdle":"アイドル","wrap.triggerDisposed":"セッション終了","wrap.triggerManual":"パネル操作","writes.filterWrap":"締め候補のみ（{n}）","writes.pendingNoWrap":"締め候補はありません","writes.originSessionWrap":"締め","settings.groupWrap":"セッション締め","settings.groupWrapDesc":"会話の区切りで教訓・決定・未完了を抽出し、shadow 候補とルール提案を作ります。既定では自動承認しません。","settings.wrapEnabled":"セッション締めを有効化","settings.wrapEnabledDesc":"条件を満たしたときに一度だけ範囲を限った抽出を実行します。","settings.wrapCostNote":"モデルのトークンを消費します（1 回の締めにつき最大 1 呼び出し、1 日の上限あり）。","settings.wrapExplicit":"明示的な締め","settings.wrapExplicitDesc":"「締め」「セッション切り替え」などの発話の後、ターン終了時にキューへ入れます。","settings.wrapIdle":"アイドル時の締め","settings.wrapIdleDesc":"既定は無効。実行中のターンがなくアイドル分数を超えたらキューへ入れます。同じ素材は一度だけ処理します。","settings.wrapDisposed":"セッション終了時の締め","settings.wrapDisposedDesc":"既定は無効。セッションが閉じられたりアーカイブされたときにバッファを spool へ書き、キューへ入れます。","settings.wrapIdleMinutes":"アイドル分数","settings.wrapIdleMinutesDesc":"既定は 10 分。短すぎると長い作業の途中で誤作動しやすくなります。","settings.wrapMaxItems":"最大項目数","settings.wrapMaxItemsDesc":"1 回の抽出で残す候補・提案の上限です。","settings.wrapMaxRunsPerDay":"1 日の自動上限","settings.wrapMaxRunsPerDayDesc":"アイドルと終了の自動実行だけを制限します。明示的な締めは人の操作なので対象外です。","settings.wrapIngestMode":"通常記憶の自動保存","settings.wrapIngestModeDesc":"auto：価値ゲートを通った長期ルールは直接保存します。review：すべて審査候補になります（=0.7.3 への回退、自動保存なし）。","settings.wrapIngestAuto":"auto（自動保存）","settings.wrapIngestReview":"review（すべて審査）","settings.wrapIngestMinConfidence":"最低信頼度","settings.wrapIngestMinConfidenceDesc":"締めのモデルが confidence を返さない場合は 0.5 として扱い、これ未満は審査へ回します。","settings.wrapIngestDropTask":"タスク文を拒否","settings.wrapIngestDropTaskDesc":"オン：タスク指示は長期記憶に入れません。オフ：審査候補へ回します（保存はされません）。","settings.wrapReport":"締めレポートを書く","settings.wrapReportDesc":"データディレクトリの reports/ に、生の会話を含まない Markdown レポートを生成します。","settings.wrapModel":"締め用モデル","settings.wrapModelDesc":"空なら現在の既定モデルを使います。値を入れるとモデル id を上書きします（provider は既定の選択のまま）。","settings.wrapMaxMaterialChars":"素材の文字数上限","settings.wrapMaxMaterialCharsDesc":"直近の会話だけを使い、上限を超えた分はターン単位で古いものから捨てます（既定 12000 コードポイント）。","settings.wrapSpoolTtlHours":"spool 保持時間","settings.wrapSpoolTtlHoursDesc":"失敗やモデル不在のときは再試行用に素材を残し、期限後に削除します。バックアップには含めません。","settings.wrapTimeoutMs":"モデルのタイムアウト（ミリ秒）","settings.wrapTimeoutMsDesc":"1 回の抽出に対する強い上限です。タイムアウトは失敗として再試行し、会話は止めません。","settings.wrapNote":"候補は既定で shadow のままです。ルールは提案になるだけで、ルールファイルを自動では書き換えません。","settings.firstRunWrap":"セッション締めを有効にする","settings.firstRunWrapNote":"「締める」と明示したときにモデルを呼び、トークンを消費します。アイドル時と終了時の自動締めは設定で有効にするまでオフです。","err.wrap_unavailable":"締めサービスが組み込まれていません","err.wrap_disabled":"セッション締めは無効です","err.no_material":"締める対象の会話素材がありません","err.turn_in_progress":"現在のターンがまだ実行中です。少し待ってください","err.unsupported_backend":"このバックエンド構成では締め処理を使えません","err.rate_limited":"本日の自動締め上限に達しました","err.same_material":"同じ素材はすでに締め済みです","err.report_missing":"締めレポートが見つかりません","err.report_path_outside":"レポートのパスが範囲外のため拒否しました","overview.wrapDisabled":"セッション締めは無効です。「設定 → セッション締め」で有効にしてください。","err.busy_wrap":"別の締め処理が待機中または実行中です。少し待ってから再試行してください（別セッションの可能性があります）","settings.wrapRetentionDays":"台帳・レポートの保持日数","settings.wrapRetentionDaysDesc":"既定は 180 日。0 は永久保持。終了済みの締め記録と参照されないレポートだけを削除し、待機中・実行中の記録は削除しません。","health.queued":"待機","overview.wrapSessionLabel":"セッション","overview.wrapSessionRecent":"素材のある直近セッション","overview.wrapSessionSelected":"選択中 · {turns} ターン","overview.wrapSessionOption":"{turns} ターン · {state}","overview.wrapSessionRunning":"進行中","overview.wrapNoSession":"収集済みセッションがありません。少し会話してから戻ってください。","overview.wrapEmptyGuide":"セッションを選んで「今すぐ収尾」、または会話で「収尾」と言ってください。","overview.wrapQueuedPosition":"待機中です（{n} 番目）","overview.wrapExisting":"この区間は収尾中/収尾済みです（新しい会話で再実行）","overview.wrapWarnings":"注意：{list}","overview.wrapRetryable":"再試行可","overview.wrapFailureCount":"最近の失敗 {n} 件 · 展開","overview.wrapFailureHide":"失敗を折りたたむ","overview.wrapReportEmpty":"レポート内容はまだありません。","overview.wrapErrorTurn":"このセッションは応答中です。終了を待つか別のセッションを選んでください","overview.wrapErrorNoMaterial":"このセッションには収尾できる会話がまだありません","overview.wrapErrorDisabled":"セッション収尾は無効です","overview.wrapErrorUnsupported":"現在のバックエンドはローカル収尾に未対応です","overview.wrapErrorNoSession":"セッションが存在しません。更新して選び直してください","overview.wrapErrorSame":"この区間は収尾済みです（新しい会話で再実行）","overview.wrapErrorBusy":"キューがいっぱいです。しばらくして再試行してください","overview.wrapErrorSessionBusy":"このセッションには既に待機中の実行があります。完了後に再試行してください","overview.wrapErrorCapture":"収集器の準備ができていません。後で再試行してください","overview.wrapErrorDb":"記憶データベースの読み書きに失敗しました。後で再試行してください","overview.wrapErrorBadJson":"モデル出力が JSON ではありません。再試行も失敗しました","overview.wrapErrorTimeout":"モデル呼び出しがタイムアウトしました","overview.wrapErrorSpool":"セッション素材が失われました。再試行してください","overview.wrapErrorWrite":"候補の書き込みに失敗しました","overview.wrapProgress":"収尾の進捗","overview.wrapPhaseQueued":"待機","overview.wrapPhaseCapture":"収集","overview.wrapPhaseDistill":"蒸留","overview.wrapPhaseDispatch":"振り分け","overview.wrapPhaseReport":"レポート","overview.wrapRetrying":"再試行中 {n}/{max}","overview.wrapSkipCleared":"キューは再起動で消去されました。必要なら再度実行してください","overview.wrapSkipTimeout":"待機がタイムアウトしました。再試行してください","overview.wrapSkipDisposed":"セッションが閉じられたため待機を取り消しました","overview.wrapSkipBusy":"実行中のタスクがあるため今回はスキップしました","overview.wrapSkipRate":"本日の自動収尾上限に達しました","err.queue_cleared":"再起動で収尾キューが消去されました。再度実行してください","err.session_queue_full":"このセッションには既に待機中の実行があります","err.busy_queue_full":"収尾キューがいっぱいです。後で再試行してください","overview.wrapAuto":"自動収尾","overview.wrapAutoDesc":"{n} 分のアイドル後に実行 · トークンを消費","overview.wrapSkipAuto":"自動収尾をスキップ","overview.wrapSkipAutoDesc":"アイドル/クローズ時のみ。手動は常に可能","overview.wrapSessionSkipped":"自動スキップ中","err.invalid_session":"セッション ID が不正です","overview.wrapPhaseReconcile":"整合","overview.wrapCopyReport":"レポートをコピー","overview.wrapDownloadReport":".md をダウンロード","overview.wrapSessionLoadFailed":"セッション一覧の取得に失敗しました"}}
    // <<< locale:generated

// >>> manual:generated（由 scripts/manual-build.mjs 生成，勿手改）
    const MANUAL_DOC = {
      "zh": "# 鲸忆记忆中枢 · 小白使用说明\n\n> 对应 dsh-whale-memory 0.6.4（DSH 0.2.2-rc.5）。内容离线可读；每节独立，不用从头读。\n\n## 1. 一分钟上手\n\n**装完发生什么**\n\n- 装好即用：不用填密钥、不用另装服务。默认只在本机存，**不发任何外部请求**。\n- 第一次用到时自动建本地 SQLite 库：`~/.dsh/whale-memory/memory.db`（同目录另有 `-wal`、`-shm`）。若设了 `$DSH_HOME`，目录跟着 `$DSH_HOME` 走。\n- 同时开三件事：对话前自动召回并注入；普通记忆走价值闸（长期规则默认直接入库，任务/一次性状态拒收，歧义转待审）；规则文件自愈（首次写入附带默认铁律，并把摘要渲染进 `AGENTS.md`）。\n- 后台默认每 6 小时做一次巩固（合并重复/过期记忆），并每天生成一份日报。\n\n**默认开/关**\n\n| 默认开 | 默认关（要有模型或地址才建议开） |\n|---|---|\n| 召回、写入、规则、巩固、检索线程、显式收尾 | 后台空闲/关闭自动收尾、空闲反思、外部同步、向量检索 |\n\n直接写入默认是 **shadow（影子）**：先落候选，你确认后才成为记忆。**会话收尾的普通记忆默认自动入库**（0.8.0 起）：通过价值闸的长期规则直接落 active，任务指令/版本状态拒收，歧义句转待审；只有铁律仍走提案审批。想回到“全部先审”就把设置 →「收尾沉淀」的「普通记忆入库」切成 review。\n\n**数据在哪**\n\n- 记忆库：`~/.dsh/whale-memory/memory.db`（WAL 模式，旁边有 `-wal`/`-shm`，别单独删）。\n- 自动备份：`~/.dsh/whale-memory/backup/whale-<时间戳>.db`（改表结构前自动存一份，最多留 5 份）。\n- 日报：`~/.dsh/whale-memory/reports/YYYY-MM-DD.md`；收尾报告：同目录 `session-wrap-*.md`（不含原始对话）。\n- 收尾临时材料：`~/.dsh/whale-memory/spool/session-wrap/`（权限 600、默认 24 小时自删，不进灾备）。\n- 规则真源：`~/.dsh/rules/` 下的 Markdown（同目录还有 `manifest.json`、`proposals/`、`retired/`、每规则 20 份历史快照）。\n\n**怎么关 / 怎么彻底删**\n\n- 禁用或卸载插件：立即停止召回与写入，设置页不再出现；**库和规则文件都还在**，重装后继续能读。\n- 彻底删除：先导出备份，停掉 DSH，再删 `~/.dsh/whale-memory`。规则目录 `~/.dsh/rules` 里可能还有你手写的规则，删前务必先备份。\n\n## 2. 三件日常事\n\n### 自动召回（每轮对话前）\n\n- 用你最后一句去本地库检索，只取相关度 ≥0.34 的命中，最多 5 条。\n- 按意图分档：闲聊 3 条 / 排障 5 条 / 回忆 4 条 / 画图与创作 0 条；再和你设的字数上限取小。\n- 2 秒没返回就跳过本轮，不卡回复；结果只作用于当前会话，120 秒后重算。\n- 子会话（子代理）不注入。\n- 回复里真的引用了注入内容才记「已采纳」，只影响概览采纳率，不改你的记忆。\n\n### 自动写入（什么时候会记东西）\n\n- 这个插件不会偷抄你的聊天：写入来自面板「新增记忆」、导入 JSONL，以及你手动打开的自动来源。\n- 自动来源默认都关：**搜索反哺**（联网搜索返回后写一条摘要，默认关）、**空闲反思**（用模型整理旧记忆，默认关且费模型额度）。\n- 所有写入过同一道闸：单条 ≤500 字、每日最多 200 条、重复内容自动合并；句子里的密钥等敏感串会先打码再存（不会明文入库）。\n- 直接写入默认 shadow：先出候选，到「写入与关系」页点接受才入库；拒绝只留审计。\n- 想少点手工：接受一批候选后，可把「写入审核」切 auto（建议先用 shadow 跑几天看质量）；收尾的普通记忆另有「普通记忆入库」开关（auto/review）。\n\n### 会话收尾（说「收尾」/切会话时）\n\n- 什么时候跑：你在对话里说「收尾/收工/先到这/换会话/记一下这次教训」，回合结束就跑一次；面板概览有「立即收尾」，并可选“收尾哪个会话”。连续 10 分钟没动静、或会话被关掉这两路**默认关**（卡片「自动收尾」开关打开才生效，会花 token）；每个会话还可单独「跳过自动收尾」（重启后仍生效）。\n- 点击语义：运行中点「立即收尾」会**排队（202）**并显示位次与阶段进度，不再报“已有任务在跑”；同一段材料重复点只算一次；同会话已有一条排队/运行时再发起不同内容会被拒（409），完成后再试。进程重启会清空排队，卡片会明说“队列已清理，如需收尾请再点”。\n- 它做什么：只取最近对话（默认最多 20 轮 / 12000 字），调**一次**当前模型，提炼出教训/决策/偏好/待办；每条必须带原文证据，编造的条目会被丢掉。\n- 整合复核（Reconcile，默认关）：开启后在提炼后多调一次模型，把候选与同身份既有记忆比对，产出 ADD/UPDATE/MERGE/ARCHIVE/NOOP/REVIEW 决策与改写短语义；仍然只进 shadow 候选/审计，接受时才落库（ARCHIVE 只改状态不删行，受保护目标拒绝）。同主题多条可合并成一条，报告里只给决策计数。\n- 结果去哪：通过价值闸的记忆直接入库（「写入与关系」页可只看「收尾候选」查看仍需审核的歧义项）；任务指令/版本状态只留分类码；规则句只生成提案。概览「最近收尾」显示入库/待审/跳过、提案数、待办数与「可切会话」，报告可复制/下载 .md；报告只打印待审正文，已入库只列 node id。\n- 会花 token：默认开，每次最多 1–2 次模型调用（开整合多一次）；自动触发每天最多 6 次，手动「立即收尾」不受这个上限。设置 →「收尾沉淀」可关、可调空闲分钟数/条数上限，也可切「普通记忆入库」（auto 默认直接入库 / review 全部先审）与最低置信度、任务句处理方式。\n- 失败不装成功：没模型/没素材会显示“已跳过”；模型坏 JSON/超时会失败并保留材料供手动重试（重试中显示“正在重试 N/4”）。原始聊天只进临时 spool，报告、日志、状态接口都不含原文。\n\n### 规则提案（说「以后都…」）\n\n- 你说「以后都…」「必须…」「禁止…」「记成铁律」时，插件起草一条规则候选，并在回复末尾问你要不要收录。\n- 聊天确认只认**整句**「收录 pXXXXXXXX」或「确认收录 pXXXXXXXX」（口令在提示行里给）；加字、转述、带问号都不算。\n- 也可以到「规则」页签 →「待确认」审阅、改写、拒绝。\n- 收录前做冲突检测与守卫：旧规则的例外/禁止不会被悄悄删掉；冲突或合并要你点头。\n- 写入即一次本地 git 提交，可看历史、逐行 diff、回滚；没装 git 也有本地快照兜底。\n\n## 3. 六页签速览\n\n| 页签 | 你会看到 | 能做什么 |\n|---|---|---|\n| 概览 | 节点数/活跃数、今日召回、关系边；零注入率、采纳率、作业成功率、库体积与 7 日曲线；最近失败的作业；最近收尾状态 | 一眼判断「它在不在干活」；点刷新；「立即收尾」；查看收尾报告 |\n| 记忆库 | 关键词检索、命中数（含低于门槛的候选）、节点详情 | 新增记忆、编辑、归档、导入/导出 JSONL（单次 ≤4 MB） |\n| 规则 | 规则列表、待确认候选、Git 版本库状态、规则目录 | 新建/编辑/停用/彻底删除；看历史 diff、回滚、重建镜像、从记忆库导入旧铁律；也能贴一段要求手动生成候选 |\n| 召回 | 最近召回记录：命中了什么、注入多少字、是否被采纳 | 纯检索测试（不写库、不调模型） |\n| 写入与关系 | 写入审计流水、shadow 候选（可筛「只看收尾候选」）、关系边统计、最近演化 | 接受/拒绝候选 |\n| 设置 | 按场景分组的开关 | 改开关、导出记忆 |\n\n> **彻底删除规则**会写墓碑、编号永不复用：该编号以后不能再拿来新建，删前先确认。日常只想让它暂时失效，用「停用」，编号还能再用。\n\n## 4. 最常用的 10 个设置\n\n| 设置（所在分组） | 默认 | 用法与后果 |\n|---|---|---|\n| 启用召回注入（注入） | 开 | 关掉＝对话前不再注入任何记忆；库与面板照常工作。 |\n| 注入字数上限（注入） | 1500 | **改成 0 就是完全不注入**（保存时会二次确认）。每轮实际取「意图分档预算」和它之中较小的一个。 |\n| 启用写入（写入） | 开 | 关掉＝面板「新增记忆」与自动来源都不再写；导入 JSONL 是独立通道，不受它影响。 |\n| 写入审核（写入） | shadow | shadow＝候选进待审、你接受才入库；auto＝判定通过直接入库。想稳就留 shadow。 |\n| 后端模式（接入） | 本地 | 改成 http/hybrid 并填地址，才会把记忆请求发到你填的地址；本地数据不受影响，随时可切回「本地」。 |\n| 允许非回环访问（面板） | 关 | 打开后同一网络的其他机器能**只读**拉取面板数据（身份固定为当前，不能覆盖）。不需要就别开，风险自负。 |\n| 归档保留天数（隐私） | 0 | 0＝永久保留；**>0 会在到期后物理删除归档记录，删了找不回**。 |\n| 启用巩固（巩固） | 开 | 每 6 小时合并重复与过期节点；关掉库会越来越臃肿。 |\n| 启用会话收尾（收尾沉淀） | 开 | 显式说「收尾」时调一次模型提炼，会花 token；普通长期记忆默认自动入库，歧义/低置信转待审。后台空闲/关闭触发默认关，需在组内或卡片「自动收尾」打开。关掉＝不再响应收尾，已有候选/报告不受影响。 |\n| 整合复核（收尾沉淀） | 关 | 开启后每次收尾多一次模型调用，与既有记忆比对产出 ADD/UPDATE/MERGE/ARCHIVE/NOOP/REVIEW 影子决策；仍只进候选/审计，接受才落库。先用关，确认候选质量后再开。 |\n| 台账/报告保留天数（收尾沉淀） | 180 | 超期且已结束的收尾记录、不再被引用的旧报告会被清理；0=永久；排队/运行中的记录不删。 |\n\n> 其余默认关的都要外部条件：反思需要可用模型（会产生模型费用），同步需要桥地址，向量需要嵌入服务。\n\n## 5. 术语表\n\n| 术语 | 一句话解释 | 网上搜什么 |\n|---|---|---|\n| 记忆节点 | 库里的一条记忆，带层级、类型、来源和归属身份。 | memory node / 记忆节点 |\n| 召回 | 每轮对话前，自动从库里挑出可能相关的几条记忆。 | retrieval / 召回 检索 |\n| 注入 | 把召回结果拼进本轮上下文，让模型「看到」。 | context injection / 上下文注入 |\n| 字符预算 | 每轮最多注入多少字、几条；超了就丢分低的。 | token budget / 上下文预算 |\n| 身份分区（user/role/workspace） | 每条记忆归某个用户、角色、工作区，互不串场。 | multi-tenant memory / 多租户 隔离 |\n| 影子(shadow)/自动(auto) | shadow＝先出待审候选、人确认才入库；auto＝直接入库。 | human in the loop / 人工审核 |\n| FTS | SQLite 的全文索引，按关键词快速找；它与节点对不上时概览会标出来。 | SQLite FTS5 / 全文检索 |\n| worker | 把库操作放到后台线程，避免卡住对话。 | worker thread / 工作线程 |\n| schema | 库的表结构与版本号；升级会改版本，改前自动备份。 | database schema migration / 数据库迁移 |\n| 规则 / 铁律 | 可版本化的行为约束，一条规则一个 Markdown 文件。 | rule engine / 规则引擎 铁律 |\n| 提案 | 插件起草的规则候选，你确认后才变成正式规则。 | proposal workflow / 提案 审批 |\n| 镜像 | 规则文件在库里的副本，只供面板检索；对话召回不读它。 | data mirror / 数据镜像 |\n| AGENTS | 宿主每次会话自动读的说明文件；插件只重写其中的规则摘要块。 | AGENTS.md / 智能体说明文件 |\n| Git 规则仓 | 规则目录是个本地 git 仓，一次改动一次提交，可回滚；全程不联网。 | local git repository / 本地 git 版本管理 |\n| 同步 / outbox | 与外部网关双轨：本地先写，再排队推送；outbox 就是排队表。 | outbox pattern / 发件箱模式 |\n| 向量 / embedding | 用向量做「意思相近」检索；本机没接服务，默认关。 | vector embedding / 向量嵌入 |\n| volatile | 这类开关保存后立即生效，不用重载插件。 | hot reload config / 配置热更新 |\n| CAS | 写之前先核对状态没被别人改过，防止互相覆盖。 | compare-and-swap / 比较并交换 |\n| trace | 一次操作的追踪号，日志与库记录能靠它串起来查。 | trace id / 链路追踪 |\n\n## 6. FAQ\n\n**1）我明明说过，它却不召回？**\n\n按顺序查：召回开关是否开 → 注入字数上限是否被改成 0 → 最小相关度是否调得太高 → 注入层级是否只勾了 core/important（普通记忆是 normal）→ 库是否为空 → 你那句是否不到 2 个字 → 是否画图/创作类（本来就 0 注入）。还不行就去「召回」页看最近一次命中与「概览」的零注入率。\n\n**2）对话里说的事没进记忆库？**\n\n先看「写入与关系」：shadow 模式下候选在待审队列里，接受才入库；再看写入开关、每日上限是否用完、单条是否超 500 字。本插件默认不把闲聊自动抄成记忆，要长期记住某件事，用面板新增或让它变成规则。\n\n**3）规则写了却不生效？**\n\n可能原因：规则功能被关；候选还没确认（在「待确认」里）；规则作用域是某个工作区/角色，换个会话就不生效；`AGENTS.md` 里没有摘要标记块，全局规则只能靠降级注入；设置里看不到的「每轮规则注入预算」被改成了 0（这个键只在配置文件层，改完要重启宿主）。\n\n**4）`AGENTS.md` 没自动更新？**\n\n只会在已有标记块内部重写；文件存在但没有标记块时**故意不追加**（保护你手写的内容）。空机首次会自动创建管理块。块在却不更新，多半是这几项：规则功能被关；规则摘要超过预算被截断（健康检查会给黄灯）；「是否重渲染 AGENTS」这类开关只在配置文件层、改完要重启宿主。没装 git 不影响渲染。想让插件接管摘要，先备份文件再删掉它，插件会重建最小管理块。\n\n**5）换机怎么搬？**\n\n记忆：在「记忆库」或「设置」导出 JSONL，在新机导入。规则：整目录拷 `~/.dsh/rules`（含 `manifest.json` 与历史）。也可以停掉 DSH 后整目录拷 `~/.dsh/whale-memory`（三件 `memory.db`、`-wal`、`-shm` 要一起拷）。\n\n**6）卸载后留下什么？**\n\n只停功能，不删数据：`~/.dsh/whale-memory`（库、备份、日报）和 `~/.dsh/rules`（规则文件与 git 历史）都留着。重装后可继续用；确认不要了再按第 1 节「彻底删除」手动清理。\n\n**7）怎么备份、怎么恢复？**\n\n日常：面板「导出记忆」存 JSONL。整库：`backup/` 里的 `whale-<时间戳>.db` 快照。恢复必须停掉 DSH，先备份现状，再用快照覆盖 `memory.db`，并清掉旧的 `-wal`/`-shm`（否则可能读到旧日志）。不要手改库文件。\n\n**8）「允许非回环访问」有什么风险？**\n\n默认只收本机回环请求。打开后同网络的其他机器能读到你的记忆、规则与统计（只读，且身份固定为当前会话），等于把记忆内容暴露在局域网里。不需要远程看面板就别开；用过记得关回去。\n\n## 7. 排障入口\n\n- **规则健康**：面板不展示这项，直接访问 `/whale-memory/api/rules/health`（浏览器打开即可）——返回 `ok:false` 时看 `failures` 里的原因码（文件解析、编号冲突、清单不一致、链断裂、墓碑被复用、未完成事务）。业务不一致也回 200，别只看状态码。\n- **库健康**：概览看「FTS 对齐」（对不上＝全文索引与节点表不一致）与「最近失败的作业」；FTS 不一致时先停写入、导出备份，再导入重建，别手改库。\n- **日志关键词**：所有日志行带 `[whale-memory]`。常见：`worker unavailable`（检索线程没起来，功能降级）、`protocol mismatch`（外部后端协议不符，切回本地即可）、`rules ... fail-open`（规则某一步失败但不挡启动）、`db quarantined`（库损坏已改名隔离，原文件还在同目录 `memory.corrupt-*`）。\n- **备份与现场**：`~/.dsh/whale-memory/backup/`、`~/.dsh/whale-memory/reports/`、`~/.dsh/rules/manifest.json`。求助时附上这三个路径里的对应文件，比截图有用。\n- **建议顺序**：概览 → 召回页 → 写入与关系 → 规则健康。四步都正常还不满意，再动设置里的数字。\n\n## 8. 模型侧记忆工具\n\n模型在对话里可以直接调用五个记忆工具；工具身份固定为当前会话，不接受身份参数，跨身份的 id 一律按不存在处理。\n\n| 工具 | 参数 | 行为 |\n|---|---|---|\n| memory_remember | text（必填）、level?、memory_type?、tags? | 与自动写入过同一道价值闸：长期规则直接入库；歧义/主观/低置信转待审候选；任务指令与版本状态报 NOT_MEMORY；受保护目标转待审。 |\n| memory_search | query（必填）、limit?（1–20，默认 5） | 只在当前身份分区检索，返回 id/正文/层级/类型/分数；空 query 报 INVALID_ARGS。 |\n| memory_read | id | 读同身份节点与相邻关系边；跨身份 id 报 NODE_NOT_FOUND。 |\n| memory_update | id、text?、level?、tags?、expectedUpdatedAt? | 改正文/层级/标签；正文 ≤500 字；带 expectedUpdatedAt 时做 CAS，期间被改过报 NODE_CHANGED；受保护目标（owner/core/procedural）任何字段都不许改，报 PROTECTED_TARGET。 |\n| memory_forget | id、reason（≤200） | 只归档（ARCHIVE），不物理删除行；受保护目标报 PROTECTED_TARGET。 |\n\n- **身份只取当前会话**：userId/roleId 仍按插件身份配置与宿主登录态推导，workspace 由会话工作目录派生；没有 agent、缺会话头或 workspace 为空时直接报 IDENTITY_REQUIRED，不落任何写入。\n- **跨身份 id 视为不存在**：search/read/update/forget 都按当前身份过滤；拿别的分区 id 调用得到 NODE_NOT_FOUND，读不到也改不到别人的记忆。\n- **每回合写类工具限次**：remember/update/forget 每次进入写路径计数（参数非法、身份缺失、节点不存在/受保护等前置失败不计），默认每回合 5 次；超限返回 RATE_LIMITED。回合推进后计数清零。设置 →「模型工具」可把上限改成 1–50。\n- **子代理不可用**：子代理会话调用这五个工具会被拒绝（SUBAGENT_FORBIDDEN），不会读写任何记忆；只有主会话能用。\n- **受保护记忆不可改/归档**：source=owner、level=core、memory_type=procedural 的节点不能被 update 改任何字段（含只改标签），也不能被 forget 归档；调用返回 PROTECTED_TARGET，规则与默认铁律不会因模型遗忘而被删。面板编辑仍按既有规则只挡正文/等级。\n- **失败是错误而非成功**：参数越界（含标签 >32 个）、身份缺失、跨身份、受保护、CAS 冲突、限次、后端不可用都以稳定错误码抛出，不会回 `{ok:false}` 冒充成功。\n- **重复归档是幂等跳过**：对已归档节点再 forget 返回 ok，但不会再造审计行，启动日志记 `memory_forget noop`（不把“没做什么”说成新写入）。\n- **只支持本地/混合后端**：记忆工具要求后端具备同身份读改能力（`getNode`/`updateNode`）；纯 http 远端协议只有写入/检索，工具面不注册（启动日志会写明缺的能力），面板写入与收尾照常。\n- **开关**：设置 →「模型工具」的「启用模型记忆工具」关闭后，任何调用都会被拒绝（TOOLS_DISABLED），调用即生效；面板写入、导入与收尾入库照常工作。",
      "en": "",
      "ja": ""
    }
    // <<< manual:generated

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

    // ------------------------------------------------------------ identity

    /**
     * 面板当前分区身份：由 `/config` 的 runtimeIdentity 与 identityOverride 决定。
     * 只有回环（服务端 identityOverride=true）才允许把身份带进读写请求；
     * 远端只读面板一律不带，避免按 body/query 翻别人的分区。
     */
    let panelIdentity = null
    let panelIdentityOverride = false

    function setPanelIdentity(identity, override) {
      const value = identity && typeof identity === 'object' ? identity : {}
      panelIdentity = {
        userId: String(value.userId || ''),
        roleId: String(value.roleId || ''),
        workspace: String(value.workspace || ''),
      }
      panelIdentityOverride = Boolean(override)
    }

    /** 当前可覆盖身份的三字段；不可覆盖或无身份时返回 null。 */
    function identityFields() {
      if (!panelIdentityOverride || !panelIdentity) return null
      return { userId: panelIdentity.userId, roleId: panelIdentity.roleId, workspace: panelIdentity.workspace }
    }

    /** GET 查询串：只拼非空字段；不可覆盖/无字段时返回空串。 */
    function identityQuery() {
      const id = identityFields()
      if (!id) return ''
      return Object.entries(id)
        .filter(([, value]) => value !== '')
        .map(([key, value]) => key + '=' + encodeURIComponent(value))
        .join('&')
    }

    /** 给已有 query 的路径追加身份参数；保留原 query 与 hash。 */
    function withIdentity(path) {
      const query = identityQuery()
      if (!query) return path
      const [base, hash = ''] = String(path).split('#')
      const sep = base.includes('?') ? '&' : '?'
      return base + sep + query + (hash ? '#' + hash : '')
    }

    // ------------------------------------------------------------------ fetch

    /**
     * HTTP 状态兜底码：只在响应体没有 `error` 字段时使用。
     *
     * Why 不能把 422/500 折叠成 unknown_error：规则/写接口的参数错误与落盘失败是最常见的
     * 两类失败，落到「未知错误」等于把可行动信息扔掉（架构书 §7.1）。语义码与
     * src/shared/error-table.mjs 同口径。
     */
    function statusCode(status) {
      if (status === 400) return 'invalid_config'
      if (status === 403) return 'not_loopback'
      if (status === 404) return 'not_found'
      if (status === 409) return 'busy'
      if (status === 413) return 'payload_too_large'
      if (status === 405) return 'method_not_allowed'
      if (status === 422) return 'unprocessable'
      if (status === 500) return 'server_error'
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

    /**
     * 错误码 → 文案。未映射码原文透出 `[code]`（所有页签一致），不得落「未知错误」。
     * @param {(key:string,params?:object)=>string} t
     * @param {{code?:string,message?:string}} err
     * @returns {string}
     */
    function errText(t, err) {
      const code = String((err && (err.code || err.message)) || 'unknown')
      if (hasKey('err.' + code)) return t('err.' + code)
      return '[' + code + ']'
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
      const { id, value, onChange, placeholder, describedBy, disabled, type, style } = props
      return h('input', {
        id, style: style ? { ...css.fieldInput, ...style } : css.fieldInput, type: type || 'text',
        value: value === null || value === undefined ? '' : String(value),
        placeholder: placeholder || '', disabled: Boolean(disabled),
        'aria-describedby': describedBy,
        onChange: (e) => onChange(e.target.value),
      })
    }

    function NumberInput(props) {
      const { id, value, min, max, step, onChange, describedBy, disabled, style } = props
      return h('input', {
        id, style: style ? { ...css.numberInput, ...style } : css.numberInput, type: 'number',
        value: value === undefined || value === null ? '' : value,
        min, max, step: step || 1, disabled: Boolean(disabled),
        'aria-describedby': describedBy,
        onChange: (e) => onChange(e.target.value === '' ? '' : Number(e.target.value)),
      })
    }

    function SelectInput(props) {
      const { id, value, options, onChange, describedBy, disabled, style } = props
      return h('select', {
        id, style: style ? { ...css.fieldSelect, ...style } : css.fieldSelect, value, disabled: Boolean(disabled),
        'aria-describedby': describedBy,
        onChange: (e) => onChange(e.target.value),
      }, options.map(([v, l]) => h('option', { key: v, value: v }, l)))
    }

    function TextAreaInput(props) {
      const { id, value, onChange, placeholder, describedBy, disabled, rows, style } = props
      return h('textarea', {
        id, style: style ? { ...css.fieldArea, ...style } : css.fieldArea, rows: rows || 3,
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
      const { defaultValue, badge, depReason, recommend } = props
      if (!defaultValue && !badge && !depReason && !recommend) return null
      return h('div', { style: css.settingMeta },
        defaultValue ? h('span', null, defaultValue) : null,
        badge ? h('span', { style: css.badgeChip }, badge) : null,
        recommend ? h('span', { style: css.recommendChip }, recommend) : null,
        depReason ? h('span', { style: css.metaDep, role: 'note' }, depReason) : null)
    }

    /**
     * 设置项卡片：标签 + 说明小字 + 生效方式徽标 + 默认值 + 依赖；danger 用红框标出不可逆项。
     * 说明文字用 aria-describedby 与控件关联（无障碍）。
     */
    function SwitchCard(props) {
      const {
        id, label, desc, note, effect, danger, checked, onChange,
        disabled, defaultValue, badge, depReason, dependsOn, recommend,
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
      h(SettingMetaLine, { defaultValue, badge, depReason, recommend }))
    }

    /**
     * 字段卡片：children 可以是元素，也可以是 (describedBy) => 元素，保证控件与说明关联。
     */
    function FieldCard(props) {
      const {
        id, label, desc, note, effect, danger, children,
        disabled, defaultValue, badge, depReason, dependsOn, recommend,
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
      h(SettingMetaLine, { defaultValue, badge, depReason, recommend }))
    }

    // ---------------------------------------------------- scroll contract（R9-07）

    /** 细滚动条样式的唯一 id：面板重挂/两插件先后装载都只留一份 <style>。 */
    const SCROLLBAR_STYLE_ID = 'dsh-scroll-contract'

    /**
     * 注入细滚动条宽度（R9-07 第 5 条）。
     * Why 按 id 判重：面板随页签/重挂重渲染，重复 appendChild 会让 <style> 无限增长；
     * 宿主没有 document（服务端/测试）时静默跳过，不阻断装载。
     */
    function injectScrollbarStyle() {
      if (typeof document === 'undefined' || !document || !document.head) return
      if (typeof document.getElementById === 'function' && document.getElementById(SCROLLBAR_STYLE_ID)) return
      const style = document.createElement('style')
      style.id = SCROLLBAR_STYLE_ID
      style.textContent = '::-webkit-scrollbar{width:8px}'
      document.head.appendChild(style)
    }

    /**
     * 页根键盘滚动（R9-07 第 6 条）：PageUp/PageDown 翻一屏，Home/End 到顶/底。
     * Why 自己算：页根是普通 div，浏览器不原生响应这些键；不写自定义 wheel/transform 滚动。
     * 输入控件里的 Home/End 属于光标语义，不接管。
     */
    function onScrollRegionKeys(event) {
      const node = event && event.currentTarget
      if (!node || typeof node.scrollTop !== 'number') return
      const target = event.target || null
      const tag = String((target && target.tagName) || '').toLowerCase()
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || (target && target.isContentEditable)) return
      const screen = Math.max(1, Math.round((node.clientHeight || 0) * 0.9))
      if (event.key === 'PageDown') { node.scrollTop += screen; event.preventDefault() }
      else if (event.key === 'PageUp') { node.scrollTop -= screen; event.preventDefault() }
      else if (event.key === 'Home') { node.scrollTop = 0; event.preventDefault() }
      else if (event.key === 'End') { node.scrollTop = node.scrollHeight; event.preventDefault() }
    }

    /**
     * 页根滚动契约属性（R9-07 第 1/6 条）：`data-wm-scroll` 标记唯一纵向滚动根，
     * 键盘可聚焦 + region 语义；aria-label 复用面板标题，不新增文案键。
     */
    function scrollRegionProps(t) {
      return {
        tabIndex: 0,
        role: 'region',
        'aria-label': t('meta.title'),
        'data-wm-scroll': 'page',
        onKeyDown: (event) => onScrollRegionKeys(event),
      }
    }

    /**
     * 抽屉焦点圈（R9-07 第 6 条「焦点圈」）：Tab 到边界时把焦点拉回另一端。
     * Why 现查现算：面板不用第三方焦点库；抽屉内容随数据重渲染，缓存节点会失效。
     */
    function trapDialogFocus(event) {
      if (!event || event.key !== 'Tab') return
      const root = event.currentTarget
      if (!root || typeof root.querySelectorAll !== 'function') return
      const nodes = root.querySelectorAll(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )
      if (!nodes || nodes.length === 0) return
      const first = nodes[0]
      const last = nodes[nodes.length - 1]
      if (event.shiftKey && event.target === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && event.target === last) { event.preventDefault(); first.focus() }
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

    // ------------------------------------------------------- manual（WP3）

    /** 说明书内联格式：**粗体** / `代码` / [文字](链接)；渲染失败按纯文本走。 */
    function inlineMd(text, prefix) {
      const out = []
      const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g
      let last = 0
      let m
      let seq = 0
      while ((m = re.exec(text))) {
        if (m.index > last) out.push(text.slice(last, m.index))
        const token = m[0]
        const key = prefix + '-i' + seq
        seq += 1
        if (token.startsWith('**')) {
          out.push(h('strong', { key }, token.slice(2, -2)))
        } else if (token.startsWith('`')) {
          out.push(h('code', { key, style: css.mdCode }, token.slice(1, -1)))
        } else {
          const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)
          out.push(h('a', {
            key, href: link[2], target: '_blank', rel: 'noreferrer',
            style: { color: 'var(--dsw-alias-brand-primary)' },
          }, link[1]))
        }
        last = m.index + token.length
      }
      if (last < text.length) out.push(text.slice(last))
      return out
    }

    /**
     * 极简 Markdown 渲染（说明书专用）：标题/列表/表格/段落 + 行内粗体/代码/链接。
     * 刻意不引第三方解析器：client 零构建、离线可读；说明书格式由生成器控制，不需要完整 MD 语义。
     */
    function MiniMarkdown(props) {
      const lines = String(props.source || '').split('\n')
      const nodes = []
      let para = []
      let list = []
      let seq = 0
      const key = (tag) => tag + '-' + (seq += 1)

      const flushPara = () => {
        if (para.length === 0) return
        const text = para.join(' ')
        nodes.push(h('p', { key: key('p'), style: css.mdP }, inlineMd(text, key('p'))))
        para = []
      }
      const flushList = () => {
        if (list.length === 0) return
        nodes.push(h('ul', { key: key('ul'), style: css.mdList },
          list.map((item, index) => h('li', { key: index }, inlineMd(item, key('li'))))))
        list = []
      }
      const flushAll = () => { flushPara(); flushList() }

      let i = 0
      while (i < lines.length) {
        const line = lines[i]
        const trimmed = line.trim()
        if (trimmed === '') { flushAll(); i += 1; continue }

        const heading = /^(#{1,3})\s+(.*)$/.exec(trimmed)
        if (heading) {
          flushAll()
          const style = heading[1].length === 1 ? css.mdH1 : heading[1].length === 2 ? css.mdH2 : css.mdH3
          nodes.push(h('div', { key: key('h'), style }, inlineMd(heading[2], key('h'))))
          i += 1
          continue
        }

        const bullet = /^[-*]\s+(.*)$/.exec(trimmed)
        if (bullet) {
          flushPara()
          list.push(bullet[1])
          i += 1
          continue
        }

        const isTable = trimmed.startsWith('|') && i + 1 < lines.length && /^\|?\s*:?-{3,}/.test(lines[i + 1].trim())
        if (isTable) {
          flushAll()
          const cells = (row) => row.replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim())
          const header = cells(trimmed)
          i += 2
          const rows = []
          while (i < lines.length && lines[i].trim().startsWith('|')) {
            rows.push(cells(lines[i].trim()))
            i += 1
          }
          nodes.push(h('table', { key: key('t'), style: css.mdTable },
            h('thead', null, h('tr', null, header.map((cell, index) => h('th', { key: index, style: css.mdTh }, inlineMd(cell, key('th')))))),
            h('tbody', null, rows.map((row, r) => h('tr', { key: r },
              row.map((cell, c) => h('td', { key: c, style: css.mdTd }, inlineMd(cell, key('td')))))))))
          continue
        }

        para.push(trimmed)
        i += 1
      }
      flushAll()
      return h('div', { style: css.manualBody }, nodes)
    }

    /** 使用说明抽屉：全屏可滚、Esc 关闭、点遮罩关闭；内容离线（生成块）。 */
    function ManualDrawer(props) {
      const { open, onClose, t, locale } = props
      const panelRef = useRef(null)
      useEffect(() => {
        if (!open) return undefined
        if (panelRef.current && typeof panelRef.current.focus === 'function') panelRef.current.focus()
        if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined
        const onKey = (e) => { if (e.key === 'Escape') onClose() }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [open, onClose])
      if (!open) return null
      const lang = String(locale || 'zh').slice(0, 2)
      const doc = MANUAL_DOC[lang] || MANUAL_DOC.zh || ''
      return h('div', { style: css.manualMask, onClick: onClose },
        h('aside', {
          ref: panelRef, tabIndex: -1, role: 'dialog', 'aria-modal': 'true',
          'aria-label': t('manual.title'), style: css.manualPanel,
          onClick: (e) => e.stopPropagation(),
        },
        h('div', { style: css.inline },
          h('div', { style: { ...css.cardTitle, flex: 1 } }, t('manual.title')),
          lang !== 'zh' ? h('span', { style: css.tertiary }, t('manual.zhOnly')) : null,
          h('button', { style: css.button, onClick: onClose }, t('manual.close'))),
        h('div', { style: css.manualScroll }, h(MiniMarkdown, { source: doc }))))
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
      const [manualOpen, setManualOpen] = useState(false)
      const [importState, setImportState] = useState(null)
      const [opState, setOpState] = useState(null)
      const [backendCfg, setBackendCfg] = useState({ mode: '', url: '' })
      // 手动同步方向跟随 sync.mode（off 时手动按钮仍默认双向，不把"自动关闭"误当"禁用手动"）。
      const [syncDir, setSyncDir] = useState('both')
      const [backendStatus, setBackendStatus] = useState({ checked: false, protocol: null, outbox: null })
      const [recallCfg, setRecallCfg] = useState(null)
      const [switchLocal, setSwitchLocal] = useState(null)
      const fileRef = useRef(null)
      // R9-07：页根是面板唯一纵向滚动容器；切页签要回到上次位置，筛选变化要归零。
      const panelRef = useRef(null)
      const scrollPos = useRef({})

      useEffect(() => {
        let alive = true
        callJson('/config').then((body) => {
          const cfg = (body && body.config) || {}
          if (!alive) return
          const value = Number(cfg.panel && cfg.panel.pollMs)
          if (Number.isFinite(value) && value > 0) setPollMs(value)
          const runtime = (body && body.runtimeIdentity) || {}
          const identityNow = {
            userId: String((runtime.userId || (cfg.identity && cfg.identity.userId)) || ''),
            roleId: String((runtime.roleId !== undefined ? runtime.roleId : (cfg.identity && cfg.identity.roleId)) || ''),
            // 优先显示"最近一次会话真正用的 workspace"（会话 cwd）；没有会话历史才回 Config。
            workspace: String((runtime.runtimeWorkspace || (cfg.identity && cfg.identity.workspace)) || ''),
          }
          setIdentity(identityNow)
          // 读写请求的身份参数只允许回环覆盖；远端只读面板不发送。
          setPanelIdentity(identityNow, body && body.identityOverride === true)
          setCaps({
            syncEnabled: cfg.sync ? cfg.sync.enabled === true : true,
            reflectEnabled: cfg.reflect ? cfg.reflect.enabled === true : true,
          })
          setBackendCfg({
            mode: String((cfg.backend && cfg.backend.mode) || ''),
            url: String((cfg.backend && cfg.backend.url) || ''),
          })
          const modeDir = String((cfg.sync && cfg.sync.mode) || '')
          setSyncDir(modeDir === 'push' || modeDir === 'pull' || modeDir === 'both' ? modeDir : 'both')
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
        if (TABS.some(([key]) => key === wantedTab)) switchTab(wantedTab)
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
            body: JSON.stringify({ direction: syncDir, dryRun: true }),
          })
          setOpState({ kind: 'sync', phase: 'dry', body })
        } catch (err) { setOpState({ kind: 'sync', phase: 'error', code: (err && err.code) || 'unknown_error' }) }
      }
      const runSyncReal = async () => {
        setOpState({ kind: 'sync', phase: 'busy' })
        try {
          const body = await callJson('/sync', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ direction: syncDir, dryRun: false, confirm: true }),
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

      /**
       * 页签切换：先记下当前页签的 scrollTop，再切 tab；渲染后的 effect 恢复目标页签位置。
       * Why 用 ref 不 useState：滚动位置不是渲染输入，进 state 白白多一轮重渲染。
       */
      /** 待恢复的滚动目标：切页签时置位，渲染后尝试写入，成功即清（R9-07 真机修正）。 */
      const pendingRestore = useRef(0)
      const switchTab = (next) => {
        const node = panelRef.current
        if (node && next !== tab) scrollPos.current[tab] = node.scrollTop
        pendingRestore.current = next === tab ? 0 : (scrollPos.current[next] || 0)
        setTab(next)
        // 面板异步加载迟迟不失败时别无限挂起：1.5s 后放弃，避免之后某次渲染把用户拽走。
        setTimeout(() => { pendingRestore.current = 0 }, 1500)
      }

      // 为什么按帧重试而不是「每次渲染」：目标页签的数据在子组件里加载，父级 Panel 不重渲染，
      // 依赖变化的 effect 只会跑一次；而 scrollTop 在首帧高度不足时会被静默夹到 0。
      // requestAnimationFrame 直到内容长够或 1.5s 放弃，实测能稳住（R9-07 五步第 4 步）。
      useEffect(() => {
        const node = panelRef.current
        const target = pendingRestore.current
        if (!node || !target) return undefined
        node.scrollTop = typeof target === 'number' ? target : 0
        // 只有真的到位才算成功：内容不够高时会被夹到"当前最大可滚值"，>0 不等于到位（窄屏实测）。
        if (Math.abs(node.scrollTop - target) <= 2) { pendingRestore.current = 0; return undefined }
        const startedAt = Date.now()
        let raf = 0
        let timer = 0
        const tick = () => {
          if (!node) return
          node.scrollTop = target
          if (Math.abs(node.scrollTop - target) <= 2) { pendingRestore.current = 0; return }
          if (Date.now() - startedAt > 1500) { pendingRestore.current = 0; return }
          raf = typeof requestAnimationFrame === 'function'
            ? requestAnimationFrame(tick)
            : (timer = setTimeout(tick, 32))
        }
        tick()
        return () => {
          if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf)
          if (timer) clearTimeout(timer)
        }
      }, [tab])

      /** 筛选/搜索变化：整页回到顶部（R9-07），否则结果变了还停在旧位置，像没刷新。 */
      const resetScroll = () => {
        const node = panelRef.current
        if (node) node.scrollTop = 0
      }

      const viewProps = { t, locale, version, refreshKey: version, onScrollReset: resetScroll }
      const overviewProps = {
        ...viewProps, pollMs, backendMode: backendCfg.mode, backendUrl: backendCfg.url,
        backendStatus, recallCfg, switchLocal,
        onSwitchLocal, onOpenSettings: () => switchTab('settings'),
      }
      let view
      if (tab === 'memory') {
        view = h(MemoryTab, {
          ...viewProps,
          onImport: () => { if (fileRef.current) fileRef.current.click() },
          onOpenSettings: () => switchTab('settings'),
        })
      } else if (tab === 'rules') view = h(RulesView, viewProps)
      else if (tab === 'recall') view = h(RecallTab, { ...viewProps, recallCfg })
      else if (tab === 'writes') view = h(WritesTab, viewProps)
      else if (tab === 'settings') view = h(SettingsTab, {
        t, locale, onSaved, onOpenManual: () => setManualOpen(true),
      })
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

      return h('div', { style: css.panel, ref: panelRef, ...scrollRegionProps(t) },
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
            h('button', {
              style: css.button, title: t('manual.button'), onClick: () => setManualOpen(true),
            }, t('manual.button')),
            h('button', { style: css.button, onClick: () => setVersion((v) => v + 1) }, t('common.refresh')),
            h('input', {
              ref: fileRef, type: 'file', accept: t('import.accept'),
              style: { display: 'none' }, onChange: onFile,
            }))),
        opCard,
        importCard,
        h('nav', { style: css.tabs, role: 'tablist' }, TABS.map(([key, labelKey]) => h('button', {
          key,
          role: 'tab',
          'aria-selected': key === tab ? 'true' : 'false',
          style: key === tab ? css.tabActive : css.tab,
          onClick: () => switchTab(key),
        }, t(labelKey)))),
        h('main', { style: css.main }, view),
        h(ManualDrawer, { open: manualOpen, onClose: () => setManualOpen(false), t, locale }))
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
            const body = await callJson(withIdentity('/recent?limit=3'))
            if (alive) setRecent({ status: 'ok', items: Array.isArray(body.items) ? body.items : [] })
          } catch (err) {
            if (alive) setRecent({ status: 'error', err, items: [] })
          }
          try {
            const body = await callJson(withIdentity('/recalls?limit=100'))
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
        // 队列积压必须可见（审计 P1-14）：只看 running 会把「排队 7 条、一条没跑」显示成空闲。
        jobText = running > 0
          ? t('health.running') + ' ' + running + '/' + (running + queued)
          : queued > 0
            ? t('health.queued') + ' ' + queued + (failed > 0 ? ' · ' + failed + ' !' : '')
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
        h('div', { style: css.muted }, t('overview.scopeAll')),
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
        h(WrapCard, { t, locale, pollMs, version, visible }),
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

    // ---------------------------------------------------- 会话收尾卡片（S1）
    // 职责：收尾卡的取数/交互/状态与文案；概览页只装配。依赖同一 factory 作用域
    // （h/useState/useEffect/callJson/css/格式化 helper），不 import、不读其他页签内部。

    /** 错误码 → 中文一句话；原始码只放 title（P1：错误码不得直出正文）。 */
    const WRAP_ERROR_TEXT = {
      turn_in_progress: (t) => t('overview.wrapErrorTurn'),
      no_material: (t) => t('overview.wrapErrorNoMaterial'),
      wrap_disabled: (t) => t('overview.wrapErrorDisabled'),
      unsupported_backend: (t) => t('overview.wrapErrorUnsupported'),
      no_session: (t) => t('overview.wrapErrorNoSession'),
      same_material: (t) => t('overview.wrapErrorSame'),
      busy_wrap: (t) => t('overview.wrapErrorBusy'),
      busy_queue_full: (t) => t('overview.wrapErrorBusy'),
      session_queue_full: (t) => t('overview.wrapErrorSessionBusy'),
      capture_unavailable: (t) => t('overview.wrapErrorCapture'),
      db_error: (t) => t('overview.wrapErrorDb'),
      bad_json: (t) => t('overview.wrapErrorBadJson'),
      model_timeout: (t) => t('overview.wrapErrorTimeout'),
      spool_missing: (t) => t('overview.wrapErrorSpool'),
      candidate_write_failed: (t) => t('overview.wrapErrorWrite'),
    }

    function wrapErrorText(t, code) {
      const key = String(code || 'unknown')
      const fn = WRAP_ERROR_TEXT[key]
      return fn ? fn(t) : '[' + key + ']'
    }

    const WRAP_STATE_KEY = {
      queued: 'wrap.stateQueued', running: 'wrap.stateRunning', done: 'wrap.stateDone',
      failed: 'wrap.stateFailed', skipped: 'wrap.stateSkipped',
    }

    function wrapStateText(t, state) {
      const key = WRAP_STATE_KEY[String(state || '')]
      return key ? t(key) : String(state || '—')
    }

    function wrapTriggerText(t, trigger) {
      const key = 'wrap.trigger' + String(trigger || '').charAt(0).toUpperCase() + String(trigger || '').slice(1)
      return hasKey(key) ? t(key) : String(trigger || '—')
    }

    /** lastSkip 原因 → 中文一句话（队列已清理必须可见，不显示裸 reason）。 */
    const WRAP_SKIP_TEXT = {
      queue_cleared: (t) => t('overview.wrapSkipCleared'),
      queue_timeout: (t) => t('overview.wrapSkipTimeout'),
      session_disposed: (t) => t('overview.wrapSkipDisposed'),
      busy: (t) => t('overview.wrapSkipBusy'),
      rate_limited: (t) => t('overview.wrapSkipRate'),
      spool_missing: (t) => t('overview.wrapErrorSpool'),
    }

    function wrapSkipText(t, skip) {
      const reason = String((skip && skip.reason) || '—')
      const fn = WRAP_SKIP_TEXT[reason]
      return fn ? fn(t) : reason
    }

    /** 阶段投影（总纲 §5.3）：排队时 phase 恒 null；reconcile 未开启时绝不出现该阶段。 */
    const WRAP_PHASES_BASE = [
      { key: 'queued', label: 'overview.wrapPhaseQueued' },
      { key: 'capture', label: 'overview.wrapPhaseCapture' },
      { key: 'distill', label: 'overview.wrapPhaseDistill' },
      { key: 'dispatch', label: 'overview.wrapPhaseDispatch' },
      { key: 'report', label: 'overview.wrapPhaseReport' },
    ]
    const WRAP_RECONCILE_STEP = { key: 'reconcile', label: 'overview.wrapPhaseReconcile' }

    /** 阶段序列：reconcile 关闭时绝不出现该阶段（总纲 §5.3）。 */
    function wrapPhases(reconcileEnabled) {
      if (!reconcileEnabled) return WRAP_PHASES_BASE
      return [WRAP_PHASES_BASE[0], WRAP_PHASES_BASE[1], WRAP_PHASES_BASE[2], WRAP_RECONCILE_STEP, WRAP_PHASES_BASE[3], WRAP_PHASES_BASE[4]]
    }

    function wrapPhaseIndex(latest, reconcileEnabled) {
      if (!latest) return -1
      const length = wrapPhases(reconcileEnabled).length
      if (latest.state === 'queued') return 0
      if (latest.state !== 'running') return length - 1
      const phase = String(latest.phase || 'created')
      if (!reconcileEnabled) {
        if (phase === 'distilled') return 2
        if (phase === 'reconciled') return 2
        if (phase === 'written') return 3
        if (phase === 'reported' || phase === 'done') return 4
        return 1
      }
      if (phase === 'distilled') return 2
      if (phase === 'reconciled') return 3
      if (phase === 'written') return 4
      if (phase === 'reported' || phase === 'done') return 5
      return 1
    }

    /** 阶段进度点：排队→采集→蒸馏→分流→报告；当前阶段高亮 + aria-current。 */
    function WrapProgress({ t, latest, reconcileEnabled }) {
      const active = wrapPhaseIndex(latest, reconcileEnabled)
      if (active < 0) return null
      return h('div', { style: css.progRow, role: 'list', 'aria-label': t('overview.wrapProgress') },
        wrapPhases(reconcileEnabled).map((step, index) => h('span', {
          key: step.key, role: 'listitem', style: css.progStep,
          'aria-current': index === active ? 'step' : undefined,
        },
          h('span', { style: index <= active ? css.progDotOn : css.progDot }),
          h('span', { style: index === active ? css.progLabelOn : css.progLabel }, t(step.label)))))
    }

    /** 状态徽标：失败/运行/成功有底色，不再是一行普通文字（UI 审查 P1-1）。 */
    function WrapStateBadge(props) {
      const { t, state } = props
      const tone = state === 'failed' ? 'error' : state === 'running' || state === 'queued' ? 'warn'
        : state === 'done' ? 'ok' : 'muted'
      const color = tone === 'error' ? 'var(--dsw-alias-state-error-primary)'
        : tone === 'ok' ? 'var(--dsw-alias-state-success-primary)'
          : tone === 'warn' ? 'var(--dsw-alias-state-warn-primary)'
            : 'var(--dsw-alias-label-tertiary)'
      return h('span', {
        style: { ...css.badgeChip, color, borderColor: color, background: 'transparent' },
        'aria-label': wrapStateText(t, state),
      }, wrapStateText(t, state))
    }

    /** 等宽指标块：标签上、值下、左对齐（替代 Row 塞 metaGrid 的错位）。 */
    function StatTile(props) {
      return h('div', { style: css.statTile },
        h('div', { style: css.statLabel }, props.label),
        h('div', { style: css.statValue }, props.value))
    }

    /** 收尾卡数据与动作：状态、会话列表、报告、失败折叠。 */
    function useWrapCard({ visible, pollMs, version }) {
      const [data, setData] = useState({ status: 'loading', body: null, sessions: null, err: null })
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState(null)
      const [selected, setSelected] = useState('')
      const [failOpen, setFailOpen] = useState(false)
      const [report, setReport] = useState({ open: false, status: 'idle', text: '', err: null, runId: null })

      const load = async () => {
        let body = null
        let err = null
        try { body = await callJson(withIdentity('/wrap/status')) } catch (e) { err = e }
        let sessions = null
        let sessionsErr = null
        for (let attempt = 0; attempt < 2 && !sessions; attempt += 1) {
          try { sessions = await callJson(withIdentity('/wrap/sessions')) } catch (e) { sessionsErr = e; if (attempt === 0) await new Promise((r) => setTimeout(r, 150)) }
        }
        setData({ status: err ? 'error' : 'ok', body, sessions, sessionsErr, err })
      }

      useEffect(() => {
        if (!visible) return undefined
        let alive = true
        const tick = async () => { if (alive) await load() }
        tick()
        // 会话缓冲随聊天增长：收尾卡最多 10s 刷新一次，保证新会话尽快可被选中。
        const every = Math.max(5000, Math.min(10000, Number(pollMs) || 60000))
        const timer = setInterval(tick, every)
        return () => { alive = false; clearInterval(timer) }
      }, [visible, pollMs, version])

      const trigger = async () => {
        setBusy(true); setNotice(null)
        try {
          const payload = { trigger: 'manual' }
          if (selected) payload.sessionId = selected
          const body = await callJson('/wrap', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          })
          if (body && body.existing) setNotice({ ok: true, kind: 'existing', body })
          else if (body && body.queued) setNotice({ ok: true, kind: 'queued', body })
          else setNotice({ ok: true, kind: 'queued', body })
          await load()
        } catch (err) {
          setNotice({ ok: false, code: (err && err.code) || 'unknown_error' })
          // 失败后补一次取数：会话可能是刚出现（或刚关闭），不能让下拉一直停在旧空列表。
          setTimeout(() => { void load() }, 600)
        } finally { setBusy(false) }
      }

      const toggleAuto = async (next) => {
        setNotice(null)
        try {
          await callJson('/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ config: { wrap: { idle: Boolean(next) } } }),
          })
          await load()
        } catch (err) {
          setNotice({ ok: false, code: (err && err.code) || 'config_save_failed' })
        }
      }

      const toggleSkip = async (next) => {
        if (!selected) return
        setNotice(null)
        try {
          await callJson('/wrap/session', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: selected, skipAuto: Boolean(next) }),
          })
          await load()
        } catch (err) {
          setNotice({ ok: false, code: (err && err.code) || 'unknown_error' })
        }
      }

      const toggleReport = async () => {
        if (report.open) { setReport((prev) => ({ ...prev, open: false })); return }
        const latest = data.body && data.body.latest
        if (!latest || !latest.reportAvailable) return
        setReport({ open: true, status: 'loading', text: '', err: null, runId: latest.id })
        try {
          const body = await callJson(withIdentity('/wrap/report?id=' + encodeURIComponent(latest.id)))
          setReport({ open: true, status: 'ok', text: String((body && body.text) || ''), err: null, runId: latest.id })
        } catch (err) {
          setReport({ open: true, status: 'error', text: '', err, runId: latest.id })
        }
      }

      return { data, busy, notice, selected, setSelected, failOpen, setFailOpen, report, trigger, toggleReport, toggleAuto, toggleSkip, reload: load }
    }

    /** 收尾卡片本体：会话选择 + 立即收尾 + 状态/指标/警告/失败折叠/报告。 */
    function WrapCard({ t, locale, pollMs, version, visible }) {
      const { data, busy, notice, selected, setSelected, failOpen, setFailOpen, report, trigger, toggleReport, toggleAuto, toggleSkip, reload } = useWrapCard({ visible, pollMs, version })
      const body = data.body
      const sessions = data.sessions && Array.isArray(data.sessions.items) ? data.sessions.items : []
      // 自动开关优先信 /wrap/status.auto：/wrap/sessions 失败时（例如页面刚加载）也不能显示成“关闭”。
      const auto = (data.body && data.body.auto) || (data.sessions && data.sessions.auto) || { enabled: false, idleMinutes: 10 }
      const enabled = data.status === 'ok' && body && body.enabled && body.supported !== false
      const latest = body && body.latest ? body.latest : null
      // 三计数（入库/待审/跳过）：新 run 读 counts；旧 run 无该字段时按候选列回退。
      const counts = latest && latest.counts && typeof latest.counts === 'object'
        ? {
          ingested: Number(latest.counts.ingested || 0),
          reviewed: Number(latest.counts.reviewed || 0),
          skipped: Number(latest.counts.skipped || 0),
        }
        : { ingested: 0, reviewed: Number(latest && latest.candidates || 0), skipped: 0 }
      const failures = body && Array.isArray(body.recent) ? body.recent.filter((row) => row.state === 'failed') : []
      const selectedSession = sessions.find((item) => item.sessionId === selected) || null
      const selectLabel = selectedSession
        ? t('overview.wrapSessionSelected', { turns: String(selectedSession.materialTurns) })
        : t('overview.wrapSessionRecent')

      const noticeNode = (() => {
        if (!notice) return null
        if (!notice.ok) {
          // 空态也要给反馈（审计 P1-12）：409 不能表现为“什么都没发生”。
          return h('div', { style: css.error, title: String(notice.code || '') },
            t('overview.wrapFailed') + ' — ' + wrapErrorText(t, notice.code))
        }
        if (notice.kind === 'existing') {
          return h('div', { style: css.tertiary }, t('overview.wrapExisting'))
        }
        const runId = notice.body && notice.body.runId
        const position = notice.body && notice.body.position
        return h('div', { style: css.ok }, position
          ? t('overview.wrapQueuedPosition', { n: String(position) })
          : t('overview.wrapQueued', { id: String(runId ?? '—') }))
      })()

      // 报告动作（S4）：复制/下载 .md；SSR/测试环境无 document 时静默不渲染按钮。
      const canUseReportActions = typeof document !== 'undefined'
      const copyReport = async () => {
        try { await navigator.clipboard.writeText(report.text || '') } catch { /* 浏览器拒绝剪贴板：不静默失败 */ }
      }
      const downloadReport = () => {
        try {
          const blob = new Blob([report.text || ''], { type: 'text/markdown;charset=utf-8' })
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url; a.download = `session-wrap-${report.runId || 'report'}.md`
          a.click()
          setTimeout(() => URL.revokeObjectURL(url), 1000)
        } catch { /* 浏览器不支持 Blob：无动作但按钮存在即说明能力 */ }
      }
      const reportNode = report.open
        ? (report.status === 'loading'
          ? h('div', { style: css.muted }, t('state.loading'))
          : report.status === 'error'
            ? h('div', { style: css.error }, t('overview.wrapReportFailed') + ' — ' + errText(t, report.err))
            : h('div', { style: css.stack },
              h('pre', { style: css.reportBox, 'aria-label': t('overview.wrapShowReport') }, report.text || t('overview.wrapReportEmpty')),
              canUseReportActions
                ? h('div', { style: css.inline },
                  h('button', { style: css.button, onClick: copyReport }, t('overview.wrapCopyReport')),
                  h('button', { style: css.button, onClick: downloadReport }, t('overview.wrapDownloadReport')))
                : null))
        : null

      const failureRows = failOpen
        ? h('div', { style: css.stack }, failures.slice(0, 5).map((row) => h('div', {
          key: 'fail-' + String(row.id), style: css.failureRow,
        },
          h('div', { style: css.failureHead },
            h('span', { style: css.tertiary }, fmtTime(row.updatedAt || row.createdAt, locale)),
            h('span', { style: css.muted, title: String(row.error || '') },
              wrapErrorText(t, String(row.error || '').split(':')[0]))))))
        : null

      const warnings = latest && latest.switchReady && Array.isArray(latest.switchReady.warnings) ? latest.switchReady.warnings : []
      const blockers = latest && latest.switchReady && Array.isArray(latest.switchReady.blockers) ? latest.switchReady.blockers : []

      return h(Card, null,
        h('div', { style: css.wrapHead },
          h(SectionTitle, null, t('overview.wrapTitle')),
          h('div', { style: css.wrapActions },
            h('label', { style: css.wrapSelectWrap, htmlFor: 'wrap-session-select' },
              h('span', { style: css.statLabel }, t('overview.wrapSessionLabel')),
              h('select', {
                id: 'wrap-session-select',
                style: css.select,
                value: selected,
                disabled: busy || !enabled || sessions.length === 0,
                'aria-label': t('overview.wrapSessionLabel'),
                onChange: (e) => setSelected(e.target.value),
              },
                h('option', { value: '' }, sessions.length === 0 ? t('overview.wrapNoSession') : selectLabel),
                sessions.map((item) => h('option', {
                  key: item.sessionId, value: item.sessionId,
                }, t('overview.wrapSessionOption', {
                  turns: String(item.materialTurns),
                  state: item.open ? t('overview.wrapSessionRunning')
                    : item.skipAuto ? t('overview.wrapSessionSkipped') : String(item.lastRunState || ''),
                }))))),
            h('button', {
              style: enabled && !busy ? css.buttonPrimary : css.buttonDisabled,
              disabled: busy || !enabled,
              title: !enabled
                ? (data.status === 'error' ? t('overview.wrapLoadFailed')
                  : !body ? t('state.loading')
                    : !body.enabled ? t('overview.wrapDisabled')
                      : body.supported === false ? t('overview.wrapUnsupported') : '')
                : undefined,
              'aria-label': t('overview.wrapNow'),
              onClick: trigger,
            }, busy ? t('overview.wrapBusy') : t('overview.wrapNow')))),
        h('div', { style: css.wrapToggles },
          h('div', { style: css.wrapToggleRow },
            h(Switch, {
              id: 'wrap-auto-switch', checked: Boolean(auto.enabled), onChange: toggleAuto,
              label: t('overview.wrapAuto'),
            }),
            h('span', { style: css.statLabel },
              t('overview.wrapAutoDesc', { n: String(auto.idleMinutes || 10) }))),
          selectedSession
            ? h('div', { style: css.wrapToggleRow },
              h(Switch, {
                id: 'wrap-skip-switch', checked: Boolean(selectedSession.skipAuto), onChange: toggleSkip,
                label: t('overview.wrapSkipAuto'),
              }),
              h('span', { style: css.statLabel }, t('overview.wrapSkipAutoDesc')))
            : null),
        noticeNode,
        data.status === 'ok' && !data.sessions
          ? h('div', { style: css.tertiary }, t('overview.wrapSessionLoadFailed') + ' — ' + errText(t, data.sessionsErr || { code: 'network_error' }))
          : null,
        data.status === 'loading'
          ? h('div', { style: css.muted }, t('state.loading'))
          : data.status === 'error'
            ? h('div', { style: css.errorBox },
              h('div', { style: css.error }, t('overview.wrapLoadFailed') + ' — ' + errText(t, data.err)),
              h('button', { style: css.button, onClick: () => { void reload() } }, t('common.retry')))
            : !body || body.supported === false
              ? h('div', { style: css.tertiary }, t('overview.wrapUnsupported'))
              : !body.enabled
                ? h('div', { style: css.tertiary }, t('overview.wrapDisabled'))
                : !latest
                  ? h('div', { style: css.stack },
                    h('div', { style: css.tertiary }, t('overview.wrapEmpty')),
                    sessions.length > 0
                      ? h('div', { style: css.tertiary }, t('overview.wrapEmptyGuide'))
                      : h('div', { style: css.tertiary }, t('overview.wrapNoSession')))
                  : h('div', { style: css.stack },
                    h('div', { style: css.wrapStatusRow },
                      h('span', { style: css.wrapStatusLeft },
                        h(WrapStateBadge, { t, state: latest.state }),
                        h('span', { style: css.tertiary }, wrapTriggerText(t, latest.trigger))),
                      h('span', { style: css.muted }, fmtTime(latest.updatedAt || latest.createdAt, locale))),
                    h(WrapProgress, { t, latest, reconcileEnabled: Boolean(body.reconcile && body.reconcile.enabled) }),
                    h('div', { style: css.statGrid },
                      h(StatTile, { label: t('overview.wrapIngested'), value: fmtNum(counts.ingested, locale) }),
                      h(StatTile, { label: t('overview.wrapCandidates'), value: fmtNum(counts.reviewed, locale) }),
                      h(StatTile, { label: t('overview.wrapSkippedCount'), value: fmtNum(counts.skipped, locale) }),
                      h(StatTile, { label: t('overview.wrapProposals'), value: fmtNum(latest.ruleProposals, locale) }),
                      h(StatTile, { label: t('overview.wrapOpenLoops'), value: fmtNum(latest.openLoops, locale) }),
                      h(StatTile, {
                        label: t('overview.wrapSwitchReady'),
                        value: latest.switchReady && latest.switchReady.ready === true
                          ? t('overview.wrapReadyYes') : t('overview.wrapReadyNo'),
                      })),
                    blockers.length
                      ? h('div', { style: css.warn }, t('overview.wrapBlockers', { list: blockers.join(' · ') })) : null,
                    warnings.length
                      ? h('div', { style: css.warn }, t('overview.wrapWarnings', { list: warnings.join(' · ') })) : null,
                    latest.error
                      ? h('div', { style: { ...css.error, wordBreak: 'break-word' }, title: String(latest.error) },
                        t('overview.wrapLastError') + ': ' + wrapErrorText(t, String(latest.error).split(':')[0])
                        + (latest.state === 'failed' ? ' · ' + t('overview.wrapRetryable') : '')) : null,
                    latest.retrying && latest.retrying.attempt
                      ? h('div', { style: css.warn }, t('overview.wrapRetrying', {
                        n: String(latest.retrying.attempt), max: String(latest.retrying.max || 4),
                      })) : null,
                    body.lastSkip
                      ? h('div', { style: css.tertiary },
                        t('overview.wrapSkipped', { reason: wrapSkipText(t, body.lastSkip) })) : null,
                    failures.length > 0
                      ? h('div', { style: css.stack },
                        h('button', {
                          style: css.foldBtn,
                          'aria-expanded': failOpen ? 'true' : 'false',
                          onClick: () => setFailOpen(!failOpen),
                        }, failOpen
                          ? t('overview.wrapFailureHide')
                          : t('overview.wrapFailureCount', { n: String(failures.length) })),
                        failureRows)
                      : null,
                    latest.reportAvailable
                      ? h('div', { style: css.inline },
                        h('button', { style: css.button, onClick: toggleReport, 'aria-expanded': report.open ? 'true' : 'false' },
                          report.open ? t('overview.wrapHideReport') : t('overview.wrapShowReport')))
                      : null,
                    reportNode))
    }
    function MemoryTab(props) {
      const { t, locale, version, onImport, onScrollReset } = props
      /** 搜索/翻页换了结果集就回页顶（R9-07 第 6 条「筛选变化归零」）。 */
      const resetPageScroll = () => { if (typeof onScrollReset === 'function') onScrollReset() }
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
                text, level: 'normal', memory_type: 'semantic', tags: [SAMPLE_TAG], identity: identityFields(),
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
              body: JSON.stringify({ patch: { status: 'archived' }, ...(identityFields() || {}) }),
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
        callJson(withIdentity('/nodes?limit=' + PAGE_SIZE + '&offset=' + (page * PAGE_SIZE))).then((body) => {
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
              body: JSON.stringify({ query: q, limit: PAGE_SIZE, ...(identityFields() || {}) }),
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
              onChange: (e) => { setQuery(e.target.value); resetPageScroll() },
            }),
            searching ? h('button', { style: css.button, onClick: () => { setQuery(''); resetPageScroll() } }, t('common.close')) : null,
            !searching ? h('button', { style: css.buttonPrimary, onClick: () => setWriteOpen((v) => !v) }, t('memory.newTitle')) : null),
          notice ? h('div', { style: css.ok }, notice) : null,
          listBody,
          !searching && nodes.status === 'ok' && nodes.total > 0
            ? h('div', { style: css.pagination },
              h('button', { style: canPrev ? css.button : css.buttonDisabled, disabled: !canPrev, onClick: () => { setPage((p) => Math.max(0, p - 1)); resetPageScroll() } }, t('common.prev')),
              h('span', null, t('common.pageInfo', {
                from: fmtNum(from, locale), to: fmtNum(to, locale), total: fmtNum(total, locale),
              })),
              h('button', { style: canNext ? css.button : css.buttonDisabled, disabled: !canNext, onClick: () => { setPage((p) => p + 1); resetPageScroll() } }, t('common.next')))
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
      return h('div', { style: { overflowX: 'auto', overflowY: 'clip', scrollbarWidth: 'thin', scrollbarColor: 'var(--dsw-alias-border-l1) transparent' } },
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
              identity: identityFields(),
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
      // 错误态可重试（R9-07）：详情加载失败不该让用户只能关抽屉重开。
      const [reloadTick, setReloadTick] = useState(0)

      // Esc 关闭抽屉（R9-07 第 6 条）：与规则详情同一键盘契约。
      useEffect(() => {
        if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined
        const onKeyDown = (event) => {
          if (event && event.key === 'Escape') onClose()
        }
        document.addEventListener('keydown', onKeyDown)
        return () => document.removeEventListener('keydown', onKeyDown)
      }, [onClose])

      useEffect(() => {
        let alive = true
        setLoaded({ status: 'loading' })
        setSave({ status: 'idle', code: '' })
        callJson(withIdentity('/nodes/' + encodeURIComponent(id))).then((body) => {
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
      }, [id, reloadTick])

      const sendPatch = async (patch) => {
        setSave({ status: 'saving', code: '' })
        try {
          const result = await callJson('/nodes/' + encodeURIComponent(id), {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              patch,
              // 回传读到的版本：Host 用它做 CAS，避免两个面板互相覆盖。
              expectedUpdatedAt: loaded.status === 'ok' && loaded.node ? loaded.node.updated_at : undefined,
              ...(identityFields() || {}),
            }),
          })
          setSave({ status: 'ok', code: '' })
          if (patch.status) setStatus(patch.status)
          // 保存成功后必须把新版本写回详情缓存：否则同抽屉第二次保存/归档仍带旧
          // expectedUpdatedAt，服务端 CAS 必然 409 node_changed。
          if (result && result.updated_at && loaded.status === 'ok' && loaded.node) {
            setLoaded((prev) => prev.status === 'ok'
              ? { ...prev, node: { ...prev.node, ...patch, updated_at: result.updated_at, tags: Array.isArray(patch.tags) ? JSON.stringify(patch.tags) : prev.node.tags } }
              : prev)
          } else {
            setReloadTick((n) => n + 1)
          }
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
      else if (loaded.status === 'error') {
        body = h(StateBlock, {
          t, status: 'error', err: loaded.err,
          onRetry: () => setReloadTick((n) => n + 1),
        })
      }
      else {
        const node = loaded.node || {}
        // superseded 只有在节点已有继任指针时才可选：普通节点选它必触发
        // superseded_by_required（服务端拒绝），属于不可达选项。
        const statusOptions = [
          ['active', statusLabel(t, 'active')],
          ['archived', statusLabel(t, 'archived')],
          ['stale', statusLabel(t, 'stale')],
        ]
        if (node.superseded_by || status === 'superseded') {
          statusOptions.push(['superseded', statusLabel(t, 'superseded')])
        }
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
              options: statusOptions,
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
        h('aside', {
          style: css.drawer,
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': t('detail.title'),
          tabIndex: -1,
          autoFocus: true,
          onClick: (e) => e.stopPropagation(),
          onKeyDown: (event) => trapDialogFocus(event),
        },
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

    // ------------------------------------------------------------------ rules

    // >>> rules:pure
    // 规则页的降级/过滤/diff 纯函数：不引用 t()/css/React，测试直接抽取本块在 node 里跑，
    // 保证契约少字段（R3a 未上线、git 缺字段、history 缺失）时不崩、不出现 NaN/undefined。
    const RULE_CANDIDATE_STATUS = ['candidate', 'proposed', 'proposal', 'pending', 'pending_review']
    const RULE_RETIRED_STATUS = ['retired', 'merged', 'superseded', 'archived', 'deprecated', 'retracted', 'dead']

    /** git 三态归一：可用=绿；未安装=黄；可用但 error=损坏（红）；字段缺失=未知。 */
    function rulesGitState(git) {
      const g = git && typeof git === 'object' ? git : null
      if (!g) {
        return { tone: 'unknown', installed: null, broken: false, version: null, required: false, checkedAt: null, error: null }
      }
      const available = g.available === true
      const error = typeof g.error === 'string' && g.error.trim() ? g.error.trim() : null
      const rawVersion = g.version
      const version = rawVersion === null || rawVersion === undefined || rawVersion === '' ? null : String(rawVersion)
      return {
        tone: available ? (error ? 'error' : 'ok') : 'warn',
        installed: available,
        broken: Boolean(available && error),
        version,
        required: g.required === true,
        checkedAt: g.checkedAt === undefined ? null : g.checkedAt,
        error,
      }
    }

    /** 规则语义桶：退役/候选按 status 优先，铁律按 type（或 iron 布尔）识别。 */
    function ruleBucketOf(rule) {
      const r = rule && typeof rule === 'object' ? rule : {}
      const status = String(r.status || '').trim().toLowerCase()
      if (RULE_RETIRED_STATUS.includes(status)) return 'retired'
      if (RULE_CANDIDATE_STATUS.includes(status)) return 'candidate'
      const type = String(r.type || '').trim().toLowerCase()
      if (r.iron === true || type.includes('iron') || type.includes('铁律') || type === 'hard') return 'iron'
      return 'normal'
    }

    /** 本地过滤：先按语义桶，再按 key/编号/标题/摘要/正文子串（大小写不敏感）。 */
    function filterRuleList(rules, filter, query) {
      const list = Array.isArray(rules) ? rules.filter((rule) => rule && typeof rule === 'object') : []
      const bucket = ['iron', 'normal', 'candidate', 'retired'].includes(filter) ? filter : 'all'
      const q = String(query || '').trim().toLowerCase()
      return list.filter((rule) => {
        if (bucket !== 'all' && ruleBucketOf(rule) !== bucket) return false
        if (!q) return true
        const hay = [rule.key, rule.number, rule.title, rule.excerpt, rule.text]
          .filter((value) => value !== null && value !== undefined)
          .map((value) => String(value)).join(' ').toLowerCase()
        return hay.includes(q)
      })
    }

    /** 长路径省略（作用域列）：保留头尾，完整值放 title 属性。 */
    function shortPath(value, max) {
      const s = String(value === null || value === undefined ? '' : value)
      const limit = Number.isFinite(Number(max)) && Number(max) > 8 ? Number(max) : 32
      if (!s || s.length <= limit) return s
      const head = Math.ceil((limit - 3) / 2)
      const tail = Math.floor((limit - 3) / 2)
      return s.slice(0, head) + '…' + s.slice(s.length - tail)
    }

    /** 列表摘要：优先 excerpt，其次标题/正文；压平空白并截断。 */
    function ruleSummary(rule, max) {
      const r = rule && typeof rule === 'object' ? rule : {}
      const picked = [r.excerpt, r.title, r.text].find((value) => typeof value === 'string' && value.trim())
      const text = String(picked || '').replace(/\s+/g, ' ').trim()
      const limit = Number.isFinite(Number(max)) ? Math.max(8, Number(max)) : 60
      return text.length > limit ? text.slice(0, limit) + '…' : text
    }

    /** 条件/例外条目统一成文本：字符串直出；对象取常见正文字段，兜底 JSON。 */
    function ruleFieldText(value) {
      if (value === null || value === undefined) return ''
      if (typeof value === 'string') return value
      if (typeof value === 'number' || typeof value === 'boolean') return String(value)
      if (Array.isArray(value)) return value.map(ruleFieldText).filter(Boolean).join(' / ')
      if (typeof value === 'object') {
        for (const key of ['text', 'condition', 'description', 'desc', 'pattern', 'statement', 'name', 'rule']) {
          const picked = value[key]
          if (typeof picked === 'string' && picked.trim()) return picked
        }
        try {
          return JSON.stringify(value)
        } catch {
          return ''
        }
      }
      return String(value)
    }

    /** 逐行 LCS diff：旧版本=del（-），新文本=add（+），两边都有=same；上限 400 行防卡顿。 */
    function lineDiff(oldText, newText) {
      const a = String(oldText === null || oldText === undefined ? '' : oldText).split(/\r?\n/)
      const b = String(newText === null || newText === undefined ? '' : newText).split(/\r?\n/)
      const rows = []
      const m = a.length
      const n = b.length
      if (m > 400 || n > 400) {
        for (const line of a) rows.push({ kind: 'del', text: line })
        for (const line of b) rows.push({ kind: 'add', text: line })
        return rows
      }
      const table = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1))
      for (let i = m - 1; i >= 0; i -= 1) {
        for (let j = n - 1; j >= 0; j -= 1) {
          table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
        }
      }
      let i = 0
      let j = 0
      while (i < m && j < n) {
        if (a[i] === b[j]) {
          rows.push({ kind: 'same', text: a[i] })
          i += 1
          j += 1
        } else if (table[i + 1][j] >= table[i][j + 1]) {
          rows.push({ kind: 'del', text: a[i] })
          i += 1
        } else {
          rows.push({ kind: 'add', text: b[j] })
          j += 1
        }
      }
      while (i < m) {
        rows.push({ kind: 'del', text: a[i] })
        i += 1
      }
      while (j < n) {
        rows.push({ kind: 'add', text: b[j] })
        j += 1
      }
      return rows
    }
    // ---- 提案（/rules/proposals）纯函数：列表渲染/风险判断/正文合成的唯一口径 ----

    /** 关系/状态枚举：服务端契约的白名单，缺字段一律归到中性值而非 undefined。 */
    const PROPOSAL_RELATIONS = ['new', 'duplicate', 'refine', 'merge', 'conflict', 'unrelated']
    const PROPOSAL_STATUSES = ['pending', 'needs_manual', 'accepted', 'rejected', 'expired']
    const PROPOSAL_RELATION_KEYS = {
      new: 'rules.relNew',
      duplicate: 'rules.relDuplicate',
      refine: 'rules.relRefine',
      merge: 'rules.relMerge',
      conflict: 'rules.relConflict',
      unrelated: 'rules.relUnrelated',
    }
    const PROPOSAL_STATUS_KEYS = {
      pending: 'rules.proposalStatusPending',
      needs_manual: 'rules.proposalStatusNeedsManual',
      accepted: 'rules.proposalStatusAccepted',
      rejected: 'rules.proposalStatusRejected',
      expired: 'rules.proposalStatusExpired',
    }

    /** 关系归一：未知/缺失=unrelated（中性徽标），保证徽标不出现空字。 */
    function proposalRelationOf(item) {
      const raw = String((item && item.relation) || '').trim().toLowerCase()
      return PROPOSAL_RELATIONS.includes(raw) ? raw : 'unrelated'
    }

    /** 状态归一：proposed/proposal/candidate 等历史写法都收敛到 pending。 */
    function proposalStatusOf(item) {
      const raw = String((item && item.status) || '').trim().toLowerCase()
      if (PROPOSAL_STATUSES.includes(raw)) return raw
      return 'pending'
    }

    /** 关系色调：冲突=红、合并=黄、新增/细化=品牌色，重复/无关=灰。 */
    function proposalRelationTone(value) {
      const relation = proposalRelationOf({ relation: value })
      if (relation === 'conflict') return 'error'
      if (relation === 'merge' || relation === 'duplicate') return 'warn'
      if (relation === 'new' || relation === 'refine') return 'brand'
      return 'muted'
    }

    /** 提案状态色调：只有 accepted=绿，其它都走灰/黄，红只留给风险条。 */
    function proposalStatusTone(value) {
      const status = proposalStatusOf({ status: value })
      if (status === 'accepted') return 'ok'
      if (status === 'expired' || status === 'rejected') return 'muted'
      return 'warn'
    }

    /** 受影响旧规则归一：新旧正文缺失给空串，字符串形态的保留/丢弃包成数组。 */
    function proposalAffectedOf(item) {
      const list = item && Array.isArray(item.affected) ? item.affected : []
      return list.filter((row) => row && typeof row === 'object').map((row) => {
        const oldText = typeof row.oldText === 'string' ? row.oldText : ''
        const newText = typeof row.newText === 'string' ? row.newText : ''
        return {
          key: row.key === null || row.key === undefined ? null : String(row.key),
          number: Number.isFinite(Number(row.number)) ? Number(row.number) : null,
          oldText,
          newText,
          preserved: Array.isArray(row.preserved) ? row.preserved : (row.preserved == null ? [] : [row.preserved]),
          dropped: Array.isArray(row.dropped) ? row.dropped : (row.dropped == null ? [] : [row.dropped]),
          changed: row.changed === true || oldText !== newText,
        }
      })
    }

    /** 候选归一：正文缺失时退到受影响规则的新正文，再退到来源片段。 */
    function proposalCandidateOf(item) {
      const c = (item && item.candidate) || {}
      const affected = proposalAffectedOf(item)
      const source = (item && item.source) || {}
      const text = [c.text, affected[0] && affected[0].newText, source.text]
        .find((value) => typeof value === 'string' && value.trim()) || ''
      return {
        text: String(text),
        key: c.key === null || c.key === undefined ? null : String(c.key),
        type: c.type === null || c.type === undefined ? null : String(c.type),
        number: Number.isFinite(Number(c.number)) ? Number(c.number) : null,
        // 服务端优先级是 'P0'..'P3' 字符串；不转 Number（Number('P0')=NaN 会显示成 —）。
        priority: c.priority === null || c.priority === undefined ? null : String(c.priority),
        scope: c.scope === null || c.scope === undefined ? null : String(c.scope),
        role: c.role === null || c.role === undefined ? null : String(c.role),
        modality: c.modality === null || c.modality === undefined ? null : String(c.modality),
        conditions: Array.isArray(c.conditions) ? c.conditions : [],
        exceptions: Array.isArray(c.exceptions) ? c.exceptions : [],
        chars: Number.isFinite(Number(c.chars)) ? Number(c.chars) : String(text).length,
      }
    }

    /** 守卫归一：guard 缺失视为通过（旧载荷没有守卫），失败项保留 code/key/detail。 */
    function proposalGuardOf(item) {
      const raw = item && item.guard
      const failures = raw && Array.isArray(raw.failures)
        ? raw.failures.filter((failure) => failure && typeof failure === 'object').map((failure) => ({
          code: failure.code === null || failure.code === undefined ? '' : String(failure.code),
          key: failure.key === null || failure.key === undefined ? '' : String(failure.key),
          detail: ruleFieldText(failure.detail),
        }))
        : []
      return { ok: !(raw && raw.ok === false) && failures.length === 0, failures }
    }

    /**
     * needs_manual 候选归一：只有 status=needs_manual 才有值；code/failures 一律给可渲染的字符串。
     * Why 单独抽：面板必须把「为什么失败、失败码是什么」直接摆在候选卡上，并提示改写后重试。
     */
    function proposalNeedsManualOf(item) {
      if (proposalStatusOf(item) !== 'needs_manual') return null
      const raw = item && item.needsManual && typeof item.needsManual === 'object' ? item.needsManual : {}
      return {
        code: String(raw.code || 'needs_manual'),
        failures: proposalGuardOf(item).failures,
        detail: ruleFieldText(raw.detail).trim(),
      }
    }

    /** 被丢弃子句归一：扁平成 [{key, number, text}]，供风险条逐条列出。 */
    function proposalDroppedOf(item) {
      const rows = []
      for (const row of proposalAffectedOf(item)) {
        for (const clause of row.dropped) {
          const text = ruleFieldText(clause).trim()
          if (text) rows.push({ key: row.key, number: row.number, text })
        }
      }
      return rows
    }

    /**
     * 风险判定：守卫未过或有子句被丢弃即高风险，提交前必须勾选 acknowledgeDropped；
     * 冲突/合并只是把风险放大（提示语更重），不改变判定口径。
     */
    function proposalRiskOf(item) {
      const guard = proposalGuardOf(item)
      const dropped = proposalDroppedOf(item)
      const relation = proposalRelationOf(item)
      const risky = !guard.ok || dropped.length > 0
      return {
        relation,
        risky,
        // 只有「有子句被丢弃」才需要勾选确认；守卫失败要改正文，勾选放行是假通道（R9-14）。
        requiresAck: dropped.length > 0,
        guardFailed: !guard.ok,
        guardFailures: guard.failures,
        dropped,
        reasons: [!guard.ok ? 'guard' : null, dropped.length > 0 ? 'dropped' : null].filter(Boolean),
      }
    }

    /** 正文预览：压平空白、≤200 字截断并给 truncated 标记（展开/收起用同一口径）。 */
    function proposalPreview(value, max) {
      const text = String(value === null || value === undefined ? '' : value).replace(/\s+/g, ' ').trim()
      const limit = Number.isFinite(Number(max)) ? Math.max(20, Number(max)) : 200
      return {
        text,
        length: text.length,
        truncated: text.length > limit,
        preview: text.length > limit ? text.slice(0, limit) + '…' : text,
      }
    }

    /** 条件/例外统一成干净行；对象条目取正文，丢弃空行。 */
    function clauseLines(value) {
      const list = Array.isArray(value) ? value : (value === null || value === undefined || value === '' ? [] : [value])
      return list.map((entry) => ruleFieldText(entry).trim()).filter(Boolean)
    }

    /**
     * 改写提交正文：正文 + 条件/例外/作用域（服务端 decisions.text 只吃单条正文，
     * 所以结构化字段在这里落成稳定文本块，不丢用户改动）。
     */
    function composeProposalText(input) {
      const i = input && typeof input === 'object' ? input : {}
      const body = String(i.text === null || i.text === undefined ? '' : i.text).trim()
      const conditions = clauseLines(i.conditions)
      const exceptions = clauseLines(i.exceptions)
      const scope = String(i.scope === null || i.scope === undefined ? '' : i.scope).trim()
      const lines = body ? [body] : []
      if (conditions.length > 0) lines.push('', '条件：', ...conditions.map((line) => '- ' + line))
      if (exceptions.length > 0) lines.push('', '例外：', ...exceptions.map((line) => '- ' + line))
      if (scope) lines.push('', '作用域：' + scope)
      return lines.join('\n').trim()
    }

    /**
     * 丢弃子句 → `acknowledgeDropped` 契约形状（R9-14）：`[{key, clauses:[...]}]`。
     *
     * 为什么不发裸 key/布尔：key 粒度一次放行整条规则的全部条款，等于把安全确认做成橡皮章。
     */
    function proposalAckPayload(rows) {
      const byKey = new Map()
      for (const row of Array.isArray(rows) ? rows : []) {
        const key = String((row && row.key) || '').trim()
        const clause = String((row && row.text) || '').trim()
        if (!key || !clause) continue
        const list = byKey.get(key) || []
        if (!list.includes(clause)) list.push(clause)
        byKey.set(key, list)
      }
      return [...byKey.entries()].map(([key, clauses]) => ({ key, clauses }))
    }

    /** decisions 载荷：只带契约允许的字段，空正文不传（收录走候选原文）。 */
    function proposalDecisionsFor(input) {
      const i = input && typeof input === 'object' ? input : {}
      const decisions = {}
      const text = typeof i.text === 'string' ? i.text.trim() : ''
      if (text) decisions.text = text
      if (i.acknowledgeDropped === true) {
        const acknowledged = proposalAckPayload(i.dropped)
        if (acknowledged.length > 0) decisions.acknowledgeDropped = acknowledged
      }
      if (Array.isArray(i.acceptAffected) && i.acceptAffected.length > 0) {
        decisions.acceptAffected = i.acceptAffected.map((key) => String(key))
      }
      return decisions
    }

    // ---------------------------------------------------------- rules:edit（R5）

    /** 正文硬顶：与服务端 RULE_BODY_MAX 同值；计数按码点（ruleTextChars）。 */
    const RULE_BODY_MAX = 500
    /** 优先级下拉候选：契约 P0–P3；已有值不在表内时追加（不替用户改写未知优先级）。 */
    const RULE_PRIORITY_OPTIONS = ['P0', 'P1', 'P2', 'P3']
    /** 编辑补丁字段 → 文案键；服务端 patch 字段与这六个一一对应，未知字段原样显示。 */
    const RULE_EDIT_FIELD_KEYS = {
      text: 'rules.editPreviewFieldText',
      conditions: 'rules.editPreviewFieldConditions',
      exceptions: 'rules.editPreviewFieldExceptions',
      scope: 'rules.editPreviewFieldScope',
      priority: 'rules.editPreviewFieldPriority',
      status: 'rules.editPreviewFieldStatus',
    }

    /**
     * 正文计数：按 Unicode 码点（与服务端 charsOf 同口径），避免 emoji/中文被算成两个字符。
     * @param {unknown} value @returns {number}
     */
    function ruleTextChars(value) {
      return Array.from(String(value === null || value === undefined ? '' : value)).length
    }

    /**
     * 多行输入解析：每行一条条件/例外；空行丢弃、首尾空白裁掉
     * （服务端只接受「非空字符串数组」，空项会被 validateRule 判 invalid_conditions）。
     * @param {unknown} value 数组或多行文本
     * @returns {string[]}
     */
    function ruleLinesFromInput(value) {
      const chunks = Array.isArray(value)
        ? value.map((item) => ruleFieldText(item))
        : [String(value === null || value === undefined ? '' : value)]
      const lines = []
      for (const chunk of chunks) {
        for (const line of String(chunk).split(/\r?\n/)) {
          const text = line.trim()
          if (text) lines.push(text)
        }
      }
      return lines
    }

    /**
     * 作用域拆分：服务端只认 `global | workspace:<绝对路径> | role:<id>`；
     * 未知写法落到 custom 并保留原值——编辑不能把不认识的 scope 静默改成 global。
     * @param {unknown} scope @returns {{kind:'global'|'workspace'|'role'|'custom',value:string}}
     */
    function ruleScopeParts(scope) {
      const raw = String(scope === null || scope === undefined ? '' : scope).trim()
      if (!raw || raw === 'global') return { kind: 'global', value: '' }
      if (raw.startsWith('workspace:')) return { kind: 'workspace', value: raw.slice('workspace:'.length).trim() }
      if (raw.startsWith('role:')) return { kind: 'role', value: raw.slice('role:'.length).trim() }
      return { kind: 'custom', value: raw }
    }

    /** 作用域合成：与 ruleScopeParts 互逆；custom 原样回写，global 忽略值。 */
    function ruleScopeValue(kind, value) {
      const text = String(value === null || value === undefined ? '' : value).trim()
      if (kind === 'workspace') return 'workspace:' + text
      if (kind === 'role') return 'role:' + text
      if (kind === 'custom') return text
      return 'global'
    }

    /**
     * 作用域本地校验（与服务端 scopeError 同口径）：提交前先挡住，别让用户等一次 400。
     * @param {string} kind @param {string} value
     * @returns {string|null} 错误码；null=合法
     */
    function ruleScopeProblem(kind, value) {
      const text = String(value === null || value === undefined ? '' : value).trim()
      if (kind === 'workspace') {
        if (!text) return 'scope_workspace_empty'
        if (!(text.startsWith('/') || /^[A-Za-z]:[\\/]/.test(text))) return 'scope_workspace_relative'
        return null
      }
      if (kind === 'role') {
        if (!text || /\s/.test(text) || text.length > 64) return 'scope_role_invalid'
        return null
      }
      if (kind === 'custom') return text ? null : 'scope_invalid'
      return null
    }

    /** 优先级选项：P0–P3；已有值不在表内时追加，保证下拉不改写未知优先级。 */
    function rulePriorityOptions(current) {
      const text = String(current === null || current === undefined ? '' : current).trim().toUpperCase()
      return RULE_PRIORITY_OPTIONS.includes(text) || !text
        ? RULE_PRIORITY_OPTIONS.slice()
        : RULE_PRIORITY_OPTIONS.concat([text])
    }

    /** 默认铁律判定：安装自带规则的 front.origin 以 `default:` 开头（可改/停/删，编号保留）。 */
    function ruleOriginIsDefault(origin) {
      const text = typeof origin === 'string' ? origin.trim() : ruleFieldText(origin).trim()
      return text.startsWith('default:')
    }

    /** 规则对象是否安装自带默认铁律；缺 origin 一律按普通规则，避免旧载荷被误标「默认」。 */
    function ruleIsDefault(rule) {
      const r = rule && typeof rule === 'object' ? rule : {}
      return ruleOriginIsDefault(r.origin)
    }

    /** 状态切换方向：retired→reactivate，其余按 retire（面板只对 active/retired 放行）。 */
    function ruleRetireMode(status) {
      return String(status === null || status === undefined ? '' : status).trim().toLowerCase() === 'retired'
        ? 'reactivate'
        : 'retire'
    }

    /** 只有 active/retired 可切换；merged/superseded 由合并链路管理，面板不得改写。 */
    function ruleCanToggleStatus(status) {
      const text = String(status === null || status === undefined ? '' : status).trim().toLowerCase()
      return text === 'active' || text === 'retired'
    }

    /** 新建类型白名单：服务端 RULE_TYPES 的可建子集；铁律自动编号、普通规则也自动编号。 */
    const RULE_NEW_TYPES = ['iron-rule', 'rule']

    /**
     * 新建草稿本地校验：正文非空/≤500、类型/优先级合法、作用域合法。
     * Why 先挡一次：这些错服务端会以 invalid_draft/invalid_rule 返回 400，小白看不出该改哪。
     * @param {object} draft @returns {string|null} body_empty|body_too_long|type_invalid|priority_invalid|scope_*
     */
    function newRuleDraftProblem(draft) {
      const d = draft && typeof draft === 'object' ? draft : {}
      // 与提交载荷同口径：先 trim 再计数，避免「只输空格」被判成合法正文。
      const text = String(d.text === null || d.text === undefined ? '' : d.text).trim()
      const chars = ruleTextChars(text)
      if (chars === 0) return 'body_empty'
      if (chars > RULE_BODY_MAX) return 'body_too_long'
      const type = String(d.type === null || d.type === undefined ? 'rule' : d.type).trim()
      if (!RULE_NEW_TYPES.includes(type)) return 'type_invalid'
      const priority = String(d.priority === null || d.priority === undefined ? 'P1' : d.priority).trim().toUpperCase()
      if (!RULE_PRIORITY_OPTIONS.includes(priority)) return 'priority_invalid'
      const scopeProblem = ruleScopeProblem(d.scopeKind || 'global', d.scopeValue)
      if (scopeProblem) return scopeProblem
      return null
    }

    /**
     * 新建草稿归一：与 POST /rules/create 的 {draft:{...}} 契约逐字段对齐。
     * Why 只带契约字段：多带未知字段会被 validateRule 判 unknown_field；空字符串表示「留空自动抽」。
     * @param {object} draft
     * @returns {{text:string,type:string,priority:string,scope:string,role:string,
     *   conditions:string[],exceptions:string[],action:string,object:string}}
     */
    function newRuleDraftPayload(draft) {
      const d = draft && typeof draft === 'object' ? draft : {}
      const scopeKind = d.scopeKind === 'workspace' || d.scopeKind === 'role' ? d.scopeKind : 'global'
      const scopeValue = String(d.scopeValue === null || d.scopeValue === undefined ? '' : d.scopeValue).trim()
      const type = String(d.type === null || d.type === undefined ? 'rule' : d.type).trim()
      const priority = String(d.priority === null || d.priority === undefined ? 'P1' : d.priority).trim().toUpperCase()
      return {
        text: String(d.text === null || d.text === undefined ? '' : d.text).trim(),
        type: RULE_NEW_TYPES.includes(type) ? type : 'rule',
        priority: RULE_PRIORITY_OPTIONS.includes(priority) ? priority : 'P1',
        scope: ruleScopeValue(scopeKind, scopeValue),
        role: scopeKind === 'role' ? scopeValue : '',
        conditions: ruleLinesFromInput(d.conditions),
        exceptions: ruleLinesFromInput(d.exceptions),
        action: String(d.action === null || d.action === undefined ? '' : d.action).trim(),
        object: String(d.object === null || d.object === undefined ? '' : d.object).trim(),
      }
    }

    /** 全部停用判定：列表非空且每条 status 都是 retired；空态据此换「去已退役筛选找回」文案。
     * Why 只看 status 而不复用 bucket：merged/superseded 不能重新启用，混进提示会误导用户。 */
    function rulesAllRetired(rules) {
      const list = Array.isArray(rules) ? rules.filter((rule) => rule && typeof rule === 'object') : []
      return list.length > 0 && list.every((rule) => String(rule.status === null || rule.status === undefined
        ? '' : rule.status).trim().toLowerCase() === 'retired')
    }

    /**
     * 编辑补丁：只带真正变化的字段 —— 服务端按「有改动才 commit」，空字段覆盖会把
     * 结构化字段清掉；字符串与行数组各自归一后比较，避免 `\r\n`/空行算成改动。
     * @param {object} rule 当前规则（详情载荷 rule）
     * @param {{text?:string,conditions?:string[]|string,exceptions?:string[]|string,scope?:string,priority?:string,status?:string}} draft
     * @returns {{patch:object,fields:string[]}} fields=发生变化的服务端字段名
     */
    function ruleEditPatch(rule, draft) {
      const base = rule && typeof rule === 'object' ? rule : {}
      const d = draft && typeof draft === 'object' ? draft : {}
      const patch = {}
      const fields = []
      const put = (field, value) => { patch[field] = value; fields.push(field) }
      const nextText = String(d.text === null || d.text === undefined ? '' : d.text).trim()
      if (nextText !== String(base.text === null || base.text === undefined ? '' : base.text).trim()) {
        put('text', nextText)
      }
      const nextConditions = ruleLinesFromInput(d.conditions)
      if (nextConditions.join('\n') !== ruleLinesFromInput(base.conditions).join('\n')) {
        put('conditions', nextConditions)
      }
      const nextExceptions = ruleLinesFromInput(d.exceptions)
      if (nextExceptions.join('\n') !== ruleLinesFromInput(base.exceptions).join('\n')) {
        put('exceptions', nextExceptions)
      }
      const baseScope = String(base.scope === null || base.scope === undefined ? '' : base.scope).trim() || 'global'
      const nextScope = String(d.scope === null || d.scope === undefined ? '' : d.scope).trim() || 'global'
      if (nextScope !== baseScope) put('scope', nextScope)
      const basePriority = String(base.priority === null || base.priority === undefined ? '' : base.priority).trim().toUpperCase()
      const nextPriority = String(d.priority === null || d.priority === undefined ? '' : d.priority).trim().toUpperCase()
      if (nextPriority && nextPriority !== basePriority) put('priority', nextPriority)
      const baseStatus = String(base.status === null || base.status === undefined ? '' : base.status).trim()
      const nextStatus = String(d.status === null || d.status === undefined ? '' : d.status).trim()
      if (nextStatus && nextStatus !== baseStatus) put('status', nextStatus)
      return { patch, fields }
    }

    /**
     * 当前版本 rev：先按详情 `version` 与历史项 `version` 对齐（契约可选新增字段），
     * 没有版本号时退到「历史正文与当前正文完全一致」；都对不上返回 null——宁可标不出
     * 「当前」，也不能把任意一条历史谎标成当前版本。
     * @param {object} rule @param {Array<object>} history
     * @returns {string|null}
     */
    function ruleCurrentRev(rule, history) {
      const list = (Array.isArray(history) ? history : []).filter((item) => item && typeof item === 'object')
      if (list.length === 0) return null
      const version = rule && rule.version
      if (version !== undefined && version !== null && version !== '') {
        const hit = list.find((item) => item.version !== undefined && item.version !== null
          && String(item.version) === String(version))
        if (hit && hit.rev !== undefined && hit.rev !== null) return String(hit.rev)
      }
      const text = String((rule && rule.text) || '')
      const same = list.find((item) => String(item.text === null || item.text === undefined ? '' : item.text) === text)
      return same && same.rev !== undefined && same.rev !== null ? String(same.rev) : null
    }

    /**
     * 服务端 diff 归一：`diff:[{type:'same'|'add'|'del',text}]` → 本地同构 `{kind,text}`；
     * 形状不对返回 null，让调用方退回 lineDiff（服务端 R5 未上线时面板仍可用）。
     * @param {object} body @returns {Array<{kind:string,text:string}>|null}
     */
    function ruleDiffRowsFromServer(body) {
      const rows = body && body.diff
      if (!Array.isArray(rows)) return null
      return rows.map((row) => {
        const source = row && typeof row === 'object' ? row : {}
        const type = String(source.type || source.kind || '').toLowerCase()
        const kind = type === 'add' || type === '+'
          ? 'add'
          : type === 'del' || type === 'delete' || type === '-' ? 'del' : 'same'
        return { kind, text: String(source.text === null || source.text === undefined ? '' : source.text) }
      })
    }

    /**
     * 后端 detail 文案：invalid_rule 的 detail 可能是字符串、`{errors:[{code,field,message}]}`
     * 或单条错误对象；统一压成一行，把字段名/原因直接给用户看，不吞服务端信息。
     * @param {unknown} detail @returns {string}
     */
    function ruleErrorDetailText(detail) {
      if (detail === null || detail === undefined) return ''
      if (typeof detail === 'string') return detail.trim().slice(0, 400)
      if (typeof detail === 'number' || typeof detail === 'boolean') return String(detail)
      if (Array.isArray(detail)) {
        return detail.map((item) => ruleErrorDetailText(item)).filter(Boolean).join(' · ').slice(0, 400)
      }
      if (typeof detail === 'object') {
        if (Array.isArray(detail.errors)) {
          return detail.errors.map((item) => ruleErrorDetailText(item)).filter(Boolean).join(' · ').slice(0, 400)
        }
        if (Array.isArray(detail.fields)) {
          return detail.fields.map((field) => String(field)).filter(Boolean).join(', ').slice(0, 400)
        }
        const field = detail.field === undefined || detail.field === null ? '' : String(detail.field)
        const message = [detail.message, detail.reason, detail.detail, detail.error, detail.code]
          .find((value) => typeof value === 'string' && value.trim())
        const parts = [field, message ? String(message).trim() : ''].filter(Boolean)
        if (parts.length > 0) return parts.join(': ').slice(0, 400)
        return Object.keys(detail).join(', ').slice(0, 200)
      }
      return String(detail).slice(0, 400)
    }

    /** 编辑预览的字段名：未知字段原样显示（不隐藏服务端新增的 patch 字段）。 */
    function ruleEditFieldLabel(t, field) {
      const key = RULE_EDIT_FIELD_KEYS[String(field || '')]
      return key ? t(key) : String(field || '')
    }
    /** 规则是否已停用（列表徽标/详情按钮共用；只认 retired，merged/superseded 不动）。 */
    function ruleIsRetired(rule) {
      const r = rule && typeof rule === 'object' ? rule : {}
      return String(r.status === null || r.status === undefined ? '' : r.status).trim().toLowerCase() === 'retired'
    }

    /**
     * 详情历史合并：`/rules/versions`（快照 + 触及该文件的 git 提交）为骨架，
     * 再用详情 `history` 补正文（本地 diff 兜底要用 text）。
     * Why 以 versions 为准：git 提交只有 versions 有，历史条目只有 detail 有正文；
     * 两者按 rev 去重，任一接口缺失都退回另一条时间线，面板不空。
     * @param {Array<object>} history @param {Array<object>} versions
     * @returns {Array<{rev:string,version:any,ts:any,source:string,text:string,commit:string,subject:string,kind:string}>}
     */
    function mergeRuleVersions(history, versions) {
      const detail = (Array.isArray(history) ? history : []).filter((item) => item && typeof item === 'object')
      const list = (Array.isArray(versions) ? versions : []).filter((item) => item && typeof item === 'object')
      const out = []
      const seen = new Set()
      const push = (entry) => {
        const rev = entry && entry.rev !== undefined && entry.rev !== null ? String(entry.rev) : ''
        if (!rev || seen.has(rev)) return
        seen.add(rev)
        out.push(entry)
      }
      for (const item of list) {
        // current 是「当前版本」占位（rev 空），由详情正文承担，不进历史列表。
        if (String(item.kind || '') === 'current') continue
        const rev = item.rev === undefined || item.rev === null ? '' : String(item.rev)
        if (!rev) continue
        const hit = detail.find((row) => String(row.rev) === rev)
        push({
          rev,
          version: item.version === undefined || item.version === null ? (hit ? hit.version : null) : item.version,
          ts: item.ts === undefined || item.ts === null || item.ts === '' ? (hit ? hit.ts : item.ts) : item.ts,
          source: String(item.source || (hit && hit.source) || 'snapshot'),
          text: String((hit && hit.text) || ''),
          commit: String(item.commit || ''),
          subject: String(item.subject || ''),
          kind: String(item.kind || 'history'),
        })
      }
      for (const item of detail) push({ ...item, rev: String(item.rev), source: String(item.source || 'snapshot') })
      return out
    }
    // <<< rules:pure

    /** 状态键：服务端状态值本地化；未知值原样显示，不吞字段。 */
    const RULE_STATUS_KEYS = {
      active: 'rules.statusActive',
      candidate: 'rules.statusCandidate',
      retired: 'rules.statusRetired',
      merged: 'rules.statusMerged',
      superseded: 'rules.statusSuperseded',
      draft: 'rules.statusDraft',
      proposed: 'rules.statusProposed',
      proposal: 'rules.statusProposed',
    }

    /** 状态语义分桶：只有生效=绿、候选=黄，退役/未知=灰（红留给 git 损坏）。 */
    function ruleStatusTone(value) {
      const key = String(value || '').trim().toLowerCase()
      if (key === 'active' || key === 'enabled' || key === 'in_effect') return 'ok'
      if (RULE_CANDIDATE_STATUS.includes(key) || key === 'draft') return 'warn'
      return 'muted'
    }

    function ruleStatusLabel(t, value) {
      const key = RULE_STATUS_KEYS[String(value || '').trim().toLowerCase()]
      return key ? t(key) : (value || '—')
    }

    function ruleTypeLabel(t, value) {
      const key = String(value || '').trim().toLowerCase()
      if (key === 'rule-candidate' || key.includes('candidate')) return t('rules.typeCandidate')
      if (key.includes('iron') || key.includes('铁律') || key === 'hard') return t('rules.typeIron')
      if (key === 'normal' || key === 'rule' || key === 'general' || key === '') return t('rules.typeNormal')
      return value || '—'
    }

    /** 复制目录路径：只走 Clipboard API（DSH 页面是安全上下文）；失败给明确文案。 */
    function copyToClipboard(value) {
      const text = String(value || '')
      if (!text) return Promise.reject(new Error('empty'))
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard
          && typeof navigator.clipboard.writeText === 'function') {
          return navigator.clipboard.writeText(text)
        }
      } catch {
        return Promise.reject(new Error('clipboard_unavailable'))
      }
      return Promise.reject(new Error('clipboard_unavailable'))
    }

    /**
     * 规则页：顶部 git 状态条 + 待确认区 + 工具行 + 列表；详情走抽屉。
     * 边界：写操作只发 POST 并在前端二次确认；回滚/编辑在 R3b 前只读（disabled + 说明）。
     */
    function RulesView(props) {
      const { t, locale, version, onScrollReset } = props
      const [list, setList] = useState({ status: 'loading' })
      const [reloadTick, setReloadTick] = useState(0)
      const [filter, setFilter] = useState('all')
      const [query, setQuery] = useState('')
      const [detailKey, setDetailKey] = useState(null)
      const [newOpen, setNewOpen] = useState(false)
      const [guideOpen, setGuideOpen] = useState(false)
      const [copyState, setCopyState] = useState('idle')
      const [gitBusy, setGitBusy] = useState(false)
      const [op, setOp] = useState({ status: 'idle', kind: '', code: '', count: null })
      const [proposals, setProposals] = useState({ status: 'loading', items: [] })
      const proposalsRef = useRef(null)

      useEffect(() => {
        let alive = true
        setList((prev) => ({ ...prev, status: 'loading' }))
        callJson('/rules').then((body) => {
          if (!alive) return
          setList({
            status: 'ok',
            dir: typeof (body && body.dir) === 'string' ? body.dir : '',
            git: (body && body.git) || null,
            rules: Array.isArray(body && body.rules) ? body.rules : [],
            // 能力探测：恢复默认/plan 未上线时按钮必须隐藏，而不是点了报 501。
            capabilities: body && body.capabilities && typeof body.capabilities === 'object'
              ? body.capabilities
              : {},
          })
        }).catch((err) => {
          if (alive) setList({ status: 'error', err })
        })
        return () => { alive = false }
      }, [reloadTick, version])

      useEffect(() => {
        let alive = true
        setProposals((prev) => ({ ...prev, status: 'loading' }))
        // 404＝契约未上线（并行开发的旧服务端）：软降级空态；其它失败给卡片内错误态与重试，不吞网络故障。
        callJson('/rules/proposals?status=pending,needs_manual').then((body) => {
          if (!alive) return
          const items = Array.isArray(body && body.items)
            ? body.items
            : Array.isArray(body && body.proposals) ? body.proposals : []
          setProposals({ status: 'ok', items })
        }).catch((err) => {
          if (!alive) return
          if (err && (err.code === 'not_found' || err.status === 404)) setProposals({ status: 'empty', items: [] })
          else setProposals({ status: 'error', items: [], err })
        })
        return () => { alive = false }
      }, [reloadTick, version])

      const rerun = () => setReloadTick((v) => v + 1)
      /** 筛选/搜索变了就回页顶：结果集换了还停在旧位置，用户会以为列表没刷新。 */
      const resetPageScroll = () => { if (typeof onScrollReset === 'function') onScrollReset() }

      const refreshGit = async () => {
        setGitBusy(true)
        try {
          const body = await callJson('/rules/git-status')
          const nextGit = (body && body.git) || null
          setList((prev) => ({ ...prev, git: nextGit || prev.git }))
        } catch (err) {
          setOp({ status: 'error', kind: 'git', code: (err && err.code) || 'unknown_error', count: null })
        } finally {
          setGitBusy(false)
        }
      }

      const rebuildMirror = async () => {
        if (!askConfirm(t('rules.rebuildConfirm'))) return
        setOp({ status: 'busy', kind: 'rebuild', code: '', count: null })
        try {
          await callJson('/rules/rebuild-mirror', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
          })
          setOp({ status: 'ok', kind: 'rebuild', code: '', count: null })
          setReloadTick((v) => v + 1)
        } catch (err) {
          setOp({ status: 'error', kind: 'rebuild', code: (err && err.code) || 'unknown_error', count: null })
        }
      }

      const importLegacy = async () => {
        if (!askConfirm(t('rules.importConfirm'))) return
        setOp({ status: 'busy', kind: 'import', code: '', count: null })
        try {
          const body = await callJson('/rules/import-legacy', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
          })
          const raw = body && (body.imported ?? body.added ?? body.count)
          const count = Number.isFinite(Number(raw)) ? Number(raw) : null
          setOp({ status: 'ok', kind: 'import', code: '', count, skipped: body && body.skipped === true })
          setReloadTick((v) => v + 1)
        } catch (err) {
          setOp({ status: 'error', kind: 'import', code: (err && err.code) || 'unknown_error', count: null })
        }
      }

      const copyDir = async () => {
        const dir = list.status === 'ok' ? String(list.dir || '') : ''
        if (!dir) return
        try {
          await copyToClipboard(dir)
          setCopyState('ok')
        } catch {
          setCopyState('error')
        }
      }

      const scrollToProposals = () => {
        const node = proposalsRef.current
        if (node && typeof node.scrollIntoView === 'function') node.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }

      /**
       * 提案动作成功后的统一刷新：先本地摘掉已拒绝项（瞬间生效），再让列表/提案/详情/git
       * 走同一个 reloadTick，避免三处状态各自漂移。
       */
      const onProposalChanged = (event) => {
        const kind = event && event.kind
        if (kind === 'rejected' && event && event.id !== undefined) {
          setProposals((prev) => ({
            ...prev,
            status: 'ok',
            items: (Array.isArray(prev.items) ? prev.items : []).filter((item) => !item || String(item.id) !== String(event.id)),
          }))
        }
        if (kind === 'propose') scrollToProposals()
        setOp({
          status: 'ok',
          kind: kind === 'applied' ? 'apply' : kind === 'rejected' ? 'reject' : kind === 'propose' ? 'propose' : 'rebuild',
          code: '',
          count: null,
          appliedKey: event && event.key ? String(event.key) : '',
          numberAdjusted: event && event.numberAdjusted && typeof event.numberAdjusted === 'object'
            ? event.numberAdjusted
            : null,
        })
        setReloadTick((v) => v + 1)
      }

      /**
       * 详情抽屉里的写动作（编辑/回滚/停用/重新启用/彻底删除）成功后的统一刷新：与提案动作共用
       * reloadTick，列表、提案、详情、git 一起重载；op 提示带「AGENTS 摘要随后同步」的说明。
       * purge 额外带 number/nextNumber：规则已从列表消失，顶部提示是用户唯一能确认
       * "编号已作废、下一个编号是多少"的地方。
       */
      const onRuleChanged = (event) => {
        const kind = event && event.kind
        setOp({
          status: 'ok',
          kind: kind === 'revert'
            ? 'revert'
            : kind === 'restore' ? 'restore'
              : kind === 'retire' ? 'retire'
                : kind === 'reactivate' ? 'reactivate'
                  : kind === 'purge' ? 'purge' : 'edit',
          code: '',
          count: null,
          changed: !(event && event.changed === false),
          commit: event && event.commit ? String(event.commit) : '',
          number: event && event.number !== undefined && event.number !== null ? Number(event.number) : null,
          nextNumber: event && event.nextNumber !== undefined && event.nextNumber !== null
            ? Number(event.nextNumber)
            : null,
        })
        setReloadTick((v) => v + 1)
      }

      /**
       * 新建规则成功：关弹层，把「已创建 · key」写进顶部提示，并让列表/提案/详情/git
       * 走同一 reloadTick —— 新建后编号与默认徽标要立刻出现在列表里。
       */
      const onRuleCreated = (event) => {
        setNewOpen(false)
        setOp({
          status: 'ok',
          kind: 'create',
          code: '',
          count: null,
          appliedKey: event && event.key ? String(event.key) : '',
          commit: event && event.commit ? String(event.commit) : '',
        })
        setReloadTick((v) => v + 1)
      }

      const busy = op.status === 'busy'
      const rules = list.status === 'ok' ? list.rules : []
      const rows = filterRuleList(rules, filter, query)
      // 刷新期间保留上一次条数，避免徽标闪成 0；加载失败时空数组自然归零。
      const proposalCount = Array.isArray(proposals.items) ? proposals.items.length : 0

      let notice = null
      if (op.status === 'ok') {
        notice = h('div', { style: css.ok },
          op.kind === 'import'
            ? (op.skipped ? t('rules.importSkipped')
              : t('rules.importDone') + (op.count === null ? '' : ' · ' + t('rules.importCount', { n: fmtNum(op.count, locale) })))
            : op.kind === 'create'
              ? t('rules.newDone') + (op.appliedKey ? ' · ' + op.appliedKey : '') + ' · ' + t('rules.agentsSynced')
              : op.kind === 'apply'
                ? t('rules.proposalApplied') + (op.appliedKey ? ' · ' + op.appliedKey : '')
                  + (op.numberAdjusted
                    ? ' · ' + t('rules.proposalNumberAdjusted', {
                      from: op.numberAdjusted.from === null || op.numberAdjusted.from === undefined
                        ? t('common.dash')
                        : fmtNum(op.numberAdjusted.from, locale),
                      to: op.numberAdjusted.to === null || op.numberAdjusted.to === undefined
                        ? t('common.dash')
                        : fmtNum(op.numberAdjusted.to, locale),
                    })
                    : '')
                : op.kind === 'reject'
                  ? t('rules.proposalRejected') + ' · ' + t('rules.proposalCooldown')
                  : op.kind === 'edit'
                    // 编辑可能只改 status＝「无实质改动」，此时别报「已保存」误导。
                    ? (op.changed === false
                      ? t('rules.editNoChange')
                      : t('rules.editDone') + ' · ' + t('rules.agentsSynced'))
                    : op.kind === 'retire'
                      ? t('rules.retireDone')
                      : op.kind === 'reactivate'
                        ? t('rules.reactivateDone')
                        : op.kind === 'purge'
                          // 编号作废要当场说清：列表里已看不到这条规则，只有这句能证明 #n 不再复用。
                          ? t('rules.purgeDone')
                            + (op.number
                              ? ' · ' + t('rules.purgeNumberRetired', {
                                number: fmtNum(op.number, locale),
                                next: fmtNum(op.nextNumber, locale),
                              })
                              : '')
                            + ' · ' + t('rules.agentsSynced')
                          : op.kind === 'revert'
                            ? t('rules.revertDone') + ' · ' + t('rules.agentsSynced')
                            : op.kind === 'restore'
                              ? t('rules.restoreDefaultDone')
                              : op.kind === 'propose' ? t('rules.proposalManualDone') : t('rules.rebuildDone'))
      } else if (op.status === 'error') {
        notice = h('div', { style: css.error },
          t('rules.opFailed') + ' [' + op.code + '] — ' + errText(t, { code: op.code }))
      }

      let listBody = null
      if (list.status === 'loading') listBody = h(StateBlock, { t, status: 'loading' })
      else if (list.status === 'error') listBody = h(StateBlock, { t, status: 'error', err: list.err, onRetry: rerun })
      else if (rules.length === 0) listBody = h(RulesEmptyGuide, {
        t, dir: list.dir, busy, onImport: importLegacy,
        onProposed: () => onProposalChanged({ kind: 'propose' }),
      })
      else if (rulesAllRetired(rules) && filter === 'all' && String(query).trim() === '') {
        // 全部停用且筛选=全部：别把一整页灰行当「正常列表」，直接给空态并给去「已退役」的入口。
        listBody = h('div', { style: css.stack },
          h('div', { style: css.tertiary }, t('rules.emptyNoActive')),
          h('div', null,
            h('button', { style: css.button, onClick: () => { setFilter('retired'); resetPageScroll() } },
              t('rules.emptyRetiredAction'))))
      }
      else if (rows.length === 0) {
        // 首次安装自带默认铁律；空态只在下述两种情况下出现：筛选没命中，或用户把全部规则停用。
        // 全部停用时 retired 行仍在「全部/已退役」里，这里提示去「已退役」找回并重新启用。
        listBody = h(StateBlock, {
          t, status: 'empty',
          empty: t(rulesAllRetired(rules) ? 'rules.emptyNoActive' : 'rules.tableEmpty'),
        })
      }
      else listBody = h(RulesTable, { t, locale, items: rows, onOpen: setDetailKey })

      const filters = [
        ['all', 'rules.filterAll'],
        ['iron', 'rules.filterIron'],
        ['normal', 'rules.filterNormal'],
        ['candidate', 'rules.filterCandidate'],
        ['retired', 'rules.filterRetired'],
      ]

      return h('div', { style: css.stack },
        h(Note, null, t('rules.intro')),
        // 顶部说明条：默认铁律是安装自带、可改可停可删，编号与历史都保留（不写死条数，避免漂移）。
        h(Note, null, t('rules.defaultNotice')),
        h(RulesGitBar, {
          t, locale,
          git: list.status === 'ok' ? list.git : null,
          dir: list.status === 'ok' ? list.dir : '',
          copyState, gitBusy, notice, busy, opKind: op.kind,
          onCopy: copyDir,
          onGuide: () => setGuideOpen(true),
          onRefreshGit: refreshGit,
          onRebuild: rebuildMirror,
        }),
        h('div', { ref: proposalsRef },
          h(RulesProposalsCard, {
            t, locale, proposals,
            onChanged: onProposalChanged,
            onRetry: rerun,
          })),
        h(Card, null,
          h('div', { style: css.inline },
            // 新建是小白主入口：放工具行第一位、品牌色，但不挤占顶部 git 状态条。
            h('button', {
              style: css.buttonPrimary,
              title: t('rules.newHint'),
              onClick: () => setNewOpen(true),
            }, t('rules.new')),
            h('input', {
              style: css.input, value: query,
              placeholder: t('rules.searchPlaceholder'),
              onChange: (e) => { setQuery(e.target.value); resetPageScroll() },
            }),
            h('button', { style: css.button, onClick: rerun }, t('common.refresh')),
            h('button', {
              style: proposalCount > 0 ? css.rulesCountBadgeActive : css.rulesCountBadge,
              onClick: scrollToProposals,
              title: t('rules.proposalsJump'),
            }, t('rules.proposalsCount', { n: fmtNum(proposalCount, locale) }))),
          h('div', { style: css.inline },
            h('div', { style: css.tertiary }, t('rules.filterLabel')),
            filters.map(([value, labelKey]) => h('button', {
              key: value,
              style: filter === value ? css.chipActive : css.chip,
              onClick: () => { setFilter(value); resetPageScroll() },
            }, t(labelKey)))),
          list.status === 'ok' && rules.length > 0
            ? h('div', { style: css.tertiary },
              t('rules.listMeta', { shown: fmtNum(rows.length, locale), total: fmtNum(rules.length, locale) }))
            : null,
          listBody),
        detailKey ? h(RuleDrawer, {
          t, locale, ruleKey: detailKey,
          refreshTick: reloadTick,
          capabilities: list.status === 'ok' ? list.capabilities : {},
          onChanged: onRuleChanged,
          onClose: () => setDetailKey(null),
        }) : null,
        guideOpen ? h(RulesGitGuide, { t, onClose: () => setGuideOpen(false) }) : null,
        newOpen ? h(RulesNewDialog, {
          t, locale,
          onClose: () => setNewOpen(false),
          onCreated: onRuleCreated,
        }) : null)
    }

    /** git 状态条：左=三态/版本/检查时间/安装指引，右=目录（可复制）+ 重建镜像。 */
    function RulesGitBar(props) {
      const {
        t, locale, git, dir, copyState, gitBusy, notice, busy, opKind,
        onCopy, onGuide, onRefreshGit, onRebuild,
      } = props
      const state = rulesGitState(git)
      const toneColor = state.tone === 'ok'
        ? 'var(--dsw-alias-state-success-primary)'
        : state.tone === 'error'
          ? 'var(--dsw-alias-state-error-primary)'
          : state.tone === 'warn'
            ? 'var(--dsw-alias-state-warn-primary)'
            : 'var(--dsw-alias-label-tertiary)'
      const label = state.tone === 'ok'
        ? t('rules.gitOk', { version: state.version || t('common.dash') })
        : state.tone === 'error'
          ? t('rules.gitBroken')
          : state.tone === 'warn' ? t('rules.gitMissing') : t('rules.gitUnknown')
      const detail = state.tone === 'ok'
        ? t('rules.gitChecked', { time: fmtTime(state.checkedAt, locale) })
        : state.tone === 'warn'
          ? t('rules.gitMissingDetail')
          : (state.error || (state.tone === 'error' ? t('rules.gitBroken') : t('rules.gitUnknown')))
      const rebuilding = opKind === 'rebuild' && busy
      return h(Card, null,
        h('div', { style: css.rulesBarTop },
          h('div', { style: css.stack },
            h('div', { style: css.inline },
              h('span', { style: { ...css.dot, background: toneColor } }),
              h('span', { style: css.rulesGitLabel }, t('rules.gitTitle')),
              h('span', { style: css.rulesGitState }, label),
              state.required ? h('span', { style: css.warn }, t('rules.gitRequiredHint')) : null),
            h('div', { style: css.tertiary }, detail)),
          h('div', { style: css.inline },
            h('button', { style: css.button, onClick: onGuide }, t('rules.gitGuide')),
            h('button', {
              style: gitBusy ? css.buttonDisabled : css.button,
              disabled: gitBusy, onClick: onRefreshGit,
            }, gitBusy ? t('common.loading') : t('rules.gitRefresh')))),
        h('div', { style: css.rulesBarTop },
          h('div', { style: css.rulesDirBox },
            h('span', { style: css.tertiary }, t('rules.dirLabel')),
            h('code', { style: css.rulesDirPath }, dir || '~/.dsh/rules'),
            h('button', {
              style: dir ? css.button : css.buttonDisabled,
              disabled: !dir, onClick: onCopy, title: t('rules.mirrorNote'),
            }, copyState === 'ok' ? t('rules.copied')
              : copyState === 'error' ? t('rules.copyFailed') : t('rules.copyDir'))),
          h('button', {
            style: busy ? css.buttonDisabled : css.buttonWarn,
            disabled: Boolean(busy), onClick: onRebuild, title: t('rules.mirrorNote'),
          }, rebuilding ? t('rules.rebuilding') : t('rules.rebuildMirror'))),
        notice)
    }

    // >>> rules-proposals:ui
    /** 关系文案：归一后一定能落到六种之一，新关系宁可显示「无关」也不要空字。 */
    function proposalRelationLabel(t, value) {
      return t(PROPOSAL_RELATION_KEYS[proposalRelationOf({ relation: value })])
    }

    /** 状态文案：归一后一定能落到五态之一，避免未知状态渲染出空标签。 */
    function proposalStatusLabel(t, value) {
      return t(PROPOSAL_STATUS_KEYS[proposalStatusOf({ status: value })])
    }

    /** 提案色调到设计变量：红只给冲突/风险，黄给合并/重复，品牌色给新增/细化。 */
    function proposalToneColor(tone) {
      if (tone === 'error') return 'var(--dsw-alias-state-error-primary)'
      if (tone === 'warn') return 'var(--dsw-alias-state-warn-primary)'
      if (tone === 'ok') return 'var(--dsw-alias-state-success-primary)'
      if (tone === 'brand') return 'var(--dsw-alias-brand-primary)'
      return 'var(--dsw-alias-label-tertiary)'
    }

    /** 关系/状态徽标：同一形状两种语义，颜色由 tone 决定（未知值走中性灰）。 */
    function RulesProposalBadge(props) {
      const { t, kind, value } = props
      const tone = kind === 'relation' ? proposalRelationTone(value) : proposalStatusTone(value)
      const color = proposalToneColor(tone)
      const label = kind === 'relation' ? proposalRelationLabel(t, value) : proposalStatusLabel(t, value)
      return h('span', { style: { ...css.rulesStatusBadge, color, borderColor: color } }, label)
    }

    /** 保留/丢弃子句块：只在有内容时渲染，丢弃用警告色（不抢整页的红）。 */
    function proposalClauseBlock(t, labelKey, clauses, tone) {
      const lines = clauseLines(clauses)
      if (lines.length === 0) return null
      return h('div', { style: css.rulesProposalClause },
        h('div', {
          style: { ...css.fieldLabel, color: tone === 'warn' ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-label-secondary)' },
        }, t(labelKey) + ' · ' + String(lines.length)),
        h('ul', { style: css.rulesList }, lines.map((line, index) => h('li', {
          key: index, style: css.rulesListRow,
        }, line))))
    }

    /**
     * 风险条：守卫未过/有子句被丢弃时出现（冲突/合并提示更重）；
     * 必须勾选 acknowledgeDropped 才放行收录，避免把删除当默认值。
     */
    function RulesProposalRiskBar(props) {
      const { t, risk, ack, onAck } = props
      if (!risk || !risk.risky) return null
      const relationLabel = proposalRelationLabel(t, risk.relation)
      return h('div', { style: css.rulesRiskBar, role: 'alert' },
        h('div', { style: css.rulesRiskTitle },
          t('rules.proposalRiskTitle') + ' · ' + relationLabel),
        risk.guardFailed
          ? h('div', { style: css.rulesRiskLine }, t('rules.proposalRiskGuard'))
          : null,
        risk.dropped.length > 0
          ? h('div', { style: css.rulesRiskLine },
            t('rules.proposalRiskDropped', { n: fmtNum(risk.dropped.length) }))
          : null,
        risk.dropped.length > 0
          ? h('ul', { style: css.rulesRiskDroppedList }, risk.dropped.map((row, index) => h('li', {
            key: index, style: css.rulesRiskDroppedItem,
          }, (row.number === null ? row.key : '#' + String(row.number)) + ' · ' + row.text)))
          : null,
        h('label', { style: css.rulesAckRow },
          h('input', {
            type: 'checkbox', style: css.checkbox,
            checked: Boolean(ack), onChange: (e) => onAck(e.target.checked),
          }),
          h('span', null, t('rules.proposalAckDropped'))))
    }

    /** 改写弹层：预填候选正文，条件/例外/作用域可改；提交即按新正文收录。 */
    function RulesProposalEditor(props) {
      const { t, item, initialText, busy, blocked, onClose, onSubmit } = props
      const candidate = proposalCandidateOf(item)
      const [text, setText] = useState(initialText || candidate.text || '')
      const [conditions, setConditions] = useState(clauseLines(candidate.conditions).join('\n'))
      const [exceptions, setExceptions] = useState(clauseLines(candidate.exceptions).join('\n'))
      const [scope, setScope] = useState(candidate.scope || '')
      const composed = composeProposalText({
        text,
        conditions: conditions.split(/\r?\n/),
        exceptions: exceptions.split(/\r?\n/),
        scope,
      })
      const empty = composed.length === 0
      return h('div', { style: css.rulesGuideMask, onClick: onClose },
        h('aside', { style: css.rulesProposalPanel, onClick: (e) => e.stopPropagation() },
          h('div', { style: css.inline },
            h('div', { style: { ...css.cardTitle, flex: 1 } }, t('rules.proposalRewriteTitle')),
            h('button', { style: css.button, onClick: onClose }, t('common.close'))),
          h('div', { style: css.note }, t('rules.proposalRewriteHint')),
          h('label', { style: css.field },
            h('span', { style: css.fieldLabel }, t('rules.proposalEditorText')),
            h('textarea', {
              style: css.rulesProposalEditorArea, rows: 8, value: text,
              onChange: (e) => setText(e.target.value),
            })),
          h('label', { style: css.field },
            h('span', { style: css.fieldLabel }, t('rules.proposalEditorConditions')),
            h('textarea', {
              style: css.textarea, rows: 3, value: conditions,
              onChange: (e) => setConditions(e.target.value),
            })),
          h('label', { style: css.field },
            h('span', { style: css.fieldLabel }, t('rules.proposalEditorExceptions')),
            h('textarea', {
              style: css.textarea, rows: 3, value: exceptions,
              onChange: (e) => setExceptions(e.target.value),
            })),
          h('label', { style: css.field },
            h('span', { style: css.fieldLabel }, t('rules.proposalEditorScope')),
            h('input', {
              style: css.input, value: scope,
              onChange: (e) => setScope(e.target.value),
            })),
          h('div', { style: css.tertiary }, t('rules.proposalRewriteNote')),
          empty ? h('div', { style: css.warn }, t('rules.proposalRewriteEmpty')) : null,
          blocked ? h('div', { style: css.warn }, t('rules.proposalAckHint')) : null,
          h('div', { style: css.actions },
            h('button', {
              style: empty || busy || blocked ? css.buttonDisabled : css.buttonPrimary,
              disabled: Boolean(empty || busy || blocked),
              onClick: () => { if (!empty && !busy && !blocked) onSubmit(composed) },
            }, busy ? t('common.saving') : t('rules.proposalRewriteSubmit')))))
    }

    /**
     * 单条提案卡：关系/状态徽标 + 正文（≤200 字可展开）+ 编号/优先级/作用域 + 来源 +
     * 受影响旧规则（旧→新、保留/丢弃）+ 守卫失败 + 收录/改写/拒绝。
     */
    function RulesProposalItem(props) {
      const { t, locale, item, onChanged } = props
      const candidate = proposalCandidateOf(item)
      const affected = proposalAffectedOf(item)
      const guard = proposalGuardOf(item)
      const needsManual = proposalNeedsManualOf(item)
      const risk = proposalRiskOf(item)
      const preview = proposalPreview(candidate.text, 200)
      const source = (item && item.source) || {}
      const sourceText = String(source.text || '')
      const identity = (source && source.identity) || {}
      const identityText = [identity.roleId, identity.workspace].filter(Boolean).join(' · ')
      const id = item && item.id !== undefined ? item.id : null
      const [expanded, setExpanded] = useState(false)
      const [ack, setAck] = useState(false)
      const [busy, setBusy] = useState('')
      const [err, setErr] = useState(null)
      const [rewriteOpen, setRewriteOpen] = useState(false)
      const [rejectOpen, setRejectOpen] = useState(false)
      const [reason, setReason] = useState('')
      const gated = risk.requiresAck && !ack

      /**
       * apply 前先取计划指纹（CAS）：面板先 `/rules/plan`，apply 只认 planHash。
       * 501=core plan 未上线 → 降级为不带指纹（旧服务端仍可用）；其它失败直接上报并停，绝不写盘。
       */
      const requestApplyPlan = async (decisions) => {
        try {
          const body = await callJson('/rules/plan', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id, decisions }),
          })
          const planHash = body && body.plan && typeof body.plan.planHash === 'string'
            ? body.plan.planHash
            : ''
          return { ok: true, planHash }
        } catch (failure) {
          const code = (failure && failure.code) || 'plan_failed'
          if (code === 'plan_unavailable' || (failure && failure.status === 501)) {
            return { ok: true, planHash: '', degraded: true }
          }
          const failures = failure && failure.body && Array.isArray(failure.body.failures)
            ? failure.body.failures
            : []
          return { ok: false, code, failures }
        }
      }

      // 同步闸：busy 是 state，重渲染前连点两次会穿透（审计 A5）。
      const busyRef = useRef('')
      const apply = async (text) => {
        if (id === null || gated || busyRef.current) return
        busyRef.current = 'apply'
        setBusy('apply')
        setErr(null)
        const decisions = proposalDecisionsFor({
          text: typeof text === 'string' ? text : '',
          acknowledgeDropped: ack === true,
          dropped: risk.dropped,
        })
        try {
          // 计划不通过（守卫/断链/撞号）→ 只展示失败项，不进入确认、不写盘。
          const planned = await requestApplyPlan(decisions)
          if (!planned.ok) {
            setBusy('')
            setErr({ code: planned.code, failures: planned.failures, plan: true })
            return
          }
          if (!askConfirm(t('rules.proposalApplyConfirm'))) {
            setBusy('')
            return
          }
          const applyBody = { id, decisions }
          if (planned.planHash) applyBody.planHash = planned.planHash
          const body = await callJson('/rules/apply', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(applyBody),
          })
          setBusy('')
          setRewriteOpen(false)
          const applied = body && body.applied
          // 编号被顺延（提案号被占/保留号）必须让用户看见，不能静默写到另一个号。
          const adjusted = applied && applied.numberAdjusted && typeof applied.numberAdjusted === 'object'
            ? applied.numberAdjusted
            : null
          onChanged({
            kind: 'applied',
            key: applied && applied.key ? String(applied.key) : '',
            numberAdjusted: adjusted,
          })
        } catch (failure) {
          setBusy('')
          const failures = failure && failure.body && Array.isArray(failure.body.failures)
            ? failure.body.failures
            : []
          setErr({ code: (failure && failure.code) || 'unknown_error', failures })
        } finally {
          busyRef.current = ''
        }
      }

      const reject = async () => {
        if (id === null || busyRef.current) return
        if (!askConfirm(t('rules.proposalRejectConfirm'))) return
        busyRef.current = 'reject'
        setBusy('reject')
        setErr(null)
        try {
          const trimmed = reason.trim()
          await callJson('/rules/reject', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id, reason: trimmed || undefined }),
          })
          setBusy('')
          onChanged({ kind: 'rejected', id })
        } catch (failure) {
          setBusy('')
          setErr({ code: (failure && failure.code) || 'unknown_error', failures: [] })
        } finally {
          busyRef.current = ''
        }
      }

      const meta = h('div', { style: css.rulesProposalMeta },
        t('rules.proposalMeta', {
          number: candidate.number === null ? '—' : '#' + String(candidate.number),
          priority: candidate.priority === null ? '—' : String(candidate.priority),
          scope: candidate.scope || '—',
        }))

      let bodyText = null
      if (preview.text) {
        bodyText = h('div', { style: css.rulesProposalText },
          h('span', null, expanded ? preview.text : preview.preview),
          preview.truncated
            ? h('button', {
              style: css.rulesInlineButton,
              onClick: () => setExpanded((v) => !v),
            }, expanded ? t('rules.proposalCollapse') : t('rules.proposalExpand'))
            : null)
      } else bodyText = h('div', { style: css.tertiary }, t('common.dash'))

      let affectedBody = null
      if (affected.length > 0) {
        affectedBody = h('div', { style: css.rulesProposalAffect },
          h('div', { style: css.fieldLabel }, t('rules.proposalAffected')),
          affected.map((row, index) => h('div', {
            key: row.key || index, style: css.rulesProposalAffectRow,
          },
          h('div', { style: css.rulesProposalAffectHead },
            h('span', { style: css.rulesProposalAffectKey },
              (row.number === null ? '—' : '#' + String(row.number)) + (row.key ? ' · ' + row.key : '')),
            row.changed ? h('span', { style: css.rulesStatusBadge }, t('rules.proposalChanged')) : null),
          h('div', { style: css.rulesProposalCompare },
            h('div', { style: css.rulesProposalOldText },
              h('span', { style: css.rulesProposalDiffLabel }, t('rules.proposalOld')),
              h('div', { style: css.rulesProposalDiffText }, row.oldText || '—')),
            h('div', { style: css.rulesProposalNewText },
              h('span', { style: css.rulesProposalDiffLabel }, t('rules.proposalNew')),
              h('div', { style: css.rulesProposalDiffText }, row.newText || '—'))),
          proposalClauseBlock(t, 'rules.proposalPreserved', row.preserved),
          proposalClauseBlock(t, 'rules.proposalDropped', row.dropped, 'warn'))))
      }

      let guardBody = null
      if (guard.failures.length > 0) {
        guardBody = h('div', { style: css.rulesProposalGuard },
          h('div', { style: css.warn }, t('rules.proposalGuardFailed')),
          h('ul', { style: css.rulesList }, guard.failures.map((failure, index) => h('li', {
            key: index, style: css.rulesListRow,
          }, '[' + (failure.code || '—') + '] '
            + (failure.key ? failure.key + ' — ' : '')
            + (failure.detail || t('common.dash'))))))
      }

      let errBody = null
      if (needsManual) {
        // 失败候选必须留在面板上并说明原因：它不是死数据，用户要能改写正文后重试同一 id。
        errBody = h('div', { style: css.warnBox },
          h('div', { style: css.warn }, t('rules.proposalNeedsManual')),
          h('div', { style: css.tertiary },
            t('rules.proposalNeedsManualCode', { code: needsManual.code })),
          needsManual.detail ? h('div', { style: css.tertiary }, needsManual.detail) : null)
      }
      if (err) {
        errBody = h('div', { style: css.errorBox },
          h('div', { style: css.error },
            t('rules.opFailed') + ' [' + err.code + '] — ' + errText(t, { code: err.code })),
          err.failures.length > 0
            ? h('ul', { style: css.rulesList }, err.failures.map((failure, index) => h('li', {
              key: index, style: css.rulesListRow,
            }, '[' + ((failure && failure.code) || '—') + '] '
              + ((failure && failure.key) ? failure.key + ' — ' : '')
              + ruleFieldText(failure && failure.detail))))
            : null,
          h('button', { style: css.button, onClick: () => setErr(null) }, t('common.close')))
      }

      const applyDisabled = Boolean(gated || busy)
      return h('div', { style: css.rulesProposalItem },
        h('div', { style: css.rulesProposalHead },
          h('div', { style: css.rulesProposalBadges },
            h(RulesProposalBadge, { t, kind: 'relation', value: item && item.relation }),
            h(RulesProposalBadge, { t, kind: 'status', value: item && item.status }),
            // 语义提炼状态：ready+llm 显示“语义稿”，pending 显示“提炼中”；规则稿不额外加徽标。
            item && item.refine && item.refine.state === 'ready' && item.refine.by === 'llm'
              ? h('span', { style: { ...css.rulesStatusBadge, color: 'var(--dsw-alias-brand-primary)', borderColor: 'var(--dsw-alias-brand-primary)' } }, t('rules.proposalSemantic'))
              : item && item.refine && item.refine.state === 'pending'
                ? h('span', { style: css.rulesStatusBadge }, t('rules.proposalRefining'))
                : null),
          h('div', { style: css.tertiary }, fmtTime(item && item.createdAt, locale))),
        bodyText,
        meta,
        sourceText
          ? h('div', { style: css.rulesProposalSource },
            h('div', { style: css.fieldLabel }, t('rules.proposalSource')),
            h('div', { style: css.rulesProposalSourceText }, proposalPreview(sourceText, 160).preview),
            identityText || (source && source.traceId)
              ? h('div', { style: css.tertiary },
                [identityText, source && source.traceId ? 'trace ' + String(source.traceId) : ''].filter(Boolean).join(' · '))
              : null)
          : null,
        affectedBody,
        guardBody,
        h(RulesProposalRiskBar, { t, risk, ack, onAck: setAck }),
        (item && item.cooling === true)
          ? h('div', { style: css.tertiary }, t('rules.proposalCooling'))
          : null,
        errBody,
        rejectOpen
          ? h('div', { style: css.stack },
            h('label', { style: css.field },
              h('span', { style: css.fieldLabel }, t('rules.proposalRejectReason')),
              h('input', {
                style: css.input, value: reason, maxLength: 120,
                placeholder: t('rules.proposalRejectPlaceholder'),
                onChange: (e) => setReason(e.target.value),
              })),
            h('div', { style: css.actions },
              h('button', {
                style: busy ? css.buttonDisabled : css.buttonWarn,
                disabled: Boolean(busy), onClick: reject,
              }, busy === 'reject' ? t('common.saving') : t('rules.proposalRejectConfirmAction')),
              h('button', { style: css.button, onClick: () => setRejectOpen(false) }, t('common.cancel'))))
          : null,
        h('div', { style: css.actions },
          h('button', {
            style: applyDisabled ? css.buttonDisabled : css.buttonPrimary,
            disabled: applyDisabled, title: gated ? t('rules.proposalAckHint') : t('rules.proposalApplyConfirm'),
            onClick: () => apply(''),
          }, busy === 'apply' ? t('common.saving') : t('rules.proposalApply')),
          h('button', {
            style: busy ? css.buttonDisabled : css.button,
            disabled: Boolean(busy), onClick: () => setRewriteOpen(true),
          }, needsManual ? t('rules.proposalRewriteRetry') : t('rules.proposalRewrite')),
          h('button', {
            style: busy ? css.buttonDisabled : css.buttonWarn,
            disabled: Boolean(busy), onClick: () => setRejectOpen((v) => !v),
          }, t('rules.proposalReject'))),
        rewriteOpen
          ? h(RulesProposalEditor, {
            t, item, initialText: candidate.text, busy: busy === 'apply',
            blocked: gated,
            onClose: () => setRewriteOpen(false),
            onSubmit: apply,
          })
          : null)
    }

    /**
     * 待确认区：404（契约未上线）软降级为空态；其它失败在卡片内给可重试错误态，不报整页红。
     * 列表每条都是真实提案卡；空态文案＝「暂无待确认提案」。
     */
    function RulesProposalsCard(props) {
      const { t, locale, proposals, onChanged, onRetry } = props
      const items = Array.isArray(proposals.items) ? proposals.items : []
      const count = proposals.status === 'ok' ? items.length : 0
      let body = h('div', { style: css.tertiary }, t('rules.proposalsEmpty'))
      if (proposals.status === 'loading') body = h('div', { style: css.muted }, t('rules.proposalLoading'))
      else if (proposals.status === 'error') {
        body = h('div', { style: css.errorBox },
          h('div', { style: css.error }, t('rules.proposalError') + ' — ' + errText(t, proposals.err)),
          onRetry ? h('button', { style: css.button, onClick: onRetry }, t('common.retry')) : null)
      } else if (count > 0) {
        body = h('div', { style: css.stack }, items.map((item, index) => h(RulesProposalItem, {
          key: String((item && item.id) || (item && item.key) || index),
          t, locale, item, onChanged,
        })))
      }
      return h(Card, null,
        h(SectionTitle, null, t('rules.proposalsTitle', { n: fmtNum(count, locale) })),
        body)
    }
    // <<< rules-proposals:ui

    /** 列表表格：编号/类型/优先级/作用域/状态/更新时间/摘要/详情；行 hover 走状态（无样式表可用）。 */
    function RulesTable(props) {
      const { t, locale, items, onOpen } = props
      const [hover, setHover] = useState(null)
      // 390px 窄屏下不横向溢出：外层滚动容器，表格保持最小可读宽度。
      // 纵向交给页根（R9-07 单一纵向滚动根）：这里只横滚，表头靠 css.th 的 sticky 跟随页根。
      // 虚拟化阈值：规则行 > 200 条的判据＝列表 >200 行 且 单帧渲染耗时 > 16ms（1280×800 实测）。
      // 当前 17 条不做窗口化，提前引入组件只会让主流程更厚（R9-07 第 7 条）。
      return h('div', { style: { overflowX: 'auto', overflowY: 'clip', scrollbarWidth: 'thin', scrollbarColor: 'var(--dsw-alias-border-l1) transparent' } },
        h('table', { style: css.table },
          h('thead', null, h('tr', null,
            h('th', { style: css.th }, t('rules.colNumber')),
            h('th', { style: css.th }, t('rules.colType')),
            h('th', { style: css.th }, t('rules.colPriority')),
            h('th', { style: css.th }, t('rules.colScope')),
            h('th', { style: css.th }, t('rules.colStatus')),
            h('th', { style: css.th }, t('rules.colUpdated')),
            h('th', { style: css.th }, t('rules.colExcerpt')),
            h('th', { style: css.th }, t('rules.colOps')))),
          h('tbody', null, items.map((rule, index) => {
            const rowKey = String((rule && rule.key) || index)
            return h('tr', {
              key: rowKey,
              style: hover === rowKey ? { ...css.rulesRow, ...css.rulesRowHover } : css.rulesRow,
              onMouseEnter: () => setHover(rowKey),
              onMouseLeave: () => setHover((prev) => (prev === rowKey ? null : prev)),
              onClick: () => onOpen(rule && rule.key),
            },
            h('td', { style: css.td }, ruleNumberText(rule)),
            h('td', { style: css.td }, h('div', { style: css.rulesTypeCell },
              h(RulesTypeBadge, { t, value: rule && rule.type }),
              ruleIsDefault(rule) ? h(RulesDefaultBadge, { t }) : null,
              ruleIsRetired(rule) ? h(RulesRetiredBadge, { t }) : null)),
            h('td', { style: css.td },
              rule && rule.priority !== undefined && rule.priority !== null ? String(rule.priority) : '—'),
            h('td', { style: css.td },
              h('span', { style: css.rulesScope, title: String((rule && rule.scope) || '') },
                shortPath((rule && rule.scope) || '—', 28))),
            h('td', { style: css.td }, h(RulesStatusBadge, { t, value: rule && rule.status })),
            h('td', { style: css.td }, fmtTime(rule && rule.updated, locale)),
            h('td', { style: css.td }, h('div', { style: css.cellText }, ruleSummary(rule, 60) || '—')),
            h('td', { style: css.td },
              h('button', {
                style: css.button,
                onClick: (e) => { e.stopPropagation(); onOpen(rule && rule.key) },
              }, t('rules.detail'))))
          }))))
    }

    /** 类型徽标：iron-rule=铁律，rule-candidate=候选规则，rule=普通规则；未知原样。 */
    function RulesTypeBadge(props) {
      const { t, value } = props
      return h('span', { style: css.rulesTypeBadge }, ruleTypeLabel(t, value))
    }

    /** 「默认」小徽标：安装自带铁律（origin 以 default: 开头）；列表类型列旁一眼可辨。 */
    function RulesDefaultBadge(props) {
      const { t } = props
      return h('span', { style: css.rulesDefaultBadge, title: t('rules.defaultOriginNote') }, t('rules.defaultBadge'))
    }

    /** 「已停用」小徽标：停用不动文件/编号，但立刻不注入；列表一眼区分生效与停用。 */
    function RulesRetiredBadge(props) {
      const { t } = props
      return h('span', { style: css.rulesRetiredBadge, title: t('rules.retiredBadge') }, t('rules.retiredBadge'))
    }

    /** 状态徽标：绿=生效，黄=候选/草稿，灰=退役/取代；红不用于规则状态。 */
    function RulesStatusBadge(props) {
      const { t, value } = props
      const tone = ruleStatusTone(value)
      const color = tone === 'ok'
        ? 'var(--dsw-alias-state-success-primary)'
        : tone === 'warn'
          ? 'var(--dsw-alias-state-warn-primary)'
          : 'var(--dsw-alias-label-tertiary)'
      return h('span', {
        style: { ...css.rulesStatusBadge, color, borderColor: color },
      }, ruleStatusLabel(t, value))
    }

    /** 空态引导：为什么需要规则 + 从记忆库导入 + 文件在哪可手改 + 手动提案入口。 */
    function RulesEmptyGuide(props) {
      const { t, dir, busy, onImport, onProposed } = props
      const [manual, setManual] = useState('')
      const [manualState, setManualState] = useState({ status: 'idle', code: '' })

      const submitManual = async () => {
        const text = manual.trim()
        if (!text) {
          setManualState({ status: 'error', code: 'invalid_text' })
          return
        }
        setManualState({ status: 'busy', code: '' })
        try {
          await callJson('/rules/propose', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text }),
          })
          setManual('')
          setManualState({ status: 'ok', code: '' })
          if (onProposed) onProposed()
        } catch (err) {
          setManualState({ status: 'error', code: (err && err.code) || 'unknown_error' })
        }
      }

      return h('div', { style: css.guide },
        h('div', { style: css.cardTitle }, t('rules.emptyTitle')),
        h('div', { style: css.note }, t('rules.emptyWhy')),
        h('ol', { style: css.rulesSteps },
          h('li', null, t('rules.emptyStepImport')),
          h('li', null, t('rules.emptyStepEdit')),
          h('li', null, t('rules.emptyStepRefresh'))),
        dir ? h('div', { style: css.tertiary }, t('rules.dirLabel') + ': ' + dir) : null,
        h('button', {
          style: busy ? css.buttonDisabled : css.buttonPrimary,
          disabled: busy, onClick: onImport,
        }, busy ? t('rules.importing') : t('rules.importLegacy')),
        h('div', { style: css.rulesManualBlock },
          h('div', { style: css.cardTitle }, t('rules.proposalManualTitle')),
          h('div', { style: css.note }, t('rules.proposalManualHint')),
          h('textarea', {
            style: css.textarea, rows: 3, value: manual, maxLength: 2000,
            placeholder: t('rules.proposalManualPlaceholder'),
            onChange: (e) => setManual(e.target.value),
          }),
          h('div', { style: css.actions },
            h('button', {
              style: manualState.status === 'busy' ? css.buttonDisabled : css.button,
              disabled: manualState.status === 'busy', onClick: submitManual,
            }, manualState.status === 'busy' ? t('common.saving') : t('rules.proposalManualSubmit')),
            manualState.status === 'ok' ? h('span', { style: css.ok }, t('rules.proposalManualDone')) : null,
            manualState.status === 'error'
              ? h('span', { style: css.error },
                t('rules.opFailed') + ' [' + manualState.code + '] — ' + errText(t, { code: manualState.code }))
              : null)))
    }

    /** 安装指引弹层：按平台给 brew/apt/winget + 下载链接 + 「无 git 仍可用快照」说明。 */
    function RulesGitGuide(props) {
      const { t, onClose } = props
      const rows = [
        ['rules.gitGuideBrew', 'brew install git'],
        ['rules.gitGuideApt', 'sudo apt install git'],
        ['rules.gitGuideWinget', 'winget install --id Git.Git -e'],
      ]
      return h('div', { style: css.rulesGuideMask, onClick: onClose },
        h('aside', { style: css.rulesGuidePanel, onClick: (e) => e.stopPropagation() },
          h('div', { style: css.inline },
            h('div', { style: { ...css.cardTitle, flex: 1 } }, t('rules.gitGuideTitle')),
            h('button', { style: css.button, onClick: onClose }, t('common.close'))),
          h('div', { style: css.note }, t('rules.gitGuideIntro')),
          h('div', { style: css.stack }, rows.map(([key, command]) => h('div', {
            key, style: css.rulesGuideRow,
          },
          h('div', { style: css.fieldLabel }, t(key)),
          h('code', { style: css.rulesCode }, command)))),
          h('div', { style: css.note },
            h('a', {
              style: css.linkButton, href: 'https://git-scm.com/downloads',
              target: '_blank', rel: 'noreferrer',
            }, t('rules.gitGuideDownload'))),
          h('div', { style: css.warnBox }, t('rules.gitGuideSnapshot'))))
    }

    /** 条件/例外列表：字符串/对象统一成一行；非数组给「暂无」。 */
    function ruleList(value, t) {
      const items = Array.isArray(value)
        ? value
        : (value === undefined || value === null || value === '' ? [] : [value])
      if (items.length === 0) return h('div', { style: css.tertiary }, t('rules.none'))
      return h('ul', { style: css.rulesList }, items.map((item, index) => h('li', {
        key: index, style: css.rulesListRow,
      }, ruleFieldText(item) || t('common.dash'))))
    }

    /**
     * 规则详情抽屉：front matter + 完整正文（等宽可选中）+ 条件/例外 + 历史/diff。
     * 回滚/编辑在 R3b 前 disabled + tooltip，避免按钮看起来能用却打不出去。
     */
    /** 编号展示：NaN/缺失一律「—」，铁律编号只在服务端有效时显示。 */
    function ruleNumberText(rule) {
      const n = Number(rule && rule.number)
      return Number.isFinite(n) ? '#' + String(n) : '—'
    }

    /**
     * 新建规则弹层：小白只填「要什么」，编号/key 由服务端分配（铁律自动从 18 起，普通规则也自动编号）。
     * 字段：类型（铁律/普通规则）、优先级 P0–P3、作用域（global/workspace/role + 值）、
     * 正文（≤500 码点）、条件/例外（每行一条）、动作/对象（可选，留空由服务端从正文抽取）。
     *
     * Why 提交前本地校验 + 二次确认：新建会写规则文件、创建 git commit、重建镜像并渲染 AGENTS，
     * 提交即进历史；先把正文/作用域错误挡在本地，再把「会动哪些东西」讲清，避免小白误建。
     */
    function RulesNewDialog(props) {
      const { t, locale, onClose, onCreated } = props
      const [type, setType] = useState('rule')
      const [priority, setPriority] = useState('P1')
      const [scopeKind, setScopeKind] = useState('global')
      const [scopeValue, setScopeValue] = useState('')
      const [text, setText] = useState('')
      const [conditions, setConditions] = useState('')
      const [exceptions, setExceptions] = useState('')
      const [action, setAction] = useState('')
      const [object, setObject] = useState('')
      const [busy, setBusy] = useState(false)
      const [problem, setProblem] = useState(null)

      const chars = ruleTextChars(text)
      const draft = { text, type, priority, scopeKind, scopeValue, conditions, exceptions, action, object }
      const problemCode = newRuleDraftProblem(draft)
      const typeOptions = [
        ['iron-rule', t('rules.typeIron')],
        ['rule', t('rules.typeNormal')],
      ]
      const scopeOptions = [
        ['global', t('rules.editScopeGlobal')],
        ['workspace', t('rules.editScopeWorkspace')],
        ['role', t('rules.editScopeRole')],
      ]

      /** 本地校验码 → 文案：正文/作用域复用编辑弹层口径，类型/优先级走新建专属文案。 */
      const localProblemText = (code) => {
        if (!code) return ''
        if (code === 'body_empty' || code === 'body_too_long') return t('rules.editInvalidText')
        if (code === 'type_invalid') return t('rules.newTypeInvalid')
        if (code === 'priority_invalid') return t('rules.newPriorityInvalid')
        if (String(code).startsWith('scope_')) return t('rules.editScopeInvalid')
        return ''
      }

      /**
       * 提交：本地校验不过就不发请求；确认文案必须同时说明「写文件 / git commit / 重建镜像 / 渲染 AGENTS」。
       * 载荷严格 `{draft:{...}}`；成功后交给父级关弹层并统一刷新（列表/详情/提案/git）。
       */
      const submit = async () => {
        if (busy) return
        if (problemCode) {
          setProblem({ code: problemCode, detail: null })
          return
        }
        if (!askConfirm(t('rules.newConfirm'))) return
        setBusy(true)
        setProblem(null)
        try {
          const body = await callJson('/rules/create', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ draft: newRuleDraftPayload(draft) }),
          })
          if (typeof onCreated === 'function') {
            onCreated({
              kind: 'create',
              // 服务端同时回顶层 key 与 rule.key；任一存在即可，避免契约微差时丢 key。
              key: body && (body.key || (body.rule && body.rule.key)) ? String(body.key || body.rule.key) : '',
              commit: body && body.commit ? String(body.commit) : '',
            })
          }
        } catch (err) {
          setProblem({
            code: (err && err.code) || 'unknown_error',
            detail: err && err.body ? err.body.detail : null,
          })
        } finally {
          setBusy(false)
        }
      }

      let problemNode = null
      if (problem) {
        const local = localProblemText(problem.code)
        const detail = ruleErrorDetailText(problem.detail)
        problemNode = h('div', { style: css.errorBox, role: 'alert' },
          h('div', { style: css.error },
            t('rules.opFailed') + ' [' + problem.code + '] — ' + (local || errText(t, { code: problem.code }))),
          detail ? h('div', { style: css.tertiary }, t('rules.errInvalidDetail', { detail })) : null,
          problem.code === 'git_required' ? h('div', { style: css.warn }, t('rules.errGitHint')) : null)
      }

      return h('div', { style: css.rulesGuideMask, onClick: busy ? undefined : onClose },
        h('aside', { style: css.rulesEditPanel, onClick: (e) => e.stopPropagation() },
          h('div', { style: css.inline },
            h('div', { style: { ...css.cardTitle, flex: 1 } }, t('rules.newTitle')),
            h('button', { style: css.button, onClick: onClose }, t('common.close'))),
          h('div', { style: css.note }, t('rules.newHint')),
          h('div', { style: css.rulesEditReadonly },
            h(Row, { k: t('rules.fieldNumber'), v: t('rules.newAutoAssign') }),
            h(Row, { k: t('rules.fieldKey'), v: t('rules.newAutoAssign') }),
            h('div', { style: { ...css.tertiary, gridColumn: '1 / -1' } }, t('rules.newAutoAssignNote'))),
          h('div', { style: css.rulesEditGrid },
            h('label', { style: css.field },
              h('span', { style: css.fieldLabel }, t('rules.newTypeLabel')),
              h(SelectInput, { value: type, options: typeOptions, onChange: setType })),
            h('label', { style: css.field },
              h('span', { style: css.fieldLabel }, t('rules.editPriorityLabel')),
              h(SelectInput, {
                value: priority,
                options: rulePriorityOptions(priority).map((value) => [value, value]),
                onChange: setPriority,
              })),
            h('label', { style: css.field },
              h('span', { style: css.fieldLabel }, t('rules.editScopeLabel')),
              h(SelectInput, { value: scopeKind, options: scopeOptions, onChange: setScopeKind })),
            scopeKind === 'global' ? null : h('label', { style: css.field },
              h('span', { style: css.fieldLabel }, t('rules.editScopeValueLabel')),
              h(TextInput, {
                value: scopeValue,
                placeholder: scopeKind === 'workspace'
                  ? t('rules.editScopeWorkspacePlaceholder')
                  : t('rules.editScopeRolePlaceholder'),
                onChange: setScopeValue,
              }))),
          h('label', { style: css.field },
            h('span', { style: css.fieldLabel }, t('rules.editTextLabel')),
            h('textarea', {
              style: css.rulesProposalEditorArea, rows: 8, maxLength: RULE_BODY_MAX,
              value: text, placeholder: t('rules.newTextPlaceholder'),
              onChange: (e) => setText(e.target.value),
            }),
            h('div', { style: chars > RULE_BODY_MAX ? css.warn : css.tertiary },
              t('common.charCount', { n: fmtNum(chars, locale), max: fmtNum(RULE_BODY_MAX, locale) }))),
          h('div', { style: css.rulesEditGrid },
            h('label', { style: css.field },
              h('span', { style: css.fieldLabel }, t('rules.newActionLabel')),
              h(TextInput, {
                value: action, placeholder: t('rules.newActionPlaceholder'),
                onChange: setAction,
              })),
            h('label', { style: css.field },
              h('span', { style: css.fieldLabel }, t('rules.newObjectLabel')),
              h(TextInput, {
                value: object, placeholder: t('rules.newObjectPlaceholder'),
                onChange: setObject,
              }))),
          h('label', { style: css.field },
            h('span', { style: css.fieldLabel }, t('rules.editConditionsLabel')),
            h('textarea', {
              style: css.textarea, rows: 3, value: conditions,
              onChange: (e) => setConditions(e.target.value),
            })),
          h('label', { style: css.field },
            h('span', { style: css.fieldLabel }, t('rules.editExceptionsLabel')),
            h('textarea', {
              style: css.textarea, rows: 3, value: exceptions,
              onChange: (e) => setExceptions(e.target.value),
            })),
          problemCode ? h('div', { style: css.warn }, localProblemText(problemCode)) : null,
          problemNode,
          h('div', { style: css.actions },
            h('button', {
              style: busy || problemCode ? css.buttonDisabled : css.buttonPrimary,
              disabled: Boolean(busy || problemCode),
              onClick: submit,
            }, busy ? t('common.saving') : t('rules.newSubmit')),
            h('button', { style: css.button, onClick: onClose }, t('common.cancel')))))
    }

    /** diff 行渲染：服务端 rows 与本地 lineDiff 同构（kind/text）；无差异给「一致」文案。 */
    function RulesDiffRows(props) {
      const { t, rows } = props
      const list = Array.isArray(rows) ? rows : []
      const changed = list.some((row) => row && row.kind !== 'same')
      if (!changed) return h('div', { style: css.tertiary }, t('rules.diffEmpty'))
      // diff 正文是抽屉/弹层内的受控二次滚动块：标记出来，页根仍是唯一页级滚动根。
      return h('div', { style: css.rulesDiffBody, 'data-wm-scroll': 'drawer' }, list.map((row, index) => h('div', {
        key: index,
        style: row.kind === 'add'
          ? css.rulesDiffAdd
          : row.kind === 'del' ? css.rulesDiffDel : css.rulesDiffSame,
      }, (row.kind === 'add' ? '+ ' : row.kind === 'del' ? '- ' : '  ') + row.text)))
    }

    /**
     * 编辑弹层（R5）：正文（≤500 码点计数）/条件/例外（每行一条）/作用域（三选+值）/
     * 优先级（P0–P3）/状态（active|retired）；key、类型、编号只读展示并注明不可改。
     *
     * Why 先预览再提交：规则改动会进 git 历史与 AGENTS 摘要，用户必须在二次确认前
     * 看到「到底改了哪几行」——预览优先用服务端 /rules/diff（rev=当前版本）拿当前正文
     * 当基线；没有当前版本或服务端未上线时退回本地 lineDiff(旧,新)。
     */
    function RulesEditDialog(props) {
      const { t, locale, rule, history, onClose, onSaved } = props
      const base = rule && typeof rule === 'object' ? rule : {}
      const initialScope = ruleScopeParts(base.scope)
      const [text, setText] = useState(String(base.text === null || base.text === undefined ? '' : base.text))
      const [conditions, setConditions] = useState(ruleLinesFromInput(base.conditions).join('\n'))
      const [exceptions, setExceptions] = useState(ruleLinesFromInput(base.exceptions).join('\n'))
      const [scopeKind, setScopeKind] = useState(initialScope.kind)
      const [scopeValue, setScopeValue] = useState(initialScope.value)
      const [priority, setPriority] = useState(String(base.priority || 'P1').toUpperCase())
      const [status, setStatus] = useState(String(base.status || 'active'))
      const [phase, setPhase] = useState('form')
      const [preview, setPreview] = useState(null)
      const [busy, setBusy] = useState(false)
      const [problem, setProblem] = useState(null)

      const chars = ruleTextChars(text)
      const scopeProblem = ruleScopeProblem(scopeKind, scopeValue)
      const textProblem = chars === 0 ? 'body_empty' : chars > RULE_BODY_MAX ? 'body_too_long' : null
      const draft = {
        text,
        conditions,
        exceptions,
        scope: ruleScopeValue(scopeKind, scopeValue),
        priority,
        status,
      }
      const edit = ruleEditPatch(base, draft)
      const blocked = Boolean(textProblem || scopeProblem)
      const retiring = status === 'retired' && String(base.status || '') !== 'retired'
      // 预览阶段锁死表单：确认提交的必须是「预览过的那一份」，避免改完不重预览就提交。
      const editing = phase === 'form'

      /** 本地校验/合同错误码 → 文案：作用域与正文问题不走 err.* 表（后端没有这些码）。 */
      const localProblemText = (code) => {
        if (code === 'body_empty' || code === 'body_too_long') return t('rules.editInvalidText')
        if (code === 'invalid_patch') return t('err.invalid_patch')
        if (code === 'no_change') return t('rules.editNoChange')
        if (String(code || '').startsWith('scope_')) return t('rules.editScopeInvalid')
        return ''
      }

      const scopeOptions = [
        ['global', t('rules.editScopeGlobal')],
        ['workspace', t('rules.editScopeWorkspace')],
        ['role', t('rules.editScopeRole')],
      ]
      if (scopeKind === 'custom') scopeOptions.push(['custom', t('rules.editScopeOther')])

      /**
       * 生成变更预览：有当前版本时先用 /rules/diff?key&rev=<当前版本> 取服务端认定的
       * 当前正文（newText），把它当基线；请求失败或无当前版本就用 rule.text 当基线。
       * 无论如何都本地逐行对比草稿——预览要回答的是「这次编辑会改成什么」。
       */
      const buildPreview = async () => {
        if (blocked) {
          setProblem({ code: textProblem || scopeProblem, detail: null })
          return
        }
        if (edit.fields.length === 0) {
          setProblem({ code: 'no_change', detail: null })
          return
        }
        setBusy(true)
        setProblem(null)
        let baseline = String(base.text === null || base.text === undefined ? '' : base.text)
        let source = 'local'
        const currentRev = ruleCurrentRev(base, history)
        if (currentRev) {
          try {
            const body = await callJson('/rules/diff?key=' + encodeURIComponent(String(base.key || ''))
              + '&rev=' + encodeURIComponent(currentRev))
            if (body && typeof body.newText === 'string' && body.newText) {
              baseline = body.newText
              source = 'server'
            } else if (body && typeof body.oldText === 'string' && body.oldText) {
              baseline = body.oldText
              source = 'server'
            }
          } catch {
            // 服务端 diff 不可用（R5 未上线/无 git）：保留本地基线，不阻断编辑。
          }
        }
        setPreview({
          rows: lineDiff(baseline, String(draft.text || '')),
          source,
          fields: edit.fields,
          patch: edit.patch,
        })
        setPhase('preview')
        setBusy(false)
      }

      /**
       * 提交：退役＝语义从「会注入」变「不再注入」，先按「不再注入但保留历史」单独确认；
       * 再确认写入文件/新版本/AGENTS 摘要。载荷严格只有 {key,patch}（key 只读，服务端拒绝改）。
       */
      const submit = async () => {
        if (busy || blocked) return
        if (retiring && !askConfirm(t('rules.editRetireConfirm'))) return
        if (!askConfirm(t('rules.editConfirm'))) return
        setBusy(true)
        setProblem(null)
        const patch = preview && phase === 'preview' ? preview.patch : edit.patch
        try {
          const body = await callJson('/rules/update', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ key: String(base.key || ''), patch }),
          })
          if (typeof onSaved === 'function') {
            onSaved({
              kind: 'edit',
              changed: body && body.changed !== false,
              commit: body && body.commit ? String(body.commit) : '',
            })
          }
        } catch (err) {
          setProblem({
            code: (err && err.code) || 'unknown_error',
            detail: err && err.body ? err.body.detail : null,
          })
        } finally {
          setBusy(false)
        }
      }

      let problemNode = null
      if (problem) {
        const local = localProblemText(problem.code)
        const detail = ruleErrorDetailText(problem.detail)
        problemNode = h('div', { style: css.errorBox, role: 'alert' },
          h('div', { style: css.error },
            t('rules.opFailed') + ' [' + problem.code + '] — ' + (local || errText(t, { code: problem.code }))),
          detail ? h('div', { style: css.tertiary }, t('rules.errInvalidDetail', { detail })) : null,
          problem.code === 'git_required' ? h('div', { style: css.warn }, t('rules.errGitHint')) : null)
      }

      return h('div', { style: css.rulesGuideMask, onClick: busy ? undefined : onClose },
        h('aside', { style: css.rulesEditPanel, onClick: (e) => e.stopPropagation() },
          h('div', { style: css.inline },
            h('div', { style: { ...css.cardTitle, flex: 1 } }, t('rules.editTitle')),
            h('button', { style: css.button, onClick: onClose }, t('common.close'))),
          h('div', { style: css.note }, t('rules.editHint')),
          h('div', { style: css.rulesEditReadonly },
            h(Row, { k: t('rules.fieldNumber'), v: ruleNumberText(base) }),
            h(Row, { k: t('rules.fieldType'), v: ruleTypeLabel(t, base.type) }),
            h(Row, { k: t('rules.fieldKey'), v: String(base.key || '—') }),
            h('div', { style: { ...css.tertiary, gridColumn: '1 / -1' } }, t('rules.editImmutableNote'))),
          h('label', { style: css.field },
            h('span', { style: css.fieldLabel }, t('rules.editTextLabel')),
            h('textarea', {
              style: css.rulesProposalEditorArea, rows: 8, maxLength: RULE_BODY_MAX,
              value: text, disabled: !editing,
              onChange: (e) => setText(e.target.value),
            }),
            h('div', { style: chars > RULE_BODY_MAX ? css.warn : css.tertiary },
              t('common.charCount', { n: fmtNum(chars, locale), max: fmtNum(RULE_BODY_MAX, locale) }))),
          h('label', { style: css.field },
            h('span', { style: css.fieldLabel }, t('rules.editConditionsLabel')),
            h('textarea', {
              style: css.textarea, rows: 3, value: conditions, disabled: !editing,
              onChange: (e) => setConditions(e.target.value),
            })),
          h('label', { style: css.field },
            h('span', { style: css.fieldLabel }, t('rules.editExceptionsLabel')),
            h('textarea', {
              style: css.textarea, rows: 3, value: exceptions, disabled: !editing,
              onChange: (e) => setExceptions(e.target.value),
            })),
          h('div', { style: css.rulesEditGrid },
            h('label', { style: css.field },
              h('span', { style: css.fieldLabel }, t('rules.editScopeLabel')),
              h(SelectInput, {
                value: scopeKind, options: scopeOptions, disabled: !editing, onChange: setScopeKind,
              })),
            scopeKind === 'global' ? null : h('label', { style: css.field },
              h('span', { style: css.fieldLabel }, t('rules.editScopeValueLabel')),
              h(TextInput, {
                value: scopeValue, disabled: !editing, onChange: setScopeValue,
                placeholder: scopeKind === 'workspace'
                  ? t('rules.editScopeWorkspacePlaceholder')
                  : t('rules.editScopeRolePlaceholder'),
              })),
            h('label', { style: css.field },
              h('span', { style: css.fieldLabel }, t('rules.editPriorityLabel')),
              h(SelectInput, {
                value: priority,
                options: rulePriorityOptions(priority).map((value) => [value, value]),
                disabled: !editing,
                onChange: setPriority,
              })),
            h('label', { style: css.field },
              h('span', { style: css.fieldLabel }, t('rules.editStatusLabel')),
              h(SelectInput, {
                value: status,
                options: [['active', t('rules.editStatusActive')], ['retired', t('rules.editStatusRetired')]],
                disabled: !editing,
                onChange: setStatus,
              }))),
          retiring ? h('div', { style: css.warnBox }, t('rules.editRetiredHint')) : null,
          blocked ? h('div', { style: css.warn }, localProblemText(textProblem || scopeProblem)) : null,
          phase === 'preview' && preview
            ? h('div', { style: css.rulesDiff },
              h('div', { style: css.fieldLabel }, t('rules.editPreviewTitle')),
              h('div', { style: css.rulesFieldChips },
                preview.fields.map((field) => h('span', {
                  key: field, style: css.rulesFieldChip,
                }, ruleEditFieldLabel(t, field)))),
              h('div', { style: css.inline },
                h('span', { style: css.rulesDiffTagOld }, t('rules.diffOld') + ' · ' + ruleEditFieldLabel(t, 'text')),
                h('span', { style: css.rulesDiffTagNew }, t('rules.diffNew'))),
              preview.fields.includes('text')
                ? h(RulesDiffRows, { t, rows: preview.rows })
                // 只改优先级/状态时正文一致是正常的，别让「正文一致」被误读成没改动。
                : h('div', { style: css.tertiary }, t('rules.editDiffFieldsOnly')),
              h('div', { style: css.tertiary },
                preview.source === 'server'
                  ? t('rules.editDiffServerNote')
                  : t('rules.editDiffLocalNote')))
            : null,
          problemNode,
          h('div', { style: css.actions },
            phase === 'preview'
              ? h('button', {
                style: css.button,
                onClick: () => { setPhase('form'); setPreview(null); setProblem(null) },
              }, t('rules.editBack'))
              : null,
            phase === 'preview'
              ? h('button', {
                style: busy || blocked ? css.buttonDisabled : css.buttonPrimary,
                disabled: Boolean(busy || blocked), onClick: submit,
              }, busy ? t('common.saving') : t('rules.editSubmit'))
              : h('button', {
                style: busy || blocked ? css.buttonDisabled : css.buttonPrimary,
                disabled: Boolean(busy || blocked), onClick: buildPreview,
              }, busy ? t('common.loading') : t('rules.editPreview')))))
    }

    function RuleDrawer(props) {
      const { t, locale, ruleKey, refreshTick, capabilities, onChanged, onClose } = props
      const [loaded, setLoaded] = useState({ status: 'loading' })
      const [selected, setSelected] = useState(null)
      const [serverDiff, setServerDiff] = useState({ status: 'idle', rows: null, rev: null })
      const [feedback, setFeedback] = useState(null)
      const [editOpen, setEditOpen] = useState(false)
      const [revertBusy, setRevertBusy] = useState(false)
      const [statusBusy, setStatusBusy] = useState(false)
      const [purgeBusy, setPurgeBusy] = useState(false)
      // 追加在最后：运行时冒烟测试按 useState 调用序号喂预设，新增状态不能插队。
      const [retryTick, setRetryTick] = useState(0)
      const [restoreBusy, setRestoreBusy] = useState(false)
      // DangerButton 的输入闸：必须是用户手打的整句 key，输入不符不发请求（服务端同样校验）。
      const [purgeKeyInput, setPurgeKeyInput] = useState('')

      // Esc 关闭抽屉（R9-07 第 6 条）：遮罩点击已能关，键盘用户不该只能找鼠标。
      // Why 判 editOpen：编辑弹层开着时 Esc 只该关弹层，不能把外层详情一起关掉。
      useEffect(() => {
        if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined
        const onKeyDown = (event) => {
          if (event && event.key === 'Escape' && !editOpen) onClose()
        }
        document.addEventListener('keydown', onKeyDown)
        return () => document.removeEventListener('keydown', onKeyDown)
      }, [onClose, editOpen])

      useEffect(() => {
        let alive = true
        setLoaded({ status: 'loading' })
        setSelected(null)
        // 详情 + 版本时间线并行：`/rules/versions` 带 git 提交，详情 history 只有快照正文；
        // 任一接口缺失都退回另一条，抽屉历史不能因为一个新端点没上线就变空。
        Promise.all([
          callJson('/rules/' + encodeURIComponent(ruleKey)),
          callJson('/rules/versions?key=' + encodeURIComponent(ruleKey)).catch(() => null),
        ]).then(([body, versionsBody]) => {
          if (!alive) return
          const rule = (body && body.rule) || {}
          const history = Array.isArray(body && body.history)
            ? body.history
            : Array.isArray(rule.history) ? rule.history : []
          const versions = versionsBody && Array.isArray(versionsBody.versions) ? versionsBody.versions : []
          const merged = versions.length > 0 ? mergeRuleVersions(history, versions) : history
          setLoaded({ status: 'ok', rule, history: merged })
        }).catch((err) => {
          if (alive) setLoaded({ status: 'error', err })
        })
        return () => { alive = false }
      }, [ruleKey, refreshTick, retryTick])

      /**
       * 选中历史版本后先问服务端要 diff（R5 契约 `{oldText,newText,diff:[{type,text}]}`）；
       * 服务端失败/形状不对就把状态切到 local，渲染时退回本地 lineDiff —— 只读面板在
       * 服务端未上线或没有 git 的机器上必须照样能对比。
       */
      useEffect(() => {
        if (selected === null) {
          setServerDiff({ status: 'idle', rows: null, rev: null })
          return undefined
        }
        let alive = true
        setServerDiff({ status: 'loading', rows: null, rev: String(selected) })
        callJson('/rules/diff?key=' + encodeURIComponent(ruleKey) + '&rev=' + encodeURIComponent(String(selected)))
          .then((body) => {
            if (!alive) return
            const rows = ruleDiffRowsFromServer(body)
            setServerDiff(rows
              // 以「请求时选中的 rev」为准：服务端回显格式不同也不能让 diff 被当成本地兜底。
              ? { status: 'ok', rows, rev: String(selected) }
              : { status: 'local', rows: null, rev: String(selected) })
          }).catch(() => {
            if (alive) setServerDiff({ status: 'local', rows: null, rev: String(selected) })
          })
        return () => { alive = false }
      }, [ruleKey, refreshTick, selected])

      /** 回滚：生成新版本、历史不删除；成功后由父级 reloadTick 刷新列表/详情/AGENTS。 */
      const revert = async (rule, item) => {
        if (!item || revertBusy) return
        if (!askConfirm(t('rules.revertConfirm'))) return
        setRevertBusy(true)
        setFeedback(null)
        try {
          const body = await callJson('/rules/revert', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ key: String(rule.key || ruleKey), rev: String(item.rev) }),
          })
          setSelected(null)
          setFeedback({ status: 'ok', kind: 'revert', rev: String(item.rev), commit: body && body.commit ? String(body.commit) : '' })
          if (typeof onChanged === 'function') {
            onChanged({ kind: 'revert', changed: true, commit: body && body.commit ? String(body.commit) : '', rev: String(item.rev) })
          }
        } catch (err) {
          setFeedback({
            status: 'error',
            kind: 'revert',
            code: (err && err.code) || 'unknown_error',
            detail: err && err.body ? err.body.detail : null,
          })
        } finally {
          setRevertBusy(false)
        }
      }

      /**
       * 停用 / 重新启用：走 POST /rules/delete {key,mode:'retire'|'reactivate'}。
       * Why 二次确认写清保留项：停用会立刻不再注入/生效，但文件、历史与编号都保留、可随时
       * 重新启用；老文案只写「退役」会让小白以为文件被删。默认铁律再多一句专属提示。
       */
      const toggleStatus = async (rule) => {
        if (statusBusy) return
        const current = String((rule && rule.status) || '').trim()
        if (!ruleCanToggleStatus(current)) return
        const mode = ruleRetireMode(current)
        const confirmText = mode === 'retire'
          ? t('rules.retireConfirm') + (ruleIsDefault(rule) ? '\n\n' + t('rules.retireDefaultHint') : '')
          : t('rules.reactivateConfirm')
        if (!askConfirm(confirmText)) return
        setStatusBusy(true)
        setFeedback(null)
        try {
          const body = await callJson('/rules/delete', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ key: String((rule && rule.key) || ruleKey), mode }),
          })
          const nextStatus = body && body.status
            ? String(body.status)
            : (mode === 'reactivate' ? 'active' : 'retired')
          setFeedback({ status: 'ok', kind: 'status', mode, status: nextStatus })
          if (typeof onChanged === 'function') {
            onChanged({ kind: mode === 'reactivate' ? 'reactivate' : 'retire', status: nextStatus })
          }
        } catch (err) {
          setFeedback({
            status: 'error',
            kind: 'status',
            code: (err && err.code) || 'unknown_error',
            detail: err && err.body ? err.body.detail : null,
          })
        } finally {
          setStatusBusy(false)
        }
      }

      /**
       * 编辑成功：关弹层、抽屉内给成功提示，并让父级刷新详情/列表/AGENTS（同一 reloadTick）。
       */
      const onEditSaved = (event) => {
        setEditOpen(false)
        setSelected(null)
        setFeedback({
          status: 'ok',
          kind: 'edit',
          changed: !(event && event.changed === false),
          commit: (event && event.commit) || '',
        })
        if (typeof onChanged === 'function') onChanged(event || { kind: 'edit', changed: true })
      }

      /**
       * 彻底删除（purge）：走 POST /rules/delete {key,mode:'purge'}。
       *
       * Why 与「停用」分开一个按钮：停用只是不再注入、文件/编号/历史都还在；purge 会物理删
       * 规则文件、编号作废且永不复用，属于不可撤销动作。确认文案必须把四件事写全：
       * 文件被删、不可撤销、编号作废、历史快照仍可在 git/history 追溯；默认铁律另加一句
       * "删除后不会自动恢复"（播种只做一次）。
       *
       * 成功后直接关抽屉：规则已从列表消失，留着详情只会显示 rule_not_found；父级
       * onChanged 触发 reloadTick，列表/提案/git 一起刷新，topbar 提示编号作废与下一个编号。
       */
      const purgeRuleNow = async (rule) => {
        if (purgeBusy || statusBusy) return
        const purgeKey = String((rule && rule.key) || ruleKey)
        // 输入不符直接不发请求：这是不可撤销动作的唯一确认闸（不用 window.confirm 代替）。
        if (String(purgeKeyInput || '').trim() !== purgeKey) {
          setFeedback({ status: 'error', kind: 'purge', code: 'confirm_required', detail: null })
          return
        }
        setPurgeBusy(true)
        setFeedback(null)
        try {
          const body = await callJson('/rules/delete', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ key: purgeKey, mode: 'purge', confirmKey: purgeKey }),
          })
          setSelected(null)
          setPurgeKeyInput('')
          const event = {
            kind: 'purge',
            number: body && body.number !== undefined ? Number(body.number) : null,
            nextNumber: body && body.nextNumber !== undefined ? Number(body.nextNumber) : null,
            retiredNumbers: Array.isArray(body && body.retiredNumbers) ? body.retiredNumbers : [],
            commit: body && body.commit ? String(body.commit) : '',
          }
          setFeedback({ status: 'ok', ...event })
          if (typeof onChanged === 'function') onChanged(event)
          // 规则已不存在：关抽屉，别让父级再用旧 key 拉详情。
          if (typeof onClose === 'function') onClose()
        } catch (err) {
          setFeedback({
            status: 'error',
            kind: 'purge',
            code: (err && err.code) || 'unknown_error',
            detail: err && err.body ? err.body.detail : null,
          })
        } finally {
          setPurgeBusy(false)
        }
      }

      /**
       * 恢复默认（仅安装自带默认铁律 + 后端提供能力时出现）：
       * 用包内默认正文覆盖并生成新版本，历史保留；能力未上线时按钮根本不渲染。
       */
      const restoreDefaultRule = async (rule) => {
        if (restoreBusy || !(capabilities && capabilities.restoreDefault === true)) return
        if (!askConfirm(t('rules.restoreDefaultConfirm'))) return
        setRestoreBusy(true)
        setFeedback(null)
        try {
          await callJson('/rules/restore-default', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ key: String((rule && rule.key) || ruleKey) }),
          })
          setSelected(null)
          setFeedback({ status: 'ok', kind: 'restore' })
          if (typeof onChanged === 'function') onChanged({ kind: 'restore', changed: true })
        } catch (err) {
          setFeedback({
            status: 'error',
            kind: 'restore',
            code: (err && err.code) || 'unknown_error',
            detail: err && err.body ? err.body.detail : null,
          })
        } finally {
          setRestoreBusy(false)
        }
      }

      let body = null
      if (loaded.status === 'loading') body = h(StateBlock, { t, status: 'loading' })
      else if (loaded.status === 'error') {
        // 详情失败必须能重试：规则文件/git 抖动时用户不该只能关掉抽屉再点一遍。
        body = h(StateBlock, { t, status: 'error', err: loaded.err, onRetry: () => setRetryTick((v) => v + 1) })
      }
      else {
        const rule = loaded.rule || {}
        const text = String(rule.text || '')
        const history = loaded.history || []
        const selectedItem = selected === null
          ? null
          : history.find((item) => item && String(item.rev) === String(selected))
        const currentRev = ruleCurrentRev(rule, history)
        const selectedIsCurrent = selectedItem !== null && currentRev !== null
          && String(selectedItem.rev) === currentRev
        const statusKey = String(rule.status || '').trim().toLowerCase()
        const isRetired = statusKey === 'retired'
        const canToggle = ruleCanToggleStatus(statusKey)
        let diffBody = null
        if (selectedItem) {
          // 服务端 diff 优先；未拿到（未上线/失败/形状不对）就本地逐行对比，并说明来源。
          const serverRows = selected === null || serverDiff.rev !== String(selected) ? null : serverDiff.rows
          // git 提交条目在 versions 里没有正文：没有旧正文时不做本地 diff（否则会把全文误报成新增）。
          const localRows = typeof selectedItem.text === 'string' && selectedItem.text !== ''
            ? lineDiff(selectedItem.text, text)
            : null
          const rows = Array.isArray(serverRows) ? serverRows : (localRows || [])
          const sourceNote = Array.isArray(serverRows) || localRows
            ? null
            : serverDiff.status === 'loading' ? t('rules.diffLoading') : t('rules.diffServerFail')
          diffBody = h('div', { style: css.rulesDiff },
            h('div', { style: css.fieldLabel }, t('rules.diff')),
            h('div', { style: css.inline },
              h('span', { style: css.rulesDiffTagOld }, t('rules.diffOld') + ' · ' + String(selectedItem.rev || '—')),
              h('span', { style: css.rulesDiffTagNew }, t('rules.diffNew'))),
            rows.length > 0 || localRows ? h(RulesDiffRows, { t, rows }) : null,
            sourceNote ? h('div', { style: css.tertiary }, sourceNote) : null,
            selectedIsCurrent ? h('div', { style: css.tertiary }, t('rules.currentRevHint')) : null)
        } else {
          diffBody = h('div', { style: css.tertiary }, t('rules.historyHint'))
        }

        /** 抽屉内反馈（写动作成功/失败都留在详情里，不被外层遮罩挡住）。 */
        let feedbackNode = null
        if (feedback) {
          if (feedback.status === 'ok') {
            feedbackNode = h('div', { style: css.ok },
              feedback.kind === 'revert'
                ? t('rules.revertDone') + ' · ' + t('rules.agentsSynced')
                : feedback.kind === 'restore'
                  ? t('rules.restoreDefaultDone')
                  : feedback.kind === 'status'
                  ? (feedback.mode === 'reactivate' ? t('rules.reactivateDone') : t('rules.retireDone'))
                  : feedback.kind === 'purge'
                    ? t('rules.purgeDone')
                    : (feedback.changed === false
                      ? t('rules.editNoChange')
                      : t('rules.editDone') + ' · ' + t('rules.agentsSynced')))
          } else {
            const detail = ruleErrorDetailText(feedback.detail)
            feedbackNode = h('div', { style: css.errorBox, role: 'alert' },
              h('div', { style: css.error },
                t('rules.opFailed') + ' [' + feedback.code + '] — ' + errText(t, { code: feedback.code })),
              detail ? h('div', { style: css.tertiary }, t('rules.errInvalidDetail', { detail })) : null,
              feedback.code === 'git_required' ? h('div', { style: css.warn }, t('rules.errGitHint')) : null)
          }
        }

        body = h('div', { style: css.stack },
          h('div', { style: css.fieldLabel }, t('rules.detailTitle')),
          h('div', { style: css.inline },
            h('div', { style: { ...css.cardTitle, flex: 1, wordBreak: 'break-word' } },
              String(rule.title || rule.key || ruleKey)),
            isRetired
              ? h('span', { style: css.rulesRetiredBadge }, t('rules.retiredBadge'))
              : h(RulesStatusBadge, { t, value: rule.status }),
            h('button', { style: css.button, onClick: onClose }, t('common.close'))),
          h('div', { style: css.tertiary }, String(rule.key || ruleKey)),
          ruleIsDefault(rule) ? h('div', { style: css.rulesDefaultNote }, t('rules.defaultOriginNote')) : null,
          h('div', { style: css.metaGrid },
            h(Row, { k: t('rules.fieldNumber'), v: Number.isFinite(Number(rule.number)) ? String(rule.number) : '—' }),
            h(Row, { k: t('rules.fieldType'), v: ruleTypeLabel(t, rule.type) }),
            h(Row, { k: t('rules.fieldPriority'), v: rule.priority !== undefined && rule.priority !== null ? String(rule.priority) : '—' }),
            h(Row, { k: t('rules.fieldScope'), v: rule.scope || '—' }),
            h(Row, { k: t('rules.fieldRole'), v: rule.role || '—' }),
            h(Row, { k: t('rules.fieldStatus'), v: ruleStatusLabel(t, rule.status) }),
            h(Row, { k: t('rules.fieldCreated'), v: fmtTime(rule.created, locale) }),
            h(Row, { k: t('rules.fieldUpdated'), v: fmtTime(rule.updated, locale) }),
            h(Row, { k: t('rules.fieldVersion'), v: rule.version !== undefined && rule.version !== null ? String(rule.version) : '—' }),
            h(Row, { k: t('rules.fieldOrigin'), v: ruleFieldText(rule.origin) || '—' }),
            h(Row, { k: t('rules.fieldPath'), v: rule.path || '—' }),
            h(Row, { k: t('rules.fieldMergedInto'), v: rule.merged_into || '—' }),
            h(Row, { k: t('rules.fieldSupersededBy'), v: rule.superseded_by || '—' })),
          h('div', { style: css.metaBlock },
            h(SectionTitle, null, t('rules.bodyTitle')),
            h('pre', { style: css.rulesBody, 'data-wm-scroll': 'drawer' }, text || '—')),
          h('div', { style: css.metaBlock },
            h(SectionTitle, null, t('rules.conditions')),
            ruleList(rule.conditions, t)),
          h('div', { style: css.metaBlock },
            h(SectionTitle, null, t('rules.exceptions')),
            ruleList(rule.exceptions, t)),
          h('div', { style: css.metaBlock },
            h(SectionTitle, null, t('rules.history')),
            history.length === 0
              ? h('div', { style: css.tertiary }, t('rules.historyEmpty'))
              // 30 是业务上限（最近的版本足够回滚），容器不设高：纵向交给页根本体。
              : h('div', { style: css.stack }, history.slice(0, 30).map((item, index) => {
                const rev = String((item && item.rev) || index)
                const source = String((item && item.source) || 'snapshot')
                const isCurrent = currentRev !== null && String(rev) === currentRev
                return h('button', {
                  key: rev,
                  style: selected === rev ? css.rulesHistoryActive : css.rulesHistoryRow,
                  onClick: () => setSelected((prev) => (prev === rev ? null : rev)),
                },
                h('span', { style: css.rulesHistoryRev }, rev),
                item && item.subject
                  ? h('span', { style: css.rulesHistorySubject }, String(item.subject).slice(0, 120))
                  : null,
                isCurrent ? h('span', { style: css.rulesHistoryCurrent }, t('rules.currentRev')) : null,
                h('span', { style: css.tertiary }, fmtTime(item && item.ts, locale)),
                h('span', { style: css.rulesHistorySource },
                  source === 'git' ? t('rules.historySourceGit') : t('rules.historySourceSnapshot')))
              })),
            diffBody),
          feedbackNode,
          h('div', { style: css.inline },
            h('button', {
              style: !canToggle || statusBusy ? css.buttonDisabled : (isRetired ? css.button : css.buttonWarn),
              disabled: !canToggle || statusBusy,
              onClick: () => toggleStatus(rule),
              title: canToggle
                ? (isRetired ? t('rules.reactivateConfirm') : t('rules.retireConfirm'))
                : t('rules.toggleUnavailable'),
            }, statusBusy ? t('common.saving') : (isRetired ? t('rules.reactivate') : t('rules.retire'))),
            h('button', {
              style: !selectedItem || selectedIsCurrent || revertBusy ? css.buttonDisabled : css.buttonWarn,
              disabled: !selectedItem || selectedIsCurrent || revertBusy,
              onClick: () => revert(rule, selectedItem),
              title: !selectedItem
                ? t('rules.rollbackSelectHint')
                : selectedIsCurrent ? t('rules.rollbackCurrentHint') : t('rules.rollbackHint'),
            }, revertBusy ? t('rules.revertBusy') : t('rules.rollback')),
            // 恢复默认只在「安装自带默认铁律 + 后端提供能力」时出现；能力未上线直接隐藏。
            ruleIsDefault(rule) && capabilities && capabilities.restoreDefault === true
              ? h('button', {
                style: restoreBusy ? css.buttonDisabled : css.button,
                disabled: Boolean(restoreBusy),
                onClick: () => restoreDefaultRule(rule),
                title: t('rules.restoreDefaultConfirm'),
              }, restoreBusy ? t('common.saving') : t('rules.restoreDefault'))
              : null,
            h('button', {
              style: css.buttonPrimary,
              onClick: () => setEditOpen(true),
            }, t('rules.edit'))),
          h('div', { style: css.metaBlock },
            h(SectionTitle, null, t('rules.purge')),
            h('div', { style: css.errorBox, role: 'group', 'aria-label': t('rules.purgeHint') },
              h('div', { style: css.error }, t('rules.purgeConfirm')),
              ruleIsDefault(rule) ? h('div', { style: css.warn }, t('rules.purgeDefaultHint')) : null,
              h('div', { style: css.fieldLabel }, t('rules.purgeKeyLabel', { key: String(rule.key || ruleKey) })),
              h(TextInput, {
                value: purgeKeyInput,
                placeholder: t('rules.purgeKeyPlaceholder'),
                onChange: (next) => setPurgeKeyInput(next),
                disabled: purgeBusy || statusBusy,
              }),
              h('button', {
                style: purgeBusy || statusBusy || String(purgeKeyInput || '').trim() !== String(rule.key || ruleKey)
                  ? css.buttonDisabled
                  : css.buttonDanger,
                disabled: purgeBusy || statusBusy || String(purgeKeyInput || '').trim() !== String(rule.key || ruleKey),
                onClick: () => purgeRuleNow(rule),
                title: t('rules.purgeHint'),
              }, purgeBusy ? t('common.saving') : t('rules.purge')))))
      }

      return h('div', { style: css.drawerMask, onClick: onClose },
        h('aside', {
          style: css.rulesDrawer,
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': t('rules.detailTitle'),
          tabIndex: -1,
          autoFocus: true,
          onClick: (e) => e.stopPropagation(),
          onKeyDown: (event) => trapDialogFocus(event),
        },
          body,
          editOpen && loaded.status === 'ok'
            ? h(RulesEditDialog, {
              t, locale,
              rule: loaded.rule || {},
              history: loaded.history || [],
              onClose: () => setEditOpen(false),
              onSaved: onEditSaved,
            })
            : null))
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
      const { t, locale, recallCfg, onScrollReset } = props
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
        callJson(withIdentity('/recalls?limit=20' + suffix)).then((body) => {
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
            body: JSON.stringify({ query: q, maxHits: 10, ...(identityFields() || {}) }),
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
        recentBody = h('div', { style: { overflowX: 'auto', overflowY: 'clip', scrollbarWidth: 'thin', scrollbarColor: 'var(--dsw-alias-border-l1) transparent' } },
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
              onClick: () => {
                setFilter(value)
                if (typeof onScrollReset === 'function') onScrollReset()
              },
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
      const [onlyWrap, setOnlyWrap] = useState(false)
      const [reloadTick, setReloadTick] = useState(0)

      useEffect(() => {
        let alive = true
        // 候选只查 action=CANDIDATE（宿主支持服务端过滤），不再前端过滤最近 50 条。
        setCandidates((prev) => ({ ...prev, status: 'loading' }))
        callJson(withIdentity('/writes?action=CANDIDATE&limit=100')).then((body) => {
          if (alive) setCandidates({ status: 'ok', items: Array.isArray(body.items) ? body.items : [] })
        }).catch((err) => {
          if (alive) setCandidates({ status: 'error', items: [], err })
        })
        setWrites((prev) => ({ ...prev, status: 'loading' }))
        callJson(withIdentity('/writes?limit=50')).then((body) => {
          if (alive) setWrites({ status: 'ok', items: Array.isArray(body.items) ? body.items : [] })
        }).catch((err) => {
          if (alive) setWrites({ status: 'error', items: [], err })
        })
        setEdges((prev) => ({ ...prev, status: 'loading' }))
        callJson(withIdentity('/edges')).then((body) => {
          if (alive) setEdges({ status: 'ok', data: body })
        }).catch((err) => {
          if (alive) setEdges({ status: 'error', data: null, err })
        })
        setEvolution((prev) => ({ ...prev, status: 'loading' }))
        callJson(withIdentity('/evolution?limit=10')).then((body) => {
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
            body: JSON.stringify({ id, decision: action, reason: String(review.reason || '').slice(0, 200), identity: identityFields() }),
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
              body: JSON.stringify({ patch: { text: rewritten }, ...(identityFields() || {}) }),
            })
          }
          setReview((prev) => ({ ...prev, status: 'ok', id, code: '' }))
          setReloadTick((x) => x + 1)
        } catch (err) {
          setReview((prev) => ({ ...prev, status: 'error', id, code: (err && err.code) || 'unknown_error' }))
        }
      }

      const wrapCandidates = candidates.items.filter((item) => item && item.origin === 'session-wrap')
      const visibleCandidates = onlyWrap ? wrapCandidates : candidates.items
      let pendingBody = null
      if (candidates.status === 'loading') pendingBody = h(StateBlock, { t, status: 'loading' })
      else if (candidates.status === 'error') pendingBody = h(StateBlock, { t, status: 'error', err: candidates.err })
      else if (visibleCandidates.length === 0) {
        pendingBody = h(StateBlock, {
          t, status: 'empty',
          empty: onlyWrap && candidates.items.length > 0 ? t('writes.pendingNoWrap') : t('writes.pendingEmpty'),
        })
      } else {
        pendingBody = h('div', { style: { overflowX: 'auto', overflowY: 'clip', scrollbarWidth: 'thin', scrollbarColor: 'var(--dsw-alias-border-l1) transparent' } },
          h('table', { style: css.table },
            h('thead', null, h('tr', null,
              h('th', { style: css.th }, t('writes.colTime')),
              h('th', { style: css.th }, t('writes.colText')),
              h('th', { style: css.th }, t('writes.colReason')))),
            h('tbody', null, visibleCandidates.map((item, index) => h('tr', { key: (item && item.id) || index },
              h('td', { style: css.td }, fmtTime(item && item.ts, locale)),
              h('td', { style: css.td },
                item && item.origin === 'session-wrap'
                  ? h('span', { style: css.badgeChip }, t('writes.originSessionWrap')) : null,
                String((item && item.after_text) || '—').slice(0, 140)),
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
        h('div', { style: css.inline },
          h('button', {
            style: onlyWrap ? css.buttonPrimary : css.button,
            onClick: () => setOnlyWrap((value) => !value),
          }, t('writes.filterWrap', { n: wrapCandidates.length }))),
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
        body = h('div', { style: { overflowX: 'auto', overflowY: 'clip', scrollbarWidth: 'thin', scrollbarColor: 'var(--dsw-alias-border-l1) transparent' } },
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
        edgesBody = h('div', { style: { overflowX: 'auto', overflowY: 'clip', scrollbarWidth: 'thin', scrollbarColor: 'var(--dsw-alias-border-l1) transparent' } },
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
    /** 设置分组顺序：召回→写入→身份→规则→接入→同步→反思→巩固→隐私→边界→面板→高级→未启用能力。 */
    const SETTINGS_GROUP_ORDER = Object.freeze([
      'recall', 'write', 'tools', 'identity', 'rules', 'backend', 'sync',
      'reflect', 'wrap', 'consolidate', 'privacy', 'edges', 'panel', 'advanced', 'embed',
    ])
    /** 首屏展开的四组（其余默认收起，避免一屏 13 组把新手淹没）。 */
    const SETTINGS_CORE_GROUP_KEYS = new Set([
      'settings.groupRecall', 'settings.groupWrite', 'settings.groupIdentity', 'settings.groupRules',
    ])
    const SETTINGS_OPEN_STORAGE_KEY = 'wm.settings.open.v1'

    const FIRST_RUN_STORAGE_KEY = 'wm.firstRunSeen.v1'

    /** 首启向导是否已处理过（跳过/应用/保存过配置都算处理）。 */
    function readFirstRunSeen() {
      try { return globalThis.localStorage ? globalThis.localStorage.getItem(FIRST_RUN_STORAGE_KEY) === '1' : false } catch { return false }
    }

    /** 记首启已处理：失败不影响本次会话（仅下次可能再弹一次推荐卡）。 */
    function markFirstRunSeen() {
      try { globalThis.localStorage && globalThis.localStorage.setItem(FIRST_RUN_STORAGE_KEY, '1') } catch { /* 存储不可用 */ }
    }

    /**
     * 首启判定：全部设置叶子都等于内置默认值（profile 注入的 sync.bridgeUrl 不计入用户改动）。
     * 已有用户配置时返回 false → 推荐卡不出现，绝不覆盖既有值。
     */
    function configIsDefaults(cfg) {
      if (!cfg) return false
      for (const [key, meta] of Object.entries({ ...SETTINGS_META, ...RULES_SETTINGS_META })) {
        if (!meta || !Object.prototype.hasOwnProperty.call(meta, 'def')) continue
        // 这两个不是「行为配置」：bridgeUrl 由 profile 注入，panel.tab 只是上次停留在哪页。
        if (key === 'sync.bridgeUrl' || key === 'panel.tab') continue
        // 逐层下钻：Config 现在有 `wrap.ingest.mode` 这类三层叶子，split('.') 只取两层会恒 undefined。
        let current = cfg
        for (const part of key.split('.')) {
          current = current && typeof current === 'object' ? current[part] : undefined
        }
        if (JSON.stringify(current) !== JSON.stringify(meta.def)) return false
      }
      return !cfg.dataDir
    }

    /** 读某组展开状态：localStorage 不可用/坏 JSON 时回默认，不阻断面板。 */
    function readGroupOpen(key, fallback) {
      try {
        const raw = globalThis.localStorage && globalThis.localStorage.getItem(SETTINGS_OPEN_STORAGE_KEY)
        const map = raw ? JSON.parse(raw) : null
        return map && typeof map[key] === 'boolean' ? map[key] : fallback
      } catch { return fallback }
    }

    /** 记某组展开状态：写失败静默（隐私模式/localStorage 被禁仍可用面板）。 */
    function writeGroupOpen(key, open) {
      try {
        if (!globalThis.localStorage) return
        const raw = globalThis.localStorage.getItem(SETTINGS_OPEN_STORAGE_KEY)
        let map = {}
        try { map = raw ? JSON.parse(raw) : {} } catch { map = {} }
        map[key] = Boolean(open)
        globalThis.localStorage.setItem(SETTINGS_OPEN_STORAGE_KEY, JSON.stringify(map))
      } catch { /* 存储不可用：只影响下次是否记住，不影响本次交互 */ }
    }

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
      'write.searchFeed': { def: false, effect: 'instant', badge: 'general', recommend: true },
      'write.searchTtlHours': { def: 24, effect: 'instant', badge: 'general' },
      'write.model': {
        def: '', effect: 'reload', badge: 'general',
        dependsOn: { group: 'write', key: 'judge', equals: 'llm', reasonKey: 'settings.depWriteModel' },
      },
      'write.ignorePatterns': { def: [], effect: 'reload', badge: 'general' },
      'tools.enabled': { def: true, effect: 'instant', badge: 'general', recommend: true },
      'tools.maxWritesPerTurn': { def: 5, effect: 'instant', badge: 'general' },
      'reflect.enabled': { def: false, effect: 'reload', badge: 'general', recommend: true },
      'reflect.model': { def: '', effect: 'reload', badge: 'general' },
      'reflect.idleMinutes': { def: 30, effect: 'reload', badge: 'general' },
      'reflect.maxItems': { def: 8, effect: 'instant', badge: 'general' },
      'reflect.maxRunsPerDay': { def: 24, effect: 'reload', badge: 'general' },
      'wrap.enabled': { def: true, effect: 'instant', badge: 'general', recommend: true },
      'wrap.explicit': { def: true, effect: 'instant', badge: 'general' },
      'wrap.idle': { def: false, effect: 'instant', badge: 'general' },
      'wrap.disposed': { def: false, effect: 'instant', badge: 'general' },
      'wrap.idleMinutes': { def: 10, effect: 'reload', badge: 'general' },
      'wrap.maxItems': { def: 8, effect: 'instant', badge: 'general' },
      'wrap.ingest.mode': { def: 'auto', effect: 'instant', badge: 'general' },
      'wrap.ingest.minConfidence': { def: 0.55, effect: 'instant', badge: 'general' },
      'wrap.ingest.dropTaskInstructions': { def: true, effect: 'instant', badge: 'general' },
      'wrap.spoolTtlHours': { def: 24, effect: 'reload', badge: 'local' },
      'wrap.retentionDays': { def: 180, effect: 'reload', badge: 'local' },
      'wrap.maxRunsPerDay': { def: 6, effect: 'reload', badge: 'general' },
      'wrap.report': { def: true, effect: 'instant', badge: 'general' },
      'wrap.model': { def: '', effect: 'reload', badge: 'general' },
      'wrap.maxMaterialChars': { def: 12000, effect: 'reload', badge: 'general' },
      'wrap.timeoutMs': { def: 60000, effect: 'reload', badge: 'general' },
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
      'sync.enabled': { def: false, effect: 'instant', badge: 'needsConfig', recommend: true },
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
        // 全部分段用 - 连接：三层叶子（wrap.ingest.mode）与卡片 id `wm-wrap-ingest-mode` 对齐。
        out['wm-' + key.split('.').join('-')] = meta
      }
      return out
    })()

    // >>> rules-settings:contract
    // rules.* 设置元数据单独成块而不并入 SETTINGS_META：SETTINGS_META 与 src/host/config.js
    // 的 13 组 / 54 字段逐项对齐（既有契约测试锁死），规则组由 R3a 服务端并行落地；
    // 分成两块可以各自演进，UI 仍复用同一套 FieldCard/SwitchCard 与默认值/生效/依赖渲染。
    const RULES_SETTINGS_META = {
      'rules.enabled': { def: true, effect: 'instant', badge: 'general' },
      'rules.dir': { def: '', effect: 'reload', badge: 'local' },
      'rules.requireGit': { def: false, effect: 'reload', badge: 'local' },
      'rules.askMode': {
        def: 'panel+chat', effect: 'reload', badge: 'general',
        dependsOn: { group: 'rules', key: 'enabled', equals: true, reasonKey: 'settings.depRulesEnabled' },
      },
      'rules.llm': {
        def: false, effect: 'instant', badge: 'needsConfig', recommend: true,
        dependsOn: { group: 'rules', key: 'enabled', equals: true, reasonKey: 'settings.depRulesEnabled' },
      },
      'rules.maxProposals': {
        def: 20, effect: 'reload', badge: 'general',
        dependsOn: { group: 'rules', key: 'enabled', equals: true, reasonKey: 'settings.depRulesEnabled' },
      },
      'rules.guardStrict': {
        def: true, effect: 'reload', badge: 'general',
        dependsOn: { group: 'rules', key: 'enabled', equals: true, reasonKey: 'settings.depRulesEnabled' },
      },
      'rules.mirrorAuto': {
        def: true, effect: 'reload', badge: 'local',
        dependsOn: { group: 'rules', key: 'enabled', equals: true, reasonKey: 'settings.depRulesEnabled' },
      },
      'rules.askCooldownDays': {
        def: 30, effect: 'reload', badge: 'general',
        dependsOn: { group: 'rules', key: 'enabled', equals: true, reasonKey: 'settings.depRulesEnabled' },
      },
    }
    // <<< rules-settings:contract

    const RULES_SETTINGS_META_BY_ID = (() => {
      const out = {}
      for (const [key, meta] of Object.entries(RULES_SETTINGS_META)) {
        const dot = key.indexOf('.')
        out['wm-' + key.slice(0, dot) + '-' + key.slice(dot + 1)] = meta
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
      const tools = cfg.tools || {}
      const reflect = cfg.reflect || {}
      const wrap = cfg.wrap || {}
      const wrapIngest = wrap.ingest || {}
      const consolidate = cfg.consolidate || {}
      const embed = cfg.embed || {}
      const privacy = cfg.privacy || {}
      const edges = cfg.edges || {}
      const sync = cfg.sync || {}
      const panel = cfg.panel || {}
      const advanced = cfg.advanced || {}
      const rules = cfg.rules || {}
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
        tools: {
          enabled: tools.enabled !== false,
          maxWritesPerTurn: n(tools.maxWritesPerTurn, 5),
        },
        rules: {
          enabled: rules.enabled !== false,
          dir: typeof rules.dir === 'string' ? rules.dir : '',
          requireGit: rules.requireGit === true,
          askMode: oneOf(rules.askMode, ['panel+chat', 'panel', 'off'], 'panel+chat'),
          llm: rules.llm === true,
          maxProposals: n(rules.maxProposals, 20),
          guardStrict: rules.guardStrict !== false,
          mirrorAuto: rules.mirrorAuto !== false,
          askCooldownDays: n(rules.askCooldownDays, 30),
        },
        reflect: {
          enabled: reflect.enabled === true,
          model: reflect.model || '',
          idleMinutes: n(reflect.idleMinutes, 30),
          maxItems: n(reflect.maxItems, 8),
          maxRunsPerDay: n(reflect.maxRunsPerDay, 24),
        },
        wrap: {
          enabled: wrap.enabled !== false,
          explicit: wrap.explicit !== false,
          idle: wrap.idle === true,
          disposed: wrap.disposed === true,
          idleMinutes: n(wrap.idleMinutes, 10),
          maxItems: n(wrap.maxItems, 8),
          ingest: {
            mode: oneOf(wrapIngest.mode, ['auto', 'review'], 'auto'),
            minConfidence: n(wrapIngest.minConfidence, 0.55),
            dropTaskInstructions: wrapIngest.dropTaskInstructions !== false,
          },
          spoolTtlHours: n(wrap.spoolTtlHours, 24),
          retentionDays: n(wrap.retentionDays, 180),
          maxRunsPerDay: n(wrap.maxRunsPerDay, 6),
          report: wrap.report !== false,
          model: wrap.model || '',
          maxMaterialChars: n(wrap.maxMaterialChars, 12000),
          timeoutMs: n(wrap.timeoutMs, 60000),
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
        [draft.wrap.idleMinutes, 5, 1440],
        [draft.wrap.maxItems, 1, 32],
        [draft.wrap.spoolTtlHours, 1, 720],
        [draft.wrap.retentionDays, 0, 3650],
        [draft.wrap.maxRunsPerDay, 1, 96],
        [draft.wrap.maxMaterialChars, 1000, 50000],
        [draft.wrap.timeoutMs, 5000, 600000],
        [draft.consolidate.intervalHours, 1, 168],
        [draft.embed.batch, 1, 128],
        [draft.privacy.retentionDays, 0, 3650],
        [draft.edges.minConf, 0, 1],
        [draft.sync.intervalMin, 1, 10080],
        [draft.sync.httpTimeoutMs, 200, 30000],
        [draft.sync.batch, 1, 500],
        [draft.panel.pollMs, 5000, 600000],
        [draft.rules.maxProposals, 1, 200],
        [draft.rules.askCooldownDays, 0, 3650],
      ]
      return checks.some(([value, min, max]) => {
        const x = Number(value)
        return !Number.isFinite(x) || x < min || x > max
      })
    }

    /**
     * 设置分组卡：可折叠（WP2 信息架构）。
     * - 用 titleKey 让卡片自己取文案与持久化键，调用方不重复传 t()/key；
     * - 首屏四组（召回/写入/身份/规则）默认展开，其余默认收起；展开状态记在 localStorage；
     * - 危险区（danger）恒展开：安全提示不允许被折叠藏起来。
     */
    function GroupCard(props) {
      const { titleKey, title: rawTitle, desc, children, t } = props
      const title = titleKey ? t(titleKey) : rawTitle
      const alwaysOpen = titleKey === 'settings.groupDanger'
      const [open, setOpen] = useState(() => alwaysOpen || readGroupOpen(titleKey, SETTINGS_CORE_GROUP_KEYS.has(titleKey)))
      const toggle = () => {
        if (alwaysOpen) return
        setOpen((prev) => {
          const next = !prev
          writeGroupOpen(titleKey, next)
          return next
        })
      }
      return h(Card, null,
        alwaysOpen
          ? h('div', { style: css.groupHeadRow }, h('span', { style: css.cardTitle }, title))
          : h('button', {
            type: 'button', style: css.groupHeadBtn, onClick: toggle,
            'aria-expanded': open ? 'true' : 'false',
            'aria-controls': 'settings-group-' + titleKey + '-body',
          },
            h('span', { style: css.groupCaret }, open ? '▾' : '▸'),
            h('span', { style: css.cardTitle }, title),
            h('span', { style: css.groupToggleHint }, open ? t('settings.collapse') : t('settings.expand'))),
        desc ? h('div', { style: css.groupDesc }, desc) : null,
        open
          ? h('div', {
            id: alwaysOpen ? undefined : 'settings-group-' + titleKey + '-body',
            style: css.groupBody,
          }, children)
          : null)
    }

    function SettingsTab(props) {
      const activeLocale = useActiveLocale()
      const { t, onSaved } = props
      // 设置分区（settings.section）只注入 t；locale 由当前语言派生，保证与面板一致。
      const locale = props.locale || activeLocale
      const [load, setLoad] = useState({ status: 'loading' })
      const [draft, setDraft] = useState(null)
      const [save, setSave] = useState({ status: 'idle', code: '', at: 0, refreshFailed: false })
      // 服务端基线：保存只提交与它不同的叶子，避免把全部默认值钉进 profile patch
      // （宿主默认值升级/迁移会因此永久失效；审计 P1-16）。
      const serverRef = useRef(null)

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
          serverRef.current = next
          setDraft(next)
          setLoad({ status: 'ok' })
        }).catch((err) => setLoad({ status: 'error', err }))
      }

      useEffect(() => { reload() }, [])

      const [firstRun, setFirstRun] = useState({
        open: false, reflect: false, sync: false, wrap: true,
      })
      const firstRunSeenRef = useRef(readFirstRunSeen())

      // 只在「首启 + 全默认配置」时出现：已有配置的用户不弹、不覆盖；已处理过的不重复弹。
      useEffect(() => {
        if (load.status !== 'ok' || firstRunSeenRef.current) return
        if (!configIsDefaults(serverRef.current)) return
        setFirstRun((prev) => (prev.open ? prev : {
          ...prev, open: true,
          sync: Boolean(serverRef.current && serverRef.current.sync && serverRef.current.sync.bridgeUrl),
          wrap: !(serverRef.current && serverRef.current.wrap && serverRef.current.wrap.enabled === false),
        }))
      }, [load.status])

      /** 应用推荐：只覆盖用户勾选项，只提交与基线不同的叶子。 */
      const applyFirstRun = async () => {
        if (!draft) return
        const next = {
          ...draft,
          reflect: { ...draft.reflect, enabled: firstRun.reflect || draft.reflect.enabled },
          // 收尾默认开启但要用户看见“会花模型 token”；取消勾选必须真的关掉。
          wrap: { ...draft.wrap, enabled: Boolean(firstRun.wrap) },
          sync: { ...draft.sync },
        }
        // 同步先以 dry-run 起步：只记待同步项、不改远端；用户确认后自行关预演。
        if (firstRun.sync && draft.sync.bridgeUrl) {
          next.sync = { ...draft.sync, enabled: true, mode: 'both', dryRun: true }
        }
        const okSaved = await persist(next)
        if (!okSaved) return
        markFirstRunSeen()
        firstRunSeenRef.current = true
        setFirstRun((prev) => ({ ...prev, open: false }))
      }

      /** 跳过：只记「已看过」，不改任何配置。 */
      const dismissFirstRun = () => {
        markFirstRunSeen()
        firstRunSeenRef.current = true
        setFirstRun((prev) => ({ ...prev, open: false }))
      }

      const patch = (group, key, value) => {
        setDraft((prev) => (prev ? { ...prev, [group]: { ...prev[group], [key]: value } } : prev))
        setSave((prev) => (prev.status === 'ok' || prev.status === 'error'
          ? { status: 'idle', code: '', at: 0, refreshFailed: false }
          : prev))
      }

      /** 只取与基线不同的叶子（数组/标量按值比较；组按叶子递归）。 */
      const diffConfig = (base, next) => {
        const out = {}
        for (const key of Object.keys(next || {})) {
          const value = next[key]
          if (key === 'dataDir' || value === null || typeof value !== 'object') {
            if (JSON.stringify(base ? base[key] : undefined) !== JSON.stringify(value)) out[key] = value
            continue
          }
          const before = base && base[key] && typeof base[key] === 'object' ? base[key] : {}
          const patch = {}
          for (const leaf of Object.keys(value)) {
            if (JSON.stringify(before[leaf]) !== JSON.stringify(value[leaf])) patch[leaf] = value[leaf]
          }
          if (Object.keys(patch).length) out[key] = patch
        }
        return out
      }

      /**
       * 提交差异配置并回读（保存按钮与首启向导共用同一路径）。
       * 只提交与 serverRef 不同的叶子：避免把全部默认值钉进 profile patch。
       * @param {object} payload 已归一化的完整配置草稿
       * @returns {Promise<boolean>} 是否成功写入（无脏叶子也返回 true）
       */
      const persist = async (payload) => {
        const changed = diffConfig(serverRef.current, payload)
        if (Object.keys(changed).length === 0) {
          // 没有脏叶子：不写 profile（避免“点一下保存就把默认值固化”）。
          setSave({ status: 'ok', code: '', at: Date.now(), refreshFailed: false })
          return true
        }
        setSave({ status: 'saving', code: '', at: 0, refreshFailed: false })
        try {
          await callJson('/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ config: changed }),
          })
        } catch (err) {
          setSave({ status: 'error', code: (err && err.code) || 'unknown_error', at: 0, refreshFailed: false })
          return false
        }
        let next = payload
        let refreshFailed = false
        try {
          const body = await callJson('/config')
          next = carryConfig(payload, body && body.config)
          serverRef.current = next
          setDraft(next)
        } catch {
          refreshFailed = true
          setDraft(next)
        }
        setSave({ status: 'ok', code: '', at: Date.now(), refreshFailed })
        if (onSaved) onSaved(next)
        return true
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
        const okSaved = await persist(payload)
        // 保存过配置就不再是「首次默认状态」：推荐卡不再出现（不会二次打扰）。
        if (okSaved) markFirstRunSeen()
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
        // 规则组元数据独立成块（见 rules-settings:contract），查表合并即可复用同一套卡片渲染。
        const meta = SETTINGS_META_BY_ID[id] || RULES_SETTINGS_META_BY_ID[id] || null
        const depReason = depReasonOf(meta)
        return {
          effect: effectText(meta ? meta.effect : 'reload', t),
          defaultValue: meta ? t('settings.defaultValue', { value: defaultText(meta.def, t, locale) }) : undefined,
          badge: meta ? badgeText(meta.badge, t) : undefined,
          recommend: meta && meta.recommend ? t('settings.recommend') : undefined,
          depReason,
          dependsOn: meta ? meta.dependsOn : undefined,
          disabled: Boolean(depReason),
        }
      }
      const numCard = (id, label, desc, _effect, value, min, max, onChange, opt = {}) => {
        const meta = cardMeta(id)
        return h(FieldCard, {
          id, label, desc, note: opt.note, danger: opt.danger,
          effect: meta.effect, defaultValue: meta.defaultValue, badge: meta.badge, recommend: meta.recommend,
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
          effect: meta.effect, defaultValue: meta.defaultValue, badge: meta.badge, recommend: meta.recommend,
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
          effect: meta.effect, defaultValue: meta.defaultValue, badge: meta.badge, recommend: meta.recommend,
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
          effect: meta.effect, defaultValue: meta.defaultValue, badge: meta.badge, recommend: meta.recommend,
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
          // 已开启的项不再挂「推荐开启」：徽标只在「能开未开」时有信息量。
          recommend: !checked ? meta.recommend : undefined,
          depReason: meta.depReason, dependsOn: meta.dependsOn,
          disabled: Boolean(disabled) || meta.disabled,
        })
      }

      // 信息架构（WP2）：顺序即 DOM 顺序（Tab 与视觉一致）；卡片自己管折叠状态。
      const groupNodes = {
        recall: () => (h(GroupCard, {
            t, titleKey: 'settings.groupRecall', desc: t('settings.groupRecallDesc'),
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
            null, null, false, draft.recall.showSources, (v) => patch('recall', 'showSources', v)))),
        write: () => (h(GroupCard, {
            t, titleKey: 'settings.groupWrite', desc: t('settings.groupWriteDesc'),
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
            draft.write.model, (v) => patch('write', 'model', v)))),
        tools: () => (h(GroupCard, {
            t, titleKey: 'settings.groupTools', desc: t('settings.groupToolsDesc'),
          },
          switchCard(idOf('tools', 'enabled'), t('settings.toolsEnabled'), t('settings.toolsEnabledDesc'),
            null, null, false, (draft.tools || {}).enabled, (v) => patch('tools', 'enabled', v)),
          numCard(idOf('tools', 'maxWritesPerTurn'), t('settings.toolsMaxWritesPerTurn'), t('settings.toolsMaxWritesPerTurnDesc'),
            null, (draft.tools || {}).maxWritesPerTurn, 1, 50, (v) => patch('tools', 'maxWritesPerTurn', v)))),
        identity: () => (h(GroupCard, {
            t, titleKey: 'settings.groupIdentity', desc: t('settings.groupIdentityDesc'),
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
            draft.identity.workspace, (v) => patch('identity', 'workspace', v)))),
        rules: () => (h(GroupCard, {
            t, titleKey: 'settings.groupRules', desc: t('settings.groupRulesDesc'),
          },
          switchCard(idOf('rules', 'enabled'), t('settings.rulesEnabled'), t('settings.rulesEnabledDesc'),
            null, null, false, draft.rules.enabled, (v) => patch('rules', 'enabled', v)),
          textCard(idOf('rules', 'dir'), t('settings.rulesDir'), t('settings.rulesDirDesc'), null,
            draft.rules.dir, (v) => patch('rules', 'dir', v), { placeholder: '~/.dsh/rules' }),
          switchCard(idOf('rules', 'requireGit'), t('settings.rulesRequireGit'), t('settings.rulesRequireGitDesc'),
            null, null, false, draft.rules.requireGit, (v) => patch('rules', 'requireGit', v)),
          selectCard(idOf('rules', 'askMode'), t('settings.rulesAskMode'), t('settings.rulesAskModeDesc'), null,
            draft.rules.askMode, askModeOptions, (v) => patch('rules', 'askMode', v)),
          switchCard(idOf('rules', 'llm'), t('settings.rulesLlm'), t('settings.rulesLlmDesc'),
            null, null, false, draft.rules.llm, (v) => patch('rules', 'llm', v)),
          numCard(idOf('rules', 'maxProposals'), t('settings.rulesMaxProposals'), t('settings.rulesMaxProposalsDesc'),
            null, draft.rules.maxProposals, 1, 200, (v) => patch('rules', 'maxProposals', v)),
          switchCard(idOf('rules', 'guardStrict'), t('settings.rulesGuardStrict'), t('settings.rulesGuardStrictDesc'),
            null, null, false, draft.rules.guardStrict, (v) => patch('rules', 'guardStrict', v)),
          switchCard(idOf('rules', 'mirrorAuto'), t('settings.rulesMirrorAuto'), t('settings.rulesMirrorAutoDesc'),
            null, null, false, draft.rules.mirrorAuto, (v) => patch('rules', 'mirrorAuto', v)),
          numCard(idOf('rules', 'askCooldownDays'), t('settings.rulesAskCooldownDays'), t('settings.rulesAskCooldownDaysDesc'),
            null, draft.rules.askCooldownDays, 0, 3650, (v) => patch('rules', 'askCooldownDays', v)),
          // R9-07：配置层键只在 Rule 配置里生效、不进面板；不写这条用户会以为面板漏了开关。
          h(Note, null, t('settings.rulesConfigLayerNote')))),
        backend: () => (h(GroupCard, {
            t, titleKey: 'settings.groupBackend', desc: t('settings.groupBackendDesc'),
          },
          selectCard(idOf('backend', 'mode'), t('settings.backendMode'), t('settings.backendModeDesc'), null,
            draft.backend.mode, modeOptions, (v) => patch('backend', 'mode', v)),
          textCard(idOf('backend', 'id'), t('settings.backendId'), t('settings.backendIdDesc'), null,
            draft.backend.id, (v) => patch('backend', 'id', v), { placeholder: 'whale-local' }),
          textCard(idOf('backend', 'url'), t('settings.backendUrl'), t('settings.backendUrlDesc'), null,
            draft.backend.url, (v) => patch('backend', 'url', v), { placeholder: 'http://127.0.0.1:8080' }),
          numCard(idOf('backend', 'timeoutMs'), t('settings.backendTimeout'), t('settings.backendTimeoutDesc'), null,
            draft.backend.timeoutMs, 200, 30000, (v) => patch('backend', 'timeoutMs', v)))),
        sync: () => (h(GroupCard, {
            t, titleKey: 'settings.groupSync', desc: t('settings.groupSyncDesc'),
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
            null, null, false, draft.sync.dryRun, (v) => patch('sync', 'dryRun', v)))),
        reflect: () => (h(GroupCard, {
            t, titleKey: 'settings.groupReflect', desc: t('settings.groupReflectDesc'),
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
            draft.reflect.maxRunsPerDay, 1, 96, (v) => patch('reflect', 'maxRunsPerDay', v)))),
        wrap: () => (h(GroupCard, {
            t, titleKey: 'settings.groupWrap', desc: t('settings.groupWrapDesc'),
          },
          switchCard(idOf('wrap', 'enabled'), t('settings.wrapEnabled'), t('settings.wrapEnabledDesc'),
            t('settings.wrapCostNote'), null, false, draft.wrap.enabled, (v) => patch('wrap', 'enabled', v)),
          switchCard(idOf('wrap', 'explicit'), t('settings.wrapExplicit'), t('settings.wrapExplicitDesc'),
            null, null, false, draft.wrap.explicit, (v) => patch('wrap', 'explicit', v)),
          switchCard(idOf('wrap', 'idle'), t('settings.wrapIdle'), t('settings.wrapIdleDesc'),
            null, null, false, draft.wrap.idle, (v) => patch('wrap', 'idle', v)),
          switchCard(idOf('wrap', 'disposed'), t('settings.wrapDisposed'), t('settings.wrapDisposedDesc'),
            null, null, false, draft.wrap.disposed, (v) => patch('wrap', 'disposed', v)),
          numCard(idOf('wrap', 'idleMinutes'), t('settings.wrapIdleMinutes'), t('settings.wrapIdleMinutesDesc'), null,
            draft.wrap.idleMinutes, 5, 1440, (v) => patch('wrap', 'idleMinutes', v)),
          numCard(idOf('wrap', 'maxItems'), t('settings.wrapMaxItems'), t('settings.wrapMaxItemsDesc'), null,
            draft.wrap.maxItems, 1, 32, (v) => patch('wrap', 'maxItems', v)),
          numCard(idOf('wrap', 'maxRunsPerDay'), t('settings.wrapMaxRunsPerDay'), t('settings.wrapMaxRunsPerDayDesc'), null,
            draft.wrap.maxRunsPerDay, 1, 96, (v) => patch('wrap', 'maxRunsPerDay', v)),
          selectCard(idOf('wrap', 'ingest-mode'), t('settings.wrapIngestMode'), t('settings.wrapIngestModeDesc'), null,
            draft.wrap.ingest.mode, ingestOptions, (v) => patch('wrap', 'ingest', { ...draft.wrap.ingest, mode: v })),
          numCard(idOf('wrap', 'ingest-minConfidence'), t('settings.wrapIngestMinConfidence'), t('settings.wrapIngestMinConfidenceDesc'), null,
            draft.wrap.ingest.minConfidence, 0, 1, (v) => patch('wrap', 'ingest', { ...draft.wrap.ingest, minConfidence: v }), { step: 0.05 }),
          switchCard(idOf('wrap', 'ingest-dropTaskInstructions'), t('settings.wrapIngestDropTask'), t('settings.wrapIngestDropTaskDesc'),
            null, null, false, draft.wrap.ingest.dropTaskInstructions,
            (v) => patch('wrap', 'ingest', { ...draft.wrap.ingest, dropTaskInstructions: v })),
          switchCard(idOf('wrap', 'report'), t('settings.wrapReport'), t('settings.wrapReportDesc'),
            null, null, false, draft.wrap.report, (v) => patch('wrap', 'report', v)),
          textCard(idOf('wrap', 'model'), t('settings.wrapModel'), t('settings.wrapModelDesc'), null,
            draft.wrap.model, (v) => patch('wrap', 'model', v)),
          numCard(idOf('wrap', 'maxMaterialChars'), t('settings.wrapMaxMaterialChars'), t('settings.wrapMaxMaterialCharsDesc'), null,
            draft.wrap.maxMaterialChars, 1000, 50000, (v) => patch('wrap', 'maxMaterialChars', v), { step: 1000 }),
          numCard(idOf('wrap', 'spoolTtlHours'), t('settings.wrapSpoolTtlHours'), t('settings.wrapSpoolTtlHoursDesc'), null,
            draft.wrap.spoolTtlHours, 1, 720, (v) => patch('wrap', 'spoolTtlHours', v)),
          numCard(idOf('wrap', 'retentionDays'), t('settings.wrapRetentionDays'), t('settings.wrapRetentionDaysDesc'), null,
            draft.wrap.retentionDays, 0, 3650, (v) => patch('wrap', 'retentionDays', v)),
          numCard(idOf('wrap', 'timeoutMs'), t('settings.wrapTimeoutMs'), t('settings.wrapTimeoutMsDesc'), null,
            draft.wrap.timeoutMs, 5000, 600000, (v) => patch('wrap', 'timeoutMs', v), { step: 1000 }),
          h(Note, null, t('settings.wrapNote')))),
        consolidate: () => (h(GroupCard, {
            t, titleKey: 'settings.groupConsolidate', desc: t('settings.groupConsolidateDesc'),
          },
          switchCard(idOf('consolidate', 'enabled'), t('settings.consolidateEnabled'), t('settings.consolidateEnabledDesc'),
            null, null, false, draft.consolidate.enabled, (v) => patch('consolidate', 'enabled', v)),
          numCard(idOf('consolidate', 'intervalHours'), t('settings.consolidateInterval'), t('settings.consolidateIntervalDesc'), null,
            draft.consolidate.intervalHours, 1, 168, (v) => patch('consolidate', 'intervalHours', v)))),
        privacy: () => (h(GroupCard, {
            t, titleKey: 'settings.groupPrivacy', desc: t('settings.groupPrivacyDesc'),
          },
          switchCard(idOf('privacy', 'redact'), t('settings.privacyRedact'), t('settings.privacyRedactDesc'),
            null, null, false, draft.privacy.redact, (v) => patch('privacy', 'redact', v)),
          numCard(idOf('privacy', 'retentionDays'), t('settings.privacyRetention'), t('settings.privacyRetentionDesc'), null,
            draft.privacy.retentionDays, 0, 3650, (v) => patch('privacy', 'retentionDays', v),
            { danger: true, note: t('settings.privacyDanger') }))),
        edges: () => (h(GroupCard, {
            t, titleKey: 'settings.groupEdges', desc: t('settings.groupEdgesDesc'),
          },
          switchCard(idOf('edges', 'diffusion'), t('settings.edgesDiffusion'), t('settings.edgesDiffusionDesc'),
            null, null, false, draft.edges.diffusion, (v) => patch('edges', 'diffusion', v)),
          numCard(idOf('edges', 'minConf'), t('settings.edgesMinConf'), t('settings.edgesMinConfDesc'), null,
            draft.edges.minConf, 0, 1, (v) => patch('edges', 'minConf', v), { step: 0.01 }))),
        panel: () => (h(GroupCard, {
            t, titleKey: 'settings.groupPanel', desc: t('settings.groupPanelDesc'),
          },
          numCard(idOf('panel', 'pollMs'), t('settings.pollMs'), t('settings.pollMsDesc'), null,
            draft.panel.pollMs, 5000, 600000, (v) => patch('panel', 'pollMs', v), { step: 1000 }),
          switchCard(idOf('panel', 'allowRemote'), t('settings.allowRemote'), t('settings.allowRemoteDesc'),
            draft.panel.allowRemote ? t('settings.allowRemoteWarn') : null, null, false,
            draft.panel.allowRemote, (v) => patch('panel', 'allowRemote', v)),
          selectCard(idOf('panel', 'tab'), t('settings.panelTab'), t('settings.panelTabDesc'), null,
            draft.panel.tab, tabOptions, (v) => patch('panel', 'tab', v)))),
        advanced: () => (h(GroupCard, {
            t, titleKey: 'settings.groupAdvanced', desc: t('settings.groupAdvancedDesc'),
          },
          selectCard(idOf('advanced', 'logLevel'), t('settings.logLevel'), t('settings.logLevelDesc'), null,
            draft.advanced.logLevel, logOptions, (v) => patch('advanced', 'logLevel', v)),
          switchCard(idOf('advanced', 'worker'), t('settings.worker'), t('settings.workerDesc'),
            null, null, false, draft.advanced.worker, (v) => patch('advanced', 'worker', v)),
          textCard(idOf('advanced', 'traceId'), t('settings.traceId'), t('settings.traceIdDesc'), null,
            draft.advanced.traceId, (v) => patch('advanced', 'traceId', v)),
          h(Note, null, t('settings.restartNote')))),
        embed: () => (h(GroupCard, {
            t, titleKey: 'settings.groupEmbed', desc: t('settings.groupEmbedDesc'),
          },
          switchCard(idOf('embed', 'enabled'), t('settings.embedEnabled'), t('settings.embedEnabledDesc'),
            t('settings.embedNote'), null, false, draft.embed.enabled, (v) => patch('embed', 'enabled', v)),
          textCard(idOf('embed', 'endpoint'), t('settings.embedEndpoint'), t('settings.embedEndpointDesc'), null,
            draft.embed.endpoint, (v) => patch('embed', 'endpoint', v)),
          textCard(idOf('embed', 'model'), t('settings.embedModel'), t('settings.embedModelDesc'), null,
            draft.embed.model, (v) => patch('embed', 'model', v)),
          numCard(idOf('embed', 'batch'), t('settings.embedBatch'), t('settings.embedBatchDesc'), null,
            draft.embed.batch, 1, 128, (v) => patch('embed', 'batch', v)))),
      }

      const modeOptions = [['local', 'local'], ['http', 'http'], ['hybrid', 'hybrid']]
      const identityOptions = [['auto', 'auto'], ['fixed', 'fixed']]
      const reviewOptions = [['shadow', 'shadow'], ['auto', 'auto']]
      const ingestOptions = [['auto', t('settings.wrapIngestAuto')], ['review', t('settings.wrapIngestReview')]]
      const judgeOptions = [['rules', 'rules'], ['llm', 'llm']]
      const syncModeOptions = [['off', 'off'], ['push', 'push'], ['pull', 'pull'], ['both', 'both']]
      const tabOptions = TABS.map(([key, labelKey]) => [key, t(labelKey)])
      const logOptions = [['error', 'error'], ['warn', 'warn'], ['info', 'info'], ['debug', 'debug']]
      const askModeOptions = [
        ['panel+chat', t('settings.rulesAskPanelChat')],
        ['panel', t('settings.rulesAskPanel')],
        ['off', t('settings.rulesAskOff')],
      ]

      const firstRunEl = firstRun.open
        ? h('div', { style: css.wizardBox },
          h('div', { style: css.cardTitle }, t('settings.firstRunTitle')),
          h('div', { style: css.wizardNote }, t('settings.firstRunDesc')),
          h('label', { style: css.wizardRow },
            h('input', { type: 'checkbox', checked: true, disabled: true, style: css.checkbox }),
            h('div', { style: css.wizardRowText },
              h('span', null, t('settings.firstRunLocalOn')),
              h('span', { style: css.wizardNote }, t('settings.firstRunSafety')))),
          h('label', { style: css.wizardRow },
            h('input', {
              type: 'checkbox', checked: Boolean(firstRun.reflect), style: css.checkbox,
              onChange: (e) => setFirstRun((prev) => ({ ...prev, reflect: e.target.checked })),
            }),
            h('div', { style: css.wizardRowText },
              h('span', null, t('settings.firstRunReflect')),
              h('span', { style: css.wizardNote }, t('settings.firstRunReflectNote')))),
          h('label', { style: css.wizardRow },
            h('input', {
              type: 'checkbox', checked: Boolean(firstRun.wrap), style: css.checkbox,
              onChange: (e) => setFirstRun((prev) => ({ ...prev, wrap: e.target.checked })),
            }),
            h('div', { style: css.wizardRowText },
              h('span', null, t('settings.firstRunWrap')),
              h('span', { style: css.wizardNote }, t('settings.firstRunWrapNote')))),
          h('label', { style: css.wizardRow },
            h('input', {
              type: 'checkbox', checked: Boolean(firstRun.sync), style: css.checkbox,
              disabled: !(draft.sync && draft.sync.bridgeUrl),
              onChange: (e) => setFirstRun((prev) => ({ ...prev, sync: e.target.checked })),
            }),
            h('div', { style: css.wizardRowText },
              h('span', null, t('settings.firstRunSync')),
              h('span', { style: css.wizardNote },
                draft.sync && draft.sync.bridgeUrl ? t('settings.firstRunSyncNote') : t('settings.firstRunSyncUnset')))),
          h('div', { style: css.inline },
            h('button', { style: css.buttonPrimary, onClick: applyFirstRun }, t('settings.firstRunApply')),
            h('button', { style: css.button, onClick: dismissFirstRun }, t('settings.firstRunLater'))))
        : null

      return h('div', { style: css.stack },
        firstRunEl,
        h(Note, null, t('settings.defaultsNote')),
        props.onOpenManual
          ? h('button', {
            type: 'button', style: css.manualLinkBtn, onClick: props.onOpenManual,
          }, t('settings.manualLink'))
          : null,
        h('div', { style: css.groupGrid },
          SETTINGS_GROUP_ORDER.map((key) => (groupNodes[key]
            ? h(React.Fragment, { key }, groupNodes[key]())
            : null))),
        h(GroupCard, {
          t, titleKey: 'settings.groupDanger', desc: t('settings.groupDangerDesc'),
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
        position: 'relative', padding: '16px', boxSizing: 'border-box',
        background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)',
        display: 'flex', flexDirection: 'column', gap: '12px',
        // 宿主 .centerCol 是 overflow:hidden，面板必须自建滚动：整页只有这一处纵向滚动。
        flex: '1 1 auto', minHeight: 0, overflowY: 'auto',
        scrollbarWidth: 'thin', scrollbarColor: 'var(--dsw-alias-border-l1) transparent',
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
        background: 'var(--dsw-alias-bg-layer-2)', display: 'flex', flexDirection: 'column',
        gap: '4px', alignSelf: 'start', height: 'auto',
      },
      settingCardDanger: {
        border: '1px solid var(--dsw-alias-state-error-primary)', borderRadius: '8px', padding: '8px',
        background: 'var(--dsw-alias-bg-layer-2)', display: 'flex', flexDirection: 'column',
        gap: '4px', alignSelf: 'start', height: 'auto',
      },
      settingCardLocked: {
        border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '8px', padding: '8px',
        background: 'var(--dsw-alias-bg-layer-2)', display: 'flex', flexDirection: 'column',
        gap: '4px', alignSelf: 'start', height: 'auto',
        opacity: 0.65,
      },
      // 卡头：允许换行，按钮/下拉不把标题挤没（UI P2-8）；按钮区靠右（marginLeft:auto 在 wrapActions）。
      settingHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' },
      wrapHead: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' },
      wrapActions: { display: 'flex', alignItems: 'flex-end', gap: '8px', flexWrap: 'wrap', marginLeft: 'auto' },
      wrapSelectWrap: { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: '200px' },
      select: {
        background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)',
        border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '6px',
        padding: '6px 8px', fontSize: '12px', fontFamily: 'inherit', maxWidth: '320px',
      },
      // 指标：4 个等宽块，标签上/值下/左对齐（替代 Row 塞 metaGrid 的错位；窄屏 2×2）。
      statGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '8px' },
      statTile: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 },
      statLabel: { fontSize: '11px', lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)' },
      statValue: { fontSize: '18px', lineHeight: '26px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      wrapStatusRow: {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px',
        flexWrap: 'wrap', padding: '4px 0',
      },
      wrapStatusLeft: { display: 'inline-flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      wrapToggles: { display: 'flex', flexDirection: 'column', gap: '6px' },
      wrapToggleRow: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      progRow: { display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap', padding: '2px 0' },
      progStep: { display: 'inline-flex', alignItems: 'center', gap: '4px' },
      progDot: { width: '6px', height: '6px', borderRadius: '50%', background: 'var(--dsw-alias-border-l1)' },
      progDotOn: { width: '6px', height: '6px', borderRadius: '50%', background: 'var(--dsw-alias-state-success-primary)' },
      progLabel: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' },
      progLabelOn: { fontSize: '11px', color: 'var(--dsw-alias-label-primary)', fontWeight: 600 },
      foldBtn: {
        alignSelf: 'flex-start', background: 'transparent', border: 'none', padding: '2px 0',
        color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer', fontFamily: 'inherit', fontSize: '12px',
        textDecoration: 'underline',
      },
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
        display: 'flex', gap: '4px', flexWrap: 'nowrap', overflowX: 'auto', overflowY: 'hidden',
        // 关键：面板根是 flex column + 固定高度，nav 一旦成为滚动容器（overflowX:auto）其
        // flex 自动最小尺寸就是 0，会被压缩成 0 高 → 六个页签全部不可见（2026-11-26 真机）。
        // 显式 flexShrink:0 + minHeight 兜底，页签永远可点。
        flexShrink: 0, minHeight: '36px',
        borderBottom: '1px solid var(--dsw-alias-border-l1)', paddingBottom: '8px',
        // 页签必须始终可点：页根滚动后标签会滚出视野，用户被迫滚回顶部才能切换（会丢位置）。
        // sticky 让页签贴住页根顶部，切换不再触发"滚回顶部"，scrollTop 恢复才有意义（R9-07 实测）。
        position: 'sticky', top: 0, zIndex: 2,
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      tab: {
        background: 'transparent', border: 'none', color: 'var(--dsw-alias-label-secondary)',
        padding: '0 10px', cursor: 'pointer', fontFamily: 'inherit', fontSize: '13px',
        whiteSpace: 'nowrap', flex: '0 0 auto',
        // 显式盒高：避免宿主 button 重置/行高异常把文字压成 0 高。
        display: 'inline-flex', alignItems: 'center', height: '28px', boxSizing: 'border-box', lineHeight: '18px',
      },
      tabActive: {
        background: 'var(--dsw-alias-bg-layer-2)', border: 'none',
        color: 'var(--dsw-alias-label-primary)', borderRadius: '6px', padding: '0 10px',
        cursor: 'pointer', fontFamily: 'inherit', fontSize: '13px', fontWeight: 600,
        whiteSpace: 'nowrap', flex: '0 0 auto',
        display: 'inline-flex', alignItems: 'center', height: '28px', boxSizing: 'border-box', lineHeight: '18px',
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
      trendScroll: { overflowX: 'auto', overflowY: 'clip' },
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
      reportBox: {
        margin: 0, padding: '10px', maxHeight: '320px', overflow: 'auto',
        background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)',
        border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '8px',
        fontSize: '12px', lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
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
      // 不可撤销动作（彻底删除）专用：error 色 + 同色描边，与可恢复的 warn（停用/回滚）区分。
      buttonDanger: {
        fontSize: '12px', padding: '6px 10px', borderRadius: '6px',
        border: '1px solid var(--dsw-alias-state-error-primary)', background: 'transparent',
        color: 'var(--dsw-alias-state-error-primary)', cursor: 'pointer', fontFamily: 'inherit',
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
      table: { width: '100%', borderCollapse: 'separate', borderSpacing: 0, fontSize: '12px' },
      th: {
        textAlign: 'left', fontWeight: 600, color: 'var(--dsw-alias-label-secondary)',
        padding: '6px 8px', borderBottom: '1px solid var(--dsw-alias-border-l1)', whiteSpace: 'nowrap',
        // 表头跟随页根滚动保持可见；separate 下单元格自画边框，边框不会随 collapse 丢失。
        position: 'sticky', top: 0, zIndex: 1,
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      td: {
        padding: '6px 8px', borderBottom: '1px solid var(--dsw-alias-border-l1)',
        verticalAlign: 'top', color: 'var(--dsw-alias-label-primary)',
      },
      cellText: { lineHeight: 1.5, wordBreak: 'break-word' },
      clickRow: { cursor: 'pointer' },
      // 规则页：筛选 chips、表格行 hover、git 状态条、安装指引弹层、详情抽屉。
      chip: {
        fontSize: '12px', padding: '4px 10px', borderRadius: '999px',
        border: '1px solid var(--dsw-alias-border-l1)', background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer', fontFamily: 'inherit',
      },
      chipActive: {
        fontSize: '12px', padding: '4px 10px', borderRadius: '999px',
        border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600,
      },
      rulesBarTop: {
        display: 'flex', justifyContent: 'space-between', gap: '8px',
        flexWrap: 'wrap', alignItems: 'flex-start',
      },
      rulesGitLabel: { fontSize: '12px', fontWeight: 600 },
      rulesGitState: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
      rulesDirBox: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', minWidth: 0 },
      rulesDirPath: {
        fontSize: '11px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '6px', padding: '3px 6px', wordBreak: 'break-all', maxWidth: '100%',
      },
      rulesRow: { cursor: 'pointer' },
      rulesRowHover: { background: 'var(--dsw-alias-bg-layer-2)' },
      rulesTypeBadge: {
        fontSize: '10px', padding: '1px 6px', borderRadius: '999px', whiteSpace: 'nowrap',
        border: '1px solid var(--dsw-alias-border-l1)', color: 'var(--dsw-alias-label-secondary)',
        background: 'var(--dsw-alias-bg-layer-2)',
      },
      rulesStatusBadge: {
        fontSize: '10px', padding: '1px 6px', borderRadius: '999px',
        border: '1px solid', background: 'transparent', whiteSpace: 'nowrap',
      },
      rulesScope: {
        display: 'inline-block', maxWidth: '200px', overflow: 'hidden',
        textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'bottom',
      },
      rulesSteps: {
        margin: 0, paddingLeft: '18px', display: 'flex', flexDirection: 'column',
        gap: '4px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.6,
      },
      rulesProposalItem: {
        display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 0,
        borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: '8px',
      },
      rulesProposalHead: {
        display: 'flex', justifyContent: 'space-between', gap: '8px',
        alignItems: 'flex-start', flexWrap: 'wrap',
      },
      rulesProposalBadges: { display: 'flex', gap: '6px', flexWrap: 'wrap' },
      rulesProposalText: {
        fontSize: '12px', lineHeight: 1.6, color: 'var(--dsw-alias-label-primary)',
        wordBreak: 'break-word', display: 'flex', flexDirection: 'column', gap: '2px',
        alignItems: 'flex-start',
      },
      rulesInlineButton: {
        background: 'transparent', border: 'none', padding: 0, cursor: 'pointer',
        color: 'var(--dsw-alias-brand-primary)', fontFamily: 'inherit', fontSize: '12px',
      },
      rulesProposalMeta: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)', wordBreak: 'break-word' },
      rulesProposalSource: {
        display: 'flex', flexDirection: 'column', gap: '2px',
        borderLeft: '2px solid var(--dsw-alias-border-l1)', paddingLeft: '8px',
      },
      rulesProposalSourceText: {
        fontSize: '12px', color: 'var(--dsw-alias-label-primary)', lineHeight: 1.5,
        wordBreak: 'break-word',
      },
      rulesProposalAffect: { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 },
      rulesProposalAffectRow: {
        display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0,
        background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '8px', padding: '6px 8px',
      },
      rulesProposalAffectHead: { display: 'flex', gap: '8px', alignItems: 'baseline', flexWrap: 'wrap' },
      rulesProposalAffectKey: {
        fontSize: '11px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        color: 'var(--dsw-alias-label-secondary)', wordBreak: 'break-all',
      },
      rulesProposalCompare: {
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '6px',
      },
      rulesProposalOldText: {
        display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0,
        borderLeft: '2px solid var(--dsw-alias-state-warn-primary)', paddingLeft: '6px',
      },
      rulesProposalNewText: {
        display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0,
        borderLeft: '2px solid var(--dsw-alias-brand-primary)', paddingLeft: '6px',
      },
      rulesProposalDiffLabel: { fontSize: '10px', color: 'var(--dsw-alias-label-tertiary)' },
      rulesProposalDiffText: {
        fontSize: '12px', lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      },
      rulesProposalClause: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 },
      rulesProposalGuard: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 },
      rulesRiskBar: {
        display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0,
        border: '1px solid var(--dsw-alias-state-warn-primary)', borderRadius: '8px',
        background: 'var(--dsw-alias-bg-layer-2)', padding: '8px', color: 'var(--dsw-alias-label-primary)',
        boxShadow: 'inset 3px 0 0 var(--dsw-alias-state-error-primary)',
      },
      rulesRiskTitle: { fontSize: '12px', fontWeight: 600, color: 'var(--dsw-alias-state-warn-primary)' },
      rulesRiskLine: { fontSize: '12px', color: 'var(--dsw-alias-state-warn-primary)', lineHeight: 1.5 },
      rulesRiskDroppedList: {
        margin: 0, paddingLeft: '18px', display: 'flex', flexDirection: 'column', gap: '2px',
        fontSize: '12px', color: 'var(--dsw-alias-label-secondary)',
      },
      rulesRiskDroppedItem: { lineHeight: 1.5, wordBreak: 'break-word' },
      rulesAckRow: {
        display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px',
        color: 'var(--dsw-alias-label-primary)', wordBreak: 'break-word',
      },
      rulesProposalPanel: {
        width: 'min(560px, 94vw)', maxHeight: '90vh', overflowY: 'auto',
        background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '10px', padding: '16px', display: 'flex', flexDirection: 'column',
        gap: '10px', boxSizing: 'border-box',
      },
      rulesProposalEditorArea: {
        width: '100%', minHeight: '160px', resize: 'vertical', background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)', border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '6px', padding: '8px', fontSize: '13px', fontFamily: 'inherit', boxSizing: 'border-box',
      },
      rulesCountBadge: {
        fontSize: '11px', padding: '5px 10px', borderRadius: '999px',
        border: '1px solid var(--dsw-alias-border-l1)', background: 'transparent',
        color: 'var(--dsw-alias-label-tertiary)', cursor: 'pointer', fontFamily: 'inherit',
      },
      rulesCountBadgeActive: {
        fontSize: '11px', padding: '5px 10px', borderRadius: '999px',
        border: '1px solid var(--dsw-alias-state-warn-primary)', background: 'transparent',
        color: 'var(--dsw-alias-state-warn-primary)', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600,
      },
      rulesManualBlock: {
        display: 'flex', flexDirection: 'column', gap: '6px', width: '100%',
        borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: '8px', minWidth: 0,
      },
      rulesGuideMask: {
        position: 'fixed', inset: 0, background: 'var(--dsw-alias-bg-mask-1)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px', zIndex: 61,
      },
      rulesGuidePanel: {
        width: 'min(520px, 94vw)', maxHeight: '90vh', overflowY: 'auto',
        background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '10px', padding: '16px', display: 'flex', flexDirection: 'column',
        gap: '10px', boxSizing: 'border-box',
      },
      rulesGuideRow: {
        display: 'flex', flexDirection: 'column', gap: '2px',
        borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: '6px',
      },
      rulesCode: {
        fontSize: '12px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        background: 'var(--dsw-alias-bg-base)', border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '6px', padding: '5px 8px', wordBreak: 'break-all',
      },
      rulesDrawer: {
        width: 'min(560px, 94vw)', height: '100%', overflowY: 'auto',
        background: 'var(--dsw-alias-bg-layer-2)', borderLeft: '1px solid var(--dsw-alias-border-l1)',
        padding: '16px', display: 'flex', flexDirection: 'column', gap: '10px', boxSizing: 'border-box',
      },
      rulesBody: {
        margin: 0, padding: '8px', fontSize: '12px', lineHeight: 1.6,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        whiteSpace: 'pre-wrap', wordBreak: 'break-word', userSelect: 'text',
        background: 'var(--dsw-alias-bg-base)', border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '6px', maxHeight: '320px', overflowX: 'auto', overflowY: 'auto',
        // 抽屉内二次滚动：滚到边界不把滚轮传给抽屉/页根，避免"滚轮被内层吃掉"。
        overscrollBehavior: 'contain',
        scrollbarWidth: 'thin', scrollbarColor: 'var(--dsw-alias-border-l1) transparent',
      },
      rulesList: {
        margin: 0, paddingLeft: '18px', display: 'flex', flexDirection: 'column',
        gap: '2px', fontSize: '12px', color: 'var(--dsw-alias-label-primary)',
      },
      rulesListRow: { lineHeight: 1.5, wordBreak: 'break-word' },
      rulesHistoryRow: {
        display: 'flex', gap: '8px', alignItems: 'baseline', flexWrap: 'wrap', textAlign: 'left',
        width: '100%', fontSize: '12px', padding: '5px 6px', borderRadius: '6px',
        border: '1px solid transparent', background: 'transparent',
        color: 'var(--dsw-alias-label-primary)', cursor: 'pointer', fontFamily: 'inherit',
      },
      rulesHistoryActive: {
        display: 'flex', gap: '8px', alignItems: 'baseline', flexWrap: 'wrap', textAlign: 'left',
        width: '100%', fontSize: '12px', padding: '5px 6px', borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)', cursor: 'pointer', fontFamily: 'inherit',
      },
      rulesHistoryRev: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontWeight: 600,
      },
      rulesHistorySource: {
        fontSize: '10px', color: 'var(--dsw-alias-label-tertiary)',
        border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '999px', padding: '0 5px',
      },
      rulesHistorySubject: {
        fontSize: '11px', color: 'var(--dsw-alias-label-secondary)',
        maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      },
      rulesDiff: {
        display: 'flex', flexDirection: 'column', gap: '6px',
        borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: '8px',
      },
      rulesDiffTagOld: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' },
      rulesDiffTagNew: { fontSize: '11px', color: 'var(--dsw-alias-brand-primary)' },
      rulesDiffBody: {
        fontSize: '12px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '260px', overflowX: 'auto', overflowY: 'auto',
        background: 'var(--dsw-alias-bg-base)', border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '6px', padding: '6px',
        overscrollBehavior: 'contain',
        scrollbarWidth: 'thin', scrollbarColor: 'var(--dsw-alias-border-l1) transparent',
      },
      rulesDiffSame: { color: 'var(--dsw-alias-label-tertiary)' },
      rulesDiffAdd: { color: 'var(--dsw-alias-brand-primary)', background: 'var(--dsw-alias-bg-layer-2)' },
      rulesDiffDel: { color: 'var(--dsw-alias-state-warn-primary)', background: 'var(--dsw-alias-bg-layer-2)' },
      rulesHistoryCurrent: {
        fontSize: '10px', padding: '0 6px', borderRadius: '999px',
        border: '1px solid var(--dsw-alias-brand-primary)', color: 'var(--dsw-alias-brand-primary)',
        whiteSpace: 'nowrap',
      },
      rulesEditPanel: {
        width: 'min(640px, 94vw)', maxHeight: '90vh', overflowY: 'auto',
        background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '10px', padding: '16px', display: 'flex', flexDirection: 'column',
        gap: '10px', boxSizing: 'border-box',
      },
      rulesEditReadonly: {
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '6px 12px',
        border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '8px',
        background: 'var(--dsw-alias-bg-layer-1)', padding: '8px', minWidth: 0,
      },
      rulesEditGrid: {
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
        gap: '10px', minWidth: 0,
      },
      rulesFieldChips: { display: 'flex', gap: '6px', flexWrap: 'wrap' },
      rulesFieldChip: {
        fontSize: '11px', padding: '0 6px', borderRadius: '999px',
        border: '1px solid var(--dsw-alias-border-l1)', color: 'var(--dsw-alias-label-secondary)',
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      rulesTypeCell: { display: 'flex', gap: '4px', alignItems: 'center', flexWrap: 'wrap' },
      rulesDefaultBadge: {
        fontSize: '10px', padding: '1px 6px', borderRadius: '999px', whiteSpace: 'nowrap',
        border: '1px solid var(--dsw-alias-brand-primary)',
        color: 'var(--dsw-alias-brand-primary)', background: 'transparent',
      },
      rulesRetiredBadge: {
        fontSize: '10px', padding: '1px 6px', borderRadius: '999px', whiteSpace: 'nowrap',
        border: '1px solid var(--dsw-alias-state-warn-primary)',
        color: 'var(--dsw-alias-state-warn-primary)', background: 'transparent',
      },
      rulesDefaultNote: {
        fontSize: '12px', lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary)',
        border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '8px',
        background: 'var(--dsw-alias-bg-layer-1)', padding: '6px 8px', wordBreak: 'break-word',
      },
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
      // 根因 1：grid 默认 stretch 会把同排矮卡拉到最高卡高度（大片空白）；
      // 根因 2：设置控件在 column 容器里继承 flex-basis 220px，单行 input 被拉成方块。
      // 两处都从布局语义上修，不靠逐个卡片打补丁。
      groupGrid: {
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
        gap: '10px', alignItems: 'start',
      },
      fieldInput: {
        flex: '0 0 auto', width: '100%', boxSizing: 'border-box',
        background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)',
        border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '6px',
        padding: '6px 8px', fontSize: '13px', fontFamily: 'inherit',
      },
      numberInput: {
        flex: '0 0 auto', width: '100%', maxWidth: '180px', boxSizing: 'border-box',
        background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)',
        border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '6px',
        padding: '6px 8px', fontSize: '13px', fontFamily: 'inherit',
        fontVariantNumeric: 'tabular-nums',
      },
      fieldSelect: {
        width: '100%', boxSizing: 'border-box',
        background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)',
        border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '6px',
        padding: '5px 8px', fontSize: '13px', fontFamily: 'inherit',
      },
      fieldArea: {
        width: '100%', boxSizing: 'border-box', minHeight: '88px', resize: 'vertical',
        background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)',
        border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '6px',
        padding: '8px', fontSize: '13px', fontFamily: 'inherit',
      },
      groupBody: { display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '2px' },
      groupHeadRow: { display: 'flex', alignItems: 'center', gap: '8px' },
      groupHeadBtn: {
        display: 'flex', alignItems: 'center', gap: '8px', width: '100%',
        background: 'transparent', border: 'none', padding: '0', cursor: 'pointer',
        color: 'var(--dsw-alias-label-primary)', fontFamily: 'inherit', textAlign: 'left',
      },
      groupCaret: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', width: '12px' },
      groupToggleHint: {
        marginLeft: 'auto', fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)',
      },
      recommendChip: {
        fontSize: '10px', padding: '1px 6px', borderRadius: '999px', whiteSpace: 'nowrap',
        color: 'var(--dsw-alias-brand-primary)',
        border: '1px solid var(--dsw-alias-brand-primary)',
        background: 'transparent',
      },
      wizardBox: {
        border: '1px solid var(--dsw-alias-brand-primary)', borderRadius: '10px',
        padding: '12px', display: 'flex', flexDirection: 'column', gap: '8px',
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      wizardRow: { display: 'flex', alignItems: 'flex-start', gap: '8px', fontSize: '12px' },
      wizardRowText: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 },
      wizardNote: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', lineHeight: 1.5 },
      manualMask: {
        position: 'fixed', inset: 0, zIndex: 60, display: 'flex', justifyContent: 'center',
        alignItems: 'stretch', padding: '16px', boxSizing: 'border-box',
        background: 'rgba(0,0,0,0.38)',
      },
      manualPanel: {
        width: '100%', maxWidth: '880px', maxHeight: '100%', display: 'flex',
        flexDirection: 'column', gap: '8px', background: 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '12px',
        padding: '14px', boxSizing: 'border-box', overflow: 'hidden',
      },
      manualScroll: {
        overflowY: 'auto', minHeight: 0, flex: '1 1 auto', paddingRight: '4px',
        scrollbarWidth: 'thin', scrollbarColor: 'var(--dsw-alias-border-l1) transparent',
      },
      manualBody: { display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '13px', lineHeight: 1.65 },
      mdH1: { fontSize: '18px', fontWeight: 650, margin: '2px 0 4px' },
      mdH2: { fontSize: '15px', fontWeight: 650, margin: '10px 0 2px' },
      mdH3: { fontSize: '13px', fontWeight: 650, margin: '8px 0 2px' },
      mdP: { margin: 0 },
      mdList: { margin: 0, paddingLeft: '18px', display: 'flex', flexDirection: 'column', gap: '2px' },
      mdTable: { width: '100%', borderCollapse: 'collapse', fontSize: '12px' },
      mdTh: {
        textAlign: 'left', padding: '5px 8px', borderBottom: '1px solid var(--dsw-alias-border-l1)',
        color: 'var(--dsw-alias-label-secondary)', fontWeight: 600,
      },
      mdTd: {
        padding: '5px 8px', borderBottom: '1px solid var(--dsw-alias-border-l1)',
        verticalAlign: 'top', lineHeight: 1.55,
      },
      manualLinkBtn: {
        alignSelf: 'flex-start', background: 'transparent', border: 'none', padding: 0,
        color: 'var(--dsw-alias-brand-primary)', cursor: 'pointer', fontFamily: 'inherit',
        fontSize: '12px', textDecoration: 'underline',
      },
      mdCode: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px',
        background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '4px', padding: '1px 4px',
      },
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
        // R9-07 第 5 条：细滚动条 <style> 只注入一次（按 id 判重，重挂/重复装载都不会叠加）。
        ctx.effect(() => { injectScrollbarStyle() }, 'whale-memory: scrollbar-style')
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
