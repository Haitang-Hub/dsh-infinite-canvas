import { useMemo } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { nanoid } from "nanoid";

import i18n from "@/i18n";

export type ApiCallFormat = "openai" | "gemini";
export type ModelCapability = "image" | "video" | "text" | "audio";
export type ReasoningEffort = "auto" | "low" | "medium" | "high" | "xhigh";

export type ChannelModel = {
    name: string;
    capability: ModelCapability;
    script?: string;
};

export type ModelChannel = {
    id: string;
    name: string;
    baseUrl: string;
    apiKey: string;
    apiFormat: ApiCallFormat;
    models: ChannelModel[];
};

export type AiConfig = {
    channelMode: "remote" | "local";
    baseUrl: string;
    apiKey: string;
    apiFormat: ApiCallFormat;
    channels: ModelChannel[];
    model: string;
    imageModel: string;
    videoModel: string;
    textModel: string;
    /** Agent 专用模型；留空时跟随 textModel。可存 harness:: 编码。 */
    agentModel: string;
    audioModel: string;
    audioVoice: string;
    audioFormat: string;
    audioSpeed: string;
    audioInstructions: string;
    videoSeconds: string;
    vquality: string;
    videoGenerateAudio: string;
    videoWatermark: string;
    videoMode: string;
    systemPrompt: string;
    reasoningEffort: ReasoningEffort;
    models: string[];
    quality: string;
    size: string;
    background: string;
    count: string;
    canvasImageCount: string;
    nodeRegenerateBehavior: "new-node" | "overwrite";
    autoFocusOnSelect: boolean;
    imageRatio: string;
    videoRatio: string;
};

export type WebdavSyncConfig = {
    url: string;
    username: string;
    password: string;
    directory: string;
    lastSyncedAt: string;
};
export type ConfigTabKey = "channels" | "preferences" | "prompt-sources" | "webdav" | "local-storage";

export type ChannelCredentialsImportResult = {
    status: "created" | "updated" | "missing-base-url" | "invalid-base-url";
    channelName?: string;
};

export const CONFIG_STORE_KEY = "infinite-canvas:ai_config_store";
const CHANNEL_MODEL_SEPARATOR = "::";
const OPENAI_BASE_URL = "https://api.openai.com";
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com";

/** 火山方舟 Seedream 图片生成（OpenAI 兼容的 /images/generations）。 */
export const DEFAULT_VOLCENGINE_IMAGE_SCRIPT = `/**
 * 火山方舟 Seedream 图片生成脚本。
 * - POST {baseUrl}/images/generations，baseUrl 形如 https://ark.cn-beijing.volces.com/api/v3
 * - 输出尺寸按用户比例缩放到长边约 2048（Seedream 推荐 2K 档）
 * - 参考图通过 image 字段传入（data URL 或 URL）
 * @param {string} prompt
 * @param {string[]} images - 参考图 data URL；为空时纯文生图
 * @param {object} params
 * @param {string} params.size - 输出尺寸，如 "1024x1024"
 * @param {number} params.count - 生成张数（接口每次返回 1 张，按次数循环）
 * @param {string} model
 * @param {string} baseUrl - 渠道 Base URL（含 /api/v3）
 * @param {string} apiKey
 * @param {function} request
 * @returns {Promise<string[]>}
 */
function seedreamSize(size) {
  const match = String(size || "").trim().match(/^(\\d+)x(\\d+)$/i);
  if (!match) return "2K";
  const width = Number(match[1]);
  const height = Number(match[2]);
  const longSide = Math.max(width, height);
  if (!longSide) return "2K";
  if (longSide >= 2048) return width + "x" + height;
  const scale = 2048 / longSide;
  return Math.round(width * scale) + "x" + Math.round(height * scale);
}

async function generateImage({ prompt, images, params, model, baseUrl, apiKey, request }) {
  const body = {
    model: model,
    prompt: prompt,
    size: seedreamSize(params.size),
    response_format: "url",
    watermark: false,
  };
  if (images && images.length) body.image = images.length === 1 ? images[0] : images;

  const count = Math.max(1, Math.floor(Number(params.count) || 1));
  const urls = [];
  for (let index = 0; index < count; index += 1) {
    const result = await request({
      method: "post",
      url: \`\${baseUrl}/images/generations\`,
      headers: { "Content-Type": "application/json", Authorization: \`Bearer \${apiKey}\` },
      data: body,
    });
    for (const item of (result && Array.isArray(result.data) ? result.data : [])) {
      if (item && item.url) urls.push(item.url);
      else if (item && item.b64_json) urls.push(\`data:image/png;base64,\${item.b64_json}\`);
    }
  }
  if (!urls.length) throw new Error("Seedream 返回中没有图片数据");
  return urls;
}

return await generateImage({ prompt, images, params, model, baseUrl, apiKey, request });`;

