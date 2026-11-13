<script>
  /**
   * Usage and quota.
   *
   * Two kinds of figure sit on this page and they come from different places:
   *
   * - Per-account request counts and status come from the pool, which records them
   *   while serving.
   * - Per-call records — which model answered, which account served it, and how many
   *   tokens passed through — come from this app's own call log.
   *
   * The upstream returns no `usage` field, so the token counts are estimated from the
   * characters of each request and reply. They are shown with 「约」 because they are
   * a count from a rule, not a reading from the service; hiding them behind a plain
   * number would claim a precision that does not exist.
   */
  import { fly } from 'svelte/transition'
  import { cubicOut } from 'svelte/easing'

  let { appState, usage, onRefresh, busy } = $props()

  const REGIONS = [
    { site: 'cn', title: '国内版' },
    { site: 'ai', title: '国际版' }
  ]

  /** Which detail view the page is showing. */
  let view = $state('accounts')

  function percent(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
    return `${Math.round(value * 100)}%`
  }

  function amount(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
    return value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
  }

  function daysText(days) {
    if (days === null) return '—'
    if (days < 0) return '已过期'
    if (days === 0) return '今天'
    return `${days} 天`
  }

  /** A timestamp as a short clock reading; the page only shows recent calls. */
  function timeText(at) {
    if (typeof at !== 'number' || at <= 0) return '—'
    return new Date(at).toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
  }

  /** Large counts as thousands, so a column stays narrow. */
  function countText(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
    if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
    return String(value)
  }

  /** Tokens with the honesty marker: these are estimated, not measured. */
  function tokensText(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
    return `约 ${countText(value)}`
  }

  function rowsOf(site) {
    return (usage?.accounts ?? []).filter((row) => row.site === site)
  }

  function barWidth(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '0%'
    return `${Math.max(2, Math.round(value * 100))}%`
  }

  /** The model name without its region suffix, which the row already implies. */
  function modelText(model) {
    if (typeof model !== 'string') return '—'
    return model.replace(/-cn$|-ai$/, '')
  }

  const activity = $derived(usage?.activity ?? null)
  const domestic = $derived(usage?.bySite?.cn)

  /** The busiest model's call count, so the bars are proportional to each other. */
  const busiest = $derived(activity?.byModel?.[0]?.calls ?? 0)
</script>

