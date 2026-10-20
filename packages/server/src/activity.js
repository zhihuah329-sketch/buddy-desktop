/**
 * A record of calls this app served.
 *
 * ## Why the token counts are estimated
 *
 * The upstream replies with an OpenAI-shaped body that carries no `usage` field, so
 * the authoritative token counts are not available — `probe-tokens.mjs` against a
 * live account shows a body of `id, object, created, model, choices` and nothing
 * else. What can be measured is what went in and what came out: the characters of
 * the request and the characters of the answer.
 *
 * Those characters are turned into a token estimate with `estimateTokens`. It is
 * labelled "约" on the page because it is a count from a rule, not a reading from
 * the service. Storing both lets the page show the estimate while keeping the exact
 * figure that produced it, so the number never becomes unattributable.
 *
 * The ratios are the usual rule of thumb for this family of models: roughly one
 * token per CJK character, and roughly four Latin characters per token. Code and
 * punctuation tokenise differently from prose, so an individual call can be off by
 * a third in either direction; the totals across many calls are much closer.
 *
 * ## Bounded on purpose
 *
 * The file is capped at a few hundred entries and rewritten atomically. An
 * unbounded log in a program that may run for weeks would eventually be the largest
 * thing on disk, and the page only ever shows the most recent calls.
 *
 * @module @buddy-desktop/server/activity
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** How many calls to keep. */
const MAX_ENTRIES = 500

/** Latin characters that make up one token, on average. */
const LATIN_CHARS_PER_TOKEN = 4

/** Directory for the record, relative to the app's data directory. */
function recordPath(dataDir) {
  const base = dataDir ?? join(process.env.USERPROFILE ?? process.cwd(), '.buddy-desktop')
  mkdirSync(base, { recursive: true })
  return join(base, 'activity.json')
}

/**
 * Estimate the tokens in a string.
 *
 * CJK is counted per character, everything else in groups of four. The split has to
 * happen first: a Chinese sentence of 100 characters is about 100 tokens, while 100
 * Latin characters are about 25, and averaging them together would be wrong for both.
 *
 * @param text - the text to measure.
 * @returns the estimate, rounded up.
 */
export function estimateTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0
  const cjk = (text.match(/[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/g) ?? []).length
  const rest = text.length - cjk
  return Math.ceil(cjk + rest / LATIN_CHARS_PER_TOKEN)
}

/**
 * The recorded calls, newest first.
 *
 * A corrupt file yields an empty list rather than an error: losing the history is
 * annoying, but refusing to start because of it is not acceptable.
 *
 * @param dataDir - where the record lives.
 * @returns the entries.
 */
export function readActivity(dataDir) {
  const path = recordPath(dataDir)
  if (!existsSync(path)) return []
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/**
 * Append one call.
 *
 * @param dataDir - where the record lives.
 * @param entry - what happened.
 */
export function recordCall(dataDir, entry) {
  const entries = readActivity(dataDir)
  entries.unshift(entry)
  const path = recordPath(dataDir)
  const temporary = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(entries.slice(0, MAX_ENTRIES)), 'utf8')
    // Rename is atomic on the same volume, so a crash mid-write cannot leave a
    // half-written record in place of a good one.
    renameSync(temporary, path)
  } catch {
    // Recording a call is diagnostics, never a reason to fail the call itself.
  }
}

/**
 * Count the characters of a message list.
 *
 * @param messages - the OpenAI message array.
 * @returns the total characters across every textual part.
 */
export function countChars(messages) {
  return collectText(messages).length
}

/**
 * Estimate the tokens of a message list.
 *
 * @param messages - the OpenAI message array.
 * @returns the estimate.
 */
export function estimateMessageTokens(messages) {
  return estimateTokens(collectText(messages))
}

