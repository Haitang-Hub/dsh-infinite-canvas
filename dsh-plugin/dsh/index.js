/**
 * dsh-infinite-canvas 服务端入口（Cordis 插件，运行于 Harness 进程）。
 *
 * 职责（与 dsh-3d-director-desk 0.2.3 同构）：
 *   1. 托管本地桥（canvas-agent，127.0.0.1:17371）：能复用就复用，不能就自己拉起；
 *      8 秒心跳复查，桥掉线自动重建；
 *   2. 暴露 GET /api/infinite-canvas.bridge-info，面板据此显示画布或恢复引导；
 *   3. 暴露 POST /api/infinite-canvas.restart-bridge，让用户在面板上手动重建服务；
 *   4. 对端口占用者做能力探测：优先读 /health 自报的 plugin/site 字段（0.2.6+ 桥），
 *      旧版桥回退 `GET /` 含 `id="root"` 的 HTML 判据；并区分「开发态桥占用」与无关进程。
 *
 * 工具注册不在本入口：cordis.patch.yml 里的 dsh-mcp-client 条目把桥的 /mcp 门面
 * 注册为 mcp__infinite-canvas__* 原生工具（streamable-http）。
 */

import { spawn } from 'node:child_process'
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import Schema from '@deepseek-ai/schemastery'
import { projectSwitches, readSharedSettings, sharedSettingsPath, updateSharedSettings } from './shared-settings.js'

export const name = 'dsh-infinite-canvas'
export const inject = ['connection']

/** 心跳间隔：桥掉线后最多 8 秒面板就能看到状态翻转并自动重建。 */
const HEARTBEAT_MS = 8000

/**
 * 端口单一事实来源：本插件的 Config.port 与 cordis.patch.yml 里 mcp 条目的 url
 * 共用 CANVAS_AGENT_PORT。改端口只改这一处。
 */
const DEFAULT_PORT = Number(process.env.CANVAS_AGENT_PORT ?? 17371)

export const Config = Schema.object({
  root: Schema.string().required().description('桥的数据目录（dshHomePath），存放会话线程、技能与配置'),
  port: Schema.number().default(DEFAULT_PORT).description('桥监听端口，仅本机回环；与 cordis.patch.yml 的 mcp url 共用 CANVAS_AGENT_PORT'),
  host: Schema.string().default('127.0.0.1').description('桥绑定地址，保持回环；canvas-agent 仅监听此地址'),
  spawn: Schema.boolean().default(true).description('插件是否托管桥进程；false 时只复用外部已启动的桥'),
  startupTimeoutMs: Schema.number().default(15000).description('等待桥 /health 就绪的超时'),
})

/** 与 dsh-mcp-client 同口径的环境清洗：去掉密钥类与 DSH_* 变量，避免把宿主侧敏感配置带给子进程。 */
function scrubbedEnv() {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (/KEY|PASSWORD|SECRET|TOKEN/i.test(key) || key.startsWith('DSH_')) delete env[key]
  }
  // 宿主可能运行在 Electron utility process 中；此时 execPath 是 Electron，
  // 需要以 Node 模式执行桥脚本（与 dsh-image-generation 的子进程做法一致）。
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1'
  return env
}

