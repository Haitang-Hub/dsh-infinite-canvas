/**
 * 本地文件存储客户端：读写 canvas-agent 的磁盘存储（KV + 媒体文件）。
 * 服务不可达时自动降级（调用方回退浏览器 IndexedDB），可用性结果短暂缓存。
 */

const DEFAULT_BASE = "http://127.0.0.1:17371";
const HEALTH_TIMEOUT_MS = 1500;
const AVAILABLE_TTL_MS = 30_000;

function baseUrl(): string {
    try {
        const configured = localStorage.getItem("canvas-agent-url");
        return (configured && configured.trim()) || DEFAULT_BASE;
    } catch {
        return DEFAULT_BASE;
    }
}

function withTimeout(ms: number): { signal: AbortSignal; done: () => void } {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    return { signal: controller.signal, done: () => clearTimeout(timer) };
}

let availableCache: boolean | null = null;
let availableCheckedAt = 0;
let availableInFlight: Promise<boolean> | null = null;

/** 服务是否可用（短缓存；失败也缓存，避免每次请求都等超时）。 */
export async function localStoreAvailable(force = false): Promise<boolean> {
    if (!force && availableCache !== null && Date.now() - availableCheckedAt < AVAILABLE_TTL_MS) return availableCache;
    if (availableInFlight) return availableInFlight;
    const { signal, done } = withTimeout(HEALTH_TIMEOUT_MS);
    availableInFlight = fetch(`${baseUrl()}/store/health`, { signal })
        .then((res) => res.ok)
        .catch(() => false)
        .finally(() => {
            done();
            availableInFlight = null;
        })
        .then((ok) => {
            availableCache = ok;
            availableCheckedAt = Date.now();
            return ok;
        });
    return availableInFlight;
}

async function request(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<Response | null> {
    if (!(await localStoreAvailable())) return null;
    const { signal, done } = withTimeout(init?.timeoutMs ?? 8000);
    try {
        const res = await fetch(`${baseUrl()}${path}`, { ...init, signal });
        return res.ok || res.status === 404 ? res : null;
    } catch {
        availableCache = false;
        availableCheckedAt = Date.now();
        return null;
    } finally {
        done();
    }
}

// ---- KV ----

export async function kvGetText(key: string): Promise<string | null> {
    const res = await request(`/store/kv/${encodeURIComponent(key)}`);
    if (!res || res.status === 404) return null;
    return res.text();
}

export async function kvPutText(key: string, value: string): Promise<boolean> {
    const res = await request(`/store/kv/${encodeURIComponent(key)}`, { method: "PUT", body: value, headers: { "content-type": "text/plain" } });
    return Boolean(res && res.ok);
}

export async function kvDelete(key: string): Promise<void> {
    await request(`/store/kv/${encodeURIComponent(key)}`, { method: "DELETE" });
}

// ---- 媒体文件 ----

export function mediaUrl(key: string): string {
    return `${baseUrl()}/media/${encodeURIComponent(key)}`;
}

export async function mediaExists(key: string): Promise<boolean> {
    const res = await request(`/media/${encodeURIComponent(key)}`, { method: "HEAD" });
    return Boolean(res && res.ok);
}

export async function mediaUpload(key: string, blob: Blob): Promise<boolean> {
    const res = await request(`/store/media/${encodeURIComponent(key)}`, {
        method: "POST",
        body: blob,
        headers: { "content-type": blob.type || "application/octet-stream" },
        timeoutMs: 10 * 60_000,
    });
    return Boolean(res && res.ok);
}

export async function mediaGetBlob(key: string): Promise<Blob | null> {
    const res = await request(`/media/${encodeURIComponent(key)}`, { timeoutMs: 10 * 60_000 });
    if (!res || res.status === 404) return null;
    return res.blob();
}

export async function mediaDelete(key: string): Promise<void> {
    await request(`/store/media/${encodeURIComponent(key)}`, { method: "DELETE" });
}

export async function mediaListKeys(): Promise<string[]> {
    const res = await request("/store/media");
    if (!res || res.status === 404) return [];
    try {
        const data = (await res.json()) as { keys?: string[] };
        return Array.isArray(data.keys) ? data.keys : [];
    } catch {
        return [];
    }
}
