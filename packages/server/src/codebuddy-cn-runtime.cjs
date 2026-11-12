const { execFile, spawn } = require('node:child_process')
const { mkdtempSync, readFileSync, rmSync, statSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { delimiter, dirname, isAbsolute, join } = require('node:path')
const { createInterface } = require('node:readline')

const packageBin = ['node_modules', '@tencent-ai', 'codebuddy-code', 'bin', 'codebuddy']
const model = 'deepseek-v4.1-flash'
const npmPackage = '@tencent-ai/codebuddy-code'
const reasoningLevels = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
let installation
let globalPrefix
let installState = { phase: 'idle' }
let lastRequest

function installationState() { return { ...installState } }
function requestState() { return lastRequest ? { ...lastRequest, supportedEfforts: [...lastRequest.supportedEfforts] } : undefined }

function selectThoughtLevel(option, effort) {
  const requested = effort === false || effort === 'none' || effort === 'off' ? 'disabled'
    : effort === true || effort === undefined ? 'high' : effort
  if (!['disabled', 'enabled', ...reasoningLevels].includes(requested)) throw new Error('无效的 CodeBuddy 推理强度。')
  const supported = option?.options?.map((item) => item.value) ?? []
  if (!option) return { requested, supported, effective: undefined }
  if (supported.includes(requested)) return { requested, supported, effective: requested }
  if (requested === 'disabled') throw new Error('当前模型不提供关闭推理的选项。')
  const upper = reasoningLevels.slice(reasoningLevels.indexOf(requested)).find((level) => supported.includes(level))
  const lower = reasoningLevels.slice(0, reasoningLevels.indexOf(requested) + 1).filter((level) => supported.includes(level))
  const effective = upper ?? lower.at(-1) ?? (supported.includes('enabled') ? 'enabled' : undefined)
  return { requested, supported, effective }
}

function firstFile(paths) {
  return paths.find((path) => {
    if (!path || !isAbsolute(path)) return false
    try { return statSync(path).isFile() } catch { return false }
  })
}

function pathDirs(env) {
  return (env.PATH ?? env.Path ?? '').split(delimiter).map((entry) => entry.trim().replace(/^"|"$/g, '')).filter(isAbsolute)
}

function managedPrefix(env) {
  return env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'BuddyDesktop', 'codebuddy')
}

function findNode(env, nodeExecutable) {
  const windows = process.platform === 'win32'
  return firstFile([nodeExecutable, env.BUDDY_NODE_EXE,
    ...pathDirs(env).map((dir) => join(dir, windows ? 'node.exe' : 'node')),
    windows && env.ProgramFiles && join(env.ProgramFiles, 'nodejs', 'node.exe'),
    !process.versions.electron && process.execPath])
}

function findCodeBuddy(env = process.env, nodeExecutable) {
  const windows = process.platform === 'win32'
  const dirs = pathDirs(env)
  const prefixes = [globalPrefix, env.npm_config_prefix, env.APPDATA && join(env.APPDATA, 'npm'),
    managedPrefix(env), ...dirs].filter(Boolean)
  const native = firstFile([env.BUDDY_CODEBUDDY_EXE, ...dirs.map((dir) => join(dir, windows ? 'codebuddy.exe' : 'codebuddy'))])
  if (native) return { executable: native, args: [] }
  const candidates = prefixes.flatMap((prefix) => [join(prefix, ...packageBin), join(prefix, '..', 'lib', ...packageBin)])
  const cli = firstFile([env.BUDDY_CODEBUDDY_ENTRY]) ?? candidates.find((path) => {
    if (!firstFile([path])) return false
    try {
      const pkg = JSON.parse(readFileSync(join(dirname(path), '..', 'package.json'), 'utf8'))
      return pkg.name === npmPackage && typeof pkg.version === 'string'
    } catch { return false }
  })
  if (!cli) throw new Error('未找到 CodeBuddy Code。请先运行 npm install -g @tencent-ai/codebuddy-code。')
  const node = findNode(env, nodeExecutable)
  if (!node) throw new Error('已找到 CodeBuddy Code，但未找到 Node.js。请安装 Node.js 并重新打开 Buddy Desktop。')
  const managed = managedPrefix(env)
  let version
  try { version = JSON.parse(readFileSync(join(dirname(cli), '..', 'package.json'), 'utf8')).version } catch {}
  return { executable: node, args: [cli], version, managed: Boolean(managed && cli === join(managed, ...packageBin)) }
}

