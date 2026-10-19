/**
 * Load the WorkBuddy credential reader without a DSH install.
 *
 * ## The problem
 *
 * The reader lives in a content-hashed bundle shipped by `dsh-workbuddy-connect`:
 *
 *   lib/host-heartbeat-<hash>.js
 *
 * That bundle is self-contained except for one import:
 *
 *   import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
 *
 * `@deepseek-ai/dsh-home-paths` is part of DSH and cannot be installed outside a
 * harness profile. It is used only to choose a directory for four cache files.
 *
 * ## The approach
 *
 * The bundle is read once, that one specifier is rewritten to point at the local
 * shim, and the result is imported as a data: URL. Everything else in the bundle
 * keeps working because it only needs Node builtins.
 *
 * This is deliberately narrow: a single, exactly-known import is redirected, and
 * if the bundle ever needs another DSH package the rewrite stops matching and the
 * caller gets a clear error instead of a mysteriously broken reader.
 *
 * @module buddy-desktop/core/sibling
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveDshHome } from './home-paths.js'

/** The package that ships the credential reader. */
const SIBLING_PACKAGE = 'dsh-workbuddy-connect'

/** Basename prefix of its internal bundle, which is content-hashed. */
const INTERNAL_PREFIX = 'host-heartbeat-'

/** The one specifier the bundle expects from DSH. */
const DSH_HOME_SPECIFIER = '@deepseek-ai/dsh-home-paths'

/**
 * Locate the sibling package directory.
 *
 * Searched in order: this app's own `node_modules`, then an explicit override, so
 * a user who already runs the DSH plugin reuses that copy instead of installing a
 * second one.
 *
 * @returns the directory, or undefined.
 */
function locatePackage() {
  const candidates = []
  const override = process.env.BUDDY_DESKTOP_WORKBUDDY_PKG
  if (typeof override === 'string' && override.length > 0) candidates.push(override)
  // A path saved by the app, for a launch with no environment at all.
  const configured = configuredPackagePath()
  if (configured !== undefined) candidates.push(configured)

  // This file lives at <app>/packages/core/src/, so the app root is three levels up.
  const here = dirname(fileURLToPath(import.meta.url))
  candidates.push(join(here, '..', '..', '..', 'node_modules', SIBLING_PACKAGE))
  candidates.push(join(here, '..', '..', '..', '..', 'node_modules', SIBLING_PACKAGE))

  // Reuse a DSH profile's copy when this machine has one, so a user who already
  // runs the plugin does not need a second install.
  //
  // The harness home is not always under %APPDATA%: this machine keeps it on
  // another drive entirely, so a hard-coded path guessed wrong. Discovery reads
  // the environment DSH exports, then a stored path, then the conventional homes.
  for (const dir of dshProfileDirs()) {
    candidates.push(join(dir, 'node_modules', SIBLING_PACKAGE))
    // A profile directory may also be named directly.
    candidates.push(join(dir, SIBLING_PACKAGE))
  }

  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  return undefined
}

/**
 * The path a user configured for the package, if any.
 *
 * An environment variable only helps a process launched from a shell that sets it;
 * a program started from a desktop shortcut has no such environment. So the path is
 * also read from a small JSON file in the app's own data directory, which survives
 * a shortcut launch and can be edited by hand.
 *
 * @returns a configured directory, or undefined.
 */