/** 火山方舟 Seedance 视频生成（异步任务接口）。 */
export const DEFAULT_VOLCENGINE_VIDEO_SCRIPT = `/**
 * 火山方舟 Seedance 视频生成脚本。
 * - POST {baseUrl}/contents/generations/tasks 创建任务（baseUrl 含 /api/v3）
 * - 轮询 GET {baseUrl}/contents/generations/tasks/{id}，succeeded 后取 content.video_url
 * - mode "frames" 用首/尾帧，其余有图场景用参考图
 * @param {string} prompt
 * @param {string[]} images - data URL；首尾帧或参考图
 * @param {object} params
 * @param {string} params.mode - "frames" | "reference"
 * @param {string} params.resolution - 如 "720p"
 * @param {string} params.ratio - 如 "16:9"；"auto" 时省略
 * @param {number} params.seconds - 时长（秒），限制在 4–15
 * @param {string} model
 * @param {string} baseUrl
 * @param {string} apiKey
 * @param {function} request
 * @param {function} poll
 * @returns {Promise<{url:string}>}
 */
async function generateVideo({ prompt, images, params, model, baseUrl, apiKey, request, poll }) {
  const content = [{ type: "text", text: prompt }];
  if (images && images.length) {
    if (params.mode === "frames") {
      if (images[0]) content.push({ type: "image_url", image_url: { url: images[0] }, role: "first_frame" });
      if (images[1]) content.push({ type: "image_url", image_url: { url: images[1] }, role: "last_frame" });
    } else {
      for (const url of images.slice(0, 4)) content.push({ type: "image_url", image_url: { url: url }, role: "reference_image" });
    }
  }

  const body = { model: model, content: content };
  if (params.ratio && params.ratio !== "auto") body.ratio = params.ratio;
  body.duration = Math.min(15, Math.max(4, Math.round(Number(params.seconds) || 5)));
  body.watermark = Boolean(params.watermark);
  if (params.generateAudio && /seedance-(1-5|2)/.test(model)) body.generate_audio = true;
  const resolution = String(params.resolution || "").toLowerCase();
  if (/^\\d+p$/.test(resolution)) body.resolution = resolution;

  const created = await request({
    method: "post",
    url: \`\${baseUrl}/contents/generations/tasks\`,
    headers: { "Content-Type": "application/json", Authorization: \`Bearer \${apiKey}\` },
    data: body,
  });
  const taskId = created && (created.id || created.task_id);
  if (!taskId) throw new Error("Seedance 创建任务失败：响应缺少任务 ID");

  return await poll(
    () => request({
      method: "get",
      url: \`\${baseUrl}/contents/generations/tasks/\${taskId}\`,
      headers: { Authorization: \`Bearer \${apiKey}\` },
    }),
    (task) => {
      if (!task) return null;
      if (task.status === "failed" || task.status === "cancelled") throw new Error((task.error && task.error.message) || "Seedance 视频生成失败");
      if (task.status === "succeeded") {
        const url = (task.content && task.content.video_url) || task.video_url;
        if (!url) throw new Error("Seedance 结果缺少视频地址");
        return { url: url };
      }
      return null;
    },
    { intervalMs: 5000, timeoutMs: 600000 },
  );
}

return await generateVideo({ prompt, images, params, model, baseUrl, apiKey, request, poll });`;

/** 阿里云百炼 Qwen-TTS 语音合成。 */
export const DEFAULT_DASHSCOPE_TTS_SCRIPT = `/**
 * 阿里云百炼 Qwen-TTS 语音合成脚本。
 * - POST {baseUrl}/api/v1/services/aigc/multimodal-generation/generation
 * - 返回 output.audio.url，由前端下载为音频文件
 * - voice 仅接受 Qwen-TTS 音色，其余值回退 Cherry
 * @param {string} prompt - 待合成文本
 * @param {object} params
 * @param {string} params.voice
 * @param {string} model
 * @param {string} baseUrl - 渠道 Base URL，如 https://dashscope.aliyuncs.com
 * @param {string} apiKey
 * @param {function} request
 * @returns {Promise<{url:string}>}
 */
const QWEN_TTS_VOICES = ["Cherry", "Serena", "Ethan", "Chelsie"];

async function synthesize({ prompt, params, model, baseUrl, apiKey, request }) {
  const voice = QWEN_TTS_VOICES.includes(params.voice) ? params.voice : "Cherry";
  const result = await request({
    method: "post",
    url: \`\${baseUrl}/api/v1/services/aigc/multimodal-generation/generation\`,
    headers: { "Content-Type": "application/json", Authorization: \`Bearer \${apiKey}\` },
    data: { model: model, input: { text: prompt, voice: voice } },
  });
  const audio = result && result.output && result.output.audio;
  if (!audio) throw new Error((result && result.message) || "Qwen-TTS 返回中没有音频数据");
  if (audio.url) return { url: audio.url };
  if (audio.data) return { url: "data:audio/wav;base64," + audio.data };
  throw new Error("Qwen-TTS 返回中没有音频地址");
}

return await synthesize({ prompt, params, model, baseUrl, apiKey, request });`;