function installCodeBuddy(env = process.env) {
  if (installation) return installation
  const node = findNode(env)
  const npm = node && firstFile([
    join(dirname(node), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(node), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  ])
  if (!npm) {
    const error = new Error('未找到 Node.js 随附的 npm。请安装 Node.js 后点击重试。')
    installState = { phase: 'error', error: error.message }
    return Promise.reject(error)
  }
  installState = { phase: 'installing', startedAt: Date.now() }
  const runNpm = (args, timeout) => new Promise((resolve, reject) => {
    execFile(node, [npm, ...args], { timeout, windowsHide: true, env, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const code = /\b(EACCES|EPERM|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ENOSPC)\b/.exec(stderr ?? '')?.[1]
        const detail = error.killed ? '安装超时' : code ?? 'npm 安装失败'
        reject(Object.assign(new Error(`${detail}。请检查网络、磁盘空间或全局 npm 目录权限后点击重试。`), { code }))
      } else resolve(stdout.trim())
    })
  })
  installation = (async () => {
    globalPrefix = await runNpm(['prefix', '--global'], 15_000)
    if (!isAbsolute(globalPrefix)) throw new Error('npm 返回了无效的全局安装目录。')
    const args = ['install', '--global', npmPackage, '--prefer-offline', '--no-audit', '--no-fund',
      '--fetch-retries=2', '--fetch-retry-mintimeout=1000', '--fetch-retry-maxtimeout=5000', '--fetch-timeout=60000']
    try { await runNpm(args, 300_000) }
    catch (error) {
      if (!['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'].includes(error.code)) throw error
      await runNpm(args, 300_000)
    }
    findCodeBuddy(env)
    installState = { phase: 'ready', finishedAt: Date.now() }
  })().catch((error) => {
    installState = { phase: 'error', error: error.message }
    throw error
  }).finally(() => { installation = undefined })
  return installation
}

async function ensureCodeBuddy() {
  if (installation) return installation
  try { findCodeBuddy(); return } catch {}
  return installCodeBuddy()
}

