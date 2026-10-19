<script>
  /**
   * The overview page.
   *
   * The only page where the two regions appear together, and only as a summary:
   * counts, health, and a way into each region's own page. It deliberately offers
   * no actions — anything that changes state belongs to the region it changes.
   */
  import { fly } from 'svelte/transition'
  import { cubicOut } from 'svelte/easing'

  let { state, onOpen } = $props()

  const REGIONS = [
    { site: 'cn', title: '国内版', host: 'workbuddy.cn' },
    { site: 'ai', title: '国际版', host: 'workbuddy.ai' }
  ]

  function accountsOf(site) {
    return (state?.accounts ?? []).filter((account) => account.site === site)
  }

  function usableOf(site) {
    return accountsOf(site).filter((account) => account.usable === true).length
  }

  /** The shape of a region's health, reduced to one tone. */
  function toneOf(site) {
    const total = accountsOf(site).length
    if (total === 0) return 'idle'
    if (usableOf(site) === 0) return 'bad'
    if (usableOf(site) === 1) return 'warn'
    return 'good'
  }

  function labelOf(site) {
    const tone = toneOf(site)
    if (tone === 'idle') return '未配置'
    if (tone === 'bad') return '不可用'
    if (tone === 'warn') return '单账号'
    return '已就绪'
  }

  /** Accounts that need attention, across both regions. */
  const attention = $derived(
    (state?.accounts ?? []).filter((account) => account.usable !== true)
  )
</script>

