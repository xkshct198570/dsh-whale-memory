    function RulesTable(props) {
      const { t, locale, items, onOpen } = props
      const [hover, setHover] = useState(null)
      // 390px 窄屏下不横向溢出：外层滚动容器，表格保持最小可读宽度。
      // 纵向交给页根（R9-07 单一纵向滚动根）：这里只横滚，表头靠 css.th 的 sticky 跟随页根。
      // 虚拟化阈值：规则行 > 200 条的判据＝列表 >200 行 且 单帧渲染耗时 > 16ms（1280×800 实测）。
      // 当前 17 条不做窗口化，提前引入组件只会让主流程更厚（R9-07 第 7 条）。
      return h('div', { style: { overflowX: 'auto', overflowY: 'clip', scrollbarWidth: 'thin', scrollbarColor: 'var(--dsw-alias-border-l1) transparent' } },
        h('table', { style: css.table },
          h('thead', null, h('tr', null,
            h('th', { style: css.th }, t('rules.colNumber')),
            h('th', { style: css.th }, t('rules.colType')),
            h('th', { style: css.th }, t('rules.colPriority')),
            h('th', { style: css.th }, t('rules.colScope')),
            h('th', { style: css.th }, t('rules.colStatus')),
            h('th', { style: css.th }, t('rules.colUpdated')),
            h('th', { style: css.th }, t('rules.colExcerpt')),
            h('th', { style: css.th }, t('rules.colOps')))),
          h('tbody', null, items.map((rule, index) => {
            const rowKey = String((rule && rule.key) || index)
            return h('tr', {
              key: rowKey,
              style: hover === rowKey ? { ...css.rulesRow, ...css.rulesRowHover } : css.rulesRow,
              onMouseEnter: () => setHover(rowKey),
              onMouseLeave: () => setHover((prev) => (prev === rowKey ? null : prev)),
              onClick: () => onOpen(rule && rule.key),
            },
            h('td', { style: css.td }, ruleNumberText(rule)),
            h('td', { style: css.td }, h('div', { style: css.rulesTypeCell },
              h(RulesTypeBadge, { t, value: rule && rule.type }),
              ruleIsDefault(rule) ? h(RulesDefaultBadge, { t }) : null,
              ruleIsRetired(rule) ? h(RulesRetiredBadge, { t }) : null)),
            h('td', { style: css.td },
              rule && rule.priority !== undefined && rule.priority !== null ? String(rule.priority) : '—'),
            h('td', { style: css.td },
              h('span', { style: css.rulesScope, title: String((rule && rule.scope) || '') },
                shortPath((rule && rule.scope) || '—', 28))),
            h('td', { style: css.td }, h(RulesStatusBadge, { t, value: rule && rule.status })),
            h('td', { style: css.td }, fmtTime(rule && rule.updated, locale)),
            h('td', { style: css.td }, h('div', { style: css.cellText }, ruleSummary(rule, 60) || '—')),
            h('td', { style: css.td },
              h('button', {
                style: css.button,
                onClick: (e) => { e.stopPropagation(); onOpen(rule && rule.key) },
              }, t('rules.detail'))))
          }))))
    }

    /** 类型徽标：iron-rule=铁律，rule-candidate=候选规则，rule=普通规则；未知原样。 */
    function RulesTypeBadge(props) {
      const { t, value } = props
      return h('span', { style: css.rulesTypeBadge }, ruleTypeLabel(t, value))
    }

    /** 「默认」小徽标：安装自带铁律（origin 以 default: 开头）；列表类型列旁一眼可辨。 */
    function RulesDefaultBadge(props) {
      const { t } = props
      return h('span', { style: css.rulesDefaultBadge, title: t('rules.defaultOriginNote') }, t('rules.defaultBadge'))
    }

    /** 「已停用」小徽标：停用不动文件/编号，但立刻不注入；列表一眼区分生效与停用。 */
    function RulesRetiredBadge(props) {
      const { t } = props
      return h('span', { style: css.rulesRetiredBadge, title: t('rules.retiredBadge') }, t('rules.retiredBadge'))
    }

    /** 状态徽标：绿=生效，黄=候选/草稿，灰=退役/取代；红不用于规则状态。 */
    function RulesStatusBadge(props) {
      const { t, value } = props
      const tone = ruleStatusTone(value)
      const color = tone === 'ok'
        ? 'var(--dsw-alias-state-success-primary)'
        : tone === 'warn'
          ? 'var(--dsw-alias-state-warn-primary)'
          : 'var(--dsw-alias-label-tertiary)'
      return h('span', {
        style: { ...css.rulesStatusBadge, color, borderColor: color },
      }, ruleStatusLabel(t, value))
    }

    /** 空态引导：为什么需要规则 + 从记忆库导入 + 文件在哪可手改 + 手动提案入口。 */
    function RulesEmptyGuide(props) {
      const { t, dir, busy, onImport, onProposed } = props
      const [manual, setManual] = useState('')
      const [manualState, setManualState] = useState({ status: 'idle', code: '' })

      const submitManual = async () => {
        const text = manual.trim()
        if (!text) {
          setManualState({ status: 'error', code: 'invalid_text' })
          return
        }
        setManualState({ status: 'busy', code: '' })
        try {
          await callJson('/rules/propose', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text }),
          })
          setManual('')
          setManualState({ status: 'ok', code: '' })
          if (onProposed) onProposed()
        } catch (err) {
          setManualState({ status: 'error', code: (err && err.code) || 'unknown_error' })
        }
      }

      return h('div', { style: css.guide },
        h('div', { style: css.cardTitle }, t('rules.emptyTitle')),
        h('div', { style: css.note }, t('rules.emptyWhy')),
        h('ol', { style: css.rulesSteps },
          h('li', null, t('rules.emptyStepImport')),
          h('li', null, t('rules.emptyStepEdit')),
          h('li', null, t('rules.emptyStepRefresh'))),
        dir ? h('div', { style: css.tertiary }, t('rules.dirLabel') + ': ' + dir) : null,
        h('button', {
          style: busy ? css.buttonDisabled : css.buttonPrimary,
          disabled: busy, onClick: onImport,
        }, busy ? t('rules.importing') : t('rules.importLegacy')),
        h('div', { style: css.rulesManualBlock },
          h('div', { style: css.cardTitle }, t('rules.proposalManualTitle')),
          h('div', { style: css.note }, t('rules.proposalManualHint')),
          h('textarea', {
            style: css.textarea, rows: 3, value: manual, maxLength: 2000,
            placeholder: t('rules.proposalManualPlaceholder'),
            onChange: (e) => setManual(e.target.value),
          }),
          h('div', { style: css.actions },
            h('button', {
              style: manualState.status === 'busy' ? css.buttonDisabled : css.button,
              disabled: manualState.status === 'busy', onClick: submitManual,
            }, manualState.status === 'busy' ? t('common.saving') : t('rules.proposalManualSubmit')),
            manualState.status === 'ok' ? h('span', { style: css.ok }, t('rules.proposalManualDone')) : null,
            manualState.status === 'error'
              ? h('span', { style: css.error },
                t('rules.opFailed') + ' [' + manualState.code + '] — ' + errText(t, { code: manualState.code }))
              : null)))
    }

    /** 安装指引弹层：按平台给 brew/apt/winget + 下载链接 + 「无 git 仍可用快照」说明。 */
    function RulesGitGuide(props) {
      const { t, onClose } = props
      const rows = [
        ['rules.gitGuideBrew', 'brew install git'],
        ['rules.gitGuideApt', 'sudo apt install git'],
        ['rules.gitGuideWinget', 'winget install --id Git.Git -e'],
      ]
      return h('div', { style: css.rulesGuideMask, onClick: onClose },
        h('aside', { style: css.rulesGuidePanel, onClick: (e) => e.stopPropagation() },
          h('div', { style: css.inline },
            h('div', { style: { ...css.cardTitle, flex: 1 } }, t('rules.gitGuideTitle')),
            h('button', { style: css.button, onClick: onClose }, t('common.close'))),
          h('div', { style: css.note }, t('rules.gitGuideIntro')),
          h('div', { style: css.stack }, rows.map(([key, command]) => h('div', {
            key, style: css.rulesGuideRow,
          },
          h('div', { style: css.fieldLabel }, t(key)),
          h('code', { style: css.rulesCode }, command)))),
          h('div', { style: css.note },
            h('a', {
              style: css.linkButton, href: 'https://git-scm.com/downloads',
              target: '_blank', rel: 'noreferrer',
            }, t('rules.gitGuideDownload'))),
          h('div', { style: css.warnBox }, t('rules.gitGuideSnapshot'))))
    }

    /** 条件/例外列表：字符串/对象统一成一行；非数组给「暂无」。 */
    function ruleList(value, t) {
      const items = Array.isArray(value)
        ? value
        : (value === undefined || value === null || value === '' ? [] : [value])
      if (items.length === 0) return h('div', { style: css.tertiary }, t('rules.none'))
      return h('ul', { style: css.rulesList }, items.map((item, index) => h('li', {
        key: index, style: css.rulesListRow,
      }, ruleFieldText(item) || t('common.dash'))))
    }

    /**
     * 规则详情抽屉：front matter + 完整正文（等宽可选中）+ 条件/例外 + 历史/diff。
     * 回滚/编辑在 R3b 前 disabled + tooltip，避免按钮看起来能用却打不出去。
     */
    /** 编号展示：NaN/缺失一律「—」，铁律编号只在服务端有效时显示。 */
    function ruleNumberText(rule) {
      const n = Number(rule && rule.number)
      return Number.isFinite(n) ? '#' + String(n) : '—'
    }

    /**
     * 新建规则弹层：小白只填「要什么」，编号/key 由服务端分配（铁律自动从 18 起，普通规则也自动编号）。
     * 字段：类型（铁律/普通规则）、优先级 P0–P3、作用域（global/workspace/role + 值）、
     * 正文（≤500 码点）、条件/例外（每行一条）、动作/对象（可选，留空由服务端从正文抽取）。
     *
     * Why 提交前本地校验 + 二次确认：新建会写规则文件、创建 git commit、重建镜像并渲染 AGENTS，
     * 提交即进历史；先把正文/作用域错误挡在本地，再把「会动哪些东西」讲清，避免小白误建。
     */
    function RulesNewDialog(props) {
      const { t, locale, onClose, onCreated } = props
      const [type, setType] = useState('rule')
      const [priority, setPriority] = useState('P1')
      const [scopeKind, setScopeKind] = useState('global')
      const [scopeValue, setScopeValue] = useState('')
      const [text, setText] = useState('')
      const [conditions, setConditions] = useState('')
      const [exceptions, setExceptions] = useState('')
      const [action, setAction] = useState('')
      const [object, setObject] = useState('')
      const [busy, setBusy] = useState(false)
      const [problem, setProblem] = useState(null)

      const chars = ruleTextChars(text)
      const draft = { text, type, priority, scopeKind, scopeValue, conditions, exceptions, action, object }
      const problemCode = newRuleDraftProblem(draft)
      const typeOptions = [
        ['iron-rule', t('rules.typeIron')],
        ['rule', t('rules.typeNormal')],
      ]
      const scopeOptions = [
        ['global', t('rules.editScopeGlobal')],
        ['workspace', t('rules.editScopeWorkspace')],
        ['role', t('rules.editScopeRole')],
      ]

      /** 本地校验码 → 文案：正文/作用域复用编辑弹层口径，类型/优先级走新建专属文案。 */
      const localProblemText = (code) => {
        if (!code) return ''
        if (code === 'body_empty' || code === 'body_too_long') return t('rules.editInvalidText')
        if (code === 'type_invalid') return t('rules.newTypeInvalid')
        if (code === 'priority_invalid') return t('rules.newPriorityInvalid')
        if (String(code).startsWith('scope_')) return t('rules.editScopeInvalid')
        return ''
      }

      /**
       * 提交：本地校验不过就不发请求；确认文案必须同时说明「写文件 / git commit / 重建镜像 / 渲染 AGENTS」。
       * 载荷严格 `{draft:{...}}`；成功后交给父级关弹层并统一刷新（列表/详情/提案/git）。
       */
      const submit = async () => {
        if (busy) return
        if (problemCode) {
          setProblem({ code: problemCode, detail: null })
          return
        }
        if (!askConfirm(t('rules.newConfirm'))) return
        setBusy(true)
        setProblem(null)
        try {
          const body = await callJson('/rules/create', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ draft: newRuleDraftPayload(draft) }),
          })
          if (typeof onCreated === 'function') {
            onCreated({
              kind: 'create',
              // 服务端同时回顶层 key 与 rule.key；任一存在即可，避免契约微差时丢 key。
              key: body && (body.key || (body.rule && body.rule.key)) ? String(body.key || body.rule.key) : '',
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
            h('div', { style: { ...css.cardTitle, flex: 1 } }, t('rules.newTitle')),
            h('button', { style: css.button, onClick: onClose }, t('common.close'))),
          h('div', { style: css.note }, t('rules.newHint')),
          h('div', { style: css.rulesEditReadonly },
            h(Row, { k: t('rules.fieldNumber'), v: t('rules.newAutoAssign') }),
            h(Row, { k: t('rules.fieldKey'), v: t('rules.newAutoAssign') }),
            h('div', { style: { ...css.tertiary, gridColumn: '1 / -1' } }, t('rules.newAutoAssignNote'))),
          h('div', { style: css.rulesEditGrid },
            h('label', { style: css.field },
              h('span', { style: css.fieldLabel }, t('rules.newTypeLabel')),
              h(SelectInput, { value: type, options: typeOptions, onChange: setType })),
            h('label', { style: css.field },
              h('span', { style: css.fieldLabel }, t('rules.editPriorityLabel')),
              h(SelectInput, {
                value: priority,
                options: rulePriorityOptions(priority).map((value) => [value, value]),
                onChange: setPriority,
              })),
            h('label', { style: css.field },
              h('span', { style: css.fieldLabel }, t('rules.editScopeLabel')),
              h(SelectInput, { value: scopeKind, options: scopeOptions, onChange: setScopeKind })),
            scopeKind === 'global' ? null : h('label', { style: css.field },
              h('span', { style: css.fieldLabel }, t('rules.editScopeValueLabel')),
              h(TextInput, {
                value: scopeValue,
                placeholder: scopeKind === 'workspace'
                  ? t('rules.editScopeWorkspacePlaceholder')
                  : t('rules.editScopeRolePlaceholder'),
                onChange: setScopeValue,
              }))),
          h('label', { style: css.field },
            h('span', { style: css.fieldLabel }, t('rules.editTextLabel')),
            h('textarea', {
              style: css.rulesProposalEditorArea, rows: 8, maxLength: RULE_BODY_MAX,
              value: text, placeholder: t('rules.newTextPlaceholder'),
              onChange: (e) => setText(e.target.value),
            }),
            h('div', { style: chars > RULE_BODY_MAX ? css.warn : css.tertiary },
              t('common.charCount', { n: fmtNum(chars, locale), max: fmtNum(RULE_BODY_MAX, locale) }))),
          h('div', { style: css.rulesEditGrid },
            h('label', { style: css.field },
              h('span', { style: css.fieldLabel }, t('rules.newActionLabel')),
              h(TextInput, {
                value: action, placeholder: t('rules.newActionPlaceholder'),
                onChange: setAction,
              })),
            h('label', { style: css.field },
              h('span', { style: css.fieldLabel }, t('rules.newObjectLabel')),
              h(TextInput, {
                value: object, placeholder: t('rules.newObjectPlaceholder'),
                onChange: setObject,
              }))),
          h('label', { style: css.field },
            h('span', { style: css.fieldLabel }, t('rules.editConditionsLabel')),
            h('textarea', {
              style: css.textarea, rows: 3, value: conditions,
              onChange: (e) => setConditions(e.target.value),
            })),
          h('label', { style: css.field },
            h('span', { style: css.fieldLabel }, t('rules.editExceptionsLabel')),
            h('textarea', {
              style: css.textarea, rows: 3, value: exceptions,
              onChange: (e) => setExceptions(e.target.value),
            })),
          problemCode ? h('div', { style: css.warn }, localProblemText(problemCode)) : null,
          problemNode,
          h('div', { style: css.actions },
            h('button', {
              style: busy || problemCode ? css.buttonDisabled : css.buttonPrimary,
              disabled: Boolean(busy || problemCode),
              onClick: submit,
            }, busy ? t('common.saving') : t('rules.newSubmit')),
            h('button', { style: css.button, onClick: onClose }, t('common.cancel')))))
    }

    /** diff 行渲染：服务端 rows 与本地 lineDiff 同构（kind/text）；无差异给「一致」文案。 */
    function RulesDiffRows(props) {
      const { t, rows } = props
      const list = Array.isArray(rows) ? rows : []
      const changed = list.some((row) => row && row.kind !== 'same')
      if (!changed) return h('div', { style: css.tertiary }, t('rules.diffEmpty'))
      // diff 正文是抽屉/弹层内的受控二次滚动块：标记出来，页根仍是唯一页级滚动根。
      return h('div', { style: css.rulesDiffBody, 'data-wm-scroll': 'drawer' }, list.map((row, index) => h('div', {
        key: index,
        style: row.kind === 'add'
          ? css.rulesDiffAdd
          : row.kind === 'del' ? css.rulesDiffDel : css.rulesDiffSame,
      }, (row.kind === 'add' ? '+ ' : row.kind === 'del' ? '- ' : '  ') + row.text)))
    }

    /**
     * 编辑弹层（R5）：正文（≤500 码点计数）/条件/例外（每行一条）/作用域（三选+值）/
     * 优先级（P0–P3）/状态（active|retired）；key、类型、编号只读展示并注明不可改。
     *
     * Why 先预览再提交：规则改动会进 git 历史与 AGENTS 摘要，用户必须在二次确认前
     * 看到「到底改了哪几行」——预览优先用服务端 /rules/diff（rev=当前版本）拿当前正文
     * 当基线；没有当前版本或服务端未上线时退回本地 lineDiff(旧,新)。
     */
