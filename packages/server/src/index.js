/**
 * The desktop app's local API.
 *
 * ## Why a server at all
 *
 * The Vue page runs in a browser context, so it cannot read the account store or
 * touch the filesystem. Everything it needs is exposed here as JSON over
 * localhost, which also means the same endpoints serve a CLI or a script.
 *
 * ## Why it binds to loopback and checks the Origin
 *
 * The payload describes the user's accounts and can import credentials. Binding to
 * 127.0.0.1 keeps it off the network, and the Origin check stops a random web page
 * open in the same browser from driving it — without that, any tab could read the
 * account list over localhost.
 *
 * @module @buddy-desktop/server
 */

import { createServer } from 'node:http'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  accountOverview,
  authorizationPlan,
  discoverCredentials,
  applyElectronPath,
  readDesktopCredential,
  readVault,
  readHealth,
  importCredentials,
  removeAccount,
  resolveClientForSite,
  parseModel,
  MODEL_IDS,
  siblingAvailable,
  siblingLocation,
  detectTunnel,
  // The second channel: Command Code authenticates with its own key instead of a
  // desktop login, and brings its own model catalogue.
  CC_API_BASE,
  CC_MODELS,
  CC_DEFAULT_MODEL,
  maskKey,
  validateKeyShape,
  testCommandCodeKey,
  writeCommandCodeKey,
  readCommandCodeKey,
  // Daily check-in: the scheduler owns the timer, the day guard and the per-account
  // bookkeeping, so the server holds one instance and exposes it.
  CheckinScheduler
} from '@buddy-desktop/core'

import { buildPool, forwardChat, pumpAnswer } from './forward.js'

/** Content types for the small set of files this server will serve. */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
}

/** Only these origins may call the API. */
function originAllowed(origin) {
  if (typeof origin !== 'string' || origin.length === 0) return true // curl / same-origin fetch
  try {
    const { hostname } = new URL(origin)
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]'
  } catch {
    return false
  }
}

/** Read and parse a JSON request body, with a size cap. */
function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 1_000_000) {
        reject(new Error('请求体过大。'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('请求体不是合法的 JSON。'))
      }
    })
    req.on('error', reject)
  })
}

/**
 * Where a WorkBuddy client might be installed.
 *
 * The vendor default, the per-user install, and the drive roots this project has
 * seen in practice. Shared by the resolver and the diagnostic so the two cannot
 * disagree about what was tried.
 *
 * @returns candidate paths.
 */
function electronCandidatePaths() {
  const local = process.env.LOCALAPPDATA
  return [
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'WorkBuddy', 'WorkBuddy.exe'),
    ...(typeof local === 'string' ? [join(local, 'Programs', 'WorkBuddy', 'WorkBuddy.exe')] : []),
    'F:\\WorkBuddy\\WorkBuddy.exe',
    'D:\\WorkBuddy\\WorkBuddy.exe',
    'C:\\WorkBuddy\\WorkBuddy.exe',
    'E:\\WorkBuddy\\WorkBuddy.exe'
  ]
}

/**
 * Whether a path can be stat-ed, distinguishing "absent" from "not allowed".
 *
 * A sandboxed or otherwise restricted process can be refused a path that exists.
 * Reporting that as "not installed" is wrong and unactionable, so the two cases are
 * kept apart: absent means the user should install the client, refused means the
 * client may well be there but this process cannot look.
 *
 * @param path - the candidate.
 * @returns 'file' | 'absent' | 'denied'.
 */
function probePath(path) {
  try {
    return statSync(path).isFile() ? 'file' : 'absent'
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') return 'denied'
    return 'absent'
  }
}

/**
 * Apply the desktop-client path before anything reads it.
 *
 * The credential reader honours `WORKBUDDY_ELECTRON_BIN`, which a DSH session may
 * already have set. A standalone app started from a shortcut has no such
 * environment, so the CN client is not found even though it is installed. Known
 * install locations are therefore probed here, which is what makes the packaged
 * build behave like the development one.
 *
 * @param configured - an explicit path from the caller, if any.
 * @returns the path that was applied, or undefined.
 */
