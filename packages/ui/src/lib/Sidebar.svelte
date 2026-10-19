<script>
  /**
   * The navigation rail.
   *
   * Each destination is a page, not a section of one long page: the regions are
   * separate products and the settings have nothing to do with either, so mixing
   * them into a single scroll made the window feel like a form. The rail also
   * carries the one thing that matters at a glance — how many accounts each region
   * can serve right now.
   */
  import { fade } from 'svelte/transition'

  import { MODES, MODE_LABELS } from './theme.js'

  let {
    state,
    page,
    onSelect,
    onRefresh,
    busy,
    themeMode,
    onCycleTheme
  } = $props()

  /** The glyph for the current mode: a sun, a moon, or a monitor for "system". */
  function themeIcon(mode) {
    return mode === 'dark' ? 'moon' : mode === 'light' ? 'sun' : 'auto'
  }

  /** The pages, in the order they appear. */
  const PAGES = [
    { id: 'overview', label: '概览', icon: 'grid' },
    { id: 'usage', label: '使用额度', icon: 'chart' },
    { id: 'cn', label: '国内版', icon: 'dot', region: 'cn' },
    { id: 'ai', label: '国际版', icon: 'dot', region: 'ai' },
    { id: 'checkin', label: '每日签到', icon: 'check' },
    { id: 'command-code', label: 'Command Code', icon: 'key' },
    { id: 'access', label: '接入与密钥', icon: 'link' },
    { id: 'settings', label: '设置', icon: 'gear' }
  ]

  /** Accounts of one region. */
  function accountsOf(site) {
    return (state?.accounts ?? []).filter((account) => account.site === site)
  }

  /** How many accounts of a region can serve a request right now. */
  function usableOf(site) {
    return accountsOf(site).filter((account) => account.usable === true).length
  }

  /** The dot colour for a region, from its own shape rather than a shared average. */
  function toneOf(site) {
    const total = accountsOf(site).length
    if (total === 0) return 'idle'
    if (usableOf(site) === 0) return 'bad'
    if (usableOf(site) === 1) return 'warn'
    return 'good'
  }

  /** A page is selectable when it is not the current one. */
  function isRegion(entry) {
    return entry.region !== undefined
  }
</script>

