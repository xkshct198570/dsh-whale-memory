    // ---------------------------------------------------- 会话收尾卡片 · 报告视图（S5 拆分）
    // 职责：报告展开按钮/正文/复制下载；只消费 report 状态与回调，不取数、不改状态。
    // 依赖同一 factory 作用域（h/css/t/errText）；无 document 的 SSR/测试环境不渲染动作按钮。

    /** 报告视图：展开按钮 + 正文 + 复制/下载；未开启报告能力时整块返回 null。 */
    function WrapReport({ t, report, available, onToggle }) {
      const canUseReportActions = typeof document !== 'undefined'
      const copyReport = async () => {
        try { await navigator.clipboard.writeText(report.text || '') } catch { /* 浏览器拒绝剪贴板：不静默失败 */ }
      }
      const downloadReport = () => {
        try {
          const blob = new Blob([report.text || ''], { type: 'text/markdown;charset=utf-8' })
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url; a.download = `session-wrap-${report.runId || 'report'}.md`
          a.click()
          setTimeout(() => URL.revokeObjectURL(url), 1000)
        } catch { /* 浏览器不支持 Blob：无动作但按钮存在即说明能力 */ }
      }
      const body = report.open
        ? (report.status === 'loading'
          ? h('div', { style: css.muted }, t('state.loading'))
          : report.status === 'error'
            ? h('div', { style: css.error }, t('overview.wrapReportFailed') + ' — ' + errText(t, report.err))
            : h('div', { style: css.stack },
              h('pre', { style: css.reportBox, 'aria-label': t('overview.wrapShowReport') }, report.text || t('overview.wrapReportEmpty')),
              canUseReportActions
                ? h('div', { style: css.inline },
                  h('button', { style: css.button, onClick: copyReport }, t('overview.wrapCopyReport')),
                  h('button', { style: css.button, onClick: downloadReport }, t('overview.wrapDownloadReport')))
                : null))
        : null
      const toggle = available
        ? h('div', { style: css.inline },
          h('button', { style: css.button, onClick: onToggle, 'aria-expanded': report.open ? 'true' : 'false' },
            report.open ? t('overview.wrapHideReport') : t('overview.wrapShowReport')))
        : null
      if (!toggle && !body) return null
      return h(React.Fragment, null, toggle, body)
    }
