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
