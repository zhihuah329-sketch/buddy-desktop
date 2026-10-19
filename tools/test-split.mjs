/**
 * Check that the two upstreams stay apart.
 *
 * Each product is reached on its own path with its own key. A model name from one
 * must not resolve on the other's path, and a key minted for one must not open the
 * other — otherwise the two bills merge without anyone choosing that.
 */
const B = 'http://127.0.0.1:5178'

/** One call, returning the status and a short description. */
async function call(path, body, key) {
  const headers = { 'content-type': 'application/json' }
  if (key !== undefined) headers.authorization = `Bearer ${key}`
  const response = await fetch(B + path, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  })
  let detail = ''
  try {
    const parsed = await response.json()
    detail = parsed.choices?.[0]?.message?.content ?? parsed.error?.message ?? ''
  } catch {
    detail = ''
  }
  return { status: response.status, detail: String(detail).slice(0, 70) }
}

let failed = 0
function check(name, ok, detail) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failed += 1
}

console.log('=== 模型列表分开 ===')
const wb = await (await fetch(`${B}/v1/models`)).json()
check('/v1/models 只有 WorkBuddy 模型', wb.data.every((m) => m.owned_by === 'workbuddy'), `${wb.data.length} 个`)
const cc = await (await fetch(`${B}/v1/cc/models`)).json()
check('/v1/cc/models 只有 Command Code 模型', cc.data.every((m) => m.owned_by === 'command-code'), `${cc.data.length} 个`)
check('两组没有重叠', wb.data.every((m) => !cc.data.some((n) => n.id === m.id)))

console.log('\n=== 跨路径调用被拒绝 ===')
let r = await call('/v1/chat/completions', { model: 'gpt-5.5', messages: [{ role: 'user', content: 'hi' }] })
check('WorkBuddy 路径拒绝 CC 模型', r.status === 400 && r.detail.includes('Command Code'), `${r.status} ${r.detail}`)
r = await call('/v1/cc/chat/completions', { model: 'deepseek-v4.1-flash-cn', messages: [{ role: 'user', content: 'hi' }] })
check('CC 路径拒绝 WorkBuddy 模型', r.status === 400 && r.detail.includes('Command Code 没有模型'), `${r.status} ${r.detail}`)

console.log('\n=== 密钥按来源隔离 ===')
const wbKey = (await (await fetch(`${B}/api/keys`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ label: '仅 WorkBuddy', scope: 'workbuddy' })
})).json()).key
const ccKey = (await (await fetch(`${B}/api/keys`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ label: '仅 Command Code', scope: 'command-code' })
})).json()).key
check('密钥都是 sk- 开头', wbKey.startsWith('sk-') && ccKey.startsWith('sk-'))

const wbModelsNoKey = await fetch(`${B}/v1/models`)
check('有密钥后列表需要密钥', wbModelsNoKey.status === 401, String(wbModelsNoKey.status))
const wbModelsWithWb = await fetch(`${B}/v1/models`, { headers: { authorization: `Bearer ${wbKey}` } })
check('WorkBuddy 密钥可读 WorkBuddy 列表', wbModelsWithWb.status === 200, String(wbModelsWithWb.status))
const ccModelsWithWb = await fetch(`${B}/v1/cc/models`, { headers: { authorization: `Bearer ${wbKey}` } })
check('WorkBuddy 密钥读不了 CC 列表', ccModelsWithWb.status === 401, String(ccModelsWithWb.status))
const ccModelsWithCc = await fetch(`${B}/v1/cc/models`, { headers: { authorization: `Bearer ${ccKey}` } })
check('CC 密钥可读 CC 列表', ccModelsWithCc.status === 200, String(ccModelsWithCc.status))

// Clean up so the next run starts from no keys.
const list = await (await fetch(`${B}/api/keys`)).json()
for (const key of list.keys ?? []) {
  await fetch(`${B}/api/keys`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: key.id, remove: true })
  })
}

console.log('')
console.log(failed === 0 ? '全部通过' : `${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
