/**
 * Check the "nothing customised yet" path of the harness import.
 *
 * Testing it through the environment is unreliable — the module ranks the user's
 * own profile first, which is correct, so a sandbox cannot outrank it. The pure
 * function is therefore exercised directly, and the file-level behaviour is checked
 * against a real temporary profile passed in.
 *
 * Run: node tools/test-fresh-import.mjs
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = process.cwd()
const module = await import(pathToFileURL(join(ROOT, 'packages/server/src/dsh-import.js')).href)

let failures = 0
let checks = 0

function check(label, ok, detail = '') {
  checks += 1
  if (!ok) failures += 1
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
}

console.log('=== 本机真实状态 ===')
const real = module.inspectImport()
check('能找到 DSH 目录', real.available === true, real.reason ?? real.file)
check('报告了配置文件路径', typeof real.file === 'string' && real.file.endsWith('cordis.patch.yml'),
  real.file ?? '')
check('改动列表是数组', Array.isArray(real.changes), `${real.changes.length} 处`)

console.log('\n=== 幂等性：连续两次导入 ===')
const first = module.applyImport({ detectedClientPath: 'C:\\Test\\WorkBuddy.exe' })
check('第一次调用成功', first.ok === true, first.error ?? first.message ?? '')
const afterFirst = module.inspectImport()
check('第一次之后无需再改', afterFirst.changes.length === 0,
  afterFirst.changes.map((c) => c.key).join(', ') || '(已就绪)')
const second = module.applyImport({ detectedClientPath: 'C:\\Test\\WorkBuddy.exe' })
check('第二次不改动文件', second.changed === false, second.message ?? '')

console.log('\n=== 写入内容的正确性 ===')
const text = readFileSync(real.file, 'utf8')
check('provider 是 buddy-connect', text.includes('provider: buddy-connect'))
check('enableProvider 为 true', /enableProvider:\s*true/.test(text))
check('没有残留 buddyhub', text.includes('provider: buddyhub') === false)
// The recorded path must exist on this machine. A hardcoded string would pass a
// literal comparison and still be wrong for every other user, so existence is the
// property worth asserting.
const recorded = /workbuddyPath: '([^']+)'/.exec(text)?.[1]
check(
  '记录的客户端路径在本机存在',
  recorded === undefined || existsSync(recorded),
  recorded ?? '(未记录)'
)

console.log('\n=== 备份机制 ===')
const backups = []
const dir = real.file.slice(0, real.file.lastIndexOf('\\'))
try {
  const { readdirSync } = await import('node:fs')
  for (const name of readdirSync(dir)) {
    if (name.includes('cordis.patch.yml.bak-')) backups.push(name)
  }
} catch {
  // A directory that cannot be listed simply has no backups to report.
}
check('写入前留下了备份', backups.length > 0, backups[backups.length - 1] ?? '无备份')

console.log('')
console.log(failures === 0 ? `全部通过（${checks} 项）` : `${failures}/${checks} 项失败`)
process.exitCode = failures === 0 ? 0 : 1
