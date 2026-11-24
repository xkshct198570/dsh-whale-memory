/**
 * Host 路由公共件：回环判定 / JSON 收发 / 请求体上限 / 统一错误码。
 *
 * 为什么收敛成一处：旧面板把 isLoopback/sendJson 复制了 4 份，安全闸改一次要改 4 处；
 * 本包只保留这一份，后续所有路由必须 import 这里（铁律 2 解耦优先）。
 */
import { Buffer } from 'node:buffer'

/** @param {string | undefined} addr */
export function isLoopback(addr) {
  if (!addr) return false
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || addr.startsWith('127.')
}

/** 本机 GUI 允许的 host 名（不含端口）。 */
const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1'])

/**
 * Host 头 → 主机名：去端口、IPv6 去括号。
 *
 * 严格只返回「形态合法」的主机名，任何畸形（`[evil`、`[]`、`:8080`、userinfo、
 * 未加括号的 IPv6、非数字端口）一律返回 ''。为什么不能宽松：历史实现把畸形 Host
 * 也当成「空 Host」放行，DNS rebinding 页面就能带 `Host: [evil` 同源 GET 走规则全文。
 *
 * @param {unknown} value
 * @returns {string} '' = 畸形/空
 */
function hostnameOf(value) {
  const raw = String(value ?? '').trim().toLowerCase()
  if (!raw) return ''
  // userinfo（`user@host`）不是合法 Host 头；带 @ 一律按畸形拒绝。
  if (raw.includes('@')) return ''
  // 未加括号的 IPv6 只有本机回环 `::1` 可接受，其余（多冒号）按畸形。
  if (raw === '::1') return '::1'
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']')
    if (end < 0) return ''
    const name = raw.slice(1, end)
    const rest = raw.slice(end + 1)
    // `[::1]evil`、`[::1]8080` 都不是 Host 头合法形态。
    if (rest && !/^:\d+$/.test(rest)) return ''
    return name
  }
  const parts = raw.split(':')
  if (parts.length === 1) return parts[0]
  if (parts.length === 2 && /^\d+$/.test(parts[1])) return parts[0]
  return ''
}

/**
 * 本机 Host 头：缺省/空串放行（curl 与无 Host 的本机客户端历史行为），
 * 非空必须是本机名之一；畸形一律 false（见 `hostnameOf`）。
 *
 * @param {unknown} host
 * @returns {boolean}
 */
export function isLocalHostName(host) {
  const raw = String(host ?? '').trim()
  if (!raw) return true
  return LOCAL_HOSTNAMES.has(hostnameOf(raw))
}

/** 绑定地址字面量归一（IPv6 去括号/小写），用于 allowRemote 的 Host 白名单等值比较。 */
function normalizeBindHost(value) {
  const raw = String(value ?? '').trim().toLowerCase()
  if (!raw) return ''
  if (raw.startsWith('[') && raw.endsWith(']')) return raw.slice(1, -1)
  return raw
}

/**
 * Host 白名单判定：本机名恒放行；allowRemote 时额外放行 webServer 实际绑定地址
 * （`ctx.webServer.host` 只可能是某个具体本地接口字面量）。
 *
 * 为什么不是"allowRemote 就放行任意 Host"：那等于把 DNS rebinding 面重新打开；
 * 绑定地址是已知事实，等值比较既支持同网段访问，也不接受伪造域名。
 *
 * @param {unknown} host Host 头原值
 * @param {string[]} [boundHosts] 额外允许的绑定地址字面量（allowRemote 时传入）
 * @returns {boolean}
 */
export function isAllowedHostName(host, boundHosts = []) {
  const raw = String(host ?? '').trim()
  if (!raw) return true
  const name = hostnameOf(raw)
  if (!name) return false
  if (LOCAL_HOSTNAMES.has(name)) return true
  return boundHosts.map(normalizeBindHost).filter(Boolean).includes(name)
}

/**
 * 本机 GUI Origin：只认 `http(s)://127.0.0.1|localhost|::1[:port]`，带 userinfo/别的 scheme 一律拒绝。
 * 空 Origin（本机 curl / 非浏览器客户端）放行；字面量 `null`（file://）拒绝。
 */
export function isLocalOrigin(origin) {
  const raw = String(origin ?? '').trim().toLowerCase()
  if (!raw) return true
  if (raw === 'null') return false
  let parsed
  try { parsed = new URL(raw) } catch { return false }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  if (parsed.username || parsed.password) return false
  return LOCAL_HOSTNAMES.has(hostnameOf(parsed.host))
}

