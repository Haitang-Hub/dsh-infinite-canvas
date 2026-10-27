import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_PORT = 17371;
/**
 * 配置与运行数据的落点：默认 ~/.infinite-canvas；被 Harness 插件托管时经
 * CANVAS_AGENT_HOME 指到 dshHomePath('infinite-canvas')，卸载插件不删数据。
 */
export const CONFIG_DIR = path.join(
    process.env.CANVAS_AGENT_HOME?.trim() || path.join(os.homedir(), ".infinite-canvas"),
);
export const CONFIG_FILE = path.join(CONFIG_DIR, "canvas-agent.json");
export const CODEX_CONFIG_FILE = path.join(os.homedir(), ".codex", "config.toml");
let pinnedCodexModelCache: string | null | undefined;

/**
 * 读取 ~/.codex/config.toml 中自定义 model_provider 固定的模型。
 * 仅当 provider 不是内置 openai 且显式配置了 model 时返回模型名，
 * 让网页端模型列表和 turn 请求与本地 Codex 配置保持一致，进程内只读取一次。
 */
export function getPinnedCodexModel(): string | undefined {
    if (pinnedCodexModelCache !== undefined) return pinnedCodexModelCache ?? undefined;
    pinnedCodexModelCache = null;
    try {
        const scalars = parseTopLevelTomlScalars(fs.readFileSync(CODEX_CONFIG_FILE, "utf8"));
        const provider = scalars.model_provider;
        const model = scalars.model?.trim();
        if (provider && provider !== "openai" && model) pinnedCodexModelCache = model;
    } catch {
        // 没有 Codex 配置文件时按默认 OpenAI 目录处理。
    }
    return pinnedCodexModelCache ?? undefined;
}

/** 只提取 TOML 顶层 key = "value" 形式的字符串标量，忽略注释和各个 [section]。 */
function parseTopLevelTomlScalars(text: string): Record<string, string> {
    const result: Record<string, string> = {};
    let passedFirstTable = false;
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (/^\[[^\]]*]$/.test(line)) {
            passedFirstTable = true;
            continue;
        }
        if (passedFirstTable || !line || line.startsWith("#")) continue;
        const match = line.match(/^([A-Za-z0-9_-]+)\s*=\s*"([^"]*)"/);
        if (match) result[match[1]] = match[2];
    }
    return result;
}

/** 依次尝试多个候选路径读取文本文件（tsc dist 与 esbuild 单文件布局层数不同）。 */
function readBundledFile(candidates: URL[]): string {
    for (const candidate of candidates) {
        try {
            return fs.readFileSync(candidate, "utf8");
        } catch {
            // 尝试下一个布局。
        }
    }
    return "";
}

export const VERSION = readPackageVersion();
export const AGENT_PROMPT = readBundledFile([
    // esbuild 单文件布局：bundle 与资源同目录（优先；上层可能是 dsh-plugin 包根，内容不同）。
    new URL("./agent-instructions.md", import.meta.url),
    // 源码/dist 布局：本文件位于 src/（或 dist/），资源在包根。
    new URL("../agent-instructions.md", import.meta.url),
]);
const initializedWorkspaces = new Set<string>();

export type SiteWorkspaceConfig = { workspacePath: string; activeThreadId?: string; pinnedThreadIds?: string[] };
export type CanvasAgentConfig = { url: string; token: string; origins?: string[]; workspace?: SiteWorkspaceConfig };

/** 读取本地 Canvas Agent 配置，不存在时生成默认配置。 */
export function loadConfig(create = false): CanvasAgentConfig {
    try {
        return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) as CanvasAgentConfig;
    } catch {
        const config = { url: `http://127.0.0.1:${Number(process.env.PORT) || DEFAULT_PORT}`, token: crypto.randomBytes(18).toString("hex") };
        if (create) saveConfig(config);
        return config;
    }
}

/** 将 Canvas Agent 配置写入用户配置目录。 */
export function saveConfig(config: CanvasAgentConfig) {
    writeConfigFile(CONFIG_DIR, CONFIG_FILE, config);
}

/** 写入配置并强制目录 0700、文件 0600，包括纠正已有宽松权限。 */
export function writeConfigFile(dir: string, file: string, config: CanvasAgentConfig) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o600 });
    fs.chmodSync(dir, 0o700);
    fs.chmodSync(file, 0o600);
}

/** 确保站点级 Codex 工作空间存在并已初始化。 */
export function ensureSiteWorkspace(config: CanvasAgentConfig) {
    const current = config.workspace;
    if (current?.workspacePath) {
        const workspacePath = resolveWorkspacePath(current.workspacePath);
        initializeWorkspace(workspacePath);
        return { ...current, workspacePath };
    }
    const workspacePath = path.join(CONFIG_DIR, "codex-workspaces", "site");
    config.workspace = { workspacePath };
    initializeWorkspace(workspacePath);
    saveConfig(config);
    return { workspacePath };
}

/** 更新站点级 Codex 工作空间配置。 */
export function updateSiteWorkspace(config: CanvasAgentConfig, patch: Partial<SiteWorkspaceConfig>) {
    const current = ensureSiteWorkspace(config);
    const workspacePath = patch.workspacePath ? resolveWorkspacePath(patch.workspacePath) : current.workspacePath;
    const next = { ...current, ...patch, workspacePath };
    config.workspace = { workspacePath: next.workspacePath, activeThreadId: next.activeThreadId, pinnedThreadIds: next.pinnedThreadIds };
    initializeWorkspace(workspacePath);
    saveConfig(config);
    return config.workspace;
}

/** 创建工作空间目录并写入默认 AGENTS.md。 */
function initializeWorkspace(workspacePath: string) {
    if (initializedWorkspaces.has(workspacePath)) return;
    fs.mkdirSync(workspacePath, { recursive: true });
    const instructionsFile = path.join(workspacePath, "AGENTS.md");
    const current = fs.existsSync(instructionsFile) ? fs.readFileSync(instructionsFile, "utf8") : "";
    if (!current || current.startsWith("# Infinite Canvas Agent")) fs.writeFileSync(instructionsFile, AGENT_PROMPT);
    initializedWorkspaces.add(workspacePath);
}

/** 将用户输入的工作空间路径解析为绝对路径。 */
function resolveWorkspacePath(value: string) {
    if (value === "~") return os.homedir();
    if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
    return path.resolve(value);
}

/** 从当前包信息中读取 Canvas Agent 版本号。 */
function readPackageVersion() {
    const text = readBundledFile([
        // esbuild 单文件布局：随 bundle 复制的本包 package.json（优先）。
        new URL("./package.json", import.meta.url),
        // 源码/dist 布局：本文件位于 src/（或 dist/），package.json 在包根。
        new URL("../package.json", import.meta.url),
    ]);
    try {
        return JSON.parse(text).version || "0.0.0";
    } catch {
        return "0.0.0";
    }
}
