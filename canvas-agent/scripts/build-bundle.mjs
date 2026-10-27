#!/usr/bin/env node
/**
 * 打包插件桥用的 esbuild 单文件产物（dist-bundle/）：
 *   - index.js：canvas-agent 全量依赖内联（express / MCP SDK / zod / winston 等），
 *     dsh-plugin 无需携带 node_modules 即可 spawn；
 *   - agent-instructions.md、package.json：运行时按 import.meta.url 相对读取的资源，
 *     与 bundle 同目录放置（config.ts 的 readBundledFile 候选覆盖两种布局）。
 *
 * 常规 tsc 构建（npm run build）不受影响，dist/ 仍是发布 npm 包的产物。
 */

import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "dist-bundle");

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

await build({
    entryPoints: [join(root, "src/index.ts")],
    bundle: true,
    platform: "node",
    target: "node18",
    format: "esm",
    outfile: join(outDir, "index.js"),
    sourcemap: false,
    minify: false,
    legalComments: "none",
    // ESM 输出中 CJS 依赖（express/winston 等）会动态 require 内置模块，
    // 注入 createRequire 让这些调用落回真实 Node 模块解析。
    banner: {
        js: "import { createRequire as __bundleCreateRequire } from 'node:module';\nconst require = __bundleCreateRequire(import.meta.url);",
    },
});

copyFileSync(join(root, "agent-instructions.md"), join(outDir, "agent-instructions.md"));
copyFileSync(join(root, "package.json"), join(outDir, "package.json"));
console.log("[build-bundle] dist-bundle/index.js ready");
