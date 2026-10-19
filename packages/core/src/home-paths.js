/**
 * A stand-in for `@deepseek-ai/dsh-home-paths`.
 *
 * ## Why this exists
 *
 * The credential reader needs one function from the WorkBuddy integration bundle:
 * `resolveDshHome()`. In DSH that answers "where is the harness home", and the
 * bundle uses it only to place its own small cache files — the client version and
 * the auth snapshot:
 *
 *   .workbuddy-ai-version.json
 *   .workbuddy-app-version.json
 *   .workbuddy-auth.json
 *   .workbuddy-host-heartbeat.json
 *
 * That is a directory, nothing more. A standalone app supplies its own, which is
 * what makes the reader usable here without any DSH package installed.
 *
 * The function is installed into the module resolution graph by `patch-home-paths`
 * below rather than by importing the real package, which does not exist outside a
 * DSH profile.
 *
 * @module buddy-desktop/core/home-paths
 */

import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Root of this app's own data, independent of DSH. */
export function appDataDir() {
  const override = process.env.BUDDY_DESKTOP_DATA
  if (typeof override === 'string' && override.length > 0) return override
  const home = process.env.USERPROFILE || process.env.HOME || homedir()
  return join(home, '.buddy-desktop')
}

/**
 * The directory the WorkBuddy integration bundle writes its caches into.
 *
 * Named to match the real implementation so the bundle's `join()` calls land in
 * one place. It is created on demand: the bundle writes files without checking.
 *
 * @returns an existing directory path.
 */
export function resolveDshHome() {
  const dir = join(appDataDir(), 'workbuddy-cache')
  mkdirSync(dir, { recursive: true })
  return dir
}
