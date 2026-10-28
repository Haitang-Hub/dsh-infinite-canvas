# dsh-infinite-canvas（DSH 工作台插件包）

把无限画布接入 DeepSeek Harness（DSH Desktop）的插件包，形态与
`dsh-3d-director-desk` 同构。一个包同时是：

- **npm 包**：`dsh plugin add` 可安装的 `.tgz`；
- **DSH 插件（bundle）**：`cordis.patch.yml` 把服务端入口插入 Harness 插件树；
- **右侧栏面板**：客户端经 `sidebarRightTabs.register()` 注册「无限画布」标签；
- **MCP 工具来源**：patch 里的 `dsh-mcp-client` 条目把桥的 `/mcp` 门面注册为
  `mcp__infinite-canvas__site_navigate / canvas_list_projects / canvas_get_state /
  canvas_get_selection / canvas_apply_ops / canvas_run_generation /
  canvas_export_snapshot` 原生工具（streamable-http，无状态）。

> 本仓库 `main` 分支即插件包本体（插件内容在仓库根）。全量开发版（web/ 前端源码、
> canvas-agent/ 桥源码、一键启动脚本）在 `full` 分支维护，tag `v0.21.0-full` 是
> 全量版封存快照。与 `dsh-3d-director-desk` 并存：两个插件同时在线时，Harness 用不同
> MCP server 名（`infinite-canvas` / `director-desk`）区分调用目标，端口互不冲突
> （17371 / 17372）。

## 架构

```
DSH 会话（模型调用 mcp__infinite-canvas__*）
  ▼
dsh-mcp-client（harness 进程，streamable-http → 127.0.0.1:17371/mcp，持续重连）
  ▼
canvas-agent 桥（esbuild 单文件，由 dsh/index.js spawn 并 8s 心跳监管；
                 数据目录 = dshHomePath('infinite-canvas')，经 CANVAS_AGENT_HOME 注入）
  │ SSE tool_call（/api/tools 同一执行通道，进程内直达 CanvasSession）
  ▼
executor = 面板 iframe 里的画布页面（经 /bootstrap 零配置拿到本机 token，
           use-agent-bridge + agent-site-tools 在浏览器内执行 canvas_* 工具）
```

## 目录

```
├── package.json          # npm 与 dsh.bundle.patch / dsh.client 声明
├── cordis.patch.yml      # 服务端入口条目 + dsh-mcp-client 条目
├── dsh/index.js          # 服务端入口：托管桥（复用/拉起/心跳/手动重启）+ bridge-info
├── lib/client.js         # 客户端单文件（右侧栏标签：工具栏 + 画布 iframe）
├── scripts/sync-assets.mjs  # 打包前同步 bridge/（canvas-agent dist-bundle）与 site/（web/dist）；main 产物分支无源码时跳过并提示
├── bridge/               # esbuild 单文件桥运行时（构建产物，随 release 更新入库）
├── site/                 # 画布前端构建产物（web/dist，随 release 更新入库）
└── docs/bridge-protocol.md  # 桥协议规范（与 3d-director-desk 共享）
```

## 宿主接口

| 接口 | 用途 |
| --- | --- |
| `GET /api/infinite-canvas.bridge-info` | `{ ready, host, port, supervised, restarts, error? }`，面板据此显示 iframe 还是恢复引导 |
| `POST /api/infinite-canvas.restart-bridge` | 杀掉插件托管的桥并重建，不用重启 DSH Desktop |
| `sidebarRightTabs.register({ kind: "infinite-canvas" })` | 右侧栏标签类型 + 「开始」引导页入口 |
| `desktopWorkbenches.register(definition, component)` | 工作台页 provider（标准分栏，repository 解析身份），与右侧栏标签并存 |

## 桥进程（canvas-agent 单文件）

`canvas-agent/scripts/build-bundle.mjs`（见 `full` 分支）用 esbuild 把全部依赖
（express、MCP SDK、zod、winston 等）内联成 `dist-bundle/index.js`，插件包无需携带
node_modules。插件环境变量：

| 变量 | 作用 |
| --- | --- |
| `CANVAS_AGENT_HOME` | 配置与会话线程/技能/日志落点（= dshHomePath('infinite-canvas')）；独立开发态不设，仍用 `~/.infinite-canvas` |
| `CANVAS_SITE_DIR` | 指向打包内 `site/`，桥据此伺服画布站点（静态 + SPA 回退） |
| `PORT` | 监听端口（= Config.port） |

桥新增的插件化端点（独立运行时同样可用）：

- `GET /bootstrap`：零配置下发 `{ url, token }`（回环端点，token 中间件之前）；
- `POST /mcp`：无状态 streamable-http MCP 门面，工具在桥进程内直达 `CanvasSession`；
- 静态站点伺服 + SPA 回退（`CANVAS_SITE_DIR` 存在时启用）。

## 构建与安装

源码构建在 `full` 分支进行（本分支只保留产物）：

```bash
# 0. 切到全量开发版
git checkout full   # （或 git worktree add ../infinite-canvas-full full）

# 1. 构建前端（web/）
cd web && npm install --legacy-peer-deps && npm run build

# 2. 构建单文件桥（canvas-agent/）
cd ../canvas-agent && npm install && npm run build:bundle

# 3. 同步资产并打包（dsh-plugin/）
cd ../dsh-plugin && npm run pack:all   # = sync + npm pack，产出 dsh-infinite-canvas-x.y.z.tgz

# 4. 安装到 DSH Desktop
dsh plugin --profile web add /绝对路径/dsh-infinite-canvas-x.y.z.tgz
# 5. 完整退出并重新打开 Desktop（安装/替换包必须重启才载入新 JS 模块代码）
```

产物更新到本分支：把新生成的 `bridge/`、`site/` 覆盖到仓库根并提交（对齐
`dsh-3d-director-desk` 的 release 流程），`.tgz` 走 GitHub Releases 分发、不入库。
也可在 `main` 上设 `CANVAS_PLUGIN_SOURCE_ROOT=<full 检出目录>` 后 `npm run sync`
直接从 full 检出拉取产物。

改端口时只设一处：`CANVAS_AGENT_PORT=18000`（Harness 进程环境），patch 的 url 与
插件 `Config.port` 同步生效。

## 验收（按工作台规范第 8 节）

1. `npm pack` 后 `tar -tzf dsh-infinite-canvas-x.y.z.tgz` 核对 `package.json`、`dsh/`、
   `lib/`、`bridge/`、`site/`、`cordis.patch.yml`；
2. `dsh --profile web --dump-config` 出现本包两层条目（只证明配置，不代表界面已加载）；
3. Desktop 右侧栏「开始」引导页出现「无限画布」入口，打开后面板显示画布；
4. 原生会话里调用 `mcp__infinite-canvas__canvas_get_state` 全链路跑通（工具经桥下发
   iframe 内执行器）。

## 已知限制

- 端口/包更新需重启 DSH Desktop 才生效；
- 17371 若被独立运行的桥占用，插件会复用它（数据落在 `~/.infinite-canvas`
  而非 dshHomePath，站点能力探测通过即可）；
- iframe 内建 AI 助手（页面直连模型）仍存在，与 Harness 原生会话并存。
