/**
 * Build the single executable.
 *
 * Runs the whole chain in order — the page, the embed step, the module bundle, the
 * SEA blob, and the injection — because each depends on the previous one and a
 * skipped step produces an exe that starts and then misbehaves.
 *
 * Run: node tools/build-exe.mjs
 *
 * @module buddy-desktop/tools/build-exe
 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const BUILD = join(ROOT, 'build')
const OUT_EXE = join(BUILD, 'buddy-desktop.exe')

/** The fuse Node looks for inside a SEA binary. */
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'

/** Run a command, failing the build if it fails. */
function run(label, command, args, options = {}) {
  process.stdout.write(`  ${label} … `)
  try {
    execFileSync(command, args, { cwd: ROOT, stdio: 'pipe', ...options })
    console.log('ok')
  } catch (error) {
    console.log('失败')
    const out = error.stdout?.toString() ?? ''
    const err = error.stderr?.toString() ?? ''
    console.error(`\n${out}\n${err}`)
    throw new Error(`${label} 失败`)
  }
}

mkdirSync(BUILD, { recursive: true })

console.log('构建单文件可执行程序')

// 1. The page. Vite is invoked through the current Node rather than through pnpm:
//    the build must not depend on a `pnpm` on PATH, which another shell may not
//    have, and running its entry script is one less moving part.
const viteBin = join(ROOT, 'packages', 'ui', 'node_modules', 'vite', 'bin', 'vite.js')
if (!existsSync(viteBin)) {
  console.error('\n缺少 vite。先运行：pnpm install')
  process.exit(1)
}
run('构建界面', process.execPath, [viteBin, 'build'], { cwd: join(ROOT, 'packages', 'ui') })

// 2. Inline the page into the entry point.
run('内嵌页面', process.execPath, [join(ROOT, 'tools', 'embed-ui.mjs')])

// 3. Flatten the modules.
run('打包模块', process.execPath, [join(ROOT, 'tools', 'bundle.mjs')])

// 4. The SEA preparation blob.
const seaConfig = {
  main: 'build/buddy-desktop.cjs',
  output: 'build/buddy-desktop.blob',
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false
}
writeFileSync(join(BUILD, 'sea-config.json'), JSON.stringify(seaConfig, null, 2), 'utf8')
run('生成 blob', process.execPath, ['--experimental-sea-config', join(BUILD, 'sea-config.json')])

// 5. Copy the Node binary and inject. The result is a Node runtime with the app
//    inside it, so the machine needs no Node install.
console.log('  复制运行时 …')
copyFileSync(process.execPath, OUT_EXE)

const postject = join(ROOT, 'node_modules', 'postject', 'dist', 'cli.js')
if (!existsSync(postject)) {
  console.error('\n缺少 postject。先运行：pnpm add -D -w postject')
  process.exit(1)
}
run('注入', process.execPath, [
  postject,
  OUT_EXE,
  'NODE_SEA_BLOB',
  join(BUILD, 'buddy-desktop.blob'),
  '--sentinel-fuse',
  FUSE
])

const size = statSync(OUT_EXE).size
console.log('')
console.log(`已生成 build/buddy-desktop.exe（${Math.round(size / 1024 / 1024)} MB）`)
console.log('')
console.log('直接双击即可运行，不需要安装 Node。')
console.log('换端口：buddy-desktop.exe --port 5190')
