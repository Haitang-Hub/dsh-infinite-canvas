/**
 * 本地文件存储端点（/store/* 与 /media/*）：画布工程 KV 与媒体文件落盘。
 *
 * 契约（网页端 services/local-store.ts 与导演台 web/src/lib/canvas-bridge.ts 依此访问）：
 *   GET    /store/health        -> { ok, dir }（可用性探测，免 token）
 *   GET    /store/kv/:key       -> 文本内容（404 = 键不存在）
 *   PUT    /store/kv/:key       <- 文本内容（text/plain）
 *   DELETE /store/kv/:key
 *   GET    /store/media         -> { keys: [...] }（媒体键列表）
 *   HEAD   /media/:key          -> 存在性探测
 *   GET    /media/:key          -> 二进制内容（Content-Type 取上传时记录的 mime）
 *   POST   /store/media/:key    <- 二进制体（Content-Type 记录为该键的 mime）
 *   DELETE /store/media/:key
 *
 * 落盘布局：<storeRoot>/kv/<encodeURIComponent(key)>.json 与
 * <storeRoot>/media/<encodeURIComponent(key)>（+ 同名 .ct 侧车记录 mime）。
 * encodeURIComponent 后只剩 URL 安全字符与 %，天然规避 Windows 非法文件名与路径穿越
 * （仅 "." / ".." 全名需显式拒绝）。
 *
 * 鉴权：挂载在 token 中间件之前、仅绑 127.0.0.1（http.ts 全局绑定），与 2026-10-25
 * 的原始设计一致——导演台跨项目导入（无本桥 token）也要能读。
 */

import fs from "node:fs";
import path from "node:path";
import { Router, type Request, type Response } from "express";

function keyToFileName(key: string) {
    const encoded = encodeURIComponent(key);
    if (!encoded || encoded === "." || encoded === "..") throw new Error("invalid storage key");
    return encoded;
}

function writeFileAtomic(file: string, data: Buffer | string) {
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
}

function readBody(req: Request): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
    });
}

/** 挂载本地文件存储端点。storeRoot 为落盘根目录（<CONFIG_DIR>/store）。 */
export function mountStoreRoutes(app: Router, storeRoot: string) {
    const kvDir = path.join(storeRoot, "kv");
    const mediaDir = path.join(storeRoot, "media");
    fs.mkdirSync(kvDir, { recursive: true });
    fs.mkdirSync(mediaDir, { recursive: true });

    const kvFile = (key: string) => path.join(kvDir, `${keyToFileName(key)}.json`);
    const mediaFile = (key: string) => path.join(mediaDir, keyToFileName(key));
    const mediaCtFile = (key: string) => path.join(mediaDir, `${keyToFileName(key)}.ct`);

    const listMediaKeys = () =>
        fs
            .readdirSync(mediaDir)
            .filter((name) => !name.endsWith(".ct") && !name.includes(".tmp-"))
            .map((name) => {
                try {
                    return decodeURIComponent(name);
                } catch {
                    return name;
                }
            });

    app.get("/store/health", (_req: Request, res: Response) => res.json({ ok: true, dir: storeRoot }));

    app.get("/store/media", (_req: Request, res: Response) => res.json({ ok: true, keys: listMediaKeys() }));

    app.get("/store/kv/:key", (req: Request, res: Response) => {
        try {
            const file = kvFile(String(req.params.key));
            if (!fs.existsSync(file)) return res.status(404).json({ ok: false, error: "not found" });
            res.type("text/plain").send(fs.readFileSync(file, "utf8"));
        } catch (error) {
            res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
    });

    app.put("/store/kv/:key", async (req: Request, res: Response) => {
        try {
            const body = await readBody(req);
            writeFileAtomic(kvFile(String(req.params.key)), body.toString("utf8"));
            res.json({ ok: true });
        } catch (error) {
            res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
    });

    app.delete("/store/kv/:key", (req: Request, res: Response) => {
        try {
            const file = kvFile(String(req.params.key));
            if (fs.existsSync(file)) fs.rmSync(file);
            res.json({ ok: true });
        } catch (error) {
            res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
    });

    app.head("/media/:key", (req: Request, res: Response) => {
        try {
            if (!fs.existsSync(mediaFile(String(req.params.key)))) return res.status(404).end();
            res.end();
        } catch {
            res.status(400).end();
        }
    });

    app.get("/media/:key", (req: Request, res: Response) => {
        try {
            const file = mediaFile(String(req.params.key));
            if (!fs.existsSync(file)) return res.status(404).json({ ok: false, error: "not found" });
            const ctFile = mediaCtFile(String(req.params.key));
            const mime = fs.existsSync(ctFile) ? fs.readFileSync(ctFile, "utf8").trim() : "application/octet-stream";
            res.setHeader("Cache-Control", "no-store");
            res.type(mime).send(fs.readFileSync(file));
        } catch (error) {
            res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
    });

    app.post("/store/media/:key", async (req: Request, res: Response) => {
        try {
            const key = String(req.params.key);
            const body = await readBody(req);
            writeFileAtomic(mediaFile(key), body);
            const mime = String(req.headers["content-type"] || "application/octet-stream").split(";")[0].trim();
            writeFileAtomic(mediaCtFile(key), mime);
            res.json({ ok: true });
        } catch (error) {
            res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
    });

    app.delete("/store/media/:key", (req: Request, res: Response) => {
        try {
            const key = String(req.params.key);
            for (const file of [mediaFile(key), mediaCtFile(key)]) {
                if (fs.existsSync(file)) fs.rmSync(file);
            }
            res.json({ ok: true });
        } catch (error) {
            res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
    });
}
