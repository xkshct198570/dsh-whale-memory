/**
 * dsh-whale-memory Client 半（S1 拆分版）。
 *
 * 五个页签：概览 / 记忆库 / 召回 / 写入与关系 / 设置。
 * 边界：本包只展示与触发"记忆"操作；角色与对话由独立插件提供，本文件不得出现其接口。
 */
window.__ModuleLoader__.load({
  id: 'dsh-whale-memory',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useMemo, useState } = React
    const NS = 'dsh-whale-memory'
    const PANEL_ID = 'whale-memory'
    const API = '/whale-memory/api'
    const TABS = [
      ['overview', '概览'], ['memory', '记忆库'], ['recall', '召回'],
      ['writes', '写入与关系'], ['settings', '设置'],
    ]
    const dict = {
      zh: { meta: { title: '小鲸鱼记忆中枢', description: '长期记忆：节点、召回与审计（只记不扮演）' } },
      en: { meta: { title: 'Whale Memory', description: 'Long-term memory: nodes, recall and audit' } },
    }

    async function getJson(url, opts) {
      const res = await fetch(url, opts)
      const body = await res.json().catch(() => ({}))
      if (!res.ok || body.ok === false) {
        const err = new Error(body.error || `HTTP ${res.status}`)
        err.detail = body
        throw err
      }
      return body
    }

    function Card({ title, children }) {
      return h('section', { style: css.card },
        title ? h('div', { style: css.cardTitle }, title) : null, children)
    }
    function Row({ k, v }) {
      return h('div', { style: css.row }, h('span', { style: css.muted }, k), h('span', null, String(v)))
    }

    function Overview() {
      const [stats, setStats] = useState(null)
      const [err, setErr] = useState('')
      useEffect(() => {
        let alive = true
        getJson(`${API}/stats`).then((b) => { if (alive) setStats(b.stats || null) })
          .catch((e) => { if (alive) setErr(e.message) })
        return () => { alive = false }
      }, [])
      return h(Card, { title: '概览' },
        err ? h('div', { style: css.warn }, `后端未连接：${err}`) : null,
        stats ? h('div', null,
          h(Row, { k: '节点总数', v: stats.totals?.nodes_total ?? stats.nodes_total ?? '-' }),
          h(Row, { k: '活跃节点', v: stats.totals?.nodes_active ?? stats.nodes_active ?? '-' }),
          h(Row, { k: '关系边', v: stats.totals?.edges ?? stats.edges ?? '-' }))
          : h('div', { style: css.muted }, err ? '' : '读取中…'),
        h('div', { style: css.note }, 'S1：只读展示已就绪；本地记忆核心在 S2 接入。'))
    }

    function MemoryTab() {
      const [query, setQuery] = useState('')
      const [hits, setHits] = useState(null)
      const [err, setErr] = useState('')
      async function run() {
        setErr('')
        try {
          const b = await getJson(`${API}/search`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ query, limit: 8 }),
          })
          setHits(b.hits || [])
        } catch (e) { setErr(e.message) }
      }
      let body = null
      if (hits !== null) {
        body = hits.length === 0
          ? h('div', { style: css.muted }, '没有命中')
          : h('ul', { style: css.list }, hits.map((x, i) => h('li', { key: x.id || i, style: css.item },
            h('div', null, String(x.text || '').slice(0, 160)),
            h('div', { style: css.muted }, `${x.level || ''} · ${x.type || ''} · ${Number(x.score || 0).toFixed(3)}`))))
      }
      return h(Card, { title: '记忆库（只读检索）' },
        h('div', { style: css.inline },
          h('input', { style: css.input, value: query, placeholder: '输入关键词…',
            onChange: (e) => setQuery(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter') run() } }),
          h('button', { style: css.btn, onClick: run }, '查')),
        err ? h('div', { style: css.warn }, err) : null,
        body)
    }

    function RecallTab() {
      const [query, setQuery] = useState('')
      const [out, setOut] = useState(null)
      const [err, setErr] = useState('')
      async function run() {
        setErr('')
        try {
          const b = await getJson(`${API}/recall-test`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ query, maxHits: 5 }),
          })
          setOut(b)
        } catch (e) { setErr(e.message) }
      }
      return h(Card, { title: '召回（纯检索测试）' },
        h('div', { style: css.note }, '只调用检索接口，不调用任何生成模型，不写库。'),
        h('div', { style: css.inline },
          h('input', { style: css.input, value: query, placeholder: '输入关键词…',
            onChange: (e) => setQuery(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter') run() } }),
          h('button', { style: css.btn, onClick: run }, '测试')),
        err ? h('div', { style: css.warn }, err) : null,
        out ? h('div', null,
          h('div', { style: css.muted }, `mode=${out.mode} · ${out.count} 条 · ${out.elapsed_ms}ms`),
          h('ul', { style: css.list }, (out.hits || []).map((x, i) => h('li', { key: i, style: css.item },
            String(x.text || '').slice(0, 160))))) : null)
    }

    function WritesTab() {
      return h(Card, { title: '写入与关系' },
        h('div', { style: css.muted }, 'S2–S4：写入队列、决策审计、边类型与演化历史。'))
    }

    function SettingsTab() {
      return h(Card, { title: '设置' },
        h('div', { style: css.note }, '本包只负责记忆的存取与检索；角色与对话由独立插件提供。'),
        h('div', { style: css.muted }, 'S3：按场景分组的开关（接入/身份/注入/写入/反思/向量/关系/同步）。'))
    }

    const VIEWS = { overview: Overview, memory: MemoryTab, recall: RecallTab, writes: WritesTab, settings: SettingsTab }

    function Panel() {
      const [tab, setTab] = useState('overview')
      const View = useMemo(() => VIEWS[tab] || Overview, [tab])
      return h('div', { style: css.panel },
        h('header', { style: css.header },
          h('div', { style: css.title }, '小鲸鱼记忆中枢'),
          h('div', { style: css.muted }, '长期记忆：只记不扮演')),
        h('nav', { style: css.tabs }, TABS.map(([key, label]) => h('button', {
          key, style: key === tab ? css.tabActive : css.tab, onClick: () => setTab(key),
        }, label))),
        h('main', { style: css.main }, h(View)))
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
        }, Panel)), 'whale-memory: panel')
      },
    }
  },
})

