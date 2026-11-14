import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 开发态默认端口（直接 `npm run dev`、未设 PORT 时）。与 Desktop 插件桥统一为
 * 17371（2026-11-14 起）：插件托管形态 spawn 时仍显式传 PORT（dsh/index.js 的
 * Config.port），同一端口先到先得，start.ps1 探测 /health 健康后直接复用，不再双端口错开。
 */
export const DEFAULT_PORT = 17371;
/**
 * 配置与运行数据的落点：默认 ~/.infinite-canvas；被 Harness 插件托管时经
 * CANVAS_AGENT_HOME 指到 dshHomePath('infinite-canvas')，卸载插件不删数据。
 */
export const CONFIG_DIR = path.join(
    process.env.CANVAS_AGENT_HOME?.trim() || path.join(os.homedir(), ".infinite-canvas"),
);
export const CONFIG_FILE = path.join(CONFIG_DIR, "canvas-agent.json");

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
    // CANVAS_AGENT_TOKEN 可固定 Connect token（harness 插件设置里配置后经 spawn 注入），
    // 优先级最高：已落盘的 token 也被覆盖，保证重启后 token 与设置一致。
    const envToken = process.env.CANVAS_AGENT_TOKEN?.trim();
    try {
        const config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) as CanvasAgentConfig;
        return envToken ? { ...config, token: envToken } : config;
    } catch {
        const config = { url: `http://127.0.0.1:${Number(process.env.PORT) || DEFAULT_PORT}`, token: envToken || crypto.randomBytes(18).toString("hex") };
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

/** 工作空间根目录：旧名 codex-workspaces（引擎已不是 Agent，2026-11-14 起更名）。 */
const LEGACY_WORKSPACES_DIR = path.join(CONFIG_DIR, "codex-workspaces");
const WORKSPACES_DIR = path.join(CONFIG_DIR, "agent-workspaces");

/** 旧目录一次性迁移：codex-workspaces → agent-workspaces（改完即返回，不重复做）。 */
function ensureWorkspacesDirMigrated() {
    if (fs.existsSync(LEGACY_WORKSPACES_DIR) && !fs.existsSync(WORKSPACES_DIR)) {
        try {
            fs.renameSync(LEGACY_WORKSPACES_DIR, WORKSPACES_DIR);
        } catch {
            // 迁移失败（占用/权限）不阻断启动，按新目录重新创建。
        }
    }
}

/** 确保站点级 Agent 工作空间存在并已初始化。 */
export function ensureSiteWorkspace(config: CanvasAgentConfig) {
    ensureWorkspacesDirMigrated();
    const current = config.workspace;
    if (current?.workspacePath) {
        const workspacePath = resolveWorkspacePath(current.workspacePath);
        if (workspacePath.startsWith(LEGACY_WORKSPACES_DIR)) {
            // 旧配置里持久化的工作空间路径指向旧目录：改指新目录并落盘。
            const migratedPath = path.join(WORKSPACES_DIR, "site");
            initializeWorkspace(migratedPath);
            config.workspace = { ...current, workspacePath: migratedPath };
            saveConfig(config);
            return { ...current, workspacePath: migratedPath };
        }
        initializeWorkspace(workspacePath);
        return { ...current, workspacePath };
    }
    const workspacePath = path.join(WORKSPACES_DIR, "site");
    config.workspace = { workspacePath };
    initializeWorkspace(workspacePath);
    saveConfig(config);
    return { workspacePath };
}

/** 更新站点级 Agent 工作空间配置。 */
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
