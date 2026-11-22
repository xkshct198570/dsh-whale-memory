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

/** Host 头 → 主机名：去端口、IPv6 去括号；空/非法返回 ''。 */
function hostnameOf(value) {
  const raw = String(value ?? '').trim().toLowerCase()
  if (!raw) return ''
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']')
    return end > 0 ? raw.slice(1, end) : ''
  }
  return raw.split(':')[0]
}

/** 本机 Host 头：空头放行（curl 无 Host 的历史行为），只拒绝明确的外部 Host。 */
export function isLocalHostName(host) {
  const name = hostnameOf(host)
  return !name || LOCAL_HOSTNAMES.has(name)
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
 * @returns {{status:number,error:string}|null} null=放行
 */
export function writeRequestProblem(req) {
  const rawType = String(req?.headers?.['content-type'] ?? '')
  const mediaType = rawType.split(';')[0].trim().toLowerCase()
  if (mediaType !== 'application/json') {
    return { status: 415, error: 'unsupported_media_type' }
  }
  const host = req?.headers?.host
  if (!isLocalHostName(host)) return { status: 403, error: 'cross_origin_denied' }
  const origin = req?.headers?.origin
  if (origin !== undefined && !isLocalOrigin(origin)) {
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

/** 读 JSON body，硬顶 maxBytes；返回 { ok, value } 或 { ok:false, status, error }。 */
export async function readJson(req, maxBytes = 64 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) return { ok: false, status: 413, error: 'payload_too_large' }
    chunks.push(chunk)
  }
  if (!size) return { ok: false, status: 400, error: 'invalid_json' }
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  } catch {
    return { ok: false, status: 400, error: 'invalid_json' }
  }
}

/** @param {unknown} value */
export function clamp(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}
