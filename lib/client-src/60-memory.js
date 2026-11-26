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
