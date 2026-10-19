/**
 * Model-call forwarding.
 *
 * ## What this does
 *
 * Takes an OpenAI-shaped chat request, picks an account from the right region's
 * pool, forwards it upstream, and streams the answer back. If the account cannot
 * serve — spent quota, rate limit, expired token — it moves to the next account
 * without the caller noticing, and only fails once the pool is exhausted.
 *
 * ## Why the stream is pumped by hand
 *
 * A quota refusal can arrive as an SSE error event inside an HTTP 200, so testing
 * the response status alone misses it. The chunk count is tracked instead: before
 * anything reached the client another account can serve the request outright;
 * after that, retrying would duplicate the answer, so the account steps aside and
 * the error is reported.
 *
 * @module @buddy-desktop/server/forward
 */

import {
  AccountPool,
  COOLDOWN_MS,
  MAX_ACCOUNTS,
  HOSTS,
  parseModel,
  preparePayload,
  requestContext,
  shouldRotate,
  streamFailurePlan,
  upstreamHeaders,
  uuid7Hex,
  dashify,
  readVault,
  recordHealth,
  readHealth
} from '@buddy-desktop/core'

/** Upstream paths that accept a chat completion. */
const CHAT_PATH = '/v2/chat/completions'

/** How long an account is parked after a failure that is its own fault. */
const DEFAULT_COOLDOWN_MS = COOLDOWN_MS

/**
 * Build a pool from the account store.
 *
 * The learned quota windows are replayed into it, so an account that ran out
 * before this process started is not offered again until its window passes.
 *
 * @param dataDir - the account store to read.
 * @returns the pool and the store result.
 */
export function buildPool(dataDir) {
  const vault = readVault(dataDir)
  if (vault.ok !== true) return { ok: false, error: vault.error ?? '账号库读取失败。' }

  const accounts = (vault.accounts ?? [])
    .filter((account) => account && account.removed !== true)
    .map((account) => ({
      id: account.id,
      site: account.site === 'ai' ? 'ai' : 'cn',
      accessToken: account.accessToken,
      refreshToken: account.refreshToken ?? '',
      uid: account.uid ?? '',
      enterpriseId: account.enterpriseId ?? '',
      domain: account.domain ?? '',
      expiresAt: typeof account.expiresAt === 'number' ? account.expiresAt : 0,
      enabled: account.enabled !== false,
      authState: account.authState ?? '待验证'
    }))

  const pool = new AccountPool(accounts, {
    onFinish: (id, outcome) => {
      // Persisting the quota window is what makes a spent account stay out of
      // rotation across restarts.
      if (outcome?.quotaResetAt !== undefined || outcome?.error !== undefined) {
        recordHealth(id, {
          ...(outcome.quotaResetAt === undefined ? {} : { quotaResetAt: outcome.quotaResetAt }),
          ...(outcome.error === undefined ? {} : { lastError: outcome.error })
        })
      }
    }
  })
  pool.hydrate(readHealth(), Date.now())
  return { ok: true, pool, accounts }
}

/**
 * Choose the upstream base URL for a region.
 *
 * The first host is the canonical one; the second is used if the first refuses to
 * connect, which happens on networks that block one of the two domains.
 *
 * @param site - 'cn' or 'ai'.
 * @returns the base URL, without a trailing slash.
 */
function baseFor(site) {
  return (HOSTS[site] ?? HOSTS.cn)[0]
}

/** Build the per-request ids the upstream expects. */
function claimIds() {
  const message = uuid7Hex()
  return {
    conversation: dashify(uuid7Hex()),
    turn: dashify(uuid7Hex()),
    message
  }
}

/** Read a failure body without throwing on a non-JSON reply. */
async function readFailure(response) {
  let text = ''
  try {
    text = await response.text()
  } catch {
    // A body that cannot be read is reported by status alone.
  }
  let code
  let message = text
  try {
    const parsed = JSON.parse(text)
    if (typeof parsed?.code === 'number') code = parsed.code
    const raw = parsed?.msg ?? parsed?.message ?? parsed?.error?.message
    if (typeof raw === 'string' && raw.length > 0) message = raw
  } catch {
    // Not JSON: keep the raw text, trimmed.
  }
  return { code, message: message.slice(0, 500) }
}

