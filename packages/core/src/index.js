/**
 * The framework-free core of the desktop app.
 *
 * Everything exported here runs in plain Node with no DSH or Electron dependency.
 * The app is a thin shell — an HTTP server and a Vue page — over these modules, so
 * the same logic can back a CLI, a tray icon, or a future mobile client without
 * being rewritten.
 *
 * @module @buddy-desktop/core
 */

// Account pool and the rules that decide which account may serve a request.
export {
  AccountPool,
  MAX_ACCOUNTS,
  COOLDOWN_MS,
  QUOTA_EXHAUSTED_CODE,
  HOSTS,
  MODEL_IDS,
  BASE_MODEL,
  identityFromToken,
  quotaResetAt,
  isQuotaExhausted,
  eligibility,
  parseModel,
  preparePayload,
  requestContext,
  shouldRotate,
  streamFailurePlan,
  upstreamHeaders,
  uuid7Hex,
  dashify
} from './proxy.js'

// What the page shows: verdicts, counts, and the authorize plan per region.
export {
  ACCOUNT_STATUSES,
  STATUS_LABELS,
  accountStatus,
  accountOverview,
  authorizationPlan,
  discoverCredentials,
  importCredentialFile,
  importCredentials,
  poolAlreadyHas,
  resolveClientForSite,
  resolveWorkBuddyPath
} from './account-status.js'

// Reading a credential straight out of the installed desktop app.
export { applyElectronPath, readDesktopCredential, siblingAvailable } from './desktop-app.js'
export { loadSibling, siblingLocation } from './sibling.js'
export { appDataDir, resolveDshHome } from './home-paths.js'

// The encrypted account store.
export { readVault, diagnoseCredential } from './vault.js'
export {
  readVaultAccounts,
  upsertCapturedCredential,
  updateAccountCredential,
  removeAccount
} from './vault-edit.js'

// Learned state that outlives a process: quota windows and error history.
export { readHealth, recordHealth, clearHealth } from './account-health.js'
export { resolveStateDir } from './state-dir.js'
export { detectTunnel, tunnelWarning } from './tunnel.js'

// The second model channel: Command Code, reached with its own API key rather than
// a desktop login, and offering its own model catalogue.
export {
  CC_API_BASE,
  CC_MODELS,
  CC_DEFAULT_MODEL,
  buildCcRequest,
  ccHeaders,
  ccModelCatalogue,
  mapCcError,
  mapFinishReason,
  normalizeUsage
} from './command-code.js'

export {
  readCommandCodeKey,
  writeCommandCodeKey,
  maskKey,
  validateKeyShape,
  testCommandCodeKey
} from './cc-credentials.js'

// Daily check-in across every account.
export { CHECKIN_OUTCOMES, checkinAll, selectCheckinAccounts, summarise } from './checkin-all.js'
export { CheckinScheduler, cnDate, nextOccurrence } from './scheduler.js'
export { CheckinPrefs, applyCheckinPrefs } from './checkin-prefs.js'