export const defaultConfig: AiConfig = {
    channelMode: "local",
    baseUrl: "https://api.deepseek.com",
    apiKey: "",
    apiFormat: "openai",
    // 默认渠道：文本 DeepSeek、图片/视频 火山方舟（共用一把 key）、语音 阿里云百炼
    channels: [
        {
            id: "deepseek",
            name: "DeepSeek",
            baseUrl: "https://api.deepseek.com",
            apiKey: "",
            apiFormat: "openai",
            models: [{ name: "deepseek-flash", capability: "text" }],
        },
        {
            id: "volcengine",
            name: "火山方舟",
            baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
            apiKey: "",
            apiFormat: "openai",
            models: [
                { name: "doubao-seedream-5-5-pro", capability: "image", script: DEFAULT_VOLCENGINE_IMAGE_SCRIPT },
                { name: "doubao-seedance-2-5-260628", capability: "video", script: DEFAULT_VOLCENGINE_VIDEO_SCRIPT },
            ],
        },
        {
            id: "dashscope",
            name: "阿里云百炼",
            baseUrl: "https://dashscope.aliyuncs.com",
            apiKey: "",
            apiFormat: "openai",
            models: [{ name: "qwen-audio-3.1-tts-flash", capability: "audio", script: DEFAULT_DASHSCOPE_TTS_SCRIPT }],
        },
    ],
    model: "volcengine::doubao-seedream-5-5-pro",
    imageModel: "volcengine::doubao-seedream-5-5-pro",
    videoModel: "volcengine::doubao-seedance-2-5-260628",
    textModel: "deepseek::deepseek-flash",
    agentModel: "",
    audioModel: "dashscope::qwen-audio-3.1-tts-flash",
    audioVoice: "alloy",
    audioFormat: "mp3",
    audioSpeed: "1",
    audioInstructions: "",
    videoSeconds: "6",
    vquality: "720",
    videoGenerateAudio: "true",
    videoWatermark: "false",
    videoMode: "frames",
    systemPrompt: "",
    reasoningEffort: "auto",
    models: ["volcengine::doubao-seedream-5-5-pro", "volcengine::doubao-seedance-2-5-260628", "deepseek::deepseek-flash", "dashscope::qwen-audio-3.1-tts-flash"],
    quality: "auto",
    size: "1:1",
    background: "",
    count: "1",
    canvasImageCount: "3",
    nodeRegenerateBehavior: "new-node",
    autoFocusOnSelect: false,
    imageRatio: "auto",
    videoRatio: "auto",
};

// 旧版内置的单一「默认渠道」（OpenAI 地址 + 四个占位模型）。只在用户完全没动过它时
// 一次性替换成上面的新默认组合；加过 Key 或改过任意一项就原样保留。
const LEGACY_DEFAULT_MODELS = ["gpt-image-2", "grok-imagine-video", "gpt-5.5", "gpt-4o-mini-tts"];
const LEGACY_DEFAULT_MIGRATION_KEY = "haitang-aigc:legacy-default-migrated-at";

function isPristineLegacyChannel(channel: Partial<ModelChannel> | undefined) {
    if (!channel || channel.id !== "default") return false;
    if ((channel.apiKey || "").trim()) return false;
    if ((channel.apiFormat || "openai") !== "openai") return false;
    if ((channel.baseUrl || "").trim().replace(/\/+$/, "").toLowerCase() !== "https://api.openai.com") return false;
    const names = ((channel.models || []) as Array<ModelChannel["models"][number] | string>)
        .map((model) => (typeof model === "string" ? model : model?.name || ""))
        .filter(Boolean);
    if (names.length !== LEGACY_DEFAULT_MODELS.length) return false;
    return LEGACY_DEFAULT_MODELS.every((name) => names.includes(name));
}

function shouldMigrateLegacyDefaults(persisted: Partial<AiConfig>) {
    if ((persisted.apiKey || "").trim()) return false;
    if (persisted.baseUrl && persisted.baseUrl.trim().replace(/\/+$/, "").toLowerCase() !== "https://api.openai.com") return false;
    return Array.isArray(persisted.channels) && persisted.channels.length === 1 && isPristineLegacyChannel(persisted.channels[0]);
}

