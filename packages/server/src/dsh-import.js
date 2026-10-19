/**
 * Register this app's models inside DeepSeek Harness.
 *
 * ## What "import" means here
 *
 * DSH does not read a model from a file: its plugins register adapters in-process
 * through `ctx.llm.registerAdapter`. A separate program cannot reach into that, so
 * the only durable thing this app can do is make the harness's *configuration*
 * correct — the provider entry, its path, and the default model — and let the
 * harness pick it up when it next starts.
 *
 * ## What is written
 *
 * `cordis.patch.yml` in the active profile, which is the file a user is expected to
 * edit and which survives an upgrade of DSH itself. Only the three keys that matter
 * are touched; the rest of the file is left byte-for-byte alone, because it holds
 * comments and other users' settings.
 *
 * Every write is preceded by a backup and is idempotent: running the import twice
 * changes nothing the second time.
 *
 * @module @buddy-desktop/server/dsh-import
 */

import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The provider id the plugin registers. */
const PROVIDER = 'buddy-connect'

/** The model a fresh session should use. */
const MODEL = 'deepseek-v4.1-flash-cn'

/** The plugin id whose config holds the path. */
const PLUGIN_ID = 'llm-dsh-command-buddy-connect'

/**
 * Profile directories taken from a running harness process.
 *
 * The harness is launched as `… dsh-desktop-host … <profileDir> …`, so the profile
 * it is using appears verbatim in its command line. That is the only trustworthy
 * answer when a machine holds more than one profile, which is common: a leftover
 * under the home directory plus the real one wherever the user installed DSH.
 *
 * Windows is queried through `wmic`-less CIM via PowerShell, because Node has no
 * portable way to read another process's command line. A failure is not an error —
 * the caller falls back to the filesystem search.
 *
 * @returns profile directories, most authoritative first.
 */
