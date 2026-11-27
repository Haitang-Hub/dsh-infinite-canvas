import { Home } from "lucide-react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";

export default function NotFound() {
    const { t } = useTranslation();
    return (
        <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
            <main className="flex h-full min-h-0 items-center justify-center overflow-y-auto bg-background bg-[radial-gradient(var(--dsw-alias-border-l3)_1px,transparent_1px)] px-6 py-10 text-[var(--dsw-alias-label-primary)] [background-size:16px_16px]">
                <section className="w-full max-w-md text-center">
                    <div className="mx-auto mb-6 flex size-16 items-center justify-center rounded-lg border border-[var(--dsw-alias-border-l2)] bg-[var(--dsw-alias-bg-layer-1)] text-2xl font-semibold shadow-sm">404</div>
                    <h1 className="text-3xl font-semibold tracking-normal">{t("notFound.title")}</h1>
                    <p className="mt-3 text-sm leading-6 text-[var(--dsw-alias-label-tertiary)]">{t("notFound.description")}</p>
                    <div className="mt-8 flex flex-wrap justify-center gap-3">
                        <Link to="/" className="inline-flex h-10 items-center gap-2 rounded-lg bg-[var(--dsw-alias-brand-primary)] px-4 text-sm font-medium text-[var(--dsw-alias-label-primary-foreground)] transition hover:bg-[var(--dsw-alias-label-secondary)]">
                            <Home className="size-4" />
                            {t("notFound.home")}
                        </Link>
                    </div>
                </section>
            </main>
        </div>
    );
}
