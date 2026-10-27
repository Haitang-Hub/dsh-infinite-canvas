import localforage from "localforage";
import { nanoid } from "nanoid";

import { localStoreAvailable, mediaDelete, mediaExists, mediaGetBlob, mediaListKeys, mediaUpload, mediaUrl } from "@/services/local-store";

export type UploadedFile = { url: string; storageKey: string; bytes: number; mimeType: string; width?: number; height?: number; durationMs?: number };

const store = localforage.createInstance({ name: "infinite-canvas", storeName: "media_files" });
const objectUrls = new Map<string, string>();

export async function uploadMediaFile(input: string | Blob, prefix = "file"): Promise<UploadedFile> {
    const blob = typeof input === "string" ? await (await fetch(input)).blob() : input;
    const storageKey = `${prefix}:${nanoid()}`;
    await store.setItem(storageKey, blob);
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    // 磁盘优先：本地文件存储可用时同步落盘，url 返回稳定的磁盘地址
    if (await localStoreAvailable()) {
        if (await mediaUpload(storageKey, blob)) objectUrls.set(storageKey, mediaUrl(storageKey));
    }
    const meta = blob.type.startsWith("video/") ? await readVideoMeta(url) : blob.type.startsWith("audio/") ? await readAudioMeta(url) : {};
    return { url: objectUrls.get(storageKey) || url, storageKey, bytes: blob.size, mimeType: blob.type || "application/octet-stream", ...meta };
}

export async function resolveMediaUrl(storageKey?: string, fallback = "") {
    if (!storageKey) return fallback;
    const cached = objectUrls.get(storageKey);
    if (cached) return cached;
    // 磁盘命中：返回稳定 URL；磁盘缺失：回退 IndexedDB 并懒迁移上盘
    if (await localStoreAvailable()) {
        if (await mediaExists(storageKey)) {
            const stableUrl = mediaUrl(storageKey);
            objectUrls.set(storageKey, stableUrl);
            return stableUrl;
        }
        const blob = await store.getItem<Blob>(storageKey);
        if (!blob) return fallback;
        const objectUrl = URL.createObjectURL(blob);
        objectUrls.set(storageKey, objectUrl);
        void mediaUpload(storageKey, blob).then((ok) => {
            if (ok) objectUrls.set(storageKey, mediaUrl(storageKey));
        });
        return objectUrl;
    }
    const blob = await store.getItem<Blob>(storageKey);
    if (!blob) return fallback;
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return url;
}

export async function getMediaBlob(storageKey: string) {
    if (await localStoreAvailable()) {
        const remote = await mediaGetBlob(storageKey);
        if (remote) return remote;
    }
    return store.getItem<Blob>(storageKey);
}

export async function setMediaBlob(storageKey: string, blob: Blob) {
    await store.setItem(storageKey, blob);
    const objectUrl = URL.createObjectURL(blob);
    objectUrls.set(storageKey, objectUrl);
    if (await localStoreAvailable()) {
        if (await mediaUpload(storageKey, blob)) objectUrls.set(storageKey, mediaUrl(storageKey));
    }
    return objectUrls.get(storageKey) || objectUrl;
}

export async function deleteStoredMedia(keys: Iterable<string>) {
    await Promise.all(
        Array.from(new Set(keys)).map(async (key) => {
            const url = objectUrls.get(key);
            if (url) URL.revokeObjectURL(url);
            objectUrls.delete(key);
            await store.removeItem(key);
            await mediaDelete(key);
        }),
    );
}

export async function cleanupUnusedMedia(usedData: unknown) {
    const usedKeys = collectMediaStorageKeys(usedData);
    const unused: string[] = [];
    await store.iterate((_value, key) => {
        if (!usedKeys.has(key)) unused.push(key);
    });
    await Promise.all(unused.map((key) => store.removeItem(key)));
    // 磁盘侧同样清理未引用文件
    if (await localStoreAvailable()) {
        const diskKeys = await mediaListKeys();
        await Promise.all(diskKeys.filter((key) => !usedKeys.has(key)).map((key) => mediaDelete(key)));
    }
}

export function collectMediaStorageKeys(value: unknown, keys = new Set<string>()): Set<string> {
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.includes(":")) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectMediaStorageKeys(child, keys)) : collectMediaStorageKeys(item, keys)));
    return keys;
}

function readVideoMeta(url: string) {
    return new Promise<{ width: number; height: number; durationMs?: number }>((resolve) => {
        const video = document.createElement("video");
        const done = () => resolve({ width: video.videoWidth || 1280, height: video.videoHeight || 720, durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : undefined });
        video.onloadedmetadata = done;
        video.onerror = done;
        video.src = url;
    });
}

function readAudioMeta(url: string) {
    return new Promise<{ durationMs?: number }>((resolve) => {
        const audio = document.createElement("audio");
        const done = () => resolve({ durationMs: Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : undefined });
        audio.onloadedmetadata = done;
        audio.onerror = done;
        audio.src = url;
    });
}
