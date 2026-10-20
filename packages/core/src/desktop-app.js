/**
 * Reading a credential straight from the installed WorkBuddy desktop app.
 *
 * ## Why this exists
 *
 * The CN build seals every credential field into a `$wbEncrypted` envelope whose
 * key is produced by its own native layer at runtime. Three ways were tried to
 * work around that, and this is the fourth and only clean one:
 *
 * 1. **Read the credential file.** Impossible — the token is sealed, and the key
 *    never touches disk.
 * 2. **Re-import through the daemon.** The daemon refuses a credential whose
 *    `expiresAt` is not later than the stored one, so a re-capture could never
 *    replace a stored token. Deadlock.
 * 3. **Intercept the client's traffic.** Needs a local CA, a system-proxy change
 *    and a full client restart; it silently captures nothing when the client
 *    does not honour the system proxy, which is the common case.
 * 4. **Ask the app itself.** The desktop app can produce the at-rest key for its
 *    own codec. `dsh-workbuddy-connect` already implements exactly that: it
 *    locates the installed Electron binary, obtains the key, and decrypts the
 *    credential. This module reuses that implementation.
 *
 * ## Why the internal module and not the package entry
 *
 * The package entry imports `@deepseek-ai/dsh-llm` symbols that only exist from
 * 0.2, so on an older harness `import('dsh-workbuddy-connect')` throws before
 * anything can be used. The internal bundle it re-exports from depends only on
 * `@deepseek-ai/dsh-home-paths` and node builtins, and it is that bundle which
 * carries the key provider and the credential store.
 *
 * The bundle is minified, so its exports are single letters. Rather than pin
 * those letters — they change between releases — the needed pieces are located
 * by shape: the region variant is the object whose `region` matches, and the
 * store is the constructor whose instances expose `resolve`.
 *
 * @module dsh-command-buddy-connect/desktop-app
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { identityFromToken } from './proxy.js'
import { loadSibling as loadSiblingModule, siblingAvailable as siblingInstalled } from './sibling.js'

/**
 * Load the credential reader that ships with `dsh-workbuddy-connect`.
 *
 * The package is located and its DSH-only import rewritten by `sibling.js`, so
 * this module no longer depends on being inside a DSH profile.
 *
 * @returns the module namespace, or a reason it is unavailable.
 */
function loadSibling() {
  return loadSiblingModule()
}

/**
 * Pick the region variant out of a minified module namespace.
 *
 * @param module - the sibling module namespace.
 * @param site - 'cn' or 'ai'.
 * @returns the variant object, or undefined.
 */
function findVariant(module, site) {
  const wanted = site === 'ai' ? 'global' : 'cn'
  for (const value of Object.values(module)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
    if (typeof value.region !== 'string' || typeof value.id !== 'string') continue
    if (value.region === wanted) return value
  }
  // Older builds spell the international region 'ai'.
  if (site === 'ai') {
    for (const value of Object.values(module)) {
      if (value !== null && typeof value === 'object' && value.region === 'ai') return value
    }
  }
  return undefined
}

/**
 * Pick the credential store constructor out of a minified module namespace.
 *
 * @param module - the sibling module namespace.
 * @returns the constructor, or undefined.
 */
function findStore(module) {
  for (const value of Object.values(module)) {
    if (typeof value !== 'function') continue
    const prototype = value.prototype
    if (prototype !== undefined && typeof prototype.resolve === 'function') return value
  }
  return undefined
}

/**
 * Candidate paths for the WorkBuddy desktop binary.
 *
 * The app is not always in the vendor's default location — on this machine it is
 * on a different drive — and the sibling implementation refuses to search when
 * `WORKBUDDY_ELECTRON_BIN` names a missing file, so every plausible source is
 * consulted before giving up: the explicit setting, the vendor default, and the
 * daemon's own `config.json`, which records the path the user picked when they
 * installed it.
 *
 * @param configured - the plugin's `workbuddyPath` setting, when set.
 * @returns candidate paths, most authoritative first.
 */
function electronCandidates(configured) {
  const out = []
  if (typeof configured === 'string' && configured.trim().length > 0) out.push(configured.trim())
  const existing = process.env.WORKBUDDY_ELECTRON_BIN
  if (typeof existing === 'string' && existing.trim().length > 0) out.push(existing.trim())
  const local = process.env.LOCALAPPDATA
  if (typeof local === 'string' && local.length > 0) {
    out.push(`${local}\\Programs\\WorkBuddy\\WorkBuddy.exe`)
  }
  // The daemon's config records `workbuddyExe` / `workbuddyIntlExe` for the same
  // binary. Reading it is not a dependency on the daemon: it is a pointer that
  // may already hold the answer, and it is only consulted when it exists.
  const home = process.env.USERPROFILE ?? ''
  if (home.length > 0) {
    for (const name of ['workbuddyExe', 'workbuddyIntlExe']) {
      const value = readDaemonConfigValue(home, name)
      if (value !== undefined) out.push(value)
    }
  }
  return [...new Set(out)]
}

/**
 * Read one string field from the daemon's config, if it points at a real file.
 *
 * The file is JSON written by another product, so it is read defensively: a
 * malformed or absent file simply yields nothing.
 *
 * @param home - the user profile directory.
 * @param field - the field name to read.
 * @returns the path when it exists, or undefined.
 */
