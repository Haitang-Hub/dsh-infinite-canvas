import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import { nanoid } from "nanoid";
import i18n from "@/i18n";
import { localForageStorage, registerKvMergeHook } from "@/lib/localforage-storage";
import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import type { CanvasAssistantSession, CanvasConnection, CanvasNodeData, ViewportTransform } from "@/types/canvas";

export type CanvasProject = {
    id: string;
    /** 自增工程编号（#0001），用于界面查找与 URL 直链访问。 */
    no: number;
    title: string;
    createdAt: string;
    updatedAt: string;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    chatSessions: CanvasAssistantSession[];
    activeChatId: string | null;
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
    viewport: ViewportTransform;
};

export type CanvasDeletedProject = {
    id: string;
    deletedAt: string;
};

type CanvasStore = {
    hydrated: boolean;
    projects: CanvasProject[];
    deletedProjects: CanvasDeletedProject[];
    lastProjectId: string | null;
    createProject: (title?: string) => string;
    importProject: (project: Partial<CanvasProject>) => string;
    openProject: (id: string) => CanvasProject | null;
    /** 按 id 或工程编号查找工程（编号接受 "1" / "0001" 两种形式）。 */
    resolveProject: (idOrNo: string) => CanvasProject | null;
    renameProject: (id: string, title: string) => void;
    deleteProjects: (ids: string[]) => void;
    replaceProjects: (projects: CanvasProject[], deletedProjects?: CanvasDeletedProject[]) => void;
    setLastProjectId: (id: string) => void;
    updateProject: (id: string, patch: Partial<Pick<CanvasProject, "nodes" | "connections" | "chatSessions" | "activeChatId" | "backgroundMode" | "showImageInfo" | "viewport">>) => void;
};

const initialViewport: ViewportTransform = { x: 0, y: 0, k: 1 };
const CANVAS_STORE_KEY = "infinite-canvas:canvas_store";
type PersistedCanvasState = Pick<CanvasStore, "projects" | "deletedProjects" | "lastProjectId">;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let queuedPersistState: PersistedCanvasState | null = null;

const nextProjectNo = (projects: CanvasProject[]) => projects.reduce((max, project) => Math.max(max, project.no || 0), 0) + 1;

// 旧数据没有编号：按创建顺序补号，已有编号的工程保持不变。
const migrateProjectNos = (projects: CanvasProject[]) => {
    if (!projects.some((project) => !project.no)) return projects;
    let next = projects.reduce((max, project) => Math.max(max, project.no || 0), 0);
    const assigned = new Map(
        [...projects]
            .filter((project) => !project.no)
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
            .map((project) => [project.id, ++next]),
    );
    return projects.map((project) => (assigned.has(project.id) ? { ...project, no: assigned.get(project.id) as number } : project));
};

const canvasStorage: PersistStorage<CanvasStore> = {
    getItem: async (name) => {
        const value = await localForageStorage.getItem(name);
        if (!value) return null;
        const parsed = JSON.parse(value) as StorageValue<CanvasStore>;
        queuedPersistState = { ...(parsed.state as PersistedCanvasState), projects: migrateProjectNos((parsed.state as PersistedCanvasState).projects || []) };
        return { ...parsed, state: queuedPersistState } as StorageValue<CanvasStore>;
    },
    setItem: (name, value) => {
        const nextState = value.state as PersistedCanvasState;
        if (queuedPersistState && queuedPersistState.projects === nextState.projects && queuedPersistState.deletedProjects === nextState.deletedProjects && queuedPersistState.lastProjectId === nextState.lastProjectId) return;
        queuedPersistState = nextState;
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            saveTimer = null;
            void localForageStorage.setItem(name, JSON.stringify(value));
        }, 400);
    },
    removeItem: (name) => localForageStorage.removeItem(name),
};

export const formatProjectNo = (no: number | undefined) => `#${String(no || 0).padStart(4, "0")}`;

