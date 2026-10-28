# CHANGELOG（插件版本线）

只记录 `dsh-infinite-canvas` 插件包的版本演进。SPA 产品层面的完整变更史见
[docs/CHANGELOG.md](docs/CHANGELOG.md)（产品版本线，封存快照 tag `v0.21.0-full`，维护于 `full` 分支）。

## 0.2.3（2026-10-28）

+ [修复] 独立开发态（vite 5070/5075）AI 助手面板拿不到 token：/bootstrap 对跨源请求一律 403。setCors 现对回环 origin（localhost/127.0.0.1/::1）放行 /bootstrap——本机开发页面零配置发现桥，公网网站 drive-by 探测回环端口仍被拒。

## 0.2.2（2026-10-28）

+ [修复] 面板 iframe 黑屏：桥的 CORS 中间件把带 Origin 的同源请求按 origins 白名单拒绝，而插件托管形态是全新数据目录、白名单为空——HTML 能拿到但 JS/CSS 全部 403，画布永不挂载（浏览器对 `<script type="module" crossorigin>`/CSS 自动带 Origin 头；curl 不带所以此前 curl 验收全绿）。setCors 现对同源请求直接放行，独立运行形态不受影响。经 headless 浏览器复现 → 修复 → 复测：资源 200、root 正常挂载并自动进入画布工程页。

## 0.2.1（2026-10-28）

+ 客户端补 `desktopWorkbenches.register()` 工作台 provider（repository 指向本仓库 GitHub）：插件此前只有 sidebarRightTabs 契约，安装后不会出现在 Desktop「工作台」页；现以标准分栏注册（原生会话在左、画布业务区在右，businessWidth 0.7），首次加载由 reconcileLocalProviders 自动加入工作台页。右侧栏标签入口保留。

## 0.2.0（2026-10-28）

+ 插件提根：`main` 分支即插件包本体（`dsh/`、`lib/`、`bridge/`、`site/` 在仓库根），全量源码（`web/`、`canvas-agent/`）在 `full` 分支维护；`bridge/`、`site/` 构建产物随 release 入库，`main` 上 `npm pack` 可直接出包。
+ 托管桥守护：插件服务端入口 `dsh/index.js` 8s 心跳监管桥进程，崩溃自动重建，`POST /api/infinite-canvas.restart-bridge` 手动重启（无需重启 DSH Desktop）；`GET /api/infinite-canvas.bridge-info` 上报 `ready`/`supervised`/`restarts`/`error`。
+ 客户端：`sidebarRightTabs.register()` 注册右侧栏「无限画布」标签，iframe 面板 + 桥未就绪时的恢复引导页。
+ MCP：streamable-http `POST /mcp` 无状态门面注册 `mcp__infinite-canvas__*` 7 工具；`GET /bootstrap` 零配置 token 发现；`CANVAS_SITE_DIR` 站点伺服 + SPA 回退；`CANVAS_AGENT_HOME` 数据目录重定向。
+ `scripts/sync-assets.mjs` 适配双分支布局：`full` 完成源码构建产物同步；`main` 无源码时跳过并给出指引，支持 `CANVAS_PLUGIN_SOURCE_ROOT` 指向 full 检出目录重建。
+ 补 MIT LICENSE 文本（与 package.json 声明一致）；产品变更史移入 `docs/CHANGELOG.md`。

## 0.1.0

+ 首个插件形态包（对齐 `dsh-3d-director-desk` 插件结构，对应产品版本 0.21.0）。
