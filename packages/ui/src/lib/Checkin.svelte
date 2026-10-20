<script>
  /**
   * The check-in page.
   *
   * Both regions share one daily check-in, but the billing endpoint only accepts the
   * CN pool — the international one answers 401 — so this page reports what actually
   * happened per account rather than a single region-wide verdict.
   *
   * The reward is claimed exactly once per day by the server's own day guard, and the
   * scheduler claims it on its own. The button here only asks for a run now; it cannot
   * cause a second claim, so pressing it is always safe.
   */
  import { fly } from 'svelte/transition'
  import { cubicOut } from 'svelte/easing'

  let { appState, busyKind, onRun } = $props()

  const checkin = $derived(appState?.checkin ?? null)
  const busy = $derived(busyKind === 'checkin')

  /** Outcomes worded for a person, keyed by the value the server reports. */
  const OUTCOMES = {
    claimed: { label: '已领取', tone: 'good' },
    already: { label: '今日已签', tone: 'muted' },
    'not-eligible': { label: '不符合条件', tone: 'muted' },
    failed: { label: '失败', tone: 'bad' },
    skipped: { label: '已跳过', tone: 'muted' }
  }

  /** The wording and tone for one account's outcome. */
  function outcomeOf(value) {
    return OUTCOMES[value] ?? { label: value ?? '未知', tone: 'muted' }
  }

  /** Credits rendered compactly; the raw numbers are long floats. */
  function credits(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
    return value.toFixed(2)
  }
</script>

