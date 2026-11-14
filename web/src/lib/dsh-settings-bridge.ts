/**
 * DSH「无限画布 / 3D 导演台」设置桥。
 *
 * 两种运行位置：
 *   - 宿主设置页里的 iframe（URL 带 `dshSettingsToken`）：与父窗口收发 `dsh-settings:*`，
 *     并作为中继，把共享设置经 BroadcastChannel 同步给面板「新窗口」（URL 带 `dshWindow=1`）。
 *   - 面板「新窗口」打开的页面：不带令牌，经 BroadcastChannel 向 iframe 要快照、
 *     把本地编辑回传给面板；面板没开时保持惰性，只用本地配置。
 *
 * 边界：
 *   - 两个项目在宿主设置文件里各占一个 projects.<id> 分区（渠道 + 默认值），
 *     本模块只读写自己那一份；连接时以宿主较新的分区为准覆盖本地，
 *     本地较新的修改经面板写回宿主（面板负责打时间戳）。
 *   - 应用设置期间不回传，避免与其它窗口形成回声循环。
 *   - 密钥只在本机 localStorage 与 ~/.dsh 文件之间流动，不经过任何网络。
 *   - 中继只在面板 iframe 打开时存在；新窗口独立运行时退回纯本地配置。
 *
 * 两个项目的这份文件逐字节一致；项目 id 由 `initDshSettingsBridge` 传入。
 */

import {
    createModelChannel,
    modelOptionsFromChannels,
    normalizeChannelModels,
    useConfigStore,
    type AiConfig,
    type ModelCapability,
    type ModelChannel,
} from "@/stores/use-config-store";

type SharedModel = { name: string; capability?: string; script?: string };
type SharedChannel = {
    id: string;
    name: string;
    baseUrl: string;
    apiKey: string;
    apiFormat?: string;
    models?: SharedModel[];
};
type SharedSettings = {
    channels?: SharedChannel[];
    channelsUpdatedAt?: number;
    projects?: Record<string, Record<string, unknown>>;
};

type RelayMessage =
    | { type: "hello"; sender: string }
    | { type: "snapshot"; target: string; settings: SharedSettings | null }
    | { type: "apply"; settings: SharedSettings }
    | { type: "report"; sender: string; channels: ModelChannel[]; project: Record<string, unknown> };

const CHANNELS_META_PREFIX = "haitang-aigc:channels-updated-at:";
const PROJECT_META_PREFIX = "haitang-aigc:project-updated-at:";
const LEGACY_MIGRATION_KEY = "haitang-aigc:legacy-default-migrated-at";
const AGENT_MODEL_MIGRATION_KEY = "haitang-aigc:agent-model-migrated-at";
const MODEL_REFRESH_MIGRATION_KEY = "haitang-aigc:model-refresh-migrated-at";
const APPLY_SILENCE_MS = 800;
const RELAY_CHANNEL_PREFIX = "haitang-aigc:dsh-settings-relay:";
const WINDOW_FLAG = "dshWindow";
const RELAY_HELLO_RETRY_MS = 800;
const RELAY_HELLO_ATTEMPTS = 6;
const RELAY_HEARTBEAT_MS = 15_000;

function channelsMetaKey(projectId: string): string {
    return CHANNELS_META_PREFIX + projectId;
}

const TEXT_FIELDS = [
    "textModel",
    "agentModel",
    "imageModel",
    "videoModel",
    "audioModel",
    "imageRatio",
    "videoRatio",
    "videoSeconds",
    "canvasImageCount",
    "vquality",
    "videoGenerateAudio",
    "videoWatermark",
] as const;

function readMeta(key: string): number {
    try {
        return Number(localStorage.getItem(key)) || 0;
    } catch {
        return 0;
    }
}

function writeMeta(key: string, value: number) {
    try {
        localStorage.setItem(key, String(value));
    } catch {
        /* 隐私模式下忽略 */
    }
}

function readParam(name: string): string {
    try {
        return new URLSearchParams(window.location.search).get(name) || "";
    } catch {
        return "";
    }
}

function openRelay(projectId: string): BroadcastChannel | null {
    if (typeof BroadcastChannel === "undefined") return null;
    try {
        return new BroadcastChannel(RELAY_CHANNEL_PREFIX + projectId);
    } catch {
        return null;
    }
}

