#!/usr/bin/env node
/**
 * 同步插件包运行资产（打包前执行）：
 *   1. canvas-agent 单文件桥（dist-bundle/）→ bridge/   —— 桥进程入口
 *   2. web/dist → site/                                 —— 前端构建产物
 *
 * 双分支布局（--layout full|root 显式指定，缺省按目录形态推断）：
 *   - full：插件在 dsh-plugin/ 子目录，源码（web/、canvas-agent/）在仓库根，
 *     本脚本把构建产物同步进插件包；
 *   - root（main）：插件提根（插件内容即仓库根），仓库内没有源码，bridge/、site/
 *     以入库产物为准，脚本跳过同步，保证 `npm run pack:all` 直接可用。
 *     需要在 main 上重建产物时，设 CANVAS_PLUGIN_SOURCE_ROOT 指向 full
 *     分支的检出目录（如 git worktree add ../infinite-canvas-full full）。
 *
 * 缺产物一律硬失败（bridge 与 site 对称）：打出没有 site/ 的 tgz 装上面板 iframe
 * 直接 404，比打包失败难排查得多。确要只同步桥时传 --skip-site。
 *
 * 前置（仅 full / 指定 sourceRoot 时）：canvas-agent 先 `npm run build:bundle`
 * （esbuild 单文件，无需 node_modules），web 先 `npm run build`。
 */

import { cpSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

// 布局判定：--layout / DSH_PLUGIN_LAYOUT 显式优先，避免依赖目录名推断（目录改名即误判）。
const layoutArg = process.argv.find(arg => arg.startsWith('--layout'))
const layout = layoutArg?.split('=')[1]
  ?? process.env.DSH_PLUGIN_LAYOUT
  ?? (basename(pluginRoot) === 'dsh-plugin' ? 'full' : 'root')
const skipSite = process.argv.includes('--skip-site')

if (layout !== 'full' && layout !== 'root') {
  console.error(`[sync] 未知布局 "${layout}"：--layout 只接受 full 或 root`)
  process.exit(1)
}

const sourceRoot = process.env.CANVAS_PLUGIN_SOURCE_ROOT ?? (layout === 'full' ? join(pluginRoot, '..') : null)

if (!sourceRoot) {
  console.warn('[sync] 当前是插件产物分支（root/main）：仓库内没有 web/、canvas-agent/ 源码，跳过同步，直接使用已入库的 bridge/ 与 site/。')
  console.warn('[sync] 重新构建：切到 full 分支（git checkout full，或 git worktree add ../infinite-canvas-full full）后运行 npm run pack:all；')
  console.warn('[sync] 或设 CANVAS_PLUGIN_SOURCE_ROOT=<full 检出目录> 或 --layout full 后重试。构建完成后把 bridge/、site/ 覆盖回本分支提交（见 README「构建与安装」）。')
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
if (skipSite) {
  console.log('[sync] --skip-site：bridge/ 已更新，site/ 保持原样')
} else if (hasSite) {
  rmSync(siteTarget, { recursive: true, force: true })
  cpSync(siteSource, siteTarget, { recursive: true, dereference: true })
  console.log('[sync] bridge/ 与 site/ 已更新')
} else {
  console.error('[sync] web/dist 不存在 —— 先在 web/ 运行 npm run build。打出没有 site/ 的包会让面板 iframe 直接 404，已硬失败；确要跳过请传 --skip-site。')
  process.exit(1)
}
