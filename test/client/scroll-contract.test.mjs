/**
 * 长列表滚动契约（R9-07）：页根单纵向滚动 + 表格只横滚 + 表头 sticky + 抽屉二次滚动受控
 * + 滚动条样式只注入一次 + 键盘与页签位置恢复。
 *
 * 与其余 client 测试同风格：只读 lib/client.js 源码做结构断言，不启动插件、不用 jsdom。
 * 真浏览器五步（1280×800 / 390×844）不在本文件覆盖，必须厂长目视。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const CLIENT = fs.readFileSync(path.join(ROOT, 'lib/client.js'), 'utf8')

function sliceFrom(name, nextMarker) {
  const start = CLIENT.indexOf(name)
  assert.ok(start >= 0, `找不到 ${name}`)
  const end = CLIENT.indexOf(nextMarker, start)
  assert.ok(end > start, `${name} 缺少结束边界 ${nextMarker}`)
  return CLIENT.slice(start, end)
}

const panelCss = () => sliceFrom('      panel: {', '      header: {')
const tableCss = () => sliceFrom('      table: {', '      cellText: {')
const drawerCss = () => sliceFrom('      rulesBody: {', '      rulesHistoryCurrent: {')
const panelSource = () => sliceFrom('    function Panel(props) {', '    // --------------------------------------------------------------- overview')
const rulesView = () => sliceFrom('function RulesView(props) {', 'function RulesGitBar(props) {')
const recallView = () => sliceFrom('function RecallTab(props) {', '    // ----------------------------------------------------------------- writes')
const memoryView = () => sliceFrom('function MemoryTab(props) {', '    function MemoryTable(props) {')
const ruleDrawer = () => sliceFrom('function RuleDrawer(props) {', '// ----------------------------------------------------------------- recall')

test('页根是唯一纵向滚动根：flex 1 1 auto + minHeight 0 + overflowY auto', () => {
  const css = panelCss()
  assert.match(css, /flex: '1 1 auto'/, '页根未取满宿主剩余高度（flex 1 1 auto）')
  assert.match(css, /minHeight: 0/, '页根缺 minHeight:0，flex 子项无法收缩成滚动容器')
  assert.match(css, /overflowY: 'auto'/, '页根未自建纵向滚动')
  assert.doesNotMatch(css, /minHeight: '100%'/, '页根仍是 minHeight:100%（宿主 overflow:hidden 下会被裁）')
  assert.match(css, /scrollbarWidth: 'thin'/, '页根缺细滚动条')
  assert.match(css, /scrollbarColor: 'var\(--dsw-alias-border-l1\) transparent'/, '页根缺主题色滚动条')
})

test('页根声明 data-wm-scroll=page，键盘可聚焦且 role/aria 齐全', () => {
  const props = sliceFrom('    function scrollRegionProps(t) {', '    /**\n     * 抽屉焦点圈')
  assert.match(props, /tabIndex: 0/, '页根不可聚焦，PageDown/Home/End 收不到键')
  assert.match(props, /role: 'region'/, '页根缺 region 语义')
  assert.match(props, /'aria-label': t\('meta.title'\)/, '页根缺 aria-label（复用面板标题）')
  assert.match(props, /'data-wm-scroll': 'page'/, '页根缺纵向滚动标记')
  assert.match(props, /onKeyDown: \(event\) => onScrollRegionKeys\(event\)/, '页根未接键盘滚动')
  const panel = panelSource()
  assert.ok(panel.includes('...scrollRegionProps(t)'), 'Panel 根未应用滚动契约属性')
  assert.ok(panel.includes('ref: panelRef'), 'Panel 根未挂滚动位置 ref')
})

test('纵向滚动容器收敛：只有页根 + 抽屉二次滚动块带 data-wm-scroll', () => {
  const page = CLIENT.match(/'data-wm-scroll': 'page'/g) || []
  const drawer = CLIENT.match(/'data-wm-scroll': 'drawer'/g) || []
  assert.equal(page.length, 1, `页级纵向滚动根必须恰好 1 个，实际 ${page.length}`)
  assert.equal(drawer.length, 2, `抽屉二次滚动块应恰好 2 个（正文+diff），实际 ${drawer.length}`)
  for (const marker of CLIENT.matchAll(/'data-wm-scroll': '([a-z-]+)'/g)) {
    assert.ok(['page', 'drawer'].includes(marker[1]), `未登记的滚动标记 ${marker[1]}`)
  }
})

test('表格容器只横滚：overflowX auto + overflowY clip 且无 maxHeight', () => {
  // Chromium 实测（1280×800）：只写 overflowX:auto 会隐式生成纵向滚动容器，sticky 表头随页根滚走
  // （th 从 2px 跑到 -398px）；加 overflowY:clip 后贴住（+1px）。所以契约必须是 clip，不是"省略"。
  const wrappers = CLIENT.match(
    /style: \{ overflowX: 'auto', overflowY: 'clip', scrollbarWidth: 'thin', scrollbarColor: 'var\(--dsw-alias-border-l1\) transparent' \}/g,
  ) || []
  assert.ok(wrappers.length >= 6, `表格横向滚动容器应覆盖全部表格（当前 ${wrappers.length} 处）`)
  for (const name of ['function RulesTable(props) {', 'function MemoryTable(props) {']) {
    const start = CLIENT.indexOf(name)
    const body = CLIENT.slice(start, start + 1200)
    assert.match(body, /overflowX: 'auto'/, `${name} 缺横向滚动容器`)
    assert.match(body, /overflowY: 'clip'/, `${name} 缺 overflowY:clip（否则表头 sticky 会被页根滚走）`)
    assert.doesNotMatch(body, /overflowY: 'auto'/, `${name} 仍在纵向滚动`)
    assert.doesNotMatch(body, /maxHeight/, `${name} 仍在容器上设高度`)
    assert.ok(body.indexOf("overflowX: 'auto'") < body.indexOf("h('table'"), `${name} 滚动容器必须在表格外层`)
  }
  // 面板内禁用 vh：表格块的 70vh 必须消失（弹层/抽屉除外）。
  assert.doesNotMatch(CLIENT, /70vh/, '表格块的 70vh 仍然存在')
})

test('表格 separate + spacing 0，表头 sticky 且带不透明背景', () => {
  const css = tableCss()
  assert.match(css, /borderCollapse: 'separate'/, 'collapse 下 sticky 表头会丢边框')
  assert.match(css, /borderSpacing: 0/, 'separate 必须配 borderSpacing:0')
  const th = sliceFrom('      th: {', '      td: {')
  assert.match(th, /position: 'sticky'/, '表头未 sticky')
  assert.match(th, /top: 0/, '表头 sticky 未贴顶')
  assert.match(th, /zIndex: 1/, '表头未压住滚过的行')
  assert.match(th, /background: 'var\(--dsw-alias-bg-layer-1\)'/, '表头无背景，滚过内容会透出来')
  assert.match(th, /borderBottom:/, 'separate 下没保留表头下边框')
})

test('抽屉二次滚动受控：320/260 上限 + overscroll-behavior contain', () => {
  const css = drawerCss()
  assert.match(css, /maxHeight: '320px'/, '抽屉正文块缺 320px 上限')
  assert.match(css, /maxHeight: '260px'/, 'diff 块缺 260px 上限')
  assert.equal((css.match(/overscrollBehavior: 'contain'/g) || []).length, 2, '两个内层滚动块都要阻断滚动链')
  assert.equal((css.match(/overflowX: 'auto', overflowY: 'auto'/g) || []).length, 2, '两个内层滚动块都要 overflow:auto 两轴')
  const drawer = ruleDrawer()
  assert.ok(drawer.includes("'data-wm-scroll': 'drawer'"), '抽屉正文块未标记二次滚动')
})

test('滚动条样式只注入一次 ::-webkit-scrollbar{width:8px}', () => {
  assert.equal((CLIENT.match(/::-webkit-scrollbar/g) || []).length, 1, 'webkit 滚动条样式只能注入一处')
  assert.ok(CLIENT.includes("'::-webkit-scrollbar{width:8px}'"), '缺 8px 细滚动条样式')
  const injector = sliceFrom('    function injectScrollbarStyle() {', '    /**\n     * 页根键盘滚动')
  assert.match(injector, /getElementById\(SCROLLBAR_STYLE_ID\)/, '重复装载未按 id 判重，会叠加 <style>')
  assert.match(injector, /style\.id = SCROLLBAR_STYLE_ID/, '注入的 <style> 没有可判重的 id')
  assert.match(injector, /typeof document === 'undefined'/, '无 document 时未静默跳过')
  assert.ok(CLIENT.includes('injectScrollbarStyle()'), '注入函数未接线')
})

test('页根键盘：PageUp/PageDown/Home/End，输入控件不接管', () => {
  const handler = sliceFrom('    function onScrollRegionKeys(event) {', '    /**\n     * 页根滚动契约属性')
  for (const key of ['PageDown', 'PageUp', 'Home', 'End']) {
    assert.ok(handler.includes(`'${key}'`), `缺 ${key} 处理`)
  }
  assert.match(handler, /preventDefault\(\)/, '键盘滚动未阻止默认行为')
  assert.match(handler, /tag === 'input' \|\| tag === 'textarea' \|\| tag === 'select'/, '输入控件里的 Home/End 被劫持')
})

test('切页签恢复 scrollTop（±8px），筛选变化归零', () => {
  const panel = panelSource()
  assert.match(panel, /scrollPos\.current\[tab\] = node\.scrollTop/, '切页签前未保存位置')
  // R9-07 真机修正：恢复改为「pendingRestore + 每次渲染尝试」，因为异步面板首帧高度不足会夹到 0。
  assert.match(panel, /pendingRestore\.current = next === tab \? 0 : \(scrollPos\.current\[next\] \|\| 0\)/, '切页签未置待恢复目标')
  assert.match(panel, /node\.scrollTop = typeof target === 'number' \? target : 0/, '切回页签未恢复位置')
  assert.match(panel, /onScrollReset: resetScroll/, '未把滚动归零回调下发到页签视图')
  assert.ok(panel.includes('onClick: () => switchTab(key)'), '页签按钮未走保存位置的 switchTab')
  for (const [name, view] of [['RulesView', rulesView()], ['RecallTab', recallView()], ['MemoryTab', memoryView()]]) {
    assert.ok(view.includes('onScrollReset'), `${name} 未接收滚动归零回调`)
    assert.match(view, /onScrollReset\(\)|resetPageScroll\(\)/, `${name} 筛选/搜索变化未归零`)
  }
})

test('抽屉 role=dialog + Esc 关闭 + Tab 焦点圈', () => {
  const drawer = ruleDrawer()
  assert.ok(drawer.includes("role: 'dialog'"), '规则抽屉缺 dialog 语义')
  assert.ok(drawer.includes("'aria-modal': 'true'"), '规则抽屉缺 aria-modal')
  assert.ok(drawer.includes('aria-label'), '规则抽屉缺 aria-label')
  assert.ok(drawer.includes("event.key === 'Escape'"), '规则抽屉未接 Esc')
  assert.ok(drawer.includes('trapDialogFocus(event)'), '规则抽屉未接焦点圈')
  const detail = sliceFrom('    function DetailDrawer(props) {', '    function Row(props) {')
  assert.ok(detail.includes("role: 'dialog'"), '记忆详情抽屉缺 dialog 语义')
  assert.ok(detail.includes("event.key === 'Escape'"), '记忆详情抽屉未接 Esc')
  assert.ok(detail.includes('trapDialogFocus(event)'), '记忆详情抽屉未接焦点圈')
})

test('虚拟化只留阈值与判据，不提前引组件', () => {
  const table = sliceFrom('function RulesTable(props) {', 'function RulesTypeBadge(props) {')
  assert.match(table, /> 200/, '缺 >200 行虚拟化阈值注释')
  assert.match(table, /判据/, '缺虚拟化判据')
  assert.ok(table.includes('不做窗口化'), '未写明当前不做虚拟化')
  assert.doesNotMatch(table, /virtual|Virtual/i, '提前引入了虚拟化实现')
})

test('R9-07 真机修正：切回页签时异步面板高度未就绪 → 每次渲染补写 scrollTop，不丢位置', () => {
  const panel = CLIENT.slice(CLIENT.indexOf('function Panel('), CLIENT.indexOf('function Overview('))
  assert.match(panel, /const pendingRestore = useRef\(0\)/, '缺少待恢复目标 ref')
  assert.match(panel, /pendingRestore\.current = next === tab \? 0 :/, '切页签未置恢复目标')
  assert.match(panel, /requestAnimationFrame\(tick\)/, '缺少按帧重试（子组件数据加载不触发父级重渲染）')
  assert.match(panel, /Date\.now\(\) - startedAt > 1500/, '缺少 1.5s 放弃保护，防止无限挂起')
  assert.match(panel, /if \(node\.scrollTop > 0\) \{ pendingRestore\.current = 0; return \}/, '恢复成功后未清目标')
})

test('R9-07 真机修正：页签 sticky 贴页根顶部（滚下去也能直接切，不被迫滚回顶部）', () => {
  const css = CLIENT.slice(CLIENT.indexOf('      tabs: {'), CLIENT.indexOf('      tab: {'))
  assert.match(css, /position: 'sticky'/, '页签未 sticky：滚动后不可达，切页签会丢位置')
  assert.match(css, /top: 0/, '页签 sticky 未贴顶')
  assert.match(css, /background: 'var\(--dsw-alias-bg-layer-1\)'/, '页签无背景，会透出滚过的内容')
})
