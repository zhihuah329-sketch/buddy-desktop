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
import { Switches } from './switches.js'
import { buildUsage } from './usage.js'
import { forwardToCommandCode } from './cc-forward.js'
import { readSettings, writeSettings } from './settings.js'
import { countChars, recordCall, summariseActivity } from './activity.js'
import { createKey, publicKeys, updateKey, verifyKey } from './api-keys.js'
import { applyImport, inspectImport, watchImport } from './dsh-import.js'
import {
  PLUGIN_PROVIDER_ID,
  PLUGIN_PROVIDER_NAME,
  inspectPlugin,
  installPlugin
} from './install-plugin.js'

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
/**
 * The bearer token on a request.
 *
 * @param req - the incoming request.
 * @returns the token, or an empty string when there is none.
 */
function bearer(req) {
  const header = req.headers.authorization
  if (typeof header !== 'string') return ''
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match === null ? '' : match[1].trim()
}

/**
 * Whether a request comes from this app's own harness plugin.
 *
 * Two conditions together: the connection originates on the loopback interface, and
 * the client identifies itself. The header alone would be trivial to forge from
 * another local program, so the loopback check is what carries the weight — a remote
 * caller cannot claim to be loopback.
 *
 * This is not a security boundary against a hostile process on the same machine; no
 * loopback-only scheme is. It exists so a normal user is not asked to copy a key
 * into another program to use the feature they just enabled.
 *
 * @param req - the incoming request.
 * @returns whether the request is the local plugin.
 */
