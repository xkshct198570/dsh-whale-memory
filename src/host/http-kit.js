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