/**
 * 落盘前的跨进程写合并：导演台（3d-director-desk）会经 17371 /store 直接改写本 key
 * （跨项目导入画布节点）。若不加处理，本页面的内存态会在下一次变更时把磁盘上的导演台
 * 写入覆盖掉。按工程粒度以 updatedAt 取新者合并：导演台刚导入的工程（磁盘上 updatedAt
 * 更新）被保留；本页面正在编辑的工程（本页 updatedAt 更新）不受影响。
 * 打开中的工程被外部更新时广播事件，页面据此提示用户刷新；其余工程直接同步进内存，
 * 工程目录里即刻可见。
 */
function mergeExternalCanvasWrite(remoteNow: string | null, ourJson: string, _lastSynced: string | null): string {
    void _lastSynced;
    let remoteState: PersistedCanvasState;
    let ourState: PersistedCanvasState;
    try {
        remoteState = (JSON.parse(remoteNow || "{}") as StorageValue<CanvasStore>)?.state ?? { projects: [], deletedProjects: [], lastProjectId: null };
        ourState = (JSON.parse(ourJson) as StorageValue<CanvasStore>)?.state ?? { projects: [], deletedProjects: [], lastProjectId: null };
    } catch {
        return ourJson; // 任一侧解析失败：保守回退为 last-writer-wins
    }
    const remoteProjects = Array.isArray(remoteState.projects) ? remoteState.projects : [];
    const ourProjects = Array.isArray(ourState.projects) ? ourState.projects : [];
    const remoteById = new Map(remoteProjects.map((project) => [project.id, project]));
    const ourById = new Map(ourProjects.map((project) => [project.id, project]));
    const ids = new Set([...ourById.keys(), ...remoteById.keys()]);
    const mergedProjects: CanvasProject[] = [];
    let externalTouchedOpen = false;
    const lastProjectId = ourState.lastProjectId ?? useCanvasStore.getState().lastProjectId;
    for (const id of ids) {
        const mine = ourById.get(id);
        const theirs = remoteById.get(id);
        const winner = theirs && mine ? ((theirs.updatedAt || "") > (mine.updatedAt || "") ? theirs : mine) : (theirs ?? mine);
        if (!winner) continue;
        mergedProjects.push(winner);
        if (winner === theirs && mine && id === lastProjectId) externalTouchedOpen = true;
    }
    // deletedProjects 并集：任一侧的删除标记都保留
    const deletedById = new Map<string, CanvasDeletedProject>();
    for (const item of [...(ourState.deletedProjects || []), ...(remoteState.deletedProjects || [])]) {
        const existing = deletedById.get(item.id);
        if (!existing || (item.deletedAt || "") > (existing.deletedAt || "")) deletedById.set(item.id, item);
    }
    if (externalTouchedOpen) {
        // 打开中的工程被外部更新：磁盘保留新版本，页面弹提示引导刷新；
        // 用户随后在页面内的编辑（updatedAt 更新）会正常胜出
        window.dispatchEvent(new CustomEvent("canvas-store:external-update"));
    }
    // 合并结果收敛进内存：工程目录即刻可见导演台写入的工程；
    // 打开中的工程若本地未变会被合并版本覆盖其 store 记录（页面节点状态独立，渲染不受影响）
    const current = useCanvasStore.getState();
    const changed =
        current.projects.length !== mergedProjects.length ||
        mergedProjects.some((project) => current.projects.find((item) => item.id === project.id) !== project) ||
        current.deletedProjects.length !== deletedById.size;
    if (changed) useCanvasStore.setState({ projects: mergedProjects, deletedProjects: [...deletedById.values()] });
    return JSON.stringify({ state: { projects: mergedProjects, deletedProjects: [...deletedById.values()], lastProjectId: ourState.lastProjectId }, version: 0 });
}