function ensureElectron(configured) {
  // A throw here would leave the panel claiming no client is installed, which
  // looks identical to "not installed" and gives the user nothing to act on.
  let applied
  try {
    applied = applyElectronPath(configured)
  } catch (error) {
    console.error(`[electron] applyElectronPath 失败：${error instanceof Error ? error.message : String(error)}`)
    applied = undefined
  }
  if (applied !== undefined) return applied

  const candidates = electronCandidatePaths()
  const denied = []
  for (const candidate of candidates) {
    const state = probePath(candidate)
    if (state === 'denied') {
      denied.push(candidate)
      continue
    }
    if (state !== 'file') continue
    try {
      const found = applyElectronPath(candidate)
      if (found !== undefined) return found
    } catch (error) {
      console.error(`[electron] 无法使用 ${candidate}：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  // A refused path is not the same as an empty one, and the difference decides
  // what the user should do.
  if (denied.length > 0) {
    return { denied: denied[0] }
  }
  return undefined
}

/**
 * Everything the page needs in one response.
 *
 * One document rather than several endpoints, so a page refresh cannot show a
 * half-updated view: the account list and the client state always describe the
 * same instant.
 *
 * @param options - `dataDir` to read a specific store, `electron` for the client.
 * @returns the state document.
 */
export function buildState(options = {}) {
  const dataDir = options.dataDir
  const now = Date.now()
  const overview = accountOverview({ ...(dataDir === undefined ? {} : { dataDir }), now })
  const health = readHealth(now)

  // The endpoint reported to the page must be the one actually being served, not
  // the default port: a packaged build may be started with `--port`.
  const servedPort = options.actualPort ?? options.port ?? 5178
  const servedHost = options.host ?? '127.0.0.1'

  // The client state is resolved per region so each panel can name the program it
  // would open, and so a missing client is stated once, in the backend, rather
  // than inferred by every view.
  const found = ensureElectron(options.electron)
  const electron = typeof found === 'string' ? found : undefined
  const electronDenied = found !== null && typeof found === 'object' ? found.denied : undefined
  // Published with the state so a packaged build — which has no console to read —
  // can still be diagnosed from the page or a single request.
  const electronDebug = {
    applied: electron ?? null,
    denied: electronDenied ?? null,
    env: process.env.WORKBUDDY_ELECTRON_BIN ?? null,
    candidates: electronCandidatePaths().map((path) => ({ path, state: probePath(path) }))
  }
  // The discovered CN client is what the region panel should name, so it is passed
  // through as the configured path when the caller did not set one explicitly.
  const cnClient = options.workbuddyPath ?? electron

  const clients = {}
  for (const site of ['cn', 'ai']) {
    const resolved = resolveClientForSite({
      site,
      ...(cnClient === undefined ? {} : { configured: cnClient }),
      ...(options.workbuddyIntlPath === undefined ? {} : { intlPath: options.workbuddyIntlPath })
    })
    // A refused path means the client may exist but this process cannot look. That
    // is a different instruction for the user than "install the client", so it is
    // reported as its own state rather than as missing.
    clients[site] = resolved.path === undefined && electronDenied !== undefined
      ? {
          ...resolved,
          source: 'denied',
          hint: `检测到客户端可能在 ${electronDenied}，但当前进程无权访问该路径（可能受沙箱或权限限制）。`
        }
      : resolved
  }

  const vault = readVault(dataDir)
  const tunnel = detectTunnel()

  return {
    at: now,
    dataDir: overview.dataDir,
    vault: {
      ok: overview.vaultOk,
      reason: overview.vaultReason ?? null,
      error: overview.vaultError ?? null,
      accounts: vault.ok === true ? (vault.accounts ?? []).length : 0
    },
    pools: overview.pools,
    accounts: overview.accounts,
    warnings: overview.warnings ?? [],
    needsAttention: overview.needsAttention ?? false,
    health: Object.keys(health).length,
    clients,
    electron: electron ?? null,
    electronDebug,
    // What a client may put in `model`, and where to point it. Published here so
    // the page can show the endpoint instead of the user having to guess it.
    models: MODEL_IDS,
    endpoint: `http://${servedHost}:${servedPort}/v1`,
    // Command Code is a separate channel with its own models and its own credential,
    // so it is described separately rather than folded into the region list.
    commandCode: (() => {
      const key = readCommandCodeKey()
      return {
        configured: typeof key === 'string' && key.length > 0,
        masked: typeof key === 'string' && key.length > 0 ? maskKey(key) : null,
        endpoint: `${CC_API_BASE}/v1`,
        defaultModel: CC_DEFAULT_MODEL,
        models: CC_MODELS
      }
    })(),
    // The last check-in result, so the page shows today's state without asking.
    checkin: options.scheduler?.snapshot() ?? null,
    sibling: { available: siblingAvailable(), location: siblingLocation() ?? null },
    tunnel
  }
}

/**
 * Start the API and static file server.
 *
 * @param options - `port`, `host`, `dev` for a Vite dev server, `electron`.
 * @returns the running server, with its actual port.
 */
export async function startServer(options = {}) {
  const host = options.host ?? '127.0.0.1'
  const port = options.port ?? 5178
  const uiDir = options.uiDir ?? defaultUiDir()
  // Filled in once the socket is bound, so the endpoint reported to the page is
  // the port actually being served rather than the requested one.
  const served = { actualPort: port, host }
  // A packaged build embeds the page instead of shipping it on disk, so the
  // caller may hand in its own reader. Absent one, the built page is read from
  // `packages/ui/dist` as in development.
  const ui = options.ui

  // One scheduler for the process, so the daily guard and the in-flight lock are
  // shared between the timer and a manual "check in now" from the page. Only the CN
  // pool takes part: the international billing endpoint rejects these calls, and
  // including it would report a failure on every run with nothing actually wrong.
  const scheduler = new CheckinScheduler({
    dataDir: options.dataDir,
    sites: ['cn'],
    intervalMs: 6 * 60 * 60 * 1000
  })

  // The first check runs shortly after start rather than on the tick, so the page has
  // a real state to show instead of an empty one for six hours.
  setTimeout(() => {
    scheduler.run().catch(() => {})
  }, 3000)

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${host}`)

    // The model endpoint streams, so it is handled before the JSON route: it
    // writes its own headers and body and must not go through `send`.
    if (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions') {
      if (!originAllowed(req.headers.origin)) {
        res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: { message: '来源不被允许。' } }))
        return
      }
      await handleChat(req, res, options)
      return
    }

    const send = (status, body) => {
      const text = typeof body === 'string' ? body : JSON.stringify(body)
      res.writeHead(status, {
        'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
        // The account list is live state; a cached copy would be a lie.
        'cache-control': 'no-store'
      })
      res.end(text)
    }

    if (url.pathname.startsWith('/api/')) {
      if (!originAllowed(req.headers.origin)) {
        return send(403, { error: '来源不被允许。' })
      }
      try {
        const result = await handleApi(req, url, send, { ...options, ...served, scheduler })
        if (result !== undefined) return send(200, result)
        return
      } catch (error) {
        return send(500, { error: error instanceof Error ? error.message : String(error) })
      }
    }

    return serveStatic(url.pathname, uiDir, res, ui)
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      served.actualPort = server.address().port
      resolve()
    })
  })

  return {
    server,
    host,
    port: served.actualPort,
    url: `http://${host}:${served.actualPort}`,
    close: () => new Promise((resolve) => server.close(resolve))
  }
}

/**
 * Handle one API call.
 *
 * @returns the body to send, or undefined when the handler already responded.
 */
async function handleApi(req, url, send, options) {
  const route = url.pathname.slice('/api/'.length)
  const dataDir = url.searchParams.get('dataDir') ?? undefined
  // The scheduler and the serving identity travel with every state read, so a reply
  // built anywhere in this handler still carries today's check-in result.
  const scope = {
    ...(dataDir === undefined || dataDir.length === 0 ? {} : { dataDir }),
    ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.actualPort === undefined ? {} : { actualPort: options.actualPort })
  }

  if (route === 'state' && req.method === 'GET') {
    return buildState({ ...scope, electron: options.electron })
  }

  if (route === 'discover' && req.method === 'POST') {
    const body = await readJson(req)
    const site = body.site === 'cn' || body.site === 'ai' ? body.site : undefined
    const discovery = discoverCredentials({
      ...scope,
      ...(site === undefined ? {} : { site })
    })
    return {
      discovery: {
        ...discovery,
        plan: authorizationPlan(discovery)
      }
    }
  }

  if (route === 'import' && req.method === 'POST') {
    const body = await readJson(req)
    const site = body.site === 'cn' || body.site === 'ai' ? body.site : undefined
    const result = await importCredentials({
      ...scope,
      ...(site === undefined ? {} : { site })
    })
    return { importResult: result, state: buildState(scope) }
  }

  if (route === 'read-desktop' && req.method === 'POST') {
    const body = await readJson(req)
    const site = body.site === 'ai' ? 'ai' : 'cn'
    const read = await readDesktopCredential({ site, ...(options.electron === undefined ? {} : {}) })
    return { read }
  }

  if (route === 'account' && req.method === 'DELETE') {
    const id = url.searchParams.get('id')
    if (typeof id !== 'string' || id.length === 0) {
      return { error: '缺少账号 id。' }
    }
    const result = await removeAccount({ ...scope, id })
    return { result, state: buildState(scope) }
  }

  if (route === 'health' && req.method === 'GET') {
    return { health: readHealth(Date.now()) }
  }

  // Check-in. The scheduler reports `signedIn: false` until it has read the account
  // state once, so the page can tell "not checked yet" from "checked and failed".
  if (route === 'checkin' && req.method === 'GET') {
    return { checkin: options.scheduler?.snapshot() ?? { installed: false } }
  }

  if (route === 'checkin' && req.method === 'POST') {
    const body = await readJson(req)
    // `force` claims without consulting the day guard, which is what the manual
    // button is for: the user is asking now, not waiting for the timer.
    const checkin = await options.scheduler.run({ force: body?.force === true })
    return { checkin }
  }

  // Command Code: store the key, then prove it works. The key is never returned —
  // only its masked form, because the page never needs the real value back.
  if (route === 'command-code/key' && req.method === 'POST') {
    const body = await readJson(req)
    const key = typeof body?.key === 'string' ? body.key.trim() : ''
    // `validateKeyShape` answers with a message or null, not a result object.
    const problem = validateKeyShape(key)
    if (problem !== null) return { ok: false, error: problem }
    writeCommandCodeKey(key)
    return { ok: true, masked: maskKey(key), state: buildState(options) }
  }

  if (route === 'command-code/test' && req.method === 'POST') {
    // The tester takes the key explicitly; it does not look one up itself.
    const key = readCommandCodeKey()
    if (typeof key !== 'string' || key.length === 0) {
      return { result: { ok: false, reason: 'missing', message: '还没有填写 API Key。' } }
    }
    const result = await testCommandCodeKey({ apiKey: key })
    return { result, state: buildState(options) }
  }

  if (route === 'command-code/clear' && req.method === 'POST') {
    // An empty value removes the stored key, which is how the helper signals
    // "forget this credential".
    writeCommandCodeKey('')
    return { ok: true, state: buildState(options) }
  }

  send(404, { error: `未知接口：${route}` })
  return undefined
}