/**
 * Join every textual part of a message list into one string.
 *
 * Kept separate from the counting so both the character count and the token estimate
 * read the same text: two functions walking the array independently would eventually
 * disagree about what counts, and the two figures would stop matching.
 *
 * @param messages - the OpenAI message array.
 * @returns the joined text.
 */
function collectText(messages) {
  if (!Array.isArray(messages)) return ''
  const parts = []
  for (const message of messages) {
    if (typeof message?.content === 'string') {
      parts.push(message.content)
      continue
    }
    // A multimodal message carries an array of parts; only text is counted, because
    // image bytes are not comparable to characters.
    if (Array.isArray(message?.content)) {
      for (const part of message.content) {
        if (typeof part?.text === 'string') parts.push(part.text)
      }
    }
  }
  return parts.join('')
}

/**
 * The token estimate for one recorded call.
 *
 * Entries written before the estimate existed carry only characters. Those are
 * estimated at the prose rate, which is the middle of the range: a request is usually
 * mixed, and guessing the mix per entry would invent detail the record does not have.
 * The alternative — treating them as absent — would drop the oldest calls from the
 * totals and make history look smaller than it was.
 *
 * @param entry - one recorded call.
 * @returns its prompt and reply token estimates.
 */
function tokensOf(entry) {
  const prompt = typeof entry.promptTokens === 'number'
    ? entry.promptTokens
    : Math.ceil((entry.promptChars ?? 0) / 2)
  const reply = typeof entry.replyTokens === 'number'
    ? entry.replyTokens
    : Math.ceil((entry.replyChars ?? 0) / 2)
  return { prompt, reply }
}

/**
 * Summarise the record for the page.
 *
 * @param dataDir - where the record lives.
 * @returns totals and the most recent calls.
 */
export function summariseActivity(dataDir) {
  const entries = readActivity(dataDir)
  const byModel = new Map()
  const byAccount = new Map()

  let promptTokens = 0
  let replyTokens = 0
  let promptChars = 0
  let replyChars = 0

  for (const entry of entries) {
    const tokens = tokensOf(entry)
    const inChars = entry.promptChars ?? 0
    const outChars = entry.replyChars ?? 0
    promptTokens += tokens.prompt
    replyTokens += tokens.reply
    promptChars += inChars
    replyChars += outChars

    const modelKey = entry.model ?? 'unknown'
    const model = byModel.get(modelKey) ?? {
      model: modelKey,
      calls: 0,
      chars: 0,
      promptTokens: 0,
      replyTokens: 0,
      ok: 0
    }
    model.calls += 1
    model.chars += inChars + outChars
    model.promptTokens += tokens.prompt
    model.replyTokens += tokens.reply
    if (entry.ok === true) model.ok += 1
    byModel.set(modelKey, model)

    // Grouped by id, labelled by name: two accounts can share a label, and an
    // account's label can change when it is re-read.
    const accountKey = entry.accountId ?? entry.accountLabel ?? 'unknown'
    const account = byAccount.get(accountKey) ?? {
      id: accountKey,
      label: entry.accountLabel ?? accountKey.slice(0, 8),
      site: entry.site ?? null,
      calls: 0,
      chars: 0,
      promptTokens: 0,
      replyTokens: 0
    }
    account.calls += 1
    account.chars += inChars + outChars
    account.promptTokens += tokens.prompt
    account.replyTokens += tokens.reply
    byAccount.set(accountKey, account)
  }

  return {
    total: entries.length,
    // Whether these token figures are estimates. They always are, but the page reads
    // this rather than deciding for itself, so the label cannot drift from the data.
    estimated: true,
    tokens: { prompt: promptTokens, reply: replyTokens, total: promptTokens + replyTokens },
    chars: { prompt: promptChars, reply: replyChars, total: promptChars + replyChars },
    recent: entries.slice(0, 50),
    byModel: [...byModel.values()].sort((a, b) => b.calls - a.calls),
    byAccount: [...byAccount.values()].sort((a, b) => b.calls - a.calls)
  }
}
