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
      const [wrapStatus, setWrapStatus] = useState({ status: 'loading', data: null, err: null })
      const [wrapBusy, setWrapBusy] = useState(false)
      const [wrapNotice, setWrapNotice] = useState(null)
      const [wrapReport, setWrapReport] = useState({ open: false, status: 'idle', text: '', err: null, runId: null })
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
          try {
            const body = await callJson('/wrap/status')
            if (alive) setWrapStatus({ status: 'ok', data: body, err: null })
          } catch (err) {
            if (alive) setWrapStatus({ status: 'error', data: null, err })
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

      // 会话收尾（Session Wrap）：概览只读状态 + 一个手动入口；报告按需拉取。
      const wrapStateText = (state) => {
        const key = 'wrap.state' + String(state || '').charAt(0).toUpperCase() + String(state || '').slice(1)
        const text = t(key)
        return text === key ? String(state || '—') : text
      }
      const wrapTriggerText = (trigger) => {
        const key = 'wrap.trigger' + String(trigger || '').charAt(0).toUpperCase() + String(trigger || '').slice(1)
        const text = t(key)
        return text === key ? String(trigger || '—') : text
      }
      const reloadWrap = async () => {
        try {
          const body = await callJson('/wrap/status')
          setWrapStatus({ status: 'ok', data: body, err: null })
        } catch (err) {
          setWrapStatus({ status: 'error', data: null, err })
        }
      }
      const triggerWrap = async () => {
        setWrapBusy(true)
        setWrapNotice(null)
        try {
          const body = await callJson('/wrap', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ trigger: 'manual' }),
          })
          setWrapNotice({ ok: true, runId: body && body.runId })
          await reloadWrap()
        } catch (err) {
          setWrapNotice({ ok: false, code: (err && err.code) || 'unknown_error' })
        } finally {
          setWrapBusy(false)
        }
      }
      const toggleWrapReport = async () => {
        if (wrapReport.open) { setWrapReport((prev) => ({ ...prev, open: false })); return }
        const latest = wrapStatus.data && wrapStatus.data.latest
        if (!latest || !latest.reportAvailable) return
        setWrapReport({ open: true, status: 'loading', text: '', err: null, runId: latest.id })
        try {
          const body = await callJson('/wrap/report?id=' + encodeURIComponent(latest.id))
          setWrapReport({ open: true, status: 'ok', text: String((body && body.text) || ''), err: null, runId: latest.id })
        } catch (err) {
          setWrapReport({ open: true, status: 'error', text: '', err, runId: latest.id })
        }
      }

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
        h(Card, null,
          h('div', { style: css.settingHead },
            h(SectionTitle, null, t('overview.wrapTitle')),
            h('div', { style: css.inline },
              h('button', {
                style: wrapStatus.status === 'ok' && wrapStatus.data
                  && wrapStatus.data.enabled && wrapStatus.data.supported !== false
                  ? (wrapBusy ? css.buttonDisabled : css.buttonPrimary) : css.buttonDisabled,
                disabled: wrapBusy || wrapStatus.status !== 'ok' || !wrapStatus.data
                  || !wrapStatus.data.enabled || wrapStatus.data.supported === false,
                onClick: triggerWrap,
              }, wrapBusy ? t('overview.wrapBusy') : t('overview.wrapNow'))),
          ),
          wrapStatus.status === 'loading'
            ? h('div', { style: css.muted }, t('state.loading'))
            : wrapStatus.status === 'error'
              ? h('div', { style: css.error }, t('overview.wrapLoadFailed') + ' — ' + errText(t, wrapStatus.err))
              : !wrapStatus.data || wrapStatus.data.supported === false
                ? h('div', { style: css.tertiary }, t('overview.wrapUnsupported'))
                : !wrapStatus.data.enabled
                  ? h('div', { style: css.tertiary }, t('overview.wrapDisabled'))
                  : !wrapStatus.data.latest
                  ? h('div', { style: css.tertiary }, t('overview.wrapEmpty'))
                  : (() => {
                    const latest = wrapStatus.data.latest
                    const ready = latest.switchReady && latest.switchReady.ready === true
                    const blockers = latest.switchReady && Array.isArray(latest.switchReady.blockers)
                      ? latest.switchReady.blockers : []
                    return h('div', { style: css.stack },
                      h('div', { style: css.row },
                        h('span', null, wrapStateText(latest.state)),
                        h('span', { style: css.tertiary }, wrapTriggerText(latest.trigger)),
                        h('span', { style: css.muted }, fmtTime(latest.updatedAt || latest.createdAt, locale))),
                      h('div', { style: css.metaGrid },
                        h(Row, { k: t('overview.wrapCandidates'), v: fmtNum(latest.candidates, locale) }),
                        h(Row, { k: t('overview.wrapProposals'), v: fmtNum(latest.ruleProposals, locale) }),
                        h(Row, { k: t('overview.wrapOpenLoops'), v: fmtNum(latest.openLoops, locale) }),
                        h(Row, {
                          k: t('overview.wrapSwitchReady'),
                          v: ready ? t('overview.wrapReadyYes') : t('overview.wrapReadyNo'),
                        })),
                      blockers.length
                        ? h('div', { style: css.warn }, t('overview.wrapBlockers', { list: blockers.join(' · ') })) : null,
                      latest.error ? h('div', { style: css.error }, t('overview.wrapLastError') + ': ' + String(latest.error)) : null,
                      wrapStatus.data.lastSkip
                        ? h('div', { style: css.tertiary }, t('overview.wrapSkipped', { reason: String(wrapStatus.data.lastSkip.reason || '—') })) : null,
                      wrapNotice && wrapNotice.ok
                        ? h('div', { style: css.ok }, t('overview.wrapQueued', { id: String(wrapNotice.runId ?? '—') }))
                        : null,
                      wrapNotice && !wrapNotice.ok
                        ? h('div', { style: css.error }, t('overview.wrapFailed') + ' — ' + errText(t, { code: wrapNotice.code })) : null,
                      latest.reportAvailable
                        ? h('div', { style: css.inline },
                          h('button', { style: css.button, onClick: toggleWrapReport },
                            wrapReport.open ? t('overview.wrapHideReport') : t('overview.wrapShowReport')))
                        : null,
                      wrapReport.open
                        ? (wrapReport.status === 'loading'
                          ? h('div', { style: css.muted }, t('state.loading'))
                          : wrapReport.status === 'error'
                            ? h('div', { style: css.error }, t('overview.wrapReportFailed') + ' — ' + errText(t, wrapReport.err))
                            : h('pre', { style: css.reportBox }, wrapReport.text))
                        : null)
                  })()),
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

