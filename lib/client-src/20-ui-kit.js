    function Card(props) {
      return h('section', { style: css.card }, props.children)
    }

    function SectionTitle(props) {
      return h('div', { style: css.cardTitle }, props.children)
    }

    function Muted(props) {
      return h('div', { style: css.muted }, props.children)
    }

    function Note(props) {
      return h('div', { style: css.note }, props.children)
    }

    function StateBlock(props) {
      const { t, status, err, onRetry, empty } = props
      if (status === 'loading') return h('div', { style: css.muted }, t('state.loading'))
      if (status === 'error') {
        return h('div', { style: css.errorBox },
          h('div', { style: css.error }, errText(t, err)),
          onRetry ? h('button', { style: css.button, onClick: onRetry }, t('common.retry')) : null)
      }
      return h('div', { style: css.tertiary }, empty || t('state.empty'))
    }

    function Kpi(props) {
      return h('div', { style: css.kpi },
        h('div', { style: css.kpiLabel }, props.label),
        h('div', { style: css.kpiValue }, props.value),
        props.sub ? h('div', { style: css.kpiSub }, props.sub) : null)
    }

    function HealthPill(props) {
      const { label, value, tone } = props
      const color = tone === 'error'
        ? 'var(--dsw-alias-state-error-primary)'
        : tone === 'ok'
          ? 'var(--dsw-alias-state-success-primary)'
          : tone === 'warn'
            ? 'var(--dsw-alias-state-warn-primary)'
            : 'var(--dsw-alias-label-tertiary)'
      return h('span', { style: css.pill, title: `${label}: ${value}` },
        h('span', { style: { ...css.dot, background: color } }),
        h('span', { style: css.pillLabel }, label),
        h('span', { style: { ...css.pillValue, color: tone === 'muted' ? 'var(--dsw-alias-label-secondary)' : 'var(--dsw-alias-label-primary)' } }, value))
    }

    function Switch(props) {
      const { checked, onChange, label, id, describedBy, disabled } = props
      return h('label', { style: css.switchRow, htmlFor: id },
        h('input', {
          id, type: 'checkbox', checked: Boolean(checked), disabled: Boolean(disabled),
          style: css.checkbox, 'aria-describedby': describedBy,
          onChange: (e) => onChange(e.target.checked),
        }),
        h('span', { style: css.switchLabel }, label))
    }

    function TextInput(props) {
      const { id, value, onChange, placeholder, describedBy, disabled, type, style } = props
      return h('input', {
        id, style: style ? { ...css.fieldInput, ...style } : css.fieldInput, type: type || 'text',
        value: value === null || value === undefined ? '' : String(value),
        placeholder: placeholder || '', disabled: Boolean(disabled),
        'aria-describedby': describedBy,
        onChange: (e) => onChange(e.target.value),
      })
    }

    function NumberInput(props) {
      const { id, value, min, max, step, onChange, describedBy, disabled, style } = props
      return h('input', {
        id, style: style ? { ...css.numberInput, ...style } : css.numberInput, type: 'number',
        value: value === undefined || value === null ? '' : value,
        min, max, step: step || 1, disabled: Boolean(disabled),
        'aria-describedby': describedBy,
        onChange: (e) => onChange(e.target.value === '' ? '' : Number(e.target.value)),
      })
    }

    function SelectInput(props) {
      const { id, value, options, onChange, describedBy, disabled, style } = props
      return h('select', {
        id, style: style ? { ...css.fieldSelect, ...style } : css.fieldSelect, value, disabled: Boolean(disabled),
        'aria-describedby': describedBy,
        onChange: (e) => onChange(e.target.value),
      }, options.map(([v, l]) => h('option', { key: v, value: v }, l)))
    }

    function TextAreaInput(props) {
      const { id, value, onChange, placeholder, describedBy, disabled, rows, style } = props
      return h('textarea', {
        id, style: style ? { ...css.fieldArea, ...style } : css.fieldArea, rows: rows || 3,
        value: value === null || value === undefined ? '' : String(value),
        placeholder: placeholder || '', disabled: Boolean(disabled),
        'aria-describedby': describedBy,
        onChange: (e) => onChange(e.target.value),
      })
    }

    function TextField(props) {
      const { label } = props
      return h('label', { style: css.field },
        h('span', { style: css.fieldLabel }, label),
        h(TextInput, props))
    }

    function NumField(props) {
      const { label } = props
      return h('label', { style: css.field },
        h('span', { style: css.fieldLabel }, label),
        h(NumberInput, props))
    }

    function SelectField(props) {
      const { label } = props
      return h('label', { style: css.field },
        h('span', { style: css.fieldLabel }, label),
        h(SelectInput, props))
    }

    /** 设置卡公共副行：默认值 + 通用/本机/需配置徽标；依赖不满足时给出原因。 */
    function SettingMetaLine(props) {
      const { defaultValue, badge, depReason, recommend } = props
      if (!defaultValue && !badge && !depReason && !recommend) return null
      return h('div', { style: css.settingMeta },
        defaultValue ? h('span', null, defaultValue) : null,
        badge ? h('span', { style: css.badgeChip }, badge) : null,
        recommend ? h('span', { style: css.recommendChip }, recommend) : null,
        depReason ? h('span', { style: css.metaDep, role: 'note' }, depReason) : null)
    }

    /**
     * 设置项卡片：标签 + 说明小字 + 生效方式徽标 + 默认值 + 依赖；danger 用红框标出不可逆项。
     * 说明文字用 aria-describedby 与控件关联（无障碍）。
     */
    function SwitchCard(props) {
      const {
        id, label, desc, note, effect, danger, checked, onChange,
        disabled, defaultValue, badge, depReason, dependsOn, recommend,
      } = props
      const descId = (desc || note) ? id + '-desc' : undefined
      const locked = Boolean(disabled) || Boolean(depReason)
      return h('div', {
        style: danger ? css.settingCardDanger : (locked ? css.settingCardLocked : css.settingCard),
        'aria-disabled': locked || undefined,
      },
      h('div', { style: css.settingHead },
        h(Switch, { id, label, checked, onChange, disabled: locked, describedBy: descId }),
        effect ? h('span', { style: css.effectBadge, title: effect }, effect) : null),
      (desc || note)
        ? h('div', { id: descId, style: css.fieldDesc }, [desc, note].filter(Boolean).join(' '))
        : null,
      h(SettingMetaLine, { defaultValue, badge, depReason, recommend }))
    }

    /**
     * 字段卡片：children 可以是元素，也可以是 (describedBy) => 元素，保证控件与说明关联。
     */
    function FieldCard(props) {
      const {
        id, label, desc, note, effect, danger, children,
        disabled, defaultValue, badge, depReason, dependsOn, recommend,
      } = props
      const descId = (desc || note) ? id + '-desc' : undefined
      const locked = Boolean(disabled) || Boolean(depReason)
      return h('div', {
        style: danger ? css.settingCardDanger : (locked ? css.settingCardLocked : css.settingCard),
        'aria-disabled': locked || undefined,
      },
      h('label', { style: css.field, htmlFor: id },
        h('div', { style: css.settingHead },
          h('span', { style: css.fieldLabel }, label),
          effect ? h('span', { style: css.effectBadge, title: effect }, effect) : null),
        typeof children === 'function' ? children(descId) : children),
      (desc || note)
        ? h('div', { id: descId, style: css.fieldDesc }, [desc, note].filter(Boolean).join(' '))
        : null,
      h(SettingMetaLine, { defaultValue, badge, depReason, recommend }))
    }

    // ---------------------------------------------------- scroll contract（R9-07）

    /** 细滚动条样式的唯一 id：面板重挂/两插件先后装载都只留一份 <style>。 */
    const SCROLLBAR_STYLE_ID = 'dsh-scroll-contract'

    /**
     * 注入细滚动条宽度（R9-07 第 5 条）。
     * Why 按 id 判重：面板随页签/重挂重渲染，重复 appendChild 会让 <style> 无限增长；
     * 宿主没有 document（服务端/测试）时静默跳过，不阻断装载。
     */
    function injectScrollbarStyle() {
      if (typeof document === 'undefined' || !document || !document.head) return
      if (typeof document.getElementById === 'function' && document.getElementById(SCROLLBAR_STYLE_ID)) return
      const style = document.createElement('style')
      style.id = SCROLLBAR_STYLE_ID
      style.textContent = '::-webkit-scrollbar{width:8px}'
      document.head.appendChild(style)
    }

    /**
     * 页根键盘滚动（R9-07 第 6 条）：PageUp/PageDown 翻一屏，Home/End 到顶/底。
     * Why 自己算：页根是普通 div，浏览器不原生响应这些键；不写自定义 wheel/transform 滚动。
     * 输入控件里的 Home/End 属于光标语义，不接管。
     */
    function onScrollRegionKeys(event) {
      const node = event && event.currentTarget
      if (!node || typeof node.scrollTop !== 'number') return
      const target = event.target || null
      const tag = String((target && target.tagName) || '').toLowerCase()
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || (target && target.isContentEditable)) return
      const screen = Math.max(1, Math.round((node.clientHeight || 0) * 0.9))
      if (event.key === 'PageDown') { node.scrollTop += screen; event.preventDefault() }
      else if (event.key === 'PageUp') { node.scrollTop -= screen; event.preventDefault() }
      else if (event.key === 'Home') { node.scrollTop = 0; event.preventDefault() }
      else if (event.key === 'End') { node.scrollTop = node.scrollHeight; event.preventDefault() }
    }

    /**
     * 页根滚动契约属性（R9-07 第 1/6 条）：`data-wm-scroll` 标记唯一纵向滚动根，
     * 键盘可聚焦 + region 语义；aria-label 复用面板标题，不新增文案键。
     */
    function scrollRegionProps(t) {
      return {
        tabIndex: 0,
        role: 'region',
        'aria-label': t('meta.title'),
        'data-wm-scroll': 'page',
        onKeyDown: (event) => onScrollRegionKeys(event),
      }
    }

    /**
     * 抽屉焦点圈（R9-07 第 6 条「焦点圈」）：Tab 到边界时把焦点拉回另一端。
     * Why 现查现算：面板不用第三方焦点库；抽屉内容随数据重渲染，缓存节点会失效。
     */
    function trapDialogFocus(event) {
      if (!event || event.key !== 'Tab') return
      const root = event.currentTarget
      if (!root || typeof root.querySelectorAll !== 'function') return
      const nodes = root.querySelectorAll(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )
      if (!nodes || nodes.length === 0) return
      const first = nodes[0]
      const last = nodes[nodes.length - 1]
      if (event.shiftKey && event.target === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && event.target === last) { event.preventDefault(); first.focus() }
    }

    // ------------------------------------------------------------------ panel

    function PanelIcon(props) {
      const size = Number(props.size) || 18
      const color = props.active
        ? 'var(--dsw-alias-brand-primary)'
        : 'var(--dsw-alias-label-secondary)'
      return h('span', {
        style: { width: size, height: size, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color },
        'aria-hidden': 'true',
      }, h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
      },
      h('rect', { x: 6, y: 6, width: 12, height: 12, rx: 2 }),
      h('path', { d: 'M9 6V3M15 6V3M9 21v-3M15 21v-3M6 9H3M6 15H3M21 9h-3M21 15h-3' }),
      h('path', { d: 'M9.5 12h5M12 9.5v5' })))
    }

    // ------------------------------------------------------- manual（WP3）

    /** 说明书内联格式：**粗体** / `代码` / [文字](链接)；渲染失败按纯文本走。 */
    function inlineMd(text, prefix) {
      const out = []
      const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g
      let last = 0
      let m
      let seq = 0
      while ((m = re.exec(text))) {
        if (m.index > last) out.push(text.slice(last, m.index))
        const token = m[0]
        const key = prefix + '-i' + seq
        seq += 1
        if (token.startsWith('**')) {
          out.push(h('strong', { key }, token.slice(2, -2)))
        } else if (token.startsWith('`')) {
          out.push(h('code', { key, style: css.mdCode }, token.slice(1, -1)))
        } else {
          const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)
          out.push(h('a', {
            key, href: link[2], target: '_blank', rel: 'noreferrer',
            style: { color: 'var(--dsw-alias-brand-primary)' },
          }, link[1]))
        }
        last = m.index + token.length
      }
      if (last < text.length) out.push(text.slice(last))
      return out
    }

    /**
     * 极简 Markdown 渲染（说明书专用）：标题/列表/表格/段落 + 行内粗体/代码/链接。
     * 刻意不引第三方解析器：client 零构建、离线可读；说明书格式由生成器控制，不需要完整 MD 语义。
     */
    function MiniMarkdown(props) {
      const lines = String(props.source || '').split('\n')
      const nodes = []
      let para = []
      let list = []
      let seq = 0
      const key = (tag) => tag + '-' + (seq += 1)

      const flushPara = () => {
        if (para.length === 0) return
        const text = para.join(' ')
        nodes.push(h('p', { key: key('p'), style: css.mdP }, inlineMd(text, key('p'))))
        para = []
      }
      const flushList = () => {
        if (list.length === 0) return
        nodes.push(h('ul', { key: key('ul'), style: css.mdList },
          list.map((item, index) => h('li', { key: index }, inlineMd(item, key('li'))))))
        list = []
      }
      const flushAll = () => { flushPara(); flushList() }

      let i = 0
      while (i < lines.length) {
        const line = lines[i]
        const trimmed = line.trim()
        if (trimmed === '') { flushAll(); i += 1; continue }

        const heading = /^(#{1,3})\s+(.*)$/.exec(trimmed)
        if (heading) {
          flushAll()
          const style = heading[1].length === 1 ? css.mdH1 : heading[1].length === 2 ? css.mdH2 : css.mdH3
          nodes.push(h('div', { key: key('h'), style }, inlineMd(heading[2], key('h'))))
          i += 1
          continue
        }

        const bullet = /^[-*]\s+(.*)$/.exec(trimmed)
        if (bullet) {
          flushPara()
          list.push(bullet[1])
          i += 1
          continue
        }

        const isTable = trimmed.startsWith('|') && i + 1 < lines.length && /^\|?\s*:?-{3,}/.test(lines[i + 1].trim())
        if (isTable) {
          flushAll()
          const cells = (row) => row.replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim())
          const header = cells(trimmed)
          i += 2
          const rows = []
          while (i < lines.length && lines[i].trim().startsWith('|')) {
            rows.push(cells(lines[i].trim()))
            i += 1
          }
          nodes.push(h('table', { key: key('t'), style: css.mdTable },
            h('thead', null, h('tr', null, header.map((cell, index) => h('th', { key: index, style: css.mdTh }, inlineMd(cell, key('th')))))),
            h('tbody', null, rows.map((row, r) => h('tr', { key: r },
              row.map((cell, c) => h('td', { key: c, style: css.mdTd }, inlineMd(cell, key('td')))))))))
          continue
        }

        para.push(trimmed)
        i += 1
      }
      flushAll()
      return h('div', { style: css.manualBody }, nodes)
    }

    /** 使用说明抽屉：全屏可滚、Esc 关闭、点遮罩关闭；内容离线（生成块）。 */
    function ManualDrawer(props) {
      const { open, onClose, t, locale } = props
      const panelRef = useRef(null)
      useEffect(() => {
        if (!open) return undefined
        if (panelRef.current && typeof panelRef.current.focus === 'function') panelRef.current.focus()
        if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined
        const onKey = (e) => { if (e.key === 'Escape') onClose() }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [open, onClose])
      if (!open) return null
      const lang = String(locale || 'zh').slice(0, 2)
      const doc = MANUAL_DOC[lang] || MANUAL_DOC.zh || ''
      return h('div', { style: css.manualMask, onClick: onClose },
        h('aside', {
          ref: panelRef, tabIndex: -1, role: 'dialog', 'aria-modal': 'true',
          'aria-label': t('manual.title'), style: css.manualPanel,
          onClick: (e) => e.stopPropagation(),
        },
        h('div', { style: css.inline },
          h('div', { style: { ...css.cardTitle, flex: 1 } }, t('manual.title')),
          lang !== 'zh' ? h('span', { style: css.tertiary }, t('manual.zhOnly')) : null,
          h('button', { style: css.button, onClick: onClose }, t('manual.close'))),
        h('div', { style: css.manualScroll }, h(MiniMarkdown, { source: doc }))))
    }

