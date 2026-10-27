import { useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { App, Input, Modal, Popconfirm, Tag } from "antd";
import { Download, FileUp, Pencil, Plus, Search, Trash2 } from "lucide-react";
import dayjs from "dayjs";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { exportCanvasProjects } from "@/lib/canvas/canvas-export";
import { importCanvasProjectsZip } from "@/lib/canvas/canvas-import";
import { formatProjectNo, useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { useThemeStore } from "@/stores/use-theme-store";

type Props = {
    open: boolean;
    onClose: () => void;
    currentProjectId: string;
};

/** 工程目录：目录式列出全部画布工程（编号/名称/更新时间），支持搜索、打开、新建、重命名、导出、导入、删除。 */
export function CanvasProjectDirectory({ open, onClose, currentProjectId }: Props) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const navigate = useNavigate();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const projects = useCanvasStore((state) => state.projects);
    const createProject = useCanvasStore((state) => state.createProject);
    const renameProject = useCanvasStore((state) => state.renameProject);
    const deleteProjects = useCanvasStore((state) => state.deleteProjects);
    const [keyword, setKeyword] = useState("");
    const [editingId, setEditingId] = useState<string | null>(null);
    const [titleDraft, setTitleDraft] = useState("");
    const importInputRef = useRef<HTMLInputElement>(null);
    const exportingRef = useRef(false);

    const sorted = useMemo(() => [...projects].sort((a, b) => a.no - b.no), [projects]);
    const filtered = useMemo(() => {
        const query = keyword.trim().toLowerCase();
        if (!query) return sorted;
        return sorted.filter((project) => [formatProjectNo(project.no), String(project.no), project.title].join(" ").toLowerCase().includes(query));
    }, [keyword, sorted]);

    const openProject = (id: string) => {
        onClose();
        if (id !== currentProjectId) navigate(`/canvas/${id}`);
    };

    const createAndOpen = () => {
        const id = createProject(t("canvas.defaultTitle", { count: projects.length + 1 }));
        openProject(id);
    };

    const startRename = (project: CanvasProject) => {
        setEditingId(project.id);
        setTitleDraft(project.title);
    };

    const finishRename = () => {
        if (editingId) renameProject(editingId, titleDraft);
        setEditingId(null);
    };

    const exportProject = async (project: CanvasProject) => {
        if (exportingRef.current) return;
        exportingRef.current = true;
        const hide = message.loading(t("canvas.projectPage.exporting"), 0);
        try {
            await exportCanvasProjects([project], `${formatProjectNo(project.no)}-${project.title}`);
            message.success(t("canvas.projectPage.exported"));
        } catch (error) {
            console.error(error);
            message.error(t("canvas.sidePanel.exportFailed"));
        } finally {
            hide();
            exportingRef.current = false;
        }
    };

    const importCanvas = async (file?: File) => {
        if (!file) return;
        try {
            const count = await importCanvasProjectsZip(file);
            message.success(t("canvas.imported", { count }));
        } catch {
            message.error(t("canvas.importFailed"));
        } finally {
            if (importInputRef.current) importInputRef.current.value = "";
        }
    };

    const deleteProject = (project: CanvasProject) => {
        deleteProjects([project.id]);
        if (project.id === currentProjectId) {
            onClose();
            navigate("/");
        }
    };

    return (
        <Modal title={t("canvas.directory.title")} open={open} onCancel={onClose} footer={null} centered width={560}>
            <div className="flex flex-col gap-3">
                <div className="flex items-center gap-2">
                    <Input size="small" allowClear prefix={<Search className="size-3.5 text-stone-400" />} placeholder={t("canvas.directory.search")} value={keyword} onChange={(event) => setKeyword(event.target.value)} />
                    <button
                        type="button"
                        onClick={createAndOpen}
                        className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold transition hover:bg-black/5 dark:hover:bg-white/10"
                        style={{ color: theme.toolbar.activeText }}
                    >
                        <Plus className="size-3.5" />
                        {t("canvas.create")}
                    </button>
                    <button
                        type="button"
                        onClick={() => importInputRef.current?.click()}
                        className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold opacity-70 transition hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/10"
                        style={{ color: theme.node.text }}
                    >
                        <FileUp className="size-3.5" />
                        {t("canvas.import")}
                    </button>
                    <input ref={importInputRef} type="file" accept="application/zip,.zip" className="hidden" onChange={(event) => void importCanvas(event.target.files?.[0])} />
                </div>
                <div className="max-h-[420px] min-h-32 overflow-y-auto rounded-lg border p-1" style={{ borderColor: theme.node.stroke }}>
                    {filtered.length ? (
                        <div className="space-y-0.5">
                            {filtered.map((project) => {
                                const current = project.id === currentProjectId;
                                return (
                                    <div
                                        key={project.id}
                                        className="group flex items-center gap-2.5 rounded-lg px-2 py-2 transition"
                                        style={current ? { background: theme.toolbar.activeBg } : undefined}
                                    >
                                        <span className="shrink-0 font-mono text-xs opacity-55">{formatProjectNo(project.no)}</span>
                                        {editingId === project.id ? (
                                            <Input size="small" autoFocus value={titleDraft} onChange={(event) => setTitleDraft(event.target.value)} onBlur={finishRename} onPressEnter={finishRename} onKeyDown={(event) => event.key === "Escape" && setEditingId(null)} className="min-w-0 flex-1" />
                                        ) : (
                                            <button type="button" onClick={() => openProject(project.id)} className="min-w-0 flex-1 truncate text-left text-sm font-medium" title={t("canvas.directory.open")}>
                                                {project.title || t("canvas.project.untitled")}
                                            </button>
                                        )}
                                        {current ? <Tag className="shrink-0">{t("canvas.directory.current")}</Tag> : null}
                                        <span className="hidden shrink-0 text-xs opacity-45 sm:block">{dayjs(project.updatedAt).format("MM-DD HH:mm")}</span>
                                        <span className="shrink-0 text-xs opacity-45" title={t("canvas.directory.nodeCount")}>{project.nodes.length}</span>
                                        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
                                            <button type="button" onClick={() => startRename(project)} className="grid size-6 place-items-center rounded-md opacity-60 transition hover:bg-black/10 hover:opacity-100 dark:hover:bg-white/10" aria-label={t("canvas.renameHint")} title={t("canvas.renameHint")}>
                                                <Pencil className="size-3.5" />
                                            </button>
                                            <button type="button" onClick={() => void exportProject(project)} className="grid size-6 place-items-center rounded-md opacity-60 transition hover:bg-black/10 hover:opacity-100 dark:hover:bg-white/10" aria-label={t("canvas.exportCurrent")} title={t("canvas.exportCurrent")}>
                                                <Download className="size-3.5" />
                                            </button>
                                            <Popconfirm title={t("canvas.directory.deleteTitle", { name: project.title })} okText={t("common.delete")} cancelText={t("common.cancel")} okButtonProps={{ danger: true }} onConfirm={() => deleteProject(project)}>
                                                <button type="button" className="grid size-6 place-items-center rounded-md opacity-60 transition hover:bg-black/10 hover:text-red-500 hover:opacity-100 dark:hover:bg-white/10" aria-label={t("canvas.deleteCurrent")} title={t("canvas.deleteCurrent")}>
                                                    <Trash2 className="size-3.5" />
                                                </button>
                                            </Popconfirm>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    ) : (
                        <div className="grid h-32 place-items-center text-sm opacity-40">{projects.length ? t("canvas.directory.noMatch") : t("canvas.directory.empty")}</div>
                    )}
                </div>
            </div>
        </Modal>
    );
}