// 上一版内置的三渠道默认模型；只替换完全没动过的默认组合（空 Key、地址与模型名一致），
// 用户加过 Key 或改过模型就原样保留。
const PREVIOUS_DEFAULT_CHANNELS = [
    { id: "deepseek", baseUrl: "https://api.deepseek.com", models: ["deepseek-flash"] },
    { id: "volcengine", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", models: ["doubao-seedream-5-0-pro-260628", "doubao-seedance-2-0-260128"] },
    { id: "dashscope", baseUrl: "https://dashscope.aliyuncs.com", models: ["qwen3-tts-flash"] },
];
export const MODEL_REFRESH_MIGRATION_KEY = "haitang-aigc:model-refresh-migrated-at";

function channelModelNames(channel: Partial<ModelChannel>) {
    return ((channel.models || []) as Array<ModelChannel["models"][number] | string>)
        .map((model) => (typeof model === "string" ? model : model?.name || ""))
        .filter(Boolean);
}

function isPristinePreviousDefaultChannels(channels: Array<Partial<ModelChannel>>) {
    if (channels.length !== PREVIOUS_DEFAULT_CHANNELS.length) return false;
    return PREVIOUS_DEFAULT_CHANNELS.every((expected) => {
        const channel = channels.find((item) => item.id === expected.id);
        if (!channel || (channel.apiKey || "").trim()) return false;
        if ((channel.apiFormat || "openai") !== "openai") return false;
        if ((channel.baseUrl || "").trim().replace(/\/+$/, "").toLowerCase() !== expected.baseUrl) return false;
        const names = channelModelNames(channel);
        return names.length === expected.models.length && expected.models.every((name) => names.includes(name));
    });
}

function shouldMigratePreviousDefaultModels(persisted: Partial<AiConfig>) {
    return Array.isArray(persisted.channels) && isPristinePreviousDefaultChannels(persisted.channels);
}

const HARNESS_SELECTION_PREFIX = "harness::";
export const AGENT_MODEL_MIGRATION_KEY = "haitang-aigc:agent-model-migrated-at";

/** 旧版 Agent 选择直接写进 textModel；拆出 agentModel 时搬过去，textModel 回到默认文本模型。 */
function legacyHarnessAgentModel(persisted: Partial<AiConfig>) {
    if (typeof persisted.agentModel === "string" && persisted.agentModel.trim()) return "";
    const textModel = typeof persisted.textModel === "string" ? persisted.textModel.trim() : "";
    return textModel.startsWith(HARNESS_SELECTION_PREFIX) ? textModel : "";
}

function migrateLegacyDefaults(config: AiConfig): AiConfig {
    // 记下迁移时刻：DSH 设置桥据此抬高本机分区时间戳，避免宿主里的旧默认反冲，
    // 并在连上宿主后主动把新渠道推回去。
    try {
        localStorage.setItem(LEGACY_DEFAULT_MIGRATION_KEY, String(Date.now()));
    } catch {
        /* 隐私模式下忽略 */
    }
    return {
        ...config,
        channels: defaultConfig.channels.map((channel) => ({ ...channel, models: channel.models.map((model) => ({ ...model })) })),
        models: [...defaultConfig.models],
        model: defaultConfig.model,
        imageModel: defaultConfig.imageModel,
        videoModel: defaultConfig.videoModel,
        textModel: defaultConfig.textModel,
        audioModel: defaultConfig.audioModel,
    };
}

function migratePreviousDefaultModels(config: AiConfig): AiConfig {
    try {
        localStorage.setItem(MODEL_REFRESH_MIGRATION_KEY, String(Date.now()));
    } catch {
        /* 隐私模式下忽略 */
    }
    return {
        ...config,
        channels: defaultConfig.channels.map((channel) => ({ ...channel, models: channel.models.map((model) => ({ ...model })) })),
        models: [...defaultConfig.models],
        model: defaultConfig.model,
        imageModel: defaultConfig.imageModel,
        videoModel: defaultConfig.videoModel,
        audioModel: defaultConfig.audioModel,
    };
}

export const defaultWebdavSyncConfig: WebdavSyncConfig = {
    url: "",
    username: "",
    password: "",
    directory: "infinite-canvas",
    lastSyncedAt: "",
};

type ConfigStore = {
    config: AiConfig;
    webdav: WebdavSyncConfig;
    isConfigOpen: boolean;
    configTab: ConfigTabKey;
    shouldPromptContinue: boolean;
    updateConfig: <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void;
    importChannelCredentials: (input: { baseUrl?: string | null; apiKey?: string | null }) => ChannelCredentialsImportResult;
    updateWebdavConfig: <K extends keyof WebdavSyncConfig>(key: K, value: WebdavSyncConfig[K]) => void;
    isAiConfigReady: (config: AiConfig, model: string) => boolean;
    openConfigDialog: (shouldPromptContinue?: boolean, tab?: ConfigTabKey) => void;
    setConfigDialogOpen: (isOpen: boolean) => void;
    clearPromptContinue: () => void;
};

const VIDEO_KEYWORDS = ["video", "sora", "veo", "kling", "wan", "hailuo", "seedance"];

export function boolConfig(value: string, fallback: boolean) {
    return value ? value === "true" : fallback;
}
const AUDIO_KEYWORDS = ["audio", "tts", "speech", "voice", "music", "sound"];
const IMAGE_KEYWORDS = ["seedream", "gpt-image", "image", "dall-e", "dalle", "imagen", "flux", "sdxl", "stable-diffusion", "midjourney"];

/** Best-effort default capability for a freshly fetched model name; user can override in the channel editor. */
export function guessCapability(name: string): ModelCapability {
    const value = name.toLowerCase();
    if (VIDEO_KEYWORDS.some((keyword) => value.includes(keyword))) return "video";
    if (AUDIO_KEYWORDS.some((keyword) => value.includes(keyword))) return "audio";
    if (IMAGE_KEYWORDS.some((keyword) => value.includes(keyword))) return "image";
    return "text";
}

/** 图片默认调用脚本（模板索引 2）。 */
export const DEFAULT_EXTENDED_IMAGE_SCRIPT = `/**
 * 图片生成模板：text-to-image 和 image-to-image。
 * Key differences from OpenAI:
 * - response_format must be inside extra_body, not at top level
 * - image-to-image sends reference images via extra_body.image (JSON array), not multipart
 * - does not support n, quality, background, output_format parameters
 * @param {string} prompt
 * @param {string[]} images - reference images as data URLs; empty for text-to-image
 * @param {object} params
 * @param {string} params.size - output size, e.g. "1024x1024" or "auto"
 * @param {number} params.count - number of images to generate (API generates 1 at a time)
 * @param {string} model
 * @param {string} baseUrl
 * @param {string} apiKey
 * @param {function} request
 * @returns {Promise<string[]>} image URLs or data URLs
 */
async function generateImage({
  prompt,
  images,
  params: {
    size,
    count,
  },
  model,
  baseUrl,
  apiKey,
  request,
}) {
  const n = Number(count) || 1;
  const urls = [];

  for (let i = 0; i < n; i++) {
    const body = {
      model: model,
      prompt: prompt,
      size: size && size !== "auto" ? size : "1024x1024",
      extra_body: {
        response_format: "b64_json",
      },
    };

    if (images.length > 0) {
      body.extra_body.image = images;
    }

    const data = await request({
      method: "post",
      url: \`\${baseUrl}/v1/images/generations\`,
      headers: {
        "Content-Type": "application/json",
        Authorization: \`Bearer \${apiKey}\`,
      },
      data: body,
    });

    for (const item of data.data || []) {
      if (item.b64_json) {
        urls.push(\`data:image/png;base64,\${item.b64_json}\`);
      } else if (item.url) {
        urls.push(item.url);
      }
    }
  }
  return urls;
}

return await generateImage({
  prompt,
  images,
  params,
  model,
  baseUrl,
  apiKey,
  request,
});`;

/** 视频默认调用脚本（正确的 URL 路径：result.url，非 result.metadata?.url）。 */
export const DEFAULT_EXTENDED_VIDEO_SCRIPT = `/**
 * 视频生成模板：文生视频、首尾帧控制和图片/音频参考生成。
 * Asynchronous API: create task → poll → retrieve result.
 * Key differences from OpenAI video:
 * - endpoint is POST /v1/videos (JSON body), not multipart
 * - mode is "text" | "keyframe" | "reference" (no media → text; frames → keyframe; otherwise reference)
 * - keyframe uses first_frame/last_frame data URLs; reference uses images[]/audios[] data URLs
 * - size uses resolution like "720P"; output shape is chosen via aspect_ratio
 * - poll endpoint is GET /agnesapi?video_id=...&model_name=... (not /v1/videos/{id})
 * - result URL is at top-level url field once status becomes "completed"
 * @param {string} prompt
 * @param {string[]} images - reference image data URLs; first/last for keyframe, all for reference
 * @param {File[]} videos - reference video Files (unused by some providers, kept for compatibility)
 * @param {File[]} audios - reference audio Files, sent as data URLs in reference mode
 * @param {object} params
 * @param {string} params.mode - "frames" (first/last image) | "reference" | undefined (text-only)
 * @param {string} params.resolution - e.g. "720p" (sent as size "720P")
 * @param {string} params.ratio - aspect ratio, e.g. "16:9"; "auto" is omitted
 * @param {number} params.seconds - target duration in seconds, sent as string
 * @param {string} model
 * @param {string} baseUrl
 * @param {string} apiKey
 * @param {function} request
 * @param {function} poll
 * @returns {Promise<{url:string}>}
 */
async function generateVideo({
  prompt,
  images,
  videos,
  audios,
  params: { mode, resolution, ratio, seconds },
  model,
  baseUrl,
  apiKey,
  request,
  poll,
}) {
  async function toDataUrl(file) {
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  const audioUrls = [];
  for (const file of audios || []) {
    audioUrls.push(await toDataUrl(file));
  }

  const body = {
    model: model,
    prompt: prompt,
    seconds: String(Number(seconds) || 5),
  };
  const resolutionMatch = String(resolution || "").match(/^(\\d+)p$/i);
  if (resolutionMatch) body.size = resolutionMatch[1].toUpperCase() + "P";
  if (ratio && ratio !== "auto") body.aspect_ratio = ratio;

  if (images.length === 0 && audioUrls.length === 0) {
    body.mode = "text";
  } else if (mode === "frames") {
    body.mode = "keyframe";
    if (images[0]) body.first_frame = images[0];
    if (images[1]) body.last_frame = images[1];
  } else {
    body.mode = "reference";
    if (images.length) body.images = images;
    if (audioUrls.length) body.audios = audioUrls;
  }

  // Step 1: create task
  const createRes = await request({
    method: "post",
    url: \`\${baseUrl}/v1/videos\`,
    headers: {
      "Content-Type": "application/json",
      Authorization: \`Bearer \${apiKey}\`,
    },
    data: body,
  });

  const videoId = createRes.video_id || createRes.task_id || createRes.id;
  if (!videoId) throw new Error("video task id missing in create response");

  // Step 2: poll for completion
  const result = await poll(
    async () => {
      const r = await request({
        method: "get",
        url: \`\${baseUrl}/agnesapi\`,
        params: { video_id: videoId, model_name: model },
        headers: { Authorization: \`Bearer \${apiKey}\` },
      });
      return r;
    },
    (r) => {
      if (r.error || r.status === "failed" || r.status === "cancelled") throw new Error(r.error?.message || "Video generation failed");
      if (r.status === "completed" || r.completed_at) {
        if (!r.url) throw new Error("video url missing in task result");
        return r;
      }
      return null;
    },
    { intervalMs: 8000, timeoutMs: 300000 },
  );

  return { url: result.url };
}

return await generateVideo({
  prompt,
  images,
  videos,
  audios,
  params,
  model,
  baseUrl,
  apiKey,
  request,
  poll,
});`;

function migrateModelScripts(channels: ModelChannel[]): ModelChannel[] {
    return channels.map((channel) => ({
        ...channel,
        models: channel.models.map((model) => {
            const script = model.script;
            if (!script) return model;
            // Fix 1: result.metadata?.url → result.url（旧模板错误路径）
            if (script.includes("result.metadata?.url")) {
                return { ...model, script: script.replace("result.metadata?.url", "result.url") };
            }
            // Fix 2: 旧版默认视频脚本（width/height/num_frames 参数）整体替换为新版 mode/size/aspect_ratio 脚本
            if (script.includes("num_frames") && script.includes("frame_rate")) {
                return { ...model, script: DEFAULT_EXTENDED_VIDEO_SCRIPT };
            }
            // Fix 3: 视频脚本轮询缺少 model_name 参数
            if (script.includes("/agnesapi") && script.includes("video_id") && !script.includes("model_name: model")) {
                return { ...model, script: script.replace("params: { video_id: videoId }", "params: { video_id: videoId, model_name: model }") };
            }
            return model;
        }),
    }));
}

function findChannelModel(config: AiConfig, value: string): { channel: ModelChannel; model: ChannelModel } | null {
    const decoded = decodeChannelModel(value);
    const name = decoded?.model || value;
    const channel = decoded ? config.channels.find((item) => item.id === decoded.channelId) : config.channels.find((item) => item.models.some((model) => model.name === name));
    const model = channel?.models.find((item) => item.name === name);
    return channel && model ? { channel, model } : null;
}

export function modelCapabilityOf(config: AiConfig, value: string): ModelCapability | undefined {
    return findChannelModel(config, value)?.model.capability;
}

export function modelMatchesCapability(config: AiConfig, value: string, capability?: ModelCapability) {
    if (!capability) return true;
    return modelCapabilityOf(config, value) === capability;
}

export function resolveModelForCapability(config: AiConfig, currentModel: string | undefined, capability: ModelCapability) {
    const defaultModel = capability === "image" ? config.imageModel : capability === "video" ? config.videoModel : capability === "audio" ? config.audioModel : config.textModel;
    const fallbackModel = capability === "image" ? defaultConfig.imageModel : capability === "video" ? defaultConfig.videoModel : capability === "audio" ? defaultConfig.audioModel : defaultConfig.textModel;
    for (const model of [currentModel, defaultModel]) {
        if (!model) continue;
        const configuredCapability = modelCapabilityOf(config, model);
        // Keep unavailable selections visible so the readiness check blocks the
        // request. Only a known capability switch may choose another model.
        if (!configuredCapability || configuredCapability === capability) return model;
    }
    return fallbackModel;
}

export function selectableModelsByCapability(config: AiConfig, capability?: ModelCapability) {
    if (!capability) return config.models;
    return config.channels.flatMap((channel) => channel.models.filter((model) => model.capability === capability).map((model) => encodeChannelModel(channel.id, model.name)));
}

/** The user script (if any) attached to a model; empty string means use the system default call. */
export function resolveModelScript(config: AiConfig, value: string) {
    return findChannelModel(config, value)?.model.script?.trim() || "";
}

function isAiConfigReady(config: AiConfig, model: string) {
    const channel = resolveModelChannel(config, model);
    return Boolean(model.trim() && channel.baseUrl.trim() && channel.apiKey.trim() && isModelValid(config, model));
}

export const useConfigStore = create<ConfigStore>()(
    persist(
        (set, get) => ({
            config: defaultConfig,
            webdav: defaultWebdavSyncConfig,
            isConfigOpen: false,
            configTab: "channels",
            shouldPromptContinue: false,
            updateConfig: (key, value) =>
                set((state) => ({
                    config: {
                        ...state.config,
                        [key]: value,
                    },
                })),
            importChannelCredentials: (input) => {
                const currentConfig = get().config;
                const result = upsertChannelCredentials(currentConfig, input);
                if (result.config !== currentConfig) set({ config: result.config });
                return { status: result.status, channelName: result.channelName };
            },
            updateWebdavConfig: (key, value) =>
                set((state) => ({
                    webdav: {
                        ...state.webdav,
                        [key]: value,
                    },
                })),
            isAiConfigReady: (config, model) => isAiConfigReady(config, model),
            openConfigDialog: (shouldPromptContinue = false, configTab = "channels") => set({ isConfigOpen: true, shouldPromptContinue, configTab }),
            setConfigDialogOpen: (isConfigOpen) => set({ isConfigOpen }),
            clearPromptContinue: () => set({ shouldPromptContinue: false }),
        }),
        {
            name: CONFIG_STORE_KEY,
            partialize: (state) => ({ config: state.config, webdav: state.webdav }),
            merge: (persisted, current) => {
                const persistedState = (persisted || {}) as Partial<ConfigStore>;
                const persistedConfig = (persistedState.config || {}) as Partial<AiConfig>;
                const persistedWebdav = (persistedState.webdav || {}) as Partial<WebdavSyncConfig>;
                let config = { ...defaultConfig, ...persistedConfig };
                if (!Array.isArray(persistedConfig.channels)) {
                    // 全新安装（无历史渠道、也无旧版单渠道字段）直接采用默认渠道组合；旧配置仍走合并字段兜底
                    config.channels = persistedConfig.baseUrl || persistedConfig.apiKey ? [] : defaultConfig.channels;
                }
                const legacyMigrated = shouldMigrateLegacyDefaults(persistedConfig);
                if (legacyMigrated) config = migrateLegacyDefaults(config);
                const modelRefreshMigrated = shouldMigratePreviousDefaultModels(persistedConfig);
                if (modelRefreshMigrated) config = migratePreviousDefaultModels(config);
                const migratedAgentModel = legacyHarnessAgentModel(persistedConfig);
                if (migratedAgentModel) {
                    try {
                        localStorage.setItem(AGENT_MODEL_MIGRATION_KEY, String(Date.now()));
                    } catch {
                        /* 隐私模式下忽略 */
                    }
                }
                const channels = migrateModelScripts(normalizeChannels(config));
                const models = modelOptionsFromChannels(channels);
                const webdav = { ...defaultWebdavSyncConfig, ...persistedWebdav };
                const mergedConfig: AiConfig = {
                    ...config,
                    channelMode: "local",
                    apiFormat: normalizeApiFormat(config.apiFormat),
                    channels,
                    models,
                    imageModel: normalizeModelOptionValue(config.imageModel || config.model, channels),
                    videoModel: normalizeModelOptionValue(config.videoModel, channels),
                    textModel: normalizeModelOptionValue(migratedAgentModel ? defaultConfig.textModel : config.textModel || config.model, channels),
                    agentModel: normalizeModelOptionValue(
                        typeof config.agentModel === "string" && config.agentModel.trim() ? config.agentModel : migratedAgentModel,
                        channels,
                    ),
                    audioModel: normalizeModelOptionValue(config.audioModel || defaultConfig.audioModel, channels),
                    audioVoice: config.audioVoice || defaultConfig.audioVoice,
                    audioFormat: config.audioFormat || defaultConfig.audioFormat,
                    audioSpeed: config.audioSpeed || defaultConfig.audioSpeed,
                    audioInstructions: config.audioInstructions || "",
                    reasoningEffort: config.reasoningEffort || "auto",
                    videoSeconds: config.videoSeconds || "6",
                    vquality: config.vquality || "720",
                    videoGenerateAudio: config.videoGenerateAudio || "true",
                    videoWatermark: config.videoWatermark || "false",
                    videoMode: config.videoMode === "reference" ? "reference" : "frames",
                    canvasImageCount: config.canvasImageCount || "3",
                    nodeRegenerateBehavior: config.nodeRegenerateBehavior || "new-node",
                    autoFocusOnSelect: Boolean(config.autoFocusOnSelect),
                    imageRatio: config.imageRatio || "auto",
                    videoRatio: config.videoRatio || "auto",
                };
                // persist 的 hydrate 不回写存储，迁移结果要自己落盘，否则下次启动又读到旧默认。
                if (legacyMigrated || modelRefreshMigrated || migratedAgentModel) {
                    try {
                        localStorage.setItem(CONFIG_STORE_KEY, JSON.stringify({ state: { config: mergedConfig, webdav }, version: 0 }));
                    } catch {
                        /* 隐私模式下忽略 */
                    }
                }
                return { ...current, webdav, config: mergedConfig };
            },
        },
    ),
);

export function useEffectiveConfig() {
    const config = useConfigStore((state) => state.config);
    return useMemo(() => ({ ...config, channelMode: "local" as const }), [config]);
}

/** Normalize a mixed list of raw model names or model objects into deduped ChannelModel entries. */
export function normalizeChannelModels(models: Array<string | ChannelModel> | undefined): ChannelModel[] {
    const seen = new Set<string>();
    const result: ChannelModel[] = [];
    for (const item of models || []) {
        const name = (typeof item === "string" ? item : item?.name || "").trim();
        if (!name || seen.has(name)) continue;
        seen.add(name);
        const capability = typeof item === "string" ? guessCapability(name) : item.capability || guessCapability(name);
        const script = typeof item === "string" ? undefined : item.script?.trim() || undefined;
        result.push({ name, capability, script });
    }
    return result;
}

export function createModelChannel(channel?: Partial<ModelChannel>): ModelChannel {
    const apiFormat = normalizeApiFormat(channel?.apiFormat);
    return {
        id: channel?.id?.trim() || nanoid(),
        name: channel?.name?.trim() || i18n.t("config.channels.newName"),
        baseUrl: channel?.baseUrl?.trim() || defaultBaseUrlForApiFormat(apiFormat),
        apiKey: channel?.apiKey || "",
        apiFormat,
        models: normalizeChannelModels(channel?.models),
    };
}

export function upsertChannelCredentials(
    config: AiConfig,
    input: { baseUrl?: string | null; apiKey?: string | null },
): ChannelCredentialsImportResult & { config: AiConfig } {
    const rawBaseUrl = input.baseUrl?.trim() || "";
    if (!rawBaseUrl) return { status: "missing-base-url", config };
    if (!isHttpBaseUrl(rawBaseUrl)) return { status: "invalid-base-url", config };

    const baseUrl = normalizeImportedBaseUrl(rawBaseUrl);
    const apiKey = input.apiKey?.trim() || "";
    const matchingIndex = config.channels.findIndex((channel) => normalizedBaseUrlKey(channel.baseUrl) === normalizedBaseUrlKey(baseUrl));

    if (matchingIndex >= 0) {
        const existing = config.channels[matchingIndex];
        if (existing.baseUrl === baseUrl && (!apiKey || existing.apiKey === apiKey)) {
            return { status: "updated", channelName: existing.name, config };
        }
        const updated = { ...existing, baseUrl, ...(apiKey ? { apiKey } : {}) };
        const channels = config.channels.map((channel, index) => (index === matchingIndex ? updated : channel));
        return { status: "updated", channelName: existing.name, config: { ...config, channels } };
    }

    const channel = createModelChannel({
        name: importedChannelName(baseUrl),
        baseUrl,
        apiKey,
        apiFormat: "openai",
        models: [],
    });
    return { status: "created", channelName: channel.name, config: { ...config, channels: [...config.channels, channel] } };
}

function isHttpBaseUrl(baseUrl: string) {
    try {
        const url = new URL(baseUrl);
        return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.hostname);
    } catch {
        return false;
    }
}