function isLocalClient(req) {
  if (req.headers['x-buddy-desktop-client'] !== 'plugin') return false
  const remote = req.socket?.remoteAddress ?? ''
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
}

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
  // A path the user chose wins over everything: detection guesses well on a default
  // install and badly on the others, and a choice once made should not be re-guessed
  // on the next launch.
  const stored = readSettings(options.dataDir)

  // The discovered CN client is what the region panel should name, so it is passed
  // through as the configured path when the caller did not set one explicitly.
  const cnClient = stored.workbuddyPath.length > 0
    ? stored.workbuddyPath
    : (options.workbuddyPath ?? electron)
  const intlClient = stored.workbuddyIntlPath.length > 0
    ? stored.workbuddyIntlPath
    : options.workbuddyIntlPath

  const clients = {}
  for (const site of ['cn', 'ai']) {
    const resolved = resolveClientForSite({
      site,
      ...(cnClient === undefined ? {} : { configured: cnClient }),
      ...(intlClient === undefined ? {} : { intlPath: intlClient })
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
    // The paths the user chose, which is what the settings page edits.
    settings: stored,
    // What the harness needs in order to offer these models, and under which name.
    plugin: {
      ...inspectPlugin({ port: options.port }),
      providerId: PLUGIN_PROVIDER_ID,
      providerName: PLUGIN_PROVIDER_NAME
    },
    // What the page's switches should show, including the effective state.
    switches: options.switches?.snapshot() ?? null,
    // How many keys exist, so the page can say whether the endpoint is protected.
    keyCount: options.dataDir === undefined
      ? publicKeys().length
      : publicKeys(options.dataDir).length,
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
  // Three switches: a master gate for the endpoint, and one per region so a pool
  // can be silenced on its own.
  const switches = new Switches()

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

  // Register the models in DeepSeek Harness automatically on every start. A user who
  // has to find a page and press a button to make the app work has been given a
  // setup step they did not ask for; doing it here means installing the app is
  // enough. Failure is silent because the harness may not be installed at all.
  setTimeout(() => {
    try {
      const detected = resolveClientForSite({ site: 'cn' })
      const options = { detectedClientPath: detected?.path }
      const result = applyImport(options)
      if (result.ok === true && result.changed === true) {
        console.log(`DSH 配置已更新: ${result.file}`)
      }
      // The harness rewrites its patch file whenever its own settings are saved, so
      // a single write at startup is not enough: the stale provider has to be
      // repaired again after each save.
      watchImport(options)

      // Installing the provider plugin is what makes the models appear at all.
      // It is idempotent, so running it on every start also applies an upgrade.
      const plugin = installPlugin({ port: options.port })
      if (plugin.ok === true && plugin.changed === true) {
        console.log(`已安装 ${PLUGIN_PROVIDER_NAME} 到 ${plugin.profile}`)
      }
    } catch {
      // Another program's configuration is not a reason to fail this one.
    }
  }, 1500)

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${host}`)

    // A bare `/v1` or `/v1/` is what some clients probe before anything else. It is
    // answered here rather than falling through to the static host, which would send
    // the app's HTML page and be reported as "did not answer with JSON".
    if (url.pathname === '/v1' || url.pathname === '/v1/') {
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store'
      })
      res.end(JSON.stringify({
        object: 'api',
        message: 'Buddy Desktop',
        // The two products are separate paths, so a tool is pointed at the one it
        // wants rather than at a single list that mixes them.
        endpoints: {
          workbuddy: { models: '/v1/models', chat: '/v1/chat/completions' },
          commandCode: { models: '/v1/cc/models', chat: '/v1/cc/chat/completions' }
        }
      }))
      return
    }

    // The model lists, in the OpenAI shape. A client that takes a base URL asks for
    // this before anything else, and answering with the app's HTML page makes it
    // report that the endpoint "did not answer with JSON" — which is what a user sees
    // when they add the endpoint by hand.
    //
    // The two upstreams are answered on separate paths. They are separate products
    // with separate credentials and separate bills, so a tool pointed at one must not
    // see the other's models and conclude they are interchangeable.
    const isCcRoute = url.pathname === '/v1/cc/models'
    if (url.pathname === '/v1/models' || url.pathname === '/models' || isCcRoute) {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: { message: '只接受 GET。' } }))
        return
      }
      const routeScope = isCcRoute ? 'command-code' : 'workbuddy'
      // The same key rule as the chat route: protected once any key exists.
      const listingKeys = publicKeys(options.dataDir)
      if (listingKeys.length > 0 && isLocalClient(req) !== true) {
        const presented = bearer(req)
        if (verifyKey(options.dataDir, presented, routeScope) === undefined) {
          res.writeHead(401, {
            'content-type': 'application/json; charset=utf-8',
            'www-authenticate': 'Bearer realm="buddy-desktop"'
          })
          res.end(JSON.stringify({ error: { message: '这个接口已经启用密钥，请带上 Bearer <密钥>。' } }))
          return
        }
      }
      const now = Math.floor(Date.now() / 1000)
      const state = buildState(options)
      const listed = isCcRoute
        ? (state.commandCode?.models ?? []).map((model) => ({
            id: model.id,
            object: 'model',
            created: now,
            owned_by: 'command-code'
          }))
        : (state.models ?? []).map((model) => ({
            id: model,
            object: 'model',
            created: now,
            owned_by: 'workbuddy'
          }))
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store'
      })
      res.end(JSON.stringify({ object: 'list', data: listed }))
      return
    }

    // The model endpoint streams, so it is handled before the JSON route: it
    // writes its own headers and body and must not go through `send`.
    if (
      url.pathname === '/v1/chat/completions' ||
      url.pathname === '/chat/completions' ||
      url.pathname === '/v1/cc/chat/completions'
    ) {
      if (!originAllowed(req.headers.origin)) {
        res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: { message: '来源不被允许。' } }))
        return
      }
      // A key is required only once one exists. That keeps a fresh install working
      // without setup, and makes creating a key the moment the endpoint becomes
      // protected — which is the behaviour a user expects from "add a key".
      // Protection follows the *enabled* keys. A list of keys that are all disabled
      // would otherwise lock the endpoint while offering no way in, which is the
      // worst of both states.
      // Protection follows whether any key exists, not whether one is currently
      // enabled. Treating "all keys disabled" as "no keys" would reopen the endpoint
      // the moment a user disabled their last key — the opposite of what disabling a
      // credential is meant to achieve.
      const allKeys = publicKeys(options.dataDir)
      // The harness plugin this app installs talks to this endpoint from the same
      // machine. Requiring a key there would mean pasting a credential into another
      // program's config to use a feature just switched on, so the plugin identifies
      // itself instead.
      const localPlugin = isLocalClient(req)
      if (allKeys.length > 0 && localPlugin !== true) {
        const presented = bearer(req)
        // Scoped to the upstream this path serves, so a key minted for one product
        // does not spend the other.
        const gateScope = new URL(req.url, 'http://127.0.0.1').pathname.startsWith('/v1/cc/') ? 'command-code' : 'workbuddy'
        const matched = verifyKey(options.dataDir, presented, gateScope)
        if (matched === undefined) {
          res.writeHead(401, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            'www-authenticate': 'Bearer realm="buddy-desktop"'
          })
          res.end(JSON.stringify({
            error: {
              message: presented === ''
                ? '这个接口已经启用密钥，请在 Authorization 头里带上 Bearer <密钥>。'
                : '密钥无效或已被停用。'
            }
          }))
          return
        }
      }

      // The switches live on the server, not in that object, so they are handed over
      // explicitly; without this the call would read them as absent and refuse.
      await handleChat(req, res, { ...options, switches, scheduler })
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
        const result = await handleApi(req, url, send, { ...options, ...served, scheduler, switches })
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
    ...(options.switches === undefined ? {} : { switches: options.switches }),
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.actualPort === undefined ? {} : { actualPort: options.actualPort }),
    // The port this app actually listens on. The generated provider plugin points at
    // it, so handleApi needs it here rather than reaching for startServer's locals.
    port: options.actualPort ?? options.port ?? 5178
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
  // Keys for other tools. The plaintext is returned once, when it is created, and
  // never again: only its hash is kept.
  if (route === 'keys' && req.method === 'GET') {
    return { keys: publicKeys(options.dataDir) }
  }

  if (route === 'keys' && req.method === 'POST') {
    const body = await readJson(req)
    // The scope is what keeps the two products' bills apart, so it is passed through
    // rather than dropped: a key created for one must not open the other.
    const created = createKey(options.dataDir, { label: body?.label, scope: body?.scope })
    return { ok: true, key: created.key, record: created.record, keys: publicKeys(options.dataDir) }
  }

  if (route === 'keys' && req.method === 'PATCH') {
    const body = await readJson(req)
    const result = updateKey(options.dataDir, {
      id: body?.id,
      enabled: body?.enabled,
      remove: body?.remove
    })
    return { ...result, keys: publicKeys(options.dataDir) }
  }

  // The client paths a user chose. Only paths are accepted; anything else in the body
  // is ignored, so this cannot become a general settings backdoor.
  if (route === 'settings' && req.method === 'POST') {
    const body = await readJson(req)
    const settings = writeSettings(options.dataDir, {
      workbuddyPath: body?.workbuddyPath,
      workbuddyIntlPath: body?.workbuddyIntlPath
    })
    return { ok: true, settings, state: buildState(options) }
  }

  // The provider plugin. Separate from the profile import because they solve
  // different problems: the import points the harness at a provider that exists,
  // while this installs a provider of this app's own.
  if (route === 'plugin' && req.method === 'GET') {
    return { plugin: inspectPlugin({ port: options.port }) }
  }

  if (route === 'plugin' && req.method === 'POST') {
    const result = installPlugin({ port: options.port })
    return { ...result, plugin: inspectPlugin({ port: options.port }) }
  }

  // Importing into DeepSeek Harness: a report of what would change, then the change.
  if (route === 'dsh-import' && req.method === 'GET') {
    return { report: inspectImport() }
  }

  if (route === 'dsh-import' && req.method === 'POST') {
    const body = await readJson(req)
    // Detection, not a guess: the path recorded in another program's config has to
    // be the one on this machine.
    const detected = resolveClientForSite({ site: 'cn' })
    const result = applyImport({
      workbuddyPath: body?.workbuddyPath,
      detectedClientPath: detected?.path
    })
    return { ...result, report: inspectImport() }
  }

  // The switches. A single endpoint for all three, because they are one piece of
  // state and the page sends which one changed.
  // Usage and quota. Assembled from the same accounts the page already shows, plus
  // whatever the last check-in read, so the figures cannot disagree with them.
  if (route === 'usage' && req.method === 'GET') {
    const snapshot = buildState(options)
    const usage = buildUsage({ state: snapshot, checkin: snapshot.checkin })
    // The call record is what answers "which account and model served what"; the
    // pool's counters only know how many requests happened.
    usage.activity = summariseActivity(options.dataDir)
    return { usage }
  }

  if (route === 'switches' && req.method === 'POST') {
    const body = await readJson(req)
    const name = typeof body?.name === 'string' ? body.name : ''
    const changed = options.switches?.set(name, body?.enabled === true)
    if (changed === undefined) {
      return { ok: false, error: `未知开关：${name}`, switches: options.switches?.snapshot() ?? null }
    }
    return { ok: true, switches: options.switches.snapshot() }
  }

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
/**
 * Relay an upstream SSE body to the client, in either shape.
 *
 * Command Code answers with frames regardless of what the caller asked for, so the
 * choice between a stream and one JSON body is made here rather than upstream.
 *
 * @param response - the upstream response, already known to be ok.
 * @param res - the response to write to.
 * @param options - `model` to report, and `wantsStream`.
 */
async function relayFrames(response, res, options) {
  const frames = readSseFrames(response.body)

  if (options.wantsStream === true) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    })
    for await (const raw of frames) {
      res.write(raw)
    }
    res.end()
    return
  }

  // Collected: the deltas are joined and returned as one OpenAI-shaped body.
  let content = ''
  let modelUsed = options.model
  for await (const raw of frames) {
    for (const line of raw.split('\n')) {
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data.length === 0 || data === '[DONE]') continue
      try {
        const frame = JSON.parse(data)
        if (typeof frame.model === 'string') modelUsed = frame.model
        const delta = frame.choices?.[0]?.delta?.content
        if (typeof delta === 'string') content += delta
      } catch {
        // A frame that does not parse contributes nothing.
      }
    }
  }
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify({
    id: `chatcmpl-${Date.now().toString(36)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: modelUsed,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }]
  }))
}

