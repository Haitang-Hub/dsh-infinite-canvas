import { App, Button, Empty, Input, Modal, Select, Spin, Tag } from "antd";
import { Search, Star } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { createPromptSource, type PromptSource } from "@/services/api/prompt-source-presets";
import { DEFAULT_PROMPT_ORG, FALLBACK_PROMPT_REPOS, buildReadmeSourceUrl, fetchOrgPromptRepos, inferRepoMediaType, readmeFileForLanguage, type GithubPromptRepo } from "@/services/api/github-prompt-sources";

export function PromptGithubPickerModal({ open, onPick, onClose }: { open: boolean; onPick: (source: PromptSource) => void; onClose: () => void }) {
    const { message } = App.useApp();
    const { i18n, t } = useTranslation();
    const [org, setOrg] = useState(DEFAULT_PROMPT_ORG);
    const [repos, setRepos] = useState<GithubPromptRepo[]>([]);
    const [loadedOrg, setLoadedOrg] = useState("");
    const [loading, setLoading] = useState(false);
    const [keyword, setKeyword] = useState("");
    const [mediaFilter, setMediaFilter] = useState<"all" | "image" | "video">("all");
    const [selectedName, setSelectedName] = useState("");
    const [mediaType, setMediaType] = useState<"image" | "video">("image");

    const filteredRepos = useMemo(() => {
        const query = keyword.trim().toLowerCase();
        return repos.filter((repo) => {
            if (mediaFilter !== "all" && inferRepoMediaType(repo) !== mediaFilter) return false;
            if (!query) return true;
            return repo.name.toLowerCase().includes(query) || repo.description.toLowerCase().includes(query);
        });
    }, [repos, keyword, mediaFilter]);

    const selected = repos.find((repo) => repo.name === selectedName) || null;

    useEffect(() => {
        if (open && !repos.length) {
            setRepos(FALLBACK_PROMPT_REPOS);
            setLoadedOrg(DEFAULT_PROMPT_ORG);
        }
    }, [open, repos.length]);

    const loadRepos = async () => {
        const value = org.trim();
        if (!value) return message.warning(t("config.promptSources.github.orgRequired"));
        setLoading(true);
        try {
            const result = await fetchOrgPromptRepos(value);
            setRepos(result);
            setLoadedOrg(value);
            setSelectedName("");
            if (!result.length) message.info(t("config.promptSources.github.empty"));
        } catch (error) {
            if (value.trim().toLowerCase() === DEFAULT_PROMPT_ORG.toLowerCase()) {
                setRepos(FALLBACK_PROMPT_REPOS);
                setLoadedOrg(value.trim());
                setSelectedName("");
                message.warning(t("config.promptSources.github.liveFailed", { status: error instanceof Error ? error.message : String(error) }));
            } else {
                message.error(t("config.promptSources.github.loadFailed", { status: error instanceof Error ? error.message : String(error) }));
            }
        } finally {
            setLoading(false);
        }
    };

    const confirm = () => {
        if (!loadedOrg || !selected) return message.warning(t("config.promptSources.github.pickRequired"));
        onPick(createPromptSource({ name: displayName(selected), url: buildReadmeSourceUrl(loadedOrg, selected, readmeFileForLanguage(i18n.resolvedLanguage)), homepage: selected.homepage, mediaType }));
        reset();
        onClose();
    };

    const reset = () => {
        setSelectedName("");
        setKeyword("");
        setMediaType("image");
    };

    return (
        <Modal
            open={open}
            width={640}
            title={t("config.promptSources.github.title")}
            onCancel={() => { reset(); onClose(); }}
            onOk={confirm}
            okText={t("config.promptSources.github.confirm")}
            cancelText={t("common.cancel")}
            okButtonProps={{ disabled: !selected }}
        >
            <div className="space-y-4">
                <div className="flex gap-2">
                    <Input value={org} onChange={(event) => setOrg(event.target.value)} onPressEnter={() => void loadRepos()} placeholder={t("config.promptSources.github.orgPlaceholder")} addonBefore={t("config.promptSources.github.org")} />
                    <Button type="primary" loading={loading} onClick={() => void loadRepos()}>
                        {t("config.promptSources.github.load")}
                    </Button>
                </div>
                <Spin spinning={loading}>
                    {repos.length ? (
                        <div className="space-y-2">
                            <div className="flex items-center gap-2">
                                <Select
                                    className="w-24 shrink-0"
                                    value={mediaFilter}
                                    onChange={(value) => setMediaFilter(value as "all" | "image" | "video")}
                                    options={[
                                        { value: "all", label: t("config.promptSources.media.all") },
                                        { value: "image", label: t("config.promptSources.media.image") },
                                        { value: "video", label: t("config.promptSources.media.video") },
                                    ]}
                                />
                                <Input allowClear prefix={<Search className="size-3.5 text-stone-400" />} value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder={t("config.promptSources.github.search")} />
                                <Button loading={loading} onClick={() => void loadRepos()} title={t("config.promptSources.github.refresh")}>
                                    {t("config.promptSources.github.refresh")}
                                </Button>
                            </div>
                            <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
                                {filteredRepos.map((repo) => (
                                    <button
                                        key={repo.name}
                                        type="button"
                                        onClick={() => {
                                            setSelectedName(repo.name);
                                            setMediaType(inferRepoMediaType(repo));
                                        }}
                                        className={`block w-full rounded-lg border px-3 py-2 text-left transition-colors ${selectedName === repo.name ? "border-stone-900 bg-stone-100 dark:border-stone-200 dark:bg-stone-800" : "border-stone-200 hover:border-stone-400 dark:border-stone-800 dark:hover:border-stone-600"}`}
                                    >
                                        <div className="flex items-center gap-2">
                                            <span className="truncate text-sm font-semibold">{repo.name}</span>
                                            {repo.stars ? (
                                                <span className="flex shrink-0 items-center gap-0.5 text-xs text-stone-500">
                                                    <Star className="size-3" />
                                                    {repo.stars}
                                                </span>
                                            ) : null}
                                        </div>
                                        <div className="mt-0.5 line-clamp-2 text-xs text-stone-500">{repo.description || repo.name}</div>
                                        {repo.topics.length ? (
                                            <div className="mt-1 flex flex-wrap gap-1">
                                                {repo.topics.slice(0, 4).map((topic) => (
                                                    <Tag key={topic} className="m-0 text-[10px]">{topic}</Tag>
                                                ))}
                                            </div>
                                        ) : null}
                                    </button>
                                ))}
                                {!filteredRepos.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("config.promptSources.github.noMatch")} /> : null}
                            </div>
                            <div className="text-xs text-stone-400">{t("config.promptSources.github.readmeHint")}</div>
                        </div>
                    ) : (
                        !loading && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("config.promptSources.github.emptyHint")} />
                    )}
                </Spin>
            </div>
        </Modal>
    );
}

function displayName(repo: GithubPromptRepo) {
    return repo.name.replace(/^awesome-/, "").replace(/-/g, " ");
}
