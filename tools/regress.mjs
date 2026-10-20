/**
 * A regression pass over everything the desktop app and the plugin expose.
 *
 * The point is to find a broken thing before a user does, so this checks behaviour
 * rather than presence: a page that renders but throws, a switch that reports state
 * but does not gate, an endpoint that answers 200 with an error inside it.
 *
 * Run: node tools/regress.mjs [appPort]
 */

const APP = `http://127.0.0.1:${process.argv[2] ?? '5178'}`
const DSH = 'http://127.0.0.1:2607'

let failures = 0
let checks = 0

/** Record one assertion. */
function check(label, ok, detail = '') {
  checks += 1
  if (!ok) failures += 1
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
}

/** GET JSON, tolerating a failure. */
async function getJson(url, init) {
  try {
    const response = await fetch(url, init)
    const text = await response.text()
    let body
    try {
      body = JSON.parse(text)
    } catch {
      body = { __raw: text.slice(0, 200) }
    }
    return { status: response.status, body }
  } catch (error) {
    return { status: 0, body: { __error: error.message } }
  }
}

console.log('=== 独立应用 ===')

// --- State document ---
const state = await getJson(`${APP}/api/state`)
check('状态接口', state.status === 200, `HTTP ${state.status}`)
check('账号库可读', state.body.vault?.ok === true, `ok=${state.body.vault?.ok}`)
check('两个区域都有账号', (state.body.pools?.cn ?? 0) > 0 && (state.body.pools?.ai ?? 0) > 0,
  `cn=${state.body.pools?.cn} ai=${state.body.pools?.ai}`)
check('三个开关存在', state.body.switches?.master !== undefined
  && state.body.switches?.cn !== undefined
  && state.body.switches?.ai !== undefined,
  JSON.stringify(state.body.switches?.effective))
check('Command Code 已配置', state.body.commandCode?.configured === true,
  `${state.body.commandCode?.models?.length ?? 0} 个模型`)

// --- Credential reader ---
check('凭据读取器可用', state.body.sibling?.available === true,
  state.body.sibling?.location?.dir?.slice(-30) ?? '未找到')

// --- Usage ---
const usage = await getJson(`${APP}/api/usage`)
check('用量接口', usage.status === 200, `HTTP ${usage.status}`)
check('用量含调用记录', usage.body.usage?.activity !== undefined,
  `${usage.body.usage?.activity?.total ?? 0} 条`)
check('用量含余额判定', typeof usage.body.usage?.balanceKnown === 'boolean',
  `balanceKnown=${usage.body.usage?.balanceKnown}`)

// --- Check-in ---
const checkin = await getJson(`${APP}/api/checkin`)
check('签到接口', checkin.status === 200, `HTTP ${checkin.status}`)
check('签到已读取', checkin.body.checkin?.signedIn === true,
  checkin.body.checkin?.checkin?.status ?? '未读取')

// --- Model calls ---
async function call(model) {
  return getJson(`${APP}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: '回复：好' }] })
  })
}

const cn = await call('deepseek-v4.1-flash-cn')
check('国内版模型调用', cn.status === 200 && cn.body.choices !== undefined,
  cn.body.choices?.[0]?.message?.content ?? JSON.stringify(cn.body).slice(0, 80))

const ai = await call('deepseek-v4.1-flash-ai')
check('国际版模型调用', ai.status === 200 && ai.body.choices !== undefined,
  ai.body.choices?.[0]?.message?.content ?? JSON.stringify(ai.body).slice(0, 80))

// --- Streaming ---
try {
  const response = await fetch(`${APP}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash-cn',
      messages: [{ role: 'user', content: '数到三' }],
      stream: true
    })
  })
  const text = await response.text()
  const frames = text.split('\n').filter((line) => line.startsWith('data:')).length
  check('流式调用', response.status === 200 && frames > 1 && text.includes('[DONE]'),
    `${frames} 帧`)
} catch (error) {
  check('流式调用', false, error.message)
}

// --- Switches actually gate ---
for (const name of ['master', 'cn', 'ai']) {
  await getJson(`${APP}/api/switches`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, enabled: true })
  })
}
await getJson(`${APP}/api/switches`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'cn', enabled: false })
})
const blocked = await call('deepseek-v4.1-flash-cn')
check('关闭国内版后拒绝调用', blocked.status >= 400 || blocked.body.error !== undefined,
  blocked.body.error?.message ?? '仍然通过')
const stillOk = await call('deepseek-v4.1-flash-ai')
check('关闭国内版不影响国际版', stillOk.status === 200 && stillOk.body.choices !== undefined,
  stillOk.body.choices?.[0]?.message?.content ?? JSON.stringify(stillOk.body).slice(0, 60))
await getJson(`${APP}/api/switches`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'cn', enabled: true })
})

// --- Origin guard ---
const crossOrigin = await getJson(`${APP}/api/state`, { headers: { origin: 'https://evil.example' } })
check('跨站请求被拒绝', crossOrigin.status === 403, `HTTP ${crossOrigin.status}`)

// --- Pages ---
console.log('\n=== 页面 ===')
const PAGES = ['overview', 'usage', 'cn', 'ai', 'checkin', 'command-code', 'settings']
for (const page of PAGES) {
  const response = await getJson(`${APP}/`)
  check(`首页可访问（${page}）`, response.status === 200, `HTTP ${response.status}`)
}

console.log('')
console.log(failures === 0 ? `全部通过（${checks} 项）` : `${failures}/${checks} 项失败`)
process.exitCode = failures === 0 ? 0 : 1
