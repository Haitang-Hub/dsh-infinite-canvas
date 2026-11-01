#!/usr/bin/env node
/**
 * 插件壳一致性校验（advisory，恒退出 0）。
 *
 * dsh-infinite-canvas 与 dsh-3d-director-desk 的壳代码（dsh/index.js、lib/client.js、
 * cordis.patch.yml）刻意保持同构：守护/探测/重启逻辑一处在两边同步改。本脚本把两边的
 * 壳文件按「插件差异映射表」归一化后 diff，剩下的差异行要么是预期内的插件特有功能，
 * 要么就是壳漂移——先判断，再决定是否同步。
 *
 * 用法：
 *   node scripts/check-shell-parity.mjs <兄弟仓库 dsh-plugin 目录>
 *   SIBLING_PLUGIN_DIR=../3d-director-desk/dsh-plugin node scripts/check-shell-parity.mjs
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = join(dirname(fileURLToPath(import.meta.url)), '..')
const sibling = process.argv[2] || process.env.SIBLING_PLUGIN_DIR
if (!sibling) {
  console.error('用法：node check-shell-parity.mjs <兄弟仓库 dsh-plugin 目录>（或设 SIBLING_PLUGIN_DIR）')
  process.exit(1)
}

/** 插件差异映射：两边等价的 token 归一化为同一占位符（顺序无关，按正则逐个替换）。 */
const REPLACEMENTS = [
  [/dsh-infinite-canvas/g, '«plugin-id»'],
  [/dsh-3d-director-desk/g, '«plugin-id»'],
  [/canvas-agent/g, '«bridge»'],
  [/director-mcp/g, '«bridge»'],
  [/infinite-canvas/g, '«slug»'],
  [/director-desk/g, '«slug»'],
  [/17371|17372/g, '«port»'],
  [/CANVAS_AGENT_PORT|DIRECTOR_DESK_PORT/g, '«port-env»'],
  [/CANVAS_SITE_DIR|DIRECTOR_SITE_DIR/g, '«site-env»'],
  [/CANVAS_AGENT_HOME|DIRECTOR_STORE_DIR/g, '«data-env»'],
  [/STORE_PORT/g, 'PORT'],
  [/dshHomePath\('[^']+'\)/g, "dshHomePath('«root»')"],
  [/画布|导演台/g, '«产品»'],
  [/\d+\.\d+\.\d+/g, '«ver»'],
]

function normalize(root, rel) {
  const text = readFileSync(join(root, rel), 'utf8').replace(/\r\n/g, '\n')
  return REPLACEMENTS.reduce((acc, [re, to]) => acc.replace(re, to), text)
}

const FILES = ['dsh/index.js', 'lib/client.js', 'cordis.patch.yml']
const tmp = mkdtempSync(join(tmpdir(), 'shell-parity-'))
let drift = false

for (const rel of FILES) {
  const a = join(tmp, `a-${rel.replaceAll('/', '-')}`)
  const b = join(tmp, `b-${rel.replaceAll('/', '-')}`)
  try {
    writeFileSync(a, normalize(here, rel))
    writeFileSync(b, normalize(sibling, rel))
  } catch (error) {
    console.error(`[parity] 无法读取 ${rel}：${error.message}`)
    drift = true
    continue
  }
  let diffText = ''
  try {
    diffText = execFileSync('git', ['diff', '--no-index', '--unified=2', a, b], { encoding: 'utf8' })
  } catch (error) {
    // git diff --no-index 在有差异时退出码为 1，输出走 stdout。
    diffText = String(error.stdout || error.message)
  }
  const changed = diffText
    .split('\n')
    .filter(line => (line.startsWith('+') || line.startsWith('-')) && !line.startsWith('+++') && !line.startsWith('---'))
  if (changed.length) {
    drift = true
    console.log(`\n[parity] ${rel}：归一化后仍有 ${changed.length} 行差异`)
    console.log(changed.slice(0, 60).join('\n'))
    if (changed.length > 60) console.log(`… 其余 ${changed.length - 60} 行省略`)
  } else {
    console.log(`[parity] ${rel}：一致 ✓`)
  }
}

console.log(
  drift
    ? '\n[parity] 存在壳差异：先判断是否预期（插件特有功能，如画布的工作台注册、导演台的 instanceId 导航），否则把共享逻辑同步到两边（见 SHELL-SYNC.md）。'
    : '\n[parity] 壳完全一致。',
)
process.exit(0)
