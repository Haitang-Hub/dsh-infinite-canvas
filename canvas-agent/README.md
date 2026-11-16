# Infinite Canvas Agent

本地 Canvas Agent 用来连接画布网页和 Harness（或 OpenAI 兼容渠道模型）。本地开发时优先连接 `http://localhost:3000`，不需要先使用线上站点。

它是 infinite-canvas 的内部模块，不单独发布到 npm：构建时由 esbuild 打成单文件 `dist-bundle/index.js`，随 `@haitang-hub/dsh-infinite-canvas` 插件一起分发，插件启动时自动拉起。下面的命令仅用于本仓库开发调试。

## 启动

```bash
cd canvas-agent
npm install
npm run build
node dist/index.js
```

需要排查连接、线程、模型请求或工具调用问题时，可开启 Debug 模式：

```bash
node dist/index.js --debug
```

Debug 日志会以 `[DEBUG][HH:mm:ss]` 等传统格式输出到终端，并按启动日期保存到 `~/.infinite-canvas/logs/canvas-agent-YYYY-MM-DD.log`。终端日志带级别颜色，文件日志为纯文本；日志包含 HTTP、SSE、线程、turn、模型请求和工具调用事件，token 与图片 Data URL 会自动隐藏。

启动后会输出本机地址和 token：

```txt
Local URL: http://127.0.0.1:17371
Connect token: xxxxxx
```

在画布右上角点击 `Agent`，填入地址和 token 后连接。

Canvas Agent 默认只监听 `127.0.0.1`。网页第一次带正确 token 连接后，Canvas Agent 会记录该网页 Origin；之后其他 Origin 不能复用这个本地 Agent，除非用户清理 `~/.infinite-canvas/canvas-agent.json` 里的 `origins`。

## 发布

`canvas-agent` 不单独发布到 npm。版本号只用于内部标识，与仓库根目录 `VERSION`、`@haitang-hub/dsh-infinite-canvas` 的版本彼此独立。

推送到 `full` 后，Release 流水线会执行 `npm run build:bundle`，把 `dist-bundle/`（`index.js`、`agent-instructions.md`、`package.json`）同步进插件包的 `bridge/` 目录，随后随插件包一起发布。

## MCP 服务

桥进程支持两种 MCP 接入方式：

- **stdio**：`node dist/index.js mcp`，供任意支持 MCP 的本地客户端接入；
- **streamable-http**：常驻桥在 `/mcp` 暴露无状态门面，供 Harness 的 `dsh-mcp-client` 直连；只绑定 `127.0.0.1`。

对外只暴露核心工具，控制宿主上下文占用。MCP 协议层使用官方 `@modelcontextprotocol/sdk`，工具入参使用 `zod` 描述。

可用工具：

- `site_navigate`
- `canvas_list_projects`
- `canvas_get_state`
- `canvas_get_selection`
- `canvas_apply_ops`
- `canvas_run_generation`
- `canvas_export_snapshot`

`canvas_apply_ops` 示例：

```json
{
  "ops": [
    {
      "type": "add_node",
      "nodeType": "text",
      "title": "标题",
      "position": { "x": 0, "y": 0 },
      "metadata": { "content": "文本内容" }
    }
  ]
}
```

## 模型接入

面板里的对话由 Canvas Agent 直接调用模型，有两种形态：

- **Harness 中继**：经 DSH 插件的 `/api/infinite-canvas.harness-chat` 代理调用用户在 Harness 里已配置的模型，密钥不出 Harness 进程；
- **渠道模型**：按 OpenAI 兼容协议直连 `baseUrl`，需要在网页「模型配置」里填写 API Key。

两种形态都在桥进程内执行 `canvas_*` 工具，最多连续 10 轮工具调用。面板里的工具执行可选「执行前确认」或「自动执行」，流式回复与工具调用过程会整理成时间线展示。

侧边栏上传或粘贴的图片会先发到本机 Canvas Agent，单次请求体限制 30MB。
