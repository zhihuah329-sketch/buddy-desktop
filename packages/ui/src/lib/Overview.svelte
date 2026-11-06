<script>
  /**
   * The overview.
   *
   * The first thing the window shows, so it answers three questions before anything
   * else: is the service on, which regions are serving, and is anything wrong. The
   * switches live here because they are the one control a user reaches for without
   * knowing which account is which.
   *
   * The two regions appear together on this page and nowhere else, and only as a
   * summary: anything that changes state belongs to the region's own page.
   */
  import { fly } from 'svelte/transition'
  import { cubicOut } from 'svelte/easing'
  import Switch from './Switch.svelte'

  let { appState, switches, busyKey, onToggleSwitch, onOpen } = $props()

  const REGIONS = [
    { site: 'cn', title: '国内版', host: 'workbuddy.cn' },
    { site: 'ai', title: '国际版', host: 'workbuddy.ai' }
  ]

  function accountsOf(site) {
    return (appState?.accounts ?? []).filter((account) => account.site === site)
  }

  function usableOf(site) {
    return accountsOf(site).filter((account) => account.usable === true).length
  }

  /** The health of a region, reduced to one tone. */
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

  /** Accounts that cannot serve a request right now. */
  const attention = $derived((appState?.accounts ?? []).filter((account) => account.usable !== true))

  /** Total requests recorded across the pool; the only usage figure the app keeps. */
  const totalRequests = $derived(
    (appState?.accounts ?? []).reduce((sum, account) => sum + (account.requests ?? 0), 0)
  )

  /** Whether a region is effectively serving, which accounts for the master switch. */
  function serving(site) {
    return switches?.effective?.[site] === true
  }

  /** A region is on but the master is off: worth saying explicitly. */
  function blockedByMaster(site) {
    return switches?.[site] === true && switches?.master === false
  }
</script>

