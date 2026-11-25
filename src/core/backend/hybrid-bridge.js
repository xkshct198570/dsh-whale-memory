// 职责：backend 远端桥——HTTP 协议客户端（HttpBackend/协议串）与 local/http/hybrid 后端工厂。
// 依赖方向：local-db（LocalBackend）← 本文件 → hybrid.js 门面；不 import host。
// 两条硬口径：读接口 fail-open（失败返回 null 不阻塞对话）；写接口显式失败（{ok:false}，绝不静默 null）。

import { value } from '../../shared/config-values.js'
import { HybridBackend } from '../hybrid.js'
import { LocalBackend } from './local-db.js'

/**
 * 读接口第二参数兼容层：既接受 AbortSignal（hook 直传 `recall(q, signal)` 的旧写法），
 * 也接受 `{ signal, timeoutMs, identity }` 选项对象（路由统一 opts 口径）。
 * why 必须兼容：hook 传的是 AbortSignal，路由传的是 opts；HttpBackend 一个方法要接住两种调用。
 *
 * @param {AbortSignal|{signal?:AbortSignal,timeoutMs?:number,identity?:any}|null|undefined} opts
 * @returns {{ signal?: AbortSignal, timeoutMs?: number, identity?: any }}
 */
function callOpts(opts) {
  if (!opts || typeof opts !== 'object') return {}
  if (typeof opts.addEventListener === 'function' && typeof opts.aborted === 'boolean') return { signal: opts }
  return { ...opts }
}

/** 远端协议串：`GET /version` 回 `{protocol}`，不匹配即 protocol_mismatch（面板可读）。 */
export const WHALE_PROTOCOL = 'whale-memory/1'
/** 单次响应体硬顶（防止远端返回巨大 JSON 拖死主线程）。 */
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

/**
 * 外部服务客户端：读四接口 + 写接口 + version。
 *
 * 两条硬口径：
 * - 读接口 fail-open（返回 null），检索失败不能阻塞对话；
 * - 写接口显式失败（返回 `{ok:false,error}`），绝不静默 null——否则 outbox 会把
 *   "没写成功"当成"没响应"，重试与审计都失去依据。
 *
 * Bearer token 只由构造参数传入（不读 env/config 魔法），`authorization` 头统一注入，
 * 读/写/version 三条链路同源。
 */
