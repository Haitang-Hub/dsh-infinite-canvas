import i18n from "@/i18n";
import type { PromptSource } from "./prompt-source-presets";

export type RawPrompt = {
    id: string;
    title: string;
    prompt: string;
    description: string;
    coverUrl: string;
    referenceImageUrls: string[];
    tags: string[];
    preview: string;
    createdAt: string;
    updatedAt: string;
    author?: string;
    sourceUrl?: string;
    imageMode?: string;
    imageModel?: string;
    imageSize?: string;
    imageCount?: number;
};

type RunOptions = { signal?: AbortSignal };

async function fetchSource(source: PromptSource, options?: RunOptions): Promise<string> {
    let response = await fetch(source.url, { cache: "no-store", signal: options?.signal });
    if (response.status === 404 && /\/README_[^/]+\.md$/i.test(source.url)) {
        response = await fetch(source.url.replace(/README_[^/]+\.md$/i, "README.md"), { cache: "no-store", signal: options?.signal });
    }
    if (!response.ok) throw new Error(i18n.t("config.promptSources.runtime.requestFailed", { status: response.status }));
    return response.text();
}

export async function runPromptSource(source: PromptSource, options?: RunOptions): Promise<RawPrompt[]> {
    if (!source.url.trim()) throw new Error(i18n.t("config.promptSources.runtime.urlRequired"));
    let text: string;
    try {
        text = await fetchSource(source, options);
    } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") throw error;
        throw new Error(i18n.t("config.promptSources.runtime.fetchFailed", { name: source.name, error: error instanceof Error ? error.message : String(error) }));
    }

    const items = parseSourceText(text, source);
    if (source.builtIn && !items.length) throw new Error(i18n.t("config.promptSources.runtime.noPrompts", { name: source.name }));
    return items;
}

function parseSourceText(text: string, source: PromptSource) {
    const trimmed = text.trim().replace(/^\uFEFF/, "");
    if (trimmed.startsWith("[")) {
        try {
            const data: unknown = JSON.parse(trimmed);
            if (Array.isArray(data)) return parseJsonSource(data, source);
        } catch {
            // Not a JSON array (e.g. a README whose first line is a "[![badge](...)]" link); fall through to README parsing.
        }
    }
    return parseReadmeSource(text, source);
}

const README_ENTRY_PATTERN = /^### No\. \d+:\s*(.+)$/gm;

function parseReadmeSource(text: string, source: PromptSource) {
    const matches = [...text.matchAll(README_ENTRY_PATTERN)];
    if (!matches.length) throw new Error(i18n.t("config.promptSources.runtime.invalidRoot", { name: source.name }));
    const items: RawPrompt[] = [];
    matches.forEach((match, index) => {
        const title = match[1].trim();
        const bodyStart = (match.index ?? 0) + match[0].length;
        const bodyEnd = index + 1 < matches.length ? matches[index + 1].index ?? text.length : text.length;
        const body = text.slice(bodyStart, bodyEnd);
        const promptSection = readmeSection(body, "📝");
        const prompt = promptSection.match(/```[^\n]*\n([\s\S]*?)```/)?.[1]?.trim() || promptSection;
        if (!title || !prompt) return;
        const referenceImageUrls = [...body.matchAll(/<img\s+[^>]*src="([^"]+)"/g)].map((image) => image[1]).filter((url) => !url.includes("img.shields.io"));
        const tags = [...body.matchAll(/^!\[([^\]]+)\]\(https:\/\/img\.shields\.io/gm)].map((badge) => badge[1].split("-")[0]).filter(Boolean);
        const author = body.match(/-\s+\*\*Author:\*\*\s*\[([^\]]+)\]/)?.[1]?.trim();
        const id = `${source.id}-${leftPad(index + 1)}`;
        items.push({
            id,
            title,
            prompt,
            description: readmeSection(body, "📖"),
            coverUrl: referenceImageUrls[0] || "",
            referenceImageUrls,
            tags: [...new Set(tags)],
            preview: "",
            createdAt: "",
            updatedAt: "",
            author,
            sourceUrl: source.homepage || source.url,
        });
    });
    return items;
}

function readmeSection(body: string, emoji: string) {
    const pattern = new RegExp(`^#### ${emoji}[^\\n]*\\n([\\s\\S]*?)(?=^#### )`, "m");
    return body.match(pattern)?.[1]?.trim() || "";
}

function parseJsonSource(data: unknown, source: PromptSource) {
    if (!Array.isArray(data)) throw new Error(i18n.t("config.promptSources.runtime.invalidRoot", { name: source.name }));
    return normalizeItems(data, source);
}

function normalizeItems(values: unknown[], source: PromptSource) {
    const seen = new Set<string>();
    const items: RawPrompt[] = [];
    values.forEach((value, index) => {
        const record = asRecord(value);
        const title = stringValue(record.title).trim();
        const prompt = stringValue(record.prompt).trim();
        if (!title || !prompt) return;
        const id = stringValue(record.id).trim() || `${source.id}-${leftPad(index + 1)}`;
        if (seen.has(id)) return;
        seen.add(id);
        const referenceImageUrls = stringArray(record.referenceImageUrls).map((url) => absoluteUrl(source.url, url));
        const coverUrl = absoluteUrl(source.url, stringValue(record.coverUrl)) || referenceImageUrls[0] || "";
        items.push({
            id,
            title,
            prompt,
            description: stringValue(record.description),
            coverUrl,
            referenceImageUrls,
            tags: stringArray(record.tags),
            preview: stringValue(record.preview),
            createdAt: stringValue(record.createdAt),
            updatedAt: stringValue(record.updatedAt),
            author: stringValue(record.author),
            sourceUrl: absoluteUrl(source.url, stringValue(record.sourceUrl)),
            imageMode: optionalString(record.imageMode),
            imageModel: optionalString(record.imageModel),
            imageSize: optionalString(record.imageSize),
            imageCount: optionalNumber(record.imageCount),
        });
    });
    return items;
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown) {
    return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function stringArray(value: unknown) {
    return Array.isArray(value) ? value.map(stringValue).map((item) => item.trim()).filter(Boolean) : [];
}

function optionalString(value: unknown) {
    const result = stringValue(value).trim();
    return result || undefined;
}

function optionalNumber(value: unknown) {
    const result = Number(value);
    return Number.isFinite(result) && result > 0 ? result : undefined;
}

function absoluteUrl(baseUrl: string, path: string) {
    if (!path) return "";
    try {
        return new URL(path, baseUrl).toString();
    } catch {
        return path;
    }
}

function leftPad(value: number) {
    return String(value).padStart(4, "0");
}