function configuredPackagePath() {
  try {
    const file = join(resolveDshHome(), '..', 'settings.json')
    if (!existsSync(file)) return undefined
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const value = parsed?.workbuddyPackage
    return typeof value === 'string' && value.length > 0 ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Candidate DSH profile directories, most specific first.
 *
 * A profile is the directory holding the harness's `node_modules`, where the
 * integration package would be installed. Several sources are consulted because
 * the harness home is not always in a conventional place — this machine keeps it
 * on another drive, so a guessed path found nothing.
 *
 * @returns directories to search.
 */
function dshProfileDirs() {
  const out = []
  const push = (value) => {
    if (typeof value === 'string' && value.length > 0 && !out.includes(value)) out.push(value)
  }

  // DSH exports its own locations to every child process; use them first.
  push(process.env.DSH_PROFILE_DIR)
  push(process.env.BUDDY_DSH_PROFILE)

  // A harness home plus a profile name reconstructs the same path.
  const harnessHome = process.env.DSH_HOME
  const profileName = process.env.DSH_PROFILE ?? 'desktop'
  if (typeof harnessHome === 'string' && harnessHome.length > 0) {
    push(join(harnessHome, 'profiles', profileName))
  }

  // Conventional locations, for a user who runs this app without DSH in the
  // environment but does have a profile on disk.
  const userHome = process.env.USERPROFILE || process.env.HOME
  if (typeof userHome === 'string' && userHome.length > 0) {
    push(join(userHome, '.dsh', 'profiles', profileName))
    push(join(userHome, '.dsh', 'profiles', 'desktop'))
    push(join(userHome, '.dsh'))
    push(join(userHome, 'AppData', 'Roaming', 'dsh', 'profiles', profileName))
    push(join(userHome, 'AppData', 'Roaming', 'dsh', 'profiles', 'desktop'))
  }

  // Finally, look for a harness data directory on each drive root. The harness is
  // sometimes installed on another drive under a custom folder, which no
  // environment variable reveals when the app is started from a shortcut.
  for (const found of scanForHarness()) push(found)
  return out
}

/** How deep to look for a harness directory below a drive root. */
const SCAN_DEPTH = 3

/**
 * Find a DSH harness directory by looking for the package on disk.
 *
 * Bounded on purpose: a handful of top-level names per drive, a few levels deep, and
 * only directories whose name mentions the harness. A full drive walk would take
 * minutes on a machine with a large disk.
 *
 * @returns profile directories that actually contain the package.
 */
function scanForHarness() {
  const out = []
  const drives = 'CDEFGH'.split('').map((letter) => `${letter}:\\`)
  for (const drive of drives) {
    if (!existsSync(drive)) continue
    let entries
    try {
      entries = readdirSync(drive)
    } catch {
      continue
    }
    for (const name of entries) {
      if (!/deepseek|harness|dsh/i.test(name)) continue
      const root = join(drive, name)
      for (const candidate of [
        join(root, 'harness', 'profiles'),
        join(root, 'profiles'),
        root
      ]) {
        if (!existsSync(candidate)) continue
        let profiles
        try {
          profiles = readdirSync(candidate)
        } catch {
          continue
        }
        for (const profile of profiles) {
          const dir = join(candidate, profile)
          if (existsSync(join(dir, 'node_modules', SIBLING_PACKAGE, 'package.json'))) {
            out.push(dir)
          }
        }
      }
    }
  }
  return out
}

/**
 * Find the bundle beside the package's manifest.
 *
 * The hash changes between releases, so the name is discovered rather than
 * assumed.
 *
 * @param packageDir - the package directory.
 * @returns the bundle path, or undefined.
 */
function locateBundle(packageDir) {
  const libDir = join(packageDir, 'lib')
  if (!existsSync(libDir)) return undefined
  let entries
  try {
    entries = readdirSync(libDir)
  } catch {
    return undefined
  }
  const match = entries
    .filter((name) => name.startsWith(INTERNAL_PREFIX) && name.endsWith('.js'))
    .sort()
  return match.length === 0 ? undefined : join(libDir, match[0])
}

/** Cache the loaded module: reading and rewriting 180 KB per call is wasteful. */
let loaded

/**
 * Load the credential reader module.
 *
 * @returns `{ ok: true, module }` or `{ ok: false, reason, error }`.
 */
export async function loadSibling() {
  if (loaded !== undefined) return loaded

  const packageDir = locatePackage()
  if (packageDir === undefined) {
    loaded = {
      ok: false,
      reason: 'not-installed',
      error: `找不到 ${SIBLING_PACKAGE}。请先安装它，它提供从桌面版读取凭据的能力。`
    }
    return loaded
  }
  const bundlePath = locateBundle(packageDir)
  if (bundlePath === undefined) {
    loaded = {
      ok: false,
      reason: 'no-bundle',
      error: `${SIBLING_PACKAGE} 里没有找到凭据读取模块（lib/${INTERNAL_PREFIX}*.js）。`
    }
    return loaded
  }

  let source
  try {
    source = readFileSync(bundlePath, 'utf8')
  } catch (error) {
    loaded = {
      ok: false,
      reason: 'unreadable',
      error: `读取凭据模块失败：${error instanceof Error ? error.message : String(error)}`
    }
    return loaded
  }

  // Rewrite the whole import statement, not the specifier inside it.
  //
  // Replacing only the quoted specifier leaves `from __SHIM__` — a bare
  // identifier where a module path must be — which is a syntax error. The
  // statement is matched exactly (including its trailing semicolon and the
  // optional `as` alias the bundle does not use but might).
  const importPattern = new RegExp(
    `import\\s*\\{[^}]*\\}\\s*from\\s*["']${DSH_HOME_SPECIFIER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']\\s*;?`
  )
  const matched = importPattern.test(source)
  const rewritten = source.replace(importPattern, '')

  // Any other DSH package would fail at link time with a confusing error, so it
  // is detected here and reported as what it is.
  if (/from\s*["']@deepseek-ai\//.test(rewritten)) {
    loaded = {
      ok: false,
      reason: 'needs-dsh',
      error: `${SIBLING_PACKAGE} 的凭据模块还依赖其他 DSH 包，独立版无法直接加载。`
    }
    return loaded
  }

  // The bundle no longer imports the shim, so it is injected as a module-scope
  // binding of the same name.
  if (matched !== true) {
    loaded = {
      ok: false,
      reason: 'unexpected-bundle',
      error: `${SIBLING_PACKAGE} 的凭据模块结构与预期不同（没有找到 dsh-home-paths 导入），请更新本应用。`
    }
    return loaded
  }

  const patched = `const { __shim } = globalThis.__buddyShim__;\nconst resolveDshHome = __shim.resolveDshHome;\n${rewritten}`

  globalThis.__buddyShim__ = { __shim: { resolveDshHome } }
  const url = `data:text/javascript;base64,${Buffer.from(patched, 'utf8').toString('base64')}`

  try {
    loaded = { ok: true, module: await import(url) }
  } catch (error) {
    loaded = {
      ok: false,
      reason: 'load-failed',
      error: `${SIBLING_PACKAGE} 加载失败：${error instanceof Error ? error.message : String(error)}`
    }
  }
  return loaded
}

/**
 * Whether the credential reader can be used, without loading it.
 *
 * @returns whether a package directory was found.
 */
export function siblingAvailable() {
  return locatePackage() !== undefined
}

/** Where the package was found, for diagnostics. */
export function siblingLocation() {
  const dir = locatePackage()
  if (dir === undefined) return undefined
  return { dir, bundle: locateBundle(dir) }
}

export { pathToFileURL }
