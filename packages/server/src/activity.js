/**
 * A record of calls this app served.
 *
 * ## Why a local record at all
 *
 * The upstream replies with an OpenAI-shaped body that carries no `usage` field, so
 * the authoritative token counts are not available. What can be measured is what
 * went in and what came out: the characters of the request and the characters of
 * the answer, which is enough to show a user which account and model served a call
 * and roughly how large it was. Guessing a token count would be worse than saying
 * which figure is being shown, so the record keeps characters and says so.
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

/** Directory for the record, relative to the app's data directory. */
function recordPath(dataDir) {
  const base = dataDir ?? join(process.env.USERPROFILE ?? process.cwd(), '.buddy-desktop')
  mkdirSync(base, { recursive: true })
  return join(base, 'activity.json')
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
  if (!Array.isArray(messages)) return 0
  let total = 0
  for (const message of messages) {
    if (typeof message?.content === 'string') {
      total += message.content.length
      continue
    }
    // A multimodal message carries an array of parts; only text is counted, because
    // image bytes are not comparable to characters.
    if (Array.isArray(message?.content)) {
      for (const part of message.content) {
        if (typeof part?.text === 'string') total += part.text.length
      }
    }
  }
  return total
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

  for (const entry of entries) {
    const modelKey = entry.model ?? 'unknown'
    const model = byModel.get(modelKey) ?? { model: modelKey, calls: 0, chars: 0, ok: 0 }
    model.calls += 1
    model.chars += (entry.promptChars ?? 0) + (entry.replyChars ?? 0)
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
      chars: 0
    }
    account.calls += 1
    account.chars += (entry.promptChars ?? 0) + (entry.replyChars ?? 0)
    byAccount.set(accountKey, account)
  }

  return {
    total: entries.length,
    recent: entries.slice(0, 50),
    byModel: [...byModel.values()].sort((a, b) => b.calls - a.calls),
    byAccount: [...byAccount.values()].sort((a, b) => b.calls - a.calls)
  }
}
