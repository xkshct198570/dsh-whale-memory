    function RulesView(props) {
      const { t, locale, version, onScrollReset } = props
      const [list, setList] = useState({ status: 'loading' })
      const [reloadTick, setReloadTick] = useState(0)
      const [filter, setFilter] = useState('all')
      const [query, setQuery] = useState('')
      const [detailKey, setDetailKey] = useState(null)
      const [newOpen, setNewOpen] = useState(false)
      const [guideOpen, setGuideOpen] = useState(false)
      const [copyState, setCopyState] = useState('idle')
      const [gitBusy, setGitBusy] = useState(false)
      const [op, setOp] = useState({ status: 'idle', kind: '', code: '', count: null })
      const [proposals, setProposals] = useState({ status: 'loading', items: [] })
      const proposalsRef = useRef(null)

      useEffect(() => {
        let alive = true
        setList((prev) => ({ ...prev, status: 'loading' }))
        callJson('/rules').then((body) => {
          if (!alive) return
          setList({
            status: 'ok',
            dir: typeof (body && body.dir) === 'string' ? body.dir : '',
            git: (body && body.git) || null,
            rules: Array.isArray(body && body.rules) ? body.rules : [],
            // 能力探测：恢复默认/plan 未上线时按钮必须隐藏，而不是点了报 501。
            capabilities: body && body.capabilities && typeof body.capabilities === 'object'
              ? body.capabilities
              : {},
          })
        }).catch((err) => {
          if (alive) setList({ status: 'error', err })
        })
        return () => { alive = false }
      }, [reloadTick, version])

      useEffect(() => {
        let alive = true
        setProposals((prev) => ({ ...prev, status: 'loading' }))
        // 404＝契约未上线（并行开发的旧服务端）：软降级空态；其它失败给卡片内错误态与重试，不吞网络故障。
        callJson('/rules/proposals?status=pending,needs_manual').then((body) => {
          if (!alive) return
          const items = Array.isArray(body && body.items)
            ? body.items
            : Array.isArray(body && body.proposals) ? body.proposals : []
          setProposals({ status: 'ok', items })
        }).catch((err) => {
          if (!alive) return
          if (err && (err.code === 'not_found' || err.status === 404)) setProposals({ status: 'empty', items: [] })
          else setProposals({ status: 'error', items: [], err })
        })
        return () => { alive = false }
      }, [reloadTick, version])

      const rerun = () => setReloadTick((v) => v + 1)
      /** 筛选/搜索变了就回页顶：结果集换了还停在旧位置，用户会以为列表没刷新。 */
      const resetPageScroll = () => { if (typeof onScrollReset === 'function') onScrollReset() }

      const refreshGit = async () => {
        setGitBusy(true)
        try {
          const body = await callJson('/rules/git-status')
          const nextGit = (body && body.git) || null
          setList((prev) => ({ ...prev, git: nextGit || prev.git }))
        } catch (err) {
          setOp({ status: 'error', kind: 'git', code: (err && err.code) || 'unknown_error', count: null })
        } finally {
          setGitBusy(false)
        }
      }

      const rebuildMirror = async () => {
        if (!askConfirm(t('rules.rebuildConfirm'))) return
        setOp({ status: 'busy', kind: 'rebuild', code: '', count: null })
        try {
          await callJson('/rules/rebuild-mirror', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
          })
          setOp({ status: 'ok', kind: 'rebuild', code: '', count: null })
          setReloadTick((v) => v + 1)
        } catch (err) {
          setOp({ status: 'error', kind: 'rebuild', code: (err && err.code) || 'unknown_error', count: null })
        }
      }

      const importLegacy = async () => {
        if (!askConfirm(t('rules.importConfirm'))) return
        setOp({ status: 'busy', kind: 'import', code: '', count: null })
        try {
          const body = await callJson('/rules/import-legacy', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
          })
          const raw = body && (body.imported ?? body.added ?? body.count)
          const count = Number.isFinite(Number(raw)) ? Number(raw) : null
          setOp({ status: 'ok', kind: 'import', code: '', count, skipped: body && body.skipped === true })
          setReloadTick((v) => v + 1)
        } catch (err) {
          setOp({ status: 'error', kind: 'import', code: (err && err.code) || 'unknown_error', count: null })
        }
      }

      const copyDir = async () => {
        const dir = list.status === 'ok' ? String(list.dir || '') : ''
        if (!dir) return
        try {
          await copyToClipboard(dir)
          setCopyState('ok')
        } catch {
          setCopyState('error')
        }
      }

      const scrollToProposals = () => {
        const node = proposalsRef.current
        if (node && typeof node.scrollIntoView === 'function') node.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }

      /**
       * 提案动作成功后的统一刷新：先本地摘掉已拒绝项（瞬间生效），再让列表/提案/详情/git
       * 走同一个 reloadTick，避免三处状态各自漂移。
       */
      const onProposalChanged = (event) => {
        const kind = event && event.kind
        if (kind === 'rejected' && event && event.id !== undefined) {
          setProposals((prev) => ({
            ...prev,
            status: 'ok',
            items: (Array.isArray(prev.items) ? prev.items : []).filter((item) => !item || String(item.id) !== String(event.id)),
          }))
        }
        if (kind === 'propose') scrollToProposals()
        setOp({
          status: 'ok',
          kind: kind === 'applied' ? 'apply' : kind === 'rejected' ? 'reject' : kind === 'propose' ? 'propose' : 'rebuild',
          code: '',
          count: null,
          appliedKey: event && event.key ? String(event.key) : '',
          numberAdjusted: event && event.numberAdjusted && typeof event.numberAdjusted === 'object'
            ? event.numberAdjusted
            : null,
        })
        setReloadTick((v) => v + 1)
      }

      /**
       * 详情抽屉里的写动作（编辑/回滚/停用/重新启用/彻底删除）成功后的统一刷新：与提案动作共用
       * reloadTick，列表、提案、详情、git 一起重载；op 提示带「AGENTS 摘要随后同步」的说明。
       * purge 额外带 number/nextNumber：规则已从列表消失，顶部提示是用户唯一能确认
       * "编号已作废、下一个编号是多少"的地方。
       */
      const onRuleChanged = (event) => {
        const kind = event && event.kind
        setOp({
          status: 'ok',
          kind: kind === 'revert'
            ? 'revert'
            : kind === 'restore' ? 'restore'
              : kind === 'retire' ? 'retire'
                : kind === 'reactivate' ? 'reactivate'
                  : kind === 'purge' ? 'purge' : 'edit',
          code: '',
          count: null,
          changed: !(event && event.changed === false),
          commit: event && event.commit ? String(event.commit) : '',
          number: event && event.number !== undefined && event.number !== null ? Number(event.number) : null,
          nextNumber: event && event.nextNumber !== undefined && event.nextNumber !== null
            ? Number(event.nextNumber)
            : null,
        })
        setReloadTick((v) => v + 1)
      }

      /**
       * 新建规则成功：关弹层，把「已创建 · key」写进顶部提示，并让列表/提案/详情/git
       * 走同一 reloadTick —— 新建后编号与默认徽标要立刻出现在列表里。
       */
      const onRuleCreated = (event) => {
        setNewOpen(false)
        setOp({
          status: 'ok',
          kind: 'create',
          code: '',
          count: null,
          appliedKey: event && event.key ? String(event.key) : '',
          commit: event && event.commit ? String(event.commit) : '',
        })
        setReloadTick((v) => v + 1)
      }

      const busy = op.status === 'busy'
      const rules = list.status === 'ok' ? list.rules : []
      const rows = filterRuleList(rules, filter, query)
      // 刷新期间保留上一次条数，避免徽标闪成 0；加载失败时空数组自然归零。
      const proposalCount = Array.isArray(proposals.items) ? proposals.items.length : 0

      let notice = null
      if (op.status === 'ok') {
        notice = h('div', { style: css.ok },
          op.kind === 'import'
            ? (op.skipped ? t('rules.importSkipped')
              : t('rules.importDone') + (op.count === null ? '' : ' · ' + t('rules.importCount', { n: fmtNum(op.count, locale) })))
            : op.kind === 'create'
              ? t('rules.newDone') + (op.appliedKey ? ' · ' + op.appliedKey : '') + ' · ' + t('rules.agentsSynced')
              : op.kind === 'apply'
                ? t('rules.proposalApplied') + (op.appliedKey ? ' · ' + op.appliedKey : '')
                  + (op.numberAdjusted
                    ? ' · ' + t('rules.proposalNumberAdjusted', {
                      from: op.numberAdjusted.from === null || op.numberAdjusted.from === undefined
                        ? t('common.dash')
                        : fmtNum(op.numberAdjusted.from, locale),
                      to: op.numberAdjusted.to === null || op.numberAdjusted.to === undefined
                        ? t('common.dash')
                        : fmtNum(op.numberAdjusted.to, locale),
                    })
                    : '')
                : op.kind === 'reject'
                  ? t('rules.proposalRejected') + ' · ' + t('rules.proposalCooldown')
                  : op.kind === 'edit'
                    // 编辑可能只改 status＝「无实质改动」，此时别报「已保存」误导。
                    ? (op.changed === false
                      ? t('rules.editNoChange')
                      : t('rules.editDone') + ' · ' + t('rules.agentsSynced'))
                    : op.kind === 'retire'
                      ? t('rules.retireDone')
                      : op.kind === 'reactivate'
                        ? t('rules.reactivateDone')
                        : op.kind === 'purge'
                          // 编号作废要当场说清：列表里已看不到这条规则，只有这句能证明 #n 不再复用。
                          ? t('rules.purgeDone')
                            + (op.number
                              ? ' · ' + t('rules.purgeNumberRetired', {
                                number: fmtNum(op.number, locale),
                                next: fmtNum(op.nextNumber, locale),
                              })
                              : '')
                            + ' · ' + t('rules.agentsSynced')
                          : op.kind === 'revert'
                            ? t('rules.revertDone') + ' · ' + t('rules.agentsSynced')
                            : op.kind === 'restore'
                              ? t('rules.restoreDefaultDone')
                              : op.kind === 'propose' ? t('rules.proposalManualDone') : t('rules.rebuildDone'))
      } else if (op.status === 'error') {
        notice = h('div', { style: css.error },
          t('rules.opFailed') + ' [' + op.code + '] — ' + errText(t, { code: op.code }))
      }

      let listBody = null
      if (list.status === 'loading') listBody = h(StateBlock, { t, status: 'loading' })
      else if (list.status === 'error') listBody = h(StateBlock, { t, status: 'error', err: list.err, onRetry: rerun })
      else if (rules.length === 0) listBody = h(RulesEmptyGuide, {
        t, dir: list.dir, busy, onImport: importLegacy,
        onProposed: () => onProposalChanged({ kind: 'propose' }),
      })
      else if (rulesAllRetired(rules) && filter === 'all' && String(query).trim() === '') {
        // 全部停用且筛选=全部：别把一整页灰行当「正常列表」，直接给空态并给去「已退役」的入口。
        listBody = h('div', { style: css.stack },
          h('div', { style: css.tertiary }, t('rules.emptyNoActive')),
          h('div', null,
            h('button', { style: css.button, onClick: () => { setFilter('retired'); resetPageScroll() } },
              t('rules.emptyRetiredAction'))))
      }
      else if (rows.length === 0) {
        // 首次安装自带默认铁律；空态只在下述两种情况下出现：筛选没命中，或用户把全部规则停用。
        // 全部停用时 retired 行仍在「全部/已退役」里，这里提示去「已退役」找回并重新启用。
        listBody = h(StateBlock, {
          t, status: 'empty',
          empty: t(rulesAllRetired(rules) ? 'rules.emptyNoActive' : 'rules.tableEmpty'),
        })
      }
      else listBody = h(RulesTable, { t, locale, items: rows, onOpen: setDetailKey })

      const filters = [
        ['all', 'rules.filterAll'],
        ['iron', 'rules.filterIron'],
        ['normal', 'rules.filterNormal'],
        ['candidate', 'rules.filterCandidate'],
        ['retired', 'rules.filterRetired'],
      ]

      return h('div', { style: css.stack },
        h(Note, null, t('rules.intro')),
        // 顶部说明条：默认铁律是安装自带、可改可停可删，编号与历史都保留（不写死条数，避免漂移）。
        h(Note, null, t('rules.defaultNotice')),
        h(RulesGitBar, {
          t, locale,
          git: list.status === 'ok' ? list.git : null,
          dir: list.status === 'ok' ? list.dir : '',
          copyState, gitBusy, notice, busy, opKind: op.kind,
          onCopy: copyDir,
          onGuide: () => setGuideOpen(true),
          onRefreshGit: refreshGit,
          onRebuild: rebuildMirror,
        }),
        h('div', { ref: proposalsRef },
          h(RulesProposalsCard, {
            t, locale, proposals,
            onChanged: onProposalChanged,
            onRetry: rerun,
          })),
        h(Card, null,
          h('div', { style: css.inline },
            // 新建是小白主入口：放工具行第一位、品牌色，但不挤占顶部 git 状态条。
            h('button', {
              style: css.buttonPrimary,
              title: t('rules.newHint'),
              onClick: () => setNewOpen(true),
            }, t('rules.new')),
            h('input', {
              style: css.input, value: query,
              placeholder: t('rules.searchPlaceholder'),
              onChange: (e) => { setQuery(e.target.value); resetPageScroll() },
            }),
            h('button', { style: css.button, onClick: rerun }, t('common.refresh')),
            h('button', {
              style: proposalCount > 0 ? css.rulesCountBadgeActive : css.rulesCountBadge,
              onClick: scrollToProposals,
              title: t('rules.proposalsJump'),
            }, t('rules.proposalsCount', { n: fmtNum(proposalCount, locale) }))),
          h('div', { style: css.inline },
            h('div', { style: css.tertiary }, t('rules.filterLabel')),
            filters.map(([value, labelKey]) => h('button', {
              key: value,
              style: filter === value ? css.chipActive : css.chip,
              onClick: () => { setFilter(value); resetPageScroll() },
            }, t(labelKey)))),
          list.status === 'ok' && rules.length > 0
            ? h('div', { style: css.tertiary },
              t('rules.listMeta', { shown: fmtNum(rows.length, locale), total: fmtNum(rules.length, locale) }))
            : null,
          listBody),
        detailKey ? h(RuleDrawer, {
          t, locale, ruleKey: detailKey,
          refreshTick: reloadTick,
          capabilities: list.status === 'ok' ? list.capabilities : {},
          onChanged: onRuleChanged,
          onClose: () => setDetailKey(null),
        }) : null,
        guideOpen ? h(RulesGitGuide, { t, onClose: () => setGuideOpen(false) }) : null,
        newOpen ? h(RulesNewDialog, {
          t, locale,
          onClose: () => setNewOpen(false),
          onCreated: onRuleCreated,
        }) : null)
    }

    /** git 状态条：左=三态/版本/检查时间/安装指引，右=目录（可复制）+ 重建镜像。 */
    function RulesGitBar(props) {
      const {
        t, locale, git, dir, copyState, gitBusy, notice, busy, opKind,
        onCopy, onGuide, onRefreshGit, onRebuild,
      } = props
      const state = rulesGitState(git)
      const toneColor = state.tone === 'ok'
        ? 'var(--dsw-alias-state-success-primary)'
        : state.tone === 'error'
          ? 'var(--dsw-alias-state-error-primary)'
          : state.tone === 'warn'
            ? 'var(--dsw-alias-state-warn-primary)'
            : 'var(--dsw-alias-label-tertiary)'
      const label = state.tone === 'ok'
        ? t('rules.gitOk', { version: state.version || t('common.dash') })
        : state.tone === 'error'
          ? t('rules.gitBroken')
          : state.tone === 'warn' ? t('rules.gitMissing') : t('rules.gitUnknown')
      const detail = state.tone === 'ok'
        ? t('rules.gitChecked', { time: fmtTime(state.checkedAt, locale) })
        : state.tone === 'warn'
          ? t('rules.gitMissingDetail')
          : (state.error || (state.tone === 'error' ? t('rules.gitBroken') : t('rules.gitUnknown')))
      const rebuilding = opKind === 'rebuild' && busy
      return h(Card, null,
        h('div', { style: css.rulesBarTop },
          h('div', { style: css.stack },
            h('div', { style: css.inline },
              h('span', { style: { ...css.dot, background: toneColor } }),
              h('span', { style: css.rulesGitLabel }, t('rules.gitTitle')),
              h('span', { style: css.rulesGitState }, label),
              state.required ? h('span', { style: css.warn }, t('rules.gitRequiredHint')) : null),
            h('div', { style: css.tertiary }, detail)),
          h('div', { style: css.inline },
            h('button', { style: css.button, onClick: onGuide }, t('rules.gitGuide')),
            h('button', {
              style: gitBusy ? css.buttonDisabled : css.button,
              disabled: gitBusy, onClick: onRefreshGit,
            }, gitBusy ? t('common.loading') : t('rules.gitRefresh')))),
        h('div', { style: css.rulesBarTop },
          h('div', { style: css.rulesDirBox },
            h('span', { style: css.tertiary }, t('rules.dirLabel')),
            h('code', { style: css.rulesDirPath }, dir || '~/.dsh/rules'),
            h('button', {
              style: dir ? css.button : css.buttonDisabled,
              disabled: !dir, onClick: onCopy, title: t('rules.mirrorNote'),
            }, copyState === 'ok' ? t('rules.copied')
              : copyState === 'error' ? t('rules.copyFailed') : t('rules.copyDir'))),
          h('button', {
            style: busy ? css.buttonDisabled : css.buttonWarn,
            disabled: Boolean(busy), onClick: onRebuild, title: t('rules.mirrorNote'),
          }, rebuilding ? t('rules.rebuilding') : t('rules.rebuildMirror'))),
        notice)
    }

    // >>> rules-proposals:ui
    /** 关系文案：归一后一定能落到六种之一，新关系宁可显示「无关」也不要空字。 */
    function proposalRelationLabel(t, value) {
      return t(PROPOSAL_RELATION_KEYS[proposalRelationOf({ relation: value })])
    }

    /** 状态文案：归一后一定能落到五态之一，避免未知状态渲染出空标签。 */
    function proposalStatusLabel(t, value) {
      return t(PROPOSAL_STATUS_KEYS[proposalStatusOf({ status: value })])
    }

    /** 提案色调到设计变量：红只给冲突/风险，黄给合并/重复，品牌色给新增/细化。 */
    function proposalToneColor(tone) {
      if (tone === 'error') return 'var(--dsw-alias-state-error-primary)'
      if (tone === 'warn') return 'var(--dsw-alias-state-warn-primary)'
      if (tone === 'ok') return 'var(--dsw-alias-state-success-primary)'
      if (tone === 'brand') return 'var(--dsw-alias-brand-primary)'
      return 'var(--dsw-alias-label-tertiary)'
    }

    /** 关系/状态徽标：同一形状两种语义，颜色由 tone 决定（未知值走中性灰）。 */
    function RulesProposalBadge(props) {
      const { t, kind, value } = props
      const tone = kind === 'relation' ? proposalRelationTone(value) : proposalStatusTone(value)
      const color = proposalToneColor(tone)
      const label = kind === 'relation' ? proposalRelationLabel(t, value) : proposalStatusLabel(t, value)
      return h('span', { style: { ...css.rulesStatusBadge, color, borderColor: color } }, label)
    }

    /** 保留/丢弃子句块：只在有内容时渲染，丢弃用警告色（不抢整页的红）。 */
    function proposalClauseBlock(t, labelKey, clauses, tone) {
      const lines = clauseLines(clauses)
      if (lines.length === 0) return null
      return h('div', { style: css.rulesProposalClause },
        h('div', {
          style: { ...css.fieldLabel, color: tone === 'warn' ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-label-secondary)' },
        }, t(labelKey) + ' · ' + String(lines.length)),
        h('ul', { style: css.rulesList }, lines.map((line, index) => h('li', {
          key: index, style: css.rulesListRow,
        }, line))))
    }

    /**
     * 风险条：守卫未过/有子句被丢弃时出现（冲突/合并提示更重）；
     * 必须勾选 acknowledgeDropped 才放行收录，避免把删除当默认值。
     */
    function RulesProposalRiskBar(props) {
      const { t, risk, ack, onAck } = props
      if (!risk || !risk.risky) return null
      const relationLabel = proposalRelationLabel(t, risk.relation)
      return h('div', { style: css.rulesRiskBar, role: 'alert' },
        h('div', { style: css.rulesRiskTitle },
          t('rules.proposalRiskTitle') + ' · ' + relationLabel),
        risk.guardFailed
          ? h('div', { style: css.rulesRiskLine }, t('rules.proposalRiskGuard'))
          : null,
        risk.dropped.length > 0
          ? h('div', { style: css.rulesRiskLine },
            t('rules.proposalRiskDropped', { n: fmtNum(risk.dropped.length) }))
          : null,
        risk.dropped.length > 0
          ? h('ul', { style: css.rulesRiskDroppedList }, risk.dropped.map((row, index) => h('li', {
            key: index, style: css.rulesRiskDroppedItem,
          }, (row.number === null ? row.key : '#' + String(row.number)) + ' · ' + row.text)))
          : null,
        h('label', { style: css.rulesAckRow },
          h('input', {
            type: 'checkbox', style: css.checkbox,
            checked: Boolean(ack), onChange: (e) => onAck(e.target.checked),
          }),
          h('span', null, t('rules.proposalAckDropped'))))
    }

    /** 改写弹层：预填候选正文，条件/例外/作用域可改；提交即按新正文收录。 */
    function RulesProposalEditor(props) {
      const { t, item, initialText, busy, blocked, onClose, onSubmit } = props
      const candidate = proposalCandidateOf(item)
      const [text, setText] = useState(initialText || candidate.text || '')
      const [conditions, setConditions] = useState(clauseLines(candidate.conditions).join('\n'))
      const [exceptions, setExceptions] = useState(clauseLines(candidate.exceptions).join('\n'))
      const [scope, setScope] = useState(candidate.scope || '')
      const composed = composeProposalText({
        text,
        conditions: conditions.split(/\r?\n/),
        exceptions: exceptions.split(/\r?\n/),
        scope,
      })
      const empty = composed.length === 0
      return h('div', { style: css.rulesGuideMask, onClick: onClose },
        h('aside', { style: css.rulesProposalPanel, onClick: (e) => e.stopPropagation() },
          h('div', { style: css.inline },
            h('div', { style: { ...css.cardTitle, flex: 1 } }, t('rules.proposalRewriteTitle')),
            h('button', { style: css.button, onClick: onClose }, t('common.close'))),
          h('div', { style: css.note }, t('rules.proposalRewriteHint')),
          h('label', { style: css.field },
            h('span', { style: css.fieldLabel }, t('rules.proposalEditorText')),
            h('textarea', {
              style: css.rulesProposalEditorArea, rows: 8, value: text,
              onChange: (e) => setText(e.target.value),
            })),
          h('label', { style: css.field },
            h('span', { style: css.fieldLabel }, t('rules.proposalEditorConditions')),
            h('textarea', {
              style: css.textarea, rows: 3, value: conditions,
              onChange: (e) => setConditions(e.target.value),
            })),
          h('label', { style: css.field },
            h('span', { style: css.fieldLabel }, t('rules.proposalEditorExceptions')),
            h('textarea', {
              style: css.textarea, rows: 3, value: exceptions,
              onChange: (e) => setExceptions(e.target.value),
            })),
          h('label', { style: css.field },
            h('span', { style: css.fieldLabel }, t('rules.proposalEditorScope')),
            h('input', {
              style: css.input, value: scope,
              onChange: (e) => setScope(e.target.value),
            })),
          h('div', { style: css.tertiary }, t('rules.proposalRewriteNote')),
          empty ? h('div', { style: css.warn }, t('rules.proposalRewriteEmpty')) : null,
          blocked ? h('div', { style: css.warn }, t('rules.proposalAckHint')) : null,
          h('div', { style: css.actions },
            h('button', {
              style: empty || busy || blocked ? css.buttonDisabled : css.buttonPrimary,
              disabled: Boolean(empty || busy || blocked),
              onClick: () => { if (!empty && !busy && !blocked) onSubmit(composed) },
            }, busy ? t('common.saving') : t('rules.proposalRewriteSubmit')))))
    }

    /**
     * 单条提案卡：关系/状态徽标 + 正文（≤200 字可展开）+ 编号/优先级/作用域 + 来源 +
     * 受影响旧规则（旧→新、保留/丢弃）+ 守卫失败 + 收录/改写/拒绝。
     */
    function RulesProposalItem(props) {
      const { t, locale, item, onChanged } = props
      const candidate = proposalCandidateOf(item)
      const affected = proposalAffectedOf(item)
      const guard = proposalGuardOf(item)
      const needsManual = proposalNeedsManualOf(item)
      const risk = proposalRiskOf(item)
      const preview = proposalPreview(candidate.text, 200)
      const source = (item && item.source) || {}
      const sourceText = String(source.text || '')
      const identity = (source && source.identity) || {}
      const identityText = [identity.roleId, identity.workspace].filter(Boolean).join(' · ')
      const id = item && item.id !== undefined ? item.id : null
      const [expanded, setExpanded] = useState(false)
      const [ack, setAck] = useState(false)
      const [busy, setBusy] = useState('')
      const [err, setErr] = useState(null)
      const [rewriteOpen, setRewriteOpen] = useState(false)
      const [rejectOpen, setRejectOpen] = useState(false)
      const [reason, setReason] = useState('')
      const gated = risk.requiresAck && !ack

      /**
       * apply 前先取计划指纹（CAS）：面板先 `/rules/plan`，apply 只认 planHash。
       * 501=core plan 未上线 → 降级为不带指纹（旧服务端仍可用）；其它失败直接上报并停，绝不写盘。
       */
      const requestApplyPlan = async (decisions) => {
        try {
          const body = await callJson('/rules/plan', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id, decisions }),
          })
          const planHash = body && body.plan && typeof body.plan.planHash === 'string'
            ? body.plan.planHash
            : ''
          return { ok: true, planHash }
        } catch (failure) {
          const code = (failure && failure.code) || 'plan_failed'
          if (code === 'plan_unavailable' || (failure && failure.status === 501)) {
            return { ok: true, planHash: '', degraded: true }
          }
          const failures = failure && failure.body && Array.isArray(failure.body.failures)
            ? failure.body.failures
            : []
          return { ok: false, code, failures }
        }
      }

      // 同步闸：busy 是 state，重渲染前连点两次会穿透（审计 A5）。
      const busyRef = useRef('')
      const apply = async (text) => {
        if (id === null || gated || busyRef.current) return
        busyRef.current = 'apply'
        setBusy('apply')
        setErr(null)
        const decisions = proposalDecisionsFor({
          text: typeof text === 'string' ? text : '',
          acknowledgeDropped: ack === true,
          dropped: risk.dropped,
        })
        try {
          // 计划不通过（守卫/断链/撞号）→ 只展示失败项，不进入确认、不写盘。
          const planned = await requestApplyPlan(decisions)
          if (!planned.ok) {
            setBusy('')
            setErr({ code: planned.code, failures: planned.failures, plan: true })
            return
          }
          if (!askConfirm(t('rules.proposalApplyConfirm'))) {
            setBusy('')
            return
          }
          const applyBody = { id, decisions }
          if (planned.planHash) applyBody.planHash = planned.planHash
          const body = await callJson('/rules/apply', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(applyBody),
          })
          setBusy('')
          setRewriteOpen(false)
          const applied = body && body.applied
          // 编号被顺延（提案号被占/保留号）必须让用户看见，不能静默写到另一个号。
          const adjusted = applied && applied.numberAdjusted && typeof applied.numberAdjusted === 'object'
            ? applied.numberAdjusted
            : null
          onChanged({
            kind: 'applied',
            key: applied && applied.key ? String(applied.key) : '',
            numberAdjusted: adjusted,
          })
        } catch (failure) {
          setBusy('')
          const failures = failure && failure.body && Array.isArray(failure.body.failures)
            ? failure.body.failures
            : []
          setErr({ code: (failure && failure.code) || 'unknown_error', failures })
        } finally {
          busyRef.current = ''
        }
      }

      const reject = async () => {
        if (id === null || busyRef.current) return
        if (!askConfirm(t('rules.proposalRejectConfirm'))) return
        busyRef.current = 'reject'
        setBusy('reject')
        setErr(null)
        try {
          const trimmed = reason.trim()
          await callJson('/rules/reject', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id, reason: trimmed || undefined }),
          })
          setBusy('')
          onChanged({ kind: 'rejected', id })
        } catch (failure) {
          setBusy('')
          setErr({ code: (failure && failure.code) || 'unknown_error', failures: [] })
        } finally {
          busyRef.current = ''
        }
      }

      const meta = h('div', { style: css.rulesProposalMeta },
        t('rules.proposalMeta', {
          number: candidate.number === null ? '—' : '#' + String(candidate.number),
          priority: candidate.priority === null ? '—' : String(candidate.priority),
          scope: candidate.scope || '—',
        }))

      let bodyText = null
      if (preview.text) {
        bodyText = h('div', { style: css.rulesProposalText },
          h('span', null, expanded ? preview.text : preview.preview),
          preview.truncated
            ? h('button', {
              style: css.rulesInlineButton,
              onClick: () => setExpanded((v) => !v),
            }, expanded ? t('rules.proposalCollapse') : t('rules.proposalExpand'))
            : null)
      } else bodyText = h('div', { style: css.tertiary }, t('common.dash'))

      let affectedBody = null
      if (affected.length > 0) {
        affectedBody = h('div', { style: css.rulesProposalAffect },
          h('div', { style: css.fieldLabel }, t('rules.proposalAffected')),
          affected.map((row, index) => h('div', {
            key: row.key || index, style: css.rulesProposalAffectRow,
          },
          h('div', { style: css.rulesProposalAffectHead },
            h('span', { style: css.rulesProposalAffectKey },
              (row.number === null ? '—' : '#' + String(row.number)) + (row.key ? ' · ' + row.key : '')),
            row.changed ? h('span', { style: css.rulesStatusBadge }, t('rules.proposalChanged')) : null),
          h('div', { style: css.rulesProposalCompare },
            h('div', { style: css.rulesProposalOldText },
              h('span', { style: css.rulesProposalDiffLabel }, t('rules.proposalOld')),
              h('div', { style: css.rulesProposalDiffText }, row.oldText || '—')),
            h('div', { style: css.rulesProposalNewText },
              h('span', { style: css.rulesProposalDiffLabel }, t('rules.proposalNew')),
              h('div', { style: css.rulesProposalDiffText }, row.newText || '—'))),
          proposalClauseBlock(t, 'rules.proposalPreserved', row.preserved),
          proposalClauseBlock(t, 'rules.proposalDropped', row.dropped, 'warn'))))
      }

      let guardBody = null
      if (guard.failures.length > 0) {
        guardBody = h('div', { style: css.rulesProposalGuard },
          h('div', { style: css.warn }, t('rules.proposalGuardFailed')),
          h('ul', { style: css.rulesList }, guard.failures.map((failure, index) => h('li', {
            key: index, style: css.rulesListRow,
          }, '[' + (failure.code || '—') + '] '
            + (failure.key ? failure.key + ' — ' : '')
            + (failure.detail || t('common.dash'))))))
      }

      let errBody = null
      if (needsManual) {
        // 失败候选必须留在面板上并说明原因：它不是死数据，用户要能改写正文后重试同一 id。
        errBody = h('div', { style: css.warnBox },
          h('div', { style: css.warn }, t('rules.proposalNeedsManual')),
          h('div', { style: css.tertiary },
            t('rules.proposalNeedsManualCode', { code: needsManual.code })),
          needsManual.detail ? h('div', { style: css.tertiary }, needsManual.detail) : null)
      }
      if (err) {
        errBody = h('div', { style: css.errorBox },
          h('div', { style: css.error },
            t('rules.opFailed') + ' [' + err.code + '] — ' + errText(t, { code: err.code })),
          err.failures.length > 0
            ? h('ul', { style: css.rulesList }, err.failures.map((failure, index) => h('li', {
              key: index, style: css.rulesListRow,
            }, '[' + ((failure && failure.code) || '—') + '] '
              + ((failure && failure.key) ? failure.key + ' — ' : '')
              + ruleFieldText(failure && failure.detail))))
            : null,
          h('button', { style: css.button, onClick: () => setErr(null) }, t('common.close')))
      }

      const applyDisabled = Boolean(gated || busy)
      return h('div', { style: css.rulesProposalItem },
        h('div', { style: css.rulesProposalHead },
          h('div', { style: css.rulesProposalBadges },
            h(RulesProposalBadge, { t, kind: 'relation', value: item && item.relation }),
            h(RulesProposalBadge, { t, kind: 'status', value: item && item.status }),
            // 语义提炼状态：ready+llm 显示“语义稿”，pending 显示“提炼中”；规则稿不额外加徽标。
            item && item.refine && item.refine.state === 'ready' && item.refine.by === 'llm'
              ? h('span', { style: { ...css.rulesStatusBadge, color: 'var(--dsw-alias-brand-primary)', borderColor: 'var(--dsw-alias-brand-primary)' } }, t('rules.proposalSemantic'))
              : item && item.refine && item.refine.state === 'pending'
                ? h('span', { style: css.rulesStatusBadge }, t('rules.proposalRefining'))
                : null),
          h('div', { style: css.tertiary }, fmtTime(item && item.createdAt, locale))),
        bodyText,
        meta,
        sourceText
          ? h('div', { style: css.rulesProposalSource },
            h('div', { style: css.fieldLabel }, t('rules.proposalSource')),
            h('div', { style: css.rulesProposalSourceText }, proposalPreview(sourceText, 160).preview),
            identityText || (source && source.traceId)
              ? h('div', { style: css.tertiary },
                [identityText, source && source.traceId ? 'trace ' + String(source.traceId) : ''].filter(Boolean).join(' · '))
              : null)
          : null,
        affectedBody,
        guardBody,
        h(RulesProposalRiskBar, { t, risk, ack, onAck: setAck }),
        (item && item.cooling === true)
          ? h('div', { style: css.tertiary }, t('rules.proposalCooling'))
          : null,
        errBody,
        rejectOpen
          ? h('div', { style: css.stack },
            h('label', { style: css.field },
              h('span', { style: css.fieldLabel }, t('rules.proposalRejectReason')),
              h('input', {
                style: css.input, value: reason, maxLength: 120,
                placeholder: t('rules.proposalRejectPlaceholder'),
                onChange: (e) => setReason(e.target.value),
              })),
            h('div', { style: css.actions },
              h('button', {
                style: busy ? css.buttonDisabled : css.buttonWarn,
                disabled: Boolean(busy), onClick: reject,
              }, busy === 'reject' ? t('common.saving') : t('rules.proposalRejectConfirmAction')),
              h('button', { style: css.button, onClick: () => setRejectOpen(false) }, t('common.cancel'))))
          : null,
        h('div', { style: css.actions },
          h('button', {
            style: applyDisabled ? css.buttonDisabled : css.buttonPrimary,
            disabled: applyDisabled, title: gated ? t('rules.proposalAckHint') : t('rules.proposalApplyConfirm'),
            onClick: () => apply(''),
          }, busy === 'apply' ? t('common.saving') : t('rules.proposalApply')),
          h('button', {
            style: busy ? css.buttonDisabled : css.button,
            disabled: Boolean(busy), onClick: () => setRewriteOpen(true),
          }, needsManual ? t('rules.proposalRewriteRetry') : t('rules.proposalRewrite')),
          h('button', {
            style: busy ? css.buttonDisabled : css.buttonWarn,
            disabled: Boolean(busy), onClick: () => setRejectOpen((v) => !v),
          }, t('rules.proposalReject'))),
        rewriteOpen
          ? h(RulesProposalEditor, {
            t, item, initialText: candidate.text, busy: busy === 'apply',
            blocked: gated,
            onClose: () => setRewriteOpen(false),
            onSubmit: apply,
          })
          : null)
    }

    /**
     * 待确认区：404（契约未上线）软降级为空态；其它失败在卡片内给可重试错误态，不报整页红。
     * 列表每条都是真实提案卡；空态文案＝「暂无待确认提案」。
     */
    function RulesProposalsCard(props) {
      const { t, locale, proposals, onChanged, onRetry } = props
      const items = Array.isArray(proposals.items) ? proposals.items : []
      const count = proposals.status === 'ok' ? items.length : 0
      let body = h('div', { style: css.tertiary }, t('rules.proposalsEmpty'))
      if (proposals.status === 'loading') body = h('div', { style: css.muted }, t('rules.proposalLoading'))
      else if (proposals.status === 'error') {
        body = h('div', { style: css.errorBox },
          h('div', { style: css.error }, t('rules.proposalError') + ' — ' + errText(t, proposals.err)),
          onRetry ? h('button', { style: css.button, onClick: onRetry }, t('common.retry')) : null)
      } else if (count > 0) {
        body = h('div', { style: css.stack }, items.map((item, index) => h(RulesProposalItem, {
          key: String((item && item.id) || (item && item.key) || index),
          t, locale, item, onChanged,
        })))
      }
      return h(Card, null,
        h(SectionTitle, null, t('rules.proposalsTitle', { n: fmtNum(count, locale) })),
        body)
    }
    // <<< rules-proposals:ui

    /** 列表表格：编号/类型/优先级/作用域/状态/更新时间/摘要/详情；行 hover 走状态（无样式表可用）。 */
