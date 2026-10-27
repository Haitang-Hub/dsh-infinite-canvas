#!/usr/bin/env node
/**
 * 同步插件包运行资产（打包前执行）：
 *   1. canvas-agent 单文件桥（dist-bundle/）→ bridge/   —— 桥进程入口
 *   2. web/dist → site/                                 —— 前端构建产物
 *
 * 双分支布局：
 *   - full：插件在 dsh-plugin/ 子目录，源码（web/、canvas-agent/）在仓库根，
 *     本脚本把构建产物同步进插件包；
 *   - main：插件提根（插件内容即仓库根），仓库内没有源码，bridge/、site/
 *     以入库产物为准，脚本跳过同步，保证 `npm run pack:all` 直接可用。
 *     需要在 main 上重建产物时，设 CANVAS_PLUGIN_SOURCE_ROOT 指向 full
 *     分支的检出目录（如 git worktree add ../infinite-canvas-full full）。
 *
 * 前置（仅 full / 指定 sourceRoot 时）：canvas-agent 先 `npm run build:bundle`
 * （esbuild 单文件，无需 node_modules），web 先 `npm run build`。
 */

import { cpSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const sourceRoot = process.env.CANVAS_PLUGIN_SOURCE_ROOT
  ?? (basename(pluginRoot) === 'dsh-plugin' ? join(pluginRoot, '..') : null)

if (!sourceRoot) {
  console.warn('[sync] 当前是插件产物分支（main）：仓库内没有 web/、canvas-agent/ 源码，跳过同步，直接使用已入库的 bridge/ 与 site/。')
  console.warn('[sync] 重新构建：切到 full 分支（git checkout full，或 git worktree add ../infinite-canvas-full full）后运行 npm run pack:all；')
  console.warn('[sync] 或设 CANVAS_PLUGIN_SOURCE_ROOT=<full 检出目录> 后重试。构建完成后把 bridge/、site/ 覆盖回本分支提交（见 README「构建与安装」）。')
  process.exit(0)
}

const bridgeSource = join(sourceRoot, 'canvas-agent', 'dist-bundle')
const bridgeTarget = join(pluginRoot, 'bridge')
const siteSource = join(sourceRoot, 'web', 'dist')
const siteTarget = join(pluginRoot, 'site')

function mustExist(path, hint) {
  if (!existsSync(path)) {
    console.error(`[sync] 缺少 ${path} —— ${hint}`)
    process.exit(1)
  }
}

function replaceDir(source, target, items) {
  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })
  for (const item of items) {
    const from = join(source, item)
    if (!existsSync(from)) continue
    cpSync(from, join(target, item), { recursive: true, dereference: true })
  }
}

mustExist(join(bridgeSource, 'index.js'), '先在 canvas-agent/ 运行 npm run build:bundle（esbuild 单文件桥）')
replaceDir(bridgeSource, bridgeTarget, ['index.js', 'agent-instructions.md', 'package.json'])

const hasSite = existsSync(siteSource) && statSync(siteSource).isDirectory()
if (hasSite) {
  rmSync(siteTarget, { recursive: true, force: true })
  cpSync(siteSource, siteTarget, { recursive: true, dereference: true })
  console.log('[sync] bridge/ 与 site/ 已更新')
} else {
  console.warn('[sync] web/dist 不存在，跳过 site/（面板 iframe 需要；先在 web/ 运行 npm run build）')
  console.log('[sync] bridge/ 已更新')
}
