    // ---------------------------------------------------- 会话收尾卡片（S5 拆分后主体）
    // 职责：收尾卡壳（状态/指标/警告/失败折叠）与小件（阶段进度/状态徽标/指标块）；
    // 数据/动作见 51-wrap-card-actions.js、报告见 51-wrap-card-report.js、设置区见 51-wrap-card-settings.js。
    // 依赖同一 factory 作用域；不 import、不读其他页签内部。

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

      // 设置区/报告只装配子件：动作与状态仍是 useWrapCard 的唯一来源。
      const triggerTitle = !enabled
        ? (data.status === 'error' ? t('overview.wrapLoadFailed')
          : !body ? t('state.loading')
            : !body.enabled ? t('overview.wrapDisabled')
              : body.supported === false ? t('overview.wrapUnsupported') : '')
        : undefined
      const controls = h(WrapControls, {
        t, sessions, selected, setSelected, busy, enabled, triggerTitle, auto,
        onTrigger: trigger, onToggleAuto: toggleAuto, onToggleSkip: toggleSkip,
      })
      return h(Card, null,
        controls,
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
                    h(WrapReport, {
                      t, report, available: Boolean(latest.reportAvailable), onToggle: toggleReport,
                    })))
    }
