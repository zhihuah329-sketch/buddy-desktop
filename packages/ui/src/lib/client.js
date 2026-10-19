/**
 * The page's only doorway to the backend.
 *
 * Every call goes through one request function, so a transport failure is reported
 * in one shape and the page can tell "the server said no" from "the server is not
 * running" without each component inventing its own handling.
 */

/** Thrown when the backend answers with a non-2xx status, or cannot be reached. */
export class ApiError extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

/**
 * Perform one API call.
 *
 * @param {string} path e.g. `/state`.
 * @param {{ method?: string, body?: unknown }} options request options.
 */
async function request(path, options = {}) {
  let response
  try {
    response = await fetch(`/api${path}`, {
      method: options.method ?? 'GET',
      headers: options.body === undefined ? {} : { 'content-type': 'application/json' },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
    })
  } catch {
    // A refused connection means the program is not running, which is something
    // the user can act on — not a bug to report.
    throw new ApiError('连不上本地服务，请重新启动程序。', 0)
  }
  if (!response.ok) {
    let detail = `HTTP ${response.status}`
    try {
      const body = await response.json()
      if (typeof body?.error === 'string') detail = body.error
    } catch {
      // A non-JSON error body leaves the status text.
    }
    throw new ApiError(detail, response.status)
  }
  return response.json()
}

/** The backend, as the page uses it. */
export function createClient() {
  return {
    /** Everything the page renders. */
    fetchState: () => request('/state'),
    /** Scan for credential files, optionally for one region. */
    discover: (site) => request('/discover', { method: 'POST', body: site ? { site } : {} }),
    /** Import every readable credential file. */
    importAll: (site) => request('/import', { method: 'POST', body: site ? { site } : {} }),
    /** Read a credential straight out of the installed desktop app. */
    readFromDesktop: (site) => request('/read-desktop', { method: 'POST', body: { site } }),
    /** The last check-in result. */
    fetchCheckin: () => request('/checkin'),
    /** Run a check-in cycle now. */
    runCheckin: () => request('/checkin', { method: 'POST', body: { force: true } }),

    /** Save a Command Code API key. */
    saveCommandCodeKey: (key) => request('/command-code/key', { method: 'POST', body: { key } }),
    /** Check the stored Command Code key against the upstream. */
    testCommandCode: () => request('/command-code/test', { method: 'POST' }),
    /** Forget the stored Command Code key. */
    clearCommandCodeKey: () => request('/command-code/clear', { method: 'POST' }),

    /** Remove one account from the pool. */
    removeAccount: (id) => request(`/account?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
  }
}
