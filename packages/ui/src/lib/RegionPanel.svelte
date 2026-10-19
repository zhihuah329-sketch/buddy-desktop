<script>
  /**
   * One region's page.
   *
   * The whole page belongs to a single region: its accounts, its client, its
   * actions. Nothing here can reach into the other region, which is what keeps the
   * two pools from ever being confused for one.
   */
  import { fly } from 'svelte/transition'
  import { cubicOut } from 'svelte/easing'

  let {
    region,
    verdict,
    accounts,
    client,
    scan,
    busyKind,
    onReadDesktop,
    onScan,
    onImport,
    onRemove
  } = $props()

  /** Whether an action of this region is running. */
  function running(action) {
    return busyKind === `${action}:${region.site}`
  }

  /** Any action at all running, which disables every button. */
  function anyBusy() {
    return busyKind !== null
  }

  /** A quota window as a short human phrase. */
  function untilText(instant) {
    if (typeof instant !== 'number' || instant <= 0) return ''
    const remaining = instant - Date.now()
    if (remaining <= 0) return ''
    const minutes = Math.round(remaining / 60000)
    if (minutes < 60) return `${minutes} 分钟后重置`
    const hours = Math.round(minutes / 60)
    if (hours < 48) return `${hours} 小时后重置`
    return `${Math.round(hours / 24)} 天后重置`
  }

  function dateText(instant) {
    if (typeof instant !== 'number' || instant <= 0) return '—'
    return new Date(instant).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
  }
</script>

