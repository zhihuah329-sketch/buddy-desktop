/**
 * Capture each page in both themes.
 *
 * The theme is forced through the URL (`?theme=light`) rather than by clicking, so a
 * capture cannot be affected by whatever the machine's system preference happens to
 * be. A small shim in the page reads it before the first paint.
 *
 * Run: node tools/capture.mjs
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const OUT = join(ROOT, 'build', 'shots')
mkdirSync(OUT, { recursive: true })

const { startServer } = await import(pathToFileURL(join(ROOT, 'packages/server/src/index.js')).href)

const CHROME = [
  join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  join(process.env.ProgramFiles ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe')
].find((path) => existsSync(path))

if (CHROME === undefined) {
  console.error('找不到 Chrome。')
  process.exit(1)
}

const PAGES = [
  { id: 'overview', name: 'overview' },
  { id: 'cn', name: 'cn' },
  { id: 'ai', name: 'ai' },
  { id: 'command-code', name: 'command-code' },
  { id: 'settings', name: 'settings' }
]

const running = await startServer({ port: 5412 })
try {
  for (const theme of ['dark', 'light']) {
    console.log(`\n${theme === 'dark' ? '深色' : '浅色'}`)
    for (const page of PAGES) {
      const target = join(OUT, `${theme}-${page.name}.png`)
      execFileSync(CHROME, [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--force-device-scale-factor=1.6',
        '--window-size=1000,700',
        `--screenshot=${target}`,
        '--virtual-time-budget=9000',
        '--run-all-compositor-stages-before-draw',
        // The query string is read by the theme module, which applies the mode
        // before the first paint.
        `${running.url}/?theme=${theme}#/${page.id}`
      ], { stdio: 'pipe', timeout: 60000 })
      const size = existsSync(target) ? Math.round(statSync(target).size / 1024) : 0
      console.log(`  ${page.name.padEnd(14)} ${size} KB`)
    }
  }
} finally {
  await running.close()
}