function runningProfileDirs() {
  if (process.platform !== 'win32') return []
  let output
  try {
    output = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process -Filter "Name like \'%DeepSeek%\' or Name like \'%dsh%\' or Name=\'electron.exe\'" | Select-Object -ExpandProperty CommandLine'
      ],
      { encoding: 'utf8', timeout: 4000, windowsHide: true }
    )
  } catch {
    return []
  }

  const found = []
  // The profile path is the argument ending in a directory whose name looks like a
  // profile and which contains a cordis.yml. Matching on that shape avoids picking
  // up the application directory, which appears earlier in the same command line.
  for (const line of output.split(/\r?\n/)) {
    for (const token of line.split(/\s+/)) {
      const cleaned = token.replace(/^["']|["']$/g, '')
      if (!cleaned.includes('profiles')) continue
      if (!existsSync(join(cleaned, 'cordis.yml'))) continue
      if (!found.includes(cleaned)) found.push(cleaned)
    }
  }
  return found
}

/**
 * Candidate DSH profile directories.
 *
 * The same set the credential reader searches, for the same reason: the harness is
 * not always under the home directory, and a program launched from a shortcut
 * inherits no environment that would say where it is.
 *
 * @returns the directories that look like a profile.
 */
function profileDirs() {
  const out = []
  const push = (value) => {
    if (typeof value === 'string' && value.length > 0 && !out.includes(value)) out.push(value)
  }

  // The running harness is the authority. A machine can hold several profiles — a
  // leftover under the home directory and the one actually in use on another drive
  // — and writing the wrong one produces a configuration that never takes effect.
  // The profile path appears in the process command line, so it is read from there
  // before anything is guessed.
  for (const running of runningProfileDirs()) push(running)

  push(process.env.DSH_PROFILE_DIR)
  const harnessHome = process.env.DSH_HOME
  const profileName = process.env.DSH_PROFILE ?? 'desktop'
  if (typeof harnessHome === 'string' && harnessHome.length > 0) {
    push(join(harnessHome, 'profiles', profileName))
  }

  const user = process.env.USERPROFILE ?? homedir()
  push(join(user, '.dsh', 'profiles', profileName))
  push(join(user, 'AppData', 'Roaming', 'dsh', 'profiles', profileName))

  // A harness on another drive, found the same way the credential reader finds it.
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

  return out.filter((dir) => existsSync(join(dir, 'cordis.yml')))
}

/** The patch file of the first usable profile, or undefined. */
function patchFile() {
  for (const dir of profileDirs()) {
    const file = join(dir, 'cordis.patch.yml')
    if (existsSync(file)) return file
  }
  return undefined
}

/**
 * Where to create a patch file when none exists.
 *
 * A profile that has `cordis.yml` but no patch file is the normal state before
 * anything has been customised. Writing the patch there is correct and is what the
 * harness itself expects, so a user who has never touched their configuration can
 * still get the models.
 *
 * @returns the path to create, or undefined when no profile exists at all.
 */
function patchFileToCreate() {
  for (const dir of profileDirs()) return join(dir, 'cordis.patch.yml')
  return undefined
}

/** The minimal patch that registers the plugin and makes it the default. */
function freshPatch(clientPath) {
  const pathLine = clientPath.length > 0 ? `    workbuddyPath: '${clientPath}'\n` : ''
  return `# Written by Buddy Desktop.
#
# Registers the account pools this app serves so DeepSeek Harness offers the models
# in a new session. The \`${PROVIDER}\` provider is served in-process by the plugin,
# which reads credentials from the desktop client; nothing here reaches the network
# beyond what the client already does.
- id: agent-default-model
  config:
    provider: ${PROVIDER}
    model: ${MODEL}
- id: ${PLUGIN_ID}
  config:
${pathLine}    enableProvider: true
`
}

/**
 * Whether an import would change anything.
 *
 * @returns `{ available, file, changes, fresh }`.
 */
export function inspectImport() {
  const file = patchFile()
  if (file === undefined) {
    // No patch file yet: offered as a creation rather than refused, because that is
    // the state every user starts in.
    const target = patchFileToCreate()
    if (target === undefined) {
      return {
        available: false,
        file: null,
        changes: [],
        reason: '找不到 DeepSeek Harness 的数据目录。请先安装并启动一次 DSH。'
      }
    }
    return {
      available: true,
      file: target,
      fresh: true,
      changes: [
        { key: '配置文件', from: '(不存在)', to: '将创建' },
        { key: 'provider', from: '(未设置)', to: PROVIDER },
        { key: 'enableProvider', from: '(未设置)', to: 'true' }
      ]
    }
  }

  const text = readFileSync(file, 'utf8')
  const changes = []

  if (!text.includes(`provider: ${PROVIDER}`)) {
    const current = /provider:\s*(\S+)/.exec(text)
    changes.push({
      key: 'provider',
      from: current?.[1] ?? '(未设置)',
      to: PROVIDER
    })
  }
  if (!/enableProvider:\s*true/.test(text)) {
    changes.push({ key: 'enableProvider', from: 'false', to: 'true' })
  }
  if (!text.includes(PLUGIN_ID)) {
    changes.push({ key: 'plugin', from: '(缺失)', to: PLUGIN_ID })
  }

  return { available: true, file, changes }
}

/**
 * Keep the configuration correct while the harness runs.
 *
 * ## Why a watcher and not a one-off write
 *
 * The harness rewrites its own patch file whenever the user changes a setting in its
 * interface — including choosing a model. If the interface still shows the removed
 * daemon provider, that write puts `buddyhub` back and the configuration silently
 * reverts, which is exactly what a user sees as "I wrote it but nothing changed".
 *
 * The watcher repairs only that one stale value, so a user who deliberately picks a
 * different provider is left alone.
 *
 * @param options - `workbuddyPath` and `detectedClientPath`, as for the import.
 * @param settings - `intervalMs`, default 10 seconds.
 * @returns a function that stops the watcher.
 */
export function watchImport(options = {}, settings = {}) {
  const intervalMs = Number.isFinite(settings.intervalMs) && settings.intervalMs >= 2000
    ? settings.intervalMs
    : 10000

  /** The last repair, so the same file is not rewritten every tick. */
  let lastRepair = 0

  const tick = () => {
    try {
      const report = inspectImport()
      if (report.available !== true) return
      const stale = report.changes.some(
        (change) => change.key === 'provider' && change.from === 'buddyhub'
      )
      if (!stale) return
      // Two repairs inside a minute means something is fighting back; backing off
      // avoids a write loop against the harness.
      if (Date.now() - lastRepair < 60000) return
      lastRepair = Date.now()
      applyImport(options)
    } catch {
      // A watcher must never be the reason the app fails.
    }
  }

  const timer = setInterval(tick, intervalMs)
  // The timer must not keep the process alive on its own.
  if (typeof timer.unref === 'function') timer.unref()
  return () => clearInterval(timer)
}

/**
 * Apply the import.
 *
 * @param options - `workbuddyPath` to record for the client.
 * @returns what was changed, and where.
 */
export function applyImport(options = {}) {
  // The path to record must be the one on this machine, so it is taken from
  // detection rather than assumed.
  const clientPath = typeof options.workbuddyPath === 'string' && options.workbuddyPath.length > 0
    ? options.workbuddyPath
    : (typeof options.detectedClientPath === 'string' ? options.detectedClientPath : '')

  const file = patchFile() ?? patchFileToCreate()
  if (file === undefined) {
    return { ok: false, error: '找不到 DeepSeek Harness 的数据目录，请先安装并启动一次 DSH。' }
  }

  // A missing patch file is the normal state before any customisation, so it is
  // created whole rather than treated as an error.
  if (!existsSync(file)) {
    writeFileSync(file, freshPatch(clientPath), 'utf8')
    const verify = inspectImport()
    if (verify.changes.length > 0) {
      return { ok: false, error: '创建后校验未通过。', file, remaining: verify.changes }
    }
    return {
      ok: true,
      changed: true,
      file,
      created: true,
      message: '已创建 DSH 配置。重启 DeepSeek Harness 后，新会话即可选择这两个模型。'
    }
  }

  const before = readFileSync(file, 'utf8')
  let after = before

  // 1. The default model's provider. Done with a targeted pattern so the comment
  //    above it and every other entry stay as they are.
  if (!after.includes(`provider: ${PROVIDER}`)) {
    after = after.replace(
      /(- id: agent-default-model[\s\S]{0,200}?provider:\s*)(\S+)/,
      `$1${PROVIDER}`
    )
  }

  // 2. The plugin's own config: switched on. The client path was resolved at the top
  //    of this function, so it is not recomputed here.
  if (/enableProvider:\s*false/.test(after)) {
    after = after.replace(/enableProvider:\s*false/g, 'enableProvider: true')
  }

  // 3. If the plugin entry is missing entirely, append one. This is the only case
  //    where text is added rather than replaced.
  if (!after.includes(PLUGIN_ID)) {
    // The path line is omitted when no client was found, rather than written empty:
    // an empty string would be a value the harness has to interpret, while a missing
    // key lets it fall back to its own detection.
    const pathLine = clientPath.length > 0 ? `    workbuddyPath: '${clientPath}'\n` : ''
    after += `\n- id: ${PLUGIN_ID}\n  config:\n${pathLine}    enableProvider: true\n`
  }

  if (after === before) {
    return { ok: true, changed: false, file, changes: [], message: 'DSH 配置已经是正确的，无需改动。' }
  }

  // A backup before writing: this is another program's configuration, and a
  // mangled YAML would stop the harness from starting.
  const backup = `${file}.bak-${Date.now()}`
  copyFileSync(file, backup)
  writeFileSync(file, after, 'utf8')

  const verify = inspectImport()
  if (verify.changes.length > 0) {
    // Put it back rather than leave a configuration that does not do what was
    // promised.
    copyFileSync(backup, file)
    return {
      ok: false,
      error: '写入后校验未通过，已还原原文件。',
      file,
      remaining: verify.changes
    }
  }

  return {
    ok: true,
    changed: true,
    file,
    backup,
    message: 'DSH 配置已更新。重启 DeepSeek Harness 后，新会话即可选择这两个模型。'
  }
}