<div class="page">
  <header class="page-head">
    <div>
      <span class="eyebrow">BUDDY DESKTOP</span>
      <h1>服务概览</h1>
      <span class="sub">管理 WorkBuddy 转发线路与账号</span>
    </div>
    <div class="head-state" class:live={switches?.master}>
      <span class="head-dot"></span>
      {switches?.master ? '服务运行中' : '服务已停止'}
    </div>
  </header>

  <button class="quota-link" onclick={() => onOpen('usage')}>
    <span><strong>套餐额度</strong><small>查看本周期总额度、剩余积分和本机调用</small></span>
    <span aria-hidden="true">→</span>
  </button>

  <!-- The switches come first: they decide whether anything below can be used. -->
  <section class="block">
    <div class="block-head">
      <span class="block-label">服务开关</span>
      <span class="block-note">关闭后对应的调用会立即失败，不会消耗额度</span>
    </div>
    <div class="switch-list">
      <Switch
        checked={switches?.master === true}
        label="服务总开关"
        description="关闭后两个区域都不再响应模型调用"
        busy={busyKey === 'switch:master'}
        disabled={busyKey !== null && busyKey !== 'switch:master'}
        onToggle={(next) => onToggleSwitch('master', next)}
      />
      {#each REGIONS as region (region.site)}
        <Switch
          checked={switches?.[region.site] === true}
          label="{region.title}线路"
          description={blockedByMaster(region.site)
            ? '总开关已关闭，打开总开关后才会生效'
            : `${usableOf(region.site)} 个账号可服务`}
          tone={region.site}
          busy={busyKey === `switch:${region.site}`}
          disabled={busyKey !== null && busyKey !== `switch:${region.site}`}
          onToggle={(next) => onToggleSwitch(region.site, next)}
        />
      {/each}
    </div>
  </section>

  <div class="cards">
    {#each REGIONS as region, index (region.site)}
      <button
        class="region-card {region.site}"
        class:muted={!serving(region.site)}
        in:fly={{ y: 8, duration: 240, delay: index * 45, easing: cubicOut }}
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
          <span class="rc-label {toneOf(region.site)}">
            {serving(region.site) ? labelOf(region.site) : '已暂停'}
          </span>
          <span class="rc-go">打开 →</span>
        </div>
      </button>
    {/each}
  </div>

  {#if appState !== null}
    <section class="summary">
      <div class="summary-row">
        <span class="summary-label">账号总数</span>
        <span class="summary-value">{appState.accounts?.length ?? 0}</span>
      </div>
      <div class="summary-row">
        <span class="summary-label">需要处理</span>
        <span class="summary-value" class:attn={attention.length > 0}>{attention.length}</span>
      </div>
      <div class="summary-row">
        <span class="summary-label">累计请求</span>
        <span class="summary-value">{totalRequests}</span>
      </div>
      <div class="summary-row">
        <span class="summary-label">签到</span>
        <span class="summary-value sm">{appState.checkin?.checkin?.status ?? '—'}</span>
      </div>
    </section>

    <!-- The upstream's anti-proxy check is not an account problem, so it is stated
         above the account list rather than inside it: every account is fine, and the
         user needs to know that before they start replacing them. -->
    {#if appState.antiProxy?.open === true || (appState.antiProxy?.consecutive ?? 0) > 0}
      <section class="anti-proxy">
        <div class="anti-title">
          {appState.antiProxy?.open === true
            ? 'WorkBuddy 上游正在拒绝本程序的请求'
            : `上游已拒绝 ${appState.antiProxy?.consecutive} 次`}
        </div>
        <div class="anti-body">
          {appState.antiProxy?.hint ?? '上游已开启反代理检测。'}
        </div>
        <div class="anti-note">
          账号没有被停用，额度也没有消耗；换账号解决不了这个问题。
          {#if appState.antiProxy?.open === true}
            程序会在约 1 分钟后自动重试。
          {/if}
        </div>
      </section>
    {/if}

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
    {:else if (appState.accounts?.length ?? 0) > 0}
      <section class="all-good">
        <span class="good-dot"></span>
        全部 {appState.accounts.length} 个账号均可正常服务
      </section>
    {/if}

    <!-- The endpoint, repeated from settings because it is the value a user copies
         most often and this is the page they land on. -->
    <section class="endpoint-strip">
      <span class="strip-label">接入地址</span>
      <code class="strip-url">{appState.endpoint}</code>
    </section>
  {/if}
</div>

<style>
  .page {
    display: flex;
    flex-direction: column;
    gap: 15px;
    max-width: 920px;
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
    font-size: 26px;
    font-weight: 600;
    letter-spacing: -0.3px;
  }

  .sub {
    display: block;
    margin-top: 2px;
    font-size: 11px;
    color: var(--ink-dim);
  }

  .eyebrow { color: var(--cn); font-size: 10px; font-weight: 650; letter-spacing: .15em; }
  .quota-link {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 16px;
    padding: 13px 16px;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: color-mix(in srgb, var(--cn) 8%, var(--bg-card));
    color: var(--ink);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .quota-link:hover { border-color: var(--cn); }
  .quota-link small { display: block; color: var(--ink-mid); margin-top: 3px; }

  .head-state {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 10px;
    border-radius: 99px;
    border: 1px solid var(--line);
    font-size: 10.5px;
    color: var(--ink-dim);
  }

  .head-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--ink-dim);
  }

  .head-appState.live {
    color: var(--good);
    border-color: rgba(69, 209, 122, 0.3);
    background: var(--good-glow);
  }

  .head-appState.live .head-dot {
    background: var(--good);
  }

  .block-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 7px;
  }

  .block-label {
    font-size: 11px;
    color: var(--ink-mid);
    letter-spacing: 0.2px;
  }

  .block-note {
    font-size: 10px;
    color: var(--ink-dim);
    text-align: right;
  }

  .switch-list {
    display: flex;
    flex-direction: column;
    gap: 5px;
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
    padding: 12px 13px;
    border-radius: var(--r-lg);
    border: 1px solid var(--line);
    background: var(--bg-card);
    text-align: left;
    font: inherit;
    cursor: pointer;
    position: relative;
    overflow: hidden;
    --accent: var(--cn);
    transition: border-color 150ms var(--ease), transform 150ms var(--ease), opacity 150ms var(--ease);
  }

  .region-card.ai {
    --accent: var(--ai);
  }

  .region-card::before {
    content: "";
    position: absolute;
    inset: 0 0 auto 0;
    height: 2px;
    background: linear-gradient(90deg, transparent, var(--accent), transparent);
    opacity: 0.45;
  }

  .region-card:hover {
    border-color: var(--line-strong);
    transform: translateY(-1px);
  }

  /* A paused region keeps its layout but loses its colour: the account count is
     still true, the availability is not. */
  .region-card.muted {
    opacity: 0.55;
  }

  .rc-head {
    display: flex;
    align-items: center;
    gap: 7px;
  }

  .rc-dot {
    width: 7px;
    height: 7px;
    flex: none;
    border-radius: 50%;
    border: 1.4px solid var(--ink-dim);
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
    margin-left: auto;
    font-size: 10px;
    color: var(--ink-dim);
  }

  .rc-metric {
    display: flex;
    align-items: baseline;
    gap: 4px;
  }

  .rc-number {
    font-size: 25px;
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
    padding: 9px 11px;
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

  .summary-value.sm {
    font-size: 11.5px;
    font-weight: 500;
  }

  .summary-value.attn {
    color: var(--warn);
  }

  /* Stated as a warning, not as an error: nothing the user owns is broken. */
  .anti-proxy {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 10px 12px;
    border-radius: var(--r-md);
    background: var(--bad-glow);
    border: 1px solid rgba(242, 86, 77, 0.28);
  }

  .anti-title {
    font-size: 12px;
    font-weight: 600;
    color: var(--bad);
  }

  .anti-body {
    font-size: 11px;
    color: var(--ink-mid);
    line-height: 1.55;
  }

  .anti-note {
    font-size: 10.5px;
    color: var(--ink-dim);
    line-height: 1.5;
  }

  .attention {
    padding: 10px 12px;
    border-radius: var(--r-md);
    background: var(--warn-glow);
    border: 1px solid rgba(227, 168, 58, 0.22);
  }

  .attention-title {
    font-size: 10.5px;
    color: var(--warn);
    margin-bottom: 5px;
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

  .all-good {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 9px 12px;
    border-radius: var(--r-md);
    background: var(--good-glow);
    border: 1px solid rgba(69, 209, 122, 0.2);
    font-size: 11px;
    color: var(--good);
  }

  .good-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--good);
  }

  .endpoint-strip {
    display: flex;
    align-items: baseline;
    gap: 9px;
    padding: 9px 12px;
    border-radius: var(--r-md);
    background: var(--bg-input);
    border: 1px solid var(--line-soft);
  }

  .strip-label {
    flex: none;
    font-size: 10.5px;
    color: var(--ink-dim);
  }

  .strip-url {
    font-size: 11.5px;
    color: var(--ink);
    word-break: break-all;
  }
</style>
