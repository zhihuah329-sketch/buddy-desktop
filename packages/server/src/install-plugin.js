/**
 * Install this app's provider plugin into DeepSeek Harness.
 *
 * ## Why a plugin has to be installed at all
 *
 * A harness registers model providers in-process, through `ctx.llm.registerAdapter`.
 * Nothing outside the harness process can call that, so an external program cannot
 * add a model by writing configuration alone. What it *can* do is place a small
 * plugin in the harness's own `node_modules` and point the profile at it.
 *
 * ## Why the plugin is generated here rather than shipped as a file
 *
 * The manifest has to match the harness that is actually installed — its package
 * version, the port this app listens on. A fixed file works on the machine it was
 * built on and fails wherever the harness differs, which is most machines. Writing it
 * at install time from what is present removes that whole class of failure.
 *
 * ## What gets written
 *
 * - `node_modules/dsh-command-buddy-connect-standalone/` with a generated manifest
 *   and adapter, and nothing else: a `dsh.bundle.patch` pointing at a file that is not
 *   there makes the harness skip the package without saying so.
 * - One entry in the profile's patch file, added once and left alone afterwards.
 *
 * @module @buddy-desktop/server/install-plugin
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { ADAPTER_SOURCE, buildManifest } from './plugin-source.js'

/** The package name this app owns. Distinct from the published plugin on purpose. */
const PACKAGE = 'dsh-command-buddy-connect-standalone'

/** The entry id used in the profile's patch file. */
const ENTRY_ID = 'llm-command-buddy-connect'

/** The marker line that proves the entry was added by this app. */
const MARKER = '# Added by Buddy Desktop'

/** The provider id, mirrored from the generated adapter. */
export const PLUGIN_PROVIDER_ID = 'command-buddy-connect'

/** What the model picker shows. */
export const PLUGIN_PROVIDER_NAME = 'Command Buddy Connect'

/** The profile directories that hold a harness, most authoritative first. */
function harnessProfileDirs() {
  const out = []
  const push = (value) => {
    if (typeof value === 'string' && value.length > 0 && !out.includes(value)) out.push(value)
  }

  push(process.env.DSH_PROFILE_DIR)
  const harnessHome = process.env.DSH_HOME
  const profileName = process.env.DSH_PROFILE ?? 'desktop'
  if (typeof harnessHome === 'string' && harnessHome.length > 0) {
    push(join(harnessHome, 'profiles', profileName))
  }

  const user = process.env.USERPROFILE ?? process.env.HOME ?? ''
  if (user.length > 0) {
    push(join(user, '.dsh', 'profiles', profileName))
    push(join(user, 'AppData', 'Roaming', 'dsh', 'profiles', profileName))
  }

  // The harness on another drive, found the way the rest of the app finds it.
  for (const drive of 'CDEFGH'.split('')) {
    const root = `${drive}:\\`
    if (!existsSync(root)) continue
    let entries
    try {
      entries = readdirSync(root)
    } catch {
      continue
    }
    for (const name of entries) {
      if (!/deepseek|harness|dsh/i.test(name)) continue
      for (const base of [join(root, name, 'harness', 'profiles'), join(root, name, 'profiles')]) {
        if (!existsSync(base)) continue
        let profiles
        try {
          profiles = readdirSync(base)
        } catch {
          continue
        }
        for (const profile of profiles) push(join(base, profile))
      }
    }
  }

  // A profile counts once it has the file the harness itself writes.
  return out.filter((dir) => existsSync(join(dir, 'cordis.yml')))
}

/**
 * The harness's own `@deepseek-ai/dsh-llm` version, when it can be read.
 *
 * This decides the peer range in the manifest. Reading it from the installed harness
 * is what lets the plugin work on a machine whose harness differs from the one this
 * app was built against.
 *
 * @param profile - the harness profile directory.
 * @returns the version, or undefined.
 */
