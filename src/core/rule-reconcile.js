/**
 * 门面：规则编译/关系判定/守卫/合并提示词的公开 API 唯一出口；只 re-export，不承载业务分支。
 *
 * 依赖方向（单向，无环）：relation/guards/merge-prompt → compile；门面 → 四个子模块。
 * 本文件不认识 DB、不认识 HTTP、不调模型；LLM 调用在 rule-proposal.js。
 */
import {
  VERB_FAMILIES, extractExplicitRef, domainOfText, extractExceptions,
  extractConditionPhrases, modalityOf, splitConditions, verbFamilyOf,
  extractSlots, titleOfRuleDraft, mainClauseIntact, compileStructured,
} from './rule-reconcile/compile.js'
import {
  DUPLICATE_SIMILARITY, SLOT_OVERLAP_MIN, OPPOSITE_FAMILIES, REVERSE_MODALITY,
  objectWords, scopeKeyOf, classifyRelation,
} from './rule-reconcile/relation.js'
import {
  SYNONYM_GROUPS, MODALITY_WORDS, normalizeForGuard, guardVariants, retainsClause,
  guardRewrite, chainPointerOf, resolveChain, chainIssues,
} from './rule-reconcile/guards.js'
import { buildMergePrompt, parseMergeReply } from './rule-reconcile/merge-prompt.js'

// 公开符号原样再导出：路径与导出名保持不变，调用方无需改动。
export {
  VERB_FAMILIES, extractExplicitRef, domainOfText, extractExceptions,
  extractConditionPhrases, modalityOf, splitConditions, verbFamilyOf,
  extractSlots, titleOfRuleDraft, mainClauseIntact, compileStructured,
  DUPLICATE_SIMILARITY, SLOT_OVERLAP_MIN, OPPOSITE_FAMILIES, REVERSE_MODALITY,
  objectWords, scopeKeyOf, classifyRelation,
  SYNONYM_GROUPS, MODALITY_WORDS, normalizeForGuard, guardVariants, retainsClause,
  guardRewrite, chainPointerOf, resolveChain, chainIssues,
  buildMergePrompt, parseMergeReply,
}