function normalizedBaseUrlKey(baseUrl: string) {
    try {
        return stripTrailingApiVersion(normalizeImportedBaseUrl(baseUrl));
    } catch {
        return stripTrailingApiVersion(baseUrl.trim().replace(/\/+$/, ""));
    }
}

function normalizeImportedBaseUrl(baseUrl: string) {
    const url = new URL(baseUrl.trim());
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
}

function stripTrailingApiVersion(baseUrl: string) {
    return baseUrl.replace(/\/v1$/i, "");
}

function importedChannelName(baseUrl: string) {
    const hostname = new URL(baseUrl).hostname;
    return hostname.replace(/^(?:www|api)\./i, "") || i18n.t("config.channels.newName");
}

export function encodeChannelModel(channelId: string, model: string) {
    return `${channelId}${CHANNEL_MODEL_SEPARATOR}${model.trim()}`;
}

export function isChannelModelValue(value: string) {
    return value.includes(CHANNEL_MODEL_SEPARATOR);
}

export function decodeChannelModel(value: string) {
    const index = value.indexOf(CHANNEL_MODEL_SEPARATOR);
    if (index < 0) return null;
    return { channelId: value.slice(0, index), model: value.slice(index + CHANNEL_MODEL_SEPARATOR.length) };
}

export function modelOptionName(value: string) {
    return decodeChannelModel(value)?.model || value;
}

