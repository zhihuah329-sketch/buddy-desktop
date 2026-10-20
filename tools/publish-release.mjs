/**
 * Create a GitHub release and attach the installer.
 *
 * Uploads go through curl rather than fetch: curl speaks the SOCKS proxy this network
 * needs, can stream a 100 MB body straight off disk, and reports progress. Node's
 * fetch has no proxy support, and an upload that has to buffer the whole file first is
 * both slower and more likely to time out.
 *
 * Run: node tools/publish-release.mjs <tag> <installerPath>
 */
import { execFileSync } from 'node:child_process'
import { statSync } from 'node:fs'

const OWNER = 'zhihuah329-sketch'
const REPO = 'buddy-desktop'
const PROXY = process.env.GITHUB_PROXY ?? 'socks5h://127.0.0.1:7890'

const tag = process.argv[2]
const installer = process.argv[3]
if (tag === undefined || installer === undefined) {
  console.error('用法: node tools/publish-release.mjs <tag> <installerPath>')
  process.exit(1)
}

/** The token git stores, so this script needs no credential of its own. */
function credential() {
  const out = execFileSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8'
  })
  const match = out.match(/^password=(.+)$/m)
  if (match === null) throw new Error('git 里没有 GitHub 令牌。')
  return match[1]
}

const token = credential()

/** One API call. Returns the parsed body and the status. */
function api(path, options = {}) {
  const args = [
    '-sS',
    '--proxy', PROXY,
    '--max-time', '120',
    '-w', '\n%{http_code}',
    '-H', `authorization: Bearer ${token}`,
    '-H', 'accept: application/vnd.github+json',
    '-H', 'x-github-api-version: 2022-11-28',
    '-H', 'user-agent: buddy-desktop-release'
  ]
  const method = options.method ?? 'GET'
  if (method !== 'GET') args.push('-X', method)
  if (options.json !== undefined) {
    args.push('-H', 'content-type: application/json', '--data-binary', JSON.stringify(options.json))
  }
  args.push(`https://api.github.com${path}`)

  const out = execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  const split = out.lastIndexOf('\n')
  const status = Number.parseInt(out.slice(split + 1).trim(), 10)
  const text = out.slice(0, split)
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = { raw: text }
  }
  return { status, body }
}

const body = `## Buddy Desktop ${tag}

Windows 桌面版安装包。

### 功能

- **WorkBuddy 多账号池**：国内版 / 国际版分开管理，额度用尽自动切换到同区域的下一个账号
- **Command Code 通道**：Claude、GPT、Kimi、GLM 等 15 个模型
- **OpenAI 兼容接口**：任何支持自定义地址的工具都能接入
  - \`http://127.0.0.1:5178/v1\` — WorkBuddy
  - \`http://127.0.0.1:5178/v1/cc\` — Command Code
- **\`sk-\` 密钥**：可限定来源，一把密钥只走一条线路
- **每日自动签到**、用量统计、深色/浅色主题

### 安装

下载 \`BuddyDesktop-Setup.exe\` 双击安装。装好后桌面和开始菜单会出现图标。

服务只监听 \`127.0.0.1\`，不对外网开放。

---

Standalone Windows desktop app for WorkBuddy multi-account pools: quota-aware
rotation, OpenAI-compatible forwarding, and a Command Code channel.
`

console.log('1. 创建 Release…')
let release = api(`/repos/${OWNER}/${REPO}/releases`, {
  method: 'POST',
  json: {
    tag_name: tag,
    name: `Buddy Desktop ${tag}`,
    body,
    draft: false,
    prerelease: false
  }
})

if (release.status === 422) {
  console.log('   Release 已存在，复用')
  release = api(`/repos/${OWNER}/${REPO}/releases/tags/${tag}`)
}

if (release.status >= 300) {
  console.error('   失败:', release.status, JSON.stringify(release.body).slice(0, 300))
  process.exit(1)
}

const info = release.body
console.log('   完成:', info.html_url)

// An asset with the same name cannot be uploaded twice, so it is replaced.
for (const asset of info.assets ?? []) {
  if (asset.name !== 'BuddyDesktop-Setup.exe') continue
  console.log('   删除旧附件', asset.name)
  api(`/repos/${OWNER}/${REPO}/releases/assets/${asset.id}`, { method: 'DELETE' })
}

const size = statSync(installer).size
console.log(`2. 上传 ${(size / 1024 / 1024).toFixed(1)} MB…`)

const out = execFileSync(
  'curl',
  [
    '-sS',
    '--proxy', PROXY,
    // A 100 MB upload over this network needs more than the default patience.
    '--max-time', '1800',
    '--connect-timeout', '30',
    '-X', 'POST',
    '-H', `authorization: Bearer ${token}`,
    '-H', 'content-type: application/octet-stream',
    '-H', 'user-agent: buddy-desktop-release',
    '--data-binary', `@${installer}`,
    '-w', '\n%{http_code}',
    `https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${info.id}/assets?name=BuddyDesktop-Setup.exe`
  ],
  { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 1800000 }
)

const split = out.lastIndexOf('\n')
const status = Number.parseInt(out.slice(split + 1).trim(), 10)
let asset
try {
  asset = JSON.parse(out.slice(0, split))
} catch {
  asset = { raw: out.slice(0, 400) }
}

if (status >= 300) {
  console.error('   上传失败:', status, JSON.stringify(asset).slice(0, 400))
  process.exit(1)
}

console.log('   完成:', asset.browser_download_url)
console.log('')
console.log('Release:', info.html_url)
