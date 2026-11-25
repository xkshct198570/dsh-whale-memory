    // ---------------------------------------------------------------- runtime

    /** Locale face captured at apply time; UI hooks read the active language from it. */
    let localeService = null

    function localeTag(active) {
      const id = String(active || 'zh')
      if (id.toLowerCase().startsWith('zh')) return 'zh-CN'
      if (id.toLowerCase().startsWith('en')) return 'en-US'
      return id
    }

    function useActiveLocale() {
      const read = () => (localeService && typeof localeService.getSnapshot === 'function'
        ? localeService.getSnapshot().active
        : 'zh')
      const [active, setActive] = useState(read)
      useEffect(() => {
        if (!localeService || typeof localeService.subscribe !== 'function') return undefined
        return localeService.subscribe(() => setActive(read()))
      }, [])
      return active
    }

    function useVisible() {
      const read = () => (typeof document === 'undefined' ? true : document.visibilityState !== 'hidden')
      const [visible, setVisible] = useState(read)
      useEffect(() => {
        if (typeof document === 'undefined') return undefined
        const onChange = () => setVisible(read())
        document.addEventListener('visibilitychange', onChange)
        return () => document.removeEventListener('visibilitychange', onChange)
      }, [])
      return visible
    }

    // ------------------------------------------------------------------ fetch

    /**
     * HTTP 状态兜底码：只在响应体没有 `error` 字段时使用。
     *
     * Why 不能把 422/500 折叠成 unknown_error：规则/写接口的参数错误与落盘失败是最常见的
     * 两类失败，落到「未知错误」等于把可行动信息扔掉（架构书 §7.1）。语义码与
     * src/shared/error-table.mjs 同口径。
     */
    function statusCode(status) {
      if (status === 400) return 'invalid_config'
      if (status === 403) return 'not_loopback'
      if (status === 404) return 'not_found'
      if (status === 409) return 'busy'
      if (status === 413) return 'payload_too_large'
      if (status === 405) return 'method_not_allowed'
      if (status === 422) return 'unprocessable'
      if (status === 500) return 'server_error'
      if (status === 501) return 'config_save_unavailable'
      if (status === 502 || status === 503) return 'backend_error'
      return 'unknown_error'
    }

    async function callJson(path, opts) {
      let res
      try {
        res = await fetch(API + path, opts)
      } catch (cause) {
        const err = new Error('network_error')
        err.code = 'network_error'
        err.cause = cause
        throw err
      }
      const body = await res.json().catch(() => null)
      if (!res.ok || body === null || body.ok === false) {
        const code = (body && typeof body.error === 'string' && body.error) || statusCode(res.status)
        const err = new Error(code)
        err.code = code
        err.status = res.status
        err.offline = Boolean(body && body.offline)
        err.body = body
        throw err
      }
      return body
    }

    function hasKey(key) {
      return Object.keys(dict).some((lang) => Object.prototype.hasOwnProperty.call(dict[lang], key))
    }

    /** 二次确认：宿主无 window 时（测试/SSR）不阻断，视为确认。 */
    function askConfirm(message) {
      if (typeof window === 'undefined' || typeof window.confirm !== 'function') return true
      return window.confirm(message)
    }

    /**
     * 错误码 → 文案。未映射码原文透出 `[code]`（所有页签一致），不得落「未知错误」。
     * @param {(key:string,params?:object)=>string} t
     * @param {{code?:string,message?:string}} err
     * @returns {string}
     */
    function errText(t, err) {
      const code = String((err && (err.code || err.message)) || 'unknown')
      if (hasKey('err.' + code)) return t('err.' + code)
      return '[' + code + ']'
    }

    // ------------------------------------------------------------- formatting

    function toDate(ts) {
      if (ts === null || ts === undefined || ts === '') return null
      const n = Number(ts)
      if (Number.isFinite(n) && n > 0) {
        const ms = n < 1e11 ? n * 1000 : n
        const d = new Date(ms)
        return Number.isNaN(d.getTime()) ? null : d
      }
      const d = new Date(String(ts))
      return Number.isNaN(d.getTime()) ? null : d
    }

    function fmtNum(value, locale) {
      const n = Number(value)
      if (value === null || value === undefined || value === '' || !Number.isFinite(n)) return '—'
      try {
        return new Intl.NumberFormat(localeTag(locale)).format(n)
      } catch {
        return String(n)
      }
    }

    function fmtScore(value, locale) {
      const n = Number(value)
      if (!Number.isFinite(n)) return '—'
      try {
        return new Intl.NumberFormat(localeTag(locale), {
          minimumFractionDigits: 3, maximumFractionDigits: 3,
        }).format(n)
      } catch {
        return n.toFixed(3)
      }
    }

    function fmtTime(ts, locale) {
      const d = toDate(ts)
      if (!d) return '—'
      try {
        return new Intl.DateTimeFormat(localeTag(locale), {
          dateStyle: 'short', timeStyle: 'medium',
        }).format(d)
      } catch {
        return d.toISOString()
      }
    }

    // ------------------------------------------------------- observability
    // 概览观测块（指标卡 / 7 日曲线 / 最近失败）只依赖入参：数值→文案、结构→行。
    // test/client.test.mjs 直接抽取本标记块执行降级断言，因此这里不得引用 t()、css 或组件。
    // >>> observability:pure
    const METRIC_DIRECTIONS = {
      zero_injection_rate: 'lower',
      write_reject_rate: 'lower',
      pending_age_max_min: 'lower',
      idle_rate: 'lower',
      db_size_bytes: 'lower',
      adoption_rate: 'higher',
      job_success_7d: 'higher',
      precision_at_3: 'higher',
      ident_hit_rate: 'higher',
    }

    function safeNumber(value) {
      if (value === null || value === undefined || value === '') return null
      const n = Number(value)
      return Number.isFinite(n) ? n : null
    }

    /** 比例统一到 0–1（后端约定为 0–1，也接受已经乘过 100 的旧口径）。 */
    function ratioOrNull(value) {
      const n = safeNumber(value)
      if (n === null || n < 0) return null
      return n > 1 && n <= 100 ? n / 100 : n
    }

    function fmtPercent(value, locale) {
      const ratio = ratioOrNull(value)
      if (ratio === null) return '—'
      try {
        return new Intl.NumberFormat(localeTag(locale), {
          style: 'percent', maximumFractionDigits: 1,
        }).format(ratio)
      } catch {
        return (Math.round(ratio * 1000) / 10) + '%'
      }
    }

    /** 库大小人类可读：B/KB/MB/GB，缺值返回「—」。 */
    function fmtBytes(value) {
      const n = safeNumber(value)
      if (n === null || n < 0) return '—'
      const units = ['B', 'KB', 'MB', 'GB', 'TB']
      let scaled = n
      let unit = 0
      while (scaled >= 1024 && unit < units.length - 1) {
        scaled /= 1024
        unit += 1
      }
      const shown = unit === 0 ? Math.round(scaled) : scaled >= 100 ? Math.round(scaled) : Math.round(scaled * 10) / 10
      return shown + ' ' + units[unit]
    }

    /** 'met' | 'missed' | null：缺值或缺目标时不给判断，宁可不显示。 */
    function targetState(name, value, target) {
      const got = safeNumber(value)
      const goal = safeNumber(target)
      if (got === null || goal === null) return null
      const direction = METRIC_DIRECTIONS[name] === 'lower' ? 'lower' : 'higher'
      if (direction === 'lower') return got <= goal ? 'met' : 'missed'
      return got >= goal ? 'met' : 'missed'
    }

    function barPercent(ratio) {
      const n = safeNumber(ratio)
      if (n === null || n <= 0) return '0%'
      return Math.min(100, Math.round(n * 100)) + '%'
    }

    function dayKey(value) {
      const d = value instanceof Date ? value : new Date(value === undefined ? Date.now() : value)
      if (Number.isNaN(d.getTime())) return ''
      const mm = String(d.getMonth() + 1).padStart(2, '0')
      const dd = String(d.getDate()).padStart(2, '0')
      return d.getFullYear() + '-' + mm + '-' + dd
    }

    /** series → 每行展示数据；今天按 day 匹配（契约保证最后一项是今天，无法匹配时取末项）。 */
    function trendPoints(series, today) {
      if (!Array.isArray(series)) return []
      const rows = []
      for (const raw of series) {
        if (!raw || typeof raw !== 'object') continue
        const day = raw.day === null || raw.day === undefined ? '' : String(raw.day)
        const recalls = safeNumber(raw.recalls)
        const withHits = safeNumber(raw.withHits)
        const injected = safeNumber(raw.injected)
        rows.push({
          key: day || 'row-' + rows.length,
          day,
          label: day.length >= 10 ? day.slice(5) : day || '—',
          recalls,
          withHits,
          injected,
          adopted: safeNumber(raw.adopted),
          zeroHit: safeNumber(raw.zeroHit),
          injectRatio: withHits && withHits > 0 && injected !== null ? injected / withHits : 0,
          zeroRatio: recalls && recalls > 0 && safeNumber(raw.zeroHit) !== null ? safeNumber(raw.zeroHit) / recalls : 0,
        })
      }
      const matched = today ? rows.findIndex((row) => row.day === today) : -1
      const todayIndex = matched >= 0 ? matched : rows.length - 1
      rows.forEach((row, index) => { row.isToday = index === todayIndex })
      return rows
    }

    /** health.jobs → 失败行；旧后端没有该字段时返回空数组，不报错。 */
    function failureRows(jobs, limit) {
      const list = jobs && Array.isArray(jobs.recent_failures) ? jobs.recent_failures : []
      const max = safeNumber(limit) || 5
      const rows = []
      for (const raw of list) {
        if (!raw || typeof raw !== 'object') continue
        const error = raw.last_error === null || raw.last_error === undefined ? '' : String(raw.last_error)
        rows.push({
          key: raw.id === null || raw.id === undefined || raw.id === '' ? 'fail-' + rows.length : String(raw.id),
          id: raw.id === null || raw.id === undefined ? '' : String(raw.id),
          kind: raw.kind === null || raw.kind === undefined || raw.kind === '' ? '—' : String(raw.kind),
          state: raw.state === null || raw.state === undefined ? '' : String(raw.state),
          attempts: safeNumber(raw.attempts),
          error,
          errorShort: error.length > 120 ? error.slice(0, 117) + '…' : error,
          at: raw.updated_at === undefined ? null : raw.updated_at,
        })
        if (rows.length >= max) break
      }
      return rows
    }
    // <<< observability:pure

    function sameLocalDay(a, b) {
      return a.getFullYear() === b.getFullYear()
        && a.getMonth() === b.getMonth()
        && a.getDate() === b.getDate()
    }

    function pick() {
      for (let i = 0; i < arguments.length; i += 1) {
        const v = arguments[i]
        if (v !== undefined && v !== null && v !== '') return v
      }
      return null
    }

    function numOrNull(v) {
      const n = Number(v)
      return Number.isFinite(n) ? n : null
    }

    /** 页头身份徽标用短 id：保留尾部 8 位，避免长 user_id 撑爆标题栏。 */
    function shortId(value) {
      const s = String(value || '').trim()
      if (!s) return ''
      return s.length > 10 ? '…' + s.slice(-8) : s
    }

    // >>> backend-status:pure
    /**
     * 页头后端状态：`GET /version` → `{mode, protocol{ok,expected}, outbox}`。
     * 兼容 Host 尚未提供 /version 的形态（字段缺失即 null，UI 显示「—」），
     * 因此测试可直接抽取本块运行，不依赖 React 或 t()。
     */
    function backendStatusView(body) {
      const b = body && typeof body === 'object' ? body : {}
      const nest = b.backend && typeof b.backend === 'object' ? b.backend : {}
      const rawMode = b.mode ?? nest.mode ?? b.backendMode ?? b.backend_mode
      const mode = typeof rawMode === 'string' && rawMode.trim() ? rawMode.trim() : null
      const proto = b.protocol && typeof b.protocol === 'object'
        ? b.protocol
        : (b.protocolStatus && typeof b.protocolStatus === 'object' ? b.protocolStatus : null)
      let protocol = null
      if (proto) {
        if (proto.ok === true) protocol = 'ok'
        else if (proto.ok === false || proto.mismatch) protocol = 'mismatch'
      } else if (typeof b.protocol === 'string') {
        const expected = typeof b.expected === 'string' ? b.expected : ''
        protocol = expected ? (b.protocol === expected ? 'ok' : 'mismatch') : 'ok'
      } else if (b.protocol_ok === true) protocol = 'ok'
      else if (b.protocol_ok === false) protocol = 'mismatch'
      const box = b.outbox && typeof b.outbox === 'object' ? b.outbox : null
      const rawOutbox = box
        ? (box.queued ?? box.pending ?? box.n ?? (Number(box.running || 0) + Number(box.queued || 0)))
        : b.outbox
      const outboxNum = Number(rawOutbox)
      const outbox = Number.isFinite(outboxNum) && outboxNum >= 0 ? outboxNum : null
      return { checked: true, mode, protocol, outbox }
    }
    // <<< backend-status:pure

    function parseTags(value) {
      if (Array.isArray(value)) return value.filter((x) => typeof x === 'string')
      if (typeof value === 'string' && value.trim()) {
        try {
          const parsed = JSON.parse(value)
          if (Array.isArray(parsed)) return parsed.filter((x) => typeof x === 'string')
        } catch {
          return value.split(',').map((s) => s.trim()).filter(Boolean)
        }
      }
      return []
    }

    function statusLabel(t, value) {
      return hasKey('status.' + value) ? t('status.' + value) : (value || '—')
    }

    function levelLabel(t, value) {
      return hasKey('level.' + value) ? t('level.' + value) : (value || '—')
    }

    function typeLabel(t, value) {
      return hasKey('type.' + value) ? t('type.' + value) : (value || '—')
    }

    function sourceLabel(t, value) {
      return hasKey('source.' + value) ? t('source.' + value) : (value || '—')
    }

    /** 写入决策 action 本地化：ADD/NOOP/MERGE/SUPERSEDE/REJECT/CANDIDATE。 */
    const WRITE_ACTION_KEYS = {
      ADD: 'writes.actionAdd',
      NOOP: 'writes.actionNoop',
      MERGE: 'writes.actionMerge',
      SUPERSEDE: 'writes.actionSupersede',
      REJECT: 'writes.actionReject',
      CANDIDATE: 'writes.actionCandidate',
    }

    function actionLabel(t, value) {
      const key = WRITE_ACTION_KEYS[String(value || '').toUpperCase()]
      return key ? t(key) : (value || '—')
    }

    function todayRecalls(items) {
      if (!Array.isArray(items)) return null
      const today = new Date()
      let count = 0
      let chars = 0
      for (const item of items) {
        const d = toDate(item && item.ts)
        if (d && sameLocalDay(d, today)) {
          count += 1
          if (item.injected) chars += Number(item.chars) || 0
        }
      }
      return { count, chars }
    }

    // --------------------------------------------------------------- elements

