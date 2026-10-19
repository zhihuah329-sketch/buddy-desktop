/**
 * The switches a user controls.
 *
 * ## Three, and why three
 *
 * The forwarding endpoint serves two independent pools, and there are times when a
 * user wants one of them quiet without stopping everything: a region whose accounts
 * are nearly out of quota, or one being debugged. So each region has its own switch,
 * and a master switch gates the endpoint as a whole.
 *
 * The nesting is deliberate — a region switch off means that region's requests fail;
 * the master off means every request fails — and the page shows the effective state
 * so a region switched on behind a closed master does not look like it is serving.
 *
 * ## Why the state is not persisted
 *
 * A switch left off from a previous session is the kind of thing a user forgets and
 * then reports as a bug. Restarting the app therefore resumes serving, which is what
 * the app is for; the cost of one request is smaller than the cost of a mystery.
 *
 * @module @buddy-desktop/server/switches
 */

/** The switches, and their defaults. */
const DEFAULTS = {
  master: true,
  cn: true,
  ai: true
}

/** The state of every switch. */
export class Switches {
  constructor(options = {}) {
    this.state = {
      master: options.master ?? DEFAULTS.master,
      cn: options.cn ?? DEFAULTS.cn,
      ai: options.ai ?? DEFAULTS.ai
    }
    /** When each switch last changed, for the page to report. */
    this.changedAt = {}
  }

  /**
   * Whether a region may serve a request.
   *
   * Both the region's own switch and the master must be open. Asking only the
   * region would let a request through while the master is off.
   *
   * @param site - 'cn' or 'ai'.
   * @returns whether a call to that region may proceed.
   */
  allows(site) {
    if (this.state.master !== true) return false
    return this.state[site === 'ai' ? 'ai' : 'cn'] === true
  }

  /**
   * Set one switch.
   *
   * @param name - 'master', 'cn' or 'ai'.
   * @param enabled - the new state.
   * @returns the new state, or undefined when the name is unknown.
   */
  set(name, enabled) {
    if (!Object.hasOwn(this.state, name)) return undefined
    this.state[name] = enabled === true
    this.changedAt[name] = Date.now()
    return this.state[name]
  }

  /**
   * The state, with the effective answer for each region.
   *
   * `effective` is what the page should show: a region switch that is on behind a
   * closed master is not actually serving.
   *
   * @returns the snapshot.
   */
  snapshot() {
    return {
      master: this.state.master,
      cn: this.state.cn,
      ai: this.state.ai,
      effective: {
        cn: this.allows('cn'),
        ai: this.allows('ai')
      },
      changedAt: this.changedAt
    }
  }
}
