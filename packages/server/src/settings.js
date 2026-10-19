/**
 * Settings the user chooses.
 *
 * ## Why these are stored rather than detected every time
 *
 * Client detection guesses well on a default install and badly on the others: the
 * client is often moved to another drive, or installed beside a second copy. A user
 * who points at the right executable should not have to do it again on every launch,
 * so the choice is written down and takes precedence over detection.
 *
 * ## Where
 *
 * A single `settings.json` in the app's data directory. It holds only paths — never a
 * credential — so it is safe to leave readable, and a user can edit it by hand if the
 * interface is not reachable.
 *
 * @module @buddy-desktop/server/settings
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** The settings this app keeps. */
const DEFAULTS = {
  /** The CN client executable, when the user chose one. */
  workbuddyPath: '',
  /** The international client executable, when the user chose one. */
  workbuddyIntlPath: ''
}

/** The file these live in. */
function settingsPath(dataDir) {
  const base = dataDir ?? join(process.env.USERPROFILE ?? process.cwd(), '.buddy-desktop')
  mkdirSync(base, { recursive: true })
  return join(base, 'settings.json')
}

/**
 * Read the stored settings.
 *
 * A corrupt file yields the defaults rather than an error: the app can run without
 * them, and refusing to start over a malformed preference file would be worse than
 * losing the preference.
 *
 * @param dataDir - the app's data directory.
 * @returns the settings.
 */
export function readSettings(dataDir) {
  const path = settingsPath(dataDir)
  if (!existsSync(path)) return { ...DEFAULTS }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return { ...DEFAULTS }
    return {
      workbuddyPath: typeof parsed.workbuddyPath === 'string' ? parsed.workbuddyPath : '',
      workbuddyIntlPath: typeof parsed.workbuddyIntlPath === 'string' ? parsed.workbuddyIntlPath : ''
    }
  } catch {
    return { ...DEFAULTS }
  }
}

/**
 * Store a change, leaving the other keys alone.
 *
 * @param dataDir - the app's data directory.
 * @param changes - the keys to set.
 * @returns the settings after the change.
 */
export function writeSettings(dataDir, changes = {}) {
  const current = readSettings(dataDir)
  const next = { ...current }

  for (const key of Object.keys(DEFAULTS)) {
    if (typeof changes[key] !== 'string') continue
    next[key] = changes[key].trim()
  }

  const path = settingsPath(dataDir)
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(next, null, 2), 'utf8')
  // Rename is atomic on the same volume, so a crash cannot leave a half-written file.
  renameSync(temporary, path)
  return next
}