function toChannels(input: SharedChannel[]): ModelChannel[] {
    return input.map((channel) =>
        createModelChannel({
            id: channel.id,
            name: channel.name,
            baseUrl: channel.baseUrl,
            apiKey: channel.apiKey,
            // 画布只支持 openai/gemini，导演台还支持 anthropic；store 会归一化不支持的值。
            apiFormat: (channel.apiFormat === "gemini" || channel.apiFormat === "anthropic"
                ? channel.apiFormat
                : "openai") as ModelChannel["apiFormat"],
            models: normalizeChannelModels(
                (channel.models || []).map((model) => ({
                    name: model.name,
                    capability: (model.capability || "text") as ModelCapability,
                    ...(model.script ? { script: model.script } : {}),
                })),
            ),
        }),
    );
}

/**
 * 应用共享设置；只在对应分区时间戳更新时覆盖本地。返回是否改动了配置。
 *
 * `force` 用于同源中继下发：iframe 与本窗口共享 localStorage，分区时间戳常已相等，
 * 用 `>=` 才会让新窗口跟上；时间戳更旧时仍不覆盖。
 */
function applySharedSettings(settings: SharedSettings, projectId: string, force = false): boolean {
    const current = useConfigStore.getState().config;
    let config = current;
    let changed = false;

    const project = settings.projects?.[projectId];
    // v2 起渠道在项目分区里；旧宿主只给顶层 channels 时继续兼容。
    const scopedChannels = project && Array.isArray(project.channels) ? project.channels : settings.channels;
    const channelsAt = project && Array.isArray(project.channels)
        ? Number(project.channelsUpdatedAt) || 0
        : Number(settings.channelsUpdatedAt) || 0;
    const localChannelsAt = readMeta(channelsMetaKey(projectId));
    const channelsFresh = force ? channelsAt >= localChannelsAt : channelsAt > localChannelsAt;
    if (Array.isArray(scopedChannels) && channelsFresh) {
        const channels = toChannels(scopedChannels as SharedChannel[]);
        if (JSON.stringify(channels) !== JSON.stringify(current.channels)) {
            config = { ...config, channels, models: modelOptionsFromChannels(channels) };
            changed = true;
        }
        writeMeta(channelsMetaKey(projectId), Math.max(channelsAt, localChannelsAt));
    }

    if (project && typeof project === "object") {
        const updatedAt = Number(project.updatedAt) || 0;
        const metaKey = PROJECT_META_PREFIX + projectId;
        const localUpdatedAt = readMeta(metaKey);
        const projectFresh = force ? updatedAt >= localUpdatedAt : updatedAt > localUpdatedAt;
        if (projectFresh) {
            const patch: Record<string, unknown> = {};
            for (const field of TEXT_FIELDS) {
                const value = project[field];
                if (typeof value === "string" && current[field] !== value) patch[field] = value;
            }
            if (typeof project.autoFocusOnSelect === "boolean" && current.autoFocusOnSelect !== project.autoFocusOnSelect) {
                patch.autoFocusOnSelect = project.autoFocusOnSelect;
            }
            if (
                (project.nodeRegenerateBehavior === "new-node" || project.nodeRegenerateBehavior === "overwrite") &&
                current.nodeRegenerateBehavior !== project.nodeRegenerateBehavior
            ) {
                patch.nodeRegenerateBehavior = project.nodeRegenerateBehavior;
            }
            if (
                (project.videoMode === "frames" || project.videoMode === "reference") &&
                current.videoMode !== project.videoMode
            ) {
                patch.videoMode = project.videoMode;
            }
            if (Object.keys(patch).length) {
                config = { ...config, ...patch } as AiConfig;
                changed = true;
            }
            writeMeta(metaKey, Math.max(updatedAt, localUpdatedAt));
        }
    }

    if (changed) useConfigStore.setState({ config });
    return changed;
}

function projectSnapshot(config: AiConfig): Record<string, unknown> {
    const project: Record<string, unknown> = {};
    for (const field of TEXT_FIELDS) project[field] = config[field];
    project.autoFocusOnSelect = config.autoFocusOnSelect;
    project.nodeRegenerateBehavior = config.nodeRegenerateBehavior;
    project.videoMode = config.videoMode;
    return project;
}

/**
 * 消费一次性迁移标记：旧默认渠道刚在本机被替换、旧版 Agent 选择刚从 textModel 搬到
 * agentModel、或旧默认模型刚刷新时，把本项目两个分区的时间戳抬到迁移时刻，
 * 否则宿主里更早的值会在 apply 时覆盖回来。返回迁移时刻（0 表示没有迁移）。
 */
