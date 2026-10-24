import { readdirSync, readFileSync } from "node:fs";
import net from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

import { parseChangelog } from "./src/lib/release";

const webDir = dirname(fileURLToPath(import.meta.url));
const localVersion = readFileSync(resolve(webDir, "../VERSION"), "utf8").trim() || "dev";
const localChangelog = readFileSync(resolve(webDir, "../CHANGELOG.md"), "utf8");

// Preferred dev port; when it is taken (e.g. the original Canvas Director app is
// running), fall back to 5075 instead of vite's default +1 increments.
const PREFERRED_PORT = 5070;
const FALLBACK_PORT = 5075;

function checkPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolvePromise) => {
        const probe = net.createServer();
        probe.once("error", () => resolvePromise(false));
        probe.once("close", () => resolvePromise(true));
        probe.listen(port, "0.0.0.0", () => probe.close());
    });
}

// Expose /plugins/index.json with local plugin files from public/plugins.
// The frontend can discover and list them when enabled; development reads the directory live, while builds emit a static registry.
function localPluginsManifest(): Plugin {
    const pluginsDir = resolve(webDir, "public/plugins");
    const listLocalPlugins = () => {
        try {
            return readdirSync(pluginsDir)
                .filter((file) => file.endsWith(".js"))
                .sort()
                .map((file) => `/plugins/${file}`);
        } catch {
            return [];
        }
    };
    return {
        name: "local-plugins-manifest",
        configureServer(server) {
            server.middlewares.use("/plugins/index.json", (_req, res) => {
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify(listLocalPlugins()));
            });
        },
        generateBundle() {
            this.emitFile({ type: "asset", fileName: "plugins/index.json", source: JSON.stringify(listLocalPlugins()) });
        },
    };
}

export default defineConfig(async () => {
    const port = (await checkPortAvailable(PREFERRED_PORT)) ? PREFERRED_PORT : FALLBACK_PORT;
    return {
        base: process.env.VITE_BASE || "/",
        plugins: [react(), localPluginsManifest()],
        resolve: {
            alias: {
                "@": resolve(webDir, "src"),
            },
        },
        define: {
            __APP_VERSION__: JSON.stringify(localVersion),
            __APP_RELEASES__: JSON.stringify(parseChangelog(localChangelog)),
        },
        server: { port },
    };
});
