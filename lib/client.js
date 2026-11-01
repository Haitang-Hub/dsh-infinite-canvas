/**
 * dsh-infinite-canvas 客户端入口（可直接加载的单文件模块，无 JSX、无构建依赖）。
 *
 * 形态：DSH **工作台 + 右侧栏面板**双入口。
 *   - 工作台页：desktopWorkbenches.register 以规范 GitHub repository 注册 provider
 *     （Desktop 解析为 haitang-hub/dsh-infinite-canvas，首次自动加入工作台页），
 *     标准分栏：原生会话在左，画布业务区在右（占 70%）；
 *   - 右侧栏：无限画布停靠在一个标签页里，可拖动、可拆分、可全屏，
 *     「开始」引导页也有入口。
 *
 * 扩展面：
 *   ctx.desktopWorkbenches.register(definition, component)  ← 工作台 provider
 *   ctx.sidebarRightTabs.register(definition)   ← 声明标签类型与引导页入口
 *   ctx.slots.register({ name: 'sidebar.right.pane.tab', key: definition.id })  ← 标签正文
 *
 * 画布本体仍是 iframe（React 应用跑在桥自伺服的站点上，页面经 /bootstrap
 * 零配置拿到本机 token 驱动浏览器执行器）；iframe 内部 DOM 不参与宿主拖拽协议。
 */

