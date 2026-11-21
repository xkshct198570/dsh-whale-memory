/**
 * dsh-whale-memory Client 半（S1 骨架）。
 *
 * 只注册左栏图标 + 空面板，证明 slot id / main key / locale NS 三处同源；
 * 业务页签与开关在 S3 落地（见施工计划书 §7）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-whale-memory',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'dsh-whale-memory'
    const PANEL_ID = 'whale-memory'
    const dict = {
      zh: { meta: { title: '小鲸鱼记忆中枢', description: '本地长期记忆：节点、召回与审计' },
            panel: { skeleton: 'S1 骨架：面板与开关在 S3 落地' } },
      en: { meta: { title: 'Whale Memory', description: 'Local long-term memory: nodes, recall and audit' },
            panel: { skeleton: 'S1 skeleton: panel and switches land in S3' } },
    }
    function Panel(props) {
      const t = props.t
      return h('div', { style: { padding: '16px', color: 'var(--dsw-alias-label-primary)' } },
        h('div', null, String(t('panel.skeleton'))))
    }
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, dict), 'whale-memory: locale')
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: PANEL_ID, order: 25,
          label: () => t('meta.title'), locale: NS,
        }, () => h('span', { title: String(t('meta.description')) }, '🐋'))), 'whale-memory: sidebar')
        ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: PANEL_ID, locale: NS,
        }, (props) => h(Panel, { ...props, t }))), 'whale-memory: panel')
      },
    }
  },
})
