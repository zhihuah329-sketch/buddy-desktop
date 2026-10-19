/**
 * Prove the access keys work as advertised.
 *
 * Three claims are checked, because each is the reason the feature exists:
 * creating a key protects the endpoint, a valid key passes, and revoking it stops
 * that key without disturbing the others.
 *
 * Run: node tools/test-keys.mjs [port]
 */

const BASE = `http://127.0.0.1:${process.argv[2] ?? '5178'}`

let failures = 0
let checks = 0

function check(label, ok, detail = '') {
  checks += 1
  if (!ok) failures += 1
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
}

/** POST JSON and return the parsed body. */
async function post(path, body, headers = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  })
  return { status: response.status, body: await response.json() }
}

/** Patch JSON. */
async function patch(path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  return { status: response.status, body: await response.json() }
}

/** One model call with an optional key. */
async function call(key) {
  const headers = { 'content-type': 'application/json' }
  if (key !== undefined) headers.authorization = `Bearer ${key}`
  const response = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash-cn',
      messages: [{ role: 'user', content: '说：好' }]
    })
  })
  return { status: response.status, body: await response.json() }
}

// Start from no keys, so "no key required" is tested on its own.
console.log('=== 清理旧密钥 ===')
const existing = await (await fetch(`${BASE}/api/keys`)).json()
for (const record of existing.keys ?? []) {
  await patch('/api/keys', { id: record.id, remove: true })
}
check('起始状态无密钥', (await (await fetch(`${BASE}/api/keys`)).json()).keys.length === 0)

console.log('\n=== 没有密钥时不限制 ===')
const open = await call()
check('无密钥可调用', open.status === 200 && open.body.choices !== undefined,
  open.body.choices?.[0]?.message?.content?.slice(0, 20) ?? JSON.stringify(open.body).slice(0, 60))

console.log('\n=== 创建密钥 ===')
const created = await post('/api/keys', { label: '测试密钥' })
check('创建成功', created.body.ok === true, created.body.error ?? '')
const key = created.body.key
check('返回明文密钥', typeof key === 'string' && key.startsWith('sk-'), key?.slice(0, 10))
check('列表不含明文', JSON.stringify(created.body.keys).includes(key) === false,
  `列表项: ${Object.keys(created.body.keys?.[0] ?? {}).join(',')}`)

console.log('\n=== 有了密钥之后必须带 ===')
const without = await call()
check('无密钥被拒绝', without.status === 401, `HTTP ${without.status} ${without.body.error?.message ?? ''}`)

const wrong = await call('sk-wrong-key-value')
check('错误密钥被拒绝', wrong.status === 401, `HTTP ${wrong.status}`)

const withKey = await call(key)
check('正确密钥通过', withKey.status === 200 && withKey.body.choices !== undefined,
  withKey.body.choices?.[0]?.message?.content?.slice(0, 20) ?? JSON.stringify(withKey.body).slice(0, 60))

console.log('\n=== 记录使用时间 ===')
const afterUse = await (await fetch(`${BASE}/api/keys`)).json()
check('已记录使用时间', (afterUse.keys?.[0]?.lastUsedAt ?? 0) > 0,
  String(afterUse.keys?.[0]?.lastUsedAt ?? 0))

console.log('\n=== 停用与启用 ===')
const id = afterUse.keys[0].id
await patch('/api/keys', { id, enabled: false })
const disabled = await call(key)
check('停用后拒绝', disabled.status === 401, `HTTP ${disabled.status}`)

await patch('/api/keys', { id, enabled: true })
const reenabled = await call(key)
check('重新启用后通过', reenabled.status === 200, `HTTP ${reenabled.status}`)

console.log('\n=== 两个密钥互不影响 ===')
const second = await post('/api/keys', { label: '第二个' })
const secondKey = second.body.key
await patch('/api/keys', { id, remove: true })
const firstGone = await call(key)
check('删除第一个后被拒绝', firstGone.status === 401, `HTTP ${firstGone.status}`)
const secondWorks = await call(secondKey)
check('第二个仍然可用', secondWorks.status === 200, `HTTP ${secondWorks.status}`)

// Leave the machine as it was found: no keys, so the endpoint is open again.
const finalList = await (await fetch(`${BASE}/api/keys`)).json()
for (const record of finalList.keys ?? []) {
  await patch('/api/keys', { id: record.id, remove: true })
}
const restored = await call()
check('清理后恢复开放', restored.status === 200, `HTTP ${restored.status}`)

console.log('')
console.log(failures === 0 ? `全部通过（${checks} 项）` : `${failures}/${checks} 项失败`)
process.exitCode = failures === 0 ? 0 : 1