const css = {
  panel: { padding: '16px', color: 'var(--dsw-alias-label-primary)', display: 'flex', flexDirection: 'column', gap: '12px' },
  header: { display: 'flex', flexDirection: 'column', gap: '2px' },
  title: { fontSize: '16px', fontWeight: 600 },
  muted: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px' },
  note: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', lineHeight: 1.5 },
  warn: { color: 'var(--dsw-alias-state-warn-primary)', fontSize: '12px' },
  tabs: { display: 'flex', gap: '4px', flexWrap: 'wrap', borderBottom: '1px solid var(--dsw-alias-border-l1)', paddingBottom: '8px' },
  tab: { background: 'transparent', border: 'none', color: 'var(--dsw-alias-label-secondary)', padding: '4px 8px', cursor: 'pointer' },
  tabActive: { background: 'var(--dsw-alias-bg-layer-1)', border: 'none', color: 'var(--dsw-alias-label-primary)', borderRadius: '6px', padding: '4px 8px', cursor: 'pointer' },
  main: { display: 'flex', flexDirection: 'column', gap: '10px' },
  card: { background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '10px', padding: '12px', display: 'flex', flexDirection: 'column', gap: '8px' },
  cardTitle: { fontSize: '13px', fontWeight: 600 },
  row: { display: 'flex', justifyContent: 'space-between', gap: '12px', fontSize: '13px' },
  inline: { display: 'flex', gap: '8px' },
  input: { flex: 1, background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '6px', padding: '6px 8px' },
  btn: { background: 'var(--dsw-alias-brand-primary)', color: 'var(--dsw-alias-label-on-color)', border: 'none', borderRadius: '6px', padding: '6px 12px', cursor: 'pointer' },
  list: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '6px' },
  item: { borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: '6px', fontSize: '12px', lineHeight: 1.5 },
}
