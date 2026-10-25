# Infinite Canvas（无限画布）

从原 Canvas Director 项目拆分出的独立项目：节点式无限画布 + MCP 工具驱动的 AI 创作
（文生图/节点编排/画布操作），以及画布工具所需的 3D 导演台工具宿主。

画布的全部能力以标准 MCP 工具对外暴露（`canvas-agent mcp`，stdio），由 DeepSeek harness
或任意 MCP 客户端驱动；浏览器端实时呈现 AI 执行效果。页面内不再内置聊天面板——对话由
接入的 MCP 客户端（harness）提供。

## 目录结构

```
infinite-canvas/
├── web/           前端（Vite + React + antd，端口 5070）
│   └── src/pages/canvas/      画布列表页 + 画布编辑页（/ 与 /canvas/:id）
├── canvas-agent/  本机画布桥 + MCP 服务（端口 17371；`canvas-agent mcp` 启动 MCP stdio）
├── canvas-proxy/  本地转发代理（端口 23210，解决 AI 供应商 API 的 CORS）
├── start.bat      Windows 一键启动
├── start.ps1      PowerShell 一键启动
└── docs/bridge-protocol.md  桥协议规范（与 3d-director-desk 共享）
```

> 导演台是独立插件：3D 导演台（摆位、运镜、预演导出）已从本项目移除，由独立项目
> `../3d-director-desk` 提供（自带 Web 5080 + 桥 17372 + MCP）。画布中的"导演台节点"
> 保留为链接锚点（metadata.directorDeskId），节点悬浮工具栏的"打开导演台"会在新标签页
> 打开插件应用中对应实例（地址默认 http://127.0.0.1:5080，可在 web/public/config.js 用
> `directorDeskUrl` 覆盖）。harness 同时挂两个插件的 MCP 即可让 AI 完成画布→导演台协作。

## 启动

双击 `start.bat`（或 `powershell -ExecutionPolicy Bypass -File start.ps1`）。
首次运行会自动 `npm install`（web 端使用 `--legacy-peer-deps`，因 antd 6 与
pro-components beta 的 peer 依赖声明冲突），随后启动三个服务：

| 服务 | 端口 | 说明 |
| ---- | ---- | ---- |
| Web | 5070（被占用时固定回落 5075） | 画布前端（dev server），也是 MCP 工具的浏览器执行器 |
| Bridge | 17371 | 画布桥服务：MCP ↔ 浏览器执行器的分发中枢，兼本地文件存储 |
| Proxy | 23210 | AI 供应商 API 转发代理 |

打开 http://localhost:5070 即可使用画布；桥连接零配置（token 经 `GET /bootstrap`
自动发现），顶栏圆点显示桥状态（在线/离线/执行中）。

## 接入 MCP 客户端（DeepSeek harness 等）

```json
{ "mcpServers": {
    "infinite-canvas": {
      "command": "node",
      "args": ["<仓库绝对路径>/canvas-agent/dist/index.js", "mcp"]
    }
}}
```

先 `cd canvas-agent && npm run build` 产出 dist。自检：`node canvas-agent/dist/index.js doctor`
（检查桥在线、执行器在线、data 目录可写、协议版本）。

**重要**：MCP 工具在浏览器页面中执行（"遥控浏览器"模式），调用前必须已打开
http://localhost:5070 并保持页面开启；否则工具返回 `executor_offline` 错误并引导打开页面。

工具分三组：项目管理（`canvas_list_projects` / `site_navigate`）、画布操作
（`canvas_apply_ops` 批量入口 + 各便捷封装 + 读取类工具）、生成（`canvas_run_generation`
+ `generation_get_status` 状态查询）。另有 `shot_*` 镜头编排工具。导演台 `stage_*` /
`camera_*` / `preview_*` 工具由 3d-director-desk 插件的 MCP 提供，不在本项目 MCP 中。

## 本地文件存储

工程数据默认落盘到项目根目录 `data/`（已 gitignore），不再受浏览器 origin 隔离与清库影响：

- `data/kv/`：画布工程等结构化状态（zustand persist 混合存储，磁盘优先）
- `data/media/`：上传/生成的图片视频等媒体文件
- `data/logs/`：桥侧结构化日志（`tool-calls.jsonl` 全量工具调用、`tool-audit.jsonl`
  删除类操作审计），供 harness 排错

存储服务由 canvas-agent（17371）内置的 `/store/*`、`/media/*` 端点提供，页面自动发现、
零配置。服务不在线时自动回退浏览器 IndexedDB，且历史数据会在下次联网时**自动懒迁移**上盘
（读取时发现磁盘缺失 → 从 IndexedDB 上传）。换端口（5070↔5075）、换浏览器、换机器拷贝
`data/` 目录即可找回全部工程。

## 开发

```bash
cd web
npm run dev        # 开发
npm run typecheck  # 类型检查（存在少量上游遗留类型错误，与原项目一致）
npm run build      # 生产构建 → web/dist

cd ../canvas-agent
npm test           # 单元测试
npm run build      # 产出 dist（MCP 入口 dist/index.js mcp）
```

## 后续：headless 模式（阶段三）

工程数据与媒体已落盘 `data/`，headless 前置条件就绪：让桥服务直接以服务端身份读写
`data/`（纯数据操作直写 + 广播刷新；生成走供应商 API 写 `data/media/`），即可在
无人值守场景（定时批量生成、CI 流水线）下使用。详见 `修改方案.md` §5 阶段三。
