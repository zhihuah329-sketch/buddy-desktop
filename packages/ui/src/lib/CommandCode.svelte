<script>
  /**
   * The Command Code page.
   *
   * Command Code is the second model channel: it authenticates with its own API key
   * instead of a desktop login, and offers a different catalogue (Claude, GPT,
   * DeepSeek, Kimi, GLM) from the two WorkBuddy regions. It therefore gets its own
   * page rather than being folded into either region — it is neither.
   */
  import { fly } from 'svelte/transition'
  import { cubicOut } from 'svelte/easing'

  let { appState, busyKind, onSaveKey, onClearKey, onTest } = $props()

  /** What the user is typing; never read back from the server. */
  let draft = $state('')
  /** The most recent test outcome. */
  let testResult = $state(null)
  /** Whether the clear action is waiting for confirmation. */
  let confirmingClear = $state(false)

  const cc = $derived(appState?.commandCode ?? null)

  function running(action) {
    return busyKind === `cc:${action}`
  }

  async function save() {
    if (draft.trim().length === 0) return
    const saved = await onSaveKey(draft.trim())
    if (saved === true) draft = ''
  }

  async function test() {
    testResult = await onTest()
  }

  async function clear() {
    if (!confirmingClear) {
      confirmingClear = true
      setTimeout(() => {
        confirmingClear = false
      }, 4000)
      return
    }
    confirmingClear = false
    await onClearKey()
  }
</script>

<div class="page">
  <header class="page-head">
    <div class="head-id">
      <h1>Command Code</h1>
      <span class="host">api.commandcode.ai</span>
    </div>
    <div class="verdict" class:on={cc?.configured}>
      <span class="v-label">{cc?.configured ? '已配置' : '未配置'}</span>
      <span class="v-note">{cc?.configured ? 'API Key 已保存' : '需要填写 API Key'}</span>
    </div>
  </header>

  <p class="note">
    与两个 WorkBuddy 区域不同，这一路途使用独立的 API Key 直连，不依赖桌面客户端登录。
  </p>

  <!-- Credential -->
  <section class="block">
    <div class="block-head">
      <span class="block-label">API Key</span>
      {#if cc?.configured}
        <code class="masked">{cc.masked}</code>
      {/if}
    </div>

    {#if cc?.configured}
      <div class="actions">
        <button class="btn primary" disabled={busyKind !== null} onclick={test}>
          {#if running('test')}<span class="spin"></span>{/if}
          {running('test') ? '测试中' : '测试连接'}
        </button>
        <button class="btn danger" disabled={busyKind !== null} onclick={clear}>
          {confirmingClear ? '再次点击确认清除' : '清除 Key'}
        </button>
      </div>

      {#if testResult !== null}
        <div class="test-result" class:good={testResult.ok} class:bad={!testResult.ok}>
          {#if testResult.ok}
            连接正常
            {#if testResult.latencyMs}· {testResult.latencyMs}ms{/if}
            {#if testResult.models}· {testResult.models.length} 个模型{/if}
          {:else}
            {testResult.message ?? '连接失败'}
          {/if}
        </div>
      {/if}
    {:else}
      <div class="field-row">
        <input
          class="input"
          type="password"
          placeholder="user_…"
          bind:value={draft}
          onkeydown={(event) => {
            if (event.key === 'Enter') save()
          }}
        />
        <button class="btn primary" disabled={busyKind !== null || draft.trim().length === 0} onclick={save}>
          {running('save') ? '保存中' : '保存'}
        </button>
      </div>
      <div class="field-hint">Key 以 user_ 开头，保存在本机用户目录，不会上传。</div>
    {/if}
  </section>

  <!-- Model catalogue -->
  <section class="models-block">
    <div class="models-head">
      <span class="block-label">可用模型</span>
      <span class="count">{cc?.models?.length ?? 0} 个</span>
    </div>
    <ul class="models">
      {#each cc?.models ?? [] as model, index (model.id)}
        <li class="model" in:fly={{ y: 5, duration: 200, delay: index * 25, easing: cubicOut }}>
          <code class="model-id">{model.id}</code>
          <span class="model-name">{model.name}</span>
          {#if model.id === cc?.defaultModel}
            <span class="model-default">默认</span>
          {/if}
        </li>
      {/each}
    </ul>
  </section>
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

  .verdict.on .v-label {
    color: var(--good);
  }

  .v-note {
    display: block;
    font-size: 10.5px;
    color: var(--ink-dim);
  }

  .note {
    margin: -4px 0 0;
    font-size: 11px;
    color: var(--ink-dim);
    line-height: 1.55;
  }

  .block {
    padding: 12px 13px;
    border-radius: var(--r-md);
    background: var(--bg-card);
    border: 1px solid var(--line);
  }

  .block-head {
    display: flex;
    align-items: baseline;
    gap: 10px;
    margin-bottom: 9px;
  }

  .block-label {
    font-size: 10.5px;
    color: var(--ink-dim);
  }

  .masked {
    font-size: 11.5px;
    color: var(--ink-mid);
    background: var(--bg-input);
    padding: 1px 7px;
    border-radius: 4px;
    border: 1px solid var(--line-soft);
  }

  .field-row {
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
    font-size: 12px;
    outline: none;
    transition: border-color 130ms var(--ease);
  }

  .input:focus {
    border-color: var(--cn);
  }

  .input::placeholder {
    color: var(--ink-dim);
  }

  .field-hint {
    margin-top: 6px;
    font-size: 10.5px;
    color: var(--ink-dim);
  }

  .actions {
    display: flex;
    gap: 7px;
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
    border-color: #333d4a;
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

  .btn.primary:hover:not(:disabled) {
    border-color: rgba(76, 154, 255, 0.6);
    background: rgba(76, 154, 255, 0.16);
  }

  /* Clearing a credential cannot be undone by the app, so it stays visually quiet
     until a second click confirms. */
  .btn.danger {
    color: var(--ink-dim);
  }

  .btn.danger:hover:not(:disabled) {
    color: var(--bad);
    border-color: rgba(242, 86, 77, 0.4);
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

  .test-result {
    margin-top: 9px;
    padding: 7px 10px;
    border-radius: var(--r-sm);
    font-size: 11px;
    line-height: 1.5;
    word-break: break-word;
  }

  .test-result.good {
    color: var(--good);
    background: var(--good-glow);
    border: 1px solid rgba(69, 209, 122, 0.26);
  }

  .test-result.bad {
    color: var(--warn);
    background: var(--warn-glow);
    border: 1px solid rgba(227, 168, 58, 0.26);
  }

  .models-block {
    padding-top: 2px;
  }

  .models-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: 6px;
  }

  .count {
    font-size: 10.5px;
    color: var(--ink-dim);
  }

  .models {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .model {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 6px 10px;
    border-radius: var(--r-sm);
    transition: background 130ms var(--ease);
  }

  .model:hover {
    background: var(--bg-card);
  }

  .model-id {
    flex: none;
    width: 200px;
    font-size: 11px;
    color: var(--ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .model-name {
    flex: 1;
    font-size: 11px;
    color: var(--ink-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .model-default {
    flex: none;
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 9.5px;
    color: var(--cn);
    border: 1px solid rgba(76, 154, 255, 0.3);
  }
</style>
