/**
 * Drive the installed plugin the way the harness will.
 *
 * Checking that the adapter lists models proves the shape is right; it does not
 * prove a conversation works. This calls the adapter's own stream method against the
 * running desktop app, so a broken request format or a mismatched event type shows
 * up here rather than in a user's session.
 *
 * Run: node tools/test-plugin.mjs [appPort]
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

const PORT = process.argv[2] ?? '5178'
// The plugin is installed by the app, so it is read from the harness rather than
// from this repository: that is the copy the harness will actually load.
const PROFILES = [
  process.env.DSH_PROFILE_DIR,
  'D:\\DeepSeekHarnessData\\harness\\profiles\\desktop',
  join(process.env.USERPROFILE ?? '', '.dsh', 'profiles', 'desktop')
].filter(Boolean)

const pluginDir = PROFILES
  .map((profile) => join(profile, 'node_modules', 'dsh-command-buddy-connect-standalone'))
  .find((dir) => existsSync(join(dir, 'index.js')))

if (pluginDir === undefined) {
  console.error('找不到已安装的插件。请先启动桌面应用让它安装。')
  process.exit(1)
}

let failures = 0
let checks = 0

function check(label, ok, detail = '') {
  checks += 1
  if (!ok) failures += 1
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
}

const module = await import(`file:///${pluginDir.replace(/\\/g, '/')}/index.js`)

console.log('=== 插件身份 ===')
check('provider id 是 command-buddy-connect', module.PROVIDER_ID === 'command-buddy-connect',
  module.PROVIDER_ID)
check('显示名是 Command Buddy Connect', module.PROVIDER_NAME === 'Command Buddy Connect',
  module.PROVIDER_NAME)
check('默认导出带 apply', typeof module.default?.apply === 'function')

console.log('\n=== 适配器接口 ===')
const adapter = new module.DesktopAdapter({ base: `http://127.0.0.1:${PORT}/v1` })
for (const method of ['listModels', 'resolveModel', 'prepareCall', 'stream']) {
  check(`实现了 ${method}`, typeof adapter[method] === 'function')
}

const models = await adapter.listModels(module.PROVIDER_ID)
check('列出 2 个模型', models.length === 2, models.map((m) => m.id).join(', '))
check('模型带 provider 字段', models.every((m) => m.provider === module.PROVIDER_ID))
check('模型带文本模态', models.every((m) => m.inputModalities?.includes('text')))

const resolved = await adapter.resolveModel(module.PROVIDER_ID, 'deepseek-v4.1-flash-cn')
check('能解析已知模型', resolved.id === 'deepseek-v4.1-flash-cn')
check('带上下文窗口', typeof resolved.context?.contextWindow === 'number',
  String(resolved.context?.contextWindow))

try {
  await adapter.resolveModel(module.PROVIDER_ID, 'no-such-model')
  check('未知模型应当报错', false, '没有报错')
} catch (error) {
  check('未知模型报错', true, error.message.slice(0, 50))
}

console.log('\n=== 真实调用（国内版）===')
async function collect(model) {
  const events = []
  for await (const event of adapter.stream({
    model,
    messages: [{ role: 'user', content: '说：好' }]
  })) {
    events.push(event)
  }
  return events
}

try {
  const events = await collect('deepseek-v4.1-flash-cn')
  const text = events.filter((e) => e.type === 'text').map((e) => e.text).join('')
  check('收到文本事件', text.length > 0, text.slice(0, 40))
  check('事件类型正确', events.every((e) => e.type === 'text' || e.type === 'reasoning'),
    [...new Set(events.map((e) => e.type))].join(','))
} catch (error) {
  check('国内版调用成功', false, error.message.slice(0, 80))
}

console.log('\n=== 真实调用（国际版）===')
try {
  const events = await collect('deepseek-v4.1-flash-ai')
  const text = events.filter((e) => e.type === 'text').map((e) => e.text).join('')
  check('收到文本事件', text.length > 0, text.slice(0, 40))
} catch (error) {
  check('国际版调用成功', false, error.message.slice(0, 80))
}

console.log('\n=== 桌面应用没启动时的表现 ===')
const orphan = new module.DesktopAdapter({ base: 'http://127.0.0.1:59999/v1' })
try {
  const events = []
  for await (const event of orphan.stream({
    model: 'deepseek-v4.1-flash-cn',
    messages: [{ role: 'user', content: 'hi' }]
  })) {
    events.push(event)
  }
  check('连不上时应当报错', false, '没有报错')
} catch (error) {
  check('连不上时给出可读提示', /桌面应用|运行/.test(error.message), error.message.slice(0, 60))
}

console.log('')
console.log(failures === 0 ? `全部通过（${checks} 项）` : `${failures}/${checks} 项失败`)
process.exitCode = failures === 0 ? 0 : 1
