<script>
  /**
   * The settings page.
   *
   * Holds the values a user copies somewhere else — the model endpoint and the model
   * names — plus the paths the program reads. Kept out of the region pages because
   * the endpoint is shared: one address serves both regions, and the model name
   * decides which pool is used.
   */
  let { state, onCopy } = $props()

  const models = $derived((state?.models ?? []).map((model) => ({
    model,
    region: model.endsWith('-ai') ? '国际版' : '国内版',
    site: model.endsWith('-ai') ? 'ai' : 'cn'
  })))
</script>

<div class="page">
  <header class="page-head">
    <h1>设置</h1>
    <span class="sub">接入地址与运行路径</span>
  </header>

  <section class="group">
    <div class="group-title">模型接入</div>
    <div class="group-note">
      任何 OpenAI 兼容的客户端，把地址指向这里即可。模型名的 <code>-cn</code> / <code>-ai</code>
      后缀决定走哪个号池，两个区域互不回退。
    </div>

    <div class="field">
      <span class="field-key">地址</span>
      <div class="field-value">
        <code class="url">{state?.endpoint ?? '—'}</code>
        <button class="copy" onclick={onCopy}>复制</button>
      </div>
    </div>

    {#each models as entry (entry.model)}
      <div class="field">
        <span class="field-key">{entry.region}</span>
        <div class="field-value">
          <code>{entry.model}</code>
        </div>
      </div>
    {/each}
  </section>

  <section class="group">
    <div class="group-title">路径</div>
    <div class="field">
      <span class="field-key">账号库</span>
      <div class="field-value">
        <code class="wrap">{state?.dataDir ?? '—'}</code>
      </div>
    </div>
    <div class="field">
      <span class="field-key">国内版客户端</span>
      <div class="field-value">
        {#if state?.clients?.cn?.path}
          <code class="wrap">{state.clients.cn.path}</code>
        {:else}
          <span class="missing">{state?.clients?.cn?.hint ?? '未检测到'}</span>
        {/if}
      </div>
    </div>
    <div class="field">
      <span class="field-key">国际版客户端</span>
      <div class="field-value">
        {#if state?.clients?.ai?.path}
          <code class="wrap">{state.clients.ai.path}</code>
        {:else}
          <span class="missing">{state?.clients?.ai?.hint ?? '未检测到'}</span>
        {/if}
      </div>
    </div>
  </section>

  <section class="group">
    <div class="group-title">说明</div>
    <ul class="facts">
      <li>账号来自本机 WorkBuddy 客户端的登录状态，程序不上传任何凭据。</li>
      <li>服务只监听 <code>127.0.0.1</code>，不对外网开放。</li>
      <li>关闭窗口后程序仍在托盘运行，接入地址保持可用。</li>
      <li>额度用尽时自动切换到同区域的另一个账号。</li>
    </ul>
  </section>
</div>

<style>
  .page {
    display: flex;
    flex-direction: column;
    gap: 18px;
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

  .group-title {
    font-size: 11px;
    color: var(--ink-dim);
    letter-spacing: 0.3px;
    margin-bottom: 6px;
  }

  .group-note {
    font-size: 11px;
    color: var(--ink-dim);
    line-height: 1.55;
    margin-bottom: 9px;
  }

  .group-note code {
    font-size: 10.5px;
    color: var(--ink-mid);
    background: var(--bg-input);
    padding: 0 4px;
    border-radius: 3px;
  }

  .field {
    display: flex;
    align-items: baseline;
    gap: 12px;
    padding: 7px 11px;
    border-radius: var(--r-sm);
    transition: background 130ms var(--ease);
  }

  .field:hover {
    background: var(--bg-card);
  }

  .field-key {
    flex: none;
    width: 88px;
    font-size: 10.5px;
    color: var(--ink-dim);
  }

  .field-value {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .field-value code {
    font-size: 11.5px;
    color: var(--ink);
  }

  .wrap {
    word-break: break-all;
  }

  .url {
    padding: 3px 8px;
    border-radius: var(--r-sm);
    background: var(--bg-input);
    border: 1px solid var(--line-soft);
  }

  .copy {
    flex: none;
    padding: 2px 8px;
    border-radius: 5px;
    border: 1px solid var(--line);
    background: var(--bg-raised);
    color: var(--ink-mid);
    font: inherit;
    font-size: 10.5px;
    cursor: pointer;
    transition: color 130ms var(--ease), border-color 130ms var(--ease);
  }

  .copy:hover {
    color: var(--ink);
    border-color: #333d4a;
  }

  .missing {
    font-size: 11.5px;
    color: var(--warn);
  }

  .facts {
    margin: 0;
    padding-left: 16px;
    display: flex;
    flex-direction: column;
    gap: 5px;
    font-size: 11px;
    color: var(--ink-dim);
    line-height: 1.5;
  }

  .facts code {
    font-size: 10.5px;
    color: var(--ink-mid);
  }
</style>
