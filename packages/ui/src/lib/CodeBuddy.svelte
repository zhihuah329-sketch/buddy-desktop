<script>
  let { appState, onTest, onInstall } = $props()
  const route = $derived(appState?.codeBuddy)
  let testing = $state(false)
  let result = $state(null)
  let installing = $state(false)
  let installResult = $state(null)
  const managedLogin = 'node "$env:LOCALAPPDATA\\BuddyDesktop\\codebuddy\\node_modules\\@tencent-ai\\codebuddy-code\\bin\\codebuddy"'

  async function install() {
    installing = true
    installResult = null
    try { installResult = await onInstall() }
    catch (error) { installResult = { ok: false, error: error.message } }
    finally { installing = false }
  }

  async function test() {
    testing = true
    result = null
    try { result = await onTest() }
    catch (error) { result = { ok: false, error: error.message } }
    finally { testing = false }
  }
</script>

<div class="page">
  <header>
    <span class="eyebrow">CODEBUDDY CODE</span>
    <h1>CodeBuddy 国内站</h1>
    <p>使用官方 CLI 登录后，即可在 DSH 中调用 DeepSeek V4.1 Flash。无需安装或导入 WorkBuddy。</p>
  </header>
  <section>
    <h2>安装与登录</h2>
    <ol>
      <li>安装 Node.js 后，点击「安装 CodeBuddy」。已安装官方 CLI 的用户可以直接登录。</li>
      <li>在 PowerShell 运行 <code>{route?.managed ? managedLogin : 'codebuddy'}</code>，选择 <strong>Log in via Chinese Site</strong>，在浏览器完成登录。</li>
      <li>回到这里刷新状态，再点「测试线路」。测试会发出一次短模型请求。</li>
    </ol>
    <p class:good={route?.installed} aria-live="polite">{route?.installed ? '已检测到 CodeBuddy Code，登录状态请以线路测试为准。' : route?.error ?? '正在检测本机 CLI…'}</p>
    {#if !route?.installed}
      <button disabled={installing || !route} onclick={install}>{installing ? '正在安装…' : '安装 CodeBuddy'}</button>
    {/if}
    {#if installResult}<p aria-live="polite" class:good={installResult.ok}>{installResult.ok ? '安装完成。请按上面的步骤登录。' : installResult.error}</p>{/if}
    <button disabled={testing || !route?.installed} onclick={test}>{testing ? '正在测试…' : '测试线路'}</button>
    {#if result}<p aria-live="polite" class:good={result.ok}>{result.ok ? '连接成功，模型已返回回复。' : result.error}</p>{/if}
  </section>
  <section>
    <h2>在 DSH 添加自定义模型</h2>
    <dl>
      <dt>协议</dt><dd>OpenAI Chat Completions</dd>
      <dt>Base URL</dt><dd><code>{appState?.endpoint ?? 'http://127.0.0.1:5178/v1'}</code></dd>
      <dt>模型 ID</dt><dd><code>deepseek-v4.1-flash-codebuddy-cn</code></dd>
      <dt>输入与上下文</dt><dd>文本、图片 · 8192 tokens</dd>
    </dl>
    <p>需要访问密钥时，在「接入与密钥」创建包含 WorkBuddy 权限的密钥。</p>
    <p>DSH 提供 <code>read</code> 工具时，可以按工作区权限读取文本文件。命令执行和修改文件不经这条线路转发。</p>
  </section>
</div>

<style>
  .page { display: grid; gap: 14px; max-width: 880px; margin-inline: auto; }
  h1 { font-size: 26px; margin: 0; }
  h2 { font-size: 15px; margin: 0; }
  .eyebrow { color: var(--cn); font-size: 10px; font-weight: 700; letter-spacing: .14em; }
  p, li, dt { color: var(--ink-mid); }
  p { margin: 8px 0; }
  section { padding: 16px; border: 1px solid var(--line); border-radius: 12px; background: var(--bg-card); }
  ol { padding-inline-start: 20px; }
  li + li { margin-top: 7px; }
  code { overflow-wrap: anywhere; color: var(--ink); }
  button { font: inherit; padding: 7px 12px; border: 1px solid var(--line); border-radius: 7px; background: var(--bg-raised); color: var(--ink); cursor: pointer; }
  button:disabled { opacity: .55; cursor: default; }
  .good { color: var(--good); }
  dl { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 6px 14px; }
  dd { margin: 0; }
</style>
