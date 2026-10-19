/**
 * Usage and quota data, assembled from what the app already knows.
 *
 * ## Where these numbers come from
 *
 * Nothing here is estimated. Request counts and successes are what the pool recorded
 * while serving; expiry comes from the token's own claim; the quota window is either
 * the reset time named in an upstream refusal or zero when nothing has run out. The
 * balance is whatever the last check-in run read from the billing endpoint — absent
 * until a check-in has happened, which is why it is nullable rather than zero.
 *
 * @module @buddy-desktop/server/usage
 */

import { readVault, resolveStateDir } from '@buddy-desktop/core'

/**
 * Build the usage document.
 *
 * @param options - `state` (the status document) and `checkin` (its snapshot).
 * @returns the usage report.
 */
export function buildUsage(options = {}) {
  const state = options.state ?? {}
  const checkin = options.checkin ?? null
  const now = Date.now()

  // Balances arrive with the check-in run, keyed by the account label because that
  // is what the billing endpoint was asked about.
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
      balance: balance?.balance ?? null,
      credits: balance?.credits ?? null,
      totalCredits: balance?.totalCredits ?? null
    }
  })

  /** Totals across a subset, so the page does not re-add them. */
  function totalsFor(rows) {
    const requests = rows.reduce((sum, row) => sum + row.requests, 0)
    const successes = rows.reduce((sum, row) => sum + row.successes, 0)
    const balances = rows.map((row) => row.balance).filter((value) => typeof value === 'number')
    return {
      accounts: rows.length,
      usable: rows.filter((row) => row.usable).length,
      requests,
      successes,
      failures: rows.reduce((sum, row) => sum + row.failures, 0),
      successRate: requests === 0 ? null : successes / requests,
      balance: balances.length === 0 ? null : balances.reduce((sum, value) => sum + value, 0),
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
    if (account.quotaResetAt > 0) {
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
