const { execFile, spawn } = require('node:child_process')
const { mkdtempSync, rmSync, statSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { delimiter, dirname, isAbsolute, join } = require('node:path')
const { createInterface } = require('node:readline')

const packageBin = ['node_modules', '@tencent-ai', 'codebuddy-code', 'bin', 'codebuddy']
const model = 'deepseek-v4.1-flash'
const npmPackage = '@tencent-ai/codebuddy-code@2.180.0'
let installation

function firstFile(paths) {
  return paths.find((path) => {
    if (!path || !isAbsolute(path)) return false
    try { return statSync(path).isFile() } catch { return false }
  })
}

function pathDirs(env) {
  return (env.PATH ?? '').split(delimiter).map((entry) => entry.trim().replace(/^"|"$/g, '')).filter(isAbsolute)
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
  const prefixes = [env.npm_config_prefix, env.APPDATA && join(env.APPDATA, 'npm'),
    managedPrefix(env), ...dirs].filter(Boolean)
  const native = firstFile([env.BUDDY_CODEBUDDY_EXE, ...dirs.map((dir) => join(dir, windows ? 'codebuddy.exe' : 'codebuddy'))])
  if (native) return { executable: native, args: [] }
  const cli = firstFile([
    env.BUDDY_CODEBUDDY_ENTRY,
    ...prefixes.flatMap((prefix) => [join(prefix, ...packageBin), join(prefix, '..', 'lib', ...packageBin)])
  ])
  if (!cli) throw new Error('未找到 CodeBuddy Code。请先运行 npm install -g @tencent-ai/codebuddy-code。')
  const node = findNode(env, nodeExecutable)
  if (!node) throw new Error('已找到 CodeBuddy Code，但未找到 Node.js。请安装 Node.js 并重新打开 Buddy Desktop。')
  const managed = managedPrefix(env)
  return { executable: node, args: [cli], managed: Boolean(managed && cli === join(managed, ...packageBin)) }
}

function installCodeBuddy(env = process.env) {
  if (installation) return installation
  const node = findNode(env)
  const prefix = managedPrefix(env)
  const npm = node && firstFile([
    join(dirname(node), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(node), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  ])
  if (!prefix || !npm) {
    return Promise.reject(new Error('未找到 Node.js 随附的 npm。请安装 Node.js 后重新打开 Buddy Desktop。'))
  }
  installation = new Promise((resolve, reject) => {
    execFile(node, [npm, 'install', '--prefix', prefix, '--registry', 'https://registry.npmjs.org',
      '--no-audit', '--no-fund', '--ignore-scripts', '--fetch-retries=1', npmPackage],
    { timeout: 240_000, windowsHide: true, env }, (error) => {
      if (error || !firstFile([join(prefix, ...packageBin)])) {
        reject(new Error('自动安装失败。请检查网络后重试，或在 PowerShell 手动安装官方 CLI。'))
      } else resolve()
    })
  }).finally(() => { installation = undefined })
  return installation
}
function askCodeBuddyDetailed(task, signal, nodeExecutable, onDelta) {
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
    const abort = () => finish(new Error('CodeBuddy task cancelled.'))
    const timeout = setTimeout(() => finish(new Error('CodeBuddy did not finish within 120 seconds.')), 120_000)

    function finish(error) {
      if (finished) return
      finished = true
      clearTimeout(timeout)
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

    child.on('error', () => finish(new Error('Could not start the official CodeBuddy client.')))
    child.stdin.on('error', () => finish(new Error('CodeBuddy closed its input.')))
    child.on('close', () => finish(new Error('CodeBuddy exited before completing the task. Check that its Chinese site login is active.')))
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) return abort()

    reader.on('line', (line) => {
      let message
      try { message = JSON.parse(line) } catch { return }
      if (message.method === 'session/update') {
        const update = message.params?.update
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
          request.reject(new Error(`CodeBuddy 拒绝了请求${code}。请运行 codebuddy，确认已登录 Chinese Site 且账号可用。`))
        } else request.resolve(message.result)
      }
    })

    ;(async () => {
      const init = await call('initialize', {
        protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'dsh-codebuddy-cn', version: '1.0.0' }
      })
      if (init.protocolVersion !== 1) throw new Error('CodeBuddy returned an unsupported ACP version.')
      const session = await call('session/new', { cwd, mcpServers: [] })
      const prompt = typeof task === 'string' ? [{ type: 'text', text: task }] : task
      if (prompt.some((part) => part.type === 'image') && !init.agentCapabilities?.promptCapabilities?.image) {
        throw new Error('当前 CodeBuddy ACP 接口不支持图片。')
      }
      const result = await call('session/prompt', { sessionId: session.sessionId, prompt })
      if (result.stopReason !== 'end_turn' || !answer.trim()) throw new Error('CodeBuddy ended without a complete reply.')
      finish()
    })().catch(finish)
  })
}

async function askCodeBuddy(...args) {
  return (await askCodeBuddyDetailed(...args)).text
}

module.exports = { askCodeBuddy, askCodeBuddyDetailed, findCodeBuddy, installCodeBuddy }
