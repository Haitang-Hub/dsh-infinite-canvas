import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 桥侧结构化日志：每次工具调用与删除类操作分别落盘 data/logs/，
 * harness 排错时可直接读文件。写入失败静默忽略（日志不能影响工具执行）。
 */

const DEFAULT_DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..", "data");
const LOG_DIR = path.join(process.env.CANVAS_DATA_DIR?.trim() || DEFAULT_DATA_DIR, "logs");

export function appendToolLog(fileName: string, entry: Record<string, unknown>) {
    try {
        fs.mkdirSync(LOG_DIR, { recursive: true });
        fs.appendFileSync(path.join(LOG_DIR, fileName), `${JSON.stringify(entry)}\n`);
    } catch {
        // 日志目录不可写时跳过；doctor 会报告 data 目录可写性。
    }
}

/** doctor 用：检查 data 目录是否可写。 */
export function checkDataDirWritable() {
    try {
        fs.mkdirSync(LOG_DIR, { recursive: true });
        const probe = path.join(LOG_DIR, `.write-probe-${process.pid}`);
        fs.writeFileSync(probe, "ok");
        fs.unlinkSync(probe);
        return { ok: true, dir: LOG_DIR };
    } catch (error) {
        return { ok: false, dir: LOG_DIR, error: error instanceof Error ? error.message : String(error) };
    }
}