/** Turn an SSE byte stream into parsed `data:` values. */
async function* sseValues(body) {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true })
    let index = buffer.indexOf('\n\n')
    while (index >= 0) {
      const block = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      for (const line of block.split('\n')) {
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data.length === 0) continue
        if (data === '[DONE]') {
          yield { done: true }
          continue
        }
        try {
          yield { value: JSON.parse(data) }
        } catch {
          // A frame that does not parse is skipped rather than fatal.
        }
      }
      index = buffer.indexOf('\n\n')
    }
  }
}

/**
 * Forward one chat request, returning a stream of already-serialized SSE frames.
 *
 * @param options - `pool`, `site`, `model`, `payload`, `signal`.
 * @returns `{ ok: true, frames }` or `{ ok: false, status, error, code }`.
 */
export async function forwardChat(options) {
  const { pool, site, model, payload, signal } = options

  const body = preparePayload({ ...payload, model })
  const context = requestContext(body, '')

  const excluded = new Set()
  let lastStatus = 503
  let lastMessage = '没有可用的账号。'
  let lastCode

  for (let attempt = 0; attempt < MAX_ACCOUNTS; attempt += 1) {
    const account = pool.pick(site, excluded)
    if (account === undefined) break
    excluded.add(account.id)

    const base = baseFor(site)
    const ids = claimIds()
    let response
    try {
      response = await fetch(`${base}${CHAT_PATH}`, {
        method: 'POST',
        headers: upstreamHeaders(account, base, { ...ids, ...context }),
        body: JSON.stringify(body),
        signal
      })
    } catch (error) {
      if (signal?.aborted === true) {
        pool.finish(account.id, false, 'aborted', 0)
        return { ok: false, status: 499, error: '请求已取消。' }
      }
      pool.finish(account.id, false, error instanceof Error ? error.message : String(error), DEFAULT_COOLDOWN_MS)
      lastStatus = 502
      lastMessage = '连接上游失败，已换用其他账号。'
      continue
    }

    if (response.status >= 400) {
      const failure = await readFailure(response)
      lastStatus = response.status
      lastCode = failure.code
      lastMessage = failure.message
      const rotate = shouldRotate(response.status, failure.code, failure.message)
      pool.finish(account.id, false, failure.message, rotate ? DEFAULT_COOLDOWN_MS : 0, {
        code: failure.code
      })
      if (rotate) continue
      return { ok: false, status: response.status, error: failure.message, code: failure.code }
    }

    if (response.body === null) {
      pool.finish(account.id, false, '上游返回空响应', DEFAULT_COOLDOWN_MS)
      lastStatus = 502
      continue
    }

    // The account answered; its recorded outcome is decided when the stream ends.
    return { ok: true, account, response, pool, ids }
  }

  if (excluded.size === 0) {
    return {
      ok: false,
      status: 503,
      error: `${site === 'cn' ? '国内版' : '国际版'}没有可用账号。两个区域互不回退，请为该区域添加账号或等额度重置。`
    }
  }
  return {
    ok: false,
    status: lastStatus >= 400 ? lastStatus : 503,
    error: lastMessage,
    ...(lastCode === undefined ? {} : { code: lastCode })
  }
}

/**
 * Pump an upstream answer to the client, recording the outcome.
 *
 * Yields already-encoded SSE bytes, so the caller writes them without knowing the
 * upstream's frame shape.
 *
 * @param forwarded - the result of `forwardChat`.
 * @param signal - abort signal.
 */
export async function* pumpAnswer(forwarded, signal) {
  const { response, pool, account } = forwarded
  let emitted = 0
  let completed = false
  let failure = ''

  const encoder = new TextEncoder()
  for await (const frame of sseValues(response.body)) {
    if (signal?.aborted === true) {
      failure = 'aborted'
      break
    }
    if (frame.done === true) {
      completed = true
      emitted += 1
      yield encoder.encode('data: [DONE]\n\n')
      break
    }
    const value = frame.value
    if (value === undefined) continue
    // An error carried inside a 200 is the case a status check misses.
    if (value.error !== undefined) {
      const message = typeof value.error?.message === 'string' ? value.error.message : '上游返回错误'
      failure = message
      break
    }
    emitted += 1
    yield encoder.encode(`data: ${JSON.stringify(value)}\n\n`)
  }

  if (completed === true) {
    pool.finish(account.id, true, '', 0)
    return
  }
  const plan = streamFailurePlan({ emitted, message: failure })
  pool.finish(account.id, false, failure, plan.cooldownMs, plan.code === undefined ? {} : { code: plan.code })
}

export { parseModel }
