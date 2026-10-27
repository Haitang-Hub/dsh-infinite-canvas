# CHANGELOG（插件版本线）

只记录 `dsh-infinite-canvas` 插件包的版本演进。SPA 产品层面的完整变更史见
[docs/CHANGELOG.md](docs/CHANGELOG.md)（产品版本线，封存快照 tag `v0.21.0-full`，维护于 `full` 分支）。

## 0.2.0（2026-10-28）

+ 插件提根：`main` 分支即插件包本体（`dsh/`、`lib/`、`bridge/`、`site/` 在仓库根），全量源码（`web/`、`canvas-agent/`）在 `full` 分支维护；`bridge/`、`site/` 构建产物随 release 入库，`main` 上 `npm pack` 可直接出包。
+ 托管桥守护：插件服务端入口 `dsh/index.js` 8s 心跳监管桥进程，崩溃自动重建，`POST /api/infinite-canvas.restart-bridge` 手动重启（无需重启 DSH Desktop）；`GET /api/infinite-canvas.bridge-info` 上报 `ready`/`supervised`/`restarts`/`error`。
+ 客户端：`sidebarRightTabs.register()` 注册右侧栏「无限画布」标签，iframe 面板 + 桥未就绪时的恢复引导页。
+ MCP：streamable-http `POST /mcp` 无状态门面注册 `mcp__infinite-canvas__*` 7 工具；`GET /bootstrap` 零配置 token 发现；`CANVAS_SITE_DIR` 站点伺服 + SPA 回退；`CANVAS_AGENT_HOME` 数据目录重定向。
+ `scripts/sync-assets.mjs` 适配双分支布局：`full` 完成源码构建产物同步；`main` 无源码时跳过并给出指引，支持 `CANVAS_PLUGIN_SOURCE_ROOT` 指向 full 检出目录重建。
+ 补 MIT LICENSE 文本（与 package.json 声明一致）；产品变更史移入 `docs/CHANGELOG.md`。

## 0.1.0

+ 首个插件形态包（对齐 `dsh-3d-director-desk` 插件结构，对应产品版本 0.21.0）。
