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
          // 只留 sync 的能力位：手动「立即反思」是显式动作，路由本就绕过 reflect.enabled（S4 契约），
          // 面板不得把它禁掉——否则「开关关着也能手动跑」的文案与 UI 冲突（审查 P1）。
          setCaps({ syncEnabled: cfg.sync ? cfg.sync.enabled === true : true })
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
              // 手动反思始终可点（只挡并发）：自动开关只管自动触发。
              style: reflectBusy ? css.buttonDisabled : css.button,
              disabled: reflectBusy,
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

