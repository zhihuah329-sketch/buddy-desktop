/**
 * Theme handling.
 *
 * Three states, not two: a user who has never chosen should follow the operating
 * system, and someone who has chosen should keep that choice even when the system
 * changes. So `mode` is `dark | light | system`, and the applied theme is derived
 * from it.
 *
 * The choice is kept in `localStorage` because it is a per-machine preference, not
 * account state — it is applied before the first paint so a light user never sees a
 * dark flash.
 */

/** Storage key for the chosen mode. */
const KEY = 'buddy-desktop-theme'

/** The modes the interface offers, in cycle order. */
export const MODES = ['system', 'dark', 'light']

/** What a mode is called in the interface. */
export const MODE_LABELS = {
  system: '跟随系统',
  dark: '深色',
  light: '浅色'
}

/** Whether the operating system currently prefers a dark interface. */
function systemPrefersDark() {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches === true
}

/**
 * The mode to start in.
 *
 * A stored value wins; otherwise the system decides, which is what most people
 * expect from a program they have not configured.
 *
 * `?theme=` overrides both. It exists for reviewing the interface in a fixed theme,
 * where the machine's own preference would otherwise decide what is on screen.
 *
 * @returns {'dark'|'light'|'system'}
 */
export function initialMode() {
  try {
    const forced = new URLSearchParams(window.location.search).get('theme')
    if (forced === 'dark' || forced === 'light') return forced
  } catch {
    // A malformed URL leaves the normal path.
  }
  try {
    const stored = window.localStorage.getItem(KEY)
    if (MODES.includes(stored)) return stored
  } catch {
    // Private mode or a blocked store: fall through to the default.
  }
  return 'system'
}

/**
 * Apply a mode to the document.
 *
 * The resolved theme is written to `data-theme` on the root element, which is what
 * the stylesheet keys off. `system` resolves at call time rather than being stored,
 * so a system change while the app is open is picked up.
 *
 * @param {'dark'|'light'|'system'} mode
 * @returns the theme that was applied.
 */
export function applyMode(mode) {
  const resolved = mode === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : mode
  document.documentElement.setAttribute('data-theme', resolved)
  // A forced theme is a preview, not a choice: remembering it would make the next
  // normal launch open in whatever a review pass happened to use.
  const forced = new URLSearchParams(window.location.search).get('theme')
  if (forced === 'dark' || forced === 'light') return resolved
  try {
    window.localStorage.setItem(KEY, mode)
  } catch {
    // Not being able to remember the choice is not a reason to refuse it.
  }
  return resolved
}

/**
 * Call a listener whenever the system preference changes.
 *
 * Only useful in `system` mode, but it is subscribed unconditionally and the caller
 * decides — a subscription that comes and goes with the mode is easy to leak.
 *
 * @param {() => void} listener
 * @returns an unsubscribe function.
 */
export function onSystemChange(listener) {
  const query = window.matchMedia?.('(prefers-color-scheme: dark)')
  if (query === undefined) return () => {}
  query.addEventListener('change', listener)
  return () => query.removeEventListener('change', listener)
}
