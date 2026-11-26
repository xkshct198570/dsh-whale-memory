    // ---------------------------------------------------- 会话收尾卡片 · 设置与动作区（S5 拆分）
    // 职责：会话下拉 / 立即收尾按钮 / 自动收尾与跳过开关；只发回调，不取数、不持状态。
    // 依赖同一 factory 作用域（h/css/t/SectionTitle/Switch）；不读其他页签内部。

    /** 收尾卡设置区：会话选择、立即收尾、自动/跳过开关（原卡头部原样搬迁）。 */
    function WrapControls({ t, sessions, selected, setSelected, busy, enabled, triggerTitle, auto, onTrigger, onToggleAuto, onToggleSkip }) {
      const selectedSession = sessions.find((item) => item.sessionId === selected) || null
      const selectLabel = selectedSession
        ? t('overview.wrapSessionSelected', { turns: String(selectedSession.materialTurns) })
        : t('overview.wrapSessionRecent')
      return h(React.Fragment, null,
        h('div', { style: css.wrapHead },
          h(SectionTitle, null, t('overview.wrapTitle')),
          h('div', { style: css.wrapActions },
            h('label', { style: css.wrapSelectWrap, htmlFor: 'wrap-session-select' },
              h('span', { style: css.statLabel }, t('overview.wrapSessionLabel')),
              h('select', {
                id: 'wrap-session-select',
                style: css.select,
                value: selected,
                disabled: busy || !enabled || sessions.length === 0,
                'aria-label': t('overview.wrapSessionLabel'),
                onChange: (e) => setSelected(e.target.value),
              },
                h('option', { value: '' }, sessions.length === 0 ? t('overview.wrapNoSession') : selectLabel),
                sessions.map((item) => h('option', {
                  key: item.sessionId, value: item.sessionId,
                }, t('overview.wrapSessionOption', {
                  turns: String(item.materialTurns),
                  state: item.open ? t('overview.wrapSessionRunning')
                    : item.skipAuto ? t('overview.wrapSessionSkipped') : String(item.lastRunState || ''),
                }))))),
            h('button', {
              style: enabled && !busy ? css.buttonPrimary : css.buttonDisabled,
              disabled: busy || !enabled,
              title: triggerTitle,
              'aria-label': t('overview.wrapNow'),
              onClick: onTrigger,
            }, busy ? t('overview.wrapBusy') : t('overview.wrapNow')))),
        h('div', { style: css.wrapToggles },
          h('div', { style: css.wrapToggleRow },
            h(Switch, {
              id: 'wrap-auto-switch', checked: Boolean(auto.enabled), onChange: onToggleAuto,
              label: t('overview.wrapAuto'),
            }),
            h('span', { style: css.statLabel },
              t('overview.wrapAutoDesc', { n: String(auto.idleMinutes || 10) }))),
          selectedSession
            ? h('div', { style: css.wrapToggleRow },
              h(Switch, {
                id: 'wrap-skip-switch', checked: Boolean(selectedSession.skipAuto), onChange: onToggleSkip,
                label: t('overview.wrapSkipAuto'),
              }),
              h('span', { style: css.statLabel }, t('overview.wrapSkipAutoDesc')))
            : null),
)
}