<div class="page">
  <header class="page-head">
    <h1>概览</h1>
    <span class="sub">两个区域互不影响，也互不回退</span>
  </header>

  <div class="cards">
    {#each REGIONS as region, index (region.site)}
      <button
        class="region-card {region.site}"
        in:fly={{ y: 8, duration: 260, delay: index * 50, easing: cubicOut }}
        onclick={() => onOpen(region.site)}
      >
        <div class="rc-head">
          <span class="rc-dot {toneOf(region.site)}"></span>
          <span class="rc-title">{region.title}</span>
          <span class="rc-host">{region.host}</span>
        </div>

        <div class="rc-metric">
          <span class="rc-number">{usableOf(region.site)}</span>
          <span class="rc-total">/ {accountsOf(region.site).length}</span>
        </div>

        <div class="rc-foot">
          <span class="rc-label {toneOf(region.site)}">{labelOf(region.site)}</span>
          <span class="rc-go">打开 →</span>
        </div>
      </button>
    {/each}
  </div>

  {#if state !== null}
    <section class="summary">
      <div class="summary-row">
        <span class="summary-label">账号总数</span>
        <span class="summary-value">{state.accounts?.length ?? 0}</span>
      </div>
      <div class="summary-row">
        <span class="summary-label">需要处理</span>
        <span class="summary-value" class:attn={attention.length > 0}>
          {attention.length}
        </span>
      </div>
      <div class="summary-row">
        <span class="summary-label">模型</span>
        <span class="summary-value">{state.models?.length ?? 0} 个</span>
      </div>
    </section>

    {#if attention.length > 0}
      <section class="attention">
        <div class="attention-title">以下账号暂时不能使用</div>
        {#each attention as account (account.id)}
          <div class="attention-row">
            <span class="attention-site {account.site}">
              {account.site === 'cn' ? '国内' : '国际'}
            </span>
            <span class="attention-name">{account.label || account.id.slice(0, 8)}</span>
            <span class="attention-state">{account.statusLabel}</span>
          </div>
        {/each}
      </section>
    {/if}
  {/if}
</div>

<style>
  .page {
    display: flex;
    flex-direction: column;
    gap: 16px;
    max-width: 620px;
  }

  .page-head {
    display: flex;
    align-items: baseline;
    gap: 10px;
  }

  h1 {
    margin: 0;
    font-size: 17px;
    font-weight: 600;
    letter-spacing: -0.3px;
  }

  .sub {
    font-size: 11px;
    color: var(--ink-dim);
  }

  .cards {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }

  .region-card {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 13px 14px;
    border-radius: var(--r-lg);
    border: 1px solid var(--line);
    background: var(--bg-card);
    text-align: left;
    font: inherit;
    cursor: pointer;
    position: relative;
    overflow: hidden;
    --accent: var(--cn);
    --accent-soft: var(--cn-soft);
    transition: border-color 150ms var(--ease), transform 150ms var(--ease);
  }

  .region-card.ai {
    --accent: var(--ai);
    --accent-soft: var(--ai-soft);
  }

  .region-card::before {
    content: "";
    position: absolute;
    inset: 0 0 auto 0;
    height: 2px;
    background: linear-gradient(90deg, transparent, var(--accent), transparent);
    opacity: 0.5;
  }

  .region-card:hover {
    border-color: #313b48;
    transform: translateY(-1px);
  }

  .rc-head {
    display: flex;
    align-items: center;
    gap: 7px;
  }

  .rc-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    border: 1.4px solid var(--ink-dim);
    flex: none;
  }

  .rc-dot.good { background: var(--good); border-color: var(--good); }
  .rc-dot.warn { background: var(--warn); border-color: var(--warn); }
  .rc-dot.bad { background: none; border-color: var(--bad); }
  .rc-dot.idle { background: none; border-color: var(--ink-dim); }

  .rc-title {
    font-size: 12.5px;
    font-weight: 600;
    color: var(--ink);
  }

  .rc-host {
    font-size: 10px;
    color: var(--ink-dim);
    margin-left: auto;
  }

  .rc-metric {
    display: flex;
    align-items: baseline;
    gap: 4px;
  }

  .rc-number {
    font-size: 26px;
    font-weight: 600;
    letter-spacing: -1px;
    line-height: 1;
    color: var(--ink);
    font-variant-numeric: tabular-nums;
  }

  .rc-total {
    font-size: 12px;
    color: var(--ink-dim);
  }

  .rc-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .rc-label {
    font-size: 10.5px;
    color: var(--ink-dim);
  }

  .rc-label.good { color: var(--good); }
  .rc-label.warn { color: var(--warn); }
  .rc-label.bad { color: var(--bad); }

  .rc-go {
    font-size: 10.5px;
    color: var(--accent);
    opacity: 0;
    transition: opacity 150ms var(--ease);
  }

  .region-card:hover .rc-go {
    opacity: 1;
  }

  .summary {
    display: flex;
    gap: 1px;
    border-radius: var(--r-md);
    overflow: hidden;
    border: 1px solid var(--line-soft);
    background: var(--line-soft);
  }

  .summary-row {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 9px 12px;
    background: var(--bg-deep);
  }

  .summary-label {
    font-size: 10px;
    color: var(--ink-dim);
  }

  .summary-value {
    font-size: 14px;
    font-weight: 600;
    color: var(--ink);
    font-variant-numeric: tabular-nums;
  }

  .summary-value.attn {
    color: var(--warn);
  }

  .attention {
    padding: 11px 13px;
    border-radius: var(--r-md);
    background: var(--warn-glow);
    border: 1px solid rgba(227, 168, 58, 0.24);
  }

  .attention-title {
    font-size: 11px;
    color: var(--warn);
    margin-bottom: 6px;
  }

  .attention-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 2px 0;
    font-size: 11px;
  }

  .attention-site {
    flex: none;
    padding: 0 5px;
    border-radius: 4px;
    font-size: 10px;
    border: 1px solid var(--line);
    color: var(--ink-dim);
  }

  .attention-site.cn { color: var(--cn); border-color: rgba(76, 154, 255, 0.3); }
  .attention-site.ai { color: var(--ai); border-color: rgba(169, 112, 255, 0.3); }

  .attention-name {
    flex: 1;
    color: var(--ink-mid);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .attention-state {
    flex: none;
    color: var(--warn);
  }
</style>