<div class="page">
  <header class="page-head">
    <div class="head-id">
      <h1>每日签到</h1>
      <span class="host">copilot.tencent.com</span>
    </div>
    <div class="verdict" class:done={checkin?.checkin?.checkedIn}>
      <span class="v-label">
        {#if checkin?.checkin?.checkedIn}今日已签到{:else if checkin?.signedIn}今日未签到{:else}等待首次检查{/if}
      </span>
      <span class="v-note">{checkin?.checkin?.date ?? '—'}</span>
    </div>
  </header>

  <p class="note">
    签到是自动的：软件启动后会自动领一次，之后每半小时检查一次，跨天后自动补领。
    下面的按钮只是立刻跑一次，不会重复领取。
    国际版的计费接口不接受这类请求，因此只有国内版账号参与。
  </p>

  {#if checkin === null}
    <div class="empty">正在读取签到状态…</div>
  {:else if checkin.signedIn !== true}
    <div class="empty">
      {checkin.error ?? '还没有可用的国内版账号，无法签到。'}
    </div>
  {:else}
    <!-- Today's totals -->
    <section class="stats">
      <div class="stat">
        <span class="stat-label">今日状态</span>
        <span class="stat-value" class:good={checkin.checkin?.checkedIn}>
          {checkin.checkin?.status ?? '—'}
        </span>
      </div>
      <div class="stat">
        <span class="stat-label">今日积分</span>
        <span class="stat-value">{checkin.checkin?.credits ?? 0}</span>
      </div>
      <div class="stat">
        <span class="stat-label">累计积分</span>
        <span class="stat-value">{checkin.checkin?.totalCredits ?? 0}</span>
      </div>
      <div class="stat">
        <span class="stat-label">参与账号</span>
        <span class="stat-value">{checkin.checkinVisited ?? 0}</span>
      </div>
    </section>

    <!-- Per account -->
    <section class="accounts">
      <div class="accounts-head">
        <span class="block-label">账号明细</span>
        <span class="count">{checkin.checkinAccounts?.length ?? 0} 个</span>
      </div>

      {#if (checkin.checkinAccounts ?? []).length === 0}
        <div class="empty">这次运行没有访问到任何账号。</div>
      {:else}
        <ul>
          {#each checkin.checkinAccounts ?? [] as account, index (account.id)}
            {@const outcome = outcomeOf(account.outcome)}
            <li
              class="row"
              in:fly={{ y: 5, duration: 200, delay: index * 40, easing: cubicOut }}
            >
              <div class="row-info">
                <span class="row-name">{account.label ?? account.id.slice(0, 8)}</span>
                <div class="row-meta">
                  {#if account.credits !== undefined}
                    <span>+{account.credits} 积分</span>
                  {/if}
                  {#if account.totalCredits !== undefined}
                    <span>累计 {account.totalCredits}</span>
                  {/if}
                  {#if account.balance !== undefined}
                    <span>余额 {credits(account.balance)}</span>
                  {/if}
                </div>
              </div>
              <span class="chip {outcome.tone}">{outcome.label}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    {#if checkin.error}
      <div class="warn">{checkin.error}</div>
    {/if}

    <section class="actions">
      <button class="btn primary" disabled={busyKind !== null || checkin.busy} onclick={onRun}>
        {#if busy}<span class="spin"></span>{/if}
        {busy ? '签到中' : '立即签到'}
      </button>
      <div class="auto">
        <span class="auto-dot" class:on={checkin.autoCheckin !== false}></span>
        <span class="auto-text">
          {#if checkin.autoCheckin === false}
            自动签到已关闭
          {:else}
            自动签到已开启
          {/if}
        </span>
      </div>
      {#if checkin.checkin?.at}
        <span class="stamp">
          上次检查 {new Date(checkin.checkin.at).toLocaleString('zh-CN', {
            month: 'numeric',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
          })}
        </span>
      {/if}
    </section>
  {/if}
</div>

<style>
  .page {
    display: flex;
    flex-direction: column;
    gap: 15px;
    max-width: 620px;
  }

  .page-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
  }

  .head-id {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }

  h1 {
    margin: 0;
    font-size: 17px;
    font-weight: 600;
    letter-spacing: -0.3px;
  }

  .host {
    font-size: 11px;
    color: var(--ink-dim);
  }

  .verdict {
    text-align: right;
    line-height: 1.35;
  }

  .v-label {
    display: block;
    font-size: 12px;
    font-weight: 600;
    color: var(--ink-dim);
  }

  .verdict.done .v-label {
    color: var(--good);
  }

  .v-note {
    display: block;
    font-size: 10.5px;
    color: var(--ink-dim);
  }

  .note {
    margin: -5px 0 0;
    font-size: 11px;
    color: var(--ink-dim);
    line-height: 1.55;
  }

  .stats {
    display: flex;
    gap: 1px;
    border-radius: var(--r-md);
    overflow: hidden;
    border: 1px solid var(--line-soft);
    background: var(--line-soft);
  }

  .stat {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 10px 12px;
    background: var(--bg-deep);
  }

  .stat-label {
    font-size: 10px;
    color: var(--ink-dim);
  }

  .stat-value {
    font-size: 15px;
    font-weight: 600;
    color: var(--ink);
    font-variant-numeric: tabular-nums;
  }

  .stat-value.good {
    color: var(--good);
  }

  .accounts-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: 6px;
  }

  .block-label {
    font-size: 10.5px;
    color: var(--ink-dim);
  }

  .count {
    font-size: 10.5px;
    color: var(--ink-dim);
  }

  .accounts ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 9px 11px;
    border-radius: var(--r-md);
    transition: background 130ms var(--ease);
  }

  .row:hover {
    background: var(--bg-card);
  }

  .row-info {
    flex: 1;
    min-width: 0;
  }

  .row-name {
    display: block;
    font-size: 12.5px;
    color: var(--ink);
    user-select: text;
  }

  .row-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin-top: 1px;
    font-size: 10.5px;
    color: var(--ink-dim);
  }

  .chip {
    flex: none;
    padding: 2px 8px;
    border-radius: 99px;
    font-size: 10.5px;
    border: 1px solid var(--line);
    color: var(--ink-dim);
  }

  .chip.good {
    color: var(--good);
    border-color: rgba(69, 209, 122, 0.3);
    background: var(--good-glow);
  }

  .chip.bad {
    color: var(--bad);
    border-color: rgba(242, 86, 77, 0.3);
    background: var(--bad-glow);
  }

  .chip.muted {
    color: var(--ink-dim);
  }

  .empty {
    padding: 24px 12px;
    border-radius: var(--r-md);
    border: 1px dashed var(--line);
    text-align: center;
    font-size: 11.5px;
    color: var(--ink-dim);
  }

  .warn {
    padding: 8px 11px;
    border-radius: var(--r-sm);
    background: var(--warn-glow);
    border: 1px solid rgba(227, 168, 58, 0.24);
    font-size: 11px;
    color: var(--warn);
    line-height: 1.5;
  }

  .actions {
    display: flex;
    align-items: center;
    gap: 12px;
    padding-top: 3px;
  }

  .btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 14px;
    border-radius: 7px;
    border: 1px solid var(--line);
    background: var(--bg-raised);
    color: var(--ink-mid);
    font: inherit;
    font-size: 11.5px;
    cursor: pointer;
    transition: color 130ms var(--ease), border-color 130ms var(--ease), background 130ms var(--ease);
  }

  .btn.primary {
    color: var(--cn);
    border-color: rgba(76, 154, 255, 0.35);
    background: var(--cn-soft);
  }

  .btn.primary:hover:not(:disabled) {
    border-color: rgba(76, 154, 255, 0.6);
    background: rgba(76, 154, 255, 0.16);
  }

  .btn:disabled {
    opacity: 0.45;
    cursor: default;
  }

  .spin {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    border: 1.5px solid currentColor;
    border-top-color: transparent;
    animation: spin 700ms linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .stamp {
    font-size: 10.5px;
    color: var(--ink-dim);
  }

  /* Sits beside the button so the automatic behaviour is visible without a click. */
  .auto {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 10.5px;
    color: var(--ink-dim);
  }

  .auto-dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--ink-dim);
    flex: none;
  }

  .auto-dot.on {
    background: var(--good);
  }
</style>