window.__ModuleLoader__.load({
  id: 'dsh-infinite-canvas',
  factory: (require) => {
    const React = require('react')
    const { useEffect, useState } = React
    const h = React.createElement

    const TAB_ID = 'dsh-infinite-canvas'
    const TAB_KIND = 'infinite-canvas'

    const SHELL_STYLE = {
      display: 'flex',
      flexDirection: 'column',
      width: '100%',
      height: '100%',
      minHeight: 0,
      minWidth: 0,
      overflow: 'hidden',
      background: '#0b0b0d',
    }
    const TOOLBAR_STYLE = {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '4px 10px',
      flex: '0 0 auto',
      fontSize: 12,
      color: 'var(--dsw-alias-label-secondary)',
      borderBottom: '1px solid var(--dsw-alias-border-l2)',
    }
    const IFRAME_STYLE = {
      flex: '1 1 auto',
      width: '100%',
      border: 'none',
      minHeight: 0,
      minWidth: 0,
      background: '#0b0b0d',
    }
    const PLACEHOLDER_STYLE = {
      flex: 1,
      display: 'grid',
      placeItems: 'center',
      color: 'var(--dsw-alias-label-tertiary)',
      padding: 24,
      textAlign: 'center',
      lineHeight: 1.6,
      fontSize: 12,
    }
    const LINK_BUTTON_STYLE = {
      cursor: 'pointer',
      border: '1px solid var(--dsw-alias-border-l3)',
      borderRadius: 6,
      padding: '2px 8px',
      background: 'transparent',
      color: 'inherit',
      fontSize: 12,
    }

    function statusText(info) {
      if (info === undefined) return '连接中…'
      return info.ready ? '画布已连接' : '画布未就绪'
    }

    /** 桥 origin：host 由 bridge-info 下发（默认 127.0.0.1），不要写死。 */
    function bridgeOrigin(info) {
      return `http://${info?.host || '127.0.0.1'}:${info?.port}`
    }

    /** 轮询本地桥状态；失败时降级，并把原因留给占位文案。与服务端 8s 心跳同节奏。 */
    function useBridgeInfo() {
      const [info, setInfo] = useState(undefined)
      useEffect(() => {
        let alive = true
        const load = () => fetch('/api/infinite-canvas.bridge-info')
          .then(response => response.json())
          .then(data => { if (alive) setInfo(data) })
          .catch(() => { if (alive) setInfo({ ready: false, error: 'bridge-info unreachable' }) })
        load()
        const timer = setInterval(load, 8000)
        return () => { alive = false; clearInterval(timer) }
      }, [])
      return info
    }

    /** 右侧栏标签正文：工具栏 + 无限画布。 */
    function InfiniteCanvasTab() {
      const info = useBridgeInfo()
      const [nonce, setNonce] = useState(0)
      const [busy, setBusy] = useState(false)
      const [actionError, setActionError] = useState('')

      // 手动重建桥：宿主端 POST 会杀子进程并重新拉起，随后状态由 5s 轮询刷新。
      const restartBridge = () => {
        setBusy(true)
        setActionError('')
        fetch('/api/infinite-canvas.restart-bridge', { method: 'POST' })
          .then(response => response.json())
          .then(data => {
            if (data && data.ready === false) setActionError(String(data.error || '桥仍未就绪'))
            setNonce(value => value + 1)
          })
          .catch(error => setActionError(String(error?.message ?? error)))
          .finally(() => setBusy(false))
      }

      const openExternal = () => {
        if (info?.port) window.open(`${bridgeOrigin(info)}/`, '_blank', 'noopener')
      }

      return h('div', { style: SHELL_STYLE },
        h('div', { style: TOOLBAR_STYLE },
          h('span', { style: { fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, '无限画布'),
          h('span', { title: info?.error ? String(info.error) : '' }, statusText(info)),
          h('span', { style: { flex: 1 } }),
          h('button', {
            type: 'button',
            style: LINK_BUTTON_STYLE,
            disabled: !info?.ready,
            onClick: openExternal,
            title: '在独立窗口打开画布（面板太窄时更好用）',
          }, '新窗口'),
          h('button', {
            type: 'button',
            style: LINK_BUTTON_STYLE,
            disabled: busy,
            onClick: restartBridge,
            title: '重建本地画布服务（不用重启应用）',
          }, busy ? '重启中…' : '重启服务'),
          h('button', {
            type: 'button',
            style: LINK_BUTTON_STYLE,
            onClick: () => setNonce(value => value + 1),
            title: '重新加载画布（不改工程数据）',
          }, '刷新'),
        ),
        info?.ready
          ? h('iframe', {
            key: nonce,
            src: `${bridgeOrigin(info)}/`,
            title: '无限画布',
            style: IFRAME_STYLE,
            'data-dsh-no-drag': '',
          })
          : h('div', { style: PLACEHOLDER_STYLE },
            h('div', null,
              h('p', { style: { margin: '0 0 6px' } }, '画布服务未就绪。'),
              h('p', { style: { margin: 0 } },
                info?.error ? String(info.error).slice(0, 200) : '正在启动本地服务（首次约几秒）…'),
              h('p', { style: { margin: '6px 0 0' } },
                '插件每 8 秒自动重试一次；也可以点上方「重启服务」立刻重建。'),
              actionError ? h('p', { style: { margin: '6px 0 0', color: '#d25555' } }, actionError) : null,
            ),
          ),
      )
    }

    function apply(ctx) {
      // 1) 标签类型：右侧栏需要一个 kind 才认领这个标签；guide 数组决定「开始」引导页里的入口。
      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: TAB_ID,
        kind: TAB_KIND,
        title: () => '无限画布',
        guide: [{
          order: 30,
          title: () => '无限画布',
          description: () => '节点编排、图像生成与导出，和对话并排使用',
        }],
      }), 'infinite-canvas: sidebar tab type')

      // 2) 标签正文：按定义 id 注册，宿主在打开该 kind 的标签时渲染它。
      ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab',
        key: TAB_ID,
      }, InfiniteCanvasTab))

      // 3) 工作台 provider：Desktop 用 repository 解析 owner/repo 身份并交叉核对安装记录，
      //    reconcileLocalProviders 首次会自动把本工作台加入「工作台」页（added + pinned）。
      ctx.effect(() => ctx.desktopWorkbenches.register({
        title: '无限画布',
        repository: 'https://github.com/Haitang-Hub/dsh-infinite-canvas',
        description: '节点编排、图像生成与导出，和对话并排使用',
        layout: { businessSide: 'right', businessWidth: 0.7 },
      }, InfiniteCanvasTab), 'infinite-canvas: workbench provider')

      // 4) 画布页 → 宿主：悬停 3D 导演台节点时请求打开右侧栏「导演台」标签
      //    （导演台插件注册的 kind 'director-desk'；params.instanceId 交给其标签正文，
      //    由它加载 /director/editor?instanceId=...）。导演台插件缺失时回 ACK 让页面回退独立窗口。
      ctx.effect(() => {
        const onMessage = (event) => {
          const data = event.data
          if (!data || data.source !== 'infinite-canvas-page' || data.type !== 'open-director-desk') return
          const instanceId = typeof data.instanceId === 'string' ? data.instanceId : ''
          if (!instanceId) return
          try {
            ctx.sidebarRight.openTab('director-desk', { params: { instanceId } })
            event.source?.postMessage({ source: 'infinite-canvas-shell', type: 'open-director-desk:ok', instanceId }, '*')
          } catch {
            event.source?.postMessage({ source: 'infinite-canvas-shell', type: 'open-director-desk:missing', instanceId }, '*')
          }
        }
        window.addEventListener('message', onMessage)
        return () => window.removeEventListener('message', onMessage)
      }, 'infinite-canvas: shell open director tab')
    }

    return { apply, inject: ['sidebarRightTabs', 'slots', 'desktopWorkbenches', 'sidebarRight'] }
  },
})