<aside class="rail">
  <div class="rail-head">
    <div class="mark">
      <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
        <path
          d="M4 7.5 12 3l8 4.5v9L12 21l-8-4.5z"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linejoin="round" />
        <circle cx="12" cy="12" r="2.4" fill="currentColor" />
      </svg>
    </div>
    <div class="rail-title">
      <span class="name">Buddy</span>
      <span class="ver">Desktop</span>
    </div>
  </div>

  <nav class="rail-nav">
    {#each PAGES as entry (entry.id)}
      <button
        class="nav-item"
        class:active={page === entry.id}
        class:region={isRegion(entry)}
        onclick={() => onSelect(entry.id)}
      >
        <span class="nav-icon" class:cn={entry.region === 'cn'} class:ai={entry.region === 'ai'}>
          {#if entry.icon === 'grid'}
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
              <rect x="1.5" y="1.5" width="5" height="5" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.4" />
              <rect x="9.5" y="1.5" width="5" height="5" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.4" />
              <rect x="1.5" y="9.5" width="5" height="5" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.4" />
              <rect x="9.5" y="9.5" width="5" height="5" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.4" />
            </svg>
          {:else if entry.icon === 'chart'}
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
              <path
                d="M2.4 12.6V7.8M6.1 12.6V4.2M9.9 12.6V9.4M13.6 12.6V2.8"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
              />
            </svg>
          {:else if entry.icon === 'check'}
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
              <path
                d="M3.2 8.4 6.2 11.4 12.8 4.8"
                fill="none"
                stroke="currentColor"
                stroke-width="1.7"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          {:else if entry.icon === 'key'}
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
              <circle cx="5.4" cy="10.6" r="2.6" fill="none" stroke="currentColor" stroke-width="1.4" />
              <path
                d="M7.4 8.6 12.6 3.4M10.6 5.4l1.6 1.6M12.2 3.8l1.4 1.4"
                fill="none"
                stroke="currentColor"
                stroke-width="1.4"
                stroke-linecap="round"
              />
            </svg>
          {:else if entry.icon === 'link'}
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
              <path
                d="M6.6 9.4a2.6 2.6 0 0 0 3.7 0l2.1-2.1a2.6 2.6 0 0 0-3.7-3.7l-1 1"
                fill="none"
                stroke="currentColor"
                stroke-width="1.4"
                stroke-linecap="round"
              />
              <path
                d="M9.4 6.6a2.6 2.6 0 0 0-3.7 0L3.6 8.7a2.6 2.6 0 0 0 3.7 3.7l1-1"
                fill="none"
                stroke="currentColor"
                stroke-width="1.4"
                stroke-linecap="round"
              />
            </svg>
          {:else if entry.icon === 'gear'}
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
              <circle cx="8" cy="8" r="2.3" fill="none" stroke="currentColor" stroke-width="1.4" />
              <path
                d="M8 1.6v1.6M8 12.8v1.6M1.6 8h1.6M12.8 8h1.6M3.5 3.5l1.1 1.1M11.4 11.4l1.1 1.1M12.5 3.5l-1.1 1.1M4.6 11.4l-1.1 1.1"
                stroke="currentColor"
                stroke-width="1.4"
                stroke-linecap="round" />
            </svg>
          {:else}
            <span class="region-dot {toneOf(entry.region)}"></span>
          {/if}
        </span>
        <span class="nav-label">{entry.label}</span>
        {#if isRegion(entry)}
          <span class="nav-count" class:zero={usableOf(entry.region) === 0}>
            {usableOf(entry.region)}
          </span>
        {/if}
      </button>
    {/each}
  </nav>

  <div class="rail-foot">
    <button
      class="rail-action"
      onclick={onCycleTheme}
      title="切换主题（当前：{MODE_LABELS[themeMode]}）"
    >
      {#if themeIcon(themeMode) === 'sun'}
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
          <circle cx="8" cy="8" r="3.1" fill="none" stroke="currentColor" stroke-width="1.4" />
          <path
            d="M8 1.2v1.5M8 13.3v1.5M1.2 8h1.5M13.3 8h1.5M3.2 3.2l1.1 1.1M11.7 11.7l1.1 1.1M12.8 3.2l-1.1 1.1M4.3 11.7l-1.1 1.1"
            stroke="currentColor"
            stroke-width="1.3"
            stroke-linecap="round"
          />
        </svg>
      {:else if themeIcon(themeMode) === 'moon'}
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
          <path
            d="M13.2 9.6A5.6 5.6 0 0 1 6.4 2.8a5.6 5.6 0 1 0 6.8 6.8z"
            fill="none"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linejoin="round"
          />
        </svg>
      {:else}
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
          <rect
            x="1.6"
            y="2.6"
            width="12.8"
            height="8.4"
            rx="1.3"
            fill="none"
            stroke="currentColor"
            stroke-width="1.4"
          />
          <path d="M5.6 13.6h4.8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
        </svg>
      {/if}
      {MODE_LABELS[themeMode]}
    </button>

    <button class="rail-action" disabled={busy} onclick={onRefresh} title="重新读取账号状态">
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
        <path
          d="M13 8a5 5 0 1 1-1.6-3.7M13 2.4V5.6h-3.2"
          fill="none"
          stroke="currentColor"
          stroke-width="1.4"
          stroke-linecap="round"
          stroke-linejoin="round" />
      </svg>
      刷新
    </button>
    {#if state === null}
      <div class="rail-state">连接中…</div>
    {:else}
      <div class="rail-state">
        共 {state.accounts?.length ?? 0} 个账号
      </div>
    {/if}
  </div>
</aside>

<style>
  .rail {
    display: flex;
    flex-direction: column;
    width: 188px;
    flex: none;
    border-right: 1px solid var(--line);
    background: var(--bg-deep);
  }

  .rail-head {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 16px 14px 14px;
  }

  .mark {
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    border-radius: 8px;
    color: var(--ink-mid);
    background: linear-gradient(150deg, var(--mark-from), var(--mark-to));
    border: 1px solid var(--line);
  }

  .rail-title {
    display: flex;
    align-items: baseline;
    gap: 4px;
  }

  .name {
    font-size: 13px;
    font-weight: 600;
    letter-spacing: -0.2px;
  }

  .ver {
    font-size: 10px;
    color: var(--ink-dim);
  }

  .rail-nav {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 4px 8px;
    flex: 1;
  }

  .nav-item {
    display: flex;
    align-items: center;
    gap: 9px;
    width: 100%;
    padding: 7px 9px;
    border: none;
    border-radius: 7px;
    background: none;
    color: var(--ink-mid);
    font: inherit;
    font-size: 12.5px;
    text-align: left;
    cursor: pointer;
    transition: background 130ms var(--ease), color 130ms var(--ease);
  }

  .nav-item:hover {
    background: var(--bg-raised);
    color: var(--ink);
  }

  .nav-item.active {
    background: var(--bg-card);
    color: var(--ink);
    box-shadow: inset 0 0 0 1px var(--line);
  }

  .nav-icon {
    display: grid;
    place-items: center;
    width: 16px;
    height: 16px;
    flex: none;
    color: var(--ink-dim);
  }

  .nav-item.active .nav-icon {
    color: var(--ink-mid);
  }

  .region-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    border: 1.4px solid var(--ink-dim);
  }

  .region-dot.good { background: var(--good); border-color: var(--good); }
  .region-dot.warn { background: var(--warn); border-color: var(--warn); }
  .region-dot.bad { background: none; border-color: var(--bad); }
  .region-dot.idle { background: none; border-color: var(--ink-dim); }

  .nav-label {
    flex: 1;
  }

  /* The count is the rail's only live number, so it is the only thing allowed to
     carry an accent colour. */
  .nav-count {
    min-width: 17px;
    padding: 0 5px;
    border-radius: 99px;
    background: var(--bg-base);
    border: 1px solid var(--line);
    font-size: 10px;
    line-height: 15px;
    text-align: center;
    color: var(--ink-mid);
    font-variant-numeric: tabular-nums;
  }

  .nav-item.active .nav-count {
    background: var(--bg-raised);
  }

  .nav-count.zero {
    color: var(--ink-dim);
  }

  .rail-foot {
    padding: 10px 14px 14px;
    border-top: 1px solid var(--line-soft);
  }

  .rail-action {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 0;
    border: none;
    background: none;
    color: var(--ink-dim);
    font: inherit;
    font-size: 11.5px;
    cursor: pointer;
    transition: color 130ms var(--ease);
  }

  .rail-action:hover:not(:disabled) {
    color: var(--ink);
  }

  .rail-action:disabled {
    opacity: 0.45;
    cursor: default;
  }

  .rail-state {
    margin-top: 5px;
    font-size: 10.5px;
    color: var(--ink-dim);
  }
</style>