/**
 * Split an SSE body into the raw frame blocks it is made of.
 *
 * @param body - the upstream body stream.
 * @yields each frame, with its terminating blank line.
 */
async function* readSseFrames(body) {
  if (body === null || body === undefined) return
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true })
    let boundary = buffer.indexOf('\n\n')
    while (boundary !== -1) {
      const raw = buffer.slice(0, boundary + 2)
      buffer = buffer.slice(boundary + 2)
      yield raw
      boundary = buffer.indexOf('\n\n')
    }
  }
  if (buffer.trim().length > 0) yield buffer
}

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

  // Which upstream answers is decided by the path, not by the model name: the two are
  // separate products with separate credentials, and guessing from a name would let a
  // model name reach the wrong bill. `/v1/cc/...` means Command Code.
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname
  const wantsCommandCode = pathname.startsWith('/v1/cc/')

  if (wantsCommandCode) {
    if (!CC_MODELS.some((entry) => entry.id === requested)) {
      return fail(
        400,
        `Command Code 没有模型「${requested}」。可用模型请见 /v1/cc/models。`
      )
    }
    const controller = new AbortController()
    res.on('close', () => controller.abort())

    const forwarded = await forwardToCommandCode({
      model: requested,
      payload: { ...payload, model: requested },
      signal: controller.signal
    })
    if (forwarded.ok !== true) {
      return fail(forwarded.status ?? 503, forwarded.error ?? 'Command Code 调用失败。')
    }

    recordCall(options.dataDir, {
      at: Date.now(),
      model: requested,
      site: 'cc',
      accountId: 'command-code',
      accountLabel: 'Command Code',
      promptChars: countChars(payload.messages),
      replyChars: null,
      ok: true,
      streamed: payload.stream === true,
      elapsedMs: 0
    })

    // The upstream answers in SSE frames whatever the caller asked for, so both
    // shapes are produced from the same relay.
    return relayFrames(forwarded.response, res, { model: requested, wantsStream: payload.stream === true })
  }

  if (CC_MODELS.some((entry) => entry.id === requested)) {
    return fail(
      400,
      `「${requested}」属于 Command Code，请改用 /v1/cc/chat/completions。`
    )
  }

  const parsed = parseModel(requested, 'cn')
  if (parsed === null) {
    return fail(400, `不认识的模型「${requested}」。可用模型请见 /api/state 的 models。`)
  }

  // A closed switch must stop the request before any account is picked, otherwise
  // the refusal itself costs quota.
  if (options.switches?.allows(parsed.site) !== true) {
    const master = options.switches?.state?.master !== false
    return fail(
      503,
      master
        ? `${parsed.site === 'ai' ? '国际版' : '国内版'}已在应用中关闭，打开该开关后才能调用。`
        : '服务总开关已关闭。在应用首页打开后才能调用。'
    )
  }

  const built = buildPool(options.dataDir)
  if (built.ok !== true) return fail(503, built.error)

  const controller = new AbortController()
  // A client that hangs up mid-answer must stop the upstream request too,
  // otherwise the account stays claimed.
  res.on('close', () => controller.abort())

  // Counted before forwarding: the figure should describe the request that was
  // made, not a copy of it taken afterwards.
  const promptChars = countChars(payload.messages)
  const startedAt = Date.now()

  // The pool's account objects carry no display name, so it is looked up in the
  // store they were built from. Recorded by name because an id tells a user nothing.
  const store = readVault(options.dataDir)
  const labelById = new Map(
    (store.ok === true ? store.accounts : [])
      .filter((account) => account.id !== undefined)
      .map((account) => [
        account.id,
        account.label ?? account.phoneSuffix ?? account.id.slice(0, 8)
      ])
  )

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
    // A stream has no single place where its length is known until the pump ends,
    // so the record is written here rather than per frame.
    recordCall(options.dataDir, {
      at: startedAt,
      model: requested,
      site: parsed.site,
      accountId: forwarded.account?.id,
      accountLabel: labelById.get(forwarded.account?.id),
      promptChars,
      replyChars: null,
      ok: true,
      streamed: true,
      elapsedMs: Date.now() - startedAt
    })
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
  recordCall(options.dataDir, {
    at: startedAt,
    model: requested,
    site: parsed.site,
    accountId: forwarded.account?.id,
    accountLabel: labelById.get(forwarded.account?.id),
    promptChars,
    replyChars: content.length,
    ok: true,
    streamed: false,
    elapsedMs: Date.now() - startedAt
  })

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
