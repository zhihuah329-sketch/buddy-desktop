<script>
  /**
   * Access keys.
   *
   * One thing answers "how do I use this from somewhere else": a key lets another
   * tool call the endpoint.
   *
   * The key is shown once, in a box the user copies before dismissing. Keeping a
   * readable copy would mean storing the secret, which is exactly what hashing
   * avoids.
   */
  import { fly } from 'svelte/transition'
  import { cubicOut } from 'svelte/easing'

  let {
    appState,
    keys,
    keyBusy,
    onCreateKey,
    onUpdateKey
  } = $props()

  /** A label being typed for a new key. */
  let draftLabel = $state('')

  /**
   * Which upstream the new key may reach.
   *
   * The options are listed as data rather than written out in the template: Svelte
   * drops a `value` attribute whose value is a constant, which would leave the
   * select's bound value holding the displayed text instead of the scope name.
   */
  const SCOPES = [
    { value: 'all', label: '两条线路' },
    { value: 'workbuddy', label: '仅 WorkBuddy' },
    { value: 'command-code', label: '仅 Command Code' }
  ]
  let draftScope = $state('all')
  /** The freshly created key, shown once until dismissed. */
  let freshKey = $state(null)
  /** Whether the fresh key has been copied, so the box can say so. */
  let copied = $state(false)

  /** A short clock reading, for the key list. */
  function timeText(at) {
    if (typeof at !== 'number' || at <= 0) return '从未'
    return new Date(at).toLocaleString('zh-CN', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
  }

  async function create() {
    const key = await onCreateKey(draftLabel.trim(), draftScope)
    if (typeof key === 'string') {
      freshKey = key
      copied = false
      draftLabel = ''
    }
  }

  async function copyFresh() {
    if (freshKey === null) return
    try {
      await navigator.clipboard.writeText(freshKey)
      copied = true
    } catch {
      copied = false
    }
  }
</script>

<div class="page">
  <header class="page-head">
    <div>
      <h1>接入与密钥</h1>
      <span class="sub">在这里生成密钥，填到其它工具里使用</span>
    </div>
  </header>

  <!-- Access keys -->
  <section class="block">
    <div class="block-head">
      <span class="block-label">访问密钥</span>
      <span class="block-note">
        {#if keys.length === 0}未启用{:else}{keys.length} 个{/if}
      </span>
    </div>

    {#if keys.length === 0}
      <div class="muted">
        当前接口没有密钥，本机任何程序都能调用。创建一个密钥后，调用必须带上它。
      </div>
    {/if}

    <!-- Shown once, then gone. -->
    {#if freshKey !== null}
      <div class="fresh" transition:fly={{ y: -6, duration: 200, easing: cubicOut }}>
        <div class="fresh-title">密钥已创建，只显示这一次</div>
        <div class="fresh-row">
          <code class="fresh-key">{freshKey}</code>
          <button class="mini" onclick={copyFresh}>{copied ? '已复制' : '复制'}</button>
        </div>
        <div class="fresh-hint">关掉后无法再次查看，请现在复制保存。</div>
        <button class="mini dim" onclick={() => (freshKey = null)}>我已保存，关闭</button>
      </div>
    {/if}

    {#if keys.length > 0}
      <ul class="key-list">
        {#each keys as key, index (key.id)}
          <li class="key-row" class:off={key.enabled === false} in:fly={{ y: 4, duration: 180, delay: index * 30, easing: cubicOut }}>
            <div class="key-main">
              <code class="key-hint">{key.hint}…</code>
              <span class="key-label">{key.label}</span>
            </div>
            <div class="key-meta">
              <span>创建 {timeText(key.createdAt)}</span>
              <span>使用 {timeText(key.lastUsedAt)}</span>
            </div>
            <button
              class="mini"
              disabled={keyBusy}
              onclick={() => onUpdateKey(key.id, { enabled: key.enabled === false })}
            >
              {key.enabled === false ? '启用' : '停用'}
            </button>
            <button class="mini danger" disabled={keyBusy} onclick={() => onUpdateKey(key.id, { remove: true })}>
              删除
            </button>
          </li>
        {/each}
      </ul>
    {/if}

    <div class="create-row">
      <select class="input scope-pick" bind:value={draftScope}>
        {#each SCOPES as scope (scope.value)}
          <option value={scope.value}>{scope.label}</option>
        {/each}
      </select>
      <input
        class="input"
        placeholder="密钥名称（可选）"
        bind:value={draftLabel}
        onkeydown={(event) => {
          if (event.key === 'Enter') create()
        }}
      />
      <button class="btn primary" disabled={keyBusy} onclick={create}>创建密钥</button>
    </div>

    {#if appState?.endpoint}
      <div class="usage-hint">
        在其它工具里这样填，两条线路各用一个地址，互不干扰：<br />
        <br />
        <strong>WorkBuddy</strong>（deepseek 两个号池）<br />
        地址 <code>{appState.endpoint}</code><br />
        <br />
        <strong>Command Code</strong>（Claude / GPT 等 15 个模型）<br />
        地址 <code>{appState.endpoint.replace(/\/v1$/, '/v1/cc')}</code><br />
        <br />
        两边的密钥都填上面生成的 <code>sk-…</code>。创建时选「限定来源」，这一把密钥就只能走对应的线路。
      </div>
    {/if}
  </section>
</div>

<style>
  .scope-pick {
    flex: 0 0 132px;
    padding-right: 6px;
  }

  .page {
    display: flex;
    flex-direction: column;
    gap: 16px;
    max-width: 640px;
  }

  .page-head h1 {
    margin: 0;
    font-size: 17px;
    font-weight: 600;
    letter-spacing: -0.3px;
  }

  .sub {
    display: block;
    margin-top: 2px;
    font-size: 11px;
    color: var(--ink-dim);
  }

  .block {
    padding: 13px 14px;
    border-radius: var(--r-lg);
    background: var(--bg-card);
    border: 1px solid var(--line);
  }

  .block-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 9px;
  }

  .block-label {
    font-size: 11.5px;
    font-weight: 600;
    color: var(--ink-mid);
  }

  .block-note {
    font-size: 10px;
    color: var(--ink-dim);
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

  .mini {
    flex: none;
    padding: 2px 8px;
    border-radius: 5px;
    border: 1px solid var(--line);
    background: var(--bg-raised);
    color: var(--ink-mid);
    font: inherit;
    font-size: 10px;
    cursor: pointer;
    transition: color 130ms var(--ease), border-color 130ms var(--ease);
  }

  .mini:hover:not(:disabled) {
    color: var(--ink);
    border-color: var(--line-strong);
  }

  .mini:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .mini.danger:hover:not(:disabled) {
    color: var(--bad);
    border-color: rgba(242, 86, 77, 0.4);
  }

  .mini.dim {
    color: var(--ink-dim);
    margin-top: 6px;
  }

  .muted {
    padding: 8px 10px;
    border-radius: var(--r-sm);
    background: var(--bg-input);
    border: 1px solid var(--line-soft);
    font-size: 10.5px;
    color: var(--ink-dim);
    line-height: 1.55;
    margin-bottom: 9px;
  }

  .fresh {
    padding: 11px 12px;
    border-radius: var(--r-md);
    background: var(--cn-soft);
    border: 1px solid rgba(76, 154, 255, 0.3);
    margin-bottom: 10px;
  }

  .fresh-title {
    font-size: 11px;
    color: var(--cn);
    margin-bottom: 6px;
  }

  .fresh-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .fresh-key {
    flex: 1;
    padding: 5px 9px;
    border-radius: var(--r-sm);
    background: var(--bg-input);
    border: 1px solid var(--line-soft);
    font-size: 11px;
    color: var(--ink);
    word-break: break-all;
    user-select: all;
  }

  .fresh-hint {
    margin-top: 5px;
    font-size: 9.5px;
    color: var(--ink-dim);
  }

  .key-list {
    list-style: none;
    margin: 0 0 9px;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .key-row {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 7px 10px;
    border-radius: var(--r-sm);
    background: var(--bg-input);
    border: 1px solid var(--line-soft);
  }

  /* A disabled key is dimmed but kept: deleting is a separate decision. */
  .key-row.off {
    opacity: 0.5;
  }

  .key-main {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
    flex: 1;
  }

  .key-hint {
    font-size: 10.5px;
    color: var(--ink);
  }

  .key-label {
    font-size: 10.5px;
    color: var(--ink-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .key-meta {
    display: flex;
    gap: 10px;
    flex: none;
    font-size: 9.5px;
    color: var(--ink-dim);
  }

  .create-row {
    display: flex;
    gap: 7px;
  }

  .input {
    flex: 1;
    padding: 6px 10px;
    border-radius: var(--r-sm);
    border: 1px solid var(--line);
    background: var(--bg-input);
    color: var(--ink);
    font: inherit;
    font-size: 11.5px;
    outline: none;
    transition: border-color 130ms var(--ease);
  }

  .input:focus {
    border-color: var(--cn);
  }

  .input::placeholder {
    color: var(--ink-dim);
  }

  .usage-hint {
    margin-top: 9px;
    font-size: 10px;
    color: var(--ink-dim);
    line-height: 1.7;
  }

  .usage-hint code {
    font-size: 10px;
    color: var(--ink-mid);
    background: var(--bg-input);
    padding: 1px 5px;
    border-radius: 3px;
  }

</style>
