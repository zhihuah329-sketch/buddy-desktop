/**
 * Usage and quota data, assembled from what the app already knows.
 *
 * ## Where these numbers come from
 *
 * Nothing here is estimated. Request counts and successes are what the pool recorded
 * while serving; expiry comes from the token's own claim; the quota window is either
 * the reset time named in an upstream refusal or zero when nothing has run out. The
 * balance is queried directly from the billing endpoint. Check-in balances are
 * retained as historical readings.
 *
 * @module @buddy-desktop/server/usage
 */

import { readVault, selectCheckinAccounts } from '@buddy-desktop/core'
import { readBalance } from '@buddy-desktop/core/workbuddy'

export function createQuotaReader(dataDir) {
  let records = new Map()
  let pending
  async function refresh() {
    const vault = readVault(dataDir)
    if (!vault.ok) throw new Error('无法读取账号库。')
    const targets = selectCheckinAccounts(vault.accounts)
    const next = new Map()
    for (const account of targets) {
      let result
      try {
        result = await readBalance({
          accessToken: account.accessToken,
          uid: account.uid,
          domain: account.domain ?? 'copilot.tencent.com'
        }, AbortSignal.timeout(7000))
      } catch {
        result = { ok: false, error: '额度查询失败，请稍后重试。' }
      }
      next.set(account.id, { ...result, at: Date.now() })
    }
    records = next
  }
  return {
    snapshot: () => records,
    refresh() {
      pending ??= refresh().finally(() => { pending = undefined })
      return pending
    }
  }
}

/**
 * Build the usage document.
 *
 * @param options - `state` (the status document) and `checkin` (its snapshot).
 * @returns the usage report.
 */
export function buildUsage(options = {}) {
  const state = options.state ?? {}
  const checkin = options.checkin ?? null
  const quota = options.quota ?? new Map()
  const now = Date.now()

  // Preserve historical check-in balances separately, keyed by account ID.
  const balances = new Map()
  for (const record of checkin?.checkinAccounts ?? []) {
    if (typeof record.balance === 'number') {
      balances.set(record.id, {
        balance: record.balance,
        credits: record.credits ?? 0,
        totalCredits: record.totalCredits ?? 0
      })
    }
  }

  const accounts = (state.accounts ?? []).map((account) => {
    const balance = balances.get(account.id)
    const reading = account.site === 'cn' ? quota.get(account.id) : undefined
    const requests = account.requests ?? 0
    const failures = account.failures ?? 0
    const successes = account.successes ?? 0
    return {
      id: account.id,
      site: account.site,
      label: account.label ?? account.id.slice(0, 8),
      usable: account.usable === true,
      status: account.statusLabel ?? '未知',
      requests,
      successes,
      failures,
      // A rate, not a count: 81 failures out of 435 is healthy, 81 out of 90 is not.
      successRate: requests === 0 ? null : successes / requests,
      expiresAt: account.expiresAt ?? 0,
      daysToExpiry: account.expiresAt > 0 ? Math.floor((account.expiresAt - now) / 86_400_000) : null,
      quotaResetAt: account.quotaResetAt ?? 0,
      cooldownUntil: account.cooldownUntil ?? 0,
      lastError: account.lastError ?? '',
      balance: reading?.ok ? reading.balance : null,
      capacity: reading?.ok ? reading.capacity : null,
      used: reading?.ok ? reading.used : null,
      quotaAt: reading?.at ?? null,
      quotaError: reading?.ok === false ? reading.error : null,
      lastCheckinBalance: balance?.balance ?? null,
      credits: balance?.credits ?? null,
      totalCredits: balance?.totalCredits ?? null
    }
  })

  /** Totals across a subset, so the page does not re-add them. */
  function totalsFor(rows) {
    const requests = rows.reduce((sum, row) => sum + row.requests, 0)
    const successes = rows.reduce((sum, row) => sum + row.successes, 0)
    const known = rows.filter((row) => row.balance !== null)
    const sumKnown = (field) => known.length > 0 && known.every((row) => row[field] !== null)
      ? known.reduce((sum, row) => sum + row[field], 0) : null
    return {
      accounts: rows.length,
      usable: rows.filter((row) => row.usable).length,
      requests,
      successes,
      failures: rows.reduce((sum, row) => sum + row.failures, 0),
      successRate: requests === 0 ? null : successes / requests,
      balance: sumKnown('balance'),
      capacity: sumKnown('capacity'),
      used: sumKnown('used'),
      quotaKnown: known.length,
      quotaAt: rows.reduce((at, row) => Math.max(at, row.quotaAt ?? 0), 0) || null,
      credits: rows.reduce((sum, row) => sum + (row.credits ?? 0), 0),
      totalCredits: rows.reduce((sum, row) => sum + (row.totalCredits ?? 0), 0)
    }
  }

  const bySite = {
    cn: totalsFor(accounts.filter((row) => row.site === 'cn')),
    ai: totalsFor(accounts.filter((row) => row.site === 'ai'))
  }

  // Accounts worth acting on: out of quota, or expiring within a week.
  const warnings = []
  for (const account of accounts) {
    if (account.quotaResetAt > now) {
      warnings.push({
        id: account.id,
        site: account.site,
        label: account.label,
        kind: 'quota',
        at: account.quotaResetAt,
        message: '额度已用尽，等待重置'
      })
    }
    if (account.daysToExpiry !== null && account.daysToExpiry <= 7) {
      warnings.push({
        id: account.id,
        site: account.site,
        label: account.label,
        kind: 'expiry',
        at: account.expiresAt,
        message: account.daysToExpiry <= 0 ? '登录已过期' : `还有 ${account.daysToExpiry} 天到期`
      })
    }
  }

  return {
    at: now,
    accounts,
    bySite,
    total: totalsFor(accounts),
    warnings,
    // Whether any balance has been read at all, so the page can say why a figure is
    // missing instead of showing a zero that looks like an empty account.
    balanceKnown: accounts.some((account) => account.balance !== null)
  }
}
