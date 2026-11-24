    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        localeService = ctx.locale
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, dict), 'whale-memory: locale')
        // R9-07 第 5 条：细滚动条 <style> 只注入一次（按 id 判重，重挂/重复装载都不会叠加）。
        ctx.effect(() => { injectScrollbarStyle() }, 'whale-memory: scrollbar-style')
        ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 25,
          locale: NS,
          label: () => t('meta.title'),
        }, PanelIcon)), 'whale-memory: sidebar')
        ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
        }, Panel)), 'whale-memory: panel')
        // 设置页「记忆中枢」分区：复用同一个 SettingsTab，只做入口，不复制开关逻辑。
        ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: PANEL_ID,
          order: 30,
          locale: NS,
          label: () => t('settings.sectionLabel'),
          inject: () => ({ t }),
        }, (ownerProps = {}) => h(SettingsTab, { t: ownerProps.t || t }))), 'whale-memory: settings section')
      },
    }
  },
})