/**
 * Forward one chat completion.
 *
 * Streams the answer as it arrives when the caller asks for a stream, and collects
 * it into a single JSON body otherwise. Either way the client speaks the OpenAI
 * shape, so an existing tool only needs its base URL changed.
 *
 * @param req - the incoming request.
 * @param res - the response to write to.
 * @param options - server options, for the data directory.
 */
async function handleChat(req, res, options) {
  const fail = (status, message) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ error: { message } }))
  }

  if (req.method !== 'POST') return fail(405, '只接受 POST。')

  let payload
  try {
    payload = await readJson(req)
  } catch (error) {
    return fail(400, error instanceof Error ? error.message : String(error))
  }

  const requested = typeof payload?.model === 'string' ? payload.model : ''
  const parsed = parseModel(requested, 'cn')
  if (parsed === null) {
    return fail(400, `不认识的模型「${requested}」。可用模型请见 /api/state 的 models。`)
  }

  const built = buildPool(options.dataDir)
  if (built.ok !== true) return fail(503, built.error)

  const controller = new AbortController()
  // A client that hangs up mid-answer must stop the upstream request too,
  // otherwise the account stays claimed.
  res.on('close', () => controller.abort())

  const forwarded = await forwardChat({
    pool: built.pool,
    site: parsed.site,
    model: parsed.upstream,
    payload,
    signal: controller.signal
  })
  if (forwarded.ok !== true) {
    return fail(forwarded.status ?? 503, forwarded.error ?? '上游调用失败。')
  }

  const wantsStream = payload.stream === true
  const model = requested

  if (wantsStream === true) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      // Proxies in between must not buffer, or the answer arrives all at once.
      'x-accel-buffering': 'no'
    })
    try {
      for await (const bytes of pumpAnswer(forwarded, controller.signal)) {
        res.write(bytes)
      }
    } catch (error) {
      // The stream is already in progress, so the only honest report is a final
      // error event rather than an HTTP status the client can no longer see.
      res.write(`data: ${JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } })}\n\n`)
    }
    res.end()
    return
  }

  // Non-streaming: collect the frames and assemble one reply.
  const chunks = []
  for await (const bytes of pumpAnswer(forwarded, controller.signal)) {
    chunks.push(Buffer.from(bytes).toString('utf8'))
  }
  const joined = chunks.join('')
  let content = ''
  let model_used = model
  for (const line of joined.split('\n')) {
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (data.length === 0 || data === '[DONE]') continue
    try {
      const frame = JSON.parse(data)
      if (typeof frame.model === 'string') model_used = frame.model
      const delta = frame.choices?.[0]?.delta?.content
      if (typeof delta === 'string') content += delta
    } catch {
      // A frame that does not parse contributes nothing.
    }
  }
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify({
    id: `chatcmpl-${Date.now().toString(36)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model_used,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }]
  }))
}

/** Where the built page lives, relative to this module. */
function defaultUiDir() {
  const here = fileURLToPath(new URL('.', import.meta.url))
  // ../../ui/dist from packages/server/src/
  return normalize(join(here, '..', '..', 'ui', 'dist'))
}

/** Serve the built single-page app. */
function serveStatic(pathname, uiDir, res, ui) {
  // A packaged build answers from its embedded copy first.
  if (ui !== undefined && typeof ui.read === 'function') {
    const hit = ui.read(pathname)
    if (hit !== undefined) {
      res.writeHead(200, { 'content-type': hit.type, 'cache-control': 'no-store' })
      res.end(hit.body)
      return
    }
  }

  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const target = normalize(join(uiDir, relative))

  // Refuse anything that escapes the UI directory.
  if (!target.startsWith(normalize(uiDir))) {
    res.writeHead(403).end('禁止访问。')
    return
  }

  const file = existsSync(target) && statSync(target).isFile() ? target : join(uiDir, 'index.html')
  if (!existsSync(file)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('界面尚未构建。请先在 packages/ui 运行 npm run build。')
    return
  }
  const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream'
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(readFileSync(file))
}
