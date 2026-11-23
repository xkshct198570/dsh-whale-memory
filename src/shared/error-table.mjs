/**
 * 错误码单一真源：code -> { status, localeKey }。
 *
 * 为什么集中：状态码曾散在 rules-routes 的 if 链与 client 的 statusCode 里，两边各改各的
 * （422/500 被折叠成 unknown_error、purge 的 confirm_required 落 400）。这里只登记一次：
 * 路由用 `statusOf()` 取 HTTP 状态，客户端用 localeKey 取文案；没有文案的码显式标
 * `unmapped:true`，客户端一律原文透出 `[code]`，不得落「未知错误」。
 *
 * 状态语义：
 * - 400 参数/JSON 形状问题；404 资源不存在；403 闸门（回环/Host/Origin/功能关闭）；
 * - 409 并发/状态冲突（重试前需重新 plan）；413 体积；415 媒体类型；422 校验/确认失败；
 * - 500 服务端落盘/事务失败；502 后端不可达；503 锁/git 不可用；501 能力未上线。
 *
 * @typedef {{status:number, localeKey:string|null, unmapped?:boolean}} ErrorEntry
 */

/** 有文案的码：localeKey 必须能在 locale/{zh,en,ja}.json 里取到。 */
const mapped = (status, code) => Object.freeze({ status, localeKey: `err.${code}` })

/** 内部/不面客的码：显式 unmapped，客户端按原码透出。 */
const statusOnly = (status) => Object.freeze({ status, localeKey: null, unmapped: true })

