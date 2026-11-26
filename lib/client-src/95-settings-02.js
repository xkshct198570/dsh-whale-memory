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

