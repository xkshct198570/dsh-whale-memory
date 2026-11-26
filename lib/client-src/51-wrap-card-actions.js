    // ---------------------------------------------------- 会话收尾卡片 · 文案与数据动作（S5 拆分）
    // 职责：错误/状态/触发/跳过文案映射、阶段投影、取数与动作 hook（useWrapCard）。
    // 依赖同一 factory 作用域（callJson/withIdentity/useState/useEffect/css 格式化 helper）；
    // 不渲染、不读其他页签内部。拆分自 51-wrap-card.js（S5，行为等价）。

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
