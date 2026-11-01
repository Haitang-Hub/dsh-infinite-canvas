# 插件壳同步清单（dsh-infinite-canvas ↔ dsh-3d-director-desk）

两个插件的壳代码是**刻意同构的双份实现**（与桥协议"同源设计、双份实现"同一哲学：
不共享运行时依赖，但逻辑必须逐行对齐）。本文件定义哪些文件属于"壳"、改动后如何同步、
如何校验。

## 壳文件清单

| 文件 | 性质 | 共享逻辑 |
|---|---|---|
| `dsh/index.js` | 服务端入口，两边 ~250 行同构 | `scrubbedEnv` / `waitForHealth` / `probeBridge` / `ensureOnce`+`ensureBridge`（restartPending 补偿）/ `spawnBridge` / 心跳与两个 fetch 路由 |
| `lib/client.js` | 客户端面板，两边同构骨架 | `statusText` / `bridgeOrigin` / `useBridgeInfo` / `restartBridge` / 工具栏与占位文案结构 |
| `cordis.patch.yml` | 插件树插入项 | mcp 条目的 `toolCallTimeoutMs` / `reconnect` 参数与端口单一事实来源约定 |

两边**预期内**的差异（归一化后仍会出现的，属插件特有功能，不算漂移）：

- 画布侧：工作台 provider（`desktopWorkbenches.register`）、"画布页→宿主打开导演台标签"
  的 postMessage 监听、`agent-instructions` 相关注释；
- 导演台侧：`useTabInfo` 的 `instanceId` 导航参数（画布经 openTab 打开时用）、
  React 19 + three.js 相关注释。

## 改动后的同步流程

1. 在其中一个仓库改共享逻辑（探测判据、守护、重启、轮询节奏等）；
2. 把同样的语义改到另一仓库对应文件（插件特有 token 用下表映射）；
3. 两边运行校验：
   `node scripts/check-shell-parity.mjs <兄弟仓库>/dsh-plugin`
   归一化 diff 里出现的每一处差异，要么能归入上面"预期内差异"，要么就是漏改；
4. 两边各自 bump `package.json` 的 `version` 并补 CHANGELOG。

## 插件差异映射表（校验脚本内置同样规则）

| infinite-canvas | 3d-director-desk |
|---|---|
| `dsh-infinite-canvas` / `infinite-canvas` | `dsh-3d-director-desk` / `director-desk` |
| 端口 `17371`、env `CANVAS_AGENT_PORT` | 端口 `17372`、env `DIRECTOR_DESK_PORT` |
| `CANVAS_SITE_DIR` | `DIRECTOR_SITE_DIR` |
| `CANVAS_AGENT_HOME` | `DIRECTOR_STORE_DIR` |
| `PORT` | `STORE_PORT` |
| `canvas-agent` | `director-mcp` |
| 文案"画布" | 文案"导演台" |
| `dshHomePath('infinite-canvas')` | `dshHomePath('3d-director-desk')` |

## 版本与发版纪律

- 插件版本以 **full 分支 `dsh-plugin/package.json`** 为唯一权威；canvas 走 0.2.x 线，
  director 走 0.3.x 线（2026-10-31 起 main 与 full 统一到各自线上的最新版本）。
- 发版顺序固定：**full 上改源码 → build → `npm run pack:all` → 验证 → 把
  `bridge/`、`site/` 与壳文件提根覆盖到 main 并提交**。绝不在 main 上直接改壳
  （main 版本号高但功能旧的分叉就是这么来的）。
- 桥内部版本（canvas-agent package.json / director SERVER_VERSION）不随插件版本递增，
  只在桥协议或行为变更时各自递增，并通过 `/health` 的 `version` 字段暴露。
