/**
 * Inline the built page into the entry point, for the single-executable build.
 *
 * A packaged app is one file with no `dist/` beside it, so the page has to travel
 * inside the script. This rewrites the `EMBEDDED` table in `sea-entry.js` with the
 * current build's contents.
 *
 * Run after `pnpm build`: node tools/embed-ui.mjs
 *
 * @module buddy-desktop/tools/embed-ui
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DIST = join(ROOT, 'packages', 'ui', 'dist')
const ENTRY = join(ROOT, 'packages', 'server', 'src', 'sea-entry.js')

/** Every file under the build output, as `{ path, content }`. */
function collect(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      collect(full, base, out)
      continue
    }
    const key = relative(base, full).split('\\').join('/')
    out.push({ key, content: readFileSync(full, 'utf8') })
  }
  return out
}

const assets = collect(DIST)
const entries = assets
  .map(({ key, content }) => `  ${JSON.stringify(key)}: ${JSON.stringify(content)}`)
  .join(',\n')

const source = readFileSync(ENTRY, 'utf8')
const replaced = source.replace(
  /const EMBEDDED = \{[\s\S]*?\n\}/,
  `const EMBEDDED = {\n${entries}\n}`
)

if (replaced === source && !source.includes('const EMBEDDED = {})')) {
  // The table was already populated; the replacement above still ran because the
  // pattern matches both an empty and a filled table.
}

writeFileSync(ENTRY, replaced, 'utf8')
const total = assets.reduce((sum, asset) => sum + asset.content.length, 0)
console.log(`已内嵌 ${assets.length} 个资源（${Math.round(total / 1024)} KB）`)
for (const asset of assets) console.log(`  ${asset.key}`)