/**
 * 写请求安全闸：JSON Content-Type + 本机 Host/Origin。
 *
 * Why 必须前置：跨源网页可以用 `text/plain` 简单请求绕过 CORS 预检直接打到本机面板
 * （历史缺陷：恶意页面可触发 purge）。这里在读取 body / 产生任何副作用之前拒绝。
 *
 * @param {{method?:string,headers?:object}} req
 * @param {{boundHosts?:string[]}} [opts] allowRemote 读请求时额外放行的绑定地址
 * @returns {{status:number,error:string}|null} null=放行
 */
export function writeRequestProblem(req, opts = {}) {
  const rawType = String(req?.headers?.['content-type'] ?? '')
  const mediaType = rawType.split(';')[0].trim().toLowerCase()
  if (mediaType !== 'application/json') {
    return { status: 415, error: 'unsupported_media_type' }
  }
  const boundHosts = Array.isArray(opts.boundHosts) ? opts.boundHosts : []
  const host = req?.headers?.host
  // Host 只作附加校验，永远不是认证：真正的写权限由调用方的 peer/端点判定。
  if (!isAllowedHostName(host, boundHosts)) return { status: 403, error: 'cross_origin_denied' }
  const origin = req?.headers?.origin
  if (origin !== undefined && !isAllowedOrigin(origin, boundHosts)) {
    return { status: 403, error: 'cross_origin_denied' }
  }
  return null
}

/** 是否写方法（需要走 writeRequestProblem）。 */
export function isWriteMethod(method) {
  const m = String(method ?? '').toUpperCase()
  return m === 'POST' || m === 'PUT' || m === 'PATCH' || m === 'DELETE'
}

/** @param {import('node:http').ServerResponse} res */
export function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(text)
}

/**
 * 读 JSON body，硬顶 maxBytes；返回 { ok, value } 或 { ok:false, status, error }。
 *
 * `Content-Length` 已知且超限时先 413 并 `req.resume()` 排空：不排空会让大体积请求
 * 继续占着连接把字节喂给 socket（keep-alive 下污染下一次请求），且让客户端以为还能重试。
 *
 * `opts.allowEmpty`：无载荷端点（render-agents / rebuild-mirror）允许真空 body 返回
 * `value:null`；但它仍必须检查返回值——413/其它 400 不能静默继续。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [maxBytes]
 * @param {{allowEmpty?:boolean}} [opts]
 * @returns {Promise<{ok:true,value:any}|{ok:false,status:number,error:string}>}
 */
export async function readJson(req, maxBytes = 64 * 1024, opts = {}) {
  const declared = Number(req?.headers?.['content-length'])
  if (Number.isFinite(declared) && declared > maxBytes) {
    req?.resume?.()
    return { ok: false, status: 413, error: 'payload_too_large' }
  }
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) {
      // 排空剩余字节：否则 keep-alive 连接里残留的 body 会污染下一次请求。
      req?.resume?.()
      return { ok: false, status: 413, error: 'payload_too_large' }
    }
    chunks.push(chunk)
  }
  if (!size) {
    return opts?.allowEmpty === true
      ? { ok: true, value: null }
      : { ok: false, status: 400, error: 'invalid_json' }
  }
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  } catch {
    return { ok: false, status: 400, error: 'invalid_json' }
  }
}

/**
 * 整数参数收敛：缺省/空串/非数字一律回落 fallback，再夹到 [min,max]。
 *
 * 为什么必须先把 null/'' 判掉：`Number(null) === 0` 是有限数，会让 fallback 变成
 * 永远走不到的死代码（列表端点不带 limit 时被夹成 1，而不是声明的默认条数）。
 *
 * @param {unknown} value 原始参数（URLSearchParams.get / body 字段）
 * @param {number} min @param {number} max @param {number} fallback
 * @returns {number}
 */
export function clamp(value, min, max, fallback) {
  if (value === null || value === undefined) return fallback
  const raw = typeof value === 'string' ? value.trim() : value
  if (raw === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

/**
 * Origin 白名单：本机名恒放行；allowRemote 时额外放行 webServer 绑定地址。
 * 空 Origin 是 curl/非浏览器客户端，放行；`null`（file://）拒绝。
 *
 * @param {unknown} origin @param {string[]} [boundHosts]
 * @returns {boolean}
 */
export function isAllowedOrigin(origin, boundHosts = []) {
  const raw = String(origin ?? '').trim()
  if (!raw) return true
  if (raw.toLowerCase() === 'null') return false
  let parsed
  try { parsed = new URL(raw) } catch { return false }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  if (parsed.username || parsed.password) return false
  return isAllowedHostName(parsed.host, boundHosts)
}