function readDaemonConfigValue(home, field) {
  const path = join(home, '.buddyhub', 'config.json')
  if (!existsSync(path)) return undefined
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    const value = raw?.[field]
    if (typeof value !== 'string' || value.trim().length === 0) return undefined
    return existsSync(value.trim()) ? value.trim() : undefined
  } catch {
    return undefined
  }
}

/**
 * Make sure the sibling implementation can find the Electron binary.
 *
 * It reads `WORKBUDDY_ELECTRON_BIN` and fails hard when that names a missing
 * file, so a candidate is applied only when it exists. A stale variable pointing
 * at nothing is removed, because the sibling treats it as an operator decision
 * and then refuses to search at all.
 *
 * @param configured - the plugin's `workbuddyPath` setting, when set.
 * @returns the path now in effect, or undefined.
 */
export function applyElectronPath(configured) {
  for (const candidate of electronCandidates(configured)) {
    if (!existsSync(candidate)) continue
    process.env.WORKBUDDY_ELECTRON_BIN = candidate
    return candidate
  }
  const existing = process.env.WORKBUDDY_ELECTRON_BIN
  if (typeof existing === 'string' && existing.length > 0 && !existsSync(existing)) {
    delete process.env.WORKBUDDY_ELECTRON_BIN
  }
  return undefined
}

/**
 * Read one region's credential from the desktop app.
 *
 * The app must be installed and signed in to that region. Nothing is written:
 * the caller decides where the credential goes.
 *
 * @param options - `site` ('cn' or 'ai'), `workbuddyPath`, and `signal`.
 * @returns the credential, or a reason it could not be read.
 */
export async function readDesktopCredential(options = {}) {
  const site = options.site === 'ai' ? 'ai' : 'cn'
  if (options.signal?.aborted === true) {
    return { ok: false, reason: 'aborted', error: '已取消。' }
  }

  const electron = applyElectronPath(options.workbuddyPath)
  const loaded = await loadSibling()
  if (loaded.ok !== true) return loaded

  const variant = findVariant(loaded.module, site)
  const Store = findStore(loaded.module)
  if (variant === undefined || Store === undefined) {
    return {
      ok: false,
      reason: 'incompatible',
      error: 'dsh-workbuddy-connect 的版本不提供凭据读取接口，请更新或重装该包。'
    }
  }

  let credential
  try {
    credential = await new Store({ variant }).resolve()
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    // The reader is a library with its own English diagnostics. What the user needs is
    // the situation and the next step, so the original text goes to the log instead of
    // onto the page. The two regions are separate products, so the message names the
    // one that was asked for rather than saying "WorkBuddy".
    console.warn(`desktop-app: 读取 ${site} 登录状态失败 — ${detail}`)
    const product = site === 'ai' ? 'WorkBuddyAI 国际版' : 'WorkBuddy 国内版'
    const hint = electron === undefined
      ? `没有找到${product}。请先安装并登录它，或到「设置」页手动指定它的 exe 路径。`
      : `已找到${product}，但读不到登录状态。请打开它确认已登录。`
    return {
      ok: false,
      reason: 'unreadable',
      error: hint
    }
  }

  if (credential === undefined || credential === null) {
    return {
      ok: false,
      reason: 'no-credential',
      error: `${site === 'ai' ? '国际版' : '国内版'}桌面版没有已登录的账号。请先在客户端登录。`
    }
  }

  const token = typeof credential.accessToken === 'string' ? credential.accessToken : ''
  if (token.length === 0) {
    return {
      ok: false,
      reason: 'no-token',
      error: `${site === 'ai' ? '国际版' : '国内版'}桌面版没有可用的登录凭据。请先在客户端登录。`
    }
  }

  // The desktop app exposes no display name, only a token. The name is in the
  // token's OpenID claims, so it is read here rather than left blank — a blank
  // label made the panel show the account id's first six characters.
  const identity = identityFromToken(token)
  const reportedUid = typeof credential.uid === 'string' ? credential.uid : ''

  return {
    ok: true,
    site,
    credential: {
      accessToken: token,
      refreshToken: typeof credential.refreshToken === 'string' ? credential.refreshToken : '',
      domain: typeof credential.domain === 'string' && credential.domain.length > 0
        ? credential.domain
        : credential.region ?? (site === 'ai' ? 'www.workbuddy.ai' : 'www.workbuddy.cn'),
      uid: reportedUid.length > 0 ? reportedUid : identity.uid,
      ...(identity.label.length > 0 ? { label: identity.label } : {}),
      // The sibling reports milliseconds; the vault stores milliseconds too.
      expiresAt: numberOf(credential.expiresAtMs ?? credential.expiresAt),
      refreshExpiresAt: numberOf(credential.refreshExpiresAtMs ?? credential.refreshExpiresAt),
      source: 'desktop-app'
    }
  }
}

/**
 * Read one numeric field without trusting the shape.
 *
 * @param value - a candidate number.
 * @returns a finite positive number, or 0.
 */
function numberOf(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * Whether the sibling plugin appears to be installed, without importing it.
 *
 * @param importer - a module URL used as the resolution base.
 * @returns whether the package can be resolved.
 */
export function siblingAvailable() {
  return siblingInstalled()
}
