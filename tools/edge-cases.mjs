/**
 * Check the failure paths a user is likely to hit.
 *
 * A happy path proves the app works; these prove it does not become an error box
 * with nothing to act on. Each case starts its own server so the assertions cannot
 * be confused by the one already running.
 *
 * Run: node tools/edge-cases.mjs
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:net'

const NODE = process.execPath
const ROOT = process.cwd()

let failures = 0
let checks = 0

function check(label, ok, detail = '') {
  checks += 1
  if (!ok) failures += 1
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
}

/** Start a server on a port and wait until it answers. */
async function start(port, env = {}) {
  const child = spawn(NODE, ['packages/server/src/cli.js', '--port', String(port)], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: 'ignore'
  })
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/state`)
      if (response.ok) return child
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  child.kill()
  throw new Error(`端口 ${port} 没有启动`)
}

/** Send a raw request line, bypassing any client-side path normalisation. */
function rawGet(port, path) {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(`GET ${path} HTTP/1.1
Host: 127.0.0.1
Connection: close

`)
    })
    let data = ''
    socket.on('data', (chunk) => {
      data += chunk.toString()
    })
    socket.on('end', () => resolve(data))
    socket.on('error', () => resolve(''))
  })
}

console.log('=== 端口被占用 ===')
const first = await start(5190)
try {
  // A second server on the same port must not hang or crash silently: it either
  // takes another port or exits with a message.
  const second = spawn(NODE, ['packages/server/src/cli.js', '--port', '5190'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let output = ''
  second.stdout.on('data', (chunk) => {
    output += chunk.toString()
  })
  second.stderr.on('data', (chunk) => {
    output += chunk.toString()
  })
  const exited = await Promise.race([
    new Promise((resolve) => second.on('exit', (code) => resolve(code))),
    new Promise((resolve) => setTimeout(() => resolve('still-running'), 7000))
  ])
  if (exited !== 'still-running') second.kill()
  check('第二实例给出提示而不是崩溃', output.includes('占用') || exited === 'still-running',
    output.trim().split('\n')[0] ?? '')

  // The first server must still be answering: a second launch must not steal it.
  const still = await fetch('http://127.0.0.1:5190/api/state')
  check('第一个实例仍在服务', still.ok, `HTTP ${still.status}`)
} finally {
  first.kill()
}

console.log('\n=== 账号库不存在 ===')
const emptyDir = mkdtempSync(join(tmpdir(), 'buddy-empty-'))
try {
  const isolated = await start(5191, { BUDDYHUB_DATA: emptyDir })
  try {
    const state = await (await fetch('http://127.0.0.1:5191/api/state')).json()
    check('空账号库不导致崩溃', state.vault !== undefined, `ok=${state.vault?.ok}`)
    check('空账号库时可提示原因', typeof state.vault?.error === 'string' || state.vault?.ok === false,
      state.vault?.error ?? '')

    // A call with no accounts must refuse clearly rather than hang.
    const response = await fetch('http://127.0.0.1:5191/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4.1-flash-cn',
        messages: [{ role: 'user', content: 'hi' }]
      })
    })
    const body = await response.json()
    check('无账号时调用给出原因', body.error !== undefined,
      body.error?.message?.slice(0, 60) ?? '没有错误信息')
  } finally {
    isolated.kill()
  }
} finally {
  rmSync(emptyDir, { recursive: true, force: true })
}

console.log('\n=== 请求体异常 ===')
const server = await start(5192)
try {
  const base = 'http://127.0.0.1:5192'
  const cases = [
    { label: '空请求体', body: '' },
    { label: '非 JSON', body: 'not json' },
    { label: '缺少 model', body: JSON.stringify({ messages: [] }) },
    { label: '未知 model', body: JSON.stringify({ model: 'no-such-model', messages: [] }) }
  ]
  for (const testCase of cases) {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: testCase.body
    })
    let body
    try {
      body = await response.json()
    } catch {
      body = {}
    }
    check(`${testCase.label} 返回错误信息`, body.error !== undefined,
      `${response.status} ${body.error?.message?.slice(0, 40) ?? ''}`)
  }

  // GET on a POST-only route.
  const wrongMethod = await fetch(`${base}/v1/chat/completions`)
  check('错误方法被拒绝', wrongMethod.status === 405, `HTTP ${wrongMethod.status}`)

  // An unknown API route.
  const unknown = await fetch(`${base}/api/no-such-route`)
  check('未知接口返回 404', unknown.status === 404, `HTTP ${unknown.status}`)

  // fetch resolves `..` before sending, so the path is written raw over a socket to
  // actually reach the server as a traversal attempt.
  const traversal = await rawGet(5192, '/../../package.json')
  check('路径穿越被拦截', !traversal.includes('buddy-desktop') || traversal.includes('<html'),
    traversal.slice(0, 60).replace(/\s+/g, ' '))
} finally {
  server.kill()
}

console.log('')
console.log(failures === 0 ? `全部通过（${checks} 项）` : `${failures}/${checks} 项失败`)
process.exitCode = failures === 0 ? 0 : 1
