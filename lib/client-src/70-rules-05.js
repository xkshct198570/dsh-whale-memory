    function RulesEditDialog(props) {
      const { t, locale, rule, history, onClose, onSaved } = props
      const base = rule && typeof rule === 'object' ? rule : {}
      const initialScope = ruleScopeParts(base.scope)
      const [text, setText] = useState(String(base.text === null || base.text === undefined ? '' : base.text))
      const [conditions, setConditions] = useState(ruleLinesFromInput(base.conditions).join('\n'))
      const [exceptions, setExceptions] = useState(ruleLinesFromInput(base.exceptions).join('\n'))
      const [scopeKind, setScopeKind] = useState(initialScope.kind)
      const [scopeValue, setScopeValue] = useState(initialScope.value)
      const [priority, setPriority] = useState(String(base.priority || 'P1').toUpperCase())
      const [status, setStatus] = useState(String(base.status || 'active'))
      const [phase, setPhase] = useState('form')
      const [preview, setPreview] = useState(null)
      const [busy, setBusy] = useState(false)
      const [problem, setProblem] = useState(null)

      const chars = ruleTextChars(text)
      const scopeProblem = ruleScopeProblem(scopeKind, scopeValue)
      const textProblem = chars === 0 ? 'body_empty' : chars > RULE_BODY_MAX ? 'body_too_long' : null
      const draft = {
        text,
        conditions,
        exceptions,
        scope: ruleScopeValue(scopeKind, scopeValue),
        priority,
        status,
      }
      const edit = ruleEditPatch(base, draft)
      const blocked = Boolean(textProblem || scopeProblem)
      const retiring = status === 'retired' && String(base.status || '') !== 'retired'
      // 预览阶段锁死表单：确认提交的必须是「预览过的那一份」，避免改完不重预览就提交。
      const editing = phase === 'form'

      /** 本地校验/合同错误码 → 文案：作用域与正文问题不走 err.* 表（后端没有这些码）。 */
      const localProblemText = (code) => {
        if (code === 'body_empty' || code === 'body_too_long') return t('rules.editInvalidText')
        if (code === 'invalid_patch') return t('err.invalid_patch')
        if (code === 'no_change') return t('rules.editNoChange')
        if (String(code || '').startsWith('scope_')) return t('rules.editScopeInvalid')
        return ''
      }

      const scopeOptions = [
        ['global', t('rules.editScopeGlobal')],
        ['workspace', t('rules.editScopeWorkspace')],
        ['role', t('rules.editScopeRole')],
      ]
      if (scopeKind === 'custom') scopeOptions.push(['custom', t('rules.editScopeOther')])

      /**
       * 生成变更预览：有当前版本时先用 /rules/diff?key&rev=<当前版本> 取服务端认定的
       * 当前正文（newText），把它当基线；请求失败或无当前版本就用 rule.text 当基线。
       * 无论如何都本地逐行对比草稿——预览要回答的是「这次编辑会改成什么」。
       */
      const buildPreview = async () => {
        if (blocked) {
          setProblem({ code: textProblem || scopeProblem, detail: null })
          return
        }
        if (edit.fields.length === 0) {
          setProblem({ code: 'no_change', detail: null })
          return
        }
        setBusy(true)
        setProblem(null)
        let baseline = String(base.text === null || base.text === undefined ? '' : base.text)
        let source = 'local'
        const currentRev = ruleCurrentRev(base, history)
        if (currentRev) {
          try {
            const body = await callJson('/rules/diff?key=' + encodeURIComponent(String(base.key || ''))
              + '&rev=' + encodeURIComponent(currentRev))
            if (body && typeof body.newText === 'string' && body.newText) {
              baseline = body.newText
              source = 'server'
            } else if (body && typeof body.oldText === 'string' && body.oldText) {
              baseline = body.oldText
              source = 'server'
            }
          } catch {
            // 服务端 diff 不可用（R5 未上线/无 git）：保留本地基线，不阻断编辑。
          }
        }
        setPreview({
          rows: lineDiff(baseline, String(draft.text || '')),
          source,
          fields: edit.fields,
          patch: edit.patch,
        })
        setPhase('preview')
        setBusy(false)
      }

      /**
       * 提交：退役＝语义从「会注入」变「不再注入」，先按「不再注入但保留历史」单独确认；
       * 再确认写入文件/新版本/AGENTS 摘要。载荷严格只有 {key,patch}（key 只读，服务端拒绝改）。
       */
      const submit = async () => {
        if (busy || blocked) return
        if (retiring && !askConfirm(t('rules.editRetireConfirm'))) return
        if (!askConfirm(t('rules.editConfirm'))) return
        setBusy(true)
        setProblem(null)
        const patch = preview && phase === 'preview' ? preview.patch : edit.patch
        try {
          const body = await callJson('/rules/update', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ key: String(base.key || ''), patch }),
          })
          if (typeof onSaved === 'function') {
            onSaved({
              kind: 'edit',
              changed: body && body.changed !== false,
              commit: body && body.commit ? String(body.commit) : '',
            })
          }
        } catch (err) {
          setProblem({
            code: (err && err.code) || 'unknown_error',
            detail: err && err.body ? err.body.detail : null,
          })
        } finally {
          setBusy(false)
        }
      }

      let problemNode = null
      if (problem) {
        const local = localProblemText(problem.code)
        const detail = ruleErrorDetailText(problem.detail)
        problemNode = h('div', { style: css.errorBox, role: 'alert' },
          h('div', { style: css.error },
            t('rules.opFailed') + ' [' + problem.code + '] — ' + (local || errText(t, { code: problem.code }))),
          detail ? h('div', { style: css.tertiary }, t('rules.errInvalidDetail', { detail })) : null,
          problem.code === 'git_required' ? h('div', { style: css.warn }, t('rules.errGitHint')) : null)
      }

      return h('div', { style: css.rulesGuideMask, onClick: busy ? undefined : onClose },
        h('aside', { style: css.rulesEditPanel, onClick: (e) => e.stopPropagation() },
          h('div', { style: css.inline },
            h('div', { style: { ...css.cardTitle, flex: 1 } }, t('rules.editTitle')),
            h('button', { style: css.button, onClick: onClose }, t('common.close'))),
          h('div', { style: css.note }, t('rules.editHint')),
          h('div', { style: css.rulesEditReadonly },
            h(Row, { k: t('rules.fieldNumber'), v: ruleNumberText(base) }),
            h(Row, { k: t('rules.fieldType'), v: ruleTypeLabel(t, base.type) }),
            h(Row, { k: t('rules.fieldKey'), v: String(base.key || '—') }),
            h('div', { style: { ...css.tertiary, gridColumn: '1 / -1' } }, t('rules.editImmutableNote'))),
          h('label', { style: css.field },
            h('span', { style: css.fieldLabel }, t('rules.editTextLabel')),
            h('textarea', {
              style: css.rulesProposalEditorArea, rows: 8, maxLength: RULE_BODY_MAX,
              value: text, disabled: !editing,
              onChange: (e) => setText(e.target.value),
            }),
            h('div', { style: chars > RULE_BODY_MAX ? css.warn : css.tertiary },
              t('common.charCount', { n: fmtNum(chars, locale), max: fmtNum(RULE_BODY_MAX, locale) }))),
          h('label', { style: css.field },
            h('span', { style: css.fieldLabel }, t('rules.editConditionsLabel')),
            h('textarea', {
              style: css.textarea, rows: 3, value: conditions, disabled: !editing,
              onChange: (e) => setConditions(e.target.value),
            })),
          h('label', { style: css.field },
            h('span', { style: css.fieldLabel }, t('rules.editExceptionsLabel')),
            h('textarea', {
              style: css.textarea, rows: 3, value: exceptions, disabled: !editing,
              onChange: (e) => setExceptions(e.target.value),
            })),
          h('div', { style: css.rulesEditGrid },
            h('label', { style: css.field },
              h('span', { style: css.fieldLabel }, t('rules.editScopeLabel')),
              h(SelectInput, {
                value: scopeKind, options: scopeOptions, disabled: !editing, onChange: setScopeKind,
              })),
            scopeKind === 'global' ? null : h('label', { style: css.field },
              h('span', { style: css.fieldLabel }, t('rules.editScopeValueLabel')),
              h(TextInput, {
                value: scopeValue, disabled: !editing, onChange: setScopeValue,
                placeholder: scopeKind === 'workspace'
                  ? t('rules.editScopeWorkspacePlaceholder')
                  : t('rules.editScopeRolePlaceholder'),
              })),
            h('label', { style: css.field },
              h('span', { style: css.fieldLabel }, t('rules.editPriorityLabel')),
              h(SelectInput, {
                value: priority,
                options: rulePriorityOptions(priority).map((value) => [value, value]),
                disabled: !editing,
                onChange: setPriority,
              })),
            h('label', { style: css.field },
              h('span', { style: css.fieldLabel }, t('rules.editStatusLabel')),
              h(SelectInput, {
                value: status,
                options: [['active', t('rules.editStatusActive')], ['retired', t('rules.editStatusRetired')]],
                disabled: !editing,
                onChange: setStatus,
              }))),
          retiring ? h('div', { style: css.warnBox }, t('rules.editRetiredHint')) : null,
          blocked ? h('div', { style: css.warn }, localProblemText(textProblem || scopeProblem)) : null,
          phase === 'preview' && preview
            ? h('div', { style: css.rulesDiff },
              h('div', { style: css.fieldLabel }, t('rules.editPreviewTitle')),
              h('div', { style: css.rulesFieldChips },
                preview.fields.map((field) => h('span', {
                  key: field, style: css.rulesFieldChip,
                }, ruleEditFieldLabel(t, field)))),
              h('div', { style: css.inline },
                h('span', { style: css.rulesDiffTagOld }, t('rules.diffOld') + ' · ' + ruleEditFieldLabel(t, 'text')),
                h('span', { style: css.rulesDiffTagNew }, t('rules.diffNew'))),
              preview.fields.includes('text')
                ? h(RulesDiffRows, { t, rows: preview.rows })
                // 只改优先级/状态时正文一致是正常的，别让「正文一致」被误读成没改动。
                : h('div', { style: css.tertiary }, t('rules.editDiffFieldsOnly')),
              h('div', { style: css.tertiary },
                preview.source === 'server'
                  ? t('rules.editDiffServerNote')
                  : t('rules.editDiffLocalNote')))
            : null,
          problemNode,
          h('div', { style: css.actions },
            phase === 'preview'
              ? h('button', {
                style: css.button,
                onClick: () => { setPhase('form'); setPreview(null); setProblem(null) },
              }, t('rules.editBack'))
              : null,
            phase === 'preview'
              ? h('button', {
                style: busy || blocked ? css.buttonDisabled : css.buttonPrimary,
                disabled: Boolean(busy || blocked), onClick: submit,
              }, busy ? t('common.saving') : t('rules.editSubmit'))
              : h('button', {
                style: busy || blocked ? css.buttonDisabled : css.buttonPrimary,
                disabled: Boolean(busy || blocked), onClick: buildPreview,
              }, busy ? t('common.loading') : t('rules.editPreview')))))
    }

    function RuleDrawer(props) {
      const { t, locale, ruleKey, refreshTick, capabilities, onChanged, onClose } = props
      const [loaded, setLoaded] = useState({ status: 'loading' })
      const [selected, setSelected] = useState(null)
      const [serverDiff, setServerDiff] = useState({ status: 'idle', rows: null, rev: null })
      const [feedback, setFeedback] = useState(null)
      const [editOpen, setEditOpen] = useState(false)
      const [revertBusy, setRevertBusy] = useState(false)
      const [statusBusy, setStatusBusy] = useState(false)
      const [purgeBusy, setPurgeBusy] = useState(false)
      // 追加在最后：运行时冒烟测试按 useState 调用序号喂预设，新增状态不能插队。
      const [retryTick, setRetryTick] = useState(0)
      const [restoreBusy, setRestoreBusy] = useState(false)
      // DangerButton 的输入闸：必须是用户手打的整句 key，输入不符不发请求（服务端同样校验）。
      const [purgeKeyInput, setPurgeKeyInput] = useState('')

      // Esc 关闭抽屉（R9-07 第 6 条）：遮罩点击已能关，键盘用户不该只能找鼠标。
      // Why 判 editOpen：编辑弹层开着时 Esc 只该关弹层，不能把外层详情一起关掉。
      useEffect(() => {
        if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined
        const onKeyDown = (event) => {
          if (event && event.key === 'Escape' && !editOpen) onClose()
        }
        document.addEventListener('keydown', onKeyDown)
        return () => document.removeEventListener('keydown', onKeyDown)
      }, [onClose, editOpen])

      useEffect(() => {
        let alive = true
        setLoaded({ status: 'loading' })
        setSelected(null)
        // 详情 + 版本时间线并行：`/rules/versions` 带 git 提交，详情 history 只有快照正文；
        // 任一接口缺失都退回另一条，抽屉历史不能因为一个新端点没上线就变空。
        Promise.all([
          callJson('/rules/' + encodeURIComponent(ruleKey)),
          callJson('/rules/versions?key=' + encodeURIComponent(ruleKey)).catch(() => null),
        ]).then(([body, versionsBody]) => {
          if (!alive) return
          const rule = (body && body.rule) || {}
          const history = Array.isArray(body && body.history)
            ? body.history
            : Array.isArray(rule.history) ? rule.history : []
          const versions = versionsBody && Array.isArray(versionsBody.versions) ? versionsBody.versions : []
          const merged = versions.length > 0 ? mergeRuleVersions(history, versions) : history
          setLoaded({ status: 'ok', rule, history: merged })
        }).catch((err) => {
          if (alive) setLoaded({ status: 'error', err })
        })
        return () => { alive = false }
      }, [ruleKey, refreshTick, retryTick])

      /**
       * 选中历史版本后先问服务端要 diff（R5 契约 `{oldText,newText,diff:[{type,text}]}`）；
       * 服务端失败/形状不对就把状态切到 local，渲染时退回本地 lineDiff —— 只读面板在
       * 服务端未上线或没有 git 的机器上必须照样能对比。
       */
      useEffect(() => {
        if (selected === null) {
          setServerDiff({ status: 'idle', rows: null, rev: null })
          return undefined
        }
        let alive = true
        setServerDiff({ status: 'loading', rows: null, rev: String(selected) })
        callJson('/rules/diff?key=' + encodeURIComponent(ruleKey) + '&rev=' + encodeURIComponent(String(selected)))
          .then((body) => {
            if (!alive) return
            const rows = ruleDiffRowsFromServer(body)
            setServerDiff(rows
              // 以「请求时选中的 rev」为准：服务端回显格式不同也不能让 diff 被当成本地兜底。
              ? { status: 'ok', rows, rev: String(selected) }
              : { status: 'local', rows: null, rev: String(selected) })
          }).catch(() => {
            if (alive) setServerDiff({ status: 'local', rows: null, rev: String(selected) })
          })
        return () => { alive = false }
      }, [ruleKey, refreshTick, selected])

      /** 回滚：生成新版本、历史不删除；成功后由父级 reloadTick 刷新列表/详情/AGENTS。 */
      const revert = async (rule, item) => {
        if (!item || revertBusy) return
        if (!askConfirm(t('rules.revertConfirm'))) return
        setRevertBusy(true)
        setFeedback(null)
        try {
          const body = await callJson('/rules/revert', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ key: String(rule.key || ruleKey), rev: String(item.rev) }),
          })
          setSelected(null)
          setFeedback({ status: 'ok', kind: 'revert', rev: String(item.rev), commit: body && body.commit ? String(body.commit) : '' })
          if (typeof onChanged === 'function') {
            onChanged({ kind: 'revert', changed: true, commit: body && body.commit ? String(body.commit) : '', rev: String(item.rev) })
          }
        } catch (err) {
          setFeedback({
            status: 'error',
            kind: 'revert',
            code: (err && err.code) || 'unknown_error',
            detail: err && err.body ? err.body.detail : null,
          })
        } finally {
          setRevertBusy(false)
        }
      }

      /**
       * 停用 / 重新启用：走 POST /rules/delete {key,mode:'retire'|'reactivate'}。
       * Why 二次确认写清保留项：停用会立刻不再注入/生效，但文件、历史与编号都保留、可随时
       * 重新启用；老文案只写「退役」会让小白以为文件被删。默认铁律再多一句专属提示。
       */
      const toggleStatus = async (rule) => {
        if (statusBusy) return
        const current = String((rule && rule.status) || '').trim()
        if (!ruleCanToggleStatus(current)) return
        const mode = ruleRetireMode(current)
        const confirmText = mode === 'retire'
          ? t('rules.retireConfirm') + (ruleIsDefault(rule) ? '\n\n' + t('rules.retireDefaultHint') : '')
          : t('rules.reactivateConfirm')
        if (!askConfirm(confirmText)) return
        setStatusBusy(true)
        setFeedback(null)
        try {
          const body = await callJson('/rules/delete', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ key: String((rule && rule.key) || ruleKey), mode }),
          })
          const nextStatus = body && body.status
            ? String(body.status)
            : (mode === 'reactivate' ? 'active' : 'retired')
          setFeedback({ status: 'ok', kind: 'status', mode, status: nextStatus })
          if (typeof onChanged === 'function') {
            onChanged({ kind: mode === 'reactivate' ? 'reactivate' : 'retire', status: nextStatus })
          }
        } catch (err) {
          setFeedback({
            status: 'error',
            kind: 'status',
            code: (err && err.code) || 'unknown_error',
            detail: err && err.body ? err.body.detail : null,
          })
        } finally {
          setStatusBusy(false)
        }
      }

      /**
       * 编辑成功：关弹层、抽屉内给成功提示，并让父级刷新详情/列表/AGENTS（同一 reloadTick）。
       */
      const onEditSaved = (event) => {
        setEditOpen(false)
        setSelected(null)
        setFeedback({
          status: 'ok',
          kind: 'edit',
          changed: !(event && event.changed === false),
          commit: (event && event.commit) || '',
        })
        if (typeof onChanged === 'function') onChanged(event || { kind: 'edit', changed: true })
      }

      /**
       * 彻底删除（purge）：走 POST /rules/delete {key,mode:'purge'}。
       *
       * Why 与「停用」分开一个按钮：停用只是不再注入、文件/编号/历史都还在；purge 会物理删
       * 规则文件、编号作废且永不复用，属于不可撤销动作。确认文案必须把四件事写全：
       * 文件被删、不可撤销、编号作废、历史快照仍可在 git/history 追溯；默认铁律另加一句
       * "删除后不会自动恢复"（播种只做一次）。
       *
       * 成功后直接关抽屉：规则已从列表消失，留着详情只会显示 rule_not_found；父级
       * onChanged 触发 reloadTick，列表/提案/git 一起刷新，topbar 提示编号作废与下一个编号。
       */
      const purgeRuleNow = async (rule) => {
        if (purgeBusy || statusBusy) return
        const purgeKey = String((rule && rule.key) || ruleKey)
        // 输入不符直接不发请求：这是不可撤销动作的唯一确认闸（不用 window.confirm 代替）。
        if (String(purgeKeyInput || '').trim() !== purgeKey) {
          setFeedback({ status: 'error', kind: 'purge', code: 'confirm_required', detail: null })
          return
        }
        setPurgeBusy(true)
        setFeedback(null)
        try {
          const body = await callJson('/rules/delete', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ key: purgeKey, mode: 'purge', confirmKey: purgeKey }),
          })
          setSelected(null)
          setPurgeKeyInput('')
          const event = {
            kind: 'purge',
            number: body && body.number !== undefined ? Number(body.number) : null,
            nextNumber: body && body.nextNumber !== undefined ? Number(body.nextNumber) : null,
            retiredNumbers: Array.isArray(body && body.retiredNumbers) ? body.retiredNumbers : [],
            commit: body && body.commit ? String(body.commit) : '',
          }
          setFeedback({ status: 'ok', ...event })
          if (typeof onChanged === 'function') onChanged(event)
          // 规则已不存在：关抽屉，别让父级再用旧 key 拉详情。
          if (typeof onClose === 'function') onClose()
        } catch (err) {
          setFeedback({
            status: 'error',
            kind: 'purge',
            code: (err && err.code) || 'unknown_error',
            detail: err && err.body ? err.body.detail : null,
          })
        } finally {
          setPurgeBusy(false)
        }
      }

      /**
       * 恢复默认（仅安装自带默认铁律 + 后端提供能力时出现）：
       * 用包内默认正文覆盖并生成新版本，历史保留；能力未上线时按钮根本不渲染。
       */
      const restoreDefaultRule = async (rule) => {
        if (restoreBusy || !(capabilities && capabilities.restoreDefault === true)) return
        if (!askConfirm(t('rules.restoreDefaultConfirm'))) return
        setRestoreBusy(true)
        setFeedback(null)
        try {
          await callJson('/rules/restore-default', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ key: String((rule && rule.key) || ruleKey) }),
          })
          setSelected(null)
          setFeedback({ status: 'ok', kind: 'restore' })
          if (typeof onChanged === 'function') onChanged({ kind: 'restore', changed: true })
        } catch (err) {
          setFeedback({
            status: 'error',
            kind: 'restore',
            code: (err && err.code) || 'unknown_error',
            detail: err && err.body ? err.body.detail : null,
          })
        } finally {
          setRestoreBusy(false)
        }
      }

      let body = null
      if (loaded.status === 'loading') body = h(StateBlock, { t, status: 'loading' })
      else if (loaded.status === 'error') {
        // 详情失败必须能重试：规则文件/git 抖动时用户不该只能关掉抽屉再点一遍。
        body = h(StateBlock, { t, status: 'error', err: loaded.err, onRetry: () => setRetryTick((v) => v + 1) })
      }
      else {
        const rule = loaded.rule || {}
        const text = String(rule.text || '')
        const history = loaded.history || []
        const selectedItem = selected === null
          ? null
          : history.find((item) => item && String(item.rev) === String(selected))
        const currentRev = ruleCurrentRev(rule, history)
        const selectedIsCurrent = selectedItem !== null && currentRev !== null
          && String(selectedItem.rev) === currentRev
        const statusKey = String(rule.status || '').trim().toLowerCase()
        const isRetired = statusKey === 'retired'
        const canToggle = ruleCanToggleStatus(statusKey)
        let diffBody = null
        if (selectedItem) {
          // 服务端 diff 优先；未拿到（未上线/失败/形状不对）就本地逐行对比，并说明来源。
          const serverRows = selected === null || serverDiff.rev !== String(selected) ? null : serverDiff.rows
          // git 提交条目在 versions 里没有正文：没有旧正文时不做本地 diff（否则会把全文误报成新增）。
          const localRows = typeof selectedItem.text === 'string' && selectedItem.text !== ''
            ? lineDiff(selectedItem.text, text)
            : null
          const rows = Array.isArray(serverRows) ? serverRows : (localRows || [])
          const sourceNote = Array.isArray(serverRows) || localRows
            ? null
            : serverDiff.status === 'loading' ? t('rules.diffLoading') : t('rules.diffServerFail')
          diffBody = h('div', { style: css.rulesDiff },
            h('div', { style: css.fieldLabel }, t('rules.diff')),
            h('div', { style: css.inline },
              h('span', { style: css.rulesDiffTagOld }, t('rules.diffOld') + ' · ' + String(selectedItem.rev || '—')),
              h('span', { style: css.rulesDiffTagNew }, t('rules.diffNew'))),
            rows.length > 0 || localRows ? h(RulesDiffRows, { t, rows }) : null,
            sourceNote ? h('div', { style: css.tertiary }, sourceNote) : null,
            selectedIsCurrent ? h('div', { style: css.tertiary }, t('rules.currentRevHint')) : null)
        } else {
          diffBody = h('div', { style: css.tertiary }, t('rules.historyHint'))
        }

        /** 抽屉内反馈（写动作成功/失败都留在详情里，不被外层遮罩挡住）。 */
        let feedbackNode = null
        if (feedback) {
          if (feedback.status === 'ok') {
            feedbackNode = h('div', { style: css.ok },
              feedback.kind === 'revert'
                ? t('rules.revertDone') + ' · ' + t('rules.agentsSynced')
                : feedback.kind === 'restore'
                  ? t('rules.restoreDefaultDone')
                  : feedback.kind === 'status'
                  ? (feedback.mode === 'reactivate' ? t('rules.reactivateDone') : t('rules.retireDone'))
                  : feedback.kind === 'purge'
                    ? t('rules.purgeDone')
                    : (feedback.changed === false
                      ? t('rules.editNoChange')
                      : t('rules.editDone') + ' · ' + t('rules.agentsSynced')))
          } else {
            const detail = ruleErrorDetailText(feedback.detail)
            feedbackNode = h('div', { style: css.errorBox, role: 'alert' },
              h('div', { style: css.error },
                t('rules.opFailed') + ' [' + feedback.code + '] — ' + errText(t, { code: feedback.code })),
              detail ? h('div', { style: css.tertiary }, t('rules.errInvalidDetail', { detail })) : null,
              feedback.code === 'git_required' ? h('div', { style: css.warn }, t('rules.errGitHint')) : null)
          }
        }

        body = h('div', { style: css.stack },
          h('div', { style: css.fieldLabel }, t('rules.detailTitle')),
          h('div', { style: css.inline },
            h('div', { style: { ...css.cardTitle, flex: 1, wordBreak: 'break-word' } },
              String(rule.title || rule.key || ruleKey)),
            isRetired
              ? h('span', { style: css.rulesRetiredBadge }, t('rules.retiredBadge'))
              : h(RulesStatusBadge, { t, value: rule.status }),
            h('button', { style: css.button, onClick: onClose }, t('common.close'))),
          h('div', { style: css.tertiary }, String(rule.key || ruleKey)),
          ruleIsDefault(rule) ? h('div', { style: css.rulesDefaultNote }, t('rules.defaultOriginNote')) : null,
          h('div', { style: css.metaGrid },
            h(Row, { k: t('rules.fieldNumber'), v: Number.isFinite(Number(rule.number)) ? String(rule.number) : '—' }),
            h(Row, { k: t('rules.fieldType'), v: ruleTypeLabel(t, rule.type) }),
            h(Row, { k: t('rules.fieldPriority'), v: rule.priority !== undefined && rule.priority !== null ? String(rule.priority) : '—' }),
            h(Row, { k: t('rules.fieldScope'), v: rule.scope || '—' }),
            h(Row, { k: t('rules.fieldRole'), v: rule.role || '—' }),
            h(Row, { k: t('rules.fieldStatus'), v: ruleStatusLabel(t, rule.status) }),
            h(Row, { k: t('rules.fieldCreated'), v: fmtTime(rule.created, locale) }),
            h(Row, { k: t('rules.fieldUpdated'), v: fmtTime(rule.updated, locale) }),
            h(Row, { k: t('rules.fieldVersion'), v: rule.version !== undefined && rule.version !== null ? String(rule.version) : '—' }),
            h(Row, { k: t('rules.fieldOrigin'), v: ruleFieldText(rule.origin) || '—' }),
            h(Row, { k: t('rules.fieldPath'), v: rule.path || '—' }),
            h(Row, { k: t('rules.fieldMergedInto'), v: rule.merged_into || '—' }),
            h(Row, { k: t('rules.fieldSupersededBy'), v: rule.superseded_by || '—' })),
          h('div', { style: css.metaBlock },
            h(SectionTitle, null, t('rules.bodyTitle')),
            h('pre', { style: css.rulesBody, 'data-wm-scroll': 'drawer' }, text || '—')),
          h('div', { style: css.metaBlock },
            h(SectionTitle, null, t('rules.conditions')),
            ruleList(rule.conditions, t)),
          h('div', { style: css.metaBlock },
            h(SectionTitle, null, t('rules.exceptions')),
            ruleList(rule.exceptions, t)),
          h('div', { style: css.metaBlock },
            h(SectionTitle, null, t('rules.history')),
            history.length === 0
              ? h('div', { style: css.tertiary }, t('rules.historyEmpty'))
              // 30 是业务上限（最近的版本足够回滚），容器不设高：纵向交给页根本体。
              : h('div', { style: css.stack }, history.slice(0, 30).map((item, index) => {
                const rev = String((item && item.rev) || index)
                const source = String((item && item.source) || 'snapshot')
                const isCurrent = currentRev !== null && String(rev) === currentRev
                return h('button', {
                  key: rev,
                  style: selected === rev ? css.rulesHistoryActive : css.rulesHistoryRow,
                  onClick: () => setSelected((prev) => (prev === rev ? null : rev)),
                },
                h('span', { style: css.rulesHistoryRev }, rev),
                item && item.subject
                  ? h('span', { style: css.rulesHistorySubject }, String(item.subject).slice(0, 120))
                  : null,
                isCurrent ? h('span', { style: css.rulesHistoryCurrent }, t('rules.currentRev')) : null,
                h('span', { style: css.tertiary }, fmtTime(item && item.ts, locale)),
                h('span', { style: css.rulesHistorySource },
                  source === 'git' ? t('rules.historySourceGit') : t('rules.historySourceSnapshot')))
              })),
            diffBody),
          feedbackNode,
          h('div', { style: css.inline },
            h('button', {
              style: !canToggle || statusBusy ? css.buttonDisabled : (isRetired ? css.button : css.buttonWarn),
              disabled: !canToggle || statusBusy,
              onClick: () => toggleStatus(rule),
              title: canToggle
                ? (isRetired ? t('rules.reactivateConfirm') : t('rules.retireConfirm'))
                : t('rules.toggleUnavailable'),
            }, statusBusy ? t('common.saving') : (isRetired ? t('rules.reactivate') : t('rules.retire'))),
            h('button', {
              style: !selectedItem || selectedIsCurrent || revertBusy ? css.buttonDisabled : css.buttonWarn,
              disabled: !selectedItem || selectedIsCurrent || revertBusy,
              onClick: () => revert(rule, selectedItem),
              title: !selectedItem
                ? t('rules.rollbackSelectHint')
                : selectedIsCurrent ? t('rules.rollbackCurrentHint') : t('rules.rollbackHint'),
            }, revertBusy ? t('rules.revertBusy') : t('rules.rollback')),
            // 恢复默认只在「安装自带默认铁律 + 后端提供能力」时出现；能力未上线直接隐藏。
            ruleIsDefault(rule) && capabilities && capabilities.restoreDefault === true
              ? h('button', {
                style: restoreBusy ? css.buttonDisabled : css.button,
                disabled: Boolean(restoreBusy),
                onClick: () => restoreDefaultRule(rule),
                title: t('rules.restoreDefaultConfirm'),
              }, restoreBusy ? t('common.saving') : t('rules.restoreDefault'))
              : null,
            h('button', {
              style: css.buttonPrimary,
              onClick: () => setEditOpen(true),
            }, t('rules.edit'))),
          h('div', { style: css.metaBlock },
            h(SectionTitle, null, t('rules.purge')),
            h('div', { style: css.errorBox, role: 'group', 'aria-label': t('rules.purgeHint') },
              h('div', { style: css.error }, t('rules.purgeConfirm')),
              ruleIsDefault(rule) ? h('div', { style: css.warn }, t('rules.purgeDefaultHint')) : null,
              h('div', { style: css.fieldLabel }, t('rules.purgeKeyLabel', { key: String(rule.key || ruleKey) })),
              h(TextInput, {
                value: purgeKeyInput,
                placeholder: t('rules.purgeKeyPlaceholder'),
                onChange: (next) => setPurgeKeyInput(next),
                disabled: purgeBusy || statusBusy,
              }),
              h('button', {
                style: purgeBusy || statusBusy || String(purgeKeyInput || '').trim() !== String(rule.key || ruleKey)
                  ? css.buttonDisabled
                  : css.buttonDanger,
                disabled: purgeBusy || statusBusy || String(purgeKeyInput || '').trim() !== String(rule.key || ruleKey),
                onClick: () => purgeRuleNow(rule),
                title: t('rules.purgeHint'),
              }, purgeBusy ? t('common.saving') : t('rules.purge')))))
      }

      return h('div', { style: css.drawerMask, onClick: onClose },
        h('aside', {
          style: css.rulesDrawer,
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': t('rules.detailTitle'),
          tabIndex: -1,
          autoFocus: true,
          onClick: (e) => e.stopPropagation(),
          onKeyDown: (event) => trapDialogFocus(event),
        },
          body,
          editOpen && loaded.status === 'ok'
            ? h(RulesEditDialog, {
              t, locale,
              rule: loaded.rule || {},
              history: loaded.history || [],
              onClose: () => setEditOpen(false),
              onSaved: onEditSaved,
            })
            : null))
    }

    // ----------------------------------------------------------------- recall

    /** 召回命中的评分分解：rel/mult/gain/effWeight + 命中路径 + 命中词。 */
