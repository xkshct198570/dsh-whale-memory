/**
 * 门面：规则仓储公开 API 的唯一出口；只 re-export，不承载业务分支。
 *
 * 依赖方向（单向，无环）：write → git/manifest/parse/paths/io；history → git；lock-txn → git。
 * 本文件不认识 DB、不认识 HTTP、不调模型；镜像在 rule-mirror.js，路由在 rules-routes.js。
 */
import { defaultRuleRoot } from './rule-store/paths.js'
import { atomicWriteFile, durableWriteFile } from './rule-store/io.js'
import {
  RULE_FIELDS, RULE_TYPES, RULE_MODALITIES, RULE_PRIORITIES, RULE_STATUSES,
  RESERVED_NUMBERS, UNNUMBERED_RULE_KEYS, isUnnumberedRule,
  RULE_BODY_MAX, SUMMARY_MAX, RULE_NUMBER_MAX, RULE_FILE_MAX,
  RULE_PATCH_FIELDS, IMMUTABLE_RULE_FIELDS, RULE_STATUS_TRANSITIONS,
  isValidRuleKey, parseRuleDocument, ruleKeyOfFile, readRuleSource,
  serializeRuleDocument, normalizeRuleDoc, validateRule,
  readRule, readRuleLax, listRules,
} from './rule-store/parse.js'
import {
  MANIFEST_FILE, RETIRED_DIR, writeTombstone, readTombstones, isRetiredNumber,
  allocatableRuleNumber, fileRuleNumbers, occupancy, nextRuleNumber,
  computeManifest, regenerateManifest, readManifest,
} from './rule-store/manifest.js'
import {
  HISTORY_KEEP, DIFF_LINE_LIMIT, writeHistorySnapshot, readHistory, readSnapshot,
  diffLines, resolveRevision,
} from './rule-store/history.js'
import {
  RULE_DIRS, GITIGNORE_LINES, requireGitGate, ruleCommitState, commitRuleChanges,
  resetGitIndex, ensureRuleGitignore, isGitRepo, initRuleRepo, gitCommit, gitLog,
  gitShow, ensureRuleRepo,
} from './rule-store/git.js'
import {
  TXN_DIR, LOCK_DIR, REPO_LOCK, REPO_LOCK_STALE_MS, acquireRepoLock, withRepoLock,
  writeTxn, readTxn, clearTxn, listTxns, recoverPendingTxn,
} from './rule-store/lock-txn.js'
import {
  CREATE_DRAFT_FIELDS, CREATE_RULE_TYPES, writeRule, createRule, retireRule,
  reactivateRule, purgeRule, updateRule, revertRule,
} from './rule-store/write.js'

// 公开符号原样再导出：路径与导出名保持不变，调用方无需改动。
export {
  defaultRuleRoot,
  atomicWriteFile, durableWriteFile,
  RULE_FIELDS, RULE_TYPES, RULE_MODALITIES, RULE_PRIORITIES, RULE_STATUSES,
  RESERVED_NUMBERS, UNNUMBERED_RULE_KEYS, isUnnumberedRule,
  RULE_BODY_MAX, SUMMARY_MAX, RULE_NUMBER_MAX, RULE_FILE_MAX,
  RULE_PATCH_FIELDS, IMMUTABLE_RULE_FIELDS, RULE_STATUS_TRANSITIONS,
  isValidRuleKey, parseRuleDocument, ruleKeyOfFile, readRuleSource,
  serializeRuleDocument, normalizeRuleDoc, validateRule,
  readRule, readRuleLax, listRules,
  MANIFEST_FILE, RETIRED_DIR, writeTombstone, readTombstones, isRetiredNumber,
  allocatableRuleNumber, fileRuleNumbers, occupancy, nextRuleNumber,
  computeManifest, regenerateManifest, readManifest,
  HISTORY_KEEP, DIFF_LINE_LIMIT, writeHistorySnapshot, readHistory, readSnapshot,
  diffLines, resolveRevision,
  RULE_DIRS, GITIGNORE_LINES, requireGitGate, ruleCommitState, commitRuleChanges,
  resetGitIndex, ensureRuleGitignore, isGitRepo, initRuleRepo, gitCommit, gitLog,
  gitShow, ensureRuleRepo,
  TXN_DIR, LOCK_DIR, REPO_LOCK, REPO_LOCK_STALE_MS, acquireRepoLock, withRepoLock,
  writeTxn, readTxn, clearTxn, listTxns, recoverPendingTxn,
  CREATE_DRAFT_FIELDS, CREATE_RULE_TYPES, writeRule, createRule, retireRule,
  reactivateRule, purgeRule, updateRule, revertRule,
}
