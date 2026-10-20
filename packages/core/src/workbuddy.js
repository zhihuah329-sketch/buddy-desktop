/**
 * WorkBuddy account access: reach the credential that backs the daily check-in,
 * then call the billing endpoints.
 *
 * ## Credential sources, in order
 *
 * 1. **The daemon account vault.** A CN account imported into the daemon already
 *    carries a plaintext `accessToken`, `uid`, and `domain`, which is exactly
 *    what the billing endpoints need. This is the preferred source: it needs no
 *    other plugin, no Electron binary, and no decryption.
 * 2. **The `dsh-workbuddy-connect` plugin**, when it happens to be installed.
 *    It can open WorkBuddy's sealed credential file, which helps only on a
 *    machine where the daemon has no CN account yet.
 *
 * ## Why sealed credentials are not read here
 *
 * WorkBuddy's international build stores a plaintext `accessToken` string. The
 * CN build instead seals every credential field into a
 * `{$wbEncrypted:1, envelope}` wrapper — AES-256-GCM whose key is returned by
 * WorkBuddy's own native layer at runtime. Reproducing that key derivation in a
 * plugin would mean duplicating security-sensitive code that is designed not to
 * be reproduced, and it would silently break on any vendor change. So a sealed
 * file is reported as such (see `lib/vault.js` `diagnoseCredential`) and the
 * user is pointed at the path that does work: import the account into the dae进程.
 *
 * @module buddy-connect/workbuddy
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readVault } from './vault.js'

/** Plugin that can open a sealed WorkBuddy credential file. */
const CREDENTIAL_PLUGIN = 'dsh-workbuddy-connect'

/** WorkBuddy CN billing host, as used by the daemon's own client. */
export const BILLING_BASE = 'https://copilot.tencent.com'

/** Fallback host when the primary is unreachable. */
export const BILLING_BASE_FALLBACK = 'https://www.workbuddy.cn'

/**
 * `User-Agent` the upstream expects. The daemon sends the same value, and
 * the billing API rejects requests that do not look like the desktop client.
 */
const CLIENT_UA = 'CLI/2.63.2 CodeBuddy/2.63.2'

/** Where the WorkBuddy desktop binary may live, most specific first. */
function electronCandidates() {
  const local = process.env.LOCALAPPDATA
  const list = []
  if (typeof local === 'string' && local.length > 0) {
    list.push(join(local, 'Programs', 'WorkBuddy', 'WorkBuddy.exe'))
  }
  // Installations moved off the default location still work when the user
  // points us at them, but are not guessed: only the vendor's own default is.
  return list
}

/**
 * Make sure the credential reader can find the WorkBuddy desktop binary.
 *
 * Only used by the fallback source. Never overrides an existing value: an
 * operator who set the variable has chosen a specific binary, and silently
 * replacing it would be worse than failing.
 *
 * @returns the Electron binary path now in effect, when one exists.
 */
export function ensureElectronPath() {
  const existing = process.env.WORKBUDDY_ELECTRON_BIN
  if (typeof existing === 'string' && existing.length > 0) return existing
  for (const candidate of electronCandidates()) {
    if (existsSync(candidate)) {
      process.env.WORKBUDDY_ELECTRON_BIN = candidate
      return candidate
    }
  }
  return undefined
}

/**
 * Pick the CN account that should perform the check-in.
 *
 * Selection order matters when the vault holds several CN accounts:
 *
 * 1. **Never an expired account.** The billing call would fail with a plain
 *    "rejected" message and say nothing about the real cause.
 * 2. **Prefer one that is not cooling down.** A cooldown means the upstream
 *    just refused it, so another account is strictly better.
 * 3. **Then the first enabled account**, preserving vault order as a stable
 *    tiebreak so repeated runs pick the same account.
 *
 * A cooling account is still returned when it is the only one: the billing
 * call decides, and refusing to try would misreport a transient cooldown as
 * "no account at all".
 *
 * @param vault - a successful vault read.
 * @param now - the instant to judge against.
 * @returns the chosen account, or undefined when none can be used.
 */
function chooseCheckinAccount(vault, now) {
  const cn = vault.accounts.filter((a) => a.site === 'cn'
    && a.enabled !== false
    && typeof a.accessToken === 'string'
    && a.accessToken.length > 0
    && !(typeof a.expiresAt === 'number' && a.expiresAt > 0 && a.expiresAt <= now))
  if (cn.length === 0) return undefined
  const ready = cn.filter((a) => !(typeof a.cooldownUntil === 'number' && a.cooldownUntil > now))
  return ready.length > 0 ? ready[0] : cn[0]
}

/**
 * Take the best CN account from the daemon vault.
 *
 * @param dataDir - the daemon data directory, when configured.
 * @returns a credential, or undefined when the vault has no usable CN account.
 */
