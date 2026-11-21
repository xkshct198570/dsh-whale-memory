/**
 * dsh-whale-memory Host 半（S1 骨架）。
 *
 * 为什么这里只有自证日志：S1 只负责"包能装、行能挂、client 能注册"，
 * 记忆核心与路由按施工计划书 S2 起接线；提前塞半成品会违反"零封存死代码"。
 */
export const inject = []

/** 挂载自证：DSH 重启后 grep 这一行即可确认 Host 半已加载。 */
export function apply(ctx) {
  ctx.effect(() => {
    console.log('[dsh-whale-memory] skeleton armed (S1)')
    return () => console.log('[dsh-whale-memory] skeleton disposed (S1)')
  }, 'whale-memory: skeleton')
}
