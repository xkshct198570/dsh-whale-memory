/**
 * MemoryBackend（S1 只实现 HttpBackend；LocalSqliteBackend 在 S2 落地）。
 *
 * 为什么接口先立：A 包后续要同时支持"本地库 / 外部服务 / 双轨"，
 * 上层（routes/hook）只认接口，不认具体存储。
 */

/** @typedef {{ userId: string, roleId: string, workspace: string }} Identity */

/**
 * 外部记忆服务最小客户端（只读：stats/recent/search/recall）。
 * 所有请求都带 AbortSignal；超时/非 2xx/坏 JSON 一律返回 null（fail-open）。
 */
export class HttpBackend {
  /** @param {{ baseUrl: string, timeoutMs?: number, token?: string, log?: (s:string)=>void }} opts */
  constructor({ baseUrl, timeoutMs = 3000, token = '', log = () => {} }) {
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '')
    this.timeoutMs = timeoutMs
    this.token = token
    this.log = log
  }

  get ready() { return Boolean(this.baseUrl) }

  /** @param {string} path @param {{ method?: string, body?: unknown, signal?: AbortSignal, timeoutMs?: number }} [opts] */
  async request(path, opts = {}) {
    if (!this.ready) return null
    const { method = 'GET', body, signal, timeoutMs = this.timeoutMs } = opts
    const timeout = AbortSignal.timeout(timeoutMs)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    try {
      const res = await fetch(this.baseUrl + path, {
        method,
        signal: combined,
        headers: {
          'content-type': 'application/json',
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      if (!res.ok) return null
      const text = await res.text()
      if (text.length > 2 * 1024 * 1024) return null
      return JSON.parse(text)
    } catch (err) {
      this.log(`[whale-memory] backend ${method} ${path} fail-open: ${err?.name || err?.message || 'error'}`)
      return null
    }
  }

  /** @param {AbortSignal} [signal] */
  async stats(signal) { return this.request('/stats', { signal }) }

  /** @param {number} limit @param {AbortSignal} [signal] */
  async recent(limit, signal) { return this.request(`/recent?limit=${encodeURIComponent(limit)}`, { signal }) }

  /** @param {{ query: string, limit: number, identity: Identity }} q @param {AbortSignal} [signal] */
  async search(q, signal) { return this.request('/search', { method: 'POST', body: q, signal }) }

  /** @param {{ query: string, maxHits: number, identity: Identity }} q @param {AbortSignal} [signal] */
  async recall(q, signal) { return this.request('/recall', { method: 'POST', body: q, signal }) }
}

/** S2 占位：本地库未接线前明确返回"未就绪"，不假装有数据。 */
export class LocalBackend {
  get ready() { return false }
  async stats() { return null }
  async recent() { return null }
  async search() { return null }
  async recall() { return null }
}

/** @param {{ mode?: string, url?: string, timeoutMs?: number }} cfg @param {{ token?: string, log?: Function }} [extra] */
export function createBackend(cfg, extra = {}) {
  if (cfg?.mode === 'http' || cfg?.mode === 'hybrid') {
    return new HttpBackend({ baseUrl: cfg.url || '', timeoutMs: cfg.timeoutMs || 3000, ...extra })
  }
  return new LocalBackend()
}
