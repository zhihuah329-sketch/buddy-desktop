import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const childProcess = require('node:child_process')
const original = childProcess.execFile
const home = mkdtempSync(join(tmpdir(), 'buddy-startup-'))
const prefix = join(home, 'custom-global-prefix')
Object.assign(process.env, {
  APPDATA: join(home, 'Roaming'), LOCALAPPDATA: join(home, 'Local'),
  USERPROFILE: home, BUDDYHUB_DATA: join(home, 'accounts'), BUDDY_NODE_EXE: process.execPath,
  PATH: ''
})
delete process.env.BUDDY_CODEBUDDY_ENTRY
delete process.env.BUDDY_CODEBUDDY_EXE
delete process.env.npm_config_prefix

const installs = []
let finishInstall
childProcess.execFile = (_node, args, _options, callback) => {
  if (args.includes('prefix')) {
    queueMicrotask(() => callback(null, prefix, ''))
    return
  }
  installs.push(args)
  finishInstall = () => {
    const bin = join(prefix, 'node_modules', '@tencent-ai', 'codebuddy-code', 'bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'codebuddy'), '// test fixture')
    writeFileSync(join(bin, '..', 'package.json'), JSON.stringify({ name: '@tencent-ai/codebuddy-code', version: '0.0.0-test' }))
    callback(null, 'installed', '')
  }
}

let server
try {
  const { startServer } = await import('../packages/server/src/index.js')
  const runtime = require('../packages/server/src/codebuddy-cn-runtime.cjs')
  server = await startServer({ port: 0 })
  const state = await fetch(server.url + '/api/state').then((res) => res.json())
  assert.equal(state.codeBuddy.installation.phase, 'installing')
  assert.equal(state.codeBuddy.installed, false)
  const pending = runtime.ensureCodeBuddy()
  assert.equal(installs.length, 1)
  assert.ok(installs[0].includes('--global'))
  assert.ok(installs[0].includes('@tencent-ai/codebuddy-code'))
  assert.ok(!installs[0].includes('--prefix'))
  finishInstall()
  await pending
  await runtime.ensureCodeBuddy()
  assert.equal(installs.length, 1)
  const installed = await fetch(server.url + '/api/state').then((res) => res.json())
  assert.equal(installed.codeBuddy.installed, true)
  assert.equal(installed.codeBuddy.version, '0.0.0-test')
  assert.equal(installed.codeBuddy.installation.phase, 'ready')
  console.log('Startup installs globally once, reports progress, discovers a custom npm prefix, and skips an installed CLI.')
} finally {
  childProcess.execFile = original
  await server?.close()
}
