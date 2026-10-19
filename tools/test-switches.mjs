/**
 * Prove the three switches actually gate model calls.
 *
 * A switch that reports its state but does not stop a request is worse than no
 * switch: the user believes a pool is quiet while it keeps spending quota. Each
 * combination is therefore checked against a real call.
 *
 * Run: node tools/test-switches.mjs [port]
 */

const port = process.argv[2] ?? '5178'
const BASE = `http://127.0.0.1:${port}`

/** Call one model and describe what came back. */
async function call(model) {
  const response = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: '回复两个字' }]
    })
  })
  const body = await response.json()
  if (body.error) return `拒绝：${body.error.message}`
  return `通过：${body.choices?.[0]?.message?.content ?? '(空)'}`
}

/** Set one switch. */
async function setSwitch(name, enabled) {
  const response = await fetch(`${BASE}/api/switches`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, enabled })
  })
  const body = await response.json()
  if (body.ok !== true) throw new Error(`${name} 切换失败: ${body.error}`)
  return body.switches
}

const scenarios = [
  { name: '全部开启', state: { master: true, cn: true, ai: true } },
  { name: '只关国内版', state: { master: true, cn: false, ai: true } },
  { name: '只关国际版', state: { master: true, cn: true, ai: false } },
  { name: '关闭总开关', state: { master: false, cn: true, ai: true } }
]

for (const scenario of scenarios) {
  for (const [name, enabled] of Object.entries(scenario.state)) {
    await setSwitch(name, enabled)
  }
  const cn = await call('deepseek-v4.1-flash-cn')
  const ai = await call('deepseek-v4.1-flash-ai')
  console.log(`\n${scenario.name}`)
  console.log(`  国内版  ${cn}`)
  console.log(`  国际版  ${ai}`)
}

// Leave every switch open: the test must not change what the user finds afterwards.
for (const name of ['master', 'cn', 'ai']) await setSwitch(name, true)
console.log('\n已恢复：三个开关全部开启')
