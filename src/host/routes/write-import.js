/**
 * 写入/导入/导出/审核：/write、/import、/export、/import/status、/write/review。
 * 拆分（P2d）：写路径硬顶、导入信封上限、错误码白名单集中在本文件。
 * 依赖方向：host → host/http-kit + shared/error-table + node:buffer。
 */
import { Buffer } from 'node:buffer'
import { readJson } from '../http-kit.js'
import { statusOf } from '../../shared/error-table.mjs'
import { PREFIX } from './prefix.js'
import { sendBackendFailure } from './common.js'

/** 写入文本上限（与 Config.write.maxChars 默认值一致，路由侧再做硬顶）。 */
const MAX_WRITE_CHARS = 500
/** import 的 jsonl 正文上限 4 MiB；外层 JSON 信封留 1 MiB 余量。 */
const MAX_IMPORT_BYTES = 4 * 1024 * 1024
const MAX_IMPORT_ENVELOPE = MAX_IMPORT_BYTES + 1024 * 1024
/** 后端写入错误码白名单：命中则按客户端错误 400 透传，未命中一律 502（不泄漏内部码）。 */
const WRITE_ERROR_CODES = new Set([
  'invalid_text', 'invalid_level', 'invalid_memory_type', 'invalid_tags', 'identity_required',
  'write_disabled', 'duplicate', 'text_too_long', 'privacy', 'daily_cap',
])

