// 职责：把采集缓冲的会话记录投影成面板会话列表（无正文/标题/路径）；依赖：零 import。
//
// 为什么单独一片：会话列表要跨 host 边界给面板用，字段白名单必须集中钉死，
// 防止后续顺手把 rec.groups（原文）或 header.cwd（路径）带出去（架构书 §5.1/§7）。

/**
 * 单条会话的只读投影。
 *
 * @param {{id:string, lastActivity:number, groups?:unknown[], openTurns?:Set<unknown>, turn?:number,
 *   pendingIntent?:object|null, lastTriggeredAt?:number, lastTriggeredHash?:string}} rec 采集记录
 * @returns {{sessionId:string,lastActivity:number,materialTurns:number,open:boolean,turn:number,
 *   pendingIntent:boolean,lastTriggeredAt:number,hasMaterial:boolean}}
 *   materialTurns=可收尾轮数（整轮计数）；open=是否有进行中的回合；不含任何正文/标题/cwd。
 */
export function projectSession(rec) {
  const groups = Array.isArray(rec?.groups) ? rec.groups : []
  return {
    sessionId: String(rec?.id || ''),
    lastActivity: Number(rec?.lastActivity || 0),
    materialTurns: groups.length,
    open: Boolean(rec?.openTurns && rec.openTurns.size > 0),
    turn: Number(rec?.turn || 0),
    pendingIntent: Boolean(rec?.pendingIntent),
    lastTriggeredAt: Number(rec?.lastTriggeredAt || 0),
    hasMaterial: groups.length > 0,
  }
}

/**
 * 会话列表（按最后活动倒序）。
 * @param {Iterable<object>} records 采集记录
 * @returns {Array<ReturnType<typeof projectSession>>}
 */
export function projectSessions(records) {
  const list = []
  try {
    for (const rec of records || []) list.push(projectSession(rec))
  } catch { /* 迭代器异常：返回已收集部分（面板可再刷新） */ }
  return list.sort((a, b) => b.lastActivity - a.lastActivity)
}