<div class="page">
  <header class="page-head">
    <div class="page-id">
      <h1>{region.title}</h1>
      <span class="host">{region.host}</span>
    </div>
    <div class="verdict {verdict.tone}">
      <span class="v-label">{verdict.label}</span>
      <span class="v-note">{verdict.note}</span>
    </div>
  </header>

  <!-- The client is a precondition for every action below, so it is stated first
       and never hidden behind a tooltip. -->
  <section class="block" class:warn={!client?.path}>
    <div class="block-label">客户端</div>
    <div class="block-body">
      {#if client?.path}
        <code class="path">{client.path}</code>
      {:else}
        <span class="missing">{client?.hint ?? '未检测到客户端'}</span>
      {/if}
    </div>
  </section>

  <p class="note">{region.note}</p>

  <section class="accounts">
    <div class="accounts-head">
      <span class="block-label">账号</span>
      <span class="count">{accounts.length} 个</span>
    </div>

    {#if accounts.length === 0}
      <div class="empty">
        <p>还没有{region.title}账号</p>
        <span>用下面的按钮从客户端读取或导入</span>
      </div>
    {:else}
      <ul>
        {#each accounts as account, index (account.id)}
          <li
            class="row"
            in:fly={{ y: 6, duration: 220, delay: index * 40, easing: cubicOut }}
          >
            <span class="avatar">{(account.label || account.id).slice(0, 1).toUpperCase()}</span>
            <div class="row-info">
              <span class="row-name">{account.label || account.id.slice(0, 8)}</span>
              <div class="row-meta">
                {#if account.quotaResetAt > 0}
                  <span class="meta-warn">{untilText(account.quotaResetAt)}</span>
                {:else if account.lastError}
                  <span class="meta-warn">{account.lastError}</span>
                {/if}
                <span>到期 {dateText(account.expiresAt)}</span>
                {#if account.requests > 0}
                  <span>{account.requests} 次请求</span>
                {/if}
              </div>
            </div>
            <span class="chip {account.usable ? 'good' : 'bad'}">{account.statusLabel}</span>
            <button class="row-action" disabled={anyBusy()} onclick={() => onRemove(account)}>
              移除
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <section class="actions">
    <button class="btn primary" disabled={anyBusy()} onclick={onReadDesktop}>
      {#if running('desktop')}
        <span class="spin"></span>
      {/if}
      {running('desktop') ? '读取中' : '从桌面版读取'}
    </button>
    <button class="btn" disabled={anyBusy()} onclick={onScan}>
      {running('scan') ? '扫描中' : '扫描凭据'}
    </button>
    <button class="btn" disabled={anyBusy()} onclick={onImport}>
      {running('import') ? '导入中' : '导入凭据'}
    </button>
  </section>

  {#if scan !== null}
    <section class="scan" transition:fly={{ y: -6, duration: 200, easing: cubicOut }}>
      <div class="scan-title">{scan.summary}</div>
      {#each scan.files ?? [] as file (file.path)}
        <div class="scan-item">
          <span class="scan-dot {file.importable ? 'good' : 'bad'}"></span>
          <span class="scan-name">{file.name}</span>
          <span class="scan-reason">{file.importable ? '可导入' : file.reason}</span>
        </div>
      {/each}
    </section>
  {/if}
</div>

<style>
  .page {
    display: flex;
    flex-direction: column;
    gap: 14px;
    max-width: 620px;
  }

  .page-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
  }

  .page-id {
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
  }

  .v-note {
    display: block;
    font-size: 10.5px;
    color: var(--ink-dim);
  }

  .verdict.good .v-label { color: var(--good); }
  .verdict.warn .v-label { color: var(--warn); }
  .verdict.bad .v-label { color: var(--bad); }
  .verdict.idle .v-label { color: var(--ink-dim); }

  .block {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 9px 12px;
    border-radius: var(--r-md);
    background: var(--bg-input);
    border: 1px solid var(--line-soft);
  }

  .block.warn {
    border-color: rgba(227, 168, 58, 0.26);
    background: var(--warn-glow);
  }

  .block-label {
    flex: none;
    font-size: 10.5px;
    color: var(--ink-dim);
  }

  .block-body {
    min-width: 0;
  }

  .path {
    font-size: 11.5px;
    color: var(--ink);
    word-break: break-all;
  }

  .missing {
    font-size: 11.5px;
    color: var(--warn);
    line-height: 1.45;
  }

  .note {
    margin: -4px 0 0;
    font-size: 11px;
    color: var(--ink-dim);
  }

  .accounts-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: 6px;
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
    padding: 8px 10px;
    border-radius: var(--r-md);
    transition: background 130ms var(--ease);
  }

  .row:hover {
    background: var(--bg-card);
  }

  .avatar {
    display: grid;
    place-items: center;
    width: 27px;
    height: 27px;
    flex: none;
    border-radius: 8px;
    background: var(--bg-raised);
    border: 1px solid var(--line);
    font-size: 11px;
    font-weight: 600;
    color: var(--ink-mid);
  }

  .row-info {
    flex: 1;
    min-width: 0;
  }

  .row-name {
    display: block;
    font-size: 12.5px;
    color: var(--ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    user-select: text;
  }

  .row-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 9px;
    margin-top: 1px;
    font-size: 10.5px;
    color: var(--ink-dim);
  }

  .meta-warn {
    color: var(--warn);
  }

  .chip {
    flex: none;
    padding: 2px 7px;
    border-radius: 99px;
    font-size: 10.5px;
    border: 1px solid transparent;
  }

  .chip.good { color: var(--good); border-color: rgba(69, 209, 122, 0.3); background: var(--good-glow); }
  .chip.bad { color: var(--bad); border-color: rgba(242, 86, 77, 0.3); background: var(--bad-glow); }

  /* Destructive and never the target of a stray click. */
  .row-action {
    flex: none;
    padding: 2px 7px;
    border: none;
    border-radius: 5px;
    background: none;
    color: var(--ink-dim);
    font: inherit;
    font-size: 10.5px;
    cursor: pointer;
    opacity: 0;
    transition: opacity 130ms var(--ease), color 130ms var(--ease);
  }

  .row:hover .row-action {
    opacity: 1;
  }

  .row-action:hover:not(:disabled) {
    color: var(--bad);
  }

  .row-action:disabled {
    cursor: default;
  }

  .empty {
    padding: 22px 12px;
    border-radius: var(--r-md);
    border: 1px dashed var(--line);
    text-align: center;
  }

  .empty p {
    margin: 0;
    font-size: 12px;
    color: var(--ink-mid);
  }

  .empty span {
    font-size: 11px;
    color: var(--ink-dim);
  }

  .actions {
    display: flex;
    gap: 7px;
    padding-top: 4px;
  }

  .btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 13px;
    border-radius: 7px;
    border: 1px solid var(--line);
    background: var(--bg-raised);
    color: var(--ink-mid);
    font: inherit;
    font-size: 11.5px;
    cursor: pointer;
    transition: color 130ms var(--ease), border-color 130ms var(--ease), background 130ms var(--ease);
  }

  .btn:hover:not(:disabled) {
    color: var(--ink);
    border-color: var(--line-strong);
    background: var(--bg-raised);
  }

  .btn:disabled {
    opacity: 0.45;
    cursor: default;
  }

  .btn.primary {
    color: var(--cn);
    border-color: rgba(76, 154, 255, 0.35);
    background: var(--cn-soft);
  }

  :global(.panel-wrap.ai) .btn.primary {
    color: var(--ai);
    border-color: rgba(169, 112, 255, 0.35);
    background: var(--ai-soft);
  }

  .btn.primary:hover:not(:disabled) {
    border-color: rgba(76, 154, 255, 0.6);
    background: rgba(76, 154, 255, 0.16);
    color: var(--cn);
  }

  :global(.panel-wrap.ai) .btn.primary:hover:not(:disabled) {
    border-color: rgba(169, 112, 255, 0.6);
    background: rgba(169, 112, 255, 0.16);
    color: var(--ai);
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

  .scan {
    padding: 10px 12px;
    border-radius: var(--r-md);
    background: var(--bg-input);
    border: 1px solid var(--line-soft);
  }

  .scan-title {
    font-size: 11px;
    color: var(--ink-mid);
    margin-bottom: 5px;
  }

  .scan-item {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 11px;
    color: var(--ink-dim);
    padding: 1px 0;
  }

  .scan-dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    flex: none;
  }

  .scan-dot.good { background: var(--good); }
  .scan-dot.bad { background: var(--bad); }

  .scan-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