<div class="page">
  <header class="page-head">
    <div>
      <h1>WorkBuddy 额度与用量</h1>
      <span class="sub">已导入账号的积分汇总与本机 WorkBuddy 调用记录</span>
    </div>
    <button class="refresh" disabled={busy} onclick={onRefresh}>
      {busy ? '正在查询…' : '查询最新额度'}
    </button>
  </header>

  {#if usage === null}
    <div class="empty">正在读取…</div>
  {:else}
    <section class="quota">
      <div class="quota-head">
        <strong>已导入 WorkBuddy 国内账号 · 本周期积分</strong>
        <span aria-live="polite">
          {#if busy}正在查询账号额度
          {:else if domestic.quotaAt}更新于 {timeText(domestic.quotaAt)} · 已读取 {domestic.quotaKnown}/{domestic.accounts} 个账号
          {:else if domestic.accounts === 0}尚未导入国内版账号
          {:else}点击「查询最新额度」读取账号余额{/if}
        </span>
      </div>
      <div class="totals">
        <div class="total featured"><span class="total-label">剩余积分</span><span class="total-value">{amount(domestic.balance)}</span></div>
        <div class="total"><span class="total-label">本周期总额度</span><span class="total-value">{amount(domestic.capacity)}</span></div>
        <div class="total"><span class="total-label">本周期已用</span><span class="total-value">{amount(domestic.used)}</span></div>
      </div>
      {#if domestic.quotaKnown > 0 && domestic.quotaKnown < domestic.accounts}
        <div class="quota-note">当前汇总仅包含成功读取的账号。其他账号的状态见下方。</div>
      {/if}
      <div class="quota-note">余额汇总来自已导入并成功查询的 WorkBuddy 国内账号，尚未核对 CodeBuddy CLI 当前登录账号。点击「查询最新额度」会向官方查询余额，页面自动刷新仅展示最近快照。</div>
      <div class="quota-note">调用统计暂不包含 CodeBuddy CLI。0 次请求或快照余额未变，不能说明没有消耗共享积分；实际扣减以 CLI 同一账号的官方用量明细为准。</div>
    </section>

    {#if activity !== null && activity.total > 0}
      <!-- The split is what tells a user whether a call was read-heavy or write-heavy,
           which a single total cannot show. -->
      <div class="token-split">
        <span class="split-part">
          <span class="split-label">输入</span>
          <b>{tokensText(activity.tokens.prompt)}</b>
        </span>
        <span class="split-divider"></span>
        <span class="split-part">
          <span class="split-label">输出</span>
          <b>{tokensText(activity.tokens.reply)}</b>
        </span>
        <span class="split-note">WorkBuddy 调用统计 · token 按字符估算</span>
      </div>
    {/if}

    <!-- The two views answer different questions, so they are tabs rather than one
         long page: "what did I call" and "what is left". -->
    <div class="tabs">
      <button class="tab" class:active={view === 'calls'} onclick={() => (view = 'calls')}>
        调用明细
        {#if activity?.total > 0}<span class="tab-count">{activity.total}</span>{/if}
      </button>
      <button class="tab" class:active={view === 'accounts'} onclick={() => (view = 'accounts')}>
        已导入账号
      </button>
    </div>

    {#if view === 'calls'}
      {#if activity === null || activity.total === 0}
        <div class="empty">
          还没有调用记录。<br />
          <span class="empty-hint">通过 WorkBuddy 线路调用后，这里会显示对应账号、模型和估算用量。CodeBuddy CLI 调用暂不计入。</span>
        </div>
      {:else}
        <!-- Summary by model -->
        <section class="group">
          <div class="group-title">按模型</div>
          <ul class="bars">
            {#each activity.byModel as row, index (row.model)}
              <li class="bar-row" in:fly={{ y: 4, duration: 180, delay: index * 30, easing: cubicOut }}>
                <code class="bar-model">{modelText(row.model)}</code>
                <div class="bar">
                  <div class="bar-fill" class:ai={row.model.endsWith('-ai')} style="width: {barWidth(busiest === 0 ? 0 : row.calls / busiest)}"></div>
                </div>
                <span class="bar-count">{row.calls} 次</span>
                <span class="bar-tokens">{tokensText(row.promptTokens + row.replyTokens)}</span>
              </li>
            {/each}
          </ul>
        </section>

        <!-- Summary by account -->
        <section class="group">
          <div class="group-title">按账号</div>
          <ul class="bars">
            {#each activity.byAccount as row, index (row.id)}
              <li class="bar-row" in:fly={{ y: 4, duration: 180, delay: index * 30, easing: cubicOut }}>
                <span class="acct-site {row.site}">{row.site === 'ai' ? '国际' : '国内'}</span>
                <span class="acct-name">{row.label}</span>
                <span class="bar-count">{row.calls} 次</span>
                <span class="bar-tokens">{tokensText(row.promptTokens + row.replyTokens)}</span>
              </li>
            {/each}
          </ul>
        </section>

        <!-- The calls themselves, newest first -->
        <section class="group">
          <div class="group-title">
            最近调用
            <span class="group-note">显示最近 {activity.recent.length} 条</span>
          </div>
          <div class="table-head">
            <span class="col-time">时间</span>
            <span class="col-model">模型</span>
            <span class="col-acct">账号</span>
            <span class="col-num">输入</span>
            <span class="col-num">输出</span>
            <span class="col-ms">耗时</span>
          </div>
          <ul class="table">
            {#each activity.recent as call, index (call.at + '-' + index)}
              <li class="table-row" in:fly={{ y: 3, duration: 160, delay: index * 18, easing: cubicOut }}>
                <span class="col-time">{timeText(call.at)}</span>
                <span class="col-model">
                  <code>{modelText(call.model)}</code>
                  <span class="model-site {call.site}">{call.site === 'ai' ? 'AI' : 'CN'}</span>
                </span>
                <span class="col-acct">{call.accountLabel ?? (call.accountId ?? '').slice(0, 8)}</span>
                <span class="col-num">
                  {#if typeof call.promptTokens === 'number'}≈{countText(call.promptTokens)}{:else}—{/if}
                </span>
                <span class="col-num">
                  {#if typeof call.replyTokens === 'number'}
                    ≈{countText(call.replyTokens)}
                  {:else if call.streamed === true}
                    流式
                  {:else}
                    —
                  {/if}
                </span>
                <span class="col-ms">{call.elapsedMs ?? '—'}ms</span>
              </li>
            {/each}
          </ul>
          <div class="table-foot">
            token 为估算值（中文约 1 字 = 1 token，英文约 4 字符 = 1 token）。WorkBuddy 上游不返回真实 token 数，因此无法给出精确值。
          </div>
        </section>
      {/if}
    {:else}
      {#each REGIONS as region (region.site)}
        {@const summary = usage.bySite[region.site]}
        <section class="region-block {region.site}">
          <header class="region-head">
            <span class="region-name">{region.title}</span>
            <span class="region-meta">
              {summary.accounts} 个账号 · {summary.requests} 次请求 · 成功率 {percent(summary.successRate)}
            </span>
          </header>

          {#if rowsOf(region.site).length === 0}
            <div class="empty-sm">该区域还没有账号</div>
          {:else}
            <ul class="rows">
              {#each rowsOf(region.site) as row, index (row.id)}
                <li class="row" in:fly={{ y: 4, duration: 180, delay: index * 30, easing: cubicOut }}>
                  <div class="row-top">
                    <span class="row-name">{row.label}</span>
                    <span class="chip" class:good={row.usable} class:bad={!row.usable}>{row.status}</span>
                  </div>
                  <div class="bar-row-2">
                    <div class="bar">
                      <div class="bar-fill" class:low={(row.successRate ?? 1) < 0.8} style="width: {barWidth(row.successRate)}"></div>
                    </div>
                    <span class="bar-text">成功率 {percent(row.successRate)}</span>
                  </div>
                  <div class="row-stats">
                    <span>请求 <b>{row.requests}</b></span>
                    <span>成功 <b>{row.successes}</b></span>
                    <span>失败 <b class:bad-text={row.failures > 0}>{row.failures}</b></span>
                    {#if row.balance !== null}
                      <span>剩余 <b>{amount(row.balance)}</b> / 总额 <b>{amount(row.capacity)}</b> 积分</span>
                      <span>已用 <b>{amount(row.used)}</b></span>
                    {:else if row.site === 'ai'}
                      <span>国际版积分未接入</span>
                    {:else if row.lastCheckinBalance !== null}
                      <span>上次签到余额 <b>{amount(row.lastCheckinBalance)}</b> 积分</span>
                    {:else if !row.quotaError}
                      <span>积分未查询</span>
                    {/if}
                    <span>到期 <b>{daysText(row.daysToExpiry)}</b></span>
                  </div>
                  {#if row.quotaError}
                    <div class="row-warn">{row.quotaError}</div>
                  {:else if row.quotaResetAt > usage.at}
                    <div class="row-warn">额度已用尽，等待重置</div>
                  {:else if row.lastError}
                    <div class="row-warn">{row.lastError}</div>
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
        </section>
      {/each}

      {#if usage.warnings.length > 0}
        <section class="warnings">
          <div class="warn-title">需要留意</div>
          {#each usage.warnings as item (item.id + item.kind)}
            <div class="warn-row">
              <span class="warn-site {item.site}">{item.site === 'cn' ? '国内' : '国际'}</span>
              <span class="warn-name">{item.label}</span>
              <span class="warn-msg">{item.message}</span>
            </div>
          {/each}
        </section>
      {/if}
    {/if}
  {/if}
</div>

<style>
  .page {
    display: flex;
    flex-direction: column;
    gap: 14px;
    max-width: 960px;
    margin-inline: auto;
  }

  .page-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
  }

  .page-head h1 {
    margin: 0;
    font-size: 25px;
    font-weight: 600;
    letter-spacing: -0.3px;
  }

  .sub {
    display: block;
    margin-top: 2px;
    font-size: 12px;
    color: var(--ink-dim);
  }

  .refresh {
    padding: 8px 14px;
    border-radius: 7px;
    border: 1px solid color-mix(in srgb, var(--cn) 35%, var(--line));
    background: color-mix(in srgb, var(--cn) 12%, var(--bg-raised));
    color: var(--ink);
    font: inherit;
    font-size: 11.5px;
    cursor: pointer;
    transition: color 130ms var(--ease), border-color 130ms var(--ease);
  }

  .refresh:hover:not(:disabled) {
    color: var(--ink);
    border-color: var(--line-strong);
  }

  .refresh:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .quota {
    padding: clamp(12px, 2.5vw, 22px);
    border: 1px solid var(--line);
    border-radius: 16px;
    background: linear-gradient(135deg, color-mix(in srgb, var(--cn) 11%, var(--bg-card)), var(--bg-card) 62%);
  }

  .quota-head {
    display: flex;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 4px 12px;
    margin-bottom: 14px;
  }

  .quota-head span, .quota-note {
    color: var(--ink-mid);
    font-size: 12px;
  }

  .quota-note { margin-top: 12px; }

  .totals {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 135px), 1fr));
    gap: 10px;
  }

  .total {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 11px 13px;
    border: 1px solid var(--line-soft);
    border-radius: 11px;
    background: var(--bg-raised);
  }

  .total-label {
    font-size: 12px;
    color: var(--ink-dim);
    white-space: nowrap;
  }

  .total-value {
    font-size: clamp(18px, 3vw, 28px);
    font-weight: 600;
    color: var(--ink);
    font-variant-numeric: tabular-nums;
  }

  .featured .total-value {
    color: var(--cn);
  }

  .tabs {
    display: flex;
    gap: 2px;
    padding: 2px;
    border-radius: 8px;
    background: var(--bg-raised);
    border: 1px solid var(--line-soft);
  }

  .tab {
    flex: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 6px 12px;
    border: none;
    border-radius: 6px;
    background: none;
    color: var(--ink-dim);
    font: inherit;
    font-size: 11.5px;
    cursor: pointer;
    transition: background 140ms var(--ease), color 140ms var(--ease);
  }

  .tab:hover {
    color: var(--ink-mid);
  }

  .tab.active {
    background: var(--bg-card);
    color: var(--ink);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
  }

  .tab-count {
    min-width: 16px;
    padding: 0 5px;
    border-radius: 99px;
    background: var(--cn-soft);
    color: var(--cn);
    font-size: 9.5px;
    line-height: 14px;
  }

  .group-title {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin-bottom: 6px;
    font-size: 10.5px;
    color: var(--ink-dim);
  }

  .group-note {
    font-size: 9.5px;
    color: var(--ink-dim);
    opacity: 0.75;
  }

  .bars {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .bar-row {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 6px 10px;
    border-radius: var(--r-sm);
    background: var(--bg-card);
    border: 1px solid var(--line-soft);
  }

  .bar-model {
    flex: none;
    width: 132px;
    font-size: 11px;
    color: var(--ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .acct-site {
    flex: none;
    padding: 0 5px;
    border-radius: 4px;
    font-size: 9.5px;
    border: 1px solid var(--line);
    color: var(--ink-dim);
  }

  .acct-site.cn { color: var(--cn); border-color: rgba(76, 154, 255, 0.3); }
  .acct-site.ai { color: var(--ai); border-color: rgba(169, 112, 255, 0.3); }

  .acct-name {
    flex: 1;
    font-size: 11.5px;
    color: var(--ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .bar {
    flex: 1;
    min-width: 40px;
    height: 4px;
    border-radius: 99px;
    background: var(--bg-raised);
    overflow: hidden;
  }

  .bar-fill {
    height: 100%;
    border-radius: 99px;
    background: var(--cn);
    transition: width 300ms var(--ease);
  }

  .bar-fill.ai {
    background: var(--ai);
  }

  .bar-fill.low {
    background: var(--warn);
  }

  .bar-count {
    flex: none;
    font-size: 10px;
    color: var(--ink-mid);
    font-variant-numeric: tabular-nums;
  }

  .bar-tokens {
    flex: none;
    width: 74px;
    text-align: right;
    font-size: 9.5px;
    color: var(--ink-dim);
    font-variant-numeric: tabular-nums;
  }

  /* The prompt/reply split, on one line so it reads as one figure with two parts. */
  .token-split {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 12px;
    border-radius: var(--r-md);
    background: var(--bg-card);
    border: 1px solid var(--line-soft);
    font-size: 10.5px;
    color: var(--ink-dim);
  }

  .split-part {
    display: inline-flex;
    align-items: baseline;
    gap: 5px;
  }

  .split-label {
    font-size: 9.5px;
    color: var(--ink-dim);
  }

  .split-part b {
    color: var(--ink-mid);
    font-weight: 500;
    font-variant-numeric: tabular-nums;
  }

  .split-divider {
    width: 1px;
    height: 11px;
    background: var(--line-soft);
  }

  .split-note {
    margin-left: auto;
    font-size: 9.5px;
    color: var(--ink-dim);
    opacity: 0.8;
  }

  .table-head,
  .table-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 10px;
  }

  .table-head {
    font-size: 9.5px;
    color: var(--ink-dim);
    opacity: 0.85;
  }

  .table {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .table-row {
    font-size: 10.5px;
    color: var(--ink-mid);
    border-radius: var(--r-sm);
    transition: background 120ms var(--ease);
  }

  .table-row:hover {
    background: var(--bg-card);
  }

  .col-time { flex: none; width: 62px; font-variant-numeric: tabular-nums; }
  .col-model { flex: 1; display: flex; align-items: center; gap: 5px; min-width: 0; }
  .col-acct { flex: none; width: 108px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .col-num { flex: none; width: 42px; text-align: right; font-variant-numeric: tabular-nums; }
  .col-ms { flex: none; width: 50px; text-align: right; font-variant-numeric: tabular-nums; }

  .col-model code {
    font-size: 10.5px;
    color: var(--ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .model-site {
    flex: none;
    font-size: 8.5px;
    padding: 0 4px;
    border-radius: 3px;
    border: 1px solid var(--line);
  }

  .model-site.cn { color: var(--cn); border-color: rgba(76, 154, 255, 0.28); }
  .model-site.ai { color: var(--ai); border-color: rgba(169, 112, 255, 0.28); }

  .table-foot {
    margin-top: 6px;
    font-size: 9.5px;
    color: var(--ink-dim);
    line-height: 1.5;
  }

  .region-block { --accent: var(--cn); }
  .region-block.ai { --accent: var(--ai); }

  .region-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 6px;
    padding-left: 2px;
  }

  .region-name {
    font-size: 12px;
    font-weight: 600;
    color: var(--ink);
    position: relative;
    padding-left: 9px;
  }

  .region-name::before {
    content: "";
    position: absolute;
    left: 0;
    top: 50%;
    transform: translateY(-50%);
    width: 3px;
    height: 11px;
    border-radius: 2px;
    background: var(--accent);
  }

  .region-meta {
    font-size: 10.5px;
    color: var(--ink-dim);
  }

  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .row {
    padding: 10px 12px;
    border-radius: var(--r-md);
    background: var(--bg-card);
    border: 1px solid var(--line-soft);
  }

  .row-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }

  .row-name {
    font-size: 12.5px;
    color: var(--ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chip {
    flex: none;
    padding: 1px 7px;
    border-radius: 99px;
    font-size: 10px;
    border: 1px solid var(--line);
    color: var(--ink-dim);
  }

  .chip.good { color: var(--good); border-color: rgba(69, 209, 122, 0.3); background: var(--good-glow); }
  .chip.bad { color: var(--bad); border-color: rgba(242, 86, 77, 0.3); background: var(--bad-glow); }

  .bar-row-2 {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 7px 0 6px;
  }

  .bar-text {
    flex: none;
    font-size: 10px;
    color: var(--ink-dim);
    font-variant-numeric: tabular-nums;
  }

  .row-stats {
    display: flex;
    flex-wrap: wrap;
    gap: 11px;
    font-size: 10.5px;
    color: var(--ink-dim);
  }

  .row-stats b {
    color: var(--ink-mid);
    font-weight: 500;
    font-variant-numeric: tabular-nums;
  }

  .bad-text { color: var(--warn) !important; }

  .row-warn {
    margin-top: 6px;
    padding: 4px 8px;
    border-radius: 5px;
    background: var(--warn-glow);
    font-size: 10px;
    color: var(--warn);
  }

  .warnings {
    padding: 10px 12px;
    border-radius: var(--r-md);
    background: var(--warn-glow);
    border: 1px solid rgba(227, 168, 58, 0.22);
  }

  .warn-title {
    font-size: 10.5px;
    color: var(--warn);
    margin-bottom: 5px;
  }

  .warn-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 2px 0;
    font-size: 11px;
  }

  .warn-site {
    flex: none;
    padding: 0 5px;
    border-radius: 4px;
    font-size: 10px;
    border: 1px solid var(--line);
    color: var(--ink-dim);
  }

  .warn-site.cn { color: var(--cn); border-color: rgba(76, 154, 255, 0.3); }
  .warn-site.ai { color: var(--ai); border-color: rgba(169, 112, 255, 0.3); }

  .warn-name {
    flex: 1;
    color: var(--ink-mid);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .warn-msg { flex: none; color: var(--warn); }

  .empty {
    padding: 26px 14px;
    text-align: center;
    font-size: 11.5px;
    color: var(--ink-mid);
    line-height: 1.7;
    border: 1px dashed var(--line);
    border-radius: var(--r-md);
  }

  .empty-hint {
    font-size: 10.5px;
    color: var(--ink-dim);
  }

  .empty-sm {
    padding: 14px 12px;
    text-align: center;
    font-size: 11px;
    color: var(--ink-dim);
    border: 1px dashed var(--line);
    border-radius: var(--r-md);
  }
</style>
