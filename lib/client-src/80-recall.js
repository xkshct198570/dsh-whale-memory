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