export const useCanvasStore = create<CanvasStore>()(
    persist(
        (set, get) => ({
            hydrated: false,
            projects: [],
            deletedProjects: [],
            lastProjectId: null,
            createProject: (title = i18n.t("canvas.project.untitled")) => {
                const now = new Date().toISOString();
                const id = nanoid();
                const project: CanvasProject = {
                    id,
                    no: nextProjectNo(get().projects),
                    title,
                    createdAt: now,
                    updatedAt: now,
                    nodes: [],
                    connections: [],
                    chatSessions: [],
                    activeChatId: null,
                    backgroundMode: "lines",
                    showImageInfo: false,
                    viewport: initialViewport,
                };
                set((state) => ({ projects: [project, ...state.projects] }));
                return id;
            },
            importProject: (source) => {
                const now = new Date().toISOString();
                const project: CanvasProject = {
                    id: nanoid(),
                    no: nextProjectNo(get().projects),
                    title: source.title || i18n.t("canvas.project.imported"),
                    createdAt: source.createdAt || now,
                    updatedAt: now,
                    nodes: source.nodes || [],
                    connections: source.connections || [],
                    chatSessions: source.chatSessions || [],
                    activeChatId: source.activeChatId || null,
                    backgroundMode: source.backgroundMode || "lines",
                    showImageInfo: source.showImageInfo || false,
                    viewport: source.viewport || initialViewport,
                };
                set((state) => ({ projects: [project, ...state.projects] }));
                return project.id;
            },
            openProject: (id) => {
                return get().projects.find((item) => item.id === id) || null;
            },
            resolveProject: (idOrNo) => {
                const projects = get().projects;
                const byId = projects.find((item) => item.id === idOrNo);
                if (byId) return byId;
                if (/^\d+$/.test(idOrNo)) {
                    const no = Number(idOrNo);
                    return projects.find((item) => item.no === no) || null;
                }
                return null;
            },
            setLastProjectId: (id) => set({ lastProjectId: id }),
            renameProject: (id, title) =>
                set((state) => ({
                    projects: state.projects.map((project) => (project.id === id ? { ...project, title: title.trim() || project.title, updatedAt: new Date().toISOString() } : project)),
                })),
            deleteProjects: (ids) =>
                set((state) => {
                    const now = new Date().toISOString();
                    const removing = new Set(ids);
                    const projects = state.projects.filter((project) => !removing.has(project.id));
                    const deletedProjects = [...state.deletedProjects.filter((item) => !removing.has(item.id)), ...ids.map((id) => ({ id, deletedAt: now }))];
                    return { projects, deletedProjects };
                }),
            replaceProjects: (projects, deletedProjects = []) => set({ projects: migrateProjectNos(projects), deletedProjects }),
            updateProject: (id, patch) =>
                set((state) => ({
                    projects: state.projects.map((project) => (project.id === id ? { ...project, ...patch, updatedAt: new Date().toISOString() } : project)),
                })),
        }),
        {
            name: CANVAS_STORE_KEY,
            storage: canvasStorage,
            partialize: (state) =>
                ({
                    projects: state.projects,
                    deletedProjects: state.deletedProjects,
                    lastProjectId: state.lastProjectId,
                }) as StorageValue<CanvasStore>["state"],
            onRehydrateStorage: () => (state) => {
                if (state && state.projects.some((project) => !project.no)) {
                    const projects = migrateProjectNos(state.projects);
                    useCanvasStore.setState({ projects });
                    queuedPersistState = { projects, deletedProjects: state.deletedProjects, lastProjectId: state.lastProjectId };
                }
                useCanvasStore.setState({ hydrated: true });
            },
        },
    ),
);

// 注册画布 KV 的跨进程写合并：导演台（3d-director-desk）经 17371 /store 直接写入本 key，
// 落盘前按工程 updatedAt 取新者，避免本页面内存态把导演台的写入覆盖掉。
registerKvMergeHook(CANVAS_STORE_KEY, mergeExternalCanvasWrite);