export function modelOptionLabel(config: AiConfig, value: string) {
    const decoded = decodeChannelModel(value);
    if (!decoded) return value;
    const channel = config.channels.find((item) => item.id === decoded.channelId);
    return channel ? `${decoded.model}（${channel.name}）` : decoded.model;
}

export function modelOptionsFromChannels(channels: ModelChannel[]) {
    return uniqueModelOptions(channels.flatMap((channel) => channel.models.map((model) => encodeChannelModel(channel.id, model.name))));
}

/** Agent 实际使用的模型：显式 agentModel 优先，未设置时跟随 textModel。 */
export function effectiveAgentModel(config: Pick<AiConfig, "agentModel" | "textModel">) {
    return (config.agentModel || "").trim() || config.textModel;
}

export function normalizeModelOptionValue(value: string | undefined, channels: ModelChannel[]) {
    const model = (value || "").trim();
    if (!model) return "";
    const decoded = decodeChannelModel(model);
    if (decoded) {
        const channel = channels.find((item) => item.id === decoded.channelId);
        return channel && channel.models.some((item) => item.name === decoded.model) ? model : model;
    }
    const channel = channels.find((item) => item.models.some((entry) => entry.name === model)) || channels[0];
    return channel && channel.models.some((item) => item.name === model) ? encodeChannelModel(channel.id, model) : model;
}