function askCodeBuddyOnce(task, signal, nodeExecutable, onDelta, thinking = true) {
  return new Promise((resolve, reject) => {
    const runtime = findCodeBuddy(process.env, nodeExecutable)
    const cwd = mkdtempSync(join(tmpdir(), 'buddy-codebuddy-'))
    const child = spawn(runtime.executable, [...runtime.args, '--acp', '--model', model, '--tools', '',
      '--strict-mcp-config', '--setting-sources', 'user', '--no-session-persistence'], {
      cwd,
      env: { ...process.env, DISABLE_AUTOUPDATER: '1' },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore']
    })
    child.once('close', () => {
      try { rmSync(cwd, { recursive: true, force: true }) } catch { /* temp cleanup */ }
    })
    const reader = createInterface({ input: child.stdout })
    const pending = new Map()
    let nextId = 0
    let answer = ''
    let reasoning = ''
    let usage
    let finished = false
    let promptSent = false
    let configuration
    const transportError = (message) => Object.assign(new Error(message), { retryable: !promptSent })
    const abort = () => finish(new Error('CodeBuddy 请求已取消。'))
    let idleTimeout
    function resetIdleTimeout() {
      clearTimeout(idleTimeout)
      idleTimeout = setTimeout(() => finish(transportError('CodeBuddy 长时间没有响应，请检查网络后重试。')), promptSent ? 120_000 : 30_000)
    }
    resetIdleTimeout()
    const timeout = setTimeout(() => finish(new Error('CodeBuddy 请求超过 10 分钟，请缩短任务后重试。')), 600_000)

    function finish(error) {
      if (finished) return
      finished = true
      clearTimeout(timeout)
      clearTimeout(idleTimeout)
      signal?.removeEventListener('abort', abort)
      for (const request of pending.values()) request.reject(error ?? new Error('CodeBuddy connection closed.'))
      pending.clear()
      reader.close()
      child.stdin.destroy()
      if (child.exitCode === null && child.signalCode === null) child.kill()
      if (error) reject(error)
      else resolve({ text: answer.trim(), reasoning, usage })
    }

    function send(message) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
    }

    function call(method, params) {
      return new Promise((resolve, reject) => {
        const id = ++nextId
        pending.set(id, { resolve, reject })
        send({ id, method, params })
      })
    }

    child.on('error', () => finish(transportError('无法启动 CodeBuddy，请检查 CLI 安装。')))
    child.stdin.on('error', () => finish(transportError('CodeBuddy 连接已断开。')))
    child.on('close', () => finish(transportError('CodeBuddy 提前退出，请检查国内站登录和网络。')))
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) return abort()

    reader.on('line', (line) => {
      if (finished) return
      let message
      try { message = JSON.parse(line) } catch { return }
      resetIdleTimeout()
      if (message.method === 'session/update') {
        const update = message.params?.update
        const actualModel = update?._meta?.['codebuddy.ai/requestModelId']
        if (configuration && typeof actualModel === 'string') configuration.actualModel = actualModel
        if (update?.content?.type === 'text' && update.content.text) {
          const text = update.content.text
          if (update.sessionUpdate === 'agent_message_chunk') {
            answer += text
            onDelta?.('text', text)
          } else if (update.sessionUpdate === 'agent_thought_chunk') {
            reasoning += text
            onDelta?.('reasoning', text)
          }
        }
        if (update?.sessionUpdate === 'usage_update' && update._meta?.usage) usage = update._meta.usage
      } else if (message.method && message.id !== undefined) {
        if (message.method === 'session/request_permission') {
          send({ id: message.id, result: { outcome: { outcome: 'cancelled' } } })
        } else {
          send({ id: message.id, error: { code: -32601, message: 'Unsupported method' } })
        }
      } else if (pending.has(message.id)) {
        const request = pending.get(message.id)
        pending.delete(message.id)
        if (message.error) {
          const code = Number.isInteger(message.error.code) ? ` (ACP ${message.error.code})` : ''
          const auth = /auth|login|sign.?in|credential|登录/i.test(message.error.message ?? '')
          request.reject(new Error(auth
            ? `CodeBuddy 需要重新登录${code}。请运行 codebuddy，选择 Chinese Site 完成登录。`
            : `CodeBuddy 拒绝了请求${code}。请检查模型权限、额度或输入内容后重试。`))
        } else request.resolve(message.result)
      }
    })

    ;(async () => {
      const init = await call('initialize', {
        protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'dsh-codebuddy-cn', version: '1.0.0' }
      })
      if (init.protocolVersion !== 1) throw new Error('CodeBuddy returned an unsupported ACP version.')
      const session = await call('session/new', { cwd, mcpServers: [] })
      let configOptions = session.configOptions ?? []
      const modelOption = configOptions.find((option) => option.id === 'model')
      let selectedModel = modelOption?.currentValue ?? session.models?.currentModelId
      if (selectedModel !== model && modelOption?.options?.some((option) => option.value === model)) {
        const changed = await call('session/set_config_option', { sessionId: session.sessionId, configId: modelOption.id, value: model })
        configOptions = changed.configOptions ?? configOptions
        selectedModel = configOptions.find((option) => option.id === 'model')?.currentValue ?? selectedModel
      }
      if (selectedModel && selectedModel !== model) throw new Error(`CodeBuddy 当前选择的是 ${selectedModel}，未能切换到 ${model}。`)
      const thoughtOption = configOptions.find((option) => option.id === 'thought_level')
      const level = selectThoughtLevel(thoughtOption, thinking)
      if (level.effective) {
        const changed = await call('session/set_config_option', { sessionId: session.sessionId, configId: thoughtOption.id, value: level.effective })
        const confirmed = changed.configOptions?.find((option) => option.id === thoughtOption.id)?.currentValue
        if (confirmed && confirmed !== level.effective) throw new Error('CodeBuddy 未接受请求的推理强度。')
      }
      configuration = { model: selectedModel ?? model, requestedEffort: level.requested, effectiveEffort: level.effective ?? 'unknown', supportedEfforts: level.supported, startedAt: Date.now() }
      lastRequest = configuration
      const prompt = typeof task === 'string' ? [{ type: 'text', text: task }] : task
      if (prompt.some((part) => part.type === 'image') && !init.agentCapabilities?.promptCapabilities?.image) {
        throw new Error('当前 CodeBuddy ACP 接口不支持图片。')
      }
      promptSent = true
      resetIdleTimeout()
      const result = await call('session/prompt', { sessionId: session.sessionId, prompt })
      if (result.stopReason !== 'end_turn' || !answer.trim()) {
        let detail = result._meta?.['codebuddy.ai/errorMessage'] ?? ''
        try { const parsed = JSON.parse(detail); detail = parsed.data?.details ?? parsed.message ?? detail } catch {}
        if (/EPERM|EACCES/.test(detail)) throw new Error('CodeBuddy 无法写入本机配置或日志目录。请在当前 Windows 用户下运行，并检查目录写入权限。')
        if (/quota|credit|余额|额度/i.test(detail)) throw new Error('CodeBuddy 账号当前额度不足，请在官方客户端检查额度。')
        if (/auth|login|登录/i.test(detail)) throw new Error('CodeBuddy 需要重新登录，请运行 codebuddy 并选择 Chinese Site。')
        throw new Error(`CodeBuddy 未完成本次请求（${result.stopReason ?? 'unknown'}）。请检查官方客户端的错误提示后重试。`)
      }
      finish()
    })().catch(finish)
  })
}

async function askCodeBuddyDetailed(task, signal, nodeExecutable, onDelta, thinking) {
  signal?.throwIfAborted()
  try { return await askCodeBuddyOnce(task, signal, nodeExecutable, onDelta, thinking) }
  catch (error) {
    if (!error.retryable || signal?.aborted) throw error
    return askCodeBuddyOnce(task, signal, nodeExecutable, onDelta, thinking)
  }
}

async function askCodeBuddy(...args) {
  return (await askCodeBuddyDetailed(...args)).text
}

module.exports = { askCodeBuddy, askCodeBuddyDetailed, findCodeBuddy, installCodeBuddy, ensureCodeBuddy, installationState, requestState }
