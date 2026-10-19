/**
 * Drive the running app in a real browser and press its buttons.
 *
 * A rendered button proves nothing about whether it is wired up. This attaches to
 * Chrome over the DevTools protocol, navigates to a page, clicks each action, and
 * reports what changed in the DOM — which is the only way to tell a dead button
 * from a working one.
 *
 * Run: node tools/click-test.mjs [port]
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const port = process.argv[2] ?? '5178'
const BASE = `http://127.0.0.1:${port}`
const DEBUG_PORT = 9333

const CHROME = [
  join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  join(process.env.ProgramFiles ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe')
].find((path) => existsSync(path))

if (CHROME === undefined) {
  console.error('找不到 Chrome。')
  process.exit(1)
}

/** Wait for the DevTools endpoint to answer. */
async function waitForDebugger(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)
      if (response.ok) return await response.json()
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('Chrome 调试端口没有响应')
}

/** A minimal DevTools session over the JSON endpoints. */
async function openSession(url) {
  const created = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?${encodeURIComponent(url)}`, {
    method: 'PUT'
  })
  const target = await created.json()
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  let nextId = 1
  const pending = new Map()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    const waiter = pending.get(message.id)
    if (waiter === undefined) return
    pending.delete(message.id)
    if (message.error) waiter.reject(new Error(message.error.message))
    else waiter.resolve(message.result)
  })
  const send = (method, params = {}) => {
    const id = nextId++
    socket.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
  }
  await send('Runtime.enable')
  return { send, close: () => socket.close(), targetId: target.id }
}

/** Evaluate an expression in the page and return its value. */
async function evaluate(session, expression) {
  const result = await session.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  })
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text ?? '页面内的表达式失败')
  }
  return result.result.value
}

const profile = mkdtempSync(join(tmpdir(), 'buddy-click-'))
const chrome = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${profile}`,
  'about:blank'
], { stdio: 'ignore' })

let failures = 0
const report = (label, ok, detail = '') => {
  if (!ok) failures += 1
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
}

try {
  await waitForDebugger()

  // --- The region page: the three actions must reach the backend ---
  const region = await openSession(`${BASE}/#/cn`)
  await new Promise((resolve) => setTimeout(resolve, 2500))

  const buttons = await evaluate(region, `[...document.querySelectorAll('button')].map(b => b.textContent.trim())`)
  report('国内版页面渲染出按钮', buttons.some((text) => text.includes('桌面版')), buttons.join(' / '))

  // Press "从桌面版读取" and watch for the toast it should produce.
  const clicked = await evaluate(region, `(() => {
    const button = [...document.querySelectorAll('button')].find(b => b.textContent.includes('桌面版'));
    if (!button) return 'no-button';
    button.click();
    return 'clicked';
  })()`)
  report('点击「从桌面版读取」', clicked === 'clicked', clicked)

  await new Promise((resolve) => setTimeout(resolve, 3000))

  const afterRead = await evaluate(region, `(() => {
    const toast = document.querySelector('.toast');
    const busy = document.querySelector('.spin') !== null;
    return { toast: toast ? toast.textContent.trim() : null, busy };
  })()`)
  report('按钮产生了结果提示', afterRead.toast !== null, afterRead.toast ?? '没有出现任何提示')
  region.close()

  // --- Command Code page: the key test must run ---
  const cc = await openSession(`${BASE}/#/command-code`)
  await new Promise((resolve) => setTimeout(resolve, 2500))

  const ccButtons = await evaluate(cc, `[...document.querySelectorAll('button')].map(b => b.textContent.trim())`)
  report('Command Code 页面渲染出按钮', ccButtons.length > 0, ccButtons.join(' / '))

  const testClicked = await evaluate(cc, `(() => {
    const button = [...document.querySelectorAll('button')].find(b => b.textContent.includes('测试'));
    if (!button) return 'no-button';
    button.click();
    return 'clicked';
  })()`)
  report('点击「测试连接」', testClicked === 'clicked', testClicked)

  await new Promise((resolve) => setTimeout(resolve, 5000))

  const ccResult = await evaluate(cc, `(() => {
    const box = document.querySelector('.test-result');
    return box ? box.textContent.trim().replace(/\\s+/g, ' ') : null;
  })()`)
  report('测试结果返回', ccResult !== null, ccResult ?? '没有出现结果')
  cc.close()
} catch (error) {
  console.error(`\n测试中断：${error instanceof Error ? error.message : String(error)}`)
  failures += 1
} finally {
  chrome.kill()
}

console.log('')
console.log(failures === 0 ? '全部按钮可用' : `${failures} 项失败`)
process.exitCode = failures === 0 ? 0 : 1
