import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import matter from "gray-matter";

import { SkillStore, SkillStoreError, type ManagedSkillInterface } from "./store.js";

/** Skill 来源：项目（工作区）与个人（本机用户目录）可编辑；系统（随安装分发）只读。 */
export type SkillScope = "repo" | "user" | "system";
export const SKILL_SCOPES: readonly SkillScope[] = ["repo", "user", "system"];
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type SkillSourceSummary = {
    name: string;
    description: string;
    shortDescription?: string;
    interface?: ManagedSkillInterface;
    path: string;
    scope: SkillScope;
    enabled: boolean;
    managed: boolean;
};

type ScopeRoot = { root: string; parent: string; writable: boolean };

function userCanvasDir() {
    return path.join(os.homedir(), ".infinite-canvas");
}

function builtinSkillsRoot() {
    // dev 经 tsx 从 src/ 运行；打包后从 dist/ 运行，均取 canvas-agent 包根下的 builtin-skills。
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "builtin-skills");
}

/** 启停状态持久化：{ "scope:name": boolean }；缺省视为已启用。 */
function stateFilePath() {
    return path.join(userCanvasDir(), "skills-state.json");
}

async function readStateFile(): Promise<Record<string, boolean>> {
    try {
        const parsed = JSON.parse(await fs.readFile(stateFilePath(), "utf8")) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
        const result: Record<string, boolean> = {};
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
            if (typeof value === "boolean") result[key] = value;
        }
        return result;
    } catch {
        return {};
    }
}

async function writeStateFile(state: Record<string, boolean>) {
    await fs.mkdir(userCanvasDir(), { recursive: true });
    await fs.writeFile(stateFilePath(), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

/** 容错解析一个只读来源目录中的 Skill（缺 SKILL.md 或命名不合规的目录跳过）。 */
async function listReadOnlyScope(scope: SkillScope, root: string): Promise<{ skills: SkillSourceSummary[]; errors: string[] }> {
    const skills: SkillSourceSummary[] = [];
    const errors: string[] = [];
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".") || !NAME_PATTERN.test(entry.name)) continue;
        const skillFile = path.join(root, entry.name, "SKILL.md");
        try {
            const document = matter(await fs.readFile(skillFile, "utf8"));
            const description = String(document.data?.description || "").trim();
            if (!description) throw new SkillStoreError("缺少 description", 400);
            const openAiPath = path.join(root, entry.name, "agents", "openai.yaml");
            const interfaceValue = await fs.readFile(openAiPath, "utf8").then((raw) => {
                try {
                    const parsed = JSON.parse(raw) as { interface?: ManagedSkillInterface };
                    return parsed?.interface && typeof parsed.interface === "object" ? parsed.interface : undefined;
                } catch {
                    return undefined;
                }
            }).catch(() => undefined);
            skills.push({
                name: entry.name,
                description,
                ...(interfaceValue?.shortDescription ? { shortDescription: interfaceValue.shortDescription } : {}),
                ...(interfaceValue ? { interface: interfaceValue } : {}),
                path: skillFile,
                scope,
                enabled: true,
                managed: false,
            });
        } catch (error) {
            errors.push(`${scope}/${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    return { skills, errors };
}

/** 聚合四个来源的 Skill 管理：列表、启停、全文读取与可写来源的增删改。 */
export class SkillManager {
    private readonly repoStore: SkillStore;
    private readonly userStore: SkillStore;
    private readonly roots: Record<SkillScope, ScopeRoot>;

    constructor(workspacePath: string) {
        const workspace = path.resolve(workspacePath);
        const repoRoot = path.join(workspace, ".agents", "skills");
        const userParent = userCanvasDir();
        this.roots = {
            repo: { root: repoRoot, parent: workspace, writable: true },
            user: { root: path.join(userParent, "skills"), parent: userParent, writable: true },
            system: { root: builtinSkillsRoot(), parent: path.dirname(builtinSkillsRoot()), writable: false },
        };
        this.repoStore = new SkillStore(this.roots.repo.root, this.roots.repo.parent);
        this.userStore = new SkillStore(this.roots.user.root, this.roots.user.parent, { createParent: true });
    }

    store(scope: SkillScope): SkillStore {
        if (scope === "repo") return this.repoStore;
        if (scope === "user") return this.userStore;
        throw new SkillStoreError("该来源只读，不能修改 Skill", 403);
    }

    writable(scope: SkillScope) {
        return this.roots[scope]?.writable === true;
    }

    /** 聚合四来源列表；单个来源失败记入 errors，不影响其他来源。 */
    async list(): Promise<{ skills: SkillSourceSummary[]; errors: string[] }> {
        const state = await readStateFile();
        const skills: SkillSourceSummary[] = [];
        const errors: string[] = [];
        for (const scope of SKILL_SCOPES) {
            const { root, writable } = this.roots[scope];
            try {
                if (writable) {
                    for (const item of await this.store(scope).list()) {
                        skills.push({ ...item, scope, enabled: state[`${scope}:${item.name}`] !== false });
                    }
                } else {
                    const parsed = await listReadOnlyScope(scope, root);
                    skills.push(...parsed.skills.map((item) => ({ ...item, enabled: state[`${scope}:${item.name}`] !== false })));
                    errors.push(...parsed.errors);
                }
            } catch (error) {
                errors.push(`${scope}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        return { skills, errors };
    }

    async setEnabled(scope: SkillScope, name: string, enabled: boolean) {
        if (!NAME_PATTERN.test(name)) throw new SkillStoreError("Skill 名称无效", 400);
        if (!this.writable(scope) && !(await this.readOnlyScopeHasSkill(scope, name))) throw new SkillStoreError("找不到指定 Skill", 404);
        const state = await readStateFile();
        state[`${scope}:${name}`] = enabled;
        await writeStateFile(state);
    }

    private async readOnlyScopeHasSkill(scope: SkillScope, name: string) {
        const skillFile = path.join(this.roots[scope].root, name, "SKILL.md");
        try {
            const entry = await fs.lstat(skillFile);
            return entry.isFile();
        } catch {
            return false;
        }
    }

    /** 读取一个 Skill 的完整指令正文（供渠道引擎的 skill_read 工具使用）。 */
    async readInstructions(scope: SkillScope, name: string): Promise<{ name: string; description: string; instructions: string }> {
        if (!NAME_PATTERN.test(name)) throw new SkillStoreError("Skill 名称无效", 400);
        const skillFile = path.join(this.roots[scope].root, name, "SKILL.md");
        const relative = path.relative(this.roots[scope].root, skillFile);
        if (relative.startsWith("..") || path.isAbsolute(relative)) throw new SkillStoreError("Skill 路径不安全", 400);
        let raw: string;
        try {
            raw = await fs.readFile(skillFile, "utf8");
        } catch {
            throw new SkillStoreError("找不到指定 Skill", 404);
        }
        const document = matter(raw);
        return { name, description: String(document.data?.description || "").trim(), instructions: document.content.trim() };
    }
}
