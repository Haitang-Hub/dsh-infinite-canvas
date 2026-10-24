import fs from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Request, type Response } from "express";

/**
 * 本地文件存储：把画布工程数据（KV）与媒体文件落到项目 data/ 目录，
 * 摆脱浏览器 IndexedDB 的 origin 隔离与清库风险。
 * 挂载在 token 鉴权之前：本机回环服务、无敏感操作，页面零配置即可使用。
 */

const DEFAULT_DATA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../..", "data");

function dataDir(...parts: string[]) {
    const dir = join(process.env.CANVAS_DATA_DIR?.trim() || DEFAULT_DATA_DIR, ...parts);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

/** 存储键 -> 安全文件名（可逆，冒号等非法字符经 encodeURIComponent 变为 %XX，% 在文件名中合法）。 */
function encodeKey(key: string) {
    return encodeURIComponent(key);
}

function decodeKey(name: string) {
    return decodeURIComponent(name);
}

function writeFileAtomic(file: string, data: string | Buffer) {
    const tmp = `${file}.tmp-${Date.now()}`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
}

export function createStoreRouter() {
    const router = express.Router();

    router.get("/health", (_req: Request, res: Response) => {
        res.json({ ok: true, dataDir: DEFAULT_DATA_DIR });
    });

    // ---- 通用 KV（zustand persist 等结构化状态） ----
    router.get("/kv/:key", (req: Request, res: Response) => {
        try {
            const file = join(dataDir("kv"), `${encodeKey(String(req.params.key))}.txt`);
            if (!fs.existsSync(file)) return res.status(404).json({ ok: false, error: "not found" });
            res.type("text/plain").send(fs.readFileSync(file, "utf8"));
        } catch (error) {
            res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
    });

    router.put("/kv/:key", express.text({ type: "*/*", limit: "128mb" }), (req: Request, res: Response) => {
        try {
            const file = join(dataDir("kv"), `${encodeKey(String(req.params.key))}.txt`);
            writeFileAtomic(file, typeof req.body === "string" ? req.body : String(req.body ?? ""));
            res.json({ ok: true });
        } catch (error) {
            res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
    });

    router.delete("/kv/:key", (req: Request, res: Response) => {
        try {
            const file = join(dataDir("kv"), `${encodeKey(String(req.params.key))}.txt`);
            if (fs.existsSync(file)) fs.unlinkSync(file);
            res.json({ ok: true });
        } catch (error) {
            res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
    });

    // ---- 媒体文件（图片/视频等 Blob，按 storageKey 寻址） ----
    router.get("/media", (_req: Request, res: Response) => {
        try {
            const dir = dataDir("media");
            const keys = fs
                .readdirSync(dir)
                .filter((name) => name.endsWith(".meta.json"))
                .map((name) => {
                    try {
                        return String(JSON.parse(fs.readFileSync(join(dir, name), "utf8")).key ?? "");
                    } catch {
                        return "";
                    }
                })
                .filter(Boolean);
            res.json({ ok: true, keys });
        } catch (error) {
            res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
    });

    router.post("/media/:key", express.raw({ type: "*/*", limit: "2048mb" }), (req: Request, res: Response) => {
        try {
            const key = String(req.params.key);
            const dir = dataDir("media");
            const base = encodeKey(key);
            writeFileAtomic(join(dir, `${base}.bin`), Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));
            writeFileAtomic(join(dir, `${base}.meta.json`), JSON.stringify({ key, mimeType: req.headers["content-type"] || "application/octet-stream", updatedAt: Date.now() }));
            res.json({ ok: true, url: `/media/${encodeURIComponent(key)}` });
        } catch (error) {
            res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
    });

    router.delete("/media/:key", (req: Request, res: Response) => {
        try {
            const dir = dataDir("media");
            const base = encodeKey(String(req.params.key));
            for (const suffix of [".bin", ".meta.json"]) {
                const file = join(dir, base + suffix);
                if (fs.existsSync(file)) fs.unlinkSync(file);
            }
            res.json({ ok: true });
        } catch (error) {
            res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
    });

    return router;
}

export function createMediaServeRouter() {
    const router = express.Router();
    router.get("/:key", (req: Request, res: Response) => {
        try {
            const dir = dataDir("media");
            const base = encodeKey(String(req.params.key));
            const bin = join(dir, `${base}.bin`);
            if (!fs.existsSync(bin)) return res.status(404).json({ ok: false, error: "not found" });
            let mimeType = "application/octet-stream";
            try {
                mimeType = String(JSON.parse(fs.readFileSync(join(dir, `${base}.meta.json`), "utf8")).mimeType || mimeType);
            } catch {
                // meta 丢失时按二进制流返回
            }
            res.type(mimeType).send(fs.readFileSync(bin));
        } catch (error) {
            res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
    });
    return router;
}
