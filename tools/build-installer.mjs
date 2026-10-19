/**
 * Build a Windows installer.
 *
 * ## What the user gets
 *
 * One `Buddy Desktop Setup.exe`. Running it installs the app under the user's local
 * programs, creates Start-menu and desktop shortcuts, and registers an uninstaller
 * — the same shape as any other Windows program. After that it is double-clicked,
 * not served from a terminal.
 *
 * ## What goes inside
 *
 * The installed tree is Electron plus the app: the window shell, the server, the
 * core modules and the built page. The account store is deliberately absent — it is
 * read from the user's own home directory at run time.
 *
 * ## Why NSIS directly
 *
 * electron-builder would add a large dependency to invoke the same NSIS that is
 * already cached on this machine. Writing the script keeps the build legible and
 * runs offline.
 *
 * Run: node tools/build-installer.mjs
 *
 * @module buddy-desktop/tools/build-installer
 */

import { execFileSync } from 'node:child_process'
import {
  cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
// The output goes to a drive with room for it. A Windows installer stages a full
// Electron tree (about 250 MB) before compressing it, and the workspace drive can
// be nearly full; failing at that point wastes the whole build.
const BUILD = process.env.BUDDY_BUILD_DIR ?? 'F:\\buddy-desktop-build'
const STAGE = join(BUILD, 'installer-stage')
const APP_NAME = 'Buddy Desktop'
const APP_ID = 'BuddyDesktop'

mkdirSync(BUILD, { recursive: true })

/** Locate the cached NSIS that electron-builder left behind. */
function findMakensis() {
  const cache = join(process.env.LOCALAPPDATA ?? '', 'electron-builder', 'Cache')
  if (!existsSync(cache)) return undefined
  for (const entry of readdirSync(cache)) {
    if (!entry.startsWith('nsis-3')) continue
    const dir = join(cache, entry)
    const candidates = []
    for (const inner of readdirSync(dir)) {
      candidates.push(join(dir, inner, 'makensis.exe'))
      candidates.push(join(dir, inner, 'Bin', 'makensis.exe'))
    }
    candidates.push(join(dir, 'makensis.exe'))
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

/**
 * Copy a tree, optionally trimming what the packaged app does not need.
 *
 * @param from - source directory.
 * @param to - destination directory.
 * @param options - `skip` names to leave out, `keepLocales` locale packs to keep.
 */
function copyTree(from, to, options = {}) {
  const keepLocales = options.keepLocales
  const skip = options.skip ?? []
  cpSync(from, to, {
    recursive: true,
    dereference: true,
    filter: (source) => {
      const parts = source.split(/[\\/]/)
      const name = parts[parts.length - 1]
      if (skip.includes(name)) return false
      // Only files inside `locales` are filtered; the directory itself must be kept
      // or its contents are never visited.
      if (keepLocales !== undefined && parts.includes('locales')) {
        let isFile = false
        try {
          isFile = statSync(source).isFile()
        } catch {
          isFile = false
        }
        if (!isFile) return true
        return keepLocales.includes(name)
      }
      return true
    }
  })
}

function run(label, command, args, options = {}) {
  process.stdout.write(`  ${label} … `)
  try {
    execFileSync(command, args, { stdio: 'pipe', ...options })
    console.log('ok')
  } catch (error) {
    console.log('失败')
    console.error(error.stdout?.toString() ?? '')
    console.error(error.stderr?.toString() ?? '')
    throw new Error(`${label} 失败`)
  }
}

console.log('构建 Windows 安装包')

// 1. The page must be current, and inside the tree the server serves.
run('构建界面', process.execPath, [
  join(ROOT, 'packages', 'ui', 'node_modules', 'vite', 'bin', 'vite.js'),
  'build'
], { cwd: join(ROOT, 'packages', 'ui') })

// 2. Lay out the application as it will exist after installation.
console.log('  准备应用目录 …')
rmSync(STAGE, { recursive: true, force: true })
const appRoot = join(STAGE, 'app')
mkdirSync(appRoot, { recursive: true })

const electronDist = join(ROOT, 'node_modules', 'electron', 'dist')
if (!existsSync(join(electronDist, 'electron.exe'))) {
  console.error('\n缺少 Electron。先运行：node node_modules/electron/install.js')
  process.exit(1)
}
copyTree(electronDist, appRoot, {
  // Electron ships 55 locale packs (~48 MB); this app's interface is Chinese and
  // English, so the rest would be dead weight in the installer.
  keepLocales: ['zh-CN.pak', 'zh-TW.pak', 'en-US.pak', 'en-GB.pak']
})

// The app itself, with only what it needs at run time.
const resources = join(appRoot, 'resources')
const appDir = join(resources, 'app')
mkdirSync(appDir, { recursive: true })

writeFileSync(join(appDir, 'package.json'), JSON.stringify({
  name: 'buddy-desktop',
  version: '0.1.0',
  description: 'WorkBuddy 多账号桌面应用',
  main: 'main.cjs',
  type: 'commonjs'
}, null, 2), 'utf8')

// The window shell becomes the Electron entry point.
copyTree(join(ROOT, 'packages', 'desktop', 'src'), join(appDir, 'src'))
cpSync(join(ROOT, 'packages', 'desktop', 'src', 'main.cjs'), join(appDir, 'main.cjs'))

// The server, core and page travel inside the asar-less tree, which Electron loads
// directly: no packing step is needed, and a stack trace still points at real files.
// The provider plugin is generated at install time from plugin-source.js, because
// its manifest has to match the harness on the target machine. Nothing to copy here.

for (const [name, source] of [
  ['server', join(ROOT, 'packages', 'server')],
  ['core', join(ROOT, 'packages', 'core')],
  ['ui', join(ROOT, 'packages', 'ui')]
]) {
  const target = join(appDir, 'node_modules', '@buddy-desktop', name)
  mkdirSync(target, { recursive: true })
  copyTree(join(source, 'src'), join(target, 'src'))
  const manifest = join(source, 'package.json')
  if (existsSync(manifest)) cpSync(manifest, join(target, 'package.json'))
  if (name === 'ui' && existsSync(join(source, 'dist'))) {
    copyTree(join(source, 'dist'), join(target, 'dist'))
  }
}

// The server resolves the page relative to its own file, so the built page is also
// placed where that lookup expects it.
const uiDist = join(ROOT, 'packages', 'ui', 'dist')
if (existsSync(uiDist)) {
  copyTree(uiDist, join(appDir, 'node_modules', '@buddy-desktop', 'ui', 'dist'))
}

// Electron reads its entry from `resources/app/package.json`. Remove the default one
// so the app's own manifest is used.
const defaultAsar = join(resources, 'app.asar')
if (existsSync(defaultAsar)) rmSync(defaultAsar, { force: true })

writeFileSync(join(resources, 'app', 'README.txt'),
  'Buddy Desktop\n\n账号库位于用户目录，不随程序分发。\n', 'utf8')

// 3. Write the installer script.
const makensis = findMakensis()
if (makensis === undefined) {
  console.error('\n找不到 makensis（NSIS）。需要 electron-builder 缓存或已安装 NSIS。')
  process.exit(1)
}
console.log(`  使用 NSIS: ${makensis}`)

const nsiPath = join(BUILD, 'installer.nsi')
// `Unicode true` requires the script itself to be encoded as UTF-8 *with* a BOM or
// as UTF-16; a plain UTF-8 file is rejected as "Bad text encoding".
const script = `; Generated by tools/build-installer.mjs — do not edit.
Unicode true
SetCompressor /SOLID lzma

!include "MUI2.nsh"

Name "${APP_NAME}"
OutFile "${join(BUILD, 'BuddyDesktop-Setup.exe').replace(/\\/g, '\\\\')}"
InstallDir "$LOCALAPPDATA\\Programs\\${APP_ID}"
InstallDirRegKey HKCU "Software\\${APP_ID}" "InstallDir"
RequestExecutionLevel user
ShowInstDetails show

!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\\electron.exe"
!define MUI_FINISHPAGE_RUN_TEXT "立即运行 ${APP_NAME}"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

Section "Install"
  SetOutPath "$INSTDIR"
  ; The whole Electron tree plus the app, as staged.
  File /r "${STAGE}\\app\\*.*"

  ; Shortcuts: Start menu and desktop, like any Windows program.
  ;
  ; The desktop folder is resolved through the shell API rather than the DESKTOP
  ; constant, which points at the wrong place for a per-user install (it resolved
  ; to nothing, so the shortcut was silently skipped).
  SetShellVarContext current
  CreateDirectory "$SMPROGRAMS\\${APP_NAME}"
  CreateShortCut "$SMPROGRAMS\\${APP_NAME}\\${APP_NAME}.lnk" "$INSTDIR\\electron.exe" "" "$INSTDIR\\electron.exe" 0
  CreateShortCut "$SMPROGRAMS\\${APP_NAME}\\卸载 ${APP_NAME}.lnk" "$INSTDIR\\Uninstall.exe"
  CreateShortCut "$DESKTOP\\${APP_NAME}.lnk" "$INSTDIR\\electron.exe" "" "$INSTDIR\\electron.exe" 0
  ; Also place one in the all-users desktop when that folder is writable, so the
  ; icon is visible even when the per-user shell folder is redirected.
  ClearErrors
  CreateShortCut "$COMMON_DESKTOP\\${APP_NAME}.lnk" "$INSTDIR\\electron.exe" "" "$INSTDIR\\electron.exe" 0
  ClearErrors

  WriteUninstaller "$INSTDIR\\Uninstall.exe"

  WriteRegStr HKCU "Software\\${APP_ID}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${APP_ID}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${APP_ID}" "DisplayVersion" "0.1.0"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${APP_ID}" "UninstallString" "$INSTDIR\\Uninstall.exe"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${APP_ID}" "DisplayIcon" "$INSTDIR\\electron.exe"
  WriteRegDWORD HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${APP_ID}" "NoModify" 1
  WriteRegDWORD HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${APP_ID}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  Delete "$DESKTOP\\${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\\${APP_NAME}\\${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\\${APP_NAME}\\卸载 ${APP_NAME}.lnk"
  RMDir "$SMPROGRAMS\\${APP_NAME}"

  DeleteRegKey HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${APP_ID}"
  DeleteRegKey HKCU "Software\\${APP_ID}"

  ; The program files go; the user's account store is left alone on purpose.
  RMDir /r "$INSTDIR"
SectionEnd
`

writeFileSync(nsiPath, `\uFEFF${script}`, 'utf8')

// 4. Compile.
run('编译安装包', makensis, ['/V2', nsiPath])

const outExe = join(BUILD, 'BuddyDesktop-Setup.exe')
if (!existsSync(outExe)) {
  console.error('\n安装包没有生成。')
  process.exit(1)
}
const size = statSync(outExe).size
console.log('')
console.log(`已生成 ${outExe}（${Math.round(size / 1024 / 1024)} MB）`)
console.log('')
console.log('双击安装后：桌面和开始菜单会出现 Buddy Desktop 图标。')
