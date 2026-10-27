import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import { nanoid } from "nanoid";
import i18n from "@/i18n";
import { localForageStorage } from "@/lib/localforage-storage";
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
