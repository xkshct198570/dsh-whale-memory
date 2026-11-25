    const RULE_BODY_MAX = 500
    /** 优先级下拉候选：契约 P0–P3；已有值不在表内时追加（不替用户改写未知优先级）。 */
    const RULE_PRIORITY_OPTIONS = ['P0', 'P1', 'P2', 'P3']
    /** 编辑补丁字段 → 文案键；服务端 patch 字段与这六个一一对应，未知字段原样显示。 */
    const RULE_EDIT_FIELD_KEYS = {
      text: 'rules.editPreviewFieldText',
      conditions: 'rules.editPreviewFieldConditions',
      exceptions: 'rules.editPreviewFieldExceptions',
      scope: 'rules.editPreviewFieldScope',
      priority: 'rules.editPreviewFieldPriority',
      status: 'rules.editPreviewFieldStatus',
    }

    /**
     * 正文计数：按 Unicode 码点（与服务端 charsOf 同口径），避免 emoji/中文被算成两个字符。
     * @param {unknown} value @returns {number}
     */
    function ruleTextChars(value) {
      return Array.from(String(value === null || value === undefined ? '' : value)).length
    }

    /**
     * 多行输入解析：每行一条条件/例外；空行丢弃、首尾空白裁掉
     * （服务端只接受「非空字符串数组」，空项会被 validateRule 判 invalid_conditions）。
     * @param {unknown} value 数组或多行文本
     * @returns {string[]}
     */
    function ruleLinesFromInput(value) {
      const chunks = Array.isArray(value)
        ? value.map((item) => ruleFieldText(item))
        : [String(value === null || value === undefined ? '' : value)]
      const lines = []
      for (const chunk of chunks) {
        for (const line of String(chunk).split(/\r?\n/)) {
          const text = line.trim()
          if (text) lines.push(text)
        }
      }
      return lines
    }

    /**
     * 作用域拆分：服务端只认 `global | workspace:<绝对路径> | role:<id>`；
     * 未知写法落到 custom 并保留原值——编辑不能把不认识的 scope 静默改成 global。
     * @param {unknown} scope @returns {{kind:'global'|'workspace'|'role'|'custom',value:string}}
     */
    function ruleScopeParts(scope) {
      const raw = String(scope === null || scope === undefined ? '' : scope).trim()
      if (!raw || raw === 'global') return { kind: 'global', value: '' }
      if (raw.startsWith('workspace:')) return { kind: 'workspace', value: raw.slice('workspace:'.length).trim() }
      if (raw.startsWith('role:')) return { kind: 'role', value: raw.slice('role:'.length).trim() }
      return { kind: 'custom', value: raw }
    }

    /** 作用域合成：与 ruleScopeParts 互逆；custom 原样回写，global 忽略值。 */
    function ruleScopeValue(kind, value) {
      const text = String(value === null || value === undefined ? '' : value).trim()
      if (kind === 'workspace') return 'workspace:' + text
      if (kind === 'role') return 'role:' + text
      if (kind === 'custom') return text
      return 'global'
    }

    /**
     * 作用域本地校验（与服务端 scopeError 同口径）：提交前先挡住，别让用户等一次 400。
     * @param {string} kind @param {string} value
     * @returns {string|null} 错误码；null=合法
     */
    function ruleScopeProblem(kind, value) {
      const text = String(value === null || value === undefined ? '' : value).trim()
      if (kind === 'workspace') {
        if (!text) return 'scope_workspace_empty'
        if (!(text.startsWith('/') || /^[A-Za-z]:[\\/]/.test(text))) return 'scope_workspace_relative'
        return null
      }
      if (kind === 'role') {
        if (!text || /\s/.test(text) || text.length > 64) return 'scope_role_invalid'
        return null
      }
      if (kind === 'custom') return text ? null : 'scope_invalid'
      return null
    }

    /** 优先级选项：P0–P3；已有值不在表内时追加，保证下拉不改写未知优先级。 */
    function rulePriorityOptions(current) {
      const text = String(current === null || current === undefined ? '' : current).trim().toUpperCase()
      return RULE_PRIORITY_OPTIONS.includes(text) || !text
        ? RULE_PRIORITY_OPTIONS.slice()
        : RULE_PRIORITY_OPTIONS.concat([text])
    }

    /** 默认铁律判定：安装自带规则的 front.origin 以 `default:` 开头（可改/停/删，编号保留）。 */
    function ruleOriginIsDefault(origin) {
      const text = typeof origin === 'string' ? origin.trim() : ruleFieldText(origin).trim()
      return text.startsWith('default:')
    }

    /** 规则对象是否安装自带默认铁律；缺 origin 一律按普通规则，避免旧载荷被误标「默认」。 */
    function ruleIsDefault(rule) {
      const r = rule && typeof rule === 'object' ? rule : {}
      return ruleOriginIsDefault(r.origin)
    }

    /** 状态切换方向：retired→reactivate，其余按 retire（面板只对 active/retired 放行）。 */
    function ruleRetireMode(status) {
      return String(status === null || status === undefined ? '' : status).trim().toLowerCase() === 'retired'
        ? 'reactivate'
        : 'retire'
    }

    /** 只有 active/retired 可切换；merged/superseded 由合并链路管理，面板不得改写。 */
    function ruleCanToggleStatus(status) {
      const text = String(status === null || status === undefined ? '' : status).trim().toLowerCase()
      return text === 'active' || text === 'retired'
    }

    /** 新建类型白名单：服务端 RULE_TYPES 的可建子集；铁律自动编号、普通规则也自动编号。 */
    const RULE_NEW_TYPES = ['iron-rule', 'rule']

    /**
     * 新建草稿本地校验：正文非空/≤500、类型/优先级合法、作用域合法。
     * Why 先挡一次：这些错服务端会以 invalid_draft/invalid_rule 返回 400，小白看不出该改哪。
     * @param {object} draft @returns {string|null} body_empty|body_too_long|type_invalid|priority_invalid|scope_*
     */
    function newRuleDraftProblem(draft) {
      const d = draft && typeof draft === 'object' ? draft : {}
      // 与提交载荷同口径：先 trim 再计数，避免「只输空格」被判成合法正文。
      const text = String(d.text === null || d.text === undefined ? '' : d.text).trim()
      const chars = ruleTextChars(text)
      if (chars === 0) return 'body_empty'
      if (chars > RULE_BODY_MAX) return 'body_too_long'
      const type = String(d.type === null || d.type === undefined ? 'rule' : d.type).trim()
      if (!RULE_NEW_TYPES.includes(type)) return 'type_invalid'
      const priority = String(d.priority === null || d.priority === undefined ? 'P1' : d.priority).trim().toUpperCase()
      if (!RULE_PRIORITY_OPTIONS.includes(priority)) return 'priority_invalid'
      const scopeProblem = ruleScopeProblem(d.scopeKind || 'global', d.scopeValue)
      if (scopeProblem) return scopeProblem
      return null
    }

    /**
     * 新建草稿归一：与 POST /rules/create 的 {draft:{...}} 契约逐字段对齐。
     * Why 只带契约字段：多带未知字段会被 validateRule 判 unknown_field；空字符串表示「留空自动抽」。
     * @param {object} draft
     * @returns {{text:string,type:string,priority:string,scope:string,role:string,
     *   conditions:string[],exceptions:string[],action:string,object:string}}
     */
    function newRuleDraftPayload(draft) {
      const d = draft && typeof draft === 'object' ? draft : {}
      const scopeKind = d.scopeKind === 'workspace' || d.scopeKind === 'role' ? d.scopeKind : 'global'
      const scopeValue = String(d.scopeValue === null || d.scopeValue === undefined ? '' : d.scopeValue).trim()
      const type = String(d.type === null || d.type === undefined ? 'rule' : d.type).trim()
      const priority = String(d.priority === null || d.priority === undefined ? 'P1' : d.priority).trim().toUpperCase()
      return {
        text: String(d.text === null || d.text === undefined ? '' : d.text).trim(),
        type: RULE_NEW_TYPES.includes(type) ? type : 'rule',
        priority: RULE_PRIORITY_OPTIONS.includes(priority) ? priority : 'P1',
        scope: ruleScopeValue(scopeKind, scopeValue),
        role: scopeKind === 'role' ? scopeValue : '',
        conditions: ruleLinesFromInput(d.conditions),
        exceptions: ruleLinesFromInput(d.exceptions),
        action: String(d.action === null || d.action === undefined ? '' : d.action).trim(),
        object: String(d.object === null || d.object === undefined ? '' : d.object).trim(),
      }
    }

    /** 全部停用判定：列表非空且每条 status 都是 retired；空态据此换「去已退役筛选找回」文案。
     * Why 只看 status 而不复用 bucket：merged/superseded 不能重新启用，混进提示会误导用户。 */
    function rulesAllRetired(rules) {
      const list = Array.isArray(rules) ? rules.filter((rule) => rule && typeof rule === 'object') : []
      return list.length > 0 && list.every((rule) => String(rule.status === null || rule.status === undefined
        ? '' : rule.status).trim().toLowerCase() === 'retired')
    }

    /**
     * 编辑补丁：只带真正变化的字段 —— 服务端按「有改动才 commit」，空字段覆盖会把
     * 结构化字段清掉；字符串与行数组各自归一后比较，避免 `\r\n`/空行算成改动。
     * @param {object} rule 当前规则（详情载荷 rule）
     * @param {{text?:string,conditions?:string[]|string,exceptions?:string[]|string,scope?:string,priority?:string,status?:string}} draft
     * @returns {{patch:object,fields:string[]}} fields=发生变化的服务端字段名
     */
    function ruleEditPatch(rule, draft) {
      const base = rule && typeof rule === 'object' ? rule : {}
      const d = draft && typeof draft === 'object' ? draft : {}
      const patch = {}
      const fields = []
      const put = (field, value) => { patch[field] = value; fields.push(field) }
      const nextText = String(d.text === null || d.text === undefined ? '' : d.text).trim()
      if (nextText !== String(base.text === null || base.text === undefined ? '' : base.text).trim()) {
        put('text', nextText)
      }
      const nextConditions = ruleLinesFromInput(d.conditions)
      if (nextConditions.join('\n') !== ruleLinesFromInput(base.conditions).join('\n')) {
        put('conditions', nextConditions)
      }
      const nextExceptions = ruleLinesFromInput(d.exceptions)
      if (nextExceptions.join('\n') !== ruleLinesFromInput(base.exceptions).join('\n')) {
        put('exceptions', nextExceptions)
      }
      const baseScope = String(base.scope === null || base.scope === undefined ? '' : base.scope).trim() || 'global'
      const nextScope = String(d.scope === null || d.scope === undefined ? '' : d.scope).trim() || 'global'
      if (nextScope !== baseScope) put('scope', nextScope)
      const basePriority = String(base.priority === null || base.priority === undefined ? '' : base.priority).trim().toUpperCase()
      const nextPriority = String(d.priority === null || d.priority === undefined ? '' : d.priority).trim().toUpperCase()
      if (nextPriority && nextPriority !== basePriority) put('priority', nextPriority)
      const baseStatus = String(base.status === null || base.status === undefined ? '' : base.status).trim()
      const nextStatus = String(d.status === null || d.status === undefined ? '' : d.status).trim()
      if (nextStatus && nextStatus !== baseStatus) put('status', nextStatus)
      return { patch, fields }
    }

    /**
     * 当前版本 rev：先按详情 `version` 与历史项 `version` 对齐（契约可选新增字段），
     * 没有版本号时退到「历史正文与当前正文完全一致」；都对不上返回 null——宁可标不出
     * 「当前」，也不能把任意一条历史谎标成当前版本。
     * @param {object} rule @param {Array<object>} history
     * @returns {string|null}
     */
    function ruleCurrentRev(rule, history) {
      const list = (Array.isArray(history) ? history : []).filter((item) => item && typeof item === 'object')
      if (list.length === 0) return null
      const version = rule && rule.version
      if (version !== undefined && version !== null && version !== '') {
        const hit = list.find((item) => item.version !== undefined && item.version !== null
          && String(item.version) === String(version))
        if (hit && hit.rev !== undefined && hit.rev !== null) return String(hit.rev)
      }
      const text = String((rule && rule.text) || '')
      const same = list.find((item) => String(item.text === null || item.text === undefined ? '' : item.text) === text)
      return same && same.rev !== undefined && same.rev !== null ? String(same.rev) : null
    }

    /**
     * 服务端 diff 归一：`diff:[{type:'same'|'add'|'del',text}]` → 本地同构 `{kind,text}`；
     * 形状不对返回 null，让调用方退回 lineDiff（服务端 R5 未上线时面板仍可用）。
     * @param {object} body @returns {Array<{kind:string,text:string}>|null}
     */
    function ruleDiffRowsFromServer(body) {
      const rows = body && body.diff
      if (!Array.isArray(rows)) return null
      return rows.map((row) => {
        const source = row && typeof row === 'object' ? row : {}
        const type = String(source.type || source.kind || '').toLowerCase()
        const kind = type === 'add' || type === '+'
          ? 'add'
          : type === 'del' || type === 'delete' || type === '-' ? 'del' : 'same'
        return { kind, text: String(source.text === null || source.text === undefined ? '' : source.text) }
      })
    }

    /**
     * 后端 detail 文案：invalid_rule 的 detail 可能是字符串、`{errors:[{code,field,message}]}`
     * 或单条错误对象；统一压成一行，把字段名/原因直接给用户看，不吞服务端信息。
     * @param {unknown} detail @returns {string}
     */
    function ruleErrorDetailText(detail) {
      if (detail === null || detail === undefined) return ''
      if (typeof detail === 'string') return detail.trim().slice(0, 400)
      if (typeof detail === 'number' || typeof detail === 'boolean') return String(detail)
      if (Array.isArray(detail)) {
        return detail.map((item) => ruleErrorDetailText(item)).filter(Boolean).join(' · ').slice(0, 400)
      }
      if (typeof detail === 'object') {
        if (Array.isArray(detail.errors)) {
          return detail.errors.map((item) => ruleErrorDetailText(item)).filter(Boolean).join(' · ').slice(0, 400)
        }
        if (Array.isArray(detail.fields)) {
          return detail.fields.map((field) => String(field)).filter(Boolean).join(', ').slice(0, 400)
        }
        const field = detail.field === undefined || detail.field === null ? '' : String(detail.field)
        const message = [detail.message, detail.reason, detail.detail, detail.error, detail.code]
          .find((value) => typeof value === 'string' && value.trim())
        const parts = [field, message ? String(message).trim() : ''].filter(Boolean)
        if (parts.length > 0) return parts.join(': ').slice(0, 400)
        return Object.keys(detail).join(', ').slice(0, 200)
      }
      return String(detail).slice(0, 400)
    }

    /** 编辑预览的字段名：未知字段原样显示（不隐藏服务端新增的 patch 字段）。 */
    function ruleEditFieldLabel(t, field) {
      const key = RULE_EDIT_FIELD_KEYS[String(field || '')]
      return key ? t(key) : String(field || '')
    }
    /** 规则是否已停用（列表徽标/详情按钮共用；只认 retired，merged/superseded 不动）。 */
    function ruleIsRetired(rule) {
      const r = rule && typeof rule === 'object' ? rule : {}
      return String(r.status === null || r.status === undefined ? '' : r.status).trim().toLowerCase() === 'retired'
    }

    /**
     * 详情历史合并：`/rules/versions`（快照 + 触及该文件的 git 提交）为骨架，
     * 再用详情 `history` 补正文（本地 diff 兜底要用 text）。
     * Why 以 versions 为准：git 提交只有 versions 有，历史条目只有 detail 有正文；
     * 两者按 rev 去重，任一接口缺失都退回另一条时间线，面板不空。
     * @param {Array<object>} history @param {Array<object>} versions
     * @returns {Array<{rev:string,version:any,ts:any,source:string,text:string,commit:string,subject:string,kind:string}>}
     */
    function mergeRuleVersions(history, versions) {
      const detail = (Array.isArray(history) ? history : []).filter((item) => item && typeof item === 'object')
      const list = (Array.isArray(versions) ? versions : []).filter((item) => item && typeof item === 'object')
      const out = []
      const seen = new Set()
      const push = (entry) => {
        const rev = entry && entry.rev !== undefined && entry.rev !== null ? String(entry.rev) : ''
        if (!rev || seen.has(rev)) return
        seen.add(rev)
        out.push(entry)
      }
      for (const item of list) {
        // current 是「当前版本」占位（rev 空），由详情正文承担，不进历史列表。
        if (String(item.kind || '') === 'current') continue
        const rev = item.rev === undefined || item.rev === null ? '' : String(item.rev)
        if (!rev) continue
        const hit = detail.find((row) => String(row.rev) === rev)
        push({
          rev,
          version: item.version === undefined || item.version === null ? (hit ? hit.version : null) : item.version,
          ts: item.ts === undefined || item.ts === null || item.ts === '' ? (hit ? hit.ts : item.ts) : item.ts,
          source: String(item.source || (hit && hit.source) || 'snapshot'),
          text: String((hit && hit.text) || ''),
          commit: String(item.commit || ''),
          subject: String(item.subject || ''),
          kind: String(item.kind || 'history'),
        })
      }
      for (const item of detail) push({ ...item, rev: String(item.rev), source: String(item.source || 'snapshot') })
      return out
    }
    // <<< rules:pure

    /** 状态键：服务端状态值本地化；未知值原样显示，不吞字段。 */
    const RULE_STATUS_KEYS = {
      active: 'rules.statusActive',
      candidate: 'rules.statusCandidate',
      retired: 'rules.statusRetired',
      merged: 'rules.statusMerged',
      superseded: 'rules.statusSuperseded',
      draft: 'rules.statusDraft',
      proposed: 'rules.statusProposed',
      proposal: 'rules.statusProposed',
    }

    /** 状态语义分桶：只有生效=绿、候选=黄，退役/未知=灰（红留给 git 损坏）。 */
    function ruleStatusTone(value) {
      const key = String(value || '').trim().toLowerCase()
      if (key === 'active' || key === 'enabled' || key === 'in_effect') return 'ok'
      if (RULE_CANDIDATE_STATUS.includes(key) || key === 'draft') return 'warn'
      return 'muted'
    }

    function ruleStatusLabel(t, value) {
      const key = RULE_STATUS_KEYS[String(value || '').trim().toLowerCase()]
      return key ? t(key) : (value || '—')
    }

    function ruleTypeLabel(t, value) {
      const key = String(value || '').trim().toLowerCase()
      if (key === 'rule-candidate' || key.includes('candidate')) return t('rules.typeCandidate')
      if (key.includes('iron') || key.includes('铁律') || key === 'hard') return t('rules.typeIron')
      if (key === 'normal' || key === 'rule' || key === 'general' || key === '') return t('rules.typeNormal')
      return value || '—'
    }

    /** 复制目录路径：只走 Clipboard API（DSH 页面是安全上下文）；失败给明确文案。 */
    function copyToClipboard(value) {
      const text = String(value || '')
      if (!text) return Promise.reject(new Error('empty'))
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard
          && typeof navigator.clipboard.writeText === 'function') {
          return navigator.clipboard.writeText(text)
        }
      } catch {
        return Promise.reject(new Error('clipboard_unavailable'))
      }
      return Promise.reject(new Error('clipboard_unavailable'))
    }

    /**
     * 规则页：顶部 git 状态条 + 待确认区 + 工具行 + 列表；详情走抽屉。
     * 边界：写操作只发 POST 并在前端二次确认；回滚/编辑在 R3b 前只读（disabled + 说明）。
     */