export async function handleWriteImport({
  req, res, path, backend, identity, validatedIdentityOverride, traceId, log, sendJson, sendMethodNotAllowed,
}) {
    if (path === `${PREFIX}/write`) {
      if (req.method !== 'POST') return sendMethodNotAllowed(res, 'POST')
      const body = await readJson(req)
      if (!body.ok) return sendJson(res, body.status, { ok: false, error: body.error })
      const idn = validatedIdentityOverride(body.value?.identity)
      if (!idn.ok) return sendJson(res, idn.status || 400, { ok: false, error: idn.error })
      const text = typeof body.value?.text === 'string' ? body.value.text.trim() : ''
      if (!text || text.length > MAX_WRITE_CHARS) return sendJson(res, 400, { ok: false, error: 'invalid_text' })

      const rawLevel = body.value?.level
      if (rawLevel !== undefined && !['core', 'important', 'normal'].includes(rawLevel)) {
        return sendJson(res, 400, { ok: false, error: 'invalid_level' })
      }
      const rawType = body.value?.memory_type
      if (rawType !== undefined && !['semantic', 'procedural', 'episodic', 'mixed'].includes(rawType)) {
        return sendJson(res, 400, { ok: false, error: 'invalid_memory_type' })
      }
      const rawTags = body.value?.tags
      if (rawTags !== undefined && (!Array.isArray(rawTags) || rawTags.some((t) => typeof t !== 'string'))) {
        return sendJson(res, 400, { ok: false, error: 'invalid_tags' })
      }
      const tags = [...new Set((rawTags || []).map((t) => t.trim()).filter(Boolean))].slice(0, 32)

      if (typeof backend.write !== 'function') return sendJson(res, 502, { ok: false, error: 'backend_unavailable' })

      let result
      try {
        result = await backend.write({
          text,
          level: rawLevel || 'normal',
          memory_type: rawType || 'semantic',
          tags,
          identity: idn.identity,
          traceId,
        })
      } catch (err) {
        log(`[whale-memory] write fail: ${err?.message || 'error'}`)
        return sendBackendFailure(res, sendJson, err, 'backend_error')
      }
      if (!result) return sendJson(res, 502, { ok: false, error: 'backend_unreachable' })
      if (result.ok === false) {
        const whitelisted = WRITE_ERROR_CODES.has(result.error)
        return sendJson(res, whitelisted ? 400 : 502, {
          ok: false,
          error: whitelisted ? result.error : 'backend_error',
        })
      }
      if (result.id === undefined || result.id === null) {
        if (result.candidate || result.action === 'CANDIDATE') {
          return sendJson(res, 200, { ok: true, id: null, candidate: true })
        }
        return sendJson(res, 502, { ok: false, error: 'backend_error' })
      }
      return sendJson(res, 200, { ok: true, id: String(result.id) })
    }


    if (path === `${PREFIX}/import`) {
      if (req.method !== 'POST') return sendMethodNotAllowed(res, 'POST')
      const body = await readJson(req, MAX_IMPORT_ENVELOPE)
      if (!body.ok) return sendJson(res, body.status, { ok: false, error: body.error })
      const jsonl = body.value?.jsonl
      if (typeof jsonl !== 'string') return sendJson(res, 400, { ok: false, error: 'invalid_jsonl' })
      if (Buffer.byteLength(jsonl, 'utf8') > MAX_IMPORT_BYTES) {
        return sendJson(res, 413, { ok: false, error: 'payload_too_large' })
      }
      const dryRun = body.value?.dryRun === true
      const lineCount = jsonl.split('\n').filter((s) => s.trim()).length

      // 大导入不占主线程：>50 行走 202 + jobId，后台每批 50 条。
      if (!dryRun && lineCount > 50 && typeof backend.startImport === 'function') {
        try {
          const started = await backend.startImport({ jsonl, identity, forceIdentity: true })
          res.statusCode = 202
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.setHeader('cache-control', 'no-store')
          res.end(JSON.stringify({ ok: true, async: true, jobId: started.jobId, total: started.total }))
          return true
        } catch (err) {
          log(`[whale-memory] import start fail: ${err?.message || 'error'}`)
          return sendJson(res, 502, { ok: false, error: 'backend_error' })
        }
      }

      if (typeof backend.importJsonl !== 'function') {
        return sendJson(res, 502, { ok: false, error: 'backend_unavailable' })
      }
      let result
      try {
        result = await backend.importJsonl({ jsonl, identity, dryRun, forceIdentity: true })
      } catch (err) {
        log(`[whale-memory] import fail: ${err?.message || 'error'}`)
        return sendJson(res, 502, { ok: false, error: 'backend_error' })
      }
      if (!result) return sendJson(res, 502, { ok: false, error: 'backend_unreachable' })
      if (result.ok === false) return sendJson(res, 502, { ok: false, error: 'backend_error' })
      const resultBody = {
        ok: true,
        added: Number(result.added ?? 0),
        skipped: Number(result.skipped ?? 0),
        errors: Number(result.errors ?? 0),
        dryRun: result.dryRun === undefined ? dryRun : Boolean(result.dryRun),
      }
      // 计划书 §8.3 的「保留/拆分/拒绝」三计数：只有 backend 真返回时才透传（旧/假后端保持原契约）。
      if (result.kept !== undefined) resultBody.kept = Number(result.kept)
      if (result.split !== undefined) resultBody.split = Number(result.split)
      if (result.rejected !== undefined) resultBody.rejected = Number(result.rejected)
      if (result.reasons && typeof result.reasons === 'object') resultBody.reasons = result.reasons
      if (Array.isArray(result.error_details)) resultBody.error_details = result.error_details.slice(0, 20)
      return sendJson(res, 200, resultBody)
    }


    if (path === `${PREFIX}/export`) {
      if (req.method !== 'GET') return sendMethodNotAllowed(res, 'GET')
      if (typeof backend.exportJsonl !== 'function') {
        return sendJson(res, 502, { ok: false, error: 'backend_unavailable' })
      }
      let jsonl
      try {
        jsonl = await backend.exportJsonl({ identity })
      } catch (err) {
        log(`[whale-memory] export fail: ${err?.message || 'error'}`)
        return sendJson(res, 502, { ok: false, error: 'backend_error' })
      }
      if (typeof jsonl !== 'string') return sendJson(res, 502, { ok: false, error: 'backend_unreachable' })
      res.statusCode = 200
      res.setHeader('content-type', 'text/plain; charset=utf-8')
      res.setHeader('content-disposition', 'attachment; filename="whale-memory.jsonl"')
      res.setHeader('cache-control', 'no-store')
      res.end(jsonl)
      return true
    }


    if (path === `${PREFIX}/import/status`) {
      if (req.method !== 'GET') return sendMethodNotAllowed(res, 'GET')
      const id = new URL(req.url, 'http://127.0.0.1').searchParams.get('id') || ''
      if (!id || typeof backend.importStatus !== 'function') return sendJson(res, 400, { ok: false, error: 'invalid_job_id' })
      const st = await backend.importStatus(id, { identity })
      return sendJson(res, st?.ok === false ? 404 : 200, st?.ok === false ? st : { ok: true, ...st.job })
    }


    if (path === `${PREFIX}/write/review` && req.method === 'POST') {
      const body = await readJson(req)
      if (!body.ok) return sendJson(res, body.status, { ok: false, error: body.error })
      const id = Number(body.value?.id)
      const decision = String(body.value?.decision || '')
      if (!Number.isFinite(id) || !['accept', 'reject'].includes(decision)) {
        return sendJson(res, 400, { ok: false, error: 'invalid_review' })
      }
      const idn = validatedIdentityOverride(body.value?.identity)
      if (!idn.ok) return sendJson(res, idn.status || 400, { ok: false, error: idn.error })
      if (typeof backend.reviewWrite !== 'function') return sendJson(res, 502, { ok: false, error: 'backend_unavailable' })
      const got = await backend.reviewWrite(id, decision, String(body.value?.reason || '').slice(0, 200), { identity: idn.identity })
      if (!got?.ok) return sendJson(res, statusOf(got.error, 400), got)
      return sendJson(res, 200, got)
    }
  return false
}