/** Returns true when the given encoded model option still points to a real channel + model. */
export function isModelValid(config: AiConfig, value: string): boolean {
    if (!value.trim()) return false;
    const decoded = decodeChannelModel(value);
    if (!decoded) return true;
    const channel = config.channels.find((item) => item.id === decoded.channelId);
    return Boolean(channel?.models.some((item) => item.name === decoded.model));
}

export function resolveModelChannel(config: AiConfig, value: string) {
    const decoded = decodeChannelModel(value);
    const model = decoded?.model || value;
    const matched = decoded ? config.channels.find((channel) => channel.id === decoded.channelId) : config.channels.find((channel) => channel.models.some((item) => item.name === model));
    return matched || config.channels[0] || createModelChannel({ id: "default", name: i18n.t("config.channels.defaultName"), baseUrl: config.baseUrl, apiKey: config.apiKey, apiFormat: config.apiFormat, models: config.models.map(modelOptionName).map((name) => ({ name, capability: guessCapability(name) })) });
}

export function resolveModelRequestConfig(config: AiConfig, value: string) {
    const channel = resolveModelChannel(config, value);
    return {
        ...config,
        model: modelOptionName(value || config.model),
        baseUrl: channel.baseUrl,
        apiKey: channel.apiKey,
        apiFormat: channel.apiFormat,
    };
}

