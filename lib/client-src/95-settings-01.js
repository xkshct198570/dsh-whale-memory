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