function harnessLlmVersion(profile) {
  const candidates = [join(profile, 'node_modules', '@deepseek-ai', 'dsh-llm', 'package.json')]

  // The install is next to the profile often enough to be worth trying: the
  // application bundle carries its own copy of the packages it runs with.
  const harnessRoot = join(profile, '..', '..', '..')
  candidates.push(join(harnessRoot, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-llm', 'package.json'))

  for (const path of candidates) {
    try {
      if (!existsSync(path)) continue
      const parsed = JSON.parse(readFileSync(path, 'utf8'))
      if (typeof parsed.version === 'string' && parsed.version.length > 0) return parsed.version
    } catch {
      // A version that cannot be read falls through to no constraint.
    }
  }
  return undefined
}

/** The adapter with this app's port substituted in. */
function adapterText(port) {
  return ADAPTER_SOURCE.replace('__BASE__', `http://127.0.0.1:${port}/v1`)
}

/**
 * When the running harness started, if it is running.
 *
 * The harness reads its configuration once, at startup. A plugin written after the
 * process started is not loaded by it — which looks exactly like the plugin being
 * broken. Comparing the two times turns that into a one-line instruction instead.
 *
 * The time is asked for as a Unix timestamp rather than a formatted date: PowerShell
 * renders dates in the machine's own locale, and that text does not parse back.
 *
 * @returns the start time in milliseconds, or undefined when it is not running.
 */
function harnessStartedAt() {
  if (process.platform !== 'win32') return undefined
  try {
    // Read through PowerShell rather than a native module: this runs on a user's
    // machine, where nothing beyond the operating system can be assumed present.
    const output = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name like '%DeepSeek%'\" | Where-Object { $_.CommandLine -notlike '*--type=*' } | Sort-Object CreationDate | Select-Object -First 1 | ForEach-Object { [int64]($_.CreationDate.ToUniversalTime() - [datetime]'1970-01-01').TotalMilliseconds }"
      ],
      { encoding: 'utf8', timeout: 15000, windowsHide: true }
    )
    const parsed = Number.parseInt(output.trim(), 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Whether the installed copy is current for these settings.
 *
 * The stray-file check matters as much as the versions did: a leftover
 * `cordis.patch.yml` inside the package is what silently disabled the plugin before,
 * so a copy that has one is treated as stale and replaced.
 */
function isCurrent(target, port, llmVersion) {
  try {
    const manifest = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))
    const adapter = readFileSync(join(target, 'index.js'), 'utf8')
    const wanted = buildManifest({ llmVersion })
    return manifest.version === wanted.version
      && JSON.stringify(manifest.peerDependencies ?? {}) === JSON.stringify(wanted.peerDependencies ?? {})
      && adapter.includes(`127.0.0.1:${port}/v1`)
      && !existsSync(join(target, 'cordis.patch.yml'))
  } catch {
    return false
  }
}

/**
 * Report what installing would do.
 *
 * @param options - `port` this app listens on.
 * @returns the report.
 */
export function inspectPlugin(options = {}) {
  const port = Number.isFinite(options.port) ? options.port : 5178
  const profile = harnessProfileDirs()[0]
  if (profile === undefined) {
    return {
      available: false,
      reason: '找不到 DeepSeek Harness 的数据目录。请先安装并启动一次 DSH。',
      providerId: PLUGIN_PROVIDER_ID,
      providerName: PLUGIN_PROVIDER_NAME
    }
  }

  const target = join(profile, 'node_modules', PACKAGE)
  const installed = existsSync(join(target, 'index.js'))

  const patchPath = join(profile, 'cordis.patch.yml')
  const patch = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
  const registered = patch.includes(ENTRY_ID)

  const current = installed && registered && isCurrent(target, port, harnessLlmVersion(profile))

  // A plugin written after the harness started was never read by it. Reporting that
  // separately from "not installed" is what stops a user waiting for a model list to
  // refresh on its own.
  let needsRestart = false
  if (current) {
    const startedAt = harnessStartedAt()
    if (startedAt !== undefined) {
      const writtenAt = writeTime(target, patchPath)
      needsRestart = writtenAt !== undefined && writtenAt > startedAt
    }
  }

  return {
    available: true,
    profile,
    target,
    installed,
    registered,
    current,
    needsRestart,
    hint: needsRestart
      ? '插件已就位，但 DeepSeek Harness 是在它之前启动的。重启 DSH 后模型列表里才会出现 Command Buddy Connect。'
      : current
        ? undefined
        : '插件尚未就位。点「重新安装」后再重启 DeepSeek Harness。',
    providerId: PLUGIN_PROVIDER_ID,
    providerName: PLUGIN_PROVIDER_NAME
  }
}

/** The newest write time among the files that make the plugin. */
function writeTime(target, patchPath) {
  let newest
  for (const path of [join(target, 'index.js'), join(target, 'package.json'), patchPath]) {
    try {
      const at = statSync(path).mtimeMs
      if (newest === undefined || at > newest) newest = at
    } catch {
      // A file that is not there contributes nothing.
    }
  }
  return newest
}

/**
 * Install or refresh the plugin, and register it in the profile.
 *
 * @param options - `port` this app listens on.
 * @returns what happened.
 */
export function installPlugin(options = {}) {
  const port = Number.isFinite(options.port) ? options.port : 5178
  const before = inspectPlugin({ port })
  if (before.available !== true) {
    return { ok: false, error: before.reason ?? '无法安装插件。' }
  }

  const target = before.target
  const llmVersion = harnessLlmVersion(before.profile)

  // Removed whole rather than overwritten: a directory left with files that no longer
  // belong in it is exactly what broke this before.
  try {
    if (existsSync(target)) rmSync(target, { recursive: true, force: true })
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'index.js'), adapterText(port), 'utf8')
    writeFileSync(
      join(target, 'package.json'),
      JSON.stringify(buildManifest({ llmVersion }), null, 2),
      'utf8'
    )
  } catch (error) {
    return {
      ok: false,
      error: `无法写入 harness 的 node_modules：${error instanceof Error ? error.message : String(error)}`
    }
  }

  // Register the package in the profile once, keyed on the marker rather than on the
  // entry id, so a profile that mentions the id for some other reason still gets the
  // insert that makes the package load.
  const patchPath = join(before.profile, 'cordis.patch.yml')
  let patch = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
  if (!patch.includes(MARKER)) {
    if (existsSync(patchPath)) writeFileSync(`${patchPath}.bak-plugin-${Date.now()}`, patch, 'utf8')
    patch += `\n${MARKER}: registers the pools this app serves.\n- insert:\n    - id: ${ENTRY_ID}\n      name: ${PACKAGE}\n`
    writeFileSync(patchPath, patch, 'utf8')
  }

  const after = inspectPlugin({ port })
  return {
    ok: true,
    profile: before.profile,
    target,
    installed: after.installed,
    registered: after.registered,
    current: after.current,
    changed: before.current !== true,
    message: '已安装 Command Buddy Connect。重启 DeepSeek Harness 后模型列表里会出现它。'
  }
}
