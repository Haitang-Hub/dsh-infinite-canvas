import { readZip } from "@/lib/zip";
import { setMediaBlob } from "@/services/file-storage";
import { setImageBlob } from "@/services/image-storage";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import type { CanvasExportFile } from "@/types/canvas-export";

/** 解析画布压缩包（projects.json + 资产文件），写入媒体存储并导入工程。返回导入的工程数量。 */
export async function importCanvasProjectsZip(file: File): Promise<number> {
    const zip = await readZip(file);
    const projectFile = zip.get("projects.json");
    if (!projectFile) throw new Error("missing projects.json");
    const data = JSON.parse(await projectFile.text()) as CanvasExportFile;
    await Promise.all(
        data.projects.flatMap((project) =>
            project.files.map(async (item) => {
                const blob = zip.get(item.path);
                if (!blob) return;
                const typedBlob = blob.type ? blob : blob.slice(0, blob.size, item.mimeType);
                await (item.storageKey.startsWith("image:") ? setImageBlob(item.storageKey, typedBlob) : setMediaBlob(item.storageKey, typedBlob));
            }),
        ),
    );
    const { importProject } = useCanvasStore.getState();
    data.projects.forEach((item) => importProject(item.project));
    return data.projects.length;
}
