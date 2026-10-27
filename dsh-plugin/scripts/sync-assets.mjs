#!/usr/bin/env node
/**
 * 同步插件包运行资产（打包前执行）：
 *   1. canvas-agent 单文件桥（dist-bundle/）→ dsh-plugin/bridge/   —— 桥进程入口
 *   2. web/dist → dsh-plugin/site/                                 —— 前端构建产物
 *
 * bridge/ 与 site/ 是生成目录（.gitignore 排除），权威源在各自上游目录。
 * 前置：canvas-agent 先 `npm run build:bundle`（esbuild 单文件，无需 node_modules），
 *       web 先 `npm run build`。
 */

import { cpSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = join(pluginRoot, '..')

const bridgeSource = join(repoRoot, 'canvas-agent', 'dist-bundle')
const bridgeTarget = join(pluginRoot, 'bridge')
const siteSource = join(repoRoot, 'web', 'dist')
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