/** @type {Readonly<Record<string, ErrorEntry>>} */
export const ERROR_TABLE = Object.freeze({
  affected_inactive: mapped(409, 'affected_inactive'),
  affected_missing: mapped(409, 'affected_missing'),
  rule_guard_failed: mapped(422, 'rule_guard_failed'),
  target_conflict: mapped(409, 'target_conflict'),
  target_missing: mapped(409, 'target_missing'),
  all_invalid: statusOnly(400),
  already_retired: mapped(409, 'already_retired'),
  backend_disposed: statusOnly(502),
  backend_error: mapped(502, 'backend_error'),
  backend_not_configured: statusOnly(502),
  backend_unavailable: mapped(502, 'backend_unavailable'),
  backend_unreachable: mapped(502, 'backend_unreachable'),
  bad_action: statusOnly(400),
  bad_id: statusOnly(400),
  bad_json: statusOnly(400),
  busy: mapped(409, 'busy'),
  candidate_not_found: mapped(404, 'candidate_not_found'),
  commit_failed: mapped(422, 'commit_failed'),
  config_save_failed: mapped(400, 'config_save_failed'),
  config_save_unavailable: mapped(501, 'config_save_unavailable'),
  confirm_required: mapped(422, 'confirm_required'),
  cross_origin_denied: mapped(403, 'cross_origin_denied'),
  delete_failed: statusOnly(400),
  diff_too_large: mapped(413, 'diff_too_large'),
  duplicate_number: statusOnly(400),
  duplicate_rule: mapped(409, 'duplicate_rule'),
  empty: statusOnly(400),
  empty_rewrite: statusOnly(400),
  empty_text: mapped(400, 'empty_text'),
  ensure_failed: mapped(400, 'ensure_failed'),
  exceptions_missing: statusOnly(400),
  file_too_large: mapped(413, 'file_too_large'),
  front_matter_missing: statusOnly(400),
  front_matter_unclosed: statusOnly(400),
  fts_misaligned: statusOnly(400),
  git_disabled: statusOnly(400),
  git_required: mapped(403, 'git_required'),
  git_unavailable: mapped(503, 'git_unavailable'),
  http_not_configured: statusOnly(400),
  identity_required: mapped(400, 'identity_required'),
  immutable_field: mapped(400, 'immutable_field'),
  invalid_config: mapped(400, 'invalid_config'),
  invalid_decision: statusOnly(400),
  invalid_direction: mapped(400, 'invalid_direction'),
  invalid_draft: mapped(422, 'invalid_draft'),
  invalid_edge_ids: statusOnly(400),
  invalid_encoding: statusOnly(400),
  invalid_etype: statusOnly(400),
  invalid_front: statusOnly(400),
  invalid_job_id: mapped(400, 'invalid_job_id'),
  invalid_json: mapped(400, 'invalid_json'),
  invalid_jsonl: mapped(400, 'invalid_jsonl'),
  invalid_key: mapped(400, 'invalid_key'),
  invalid_level: mapped(400, 'invalid_level'),
  invalid_memory_type: mapped(400, 'invalid_memory_type'),
  invalid_mode: mapped(400, 'invalid_mode'),
  invalid_number: statusOnly(400),
  invalid_patch: mapped(400, 'invalid_patch'),
  invalid_payload: statusOnly(400),
  invalid_query: mapped(400, 'invalid_query'),
  invalid_rev: mapped(400, 'invalid_rev'),
  invalid_review: mapped(400, 'invalid_review'),
  invalid_rule: mapped(422, 'invalid_rule'),
  invalid_source: statusOnly(400),
  invalid_status: statusOnly(400),
  invalid_tags: mapped(400, 'invalid_tags'),
  invalid_text: mapped(400, 'invalid_text'),
  invalid_txn_file: statusOnly(400),
  invalid_txn_files: statusOnly(400),
  invalid_txn_id: statusOnly(400),
  job_not_found: mapped(404, 'job_not_found'),
  key_mismatch: statusOnly(400),
  legacy_body_empty: statusOnly(400),
  legacy_not_found: statusOnly(404),
  list_failed: statusOnly(400),
  llm_empty: statusOnly(400),
  llm_error: mapped(422, 'llm_error'),
  llm_unavailable: mapped(422, 'llm_unavailable'),
  llm_unparseable: mapped(422, 'llm_unparseable'),
  local_write_failed: statusOnly(400),
  lock_failed: mapped(503, 'lock_failed'),
  manifest_failed: mapped(500, 'manifest_failed'),
  marker_write_failed: statusOnly(400),
  merged_text_missing: statusOnly(400),
  method_not_allowed: mapped(400, 'method_not_allowed'),
  move_failed: statusOnly(400),
  no_json: statusOnly(400),
  no_model: statusOnly(400),
  node_not_found: mapped(404, 'node_not_found'),
  node_snapshot_missing: statusOnly(400),
  not_found: mapped(404, 'not_found'),
  not_imperative: statusOnly(400),
  not_loopback: mapped(403, 'not_loopback'),
  not_object: statusOnly(400),
  not_retired: mapped(409, 'not_retired'),
  not_rule: statusOnly(400),
  number_conflict: statusOnly(409),
  number_exhausted: mapped(422, 'number_exhausted'),
  number_reserved: statusOnly(400),
  number_retired: mapped(409, 'number_retired'),
  outbox_enqueue_failed: statusOnly(400),
  outbox_unavailable: statusOnly(400),
  partial_compile: statusOnly(400),
  payload_too_large: mapped(413, 'payload_too_large'),
  plan_failed: mapped(409, 'plan_failed'),
  plan_hash_mismatch: mapped(409, 'plan_hash_mismatch'),
  plan_stale: mapped(409, 'plan_stale'),
  plan_unavailable: mapped(501, 'plan_unavailable'),
  preference: statusOnly(400),
  privacy: mapped(400, 'privacy'),
  proposal_corrupt: mapped(409, 'proposal_corrupt'),
  proposal_not_found: mapped(404, 'proposal_not_found'),
  proposal_not_pending: mapped(409, 'proposal_not_pending'),
  protected_target: statusOnly(400),
  protocol_mismatch: statusOnly(400),
  reflect_unavailable: mapped(400, 'reflect_unavailable'),
  render_disabled: mapped(403, 'render_disabled'),
  repo_locked: mapped(503, 'repo_locked'),
  response_too_large: statusOnly(413),
  restore_failed: mapped(400, 'restore_failed'),
  restore_unavailable: mapped(501, 'restore_unavailable'),
  retired_shrink: statusOnly(409),
  rev_not_found: mapped(404, 'rev_not_found'),
  rule_locked: mapped(409, 'rule_locked'),
  rule_not_found: mapped(404, 'rule_not_found'),
  rules_disabled: mapped(403, 'rules_disabled'),
  serialize_failed: statusOnly(500),
  snapshot_failed: statusOnly(500),
  snapshot_read_failed: statusOnly(500),
  superseded_by_required: statusOnly(400),
  sync_bridge_unset: mapped(400, 'sync_bridge_unset'),
  sync_disabled: mapped(400, 'sync_disabled'),
  target_not_found: statusOnly(404),
  target_required: statusOnly(400),
  text_too_long: mapped(400, 'text_too_long'),
  timeout: statusOnly(400),
  tombstone_failed: mapped(500, 'tombstone_failed'),
  too_long: statusOnly(400),
  txn_failed: mapped(500, 'txn_failed'),
  unknown_target: statusOnly(400),
  unrecognized_version: statusOnly(400),
  unsupported_media_type: mapped(415, 'unsupported_media_type'),
  vague_word: statusOnly(400),
  write_disabled: mapped(400, 'write_disabled'),
  unprocessable: mapped(422, 'unprocessable'),
  server_error: mapped(500, 'server_error'),
  write_failed: mapped(422, 'write_failed'),
})

/**
 * code -> HTTP 状态；未登记码按 400（参数问题）并由调用方把原码透出，不吞码。
 * @param {string} code
 * @param {number} [fallback]
 * @returns {number}
 */
export function statusOf(code, fallback = 400) {
  const entry = ERROR_TABLE[String(code ?? "")]
  return entry ? entry.status : fallback
}

/**
 * code -> 文案键；未登记/无文案返回 null（客户端显示 `[code]`）。
 * @param {string} code
 * @returns {string|null}
 */
export function localeKeyOf(code) {
  const entry = ERROR_TABLE[String(code ?? "")]
  return entry ? entry.localeKey : null
}

/**
 * 是否已登记（E15 用：代码里引用的错误码必须已登记）。
 * @param {string} code
 * @returns {boolean}
 */
export function isKnownError(code) {
  return Object.prototype.hasOwnProperty.call(ERROR_TABLE, String(code ?? ""))
}
