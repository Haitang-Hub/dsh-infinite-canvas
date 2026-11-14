export const DEFAULT_PROMPT_ORG = "YouMind-OpenLab";

export type GithubPromptRepo = {
    name: string;
    description: string;
    homepage: string;
    defaultBranch: string;
    stars: number;
    topics: string[];
};

type GithubRepoRecord = {
    name?: string;
    description?: string | null;
    html_url?: string;
    default_branch?: string;
    stargazers_count?: number;
    topics?: string[];
    fork?: boolean;
    archived?: boolean;
};

export async function fetchOrgPromptRepos(org: string): Promise<GithubPromptRepo[]> {
    const response = await fetch(`https://api.github.com/orgs/${encodeURIComponent(org.trim())}/repos?per_page=100&sort=updated`, {
        headers: { Accept: "application/vnd.github+json" },
    });
    if (!response.ok) throw new Error(String(response.status));
    const data = (await response.json()) as GithubRepoRecord[];
    if (!Array.isArray(data)) throw new Error("invalid");
    return data
        .filter((repo) => repo.name && !repo.fork && !repo.archived)
        .map((repo) => ({
            name: repo.name || "",
            description: repo.description || "",
            homepage: repo.html_url || "",
            defaultBranch: repo.default_branch || "main",
            stars: repo.stargazers_count ?? 0,
            topics: Array.isArray(repo.topics) ? repo.topics : [],
        }));
}

export function buildReadmeSourceUrl(org: string, repo: GithubPromptRepo, readmeFile: string) {
    return `https://raw.githubusercontent.com/${encodeURIComponent(org.trim())}/${repo.name}/${repo.defaultBranch}/${readmeFile}`;
}

const VIDEO_HINTS = [/seedance/i, /grok-imagine/i, /sora/i, /veo/i, /kling/i, /hailuo/i, /video/i];

export function inferRepoMediaType(repo: GithubPromptRepo): "image" | "video" {
    const haystack = `${repo.name} ${repo.topics.join(" ")}`;
    return VIDEO_HINTS.some((hint) => hint.test(haystack)) ? "video" : "image";
}

export function readmeFileForLanguage(language?: string) {
    const normalized = (language || "").toLowerCase();
    if (normalized.startsWith("zh-tw") || normalized.startsWith("zh-hk")) return "README_zh-TW.md";
    if (normalized.startsWith("zh")) return "README_zh.md";
    if (normalized.startsWith("ja")) return "README_ja-JP.md";
    if (normalized.startsWith("ko")) return "README_ko-KR.md";
    return "README.md";
}

export const FALLBACK_PROMPT_REPOS: GithubPromptRepo[] = [
    {
        name: "awesome-gpt-image-2",
        description: "World's largest GPT Image 2 prompt library, updated daily — 2000+ curated prompts with preview images.",
        homepage: "https://github.com/YouMind-OpenLab/awesome-gpt-image-2",
        defaultBranch: "main",
        stars: 0,
        topics: ["gpt-image-2", "prompts", "image"],
    },
    {
        name: "awesome-nano-banana-pro-prompts",
        description: "World's largest Nano Banana Pro prompt library — 10,000+ curated prompts with preview images, 16 languages.",
        homepage: "https://github.com/YouMind-OpenLab/awesome-nano-banana-pro-prompts",
        defaultBranch: "main",
        stars: 0,
        topics: ["nano-banana-pro", "gemini", "prompts", "image"],
    },
    {
        name: "awesome-seedance-2-prompts",
        description: "2000+ curated Seedance 2.0 video generation prompts — cinematic, anime, UGC, ads, meme styles.",
        homepage: "https://github.com/YouMind-OpenLab/awesome-seedance-2-prompts",
        defaultBranch: "main",
        stars: 0,
        topics: ["seedance-2", "prompts", "video"],
    },
    {
        name: "awesome-grok-imagine-prompts",
        description: "Curated Grok Imagine (xAI) video generation prompts — cinematic, action, anime, product, meme styles.",
        homepage: "https://github.com/YouMind-OpenLab/awesome-grok-imagine-prompts",
        defaultBranch: "main",
        stars: 0,
        topics: ["grok-imagine", "prompts", "video"],
    },
    {
        name: "awesome-seedream-4.5",
        description: "100+ hand-picked Seedream 4.5 prompts with images, multilingual support, and instant gallery preview.",
        homepage: "https://github.com/YouMind-OpenLab/awesome-seedream-4.5",
        defaultBranch: "main",
        stars: 0,
        topics: ["seedream", "prompts", "image"],
    },
    {
        name: "awesome-gpt-image-1.5",
        description: "100+ selected GPT Image 1.5 prompts with images, multilingual support, and instant gallery preview.",
        homepage: "https://github.com/YouMind-OpenLab/awesome-gpt-image-1.5",
        defaultBranch: "main",
        stars: 0,
        topics: ["gpt-image-1.5", "prompts", "image"],
    },
    {
        name: "awesome-gemini-3-prompts",
        description: "50+ selected Gemini prompts with images, multilingual support, and instant gallery preview.",
        homepage: "https://github.com/YouMind-OpenLab/awesome-gemini-3-prompts",
        defaultBranch: "main",
        stars: 0,
        topics: ["gemini-3", "prompts", "image"],
    },
    {
        name: "awesome-christmas-card-prompts",
        description: "A curated collection of high-quality Christmas card prompts designed for Nano Banana Pro and modern image generation models.",
        homepage: "https://github.com/YouMind-OpenLab/awesome-christmas-card-prompts",
        defaultBranch: "main",
        stars: 0,
        topics: ["christmas", "prompts", "image"],
    },
];
