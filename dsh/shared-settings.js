/**
 * 两个插件共用的设置存储：infinite-canvas / 3d-director-desk 读写同一份
 * `~/.dsh/haitang-aigc/settings.json`，但各自的分区完全独立。
 *
 * 设计要点：
 *   - projects.<id> 里保存该项目的 AI 渠道、渠道时间戳、默认模型/生成偏好，
 *     以及该项目的本地服务开关（autoStart / autoRestart）；两个项目互不覆盖，
 *     设置页也各管各的。
 *   - 分区合并：projects.<id> 带 updatedAt，PUT 只覆盖更新的项目分区。
 *   - 旧版文件（v1）的顶层 channels 与 global 开关是两个项目共用的；读取时只对
 *     缺少对应字段的项目分区做内存播种（不自动改写用户文件）。
 *   - global 只为兼容旧设置页保留；当前运行期开关以 projects.<id> 为准。
 *   - 密钥只落本地磁盘（0600），不写日志；GET 只返回给宿主同源的设置页。
 *   - 文件损坏时按空设置处理，不自动覆盖用户文件；删除所有字段需显式 PUT。
 *
 * 本文件在两个插件里保持逐字节一致，改一处必须同步另一处。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const VERSION = 2
const MAX_CHANNELS = 50
const MAX_MODELS_PER_CHANNEL = 200
const MAX_TEXT = 4096
const MAX_SCRIPT = 200_000
const PROJECT_IDS = ['infinite-canvas', 'director-desk']

/** 共享设置文件位置：与两个插件的数据目录同级，插件卸载不删。 */
export function sharedSettingsPath(root) {
  return join(dirname(root), 'haitang-aigc', 'settings.json')
}

/** 空设置；GET 读不到文件时也返回这个形状，设置页无需判空。 */
export function emptySharedSettings() {
  return {
    version: VERSION,
    channels: [],
    channelsUpdatedAt: 0,
    global: { autoStart: true, autoRestart: true, updatedAt: 0 },
    projects: {},
  }
}