export class HttpBackend {
  /**
   * @param {{ baseUrl?: string, timeoutMs?: number, token?: string, log?: Function }} [opts]
   */
  constructor({ baseUrl, timeoutMs = 3000, token = '', log = () => {} } = {}) {
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '')
    this.mode = 'http'
    this.timeoutMs = timeoutMs
    this.token = token
    this.log = log
    /** 最近一次成功探测到的协议串（未探测为 null）。 */
    this.protocol = null
    /** 最近一次协议不匹配的证据 `{protocol,expected,baseUrl,at}`；匹配/未探测为 null。 */
    this.protocolMismatch = null
    this.protocolCheckedAt = null
  }

  get ready() { return Boolean(this.baseUrl) }

  /**
   * 运行中补 token（凭证服务异步解析，构造时拿不到）。
   * @param {string} token
   * @returns {{ ok: boolean }}
   */
  setToken(token) {
    this.token = String(token || '')
    return { ok: true }
  }

  /** 面板/统计可读的协议状态：即使不匹配也返回对象，不抛。 */
  get protocolStatus() {
    return {
      ok: this.protocol === WHALE_PROTOCOL,
      protocol: this.protocol,
      expected: WHALE_PROTOCOL,
      mismatch: this.protocolMismatch,
      checked_at: this.protocolCheckedAt,
      baseUrl: this.baseUrl,
    }
  }

  /**
   * 统一发送：不抛异常，返回显式结果。
   * @param {string} path
   * @param {{ method?: string, body?: unknown, signal?: AbortSignal, timeoutMs?: number, headers?: Record<string,string> }} [opts]
   * @returns {Promise<{ ok: boolean, status: number, data?: any, error?: string, timedOut?: boolean }>}
   */
  async _send(path, opts = {}) {
    if (!this.ready) return { ok: false, status: 0, error: 'backend_not_configured' }
    const { method = 'GET', body, signal, timeoutMs = this.timeoutMs, headers = {} } = opts
    const budget = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : this.timeoutMs
    const timeout = AbortSignal.timeout(budget)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    try {
      const res = await fetch(this.baseUrl + path, {
        method, signal: combined,
        headers: {
          'content-type': 'application/json',
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const text = await res.text()
      if (!res.ok) {
        return { ok: false, status: res.status, error: `http_${res.status}`, text: text.slice(0, 500) }
      }
      if (text.length > MAX_RESPONSE_BYTES) return { ok: false, status: res.status, error: 'response_too_large' }
      let data = null
      if (text) {
        try { data = JSON.parse(text) } catch { return { ok: false, status: res.status, error: 'invalid_json' } }
      }
      return { ok: true, status: res.status, data }
    } catch (err) {
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError'
      return {
        ok: false, status: 0, timedOut,
        error: timedOut ? 'timeout' : String(err?.code || err?.message || 'network_error'),
      }
    }
  }

  /** 读接口 fail-open：失败返回 null（内部日志保留原因）。 */
  async request(path, opts = {}) {
    const out = await this._send(path, opts)
    if (out.ok) return out.data
    this.log(`[whale-memory] backend ${opts.method || 'GET'} ${path} fail-open: ${out.error}`)
    return null
  }

  async stats(opts = {}) { return this.request('/stats', callOpts(opts)) }
  /**
   * 置顶规则在外部协议里没有端点：规则语义只存在于本地库（R1 设计）。
   * 返回 null 让 Hybrid 回退本地真源；直接调用方拿到 null 即"无规则"。
   */
  async pinnedRules() { return null }
  async recent(limit, opts = {}) {
    const { signal, ...rest } = callOpts(opts)
    return this.request(`/recent?limit=${encodeURIComponent(limit)}`, { signal, ...rest })
  }
  async search(q, opts = {}) {
    const { signal, ...rest } = callOpts(opts)
    return this.request('/search', { method: 'POST', body: q, signal, ...rest })
  }
  async recall(q, opts = {}) {
    const { signal, ...rest } = callOpts(opts)
    return this.request('/recall', { method: 'POST', body: q, signal, ...rest })
  }

  /**
   * 写入远端：POST `/write`，body `{event}`；成功返回远端 action。
   *
   * 冲突不在这里裁决：`{action:'conflict'}` 或 `{conflict:true}` 原样作为
   * `conflict:true` 交给 Hybrid（它负责把本地节点置 stale 并保留 outbox 明细）。
   *
   * @param {object} event 节点/事件快照
   * @param {{ signal?: AbortSignal, timeoutMs?: number }} [opts]
   * @returns {Promise<{ ok: boolean, action?: string, conflict?: boolean, id?: string|null, status?: number, error?: string }>}
   */
  async write(event, opts = {}) {
    const out = await this._send('/write', { method: 'POST', body: { event }, ...opts })
    if (!out.ok) return { ok: false, error: out.error, status: out.status, timedOut: Boolean(out.timedOut) }
    const data = out.data && typeof out.data === 'object' ? out.data : {}
    if (data.ok === false) return { ok: false, error: String(data.error || 'write_rejected'), status: out.status, action: data.action }
    const action = String(data.action ?? 'ok')
    return {
      ok: true,
      action,
      conflict: action === 'conflict' || data.conflict === true,
      id: data.id === undefined || data.id === null ? null : String(data.id),
      status: out.status,
    }
  }

  /**
   * 协议探测：GET `/version` → `{protocol:'whale-memory/1'}`。
   *
   * 不匹配时不抛、不静默：返回 `{ok:false,error:'protocol_mismatch'}`，同时把证据留在
   * `protocolMismatch` / `protocolStatus` 上（面板与 stats 可读）。网络失败也显式返回。
   *
   * @param {{ signal?: AbortSignal, timeoutMs?: number }} [opts]
   * @returns {Promise<{ ok: boolean, protocol?: string|null, expected: string, mismatch?: boolean, status?: number, error?: string }>}
   */
  async version(opts = {}) {
    const out = await this._send('/version', opts)
    if (!out.ok) return { ok: false, expected: WHALE_PROTOCOL, status: out.status, error: out.error }
    const protocol = String(out.data?.protocol ?? '')
    this.protocol = protocol || null
    this.protocolCheckedAt = Date.now()
    this.protocolMismatch = protocol === WHALE_PROTOCOL
      ? null
      : { protocol: protocol || null, expected: WHALE_PROTOCOL, baseUrl: this.baseUrl, at: this.protocolCheckedAt }
    if (this.protocolMismatch) {
      this.log(`[whale-memory] backend protocol mismatch: ${protocol || '(empty)'} != ${WHALE_PROTOCOL}`)
      return { ok: false, error: 'protocol_mismatch', protocol, expected: WHALE_PROTOCOL, mismatch: true, status: out.status }
    }
    return { ok: true, protocol, expected: WHALE_PROTOCOL, status: out.status }
  }
}

/**
 * 后端工厂：local（默认）/ http（纯远端）/ hybrid（本地真源 + 远端副本 + outbox）。
 *
 * hybrid 不再当纯 Http 返回：读走 HTTP 失败回本地，写必须落本地并排队同步。
 *
 * @param {{ mode?: string, url?: string, timeoutMs?: number }} cfg backend 配置段
 * @param {{ token?: string, log?: Function, dataDir?: string, useWorker?: boolean, config?: object|Function,
 *   getLlm?: () => any, getSelection?: () => object }} [extra]
 *   config 为完整配置（或 getter）：hybrid 读 `sync.httpTimeoutMs`（默认 800ms），
 *   LocalBackend 读 `write.*`，二者同源；getLlm/getSelection 供 `write.judge='llm'` 的判定器取模型。
 */
export function createBackend(cfg, extra = {}) {
  if (cfg?.mode === 'http') {
    return new HttpBackend({
      baseUrl: cfg.url || '',
      timeoutMs: cfg.timeoutMs || 3000,
      token: extra.token || '',
      log: extra.log || (() => {}),
    })
  }
  if (cfg?.mode === 'hybrid') {
    const liveConfig = () => {
      const c = extra.config
      return typeof c === 'function' ? c() : c
    }
    const syncTimeout = Number(value(liveConfig()?.sync?.httpTimeoutMs))
    const httpTimeoutMs = Number.isFinite(syncTimeout) && syncTimeout > 0 ? syncTimeout : 800
    const local = new LocalBackend({
      dataDir: extra.dataDir || '',
      useWorker: extra.useWorker !== false,
      timeoutMs: cfg?.timeoutMs || 1200,
      log: extra.log,
      config: extra.config,
      getLlm: extra.getLlm,
      getSelection: extra.getSelection,
    })
    const http = new HttpBackend({
      baseUrl: cfg.url || '',
      timeoutMs: httpTimeoutMs,
      token: extra.token || '',
      log: extra.log || (() => {}),
    })
    return new HybridBackend({ local, http, config: extra.config, log: extra.log || (() => {}), httpTimeoutMs })
  }
  return new LocalBackend({
    dataDir: extra.dataDir || '',
    useWorker: extra.useWorker !== false,
    timeoutMs: cfg?.timeoutMs || 1200,
    log: extra.log,
    config: extra.config,
    getLlm: extra.getLlm,
    getSelection: extra.getSelection,
  })
}
