import localforage from "localforage";
import type { StateStorage } from "zustand/middleware";

import { kvDelete, kvGetText, kvPutText, localStoreAvailable } from "@/services/local-store";

localforage.config({
    name: "infinite-canvas",
    storeName: "app_state",
});

/** 写磁盘按 key 防抖，避免画布高频变更时打爆本地服务。 */
const pendingPuts = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleKvPut(name: string, value: string) {
    const existing = pendingPuts.get(name);
    if (existing) clearTimeout(existing);
    pendingPuts.set(
        name,
        setTimeout(() => {
            pendingPuts.delete(name);
            void kvPutText(name, value);
        }, 500),
    );
}

async function readLocalForage(name: string): Promise<string | null> {
    try {
        return (await localforage.getItem<string>(name)) || null;
    } catch {
        try {
            return window.localStorage.getItem(name);
        } catch {
            return null;
        }
    }
}

/**
 * 混合存储：磁盘（canvas-agent 本地文件存储）优先，浏览器 IndexedDB/localStorage 兜底。
 * 读：磁盘命中直接返回；磁盘缺失但浏览器有旧数据时自动上迁一次（懒迁移）。
 * 写：两边同时写（磁盘写入防抖），保证任一侧故障时数据仍可恢复。
 */
export const localForageStorage: StateStorage = {
    getItem: async (name) => {
        if (typeof window === "undefined") return null;
        const available = await localStoreAvailable();
        if (available) {
            const remote = await kvGetText(name);
            if (remote !== null) return remote;
            const local = await readLocalForage(name);
            if (local !== null) void kvPutText(name, local);
            return local;
        }
        return readLocalForage(name);
    },
    setItem: async (name, value) => {
        if (typeof window === "undefined") return;
        try {
            await localforage.setItem(name, value);
        } catch {
            try {
                window.localStorage.setItem(name, value);
            } catch {
                // 浏览器存储满：磁盘侧仍会保存
            }
        }
        scheduleKvPut(name, value);
    },
    removeItem: async (name) => {
        if (typeof window === "undefined") return;
        try {
            await localforage.removeItem(name);
        } catch {
            try {
                window.localStorage.removeItem(name);
            } catch {
                // 忽略
            }
        }
        void kvDelete(name);
    },
};