function text(value, max = MAX_TEXT) {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

function timestamp(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0
}

function sanitizeModel(input) {
  if (!input || typeof input !== 'object') return null
  const name = text(input.name, 200).trim()
  if (!name) return null
  const capability = ['image', 'video', 'text', 'audio'].includes(input.capability) ? input.capability : 'text'
  const model = { name, capability }
  if (input.vision === true) model.vision = true
  if (typeof input.script === 'string' && input.script.trim()) model.script = input.script.slice(0, MAX_SCRIPT)
  return model
}

function sanitizeChannel(input) {
  if (!input || typeof input !== 'object') return null
  const id = text(input.id, 120).trim()
  if (!id) return null
  const apiFormat = ['openai', 'gemini', 'anthropic'].includes(input.apiFormat) ? input.apiFormat : 'openai'
  const models = []
  const seen = new Set()
  for (const raw of Array.isArray(input.models) ? input.models.slice(0, MAX_MODELS_PER_CHANNEL) : []) {
    const model = sanitizeModel(raw)
    if (!model || seen.has(model.name)) continue
    seen.add(model.name)
    models.push(model)
  }
  return {
    id,
    name: text(input.name, 120).trim() || id,
    baseUrl: text(input.baseUrl, 2000).trim(),
    apiKey: text(input.apiKey, 4000),
    apiFormat,
    models,
  }
}

function sanitizeChannels(input) {
  const channels = []
  const seen = new Set()
  for (const raw of Array.isArray(input) ? input.slice(0, MAX_CHANNELS) : []) {
    const channel = sanitizeChannel(raw)
    if (!channel || seen.has(channel.id)) continue
    seen.add(channel.id)
    channels.push(channel)
  }
  return channels
}

// 导演台只有 Agent 需要模型，默认与 web 端保持一致：仅 DeepSeek 文本渠道。
const DIRECTOR_DEFAULT_CHANNELS = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    apiKey: '',
    apiFormat: 'openai',
    models: [{ name: 'deepseek-flash', capability: 'text' }],
  },
]
// 旧版本写下的默认渠道：单一「默认渠道」（OpenAI + 四个占位模型），以及之后的
// 三渠道组合。只在用户完全没改过时收敛，加过 Key 或改过任意一项都原样保留。
const DIRECTOR_LEGACY_MODELS = ['gpt-image-2', 'grok-imagine-video', 'gpt-5.5', 'gpt-4o-mini-tts']
const PREVIOUS_DEFAULT_CHANNELS = [
  { id: 'deepseek', baseUrl: 'https://api.deepseek.com', models: ['deepseek-flash'] },
  { id: 'volcengine', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', models: ['doubao-seedream-5-0-pro-260628', 'doubao-seedance-2-0-260128'] },
  { id: 'dashscope', baseUrl: 'https://dashscope.aliyuncs.com', models: ['qwen3-tts-flash'] },
]
// 无限画布上一版默认模型的替换表：只在渠道完全是上一版默认组合时改名，保留脚本与用户偏好。
const CANVAS_DEFAULT_MODEL_RENAMES = {
  'doubao-seedream-5-0-pro-260628': 'doubao-seedream-5-5-pro',
  'doubao-seedance-2-0-260128': 'doubao-seedance-2-5-260628',
  'qwen3-tts-flash': 'qwen-audio-3.1-tts-flash',
}

function modelNames(channel) {
  return (channel.models || []).map((model) => model.name)
}

function isEmptyKey(channel) {
  return !String(channel.apiKey || '').trim()
}

function isPristineLegacyDirectorChannels(channels) {
  if (channels.length !== 1) return false
  const [channel] = channels
  if (channel.id !== 'default' || !isEmptyKey(channel)) return false
  if ((channel.apiFormat || 'openai') !== 'openai') return false
  if ((channel.baseUrl || '').trim().replace(/\/+$/, '').toLowerCase() !== 'https://api.openai.com') return false
  const names = modelNames(channel)
  return names.length === DIRECTOR_LEGACY_MODELS.length && DIRECTOR_LEGACY_MODELS.every((name) => names.includes(name))
}

function isPristinePreviousDefaultChannels(channels) {
  if (channels.length !== PREVIOUS_DEFAULT_CHANNELS.length) return false
  return PREVIOUS_DEFAULT_CHANNELS.every((expected) => {
    const channel = channels.find((item) => item.id === expected.id)
    if (!channel || !isEmptyKey(channel)) return false
    if ((channel.apiFormat || 'openai') !== 'openai') return false
    if ((channel.baseUrl || '').trim().replace(/\/+$/, '').toLowerCase() !== expected.baseUrl) return false
    const names = modelNames(channel)
    return names.length === expected.models.length && expected.models.every((name) => names.includes(name))
  })
}

function renameCanvasModelName(value) {
  if (typeof value !== 'string') return value
  const separator = value.indexOf('::')
  const name = separator < 0 ? value : value.slice(separator + 2)
  const renamed = CANVAS_DEFAULT_MODEL_RENAMES[name] || name
  return separator < 0 ? renamed : value.slice(0, separator + 2) + renamed
}

/** 上一版默认渠道改名为新的默认模型；脚本与其它字段原样保留。 */
function migrateCanvasDefaultModels(project) {
  project.channels = project.channels.map((channel) => ({
    ...channel,
    models: channel.models.map((model) => {
      const name = CANVAS_DEFAULT_MODEL_RENAMES[model.name]
      return name ? { ...model, name } : model
    }),
  }))
  for (const key of ['model', 'textModel', 'agentModel', 'imageModel', 'videoModel', 'audioModel']) {
    if (typeof project[key] === 'string') project[key] = renameCanvasModelName(project[key])
  }
}

function directorDefaultChannels() {
  return DIRECTOR_DEFAULT_CHANNELS.map((channel) => ({
    ...channel,
    models: channel.models.map((model) => ({ ...model })),
  }))
}

const PROJECT_TEXT_KEYS = ['textModel', 'agentModel', 'imageModel', 'videoModel', 'audioModel', 'imageRatio', 'videoRatio', 'videoSeconds', 'canvasImageCount', 'vquality', 'videoGenerateAudio', 'videoWatermark', 'bridgeToken']
const PROJECT_BOOL_KEYS = ['autoFocusOnSelect']
const PROJECT_SWITCH_KEYS = ['autoStart', 'autoRestart']

function sanitizeProject(input) {
  const project = {}
  if (Array.isArray(input.channels)) {
    project.channels = sanitizeChannels(input.channels)
    project.channelsUpdatedAt = timestamp(input.channelsUpdatedAt)
  }
  for (const key of PROJECT_TEXT_KEYS) {
    if (typeof input[key] === 'string') project[key] = input[key].slice(0, 500)
    else if (typeof input[key] === 'number') project[key] = String(input[key])
    else if (typeof input[key] === 'boolean') project[key] = input[key] ? 'true' : 'false'
  }
  for (const key of PROJECT_BOOL_KEYS) {
    if (typeof input[key] === 'boolean') project[key] = input[key]
    else if (input[key] === 'true' || input[key] === 'false') project[key] = input[key] === 'true'
  }
  for (const key of PROJECT_SWITCH_KEYS) {
    if (typeof input[key] === 'boolean') project[key] = input[key]
    else if (input[key] === 'true' || input[key] === 'false') project[key] = input[key] === 'true'
  }
  if (input.nodeRegenerateBehavior === 'overwrite' || input.nodeRegenerateBehavior === 'new-node') {
    project.nodeRegenerateBehavior = input.nodeRegenerateBehavior
  }
  if (input.videoMode === 'reference' || input.videoMode === 'frames') project.videoMode = input.videoMode
  return project
}

function mergeGlobal(base, incoming) {
  if (!incoming || typeof incoming !== 'object') return base
  const updatedAt = timestamp(incoming.updatedAt)
  if (updatedAt < (base.updatedAt || 0)) return base
  return {
    autoStart: incoming.autoStart === undefined ? base.autoStart !== false : Boolean(incoming.autoStart),
    autoRestart: incoming.autoRestart === undefined ? base.autoRestart !== false : Boolean(incoming.autoRestart),
    updatedAt,
  }
}

/** 把磁盘上的 JSON 合并成完整形状；坏字段丢弃而不是让整页失败。 */
function normalize(raw) {
  const base = emptySharedSettings()
  if (!raw || typeof raw !== 'object') return base
  if (Array.isArray(raw.channels)) {
    base.channels = sanitizeChannels(raw.channels)
    base.channelsUpdatedAt = timestamp(raw.channelsUpdatedAt)
  }
  base.global = mergeGlobal(base.global, raw.global)
  if (raw.projects && typeof raw.projects === 'object') {
    for (const id of PROJECT_IDS) {
      const project = raw.projects[id]
      if (!project || typeof project !== 'object') continue
      base.projects[id] = { ...sanitizeProject(project), updatedAt: timestamp(project.updatedAt) }
    }
  }
  // v1 顶层 channels 由两个项目共用；v2 起按项目独立。旧文件里缺少项目渠道时
  // 播种一份（不落盘），这样两个项目第一次打开都能拿到原来的渠道。
  if (base.channels.length) {
    for (const id of PROJECT_IDS) {
      if (Array.isArray(base.projects[id]?.channels)) continue
      base.projects[id] = {
        ...(base.projects[id] || {}),
        channels: sanitizeChannels(base.channels),
        channelsUpdatedAt: base.channelsUpdatedAt,
      }
    }
  }
  // 同理：旧文件只有 global 开关时，把它播种到缺少开关的项目分区。
  for (const id of PROJECT_IDS) {
    const project = base.projects[id]
    if (!project) continue
    if (typeof project.autoStart !== 'boolean') project.autoStart = base.global.autoStart !== false
    if (typeof project.autoRestart !== 'boolean') project.autoRestart = base.global.autoRestart !== false
  }
  // 导演台只需要文本模型：旧默认渠道在读取时收敛为当前默认（不落盘，用户下次
  // 保存会自然写回），避免设置页把图片/视频/语音渠道展示成导演台的配置。
  const director = base.projects['director-desk']
  if (director && Array.isArray(director.channels)) {
    if (isPristineLegacyDirectorChannels(director.channels) || isPristinePreviousDefaultChannels(director.channels)) {
      director.channels = directorDefaultChannels()
    }
  }
  // 无限画布：上一版默认渠道仍在磁盘上时，读取时把模型改名为当前默认模型。
  const canvas = base.projects['infinite-canvas']
  if (canvas && Array.isArray(canvas.channels) && isPristinePreviousDefaultChannels(canvas.channels)) {
    migrateCanvasDefaultModels(canvas)
  }
  return base
}

/** 磁盘上的无限画布分区是否还是上一版默认模型（用于迁移后抬高时间戳并落盘一次）。 */
function hasStaleCanvasDefaults(raw) {
  const project = raw && raw.projects && raw.projects['infinite-canvas']
  if (!project || !Array.isArray(project.channels)) return false
  return isPristinePreviousDefaultChannels(sanitizeChannels(project.channels))
}

/** 读共享设置；文件不存在 / 损坏都返回空设置（不抛错、不覆盖）。 */
export async function readSharedSettings(root) {
  try {
    const raw = await readFile(sharedSettingsPath(root), 'utf8')
    const parsed = JSON.parse(raw)
    const staleCanvas = hasStaleCanvasDefaults(parsed)
    const settings = normalize(parsed)
    if (staleCanvas) {
      // 改名的画布默认值要落盘并抬高时间戳，否则运行中的画布会继续套用旧分区。
      const project = settings.projects['infinite-canvas']
      if (project) {
        const now = Date.now()
        project.channelsUpdatedAt = now
        project.updatedAt = now
        try {
          await writeSharedSettings(root, settings)
        } catch {
          /* 只读环境下次读取再试 */
        }
      }
    }
    return settings
  } catch {
    return emptySharedSettings()
  }
}

/** 某个项目自己的运行期开关；项目分区没写过开关时回退到旧版 global。 */
export function projectSwitches(settings, projectId) {
  const project = settings?.projects?.[projectId]
  const legacy = settings?.global || {}
  return {
    autoStart: typeof project?.autoStart === 'boolean' ? project.autoStart : legacy.autoStart !== false,
    autoRestart: typeof project?.autoRestart === 'boolean' ? project.autoRestart : legacy.autoRestart !== false,
  }
}

async function writeSharedSettings(root, settings) {
  const file = sharedSettingsPath(root)
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`
  await writeFile(temp, JSON.stringify(settings, null, 2), { encoding: 'utf8', mode: 0o600 })
  try {
    await rename(temp, file)
  } catch {
    // Windows 上目标被占用时 rename 可能失败；退化为直接覆盖，至少保证设置落盘。
    await writeFile(file, JSON.stringify(settings, null, 2), { encoding: 'utf8', mode: 0o600 })
  }
}

/**
 * 分区合并写入。
 * @param root 插件数据目录（config.root）
 * @param body PUT 请求体：projects.<id>（含 channels / 默认值 / autoStart / autoRestart）；
 *   顶层 channels、global 只为兼容尚未更新的旧设置页。
 * @returns 合并后的完整设置
 */
export async function updateSharedSettings(root, body) {
  const current = await readSharedSettings(root)
  const next = { ...current, projects: { ...current.projects } }
  let changed = false

  if (body && Array.isArray(body.channels)) {
    const at = timestamp(body.channelsUpdatedAt ?? body.updatedAt) || Date.now()
    if (at >= (current.channelsUpdatedAt || 0)) {
      const channels = sanitizeChannels(body.channels)
      next.channels = channels
      next.channelsUpdatedAt = at
      // 旧客户端只发顶层 channels（当时两个项目共用）；照旧同时写进两边。
      for (const id of PROJECT_IDS) {
        next.projects[id] = { ...(next.projects[id] || {}), channels, channelsUpdatedAt: at }
      }
      changed = true
    }
  }

  if (body && body.global && typeof body.global === 'object') {
    const incoming = { ...body.global, updatedAt: timestamp(body.global.updatedAt) || Date.now() }
    const merged = mergeGlobal(current.global, incoming)
    if (merged !== current.global) {
      next.global = merged
      changed = true
    }
  }

  if (body && body.projects && typeof body.projects === 'object') {
    for (const id of PROJECT_IDS) {
      const incoming = body.projects[id]
      if (!incoming || typeof incoming !== 'object') continue
      const at = timestamp(incoming.updatedAt) || Date.now()
      if (at < (current.projects[id]?.updatedAt || 0)) continue
      const project = sanitizeProject(incoming)
      const previous = next.projects[id] || {}
      // 旧面板保存项目默认值时不会带 channels；保留磁盘上已有的项目渠道。
      if (!Array.isArray(incoming.channels) && Array.isArray(previous.channels)) {
        project.channels = previous.channels
        project.channelsUpdatedAt = previous.channelsUpdatedAt || 0
      }
      // 服务开关同理：没带就沿用当前值，别被旧面板的整分区写入清掉。
      for (const key of PROJECT_SWITCH_KEYS) {
        if (typeof project[key] !== 'boolean' && typeof previous[key] === 'boolean') project[key] = previous[key]
      }
      // 后加的文字字段（如 agentModel）只有新面板会带；旧面板整分区写入时保留磁盘值。
      for (const key of PROJECT_TEXT_KEYS) {
        if (project[key] === undefined && typeof previous[key] === 'string') project[key] = previous[key]
      }
      next.projects[id] = { ...project, updatedAt: at }
      changed = true
    }
  }

  if (changed) await writeSharedSettings(root, next)
  return next
}
