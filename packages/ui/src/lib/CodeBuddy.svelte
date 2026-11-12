<script>
  let { appState, onTest, onInstall } = $props()
  const route = $derived(appState?.codeBuddy)
  const installingNow = $derived(installing || route?.installation?.phase === 'installing')
  const effortLabels = { minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高', enabled: '模型默认', disabled: '关闭', unknown: '未确认' }
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
      <li>打开软件时会自动检测 CodeBuddy，缺少时自动运行 <code>npm install -g @tencent-ai/codebuddy-code</code>。首次安装需要 Node.js 和网络。</li>
      <li>在 PowerShell 运行 <code>{route?.managed ? managedLogin : 'codebuddy'}</code>，选择 <strong>Log in via Chinese Site</strong>，在浏览器完成登录。</li>
      <li>回到这里刷新状态，再点「测试线路」。测试会发出一次短模型请求。</li>
    </ol>
    <p class:good={route?.installed} aria-live="polite">{installingNow ? '正在全局安装官方 CLI，请稍候…' : route?.installed ? `已检测到 CodeBuddy Code${route.version ? ' ' + route.version : ''}，登录状态请以线路测试为准。` : route?.error ?? '正在检测本机 CLI…'}</p>
    {#if !route?.installed}
      <button disabled={installingNow || !route} onclick={install}>{installingNow ? '正在安装…' : '重试安装 CodeBuddy'}</button>
    {/if}
    {#if installResult}<p aria-live="polite" class:good={installResult.ok}>{installResult.ok ? '安装完成。请按上面的步骤登录。' : installResult.error}</p>{/if}
    <button disabled={testing || installingNow || !route?.installed} onclick={test}>{testing ? '正在测试…' : '测试线路'}</button>
    {#if result}<p aria-live="polite" class:good={result.ok}>{result.ok ? '连接成功，模型已返回回复。' : result.error}</p>{/if}
    {#if route?.lastRequest}
      <dl>
        <dt>最近请求的模型</dt><dd><code>{route.lastRequest.actualModel ?? route.lastRequest.model}</code></dd>
        <dt>请求的推理强度</dt><dd>{effortLabels[route.lastRequest.requestedEffort] ?? route.lastRequest.requestedEffort}</dd>
        <dt>客户端确认的强度</dt><dd>{effortLabels[route.lastRequest.effectiveEffort] ?? route.lastRequest.effectiveEffort}</dd>
        <dt>模型支持的档位</dt><dd>{route.lastRequest.supportedEfforts.map(value => effortLabels[value] ?? value).join('、') || '未确认'}</dd>
      </dl>
      {#if route.lastRequest.failure}<p role="status">最近请求失败：{route.lastRequest.failure.message} <code>{route.lastRequest.failure.code}</code></p>{/if}
    {/if}
  </section>
  <section>
    <h2>在 DSH 添加自定义模型</h2>
    <dl>
      <dt>协议</dt><dd>OpenAI Chat Completions</dd>
      <dt>Base URL</dt><dd><code>{appState?.endpoint ?? 'http://127.0.0.1:5178/v1'}</code></dd>
      <dt>模型 ID</dt><dd><code>deepseek-v4.1-flash-codebuddy-cn</code></dd>
      <dt>输入</dt><dd>文本、图片</dd>
      <dt>桥接输入限制</dt><dd>对话和工具定义合计 400 万字符；模型 token 限制由上游校验</dd>
    </dl>
    <p>需要访问密钥时，在「接入与密钥」创建包含 WorkBuddy 权限的密钥。</p>
    <p>支持 DSH 提供的文件、搜索和命令等工具。发送文件路径后，模型可调用相应工具解析文档；执行与权限确认由 DSH 负责。</p>
    <p>默认使用高推理强度；也可在 DSH 选择档位。上方显示最近请求与官方 CLI 确认的实际档位。</p>
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
