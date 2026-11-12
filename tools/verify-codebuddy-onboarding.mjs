import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { startServer } from '../packages/server/src/index.js'

const home = mkdtempSync(join(tmpdir(), 'buddy-onboarding-'))
const prefix = join(home, 'Roaming', 'npm')
const binDir = join(prefix, 'node_modules', '@tencent-ai', 'codebuddy-code', 'bin')
const powershell = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const wordSource = join(home, 'word-source')
const wordFile = join(home, 'sample.docx')
mkdirSync(join(wordSource, 'word'), { recursive: true })
writeFileSync(join(wordSource, 'word', 'document.xml'), '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>DOCX_RESULT_7424</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>TABLE_RESULT_9248</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>')
const quotePs = (value) => "'" + value.replaceAll("'", "''") + "'"
const createWord = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::Open(${quotePs(wordFile)}, [IO.Compression.ZipArchiveMode]::Create)
try {
  $writer = [IO.StreamWriter]::new($zip.CreateEntry('word/document.xml').Open())
  try { $writer.Write([IO.File]::ReadAllText(${quotePs(join(wordSource, 'word', 'document.xml'))})) }
  finally { $writer.Dispose() }
} finally { $zip.Dispose() }
`
execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', createWord], { windowsHide: true })
process.env.BUDDY_DOC_TEST_COMMAND = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead(${quotePs(wordFile)})
try {
  $reader = [IO.StreamReader]::new($zip.GetEntry('word/document.xml').Open())
  try { [xml]$doc = $reader.ReadToEnd() } finally { $reader.Dispose() }
  $ns = [Xml.XmlNamespaceManager]::new($doc.NameTable)
  $ns.AddNamespace('w', 'http://schemas.openxmlformats.org/wordprocessingml/2006/main')
  $doc.SelectNodes('//w:t', $ns) | ForEach-Object { $_.InnerText }
} finally { $zip.Dispose() }
`
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
let thoughtLevel
createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params } = JSON.parse(line)
  if (method === 'initialize') return send({ id, result: { protocolVersion: 1 } })
  if (method === 'session/new') {
    if (!existsSync(join(process.env.USERPROFILE, 'cn-test-login'))) {
      return send({ id, error: { code: -32000, message: 'Authentication required' } })
    }
    return send({ id, result: { sessionId: 'test-session', configOptions: [{
      id: 'thought_level', options: [{ value: 'high' }, { value: 'enabled' }, { value: 'disabled' }]
    }] } })
  }
  if (method === 'session/set_config_option') {
    thoughtLevel = params.value
    return send({ id, result: {} })
  }
  if (!thoughtLevel) return send({ id, error: { code: -32602, message: 'Thinking config was not sent' } })
  if (params.prompt[0].text.includes('REVIEW_JSON_INPUT')) {
    const text = String.fromCharCode(96, 96, 96) + 'json' + String.fromCharCode(10) + '{"risk":"low","note":"fixture only"}' + String.fromCharCode(10) + String.fromCharCode(96, 96, 96)
    send({ method: 'session/update', params: { update: {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }
    } } })
    return send({ id, result: { stopReason: 'end_turn' } })
  }
  if (params.prompt[0].text.includes('Parse attached Word.')) {
    const text = params.prompt[0].text
    if (!text.includes('DOCUMENT_SYSTEM_SENTINEL') || !text.includes('DOCUMENT_DEVELOPER_SENTINEL') || !text.includes('"description":{"type":"string"}')) {
      return send({ id, error: { code: -32602, message: 'Missing instructions or tool schema' } })
    }
    const chunks = text.includes('DOCX_RESULT_7424') ? ['Word contents: DOCX_RESULT_7424. Table: TABLE_RESULT_9248.']
      : ['Preparing document parser. ', 'BUDDY_DSH_', 'TOOL ' + JSON.stringify({name:'functions.pwsh',arguments:{description:'Read Word XML',command:process.env.BUDDY_DOC_TEST_COMMAND,timeoutMs:1000}}) + ' ']
    for (const text of chunks) send({ method: 'session/update', params: { update: {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }
    } } })
    return send({ id, result: { stopReason: 'end_turn' } })
  }
  if (params.prompt[0].text.includes('Emit a tool marker.')) {
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
  if (thoughtLevel !== 'disabled') send({ method: 'session/update', params: { update: {
    sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'test thought' }
  } } })
  send({ method: 'session/update', params: { update: {
    sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OK' }
  } } })
  send({ id, result: { stopReason: 'end_turn' } })
})
`

const server = await startServer({ port: 0, autoInstallCodeBuddy: false })
try {
  const base = `http://127.0.0.1:${server.port}`
  const readState = () => fetch(base + '/api/state').then((res) => res.json())
  assert.equal((await readState()).codeBuddy.installed, false)
  mkdirSync(binDir, { recursive: true })
  writeFileSync(join(binDir, 'codebuddy'), fakeCli)
  writeFileSync(join(binDir, '..', 'package.json'), JSON.stringify({ name: '@tencent-ai/codebuddy-code', version: '0.0.0-test' }))
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
  const noThinking = await prompt('Say OK.', { thinking: { type: 'disabled' } }).then((res) => res.text())
  assert.doesNotMatch(noThinking, /reasoning_content/)
  const tool = await prompt('Emit a tool marker.')
  assert.equal(tool.status, 200)
  const toolNotice = await tool.text()
  assert.match(toolNotice, /启用所需工具/)
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
  const documentTools = [...tools, { type: 'function', function: {
    name: 'pwsh', parameters: { type: 'object', properties: {
      description: { type: 'string' }, command: { type: 'string' }, timeoutMs: { type: 'number' }
    }, required: ['description', 'command'] }
  } }]
  const documentMessages = [
    { role: 'system', content: 'DOCUMENT_SYSTEM_SENTINEL' },
    { role: 'developer', content: 'DOCUMENT_DEVELOPER_SENTINEL' },
    { role: 'user', content: 'Parse attached Word.' }
  ]
  const docRequest = await prompt('', { tools: documentTools, messages: documentMessages, stream: false }).then((res) => res.json())
  const [docCall] = docRequest.choices[0].message.tool_calls
  assert.equal(docCall.function.name, 'pwsh')
  assert.deepEqual(JSON.parse(docCall.function.arguments), { description: 'Read Word XML', command: process.env.BUDDY_DOC_TEST_COMMAND, timeoutMs: 1000 })
  const documentText = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', JSON.parse(docCall.function.arguments).command], { encoding: 'utf8', windowsHide: true })
  assert.match(documentText, /DOCX_RESULT_7424/)
  assert.match(documentText, /TABLE_RESULT_9248/)
  const docResult = await prompt('', { tools: documentTools, stream: false, messages: [
    ...documentMessages,
    { role: 'assistant', content: null, tool_calls: [docCall] },
    { role: 'tool', tool_call_id: docCall.id, content: documentText }
  ] }).then((res) => res.json())
  assert.match(docResult.choices[0].message.content, /Word contents: DOCX_RESULT_7424/)
  assert.match(docResult.choices[0].message.content, /TABLE_RESULT_9248/)
  const review = await prompt('REVIEW_JSON_INPUT', { stream: false, response_format: {
    type: 'json_schema', json_schema: { name: 'fixture', schema: {
      type: 'object', properties: { risk: { type: 'string', enum: ['low', 'high'] } }, required: ['risk']
    } }
  } }).then((res) => res.json())
  assert.equal(JSON.parse(review.choices[0].message.content).risk, 'low')
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