async function waitForHealth(url, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs
  let lastError = 'no response'
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('workbench disposed while waiting for bridge')
    try {
      // 单次尝试必须带超时：对端挂起（如 Windows 控制台 QuickEdit 冻结桥进程）时，
      // 无超时的 fetch 会阻塞整个插件加载。
      const response = await fetch(url, { signal: signal ?? AbortSignal.timeout(2000) })
      if (response.ok) {
        const body = await response.json().catch(() => null)
        if (body?.ok) return body
        lastError = `health payload not ok: ${JSON.stringify(body)?.slice(0, 200)}`
      } else {
        lastError = `health HTTP ${response.status}`
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await delay(250)
  }
  throw new Error(`bridge not healthy at ${url} within ${timeoutMs}ms: ${lastError}`)
}

/**
 * 探测端口上既有的 HTTP 服务：健康 + 站点能力。
 * `listening=true` 表示端口已被占用（哪怕对面不是我们的桥），调用方据此决定复用还是报错，
 * 而不是盲目 spawn 撞 EADDRINUSE。
 * 判据优先级：/health 自报 plugin/site（新版桥）→ 回退 GET / 含 id="root" 的 HTML（旧版桥）。
 * devBridge=true 表示端口上是自家开发态桥（健康但没伺服站点），文案要与无关进程区分开。
 */
async function probeBridge(baseUrl) {
  let health
  try {
    health = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) })
  } catch (error) {
    return { ok: false, listening: false, reason: `不可连接：${error instanceof Error ? error.message : String(error)}` }
  }
  const payload = await health.json().catch(() => null)
  if (!health.ok || !payload?.ok) {
    return { ok: false, listening: true, reason: `health 异常：HTTP ${health.status}` }
  }
  if (payload.plugin) {
    if (payload.plugin !== 'infinite-canvas') {
      return { ok: false, listening: true, reason: `health 自报 plugin=${payload.plugin}，不是本插件桥` }
    }
    if (payload.site === false) {
      return { ok: false, listening: true, devBridge: true, reason: '画布桥健康但未伺服站点（开发态启动，未设 CANVAS_SITE_DIR）' }
    }
    return { ok: true, listening: true }
  }
  try {
    const site = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(2000) })
    const type = site.headers.get('content-type') || ''
    const html = type.includes('text/html') ? await site.text() : ''
    if (!site.ok || !html.includes('id="root"')) {
      return { ok: false, listening: true, reason: `站点不可用（HTTP ${site.status}，content-type=${type || 'none'}）` }
    }
    return { ok: true, listening: true }
  } catch (error) {
    return { ok: false, listening: true, reason: `站点探测失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * Harness 模型接入：插件内 Agent（画布渠道模型引擎）复用 harness 用户配置的模型。
 *
 * 两个端点（面板经 lib/client.js 的 postMessage 代理访问，见该文件）：
 *   GET  /api/infinite-canvas.harness-models  列出宿主 llm 服务已注册的 provider/模型
 *   POST /api/infinite-canvas.harness-chat    代发一次对话（OpenAI 形态入参），返回文本 + 工具调用
 *
 * 红线：provider 的 API key 只由宿主 adapter 在进程内解析，本插件与 iframe/桥都拿不到密钥。
 * llm 服务用 ctx.get 探测而非 inject——模型路由是辅助能力，宿主缺失/旧版本时插件主体
 * （桥托管）必须照常激活，端点返回 503 由面板降级提示。
 */

/** 单次请求的消息数/体量上限，防误循环把宿主日志与内存打爆。 */
const HARNESS_CHAT_MAX_MESSAGES = 500
const HARNESS_CHAT_MAX_CHARS = 2_000_000
/** 与渠道引擎一致的整体超时；生成类工具耗时由调用方轮询，不占模型请求。 */
const HARNESS_CHAT_TIMEOUT_MS = 600_000

/** 把插件 Agent 的 OpenAI 形态消息历史转成宿主 GenerateOptions 入参。 */
function toHarnessRequest(entries, provider, model) {
  const system = []
  const messages = []
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== 'object') continue
    if (entry.role === 'system') {
      if (typeof entry.content === 'string' && entry.content.trim()) system.push(entry.content)
      continue
    }
    const id = randomUUID()
    if (entry.role === 'user') {
      let content
      if (typeof entry.content === 'string') {
        content = entry.content.trim() ? [{ type: 'text', text: entry.content }] : []
      } else if (Array.isArray(entry.content)) {
        content = []
        for (const part of entry.content) {
          if (part?.type === 'text' && typeof part.text === 'string') {
            if (part.text.trim()) content.push({ type: 'text', text: part.text })
          } else if (part?.type === 'image_url') {
            throw new Error('Harness 模型暂不支持图片消息，请改用自配渠道的 vision 模型')
          }
        }
      } else {
        content = []
      }
      if (!content.length) content.push({ type: 'text', text: '(empty)' })
      messages.push({ id, role: 'user', content, source: { kind: 'user' } })
      continue
    }
    if (entry.role === 'assistant') {
      const content = []
      if (typeof entry.content === 'string' && entry.content.trim()) content.push({ type: 'text', text: entry.content })
      for (const call of Array.isArray(entry.tool_calls) ? entry.tool_calls : []) {
        content.push({
          type: 'tool-call',
          id: String(call?.id || randomUUID()),
          name: String(call?.function?.name || ''),
          arguments: String(call?.function?.arguments || '{}'),
        })
      }
      messages.push({ id, role: 'assistant', content, source: { kind: 'model', provider, model } })
      continue
    }
    if (entry.role === 'tool') {
      const callId = String(entry.tool_call_id || '')
      messages.push({
        id,
        role: 'tool',
        toolCallId: callId,
        content: [{ type: 'text', text: String(entry.content ?? '') }],
        source: { kind: 'tool', callId },
      })
    }
  }
  return { system: system.join('\n\n'), messages }
}

/**
 * 折叠一次 ctx.llm.stream() 的 StreamChunk 流为最终文本 + 工具调用。
 * block-end 携带的 block 为权威结果；流被截断时回退到 partial 组装。
 */
async function foldHarnessStream(stream) {
  const partials = new Map()
  const finals = new Map()
  let usage
  let finish
  for await (const chunk of stream) {
    if (!chunk || typeof chunk !== 'object') continue
    if (chunk.type === 'block-start') {
      partials.set(chunk.index, chunk.blockType === 'tool-call' ? { id: '', name: '', arguments: '' } : { text: '' })
    } else if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
      const partial = partials.get(chunk.index)
      if (partial && 'text' in partial) partial.text += String(chunk.text || '')
    } else if (chunk.type === 'tool-call-delta') {
      const partial = partials.get(chunk.index)
      if (partial) {
        if (chunk.id) partial.id = String(chunk.id)
        if (chunk.name) partial.name = String(chunk.name)
        partial.arguments += String(chunk.argumentsDelta || '')
      }
    } else if (chunk.type === 'block-end') {
      finals.set(chunk.index, chunk.block)
      partials.delete(chunk.index)
    } else if (chunk.type === 'usage') {
      usage = chunk.usage
    } else if (chunk.type === 'finish') {
      finish = chunk.reason
    }
  }
  if (finish && (finish.kind === 'error' || finish.kind === 'aborted')) {
    const failure = finish.failure || {}
    throw new Error(failure.message || `模型请求失败（${finish.kind}）`)
  }
  const lastIndex = Math.max(0, ...finals.keys(), ...partials.keys())
  const blocks = []
  for (let index = 0; index <= lastIndex; index += 1) {
    if (finals.has(index)) {
      blocks.push(finals.get(index))
      continue
    }
    const partial = partials.get(index)
    if (!partial) continue
    blocks.push('name' in partial
      ? { type: 'tool-call', id: partial.id, name: partial.name, arguments: partial.arguments }
      : { type: 'text', text: partial.text })
  }
  const content = blocks.filter((block) => block.type === 'text').map((block) => block.text).join('')
  const toolCalls = blocks
    .filter((block) => block.type === 'tool-call' && block.name)
    .map((block) => ({ id: block.id, name: block.name, arguments: block.arguments || '{}' }))
  return { content, toolCalls, usage }
}

/**
 * Harness 模型调用的两个核心载荷（模型列表 / 代发对话），两处共用：
 *   1. 宿主连接 fetch 路由（/api/infinite-canvas.harness-*，面板 iframe 同源访问）；
 *   2. 本插件自起的回环 HTTP 中继（canvas-agent 桥进程直连）。
 * 桌面端 shell 的 window.location.origin 是 dsh-app:// 自定义协议，桥进程的 node
 * fetch 无法访问；中继让桥经 http://127.0.0.1:<随机端口>/h/<token>/api/... 调到
 * 本进程内的 llm 服务（密钥不出 harness 进程）。
 */
function createHarnessHandlers(ctx) {
  const llm = typeof ctx.get === 'function' ? ctx.get('llm') : undefined
  const available = () => llm && typeof llm.listProviders === 'function' && typeof llm.listModels === 'function' && typeof llm.stream === 'function'

  async function modelsPayload() {
    if (!available()) {
      return { status: 503, body: { ok: false, error: '宿主 llm 服务不可用（需要 DeepSeek Harness 0.2）' } }
    }
    try {
      const groups = []
      for (const provider of llm.listProviders()) {
        const models = await llm.listModels(provider.id)
        groups.push({
          provider: provider.id,
          providerName: provider.name || provider.id,
          models: models.map((model) => ({
            id: model.id,
            name: model.name || model.id,
            description: typeof model.description === 'string' ? model.description : '',
          })),
        })
      }
      return { status: 200, body: { ok: true, groups } }
    } catch (error) {
      return { status: 500, body: { ok: false, error: error instanceof Error ? error.message : String(error) } }
    }
  }

  async function chatPayload(body) {
    if (!available()) {
      return { status: 503, body: { ok: false, error: '宿主 llm 服务不可用（需要 DeepSeek Harness 0.2）' } }
    }
    const provider = String(body?.provider || '').trim()
    const model = String(body?.model || '').trim()
    if (!provider || !model) return { status: 400, body: { ok: false, error: '缺少 provider/model' } }
    if (!llm.listProviders().some((entry) => entry.id === provider)) {
      return { status: 400, body: { ok: false, error: `provider ${provider} 未在宿主注册` } }
    }
    const entries = Array.isArray(body?.messages) ? body.messages : []
    if (entries.length > HARNESS_CHAT_MAX_MESSAGES) {
      return { status: 413, body: { ok: false, error: `消息过多（>${HARNESS_CHAT_MAX_MESSAGES}）` } }
    }
    if (JSON.stringify(entries).length > HARNESS_CHAT_MAX_CHARS) {
      return { status: 413, body: { ok: false, error: '消息体过大' } }
    }
    let requestInput
    try {
      requestInput = toHarnessRequest(entries, provider, model)
    } catch (error) {
      return { status: 400, body: { ok: false, error: error instanceof Error ? error.message : String(error) } }
    }
    const tools = (Array.isArray(body?.tools) ? body.tools : [])
      .map((tool) => tool?.function)
      .filter((fn) => fn && typeof fn.name === 'string')
      .map((fn) => ({ name: fn.name, description: String(fn.description || ''), parameters: fn.parameters && typeof fn.parameters === 'object' ? fn.parameters : { type: 'object', properties: {} } }))
    const temperature = typeof body?.temperature === 'number' ? body.temperature : undefined
    try {
      const result = await foldHarnessStream(llm.stream({
        provider,
        model,
        ...(requestInput.system ? { system: requestInput.system } : {}),
        messages: requestInput.messages,
        ...(tools.length ? { tools } : {}),
        ...(temperature !== undefined ? { temperature } : {}),
        signal: AbortSignal.timeout(HARNESS_CHAT_TIMEOUT_MS),
      }))
      return {
        status: 200,
        body: {
          ok: true,
          content: result.content,
          toolCalls: result.toolCalls,
          ...(result.usage ? { usage: result.usage } : {}),
        },
      }
    } catch (error) {
      return { status: 502, body: { ok: false, error: error instanceof Error ? error.message : String(error) } }
    }
  }

  return { modelsPayload, chatPayload }
}

function registerHarnessModelRoutes(ctx, handlers) {
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/infinite-canvas.harness-models',
    methods: ['GET'],
    requestBody: 'buffered',
    async fetch() {
      const payload = await handlers.modelsPayload()
      return Response.json(payload.body, { status: payload.status, headers: { 'Cache-Control': 'no-store' } })
    },
  }), 'infinite-canvas: harness-models route')

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/infinite-canvas.harness-chat',
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      let body
      try {
        body = await request.json()
      } catch {
        return Response.json({ ok: false, error: '请求体不是合法 JSON' }, { status: 400 })
      }
      const payload = await handlers.chatPayload(body)
      return Response.json(payload.body, { status: payload.status })
    },
  }), 'infinite-canvas: harness-chat route')
}

/**
 * 回环 harness 中继：canvas-agent（独立 node 进程）直连本插件的 harness 代理端点。
 * 仅绑 127.0.0.1，路径带随机 token（/h/<token>/api/...）防本机其它进程误用；
 * origin 经 bridge-info 下发给面板客户端，由客户端回传给 iframe 拼进渠道载荷。
 */
function startHarnessRelayServer(handlers, onListening) {
  const token = randomUUID().replace(/-/g, '')
  const server = http.createServer((req, res) => {
    const reply = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(body))
    }
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    if (!url.pathname.startsWith(`/h/${token}/api/`)) {
      reply(404, { ok: false, error: 'not found' })
      return
    }
    if (req.method === 'GET' && url.pathname.endsWith('.harness-models')) {
      handlers.modelsPayload().then(
        (payload) => reply(payload.status, payload.body),
        (error) => reply(500, { ok: false, error: error instanceof Error ? error.message : String(error) }),
      )
      return
    }
    if (req.method === 'POST' && url.pathname.endsWith('.harness-chat')) {
      const chunks = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => {
        let body
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        } catch {
          reply(400, { ok: false, error: '请求体不是合法 JSON' })
          return
        }
        handlers.chatPayload(body).then(
          (payload) => reply(payload.status, payload.body),
          (error) => reply(500, { ok: false, error: error instanceof Error ? error.message : String(error) }),
        )
      })
      return
    }
    reply(404, { ok: false, error: 'not found' })
  })
  server.listen(0, '127.0.0.1', onListening)
  return { server, token }
}

export async function apply(ctx, config) {
  const baseUrl = `http://${config.host}:${config.port}`
  const bridgeEntry = fileURLToPath(new URL('../bridge/index.js', import.meta.url))
  const siteDir = fileURLToPath(new URL('../site', import.meta.url))

  const state = {
    ready: false,
    starting: false,
    child: null,
    error: undefined,
    restarts: 0,
  }

  // 共享设置（本项目自己的设置页）：这里只取本项目的运行期开关与连接 token。
  // 读取失败按默认开启处理，设置文件损坏不应该拦住桥的启动。
  const settingsPath = sharedSettingsPath(config.root)
  let autoStart = true
  let autoRestart = true
  // 连接 token：设置里留空 = 自动（桥自己生成并经 /bootstrap 下发）；填写则 spawn 时注入固定值。
  let bridgeToken = ''
  try {
    const shared = await readSharedSettings(config.root)
    const switches = projectSwitches(shared, 'infinite-canvas')
    autoStart = switches.autoStart
    autoRestart = switches.autoRestart
    bridgeToken = String(shared.projects?.['infinite-canvas']?.bridgeToken || '').trim()
  } catch (error) {
    ctx.logger.warn('infinite-canvas: read shared settings failed: %s', error instanceof Error ? error.message : String(error))
  }

  /** 读桥当前生效的 token：先看桥落盘的配置文件，再经 /bootstrap 领（覆盖复用外部桥的场景）。 */
  async function discoverBridgeToken() {
    try {
      const raw = await readFile(join(config.root, 'canvas-agent.json'), 'utf8')
      const token = String(JSON.parse(raw)?.token || '').trim()
      if (token) return token
    } catch { /* 桥还没写过配置文件 */ }
    try {
      const response = await fetch(`${baseUrl}/bootstrap`, { signal: AbortSignal.timeout(2000) })
      const payload = await response.json().catch(() => null)
      return String(payload?.token || '').trim()
    } catch { return '' }
  }

  /** 设置里未固定 token 时，把桥当前 token 回填到共享设置，设置页打开即见（默认填充）。 */
  async function fillBridgeTokenIfEmpty() {
    if (bridgeToken) return
    const token = await discoverBridgeToken()
    if (!token) return
    bridgeToken = token
    try {
      await updateSharedSettings(config.root, {
        projects: { 'infinite-canvas': { bridgeToken: token, updatedAt: Date.now() } },
      })
      ctx.logger.info('infinite-canvas: bridge token filled into shared settings')
    } catch (error) {
      ctx.logger.warn('infinite-canvas: bridge token fill failed: %s', error instanceof Error ? error.message : String(error))
    }
  }

  /** 面板读取的稳定快照：只含可 JSON 化的状态，不含子进程句柄。 */
  const snapshot = () => ({
    ready: state.ready,
    host: config.host,
    port: config.port,
    supervised: config.spawn,
    restarts: state.restarts,
    autoStart,
    autoRestart,
    // 回环 harness 中继 origin（node 进程可直连；桌面端 shell origin 是 dsh-app:// 不可用）
    ...(harnessRelayOrigin ? { harnessRelayOrigin } : {}),
    ...(state.error ? { error: state.error } : {}),
  })

  // 注册即 effect：面板任何时刻都能拿到状态；停用/HMR 时路由随之移除。
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/infinite-canvas.bridge-info',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: () => Response.json(snapshot(), { headers: { 'Cache-Control': 'no-store' } }),
  }))

  /** 拉起打包内的桥，并等它健康。返回是否成功（失败原因写进 state.error）。 */
  async function spawnBridge() {
    await mkdir(config.root, { recursive: true })
    ctx.logger.info('infinite-canvas: spawning bridge; port=%s dataDir=%s siteDir=%s', config.port, config.root, siteDir)
    const child = spawn(process.execPath, [bridgeEntry], {
      env: {
        ...scrubbedEnv(),
        // canvas-agent 的会话线程/技能/配置都落在 CANVAS_AGENT_HOME 下；
        // 卸载插件不删数据，独立开发态（不设该变量）仍用 ~/.infinite-canvas。
        CANVAS_AGENT_HOME: config.root,
        // 显式传站点目录：桥据此伺服 web/dist（画布面板 iframe 的同源站点）。
        CANVAS_SITE_DIR: siteDir,
        // canvas-agent 读 PORT 决定监听端口。
        PORT: String(config.port),
        // 设置里固定了连接 token 时注入（CANVAS_AGENT_TOKEN 优先于桥落盘的 token；
        // scrubbedEnv 会先清掉环境里的 *TOKEN*，这里再写入我们自己的）。
        ...(bridgeToken ? { CANVAS_AGENT_TOKEN: bridgeToken } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let spawnError = null
    child.on('error', error => { spawnError = error })
    child.on('exit', code => {
      if (state.child !== child) return
      state.child = null
      state.ready = false
      if (code !== 0 && code !== null) state.error = `桥进程退出（code=${code}），稍后自动重启`
    })
    const pipe = (stream, level) => {
      stream?.on('data', chunk => {
        const text = String(chunk).trim()
        if (text) ctx.logger[level]('infinite-canvas bridge: %s', text.slice(0, 2000))
      })
    }
    pipe(child.stdout, 'info')
    pipe(child.stderr, 'warn')
    state.child = child

    try {
      await waitForHealth(`${baseUrl}/health`, config.startupTimeoutMs, undefined)
      state.ready = true
      state.error = undefined
      await fillBridgeTokenIfEmpty()
      return true
    } catch (error) {
      const cause = spawnError ? `spawn failed: ${spawnError.message}` : error.message
      try { child.kill() } catch { /* 已经退出 */ }
      if (state.child === child) state.child = null
      state.ready = false
      state.error = `桥启动失败：${cause}`
      ctx.logger.error('infinite-canvas: bridge startup failed; port=%s cause=%s', config.port, cause)
      return false
    }
  }

  /**
   * 保证桥可用。`force` 为真时忽略现有桥（先杀掉自己托管的子进程再重建）。
   * 心跳与手动重启都走这里，避免两处逻辑漂移。
   * 心跳探测进行中收到的 force 请求不会丢：记入 restartPending，本次结束后补一次重建，
   * 否则「重启服务」按钮会在 starting 窗口内静默失效。
   */
  let restartPending = false
  /**
   * @param force 忽略现有桥并重建
   * @param mode  init=插件加载时，heartbeat=心跳，manual=用户点「重启服务」
   * 自动启动/自动重启只约束前两者：手动按钮是用户的明确意图，始终生效（仍受 spawn 配置约束）。
   */
  async function ensureOnce(force, mode = 'manual') {
    if (force && state.child) {
      try { state.child.kill() } catch { /* 已经退出 */ }
      state.child = null
      state.ready = false
    }
    if (!force) {
      const probe = await probeBridge(baseUrl)
      if (probe.ok) {
        if (!state.ready) ctx.logger.info('infinite-canvas: reusing healthy bridge; url=%s', baseUrl)
        state.ready = true
        state.error = undefined
        await fillBridgeTokenIfEmpty()
        return
      }
      state.ready = false
      if (probe.listening) {
        // 端口被占住且不能提供站点：不要 spawn（只会 EADDRINUSE），给出可操作原因。
        // devBridge（自家开发态桥）与无关进程的文案区分开，用户才知道该关哪个。
        state.error = probe.devBridge
          ? `端口 ${config.port} 被开发态画布桥占用（${probe.reason}）。关闭它后会自动重试。`
          : `端口 ${config.port} 被占用，且该进程无法提供画布站点（${probe.reason}）。关闭它后会自动重试。`
        return
      }
    }
    if (!config.spawn) {
      state.error = '插件配置 spawn=false，只复用外部桥；当前没有可用桥'
      return
    }
    if (mode !== 'manual') {
      if (!autoStart) {
        state.error = '已在「无限画布」设置中关闭自动启动；可点「重启服务」手动拉起'
        return
      }
      // 首次加载不算“重启”，autoRestart 只拦心跳里的补拉。
      if (mode === 'heartbeat' && !autoRestart) {
        state.error = '服务已断开；自动重启已关闭，可点「重启服务」手动拉起'
        return
      }
    }
    if (await spawnBridge()) state.restarts += 1
  }

  async function ensureBridge(force, mode = 'manual') {
    if (state.starting) {
      if (force) restartPending = true
      return
    }
    state.starting = true
    try {
      await ensureOnce(force, mode)
      if (restartPending) {
        restartPending = false
        await ensureOnce(true, 'manual')
      }
    } finally {
      state.starting = false
    }
  }

  // 手动重启：给面板一个“不用重启应用就能恢复画布”的按钮。
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/infinite-canvas.restart-bridge',
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch() {
      await ensureBridge(true, 'manual')
      return Response.json(snapshot(), { headers: { 'Cache-Control': 'no-store' } })
    },
  }))

  /** PUT 后立即让本项目的运行期开关生效：关掉自动启动会停掉自己托管的桥，重新打开则马上补拉。 */
  async function applyRuntimeSettings(settings) {
    const switches = projectSwitches(settings, 'infinite-canvas')
    const nextStart = switches.autoStart
    const nextRestart = switches.autoRestart
    const startTurnedOff = autoStart && !nextStart
    autoStart = nextStart
    autoRestart = nextRestart
    // token 修改在下次 spawn（重启服务）时生效；清空则回落为桥自动 token。
    bridgeToken = String(settings?.projects?.['infinite-canvas']?.bridgeToken || '').trim()
    if (startTurnedOff) {
      if (state.child) {
        try { state.child.kill() } catch { /* 已经退出 */ }
        state.child = null
      }
      state.ready = false
      state.error = '自动启动已关闭，托管服务已停止'
      return
    }
    if (autoStart && !state.ready) await ensureBridge(false, 'manual')
  }

  const sharedPayload = settings => ({
    ok: true,
    settings,
    service: { ...snapshot(), root: config.root, spawn: config.spawn, settingsPath },
  })

  // 「无限画布」共享设置：两个插件同源注册，同 id 的 settings.section 读的是同一份文件。
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/infinite-canvas.shared-settings',
    methods: ['GET', 'PUT'],
    requestBody: 'buffered',
    async fetch(request) {
      if ((request.method || 'GET').toUpperCase() === 'GET') {
        const settings = await readSharedSettings(config.root)
        return Response.json(sharedPayload(settings), { headers: { 'Cache-Control': 'no-store' } })
      }
      let body
      try {
        body = await request.json()
      } catch {
        return Response.json({ ok: false, error: '请求体不是合法 JSON' }, { status: 400 })
      }
      try {
        const settings = await updateSharedSettings(config.root, body)
        await applyRuntimeSettings(settings)
        return Response.json(sharedPayload(settings), { headers: { 'Cache-Control': 'no-store' } })
      } catch (error) {
        return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 })
      }
    },
  }))

  // Harness 模型接入：宿主连接路由（面板 iframe 用）+ 回环中继（canvas-agent 桥进程用）。
  const harnessHandlers = createHarnessHandlers(ctx)
  registerHarnessModelRoutes(ctx, harnessHandlers)
  let harnessRelayOrigin = ''
  const relay = startHarnessRelayServer(harnessHandlers, () => {
    harnessRelayOrigin = `http://127.0.0.1:${relay.server.address().port}/h/${relay.token}`
    ctx.logger.info('infinite-canvas: harness relay at %s', harnessRelayOrigin)
  })
  ctx.effect(() => () => relay.server.close())

  await ensureBridge(false, 'init')

  // 心跳：桥退出 / 被外部杀掉 / 端口被占后释放，都会在这里被拉回（关闭自动重启后只探测状态）。
  ctx.effect(() => {
    const timer = setInterval(() => { void ensureBridge(false, 'heartbeat') }, HEARTBEAT_MS)
    return () => {
      clearInterval(timer)
      if (state.child) {
        try { state.child.kill() } catch { /* 忽略 */ }
        state.child = null
      }
    }
  })
}
