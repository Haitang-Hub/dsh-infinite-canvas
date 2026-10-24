# Infinite Canvas（无限画布）

从原 Canvas Director 项目拆分出的独立项目，只保留无限画布核心功能：节点式无限画布 + Codex Agent 驱动的 AI 创作（文生图/节点编排/画布操作），以及画布 Agent 所需的 3D 导演台工具宿主。

## 目录结构

```
infinite-canvas/
├── web/           前端（Vite + React + antd，端口 5070）
│   └── src/pages/
│       ├── canvas/            画布列表页 + 画布编辑页（/ 与 /canvas/:id）
│       └── director/          3D 导演台编辑器（仅作为画布 Agent 的隐藏 iframe 宿主，
│                               路由 /director/editor，不在导航中显示）
├── canvas-agent/  本地 Agent 服务（端口 17371，本地源码，含未发布修复）
├── canvas-proxy/  本地转发代理（端口 23210，解决 AI 供应商 API 的 CORS）
├── start.bat      Windows 一键启动
└── start.ps1      PowerShell 一键启动
```

> 注意：画布页的 Agent 提供 stage/camera/preview 等导演台工具，这些工具通过隐藏
> iframe 承载 `/director/editor` 页面执行，因此导演台编辑器代码保留在本项目中，
> 但导航中不出现导演台入口。纯导演台产品见 `../3d-director-desk`。

## 启动

双击 `start.bat`（或 `powershell -ExecutionPolicy Bypass -File start.ps1`）。
首次运行会自动 `npm install`（web 端使用 `--legacy-peer-deps`，因 antd 6 与
pro-components beta 的 peer 依赖声明冲突），随后启动三个服务：

| 服务 | 端口 | 说明 |
| ---- | ---- | ---- |
| Web  | 5070（被占用时固定回落 5075） | 画布前端（dev server） |
| Agent | 17371 | Codex Agent，画布 AI 能力后端 |
| Proxy | 23210 | AI 供应商 API 转发代理 |

打开 http://localhost:5070 ，在右上角连接 Agent（需要 agent 地址与 token）。

## 本地文件存储

工程数据默认落盘到项目根目录 `data/`（已 gitignore），不再受浏览器 origin 隔离与清库影响：

- `data/kv/`：画布工程等结构化状态（zustand persist 混合存储，磁盘优先）
- `data/media/`：上传/生成的图片视频等媒体文件

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
```

## 后续：DeepSeek Harness 插件化

本项目即为此目标而拆分：画布功能完整收敛在 `web/src/pages/canvas` + 共享层
（`components/agent`、`stores/canvas`、`lib/canvas`、`services`）中，与已删除的
图像/视频/提示词等页面无耦合，便于后续封装为 DeepSeek harness 插件。
