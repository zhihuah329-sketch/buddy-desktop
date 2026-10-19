/**
 * Load a page in a real browser and report every console error.
 *
 * A blank page usually means an exception before the first render, and the error is
 * only visible in the console — which a screenshot cannot show.
 *
 * Run: node tools/check-console.mjs <url>
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const url = process.argv[2] ?? 'http://127.0.0.1:5178/#/usage'
const DEBUG_PORT = 9334

const CHROME = [
  join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  join(process.env.ProgramFiles ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe')
].find((path) => existsSync(path))

if (CHROME === undefined) {
  console.error('找不到 Chrome。')
  process.exit(1)
}

const profile = mkdtempSync(join(tmpdir(), 'buddy-console-'))
const chrome = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${profile}`,
  'about:blank'
], { stdio: 'ignore' })

async function waitForDebugger(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)
      if (response.ok) return
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('Chrome 调试端口没有响应')
}

try {
  await waitForDebugger()

  const created = await fetch(
    `http://127.0.0.1:${DEBUG_PORT}/json/new?${encodeURIComponent(url)}`,
    { method: 'PUT' }
  )
  const target = await created.json()
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })

  let nextId = 1
  const pending = new Map()
  const messages = []

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id !== undefined) {
      const waiter = pending.get(message.id)
      if (waiter !== undefined) {
        pending.delete(message.id)
        waiter.resolve(message.result)
      }
      return
    }
    if (message.method === 'Runtime.consoleAPICalled') {
      const text = message.params.args
        .map((arg) => arg.value ?? arg.description ?? arg.type)
        .join(' ')
      messages.push({ kind: message.params.type, text })
    }
    if (message.method === 'Runtime.exceptionThrown') {
      const detail = message.params.exceptionDetails
      messages.push({
        kind: 'exception',
        text: `${detail.text} ${detail.exception?.description ?? ''}`.trim()
      })
    }
  })

  const send = (method, params = {}) => {
    const id = nextId++
    socket.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve) => pending.set(id, { resolve }))
  }

  await send('Runtime.enable')
  await send('Page.enable')
  await new Promise((resolve) => setTimeout(resolve, 5000))

  const result = await send('Runtime.evaluate', {
    expression: 'document.getElementById("app")?.innerHTML?.length ?? -1',
    returnByValue: true
  })

  console.log(`app 节点内容长度: ${result.result.value}`)
  console.log('')
  if (messages.length === 0) {
    console.log('没有控制台消息。')
  } else {
    console.log('控制台消息:')
    for (const message of messages.slice(0, 20)) {
      console.log(`  [${message.kind}] ${message.text.slice(0, 500)}`)
    }
  }
  socket.close()
} catch (error) {
  console.error(`失败: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  chrome.kill()
}