function consumeMigrationMarkers(projectId: string): number {
    let migratedAt = 0;
    try {
        for (const key of [LEGACY_MIGRATION_KEY, AGENT_MODEL_MIGRATION_KEY, MODEL_REFRESH_MIGRATION_KEY]) {
            const value = Number(localStorage.getItem(key)) || 0;
            if (!value) continue;
            localStorage.removeItem(key);
            migratedAt = Math.max(migratedAt, value);
        }
    } catch {
        /* 隐私模式下忽略 */
    }
    if (migratedAt) {
        writeMeta(channelsMetaKey(projectId), Math.max(migratedAt, readMeta(channelsMetaKey(projectId))));
        writeMeta(PROJECT_META_PREFIX + projectId, Math.max(migratedAt, readMeta(PROJECT_META_PREFIX + projectId)));
    }
    return migratedAt;
}

/** 面板 iframe：与宿主收发设置，同时作为同源中继服务「新窗口」。 */
function initHostSettingsRelay(projectId: string, token: string) {
    const parent = window.parent;
    const relay = openRelay(projectId);
    let applying = false;
    let lastReported = "";
    let lastSettings: SharedSettings | null = null;
    const migratedAt = consumeMigrationMarkers(projectId);

    const post = (message: Record<string, unknown>) => {
        try {
            // 注意：消息体里的 `project` 是项目快照；标识用独立字段，否则会把快照覆盖成字符串。
            parent.postMessage({ ...message, token, dshSettingsProject: projectId }, "*");
        } catch {
            /* 父窗口已关闭 */
        }
    };

    const report = () => {
        if (applying) return;
        const config = useConfigStore.getState().config;
        const payload = { channels: config.channels, project: projectSnapshot(config) };
        const serialized = JSON.stringify(payload);
        if (serialized === lastReported) return;
        lastReported = serialized;
        post({ type: "dsh-settings:report", ...payload });
    };

    // 新窗口握手：回快照（可能还没有值得下发的宿主设置）并转发它的本地编辑。
    relay?.addEventListener("message", (event) => {
        const data = event.data as RelayMessage;
        if (!data || typeof data !== "object") return;
        if (data.type === "hello" && typeof data.sender === "string") {
            relay?.postMessage({ type: "snapshot", target: data.sender, settings: lastSettings });
        } else if (data.type === "report" && Array.isArray(data.channels) && data.project && typeof data.project === "object") {
            post({ type: "dsh-settings:report", channels: data.channels, project: data.project });
        }
    });

    window.addEventListener("message", (event) => {
        if (event.source !== parent) return;
        const data = event.data;
        if (!data || typeof data !== "object" || data.token !== token) return;
        if (data.type !== "dsh-settings:apply") return;

        const settings = (data.settings && typeof data.settings === "object" ? data.settings : {}) as SharedSettings;
        lastSettings = settings;
        applying = true;
        applySharedSettings(settings, projectId);
        // 应用后的同步写盘不算用户编辑；短暂静默后把当前值记为已上报，避免回声。
        window.setTimeout(() => {
            applying = false;
            const config = useConfigStore.getState().config;
            lastReported = JSON.stringify({ channels: config.channels, project: projectSnapshot(config) });
        }, APPLY_SILENCE_MS);
        relay?.postMessage({ type: "apply", settings });

        // 宿主还没有对应分区（首次使用或刚清空）时，把本地现有配置播种上去。
        const hostProject = settings.projects?.[projectId];
        const hostChannelsAt = Number(hostProject?.channelsUpdatedAt) || Number(settings.channelsUpdatedAt) || 0;
        const hostProjectAt = Number(hostProject?.updatedAt) || 0;
        if (!hostChannelsAt || !hostProjectAt) {
            // 清掉回声哨兵：否则 800ms 后写入的 lastReported 会让这次播种被当成重复上报。
            window.setTimeout(() => {
                lastReported = "";
                report();
            }, APPLY_SILENCE_MS + 100);
        }
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    useConfigStore.subscribe(() => {
        if (applying) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(report, 600);
    });

    // 通知宿主：页面已就绪，可以下发共享设置了。
    post({ type: "dsh-settings:ready" });

    // 迁移后的新渠道要写回宿主；等宿主这次下发结束（applying 复位）再发，避免回声。
    if (migratedAt) {
        const flushMigrated = (attempt: number) => {
            window.setTimeout(() => {
                if (applying) {
                    if (attempt < 4) flushMigrated(attempt + 1);
                    return;
                }
                lastReported = "";
                report();
            }, APPLY_SILENCE_MS + 200);
        };
        flushMigrated(0);
    }
}

/** 面板「新窗口」：经同源中继跟随 iframe 里的共享设置，并把本地编辑回传。 */
function initChildSettingsRelay(projectId: string) {
    const relay = openRelay(projectId);
    if (!relay) return;

    const sender = Math.random().toString(36).slice(2) + Date.now().toString(36);
    let applying = false;
    let connected = false;
    let lastReported = "";
    let helloAttempts = 0;
    let helloTimer: number | undefined;
    const migratedAt = consumeMigrationMarkers(projectId);

    const report = () => {
        if (applying) return;
        const config = useConfigStore.getState().config;
        const payload = { sender, channels: config.channels, project: projectSnapshot(config) };
        const serialized = JSON.stringify(payload);
        if (serialized === lastReported) return;
        lastReported = serialized;
        relay.postMessage({ type: "report", ...payload });
    };

    const applyFromRelay = (settings: SharedSettings) => {
        applying = true;
        if (!applySharedSettings(settings, projectId, true)) {
            applying = false;
            return;
        }
        window.setTimeout(() => {
            applying = false;
            const config = useConfigStore.getState().config;
            lastReported = JSON.stringify({ sender, channels: config.channels, project: projectSnapshot(config) });
        }, APPLY_SILENCE_MS);
    };

    const sendHello = () => relay.postMessage({ type: "hello", sender });
    const scheduleHello = () => {
        if (helloTimer) clearTimeout(helloTimer);
        helloTimer = window.setTimeout(() => {
            if (connected || helloAttempts >= RELAY_HELLO_ATTEMPTS) return;
            helloAttempts += 1;
            sendHello();
            scheduleHello();
        }, RELAY_HELLO_RETRY_MS);
    };
    sendHello();
    scheduleHello();
    // 面板 iframe 可能晚于本窗口打开或刷新；低频握手让快照能重新送达。
    window.setInterval(sendHello, RELAY_HEARTBEAT_MS);

    relay.addEventListener("message", (event) => {
        const data = event.data as RelayMessage;
        if (!data || typeof data !== "object") return;
        if (data.type === "snapshot" && data.target === sender) {
            connected = true;
            if (helloTimer) clearTimeout(helloTimer);
            const settings = data.settings && typeof data.settings === "object"
                ? (data.settings as SharedSettings)
                : null;
            if (settings) applyFromRelay(settings);
            // 本地比宿主新（迁移后或宿主还没收到过本窗口的编辑）时补报一次。
            const remote = settings?.projects?.[projectId];
            const remoteChannelsAt = Number(remote?.channelsUpdatedAt) || Number(settings?.channelsUpdatedAt) || 0;
            const remoteProjectAt = Number(remote?.updatedAt) || 0;
            const localChannelsAt = readMeta(channelsMetaKey(projectId));
            const localProjectAt = readMeta(PROJECT_META_PREFIX + projectId);
            if (localChannelsAt > remoteChannelsAt || localProjectAt > remoteProjectAt) {
                window.setTimeout(() => {
                    if (applying) return;
                    lastReported = "";
                    report();
                }, settings ? APPLY_SILENCE_MS + 100 : 0);
            }
            return;
        }
        if (data.type === "apply" && data.settings && typeof data.settings === "object") {
            applyFromRelay(data.settings as SharedSettings);
        }
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    useConfigStore.subscribe(() => {
        if (applying) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(report, 600);
    });

    // 迁移结果在连上面板后要写回宿主，否则宿主里更早的值会盖回来。
    if (migratedAt) {
        const flushMigrated = (attempt: number) => {
            window.setTimeout(() => {
                if (applying) {
                    if (attempt < 4) flushMigrated(attempt + 1);
                    return;
                }
                lastReported = "";
                report();
            }, APPLY_SILENCE_MS + 200);
        };
        flushMigrated(0);
    }
}

/**
 * 挂上共享设置桥。必须在应用渲染前调用。
 *
 * @param projectId - `infinite-canvas` 或 `director-desk`，与宿主共享设置里的分区一致。
 */
export function initDshSettingsBridge(projectId: string) {
    if (typeof window === "undefined") return;
    const token = readParam("dshSettingsToken");
    if (token && window.parent !== window) {
        initHostSettingsRelay(projectId, token);
        return;
    }
    if (readParam(WINDOW_FLAG) !== "1") return;
    initChildSettingsRelay(projectId);
}
