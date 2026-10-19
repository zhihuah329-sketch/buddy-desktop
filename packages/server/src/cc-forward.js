/**
 * Forward a model call to Command Code.
 *
 * ## Why this exists
 *
 * The account pools serve DeepSeek through WorkBuddy. Command Code is a separate
 * upstream with its own key and its own models — Claude, GPT, and others — and the
 * app already stores that key. What was missing is the path from the forwarding
 * endpoint to it, so a local `sk-` key could not reach any of those models.
 *
 * ## The shape of the call
 *
 * Command Code speaks its own request shape, built by `buildCcRequest` in core. The
 * answer comes back as SSE frames in the OpenAI delta shape, which is what the app
 * already relays to its own clients, so only the request needs translating.
 *
 * @module @buddy-desktop/server/cc-forward
 */

import { buildCcRequest, ccHeaders, mapCcError, readCommandCodeKey, CC_API_BASE } from '@buddy-desktop/core'

/**
 * Send one request to Command Code.
 *
 * @param options - `model`, `payload`, `signal`.
 * @returns `{ ok: true, response }` or `{ ok: false, status, error }`.
 */
export async function forwardToCommandCode(options) {
  const apiKey = readCommandCodeKey()
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    return {
      ok: false,
      status: 503,
      error: 'Command Code 还没有配置密钥。到「Command Code」页填一个以 user_ 开头的密钥。'
    }
  }

  let body
  try {
    body = buildCcRequest({ ...options.payload, model: options.model })
  } catch (error) {
    return {
      ok: false,
      status: 400,
      error: `请求无法转换：${error instanceof Error ? error.message : String(error)}`
    }
  }

  let response
  try {
    response = await fetch(`${CC_API_BASE}/alpha/generate`, {
      method: 'POST',
      headers: {
        ...ccHeaders(apiKey, `buddy-desktop-${Date.now().toString(36)}`),
        accept: 'text/event-stream'
      },
      body: JSON.stringify(body),
      signal: options.signal
    })
  } catch (error) {
    return {
      ok: false,
      status: 502,
      error: `连不上 Command Code：${error instanceof Error ? error.message : String(error)}`
    }
  }

  if (!response.ok) {
    // The upstream body says far more than the status code. `mapCcError` expects the
    // raw text — it parses it itself — and reading it as JSON first lost the message,
    // which turned a precise refusal into "调用失败".
    let text = ''
    try {
      text = await response.text()
    } catch {
      text = ''
    }
    const mapped = mapCcError(response.status, text)
    return {
      ok: false,
      status: mapped.status ?? response.status ?? 502,
      error: mapped.body?.error?.message ?? mapped.message ?? 'Command Code 调用失败。'
    }
  }

  return { ok: true, response }
}
