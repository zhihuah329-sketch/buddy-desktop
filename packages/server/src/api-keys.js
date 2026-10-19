/**
 * Keys that let another tool use this app's endpoint.
 *
 * ## Why a key at all
 *
 * The endpoint listens on loopback, which keeps it away from the network but not
 * away from anything else running on the same machine. A key makes a call
 * deliberate: a tool has to have been given one, and revoking it stops that tool
 * without touching the others or the pools.
 *
 * ## What a key is not
 *
 * It is not an upstream credential. Holding one grants access to this app's
 * forwarding, never to WorkBuddy directly — the tokens stay inside the account
 * store and are never handed out. That is the point of having a separate key.
 *
 * ## Storage
 *
 * Only a hash is kept, so a stolen key file cannot be turned back into a usable
 * key. The display prefix is stored in the clear because it is what a user needs to
 * tell two keys apart.
 *
 * @module @buddy-desktop/server/api-keys
 */

import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The prefix every key carries. `sk-` is what OpenAI-compatible clients expect, so a
 * key pasted into another tool's "API key" field is accepted without explanation.
 */
const PREFIX = 'sk-'

/**
 * The upstreams a key can be limited to.
 *
 * `workbuddy` reaches the DeepSeek pools, `command-code` reaches Command Code, and
 * `all` reaches both. They are kept apart because the two are billed separately: a key
 * handed to a tool for one should not quietly spend the other.
 */
export const KEY_SCOPES = ['all', 'workbuddy', 'command-code']

/** How much of a key is shown after creation. */
const VISIBLE = 6

/**
 * The path of the key file.
 *
 * @param dataDir - the app's data directory.
 * @returns the absolute path.
 */
function keyPath(dataDir) {
  const base = dataDir ?? join(process.env.USERPROFILE ?? process.cwd(), '.buddy-desktop')
  mkdirSync(base, { recursive: true })
  return join(base, 'api-keys.json')
}

/**
 * Hash a key for storage.
 *
 * SHA-256 without a salt is right here: the input is 32 random bytes, so there is
 * nothing to guess and no rainbow table to precompute.
 *
 * @param key - the plaintext key.
 * @returns the hex digest.
 */
function hashKey(key) {
  return createHash('sha256').update(key).digest('hex')
}

/**
 * Every stored key, without the secrets.
 *
 * @param dataDir - the app's data directory.
 * @returns the key records.
 */
export function listKeys(dataDir) {
  const path = keyPath(dataDir)
  if (!existsSync(path)) return []
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** Write the records atomically. */
function saveKeys(dataDir, records) {
  const path = keyPath(dataDir)
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(records, null, 2), { mode: 0o600 })
  renameSync(temporary, path)
}

/**
 * Create a key.
 *
 * The plaintext is returned once and never stored, so a user who loses it has to
 * create another. That is deliberate: keeping the plaintext would defeat hashing.
 *
 * @param dataDir - the app's data directory.
 * @param options - `label` for the key.
 * @returns `{ ok: true, key, record }` or a refusal.
 */
export function createKey(dataDir, options = {}) {
  const records = listKeys(dataDir)
  const label = typeof options.label === 'string' && options.label.trim().length > 0
    ? options.label.trim().slice(0, 40)
    : `密钥 ${records.length + 1}`

  // Which upstream the key may reach. The two are separate products with separate
  // bills, so a key minted for one must not work against the other. `all` exists so a
  // user who wants a single key for both can still have one.
  const scope = KEY_SCOPES.includes(options.scope) ? options.scope : 'all'

  const secret = randomBytes(24).toString('base64url')
  const key = `${PREFIX}${secret}`
  const record = {
    id: randomBytes(8).toString('hex'),
    label,
    scope,
    hash: hashKey(key),
    // Enough to recognise the key in a list without revealing it.
    hint: key.slice(0, PREFIX.length + VISIBLE),
    createdAt: Date.now(),
    lastUsedAt: 0,
    enabled: true
  }

  saveKeys(dataDir, [...records, record])
  return { ok: true, key, record: withoutSecret(record) }
}

/** A record as the page may see it. */
function withoutSecret(record) {
  const { hash, ...rest } = record
  return rest
}

/**
 * Check a presented key.
 *
 * @param dataDir - the app's data directory.
 * @param presented - the value from the Authorization header.
 * @param scope - the upstream being protected, if the caller has one.
 * @returns the matching record, or undefined.
 */
export function verifyKey(dataDir, presented, scope) {
  if (typeof presented !== 'string' || !presented.startsWith(PREFIX)) return undefined
  const digest = hashKey(presented)
  const records = listKeys(dataDir)
  const match = records.find((record) => record.hash === digest)
  // A disabled key is rejected here rather than left to the caller: one place decides
  // whether a key may be used, so a new call site cannot forget the check.
  if (match === undefined || match.enabled === false) return undefined

  // A key limited to one upstream does not open the other. A record written before
  // scopes existed has none, and is treated as `all` so existing keys keep working.
  if (scope !== undefined) {
    const keyScope = match.scope ?? 'all'
    if (keyScope !== 'all' && keyScope !== scope) return undefined
  }

  // The time of use is recorded so a stale key can be spotted, but a failure to
  // write it must not reject an otherwise valid call.
  try {
    const updated = records.map((record) =>
      record.id === match.id ? { ...record, lastUsedAt: Date.now() } : record
    )
    saveKeys(dataDir, updated)
  } catch {
    // Ignored on purpose.
  }
  return withoutSecret(match)
}

/**
 * Remove a key or stop it working.
 *
 * @param dataDir - the app's data directory.
 * @param options - `id` to delete, or `id` and `enabled` to toggle.
 * @returns whether anything changed.
 */
export function updateKey(dataDir, options = {}) {
  const records = listKeys(dataDir)
  const id = options.id
  if (typeof id !== 'string') return { ok: false, error: '缺少密钥 id。' }

  const found = records.find((record) => record.id === id)
  if (found === undefined) return { ok: false, error: '找不到该密钥。' }

  if (options.remove === true) {
    saveKeys(dataDir, records.filter((record) => record.id !== id))
    return { ok: true, removed: true }
  }

  const enabled = options.enabled !== false
  saveKeys(dataDir, records.map((record) => (record.id === id ? { ...record, enabled } : record)))
  return { ok: true, enabled }
}

/**
 * The public list, for the page.
 *
 * @param dataDir - the app's data directory.
 * @returns the records that may be shown.
 */
export function publicKeys(dataDir) {
  return listKeys(dataDir).map(withoutSecret)
}