function normalizeChannels(config: AiConfig) {
    const persistedChannels = Array.isArray(config.channels) ? config.channels : [];
    const channels = persistedChannels.map((channel, index) =>
        createModelChannel({
            ...channel,
            id: channel.id || (index === 0 ? "default" : `channel-${index + 1}`),
            name: channel.name || (index === 0 ? i18n.t("config.channels.defaultName") : i18n.t("config.channels.indexedName", { index: index + 1 })),
            models: normalizeChannelModels(channel.models),
        }),
    );
    if (!channels.length) {
        channels.push(
            createModelChannel({
                id: "default",
                name: i18n.t("config.channels.defaultName"),
                baseUrl: config.baseUrl || defaultConfig.baseUrl,
                apiKey: config.apiKey || "",
                apiFormat: config.apiFormat || defaultConfig.apiFormat,
                models: normalizeChannelModels([config.model, config.imageModel, config.videoModel, config.textModel, config.audioModel].map(modelOptionName)),
            }),
        );
    }
    return channels;
}

export function defaultBaseUrlForApiFormat(apiFormat: ApiCallFormat) {
    if (apiFormat === "gemini") return GEMINI_BASE_URL;
    return OPENAI_BASE_URL;
}

function normalizeApiFormat(apiFormat: unknown): ApiCallFormat {
    return apiFormat === "gemini" ? apiFormat : "openai";
}

function uniqueModelOptions(models: string[]) {
    return Array.from(new Set((models || []).map((model) => model.trim()).filter(Boolean)));
}

export function buildApiUrl(baseUrl: string, path: string) {
    const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, "");
    const lowerBaseUrl = normalizedBaseUrl.toLowerCase();
    const apiBaseUrl = lowerBaseUrl.endsWith("/v1") ? normalizedBaseUrl : `${normalizedBaseUrl}/v1`;
    return `${apiBaseUrl}${path}`;
}

