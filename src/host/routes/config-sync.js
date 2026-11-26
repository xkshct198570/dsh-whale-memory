/**
 * 配置保存/回显、同步、反思：/config、/sync、/reflect。
 * 拆分（P2d）：配置写面板与桥接动作；配置深合并/回显 helper 在 config-util.js。
 * 依赖方向：host → config-util + shared + core/sync。
 */
import { readJson } from '../http-kit.js'
import { bool, value } from '../../shared/config-values.js'
import { resolveRefsDeep } from '../../shared/resolve-refs.js'
import { statusOf } from '../../shared/error-table.mjs'
import { HttpSyncTransport, pullFromGateway, pushToGateway } from '../../core/sync.js'
import { PREFIX } from './prefix.js'
import {
  deepMergeLeaf, echoConfig, pickConfigKeys, readBackConfig, syncRuntimeConfig,
} from './config-util.js'

export async function handleConfigSync({
  req, res, path, method, config, backend, identity, identityView, identityOverride, ctx, log, traceId, reflect, sendJson, sendMethodNotAllowed,
}) {
    if (path === `${PREFIX}/sync`) {
      if (req.method !== 'POST') return sendMethodNotAllowed(res, 'POST')
      const body = await readJson(req)
      if (!body.ok) return sendJson(res, body.status, { ok: false, error: body.error })
      if (!bool(config?.sync?.enabled, false)) return sendJson(res, 501, { ok: false, error: 'sync_disabled' })
      const direction = String(body.value?.direction || 'pull')
      if (!['pull', 'push', 'both'].includes(direction)) return sendJson(res, 400, { ok: false, error: 'invalid_direction' })
      const dryRun = body.value?.dryRun !== false
      if (!dryRun && body.value?.confirm !== true) return sendJson(res, statusOf('confirm_required'), { ok: false, error: 'confirm_required' })
      const transport = new HttpSyncTransport({ baseUrl: value(config?.sync?.bridgeUrl, ''), log })
      if (!transport.baseUrl) return sendJson(res, 501, { ok: false, error: 'sync_bridge_unset' })
      // 身份必须与 dispatch 顶部同一口径（含宿主 userId）：旧实现没传宿主身份，
      // auto 模式 + Config userId 为空时会落到 'local'，同步错分区。
      const out = {}
      if (direction === 'pull' || direction === 'both') out.pull = await pullFromGateway({ backend, transport, identity, dryRun, traceId })
      if (direction === 'push' || direction === 'both') out.push = await pushToGateway({ backend, transport, identity, dryRun, traceId })
      return sendJson(res, 200, { ok: true, dryRun, trace_id: traceId, ...out })
    }


    if (path === `${PREFIX}/reflect`) {
      if (req.method !== 'POST') return sendMethodNotAllowed(res, 'POST')
      if (!reflect || typeof reflect.trigger !== 'function') {
        return sendJson(res, 501, { ok: false, error: 'reflect_unavailable' })
      }
      const result = await reflect.trigger()
      if (result?.ok === false && result.reason === 'busy') return sendJson(res, 409, { ok: false, error: 'busy' })
      return sendJson(res, 200, { ok: true, started: true, result })
    }


    if (path === `${PREFIX}/config` && req.method === 'POST') {
      const body = await readJson(req)
      if (!body.ok) return sendJson(res, body.status, { ok: false, error: body.error })
      const next = body.value?.config
      if (!next || typeof next !== 'object' || Array.isArray(next)) {
        return sendJson(res, 400, { ok: false, error: 'invalid_config' })
      }
      const patch = pickConfigKeys(next)
      if (Object.keys(patch).length === 0) {
        return sendJson(res, 400, { ok: false, error: 'invalid_config' })
      }
      try {
        const editor = ctx?.get?.('configEditor')
        if (!editor || typeof editor.edit !== 'function' || !ctx?.fiber?.entry) {
          return sendJson(res, 501, { ok: false, error: 'config_save_unavailable' })
        }
        let saved = null
        // 只按提交的叶子深合并；current 里的未提交字段原样保留。
        await editor.edit(ctx.fiber.entry, (current) => {
          saved = deepMergeLeaf(resolveRefsDeep(current || {}), patch)
          return saved
        })
        saved = readBackConfig(editor, ctx.fiber.entry, saved)
          || deepMergeLeaf(echoConfig(config), patch)
        syncRuntimeConfig(config, saved)
        return sendJson(res, 200, { ok: true })
      } catch (err) {
        log(`[whale-memory] config save fail: ${err?.message || err}`)
        return sendJson(res, 501, { ok: false, error: 'config_save_failed' })
      }

    }

    if (path === `${PREFIX}/config` && req.method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        config: echoConfig(config),
        runtimeIdentity: identityView(),
        // 客户端据此决定是否给读写请求带显式身份；远端只读面板不得覆盖。
        identityOverride: Boolean(identityOverride),
      })
    }
  return false
}
