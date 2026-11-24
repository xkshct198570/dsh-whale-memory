    const RULE_CANDIDATE_STATUS = ['candidate', 'proposed', 'proposal', 'pending', 'pending_review']
    const RULE_RETIRED_STATUS = ['retired', 'merged', 'superseded', 'archived', 'deprecated', 'retracted', 'dead']

    /** git 三态归一：可用=绿；未安装=黄；可用但 error=损坏（红）；字段缺失=未知。 */
    function rulesGitState(git) {
      const g = git && typeof git === 'object' ? git : null
      if (!g) {
        return { tone: 'unknown', installed: null, broken: false, version: null, required: false, checkedAt: null, error: null }
      }
      const available = g.available === true
      const error = typeof g.error === 'string' && g.error.trim() ? g.error.trim() : null
      const rawVersion = g.version
      const version = rawVersion === null || rawVersion === undefined || rawVersion === '' ? null : String(rawVersion)
      return {
        tone: available ? (error ? 'error' : 'ok') : 'warn',
        installed: available,
        broken: Boolean(available && error),
        version,
        required: g.required === true,
        checkedAt: g.checkedAt === undefined ? null : g.checkedAt,
        error,
      }
    }

    /** 规则语义桶：退役/候选按 status 优先，铁律按 type（或 iron 布尔）识别。 */
    function ruleBucketOf(rule) {
      const r = rule && typeof rule === 'object' ? rule : {}
      const status = String(r.status || '').trim().toLowerCase()
      if (RULE_RETIRED_STATUS.includes(status)) return 'retired'
      if (RULE_CANDIDATE_STATUS.includes(status)) return 'candidate'
      const type = String(r.type || '').trim().toLowerCase()
      if (r.iron === true || type.includes('iron') || type.includes('铁律') || type === 'hard') return 'iron'
      return 'normal'
    }

    /** 本地过滤：先按语义桶，再按 key/编号/标题/摘要/正文子串（大小写不敏感）。 */
    function filterRuleList(rules, filter, query) {
      const list = Array.isArray(rules) ? rules.filter((rule) => rule && typeof rule === 'object') : []
      const bucket = ['iron', 'normal', 'candidate', 'retired'].includes(filter) ? filter : 'all'
      const q = String(query || '').trim().toLowerCase()
      return list.filter((rule) => {
        if (bucket !== 'all' && ruleBucketOf(rule) !== bucket) return false
        if (!q) return true
        const hay = [rule.key, rule.number, rule.title, rule.excerpt, rule.text]
          .filter((value) => value !== null && value !== undefined)
          .map((value) => String(value)).join(' ').toLowerCase()
        return hay.includes(q)
      })
    }

    /** 长路径省略（作用域列）：保留头尾，完整值放 title 属性。 */
    function shortPath(value, max) {
      const s = String(value === null || value === undefined ? '' : value)
      const limit = Number.isFinite(Number(max)) && Number(max) > 8 ? Number(max) : 32
      if (!s || s.length <= limit) return s
      const head = Math.ceil((limit - 3) / 2)
      const tail = Math.floor((limit - 3) / 2)
      return s.slice(0, head) + '…' + s.slice(s.length - tail)
    }

    /** 列表摘要：优先 excerpt，其次标题/正文；压平空白并截断。 */
    function ruleSummary(rule, max) {
      const r = rule && typeof rule === 'object' ? rule : {}
      const picked = [r.excerpt, r.title, r.text].find((value) => typeof value === 'string' && value.trim())
      const text = String(picked || '').replace(/\s+/g, ' ').trim()
      const limit = Number.isFinite(Number(max)) ? Math.max(8, Number(max)) : 60
      return text.length > limit ? text.slice(0, limit) + '…' : text
    }

    /** 条件/例外条目统一成文本：字符串直出；对象取常见正文字段，兜底 JSON。 */
    function ruleFieldText(value) {
      if (value === null || value === undefined) return ''
      if (typeof value === 'string') return value
      if (typeof value === 'number' || typeof value === 'boolean') return String(value)
      if (Array.isArray(value)) return value.map(ruleFieldText).filter(Boolean).join(' / ')
      if (typeof value === 'object') {
        for (const key of ['text', 'condition', 'description', 'desc', 'pattern', 'statement', 'name', 'rule']) {
          const picked = value[key]
          if (typeof picked === 'string' && picked.trim()) return picked
        }
        try {
          return JSON.stringify(value)
        } catch {
          return ''
        }
      }
      return String(value)
    }

    /** 逐行 LCS diff：旧版本=del（-），新文本=add（+），两边都有=same；上限 400 行防卡顿。 */
    function lineDiff(oldText, newText) {
      const a = String(oldText === null || oldText === undefined ? '' : oldText).split(/\r?\n/)
      const b = String(newText === null || newText === undefined ? '' : newText).split(/\r?\n/)
      const rows = []
      const m = a.length
      const n = b.length
      if (m > 400 || n > 400) {
        for (const line of a) rows.push({ kind: 'del', text: line })
        for (const line of b) rows.push({ kind: 'add', text: line })
        return rows
      }
      const table = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1))
      for (let i = m - 1; i >= 0; i -= 1) {
        for (let j = n - 1; j >= 0; j -= 1) {
          table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
        }
      }
      let i = 0
      let j = 0
      while (i < m && j < n) {
        if (a[i] === b[j]) {
          rows.push({ kind: 'same', text: a[i] })
          i += 1
          j += 1
        } else if (table[i + 1][j] >= table[i][j + 1]) {
          rows.push({ kind: 'del', text: a[i] })
          i += 1
        } else {
          rows.push({ kind: 'add', text: b[j] })
          j += 1
        }
      }
      while (i < m) {
        rows.push({ kind: 'del', text: a[i] })
        i += 1
      }
      while (j < n) {
        rows.push({ kind: 'add', text: b[j] })
        j += 1
      }
      return rows
    }
    // ---- 提案（/rules/proposals）纯函数：列表渲染/风险判断/正文合成的唯一口径 ----

    /** 关系/状态枚举：服务端契约的白名单，缺字段一律归到中性值而非 undefined。 */
    const PROPOSAL_RELATIONS = ['new', 'duplicate', 'refine', 'merge', 'conflict', 'unrelated']
    const PROPOSAL_STATUSES = ['pending', 'needs_manual', 'accepted', 'rejected', 'expired']
    const PROPOSAL_RELATION_KEYS = {
      new: 'rules.relNew',
      duplicate: 'rules.relDuplicate',
      refine: 'rules.relRefine',
      merge: 'rules.relMerge',
      conflict: 'rules.relConflict',
      unrelated: 'rules.relUnrelated',
    }
    const PROPOSAL_STATUS_KEYS = {
      pending: 'rules.proposalStatusPending',
      needs_manual: 'rules.proposalStatusNeedsManual',
      accepted: 'rules.proposalStatusAccepted',
      rejected: 'rules.proposalStatusRejected',
      expired: 'rules.proposalStatusExpired',
    }

    /** 关系归一：未知/缺失=unrelated（中性徽标），保证徽标不出现空字。 */
    function proposalRelationOf(item) {
      const raw = String((item && item.relation) || '').trim().toLowerCase()
      return PROPOSAL_RELATIONS.includes(raw) ? raw : 'unrelated'
    }

    /** 状态归一：proposed/proposal/candidate 等历史写法都收敛到 pending。 */
    function proposalStatusOf(item) {
      const raw = String((item && item.status) || '').trim().toLowerCase()
      if (PROPOSAL_STATUSES.includes(raw)) return raw
      return 'pending'
    }

    /** 关系色调：冲突=红、合并=黄、新增/细化=品牌色，重复/无关=灰。 */
    function proposalRelationTone(value) {
      const relation = proposalRelationOf({ relation: value })
      if (relation === 'conflict') return 'error'
      if (relation === 'merge' || relation === 'duplicate') return 'warn'
      if (relation === 'new' || relation === 'refine') return 'brand'
      return 'muted'
    }

    /** 提案状态色调：只有 accepted=绿，其它都走灰/黄，红只留给风险条。 */
    function proposalStatusTone(value) {
      const status = proposalStatusOf({ status: value })
      if (status === 'accepted') return 'ok'
      if (status === 'expired' || status === 'rejected') return 'muted'
      return 'warn'
    }

    /** 受影响旧规则归一：新旧正文缺失给空串，字符串形态的保留/丢弃包成数组。 */
    function proposalAffectedOf(item) {
      const list = item && Array.isArray(item.affected) ? item.affected : []
      return list.filter((row) => row && typeof row === 'object').map((row) => {
        const oldText = typeof row.oldText === 'string' ? row.oldText : ''
        const newText = typeof row.newText === 'string' ? row.newText : ''
        return {
          key: row.key === null || row.key === undefined ? null : String(row.key),
          number: Number.isFinite(Number(row.number)) ? Number(row.number) : null,
          oldText,
          newText,
          preserved: Array.isArray(row.preserved) ? row.preserved : (row.preserved == null ? [] : [row.preserved]),
          dropped: Array.isArray(row.dropped) ? row.dropped : (row.dropped == null ? [] : [row.dropped]),
          changed: row.changed === true || oldText !== newText,
        }
      })
    }

    /** 候选归一：正文缺失时退到受影响规则的新正文，再退到来源片段。 */
    function proposalCandidateOf(item) {
      const c = (item && item.candidate) || {}
      const affected = proposalAffectedOf(item)
      const source = (item && item.source) || {}
      const text = [c.text, affected[0] && affected[0].newText, source.text]
        .find((value) => typeof value === 'string' && value.trim()) || ''
      return {
        text: String(text),
        key: c.key === null || c.key === undefined ? null : String(c.key),
        type: c.type === null || c.type === undefined ? null : String(c.type),
        number: Number.isFinite(Number(c.number)) ? Number(c.number) : null,
        // 服务端优先级是 'P0'..'P3' 字符串；不转 Number（Number('P0')=NaN 会显示成 —）。
        priority: c.priority === null || c.priority === undefined ? null : String(c.priority),
        scope: c.scope === null || c.scope === undefined ? null : String(c.scope),
        role: c.role === null || c.role === undefined ? null : String(c.role),
        modality: c.modality === null || c.modality === undefined ? null : String(c.modality),
        conditions: Array.isArray(c.conditions) ? c.conditions : [],
        exceptions: Array.isArray(c.exceptions) ? c.exceptions : [],
        chars: Number.isFinite(Number(c.chars)) ? Number(c.chars) : String(text).length,
      }
    }

    /** 守卫归一：guard 缺失视为通过（旧载荷没有守卫），失败项保留 code/key/detail。 */
    function proposalGuardOf(item) {
      const raw = item && item.guard
      const failures = raw && Array.isArray(raw.failures)
        ? raw.failures.filter((failure) => failure && typeof failure === 'object').map((failure) => ({
          code: failure.code === null || failure.code === undefined ? '' : String(failure.code),
          key: failure.key === null || failure.key === undefined ? '' : String(failure.key),
          detail: ruleFieldText(failure.detail),
        }))
        : []
      return { ok: !(raw && raw.ok === false) && failures.length === 0, failures }
    }

    /**
     * needs_manual 候选归一：只有 status=needs_manual 才有值；code/failures 一律给可渲染的字符串。
     * Why 单独抽：面板必须把「为什么失败、失败码是什么」直接摆在候选卡上，并提示改写后重试。
     */
    function proposalNeedsManualOf(item) {
      if (proposalStatusOf(item) !== 'needs_manual') return null
      const raw = item && item.needsManual && typeof item.needsManual === 'object' ? item.needsManual : {}
      return {
        code: String(raw.code || 'needs_manual'),
        failures: proposalGuardOf(item).failures,
        detail: ruleFieldText(raw.detail).trim(),
      }
    }

    /** 被丢弃子句归一：扁平成 [{key, number, text}]，供风险条逐条列出。 */
    function proposalDroppedOf(item) {
      const rows = []
      for (const row of proposalAffectedOf(item)) {
        for (const clause of row.dropped) {
          const text = ruleFieldText(clause).trim()
          if (text) rows.push({ key: row.key, number: row.number, text })
        }
      }
      return rows
    }

    /**
     * 风险判定：守卫未过或有子句被丢弃即高风险，提交前必须勾选 acknowledgeDropped；
     * 冲突/合并只是把风险放大（提示语更重），不改变判定口径。
     */
    function proposalRiskOf(item) {
      const guard = proposalGuardOf(item)
      const dropped = proposalDroppedOf(item)
      const relation = proposalRelationOf(item)
      const risky = !guard.ok || dropped.length > 0
      return {
        relation,
        risky,
        // 只有「有子句被丢弃」才需要勾选确认；守卫失败要改正文，勾选放行是假通道（R9-14）。
        requiresAck: dropped.length > 0,
        guardFailed: !guard.ok,
        guardFailures: guard.failures,
        dropped,
        reasons: [!guard.ok ? 'guard' : null, dropped.length > 0 ? 'dropped' : null].filter(Boolean),
      }
    }

    /** 正文预览：压平空白、≤200 字截断并给 truncated 标记（展开/收起用同一口径）。 */
    function proposalPreview(value, max) {
      const text = String(value === null || value === undefined ? '' : value).replace(/\s+/g, ' ').trim()
      const limit = Number.isFinite(Number(max)) ? Math.max(20, Number(max)) : 200
      return {
        text,
        length: text.length,
        truncated: text.length > limit,
        preview: text.length > limit ? text.slice(0, limit) + '…' : text,
      }
    }

    /** 条件/例外统一成干净行；对象条目取正文，丢弃空行。 */
    function clauseLines(value) {
      const list = Array.isArray(value) ? value : (value === null || value === undefined || value === '' ? [] : [value])
      return list.map((entry) => ruleFieldText(entry).trim()).filter(Boolean)
    }

    /**
     * 改写提交正文：正文 + 条件/例外/作用域（服务端 decisions.text 只吃单条正文，
     * 所以结构化字段在这里落成稳定文本块，不丢用户改动）。
     */
    function composeProposalText(input) {
      const i = input && typeof input === 'object' ? input : {}
      const body = String(i.text === null || i.text === undefined ? '' : i.text).trim()
      const conditions = clauseLines(i.conditions)
      const exceptions = clauseLines(i.exceptions)
      const scope = String(i.scope === null || i.scope === undefined ? '' : i.scope).trim()
      const lines = body ? [body] : []
      if (conditions.length > 0) lines.push('', '条件：', ...conditions.map((line) => '- ' + line))
      if (exceptions.length > 0) lines.push('', '例外：', ...exceptions.map((line) => '- ' + line))
      if (scope) lines.push('', '作用域：' + scope)
      return lines.join('\n').trim()
    }

    /**
     * 丢弃子句 → `acknowledgeDropped` 契约形状（R9-14）：`[{key, clauses:[...]}]`。
     *
     * 为什么不发裸 key/布尔：key 粒度一次放行整条规则的全部条款，等于把安全确认做成橡皮章。
     */
    function proposalAckPayload(rows) {
      const byKey = new Map()
      for (const row of Array.isArray(rows) ? rows : []) {
        const key = String((row && row.key) || '').trim()
        const clause = String((row && row.text) || '').trim()
        if (!key || !clause) continue
        const list = byKey.get(key) || []
        if (!list.includes(clause)) list.push(clause)
        byKey.set(key, list)
      }
      return [...byKey.entries()].map(([key, clauses]) => ({ key, clauses }))
    }

    /** decisions 载荷：只带契约允许的字段，空正文不传（收录走候选原文）。 */
    function proposalDecisionsFor(input) {
      const i = input && typeof input === 'object' ? input : {}
      const decisions = {}
      const text = typeof i.text === 'string' ? i.text.trim() : ''
      if (text) decisions.text = text
      if (i.acknowledgeDropped === true) {
        const acknowledged = proposalAckPayload(i.dropped)
        if (acknowledged.length > 0) decisions.acknowledgeDropped = acknowledged
      }
      if (Array.isArray(i.acceptAffected) && i.acceptAffected.length > 0) {
        decisions.acceptAffected = i.acceptAffected.map((key) => String(key))
      }
      return decisions
    }

    // ---------------------------------------------------------- rules:edit（R5）

    /** 正文硬顶：与服务端 RULE_BODY_MAX 同值；计数按码点（ruleTextChars）。 */
