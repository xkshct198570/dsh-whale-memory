/**
 * 双轨同步（S4）：A 本地库 ↔ Python 网关 whale.db，经 B 的本机桥接口做文件交换。
 *
 * 设计：
 * - transport.pull() → JSONL（Python mem_export 产）→ A importJsonl（可 dryRun）。
 * - transport.push(jsonl) → B 调 Python mem_write 入库；A 只负责导出，不直接碰 Python 库。
 * - 所有动作可 dryRun；真跑必须 confirm=true（路由层校验）。
 * - 失败不抛给调用方 UI：返回 {ok:false,error}，本地库不受影响。
 */
const DEFAULT_TIMEOUT = 30_000

export class HttpSyncTransport {
  /** @param {{ baseUrl:string, timeoutMs?:number, log?:Function }} opts */
  constructor({ baseUrl, timeoutMs = DEFAULT_TIMEOUT, log = () => {} }) {
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '')
    this.timeoutMs = timeoutMs
    this.log = log
  }

  async pull(signal) {
    const res = await fetch(`${this.baseUrl}/sync/pull`, { signal: signal || AbortSignal.timeout(this.timeoutMs) })
    if (!res.ok) throw new Error(`sync_pull_http_${res.status}`)
    return await res.text()
  }

  async push(jsonl, signal) {
    const res = await fetch(`${this.baseUrl}/sync/push?confirm=1`, {
      method: 'POST', headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: jsonl, signal: signal || AbortSignal.timeout(this.timeoutMs),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok || body.ok === false) throw new Error(body.error || `sync_push_http_${res.status}`)
    return body
  }
}

/**
 * 预演/拉取：从网关导 JSONL，按 text_hash 幂等导入 A。
 * dryRun=true 只统计；false 走异步分片导入（>50 行）+ 返回 jobId。
 */
export async function pullFromGateway({ backend, transport, identity, dryRun = true, signal }) {
  try {
    const jsonl = await transport.pull(signal)
    if (!jsonl || !jsonl.trim()) return { ok: true, direction: 'pull', lines: 0, added: 0, skipped: 0, errors: 0 }
    if (dryRun) {
      const stat = await backend.importJsonl({ jsonl, identity, dryRun: true })
      return { ok: true, direction: 'pull', dryRun: true, lines: jsonl.trim().split('\n').length, ...stat }
    }
    const started = await backend.startImport({ jsonl, identity })
    return { ok: true, direction: 'pull', dryRun: false, ...started }
  } catch (err) {
    return { ok: false, direction: 'pull', error: String(err?.message || err) }
  }
}

/** 推送：导出 A 本地 JSONL → B → Python mem_write。 */
export async function pushToGateway({ backend, transport, identity, dryRun = true, signal }) {
  try {
    const jsonl = await backend.exportJsonl({ identity })
    const lines = jsonl.trim() ? jsonl.trim().split('\n').length : 0
    if (dryRun) return { ok: true, direction: 'push', dryRun: true, lines }
    const result = await transport.push(jsonl, signal)
    return { ok: true, direction: 'push', dryRun: false, lines, ...result }
  } catch (err) {
    return { ok: false, direction: 'push', error: String(err?.message || err) }
  }
}
