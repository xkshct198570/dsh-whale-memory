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
    const WRAP_PHASES = [
      { key: 'queued', label: 'overview.wrapPhaseQueued' },
      { key: 'capture', label: 'overview.wrapPhaseCapture' },
      { key: 'distill', label: 'overview.wrapPhaseDistill' },
      { key: 'dispatch', label: 'overview.wrapPhaseDispatch' },
      { key: 'report', label: 'overview.wrapPhaseReport' },
    ]

    function wrapPhaseIndex(latest) {
      if (!latest) return -1
      if (latest.state === 'queued') return 0
      if (latest.state !== 'running') return WRAP_PHASES.length - 1
      const phase = String(latest.phase || 'created')
      if (phase === 'distilled') return 2
      if (phase === 'written') return 3
      if (phase === 'reported' || phase === 'done') return 4
      return 1
    }

    /** 阶段进度点：排队→采集→蒸馏→分流→报告；当前阶段高亮 + aria-current。 */
    function WrapProgress({ t, latest }) {
      const active = wrapPhaseIndex(latest)
      if (active < 0) return null
      return h('div', { style: css.progRow, role: 'list', 'aria-label': t('overview.wrapProgress') },
        WRAP_PHASES.map((step, index) => h('span', {
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
        try { body = await callJson('/wrap/status') } catch (e) { err = e }
        let sessions = null
        try { sessions = await callJson('/wrap/sessions') } catch { /* 列表失败不遮状态卡 */ }
        setData({ status: err ? 'error' : 'ok', body, sessions, err })
      }

      useEffect(() => {
        if (!visible) return undefined
        let alive = true
        const tick = async () => { if (alive) await load() }
        tick()
        const every = Math.max(5000, Number(pollMs) || 60000)
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
          const body = await callJson('/wrap/report?id=' + encodeURIComponent(latest.id))
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
      const auto = data.sessions && data.sessions.auto ? data.sessions.auto : { enabled: false, idleMinutes: 10 }
      const enabled = data.status === 'ok' && body && body.enabled && body.supported !== false
      const latest = body && body.latest ? body.latest : null
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

      const reportNode = report.open
        ? (report.status === 'loading'
          ? h('div', { style: css.muted }, t('state.loading'))
          : report.status === 'error'
            ? h('div', { style: css.error }, t('overview.wrapReportFailed') + ' — ' + errText(t, report.err))
            : h('pre', { style: css.reportBox, 'aria-label': t('overview.wrapShowReport') }, report.text || t('overview.wrapReportEmpty')))
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
                h('option', { value: '' }, selectLabel),
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
                    h(WrapProgress, { t, latest }),
                    h('div', { style: css.statGrid },
                      h(StatTile, { label: t('overview.wrapCandidates'), value: fmtNum(latest.candidates, locale) }),
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
