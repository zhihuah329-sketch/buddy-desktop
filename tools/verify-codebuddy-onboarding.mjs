import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startServer } from '../packages/server/src/index.js'

const home = mkdtempSync(join(tmpdir(), 'buddy-onboarding-'))
const prefix = join(home, 'Roaming', 'npm')
const binDir = join(prefix, 'node_modules', '@tencent-ai', 'codebuddy-code', 'bin')
Object.assign(process.env, {
  APPDATA: join(home, 'Roaming'),
  LOCALAPPDATA: join(home, 'Local'),
  USERPROFILE: home,
  BUDDY_NODE_EXE: process.execPath,
  BUDDYHUB_DATA: join(home, 'accounts')
})
delete process.env.BUDDY_CODEBUDDY_ENTRY
delete process.env.BUDDY_CODEBUDDY_EXE
delete process.env.npm_config_prefix
process.env.PATH = ''

// The CLI itself is simulated, including the auth failure before login. The
// server, CLI discovery, ACP transport and OpenAI response path are real.
const fakeCli = `
const { createInterface } = require('node:readline')
const { existsSync } = require('node:fs')
const { join } = require('node:path')
const send = (obj) => console.log(JSON.stringify({ jsonrpc: '2.0', ...obj }))
createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params } = JSON.parse(line)
  if (method === 'initialize') return send({ id, result: { protocolVersion: 1 } })
  if (method === 'session/new') {
    if (!existsSync(join(process.env.USERPROFILE, 'cn-test-login'))) {
      return send({ id, error: { code: -32000, message: 'Authentication required' } })
    }
    return send({ id, result: { sessionId: 'test-session' } })
  }
  if (params.prompt[0].text === 'Emit a tool marker.') {
    for (const text of ['< | | DS', 'ML | | calls>', '< | | DSML | | invoke>']) {
      send({ method: 'session/update', params: { update: {
        sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }
      } } })
    }
    return send({ id, result: { stopReason: 'end_turn' } })
  }
  if (params.prompt[0].text.includes('DSML fixture')) {
    const name = params.prompt[0].text.includes('unsafe DSML fixture') ? 'Bash' : 'Read'
    for (const text of [
      '< ｜ ｜ DS', 'ML ｜ ｜ tool_calls>',
      '< | | DSML | | invoke name="' + name + '">',
      '< | | DSML | | parameter name="file_path" string="true">notes｜fixture.txt</ | | DSML | | parameter>',
      '< | | DSML | | parameter name="offset" string="false">2</ | | DSML | | parameter>',
      '</ | | DSML | | invoke>', '</ ｜ ｜ DSML ｜ ｜ tool_calls>'
    ]) send({ method: 'session/update', params: { update: {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }
    } } })
    return send({ id, result: { stopReason: 'end_turn' } })
  }
  if (params.prompt[0].text.includes('Read fixture.txt.')) {
    const result = params.prompt[0].text.includes('fixture value: kiwi')
      ? ['The file says kiwi.'] : ['BUDDY_', 'DSH_READ {"file_path":"fixture.txt","offset":1,"limit":80}']
    for (const text of result) send({ method: 'session/update', params: { update: {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }
    } } })
    return send({ id, result: { stopReason: 'end_turn' } })
  }
  send({ method: 'session/update', params: { update: {
    sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'test thought' }
  } } })
  send({ method: 'session/update', params: { update: {
    sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OK' }
  } } })
  send({ id, result: { stopReason: 'end_turn' } })
})
`

const server = await startServer({ port: 0 })
try {
  const base = `http://127.0.0.1:${server.port}`
  const readState = () => fetch(base + '/api/state').then((res) => res.json())
  assert.equal((await readState()).codeBuddy.installed, false)
  mkdirSync(binDir, { recursive: true })
  writeFileSync(join(binDir, 'codebuddy'), fakeCli)
  const snapshot = await readState()
  assert.equal(snapshot.codeBuddy.installed, true)
  assert.equal(snapshot.accounts.length, 0)
  const install = await fetch(base + '/api/codebuddy/install', { method: 'POST' }).then((res) => res.json())
  assert.equal(install.ok, true)
  const check = () => fetch(base + '/api/codebuddy/test', { method: 'POST' }).then((res) => res.json())
  const before = await check()
  assert.equal(before.ok, false)
  assert.match(before.error, /Chinese Site/)
  writeFileSync(join(home, 'cn-test-login'), '')
  assert.deepEqual(await check(), { ok: true })
  const prompt = (content, options = {}) => fetch(base + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: snapshot.codeBuddy.model,
      stream: true,
      messages: [{ role: 'user', content }],
      ...options
    })
  })
  const reply = await prompt('Say OK.')
  assert.equal(reply.status, 200)
  const body = await reply.text()
  assert.match(body, /"reasoning_content":"test thought"/)
  assert.match(body, /"content":"OK"/)
  assert.match(body, /data: \[DONE\]/)
  const tool = await prompt('Emit a tool marker.')
  assert.equal(tool.status, 200)
  const toolNotice = await tool.text()
  assert.match(toolNotice, /启用原生 read 工具/)
  assert.doesNotMatch(toolNotice, /DSML|tool_calls/)
  const tools = [{ type: 'function', function: {
    name: 'read', parameters: { type: 'object', properties: { file_path: { type: 'string' } } }
  } }]
  const requested = await prompt('Read fixture.txt.', { tools, stream: false }).then((res) => res.json())
  const [call] = requested.choices[0].message.tool_calls
  assert.equal(requested.choices[0].finish_reason, 'tool_calls')
  assert.equal(call.function.name, 'read')
  assert.deepEqual(JSON.parse(call.function.arguments), { file_path: 'fixture.txt', offset: 1, limit: 80 })
  const withResult = await prompt('Read fixture.txt.', { tools, messages: [
    { role: 'user', content: 'Read fixture.txt.' },
    { role: 'assistant', content: null, tool_calls: [call] },
    { role: 'tool', tool_call_id: call.id, content: 'fixture value: kiwi' }
  ] }).then((res) => res.text())
  assert.match(withResult, /The file says kiwi/)
  const dsml = await prompt('Read DSML fixture.', { tools }).then((res) => res.text())
  assert.match(dsml, /"finish_reason":"tool_calls"/)
  assert.match(dsml, /notes｜fixture\.txt/)
  assert.match(dsml, /\\"offset\\":2/)
  assert.doesNotMatch(dsml, /DSML/)
  for (const [content, options] of [
    ['Read unsafe DSML fixture.', { tools }],
    ['Read DSML fixture.', { tools, tool_choice: 'none' }]
  ]) {
    const blocked = await prompt(content, { ...options, stream: false }).then((res) => res.json())
    assert.equal(blocked.choices[0].finish_reason, 'stop')
    assert.match(blocked.choices[0].message.content, /工具请求未执行/)
    assert.doesNotMatch(blocked.choices[0].message.content, /DSML/)
  }
  console.log('Clean profile: detected CLI, reported login requirement, and streamed after simulated CN login.')
} finally {
  await server.close()
}
