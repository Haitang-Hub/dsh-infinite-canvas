# 画布桥协议规范（Bridge Protocol）

本协议是 infinite-canvas 与 3d-director-desk 两个项目的**共享资产**：任何格式变更必须
两边同步并递增协议版本号，两侧仓库各保留一份镜像文档。

## 参与方

| 角色 | 说明 |
| ---- | ---- |
| 桥服务（bridge） | canvas-agent 常驻 HTTP 进程（`http://127.0.0.1:17371`），仅监听本机回环 |
| 画布执行器（canvas executor） | 打开画布页的浏览器标签页，执行 `canvas_*` / `site_*` / 工作台工具 |
| 导演台执行器（director executor） | `/director/editor` 页面（画布页隐藏 iframe 或独立标签），执行 `stage_*` / `camera_*` / `preview_*` |
| MCP 进程 | `canvas-agent mcp`（stdio），把 MCP 工具调用 POST 到桥服务 `/api/tools` |

## 协议版本

- `AGENT_PROTOCOL_VERSION`（canvas-agent `src/canvas/session.ts`，当前 **7**）：
  hello 事件携带，画布执行器校验，不匹配即断开。
- 导演台桥实现版本 `dv`（URL 参数，当前 **6**）：桥在多个导演台页面同时连接时优先路由
  到最新版本。
- 版本策略：不兼容变更必须递增；执行器/桥两侧同步更新。

## 连接

1. **配置发现**：`GET /bootstrap`（免 token，本机回环）→ `{ ok, protocolVersion, url, token }`。
   页面 localStorage 已有 token 时跳过。token 同时落盘 `~/.infinite-canvas/canvas-agent.json`
   与 `~/.infinite-canvas/token`。
2. **SSE 订阅**：`GET /events?token=&clientId=&role=canvas|director&dv=&desk=`。
   - `role=canvas`：画布执行器；首个连接成为活跃工具目标。
   - `role=director`：导演台执行器；`/director/ready` 上报就绪后参与路由。
   - `role=status`：只收事件的旁听连接，不参与路由。
3. **hello 事件**：连接建立后服务端下发 `{ ok, protocolVersion, clientId }`。
4. **心跳**：画布执行器每 15s `POST /canvas/heartbeat?clientId=`；超过 45s 无心跳视为
   失联（`executorOnline=false`）。服务端同时每 15s 下发 `ping` 事件保活。

## 工具调用链路

1. MCP / HTTP 客户端 → `POST /api/tools` `{ name, input }`（token 鉴权）。
2. 桥校验工具名与 zod schema → 按工具类型路由：
   - SITE_TOOLS（site_navigate、canvas_list_projects、工作台、素材等）→ 画布执行器
     （无画布在线时回落到就绪的导演台执行器）。
   - DIRECTOR_TOOLS（stage_* / camera_* / preview_*）→ 已就绪的导演台执行器，
     优先 deskId 匹配与最高 `dv` 版本。
   - 其余画布工具经 `buildCanvasToolRequest` 归一为 `canvas_apply_ops` 后下发。
3. 执行器收到 SSE `tool_call` 事件 `{ requestId, name, input }`，执行后
   `POST /canvas/result?clientId=` `{ requestId, result }` 或 `{ requestId, error }`。
4. 结果只接受来自发起 clientId 的回传。

## 可靠性约定

- **执行器离线检测**：工具下发后 3s 内无在线执行器 → 结构化错误
  `{ error: "executor_offline", hint: "请先打开画布页面 http://localhost:5070..." }`。
  MCP 层以 `isError` 结果透出该结构。
- **执行超时**：状态读取类 10s，导出/渲染类（preview_render_frame / preview_export_animatic）300s，
  其余默认 30s；超时返回 `tool_timeout`。
- **FIFO 串行**：同一执行器的多个 tool_call 按到达顺序排队执行，避免画布状态竞态。
- **错误码**：`executor_offline` / `executor_disconnected` / `tool_timeout` /
  `bridge_offline` / `director_not_ready` / `canvas_not_ready` / `unknown_tool`。

## 快照与状态

- `POST /canvas/state?clientId=`：执行器上报画布快照 `{ projectId, title, nodes,
  connections, selectedNodeIds, viewport, hasCanvas }`（画布变化 300ms 防抖）。
- `POST /canvas/activate?clientId=`：设为活跃工具目标（focus/visibility 触发）。

## 安全边界

- 桥服务只绑 `127.0.0.1`。`/store/*`、`/media/*`、`/bootstrap`、`/health`、`/config`
  为免 token 本机端点；其余端点需 token（query `token=` 或 header `x-canvas-agent-token`）。
- 若未来允许远程 harness 接入，必须先给免 token 端点加鉴权。
- 删除类工具/操作记录 `data/logs/tool-audit.jsonl`；全量工具调用记录
  `data/logs/tool-calls.jsonl`（时间、工具、参数摘要、耗时、状态）。

## CORS

带 Origin 的请求走白名单：有效 token 的 Origin 自动加入配置白名单；
`/health`、`/config`、`/bootstrap` 不限 Origin。支持 PNA 头
（`Access-Control-Allow-Private-Network: true`）供公网页面访问本机桥。
