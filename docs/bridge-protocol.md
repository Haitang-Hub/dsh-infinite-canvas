# 画布桥协议规范（Bridge Protocol）

本协议是 infinite-canvas 与 3d-director-desk 两个项目的**共享资产**：任何格式变更必须
两边同步并递增协议版本号，两侧仓库各保留一份镜像文档。

## 参与方

| 角色 | 说明 |
| ---- | ---- |
| 桥服务（bridge） | canvas-agent 常驻 HTTP 进程（`http://127.0.0.1:17371`），仅监听本机回环 |
| 画布执行器（canvas executor） | 打开画布页的浏览器标签页，经 SSE 执行 `canvas_*` / `site_*` 工具 |
| MCP 进程 | `canvas-agent mcp`（stdio），把 MCP 工具调用 POST 到桥服务 `/api/tools` |
| 插件壳（harness 插件） | spawn 桥进程，用 `GET /health` 探测端口归属与站点状态（见下文） |

> 3d-director-desk 插件（独立项目）有自己的桥（17372）与导演台执行器，协议镜像见其仓库；
> 本桥（17371）不路由 `stage_*` / `camera_*` / `preview_*` 工具，历史 `dv` 版本路由参数
> 随导演台执行器迁往独立插件桥而废弃。

## 协议版本

- `AGENT_PROTOCOL_VERSION`（canvas-agent `src/canvas/session.ts`，当前 **7**）：
  hello 事件携带，画布执行器校验，不匹配即断开。
- 版本策略：不兼容变更必须递增；执行器/桥两侧同步更新。

## 连接

1. **健康探测**：`GET /health`（免 token）→ `{ ok, plugin, site, version, dataDir,
   protocolVersion, hasCanvas, clients, codexBusy, conversation }`，详见下文「健康检查」。
2. **配置发现**：`GET /bootstrap`（免 token）→ `{ ok, url, token }`。
   页面 localStorage 已有 token 时跳过。token 落盘 `~/.infinite-canvas/canvas-agent.json`。
3. **SSE 订阅**：`GET /events?token=&clientId=&role=status`。
   - 缺省（不带 `role`）：画布执行器；首个连接成为活跃工具目标，可传 `clientId` 复用身份。
   - `role=status`：只收事件的旁听连接，不参与工具路由。
4. **hello 事件**：连接建立后服务端下发 `{ ok, protocolVersion, clientId, workspace,
   conversation, codex, pendingApprovals }`。
5. **心跳**：服务端每 15s 下发 `ping` 事件保活；执行器掉线由 SSE 连接关闭检测，
   该连接上未完成的工具请求立即 reject。

## 工具调用链路

1. MCP / HTTP 客户端 → `POST /api/tools` `{ name, input }`（token 鉴权）。
2. 桥校验工具名与 zod schema → 按工具类型分派：
   - SITE_TOOLS（`site_navigate`、`canvas_list_projects`、工作台、素材、生成状态查询等）
     → 画布执行器。
   - 只读快照工具（`canvas_get_state`、`canvas_get_selection`、`canvas_export_snapshot`、
     `shot_list`）→ 桥直接用最近上报的画布快照应答，不下发页面。
   - 其余画布工具经 `buildCanvasToolRequest` 归一为 `canvas_apply_ops` 后下发；
     `canvas_create_attachment_nodes` 由桥把附件换算成图片节点后单独下发。
3. 执行器收到 SSE `tool_call` 事件 `{ requestId, name, input }`，执行后
   `POST /canvas/result?clientId=` `{ requestId, result }` 或 `{ requestId, error }`。
4. 结果只接受来自发起 clientId 的回传；同一执行器的多个请求按到达顺序处理。

## 会话与技能端点（token 鉴权）

- 对话：`/agent/codex/workspace`、`/agent/codex/models`、`/agent/codex/threads`（列表 /
  `new` / `reset` / `:threadId` / `resume` / `delete`）、`/agent/codex/history/ack`、
  `/agent/codex/turn`、`/agent/codex/interrupt`。
- 技能：`/agent/skills`（列表 / `draft` / `:name` / `:name/enabled` / `:name/delete`），
  `/agent/codex/skills` 为同一处理器的别名。
- 静态资源：`/agent/attachments/:attachmentId`、`/agent/message-assets/:messageKey/:assetFile`、
  `/agent/local-image`；本机文件定位 `/agent/local-file/reveal`。

## 健康检查（GET /health）

免 token、免 Origin 校验，返回 session 连接状态与桥自描述信息；插件壳的 probeBridge
只依赖本端点判断"端口上是不是我们的桥、有没有站点"。

| 字段 | 说明 |
| ---- | ---- |
| `ok` | 恒 `true`（能应答即存活） |
| `plugin` | 恒 `"infinite-canvas"`，标识桥的归属 |
| `site` | 是否以插件托管形态伺服站点（`Boolean(CANVAS_SITE_DIR)`） |
| `version` | canvas-agent 版本号（读 bundle 旁 package.json，兜底 `"0.0.0"`） |
| `dataDir` | 站点 Codex 工作空间绝对路径（`ensureSiteWorkspace().workspacePath`） |
| `protocolVersion` | 见「协议版本」 |
| `hasCanvas` | 当前活跃执行器是否已上报画布快照 |
| `clients` | 在线画布执行器数量 |
| `codexBusy` | 是否有 turn 正在执行 |
| `conversation` | 站点级对话状态快照 |

## 快照与状态

- `POST /canvas/state?clientId=`：执行器上报画布快照 `{ projectId, title, nodes,
  connections, selectedNodeIds, viewport, hasCanvas }`（页面端对画布变化 300ms 防抖）。
- `POST /canvas/activate?clientId=`：设为活跃工具目标（focus/visibility 触发）。
- `POST /canvas/result?clientId=`：回传工具执行结果（见「工具调用链路」）。

## 安全边界

- 桥服务只绑 `127.0.0.1`。`/health`、`/config`、`/bootstrap`、MCP streamable-http 门面、
  托管站点静态资源为免 token 本机端点；其余端点均需 token（query `token=` 或
  header `x-canvas-agent-token`），无效 token 返回 401。
- `/bootstrap` 仅接受本机回环 Origin（`127.0.0.1` / `localhost` / `::1`）的零配置发现。
- 若未来允许远程 harness 接入，必须先给免 token 端点加鉴权。

## 可靠性约定

- **执行器离线**：无在线执行器时工具调用直接抛错（"当前没有已连接画布/网页"），
  MCP 层以 `isError` 结果透出；执行器连接关闭时其未完成请求立即 reject。
- **执行超时**：工具下发后统一 30s 超时（"画布操作超时"）。
- **未知路由**：未匹配的 HTTP 路径统一返回 404 `{ ok: false, error: "not found" }`。

## CORS

带 Origin 的请求走白名单：有效 token 的 Origin 自动加入配置白名单；同源请求直接放行
（托管站点的 `<script>/<link>` 会带 Origin）；`/health`、`/config`、`/bootstrap` 不限
Origin（`/bootstrap` 另限回环）。支持 PNA 头
（`Access-Control-Allow-Private-Network: true`）供公网页面访问本机桥。