function credentialFromVault(dataDir) {
  const vault = readVault(dataDir)
  if (!vault.ok) return undefined
  const account = chooseCheckinAccount(vault, Date.now())
  if (account === undefined) return undefined
  return {
    accessToken: account.accessToken,
    uid: account.uid,
    domain: account.domain ?? 'copilot.tencent.com',
    ...(account.enterpriseId ? { enterpriseId: account.enterpriseId } : {}),
    source: 'daemon-vault'
  }
}

/**
 * Load the credential reader from the sibling plugin, when installed.
 *
 * @returns the module's public surface, or a reason it is unavailable.
 */
async function loadCredentialPlugin() {
  try {
    return { ok: true, module: await import(CREDENTIAL_PLUGIN) }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

/**
 * Resolve the live WorkBuddy credential for check-in.
 *
 * @param dataDir - the app's data directory.
 * @returns the credential, or a failure explaining why none is available.
 */
export async function resolveCredential(dataDir) {
  const fromVault = credentialFromVault(dataDir)
  if (fromVault !== undefined) return { ok: true, credential: fromVault, store: undefined }

  const loaded = await loadCredentialPlugin()
  if (!loaded.ok) {
    // What the user can act on: no account is stored yet, and how to add one. The
    // module name and the underlying error are of no use to them.
    return {
      ok: false,
      error: '还没有可签到的国内版账号。先到「国内版」页点「从桌面版读取」导入一个账号。'
    }
  }

  const { WorkBuddyCredentialStore, CN_VARIANT } = loaded.module
  if (typeof WorkBuddyCredentialStore !== 'function' || CN_VARIANT === undefined) {
    return { ok: false, error: '内置的凭据读取组件版本不匹配，请重新安装本软件。' }
  }

  const electron = ensureElectronPath()
  const store = new WorkBuddyCredentialStore({ variant: CN_VARIANT })

  try {
    const credential = await store.resolve()
    if (credential === undefined || typeof credential.accessToken !== 'string' || credential.accessToken.length === 0) {
      return {
        ok: false,
        error: '没读到可用的登录状态。请确认 WorkBuddy 国内版已打开并处于登录中，再点「从桌面版读取」。'
      }
    }
    return { ok: true, credential, store }
  } catch (error) {
    // The reader is a library with its own English diagnostics. What the user needs is
    // the situation and the next step, so the original text goes to the log rather
    // than onto the page.
    console.warn(`workbuddy: 读取登录状态失败 — ${message(error)}`)
    const hint = electron === undefined
      ? '没有找到 WorkBuddy 国内版客户端。请先安装并登录它，或到「设置」页手动指定 exe 路径。'
      : '请确认 WorkBuddy 国内版已打开并处于登录中。'
    return { ok: false, error: `读不到 WorkBuddy 的登录状态。${hint}` }
  }
}

/**
 * Decode a JWT payload without verifying it.
 *
 * Used only to read display metadata (nickname) and the expiry, never to make
 * a trust decision: the server remains the authority on whether the token is
 * valid, and a malformed token simply fails the request.
 *
 * @param token - the compact JWS string.
 * @returns the decoded payload, or undefined when it cannot be read.
 */
export function decodeJwtPayload(token) {
  try {
    const part = token.split('.')[1]
    if (typeof part !== 'string' || part.length === 0) return undefined
    const decoded = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
    return decoded !== null && typeof decoded === 'object' ? decoded : undefined
  } catch {
    return undefined
  }
}

/**
 * Build a display label for the signed-in account.
 *
 * WorkBuddy encrypts the phone number and nickname in its auth document, so the
 * label comes from the token instead. The token's `nickname` is not reliable —
 * on the account this was developed against it is literally `"en"` — so a
 * phone-number claim is preferred and masked to its last four digits, which is
 * both identifying and safe to display.
 *
 * @param credential - the resolved credential.
 * @returns a human-readable label, never empty.
 */
export function accountLabel(credential) {
  const payload = decodeJwtPayload(credential.accessToken)

  const phone = payload?.preferred_username
  if (typeof phone === 'string' && /^\d{6,}$/.test(phone.trim())) {
    return `手机 ****${phone.trim().slice(-4)}`
  }

  const nickname = payload?.nickname
  // A one- or two-character nickname carries no information a user can
  // recognise, so it is skipped in favour of a stable identifier.
  if (typeof nickname === 'string' && nickname.trim().length > 2) return nickname.trim()

  const uid = typeof credential.uid === 'string' ? credential.uid : ''
  return uid.length >= 8 ? `uid ${uid.slice(0, 8)}` : 'WorkBuddy account'
}

/**
 * Build the request headers the billing API expects.
 *
 * Every header here is required by the upstream: it rejects requests that do
 * not carry the desktop client's product, domain, and origin markers.
 *
 * @param credential - the resolved credential.
 * @param base - the host the request targets.
 * @returns the header set.
 */
function headers(credential, base) {
  const set = {
    authorization: `Bearer ${credential.accessToken}`,
    'x-user-id': String(credential.uid ?? ''),
    'x-product': 'WorkBuddy',
    'x-requested-with': 'XMLHttpRequest',
    'x-domain': String(credential.domain ?? ''),
    'user-agent': CLIENT_UA,
    origin: base,
    referer: `${base}/`,
    'content-type': 'application/json'
  }
  const enterprise = decodeJwtPayload(credential.accessToken)?.enterprise_id
  if (typeof enterprise === 'string' && enterprise.length > 0) set['x-enterprise-id'] = enterprise
  return set
}

/**
 * POST one billing endpoint.
 *
 * The upstream answers application-level failures with HTTP 200 and a non-zero
 * `code`, so both layers are checked. A 401/403 is reported separately because
 * it means the login needs renewing rather than the request being wrong.
 *
 * @param options - credential, endpoint, and whether the path takes a `/v2` prefix.
 * @returns the decoded payload, or a failure.
 */
async function billingPost(options) {
  const { credential, endpoint, v2 = true, signal } = options
  const prefix = v2 ? '/v2' : ''
  const bases = [BILLING_BASE, BILLING_BASE_FALLBACK]
  let lastError = 'the billing request did not complete'

  for (const base of bases) {
    let response
    try {
      response = await fetch(`${base}${prefix}/billing/meter/${endpoint}`, {
        method: 'POST',
        headers: headers(credential, base),
        body: '{}',
        ...(signal === undefined ? {} : { signal })
      })
    } catch (error) {
      lastError = `cannot reach WorkBuddy (${message(error)})`
      continue
    }

    const text = await response.text()
    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      lastError = `WorkBuddy returned a non-JSON reply (HTTP ${response.status})`
      continue
    }

    if (response.status === 401 || response.status === 403) {
      return { ok: false, unauthorized: true, error: 'WorkBuddy 登录已失效。请打开 WorkBuddy 客户端重新登录，然后点「从桌面版读取」。' }
    }
    if (!response.ok) {
      lastError = `WorkBuddy returned HTTP ${response.status}`
      continue
    }
    return { ok: true, payload }
  }
  return { ok: false, error: lastError }
}

/**
 * Read the check-in activity state.
 *
 * @param credential - the resolved credential.
 * @param signal - cancellation.
 * @returns the activity state, or a failure.
 */
export async function checkinStatus(credential, signal) {
  const result = await billingPost({ credential, endpoint: 'checkin-activity-status', signal })
  if (!result.ok) return result
  const payload = result.payload
  if (Number(payload?.code) !== 0 || payload?.data === null || typeof payload?.data !== 'object') {
    // The code is kept in the text because it is the only thing that distinguishes one
    // refusal from another, and it is what a user would quote when asking for help.
    return { ok: false, error: `WorkBuddy 拒绝了签到状态查询（错误码 ${payload?.code ?? 'unknown'}）。` }
  }
  const data = payload.data
  return {
    ok: true,
    active: data.active === true,
    checkedIn: data.today_checked_in === true,
    totalCredits: number(data.total_credits),
    todayCredit: number(data.today_credit),
    dailyCredit: number(data.daily_credit),
    streakDays: number(data.streak_days),
    activityName: typeof data.activity_name === 'string' ? data.activity_name : undefined
  }
}

/**
 * Claim today's check-in reward.
 *
 * The upstream treats `1001` and `10001` as "already claimed" rather than failures,
 * so they are reported as a successful no-op — retrying them would never help.
 *
 * @param credential - the resolved credential.
 * @param signal - cancellation.
 * @returns whether this call claimed the reward, or a failure.
 */
export async function claimCheckin(credential, signal) {
  const result = await billingPost({ credential, endpoint: 'daily-checkin', signal })
  if (!result.ok) return result
  const code = Number(result.payload?.code)
  if (code === 0) return { ok: true, claimed: true }
  if (code === 1001 || code === 10001) return { ok: true, claimed: false }
  return { ok: false, error: `WorkBuddy 拒绝了签到（错误码 ${Number.isFinite(code) ? code : 'unknown'}）。` }
}

/**
 * Read the account's remaining credit.
 *
 * Note the missing `/v2` prefix: this endpoint lives at the bare
 * `/billing/meter/...` path, while the check-in endpoints are under `/v2`.
 *
 * @param credential - the resolved credential.
 * @param signal - cancellation.
 * @returns the remaining credit, or a failure.
 */
export async function readBalance(credential, signal) {
  const result = await billingPost({ credential, endpoint: 'get-user-resource-summary', v2: false, signal })
  if (!result.ok) return result
  const packages = result.payload?.data?.Packages
  if (!Array.isArray(packages)) return { ok: false, error: 'WorkBuddy 没有返回额度明细。' }
  const remaining = packages.reduce((sum, entry) => sum + Math.max(0, number(entry?.CycleRemainCapacity)), 0)
  return { ok: true, balance: remaining }
}

/** Coerce a provider-reported number, treating anything unusable as zero. */
function number(value) {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** Read one Error's message without assuming the thrown value is an Error. */
function message(error) {
  return error instanceof Error ? error.message : String(error)
}

/** The signed-in account's home directory, for diagnostics. */
export function userHome() {
  return homedir()
}
