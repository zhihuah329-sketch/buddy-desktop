import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
const { startServer } = await import(process.env.BUDDY_TEST_SERVER_MODULE ?? '../packages/server/src/index.js')

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
let selectedModel = 'other-model'
const configOptions = () => [{id:'model',currentValue:selectedModel,options:[{value:'deepseek-v4.1-flash'}]}, {
  id:'thought_level',currentValue:thoughtLevel,options:['low','high','max','enabled','disabled'].map(value=>({value}))
}]
createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params } = JSON.parse(line)
  if (method === 'initialize') return send({ id, result: { protocolVersion: 1 } })
  if (method === 'session/new') {
    if (!existsSync(join(process.env.USERPROFILE, 'cn-test-login'))) {
      return send({ id, error: { code: -32000, message: 'Authentication required' } })
    }
    return send({ id, result: { sessionId: 'test-session', configOptions: configOptions() } })
  }
  if (method === 'session/set_config_option') {
    if (params.configId === 'model') selectedModel = params.value
    else thoughtLevel = params.value
    return send({ id, result: { configOptions: configOptions() } })
  }
  if (!thoughtLevel) return send({ id, error: { code: -32602, message: 'Thinking config was not sent' } })
  if (params.prompt[0].text.includes('TOOL_JSON_FIXTURE_')) {
    const task = params.prompt[0].text
    const complete = JSON.stringify({name:'ask_user_question',arguments:{questions:[{id:'style',question:'Choose a style',options:[{label:'Keep {current}',description:'Preserve the SVG'}, {label:'Change',description:'Use another color'}]}]}})
    const text = task.includes('TOOL_JSON_FIXTURE_ENVELOPE') ? complete.slice(0,-1)
      : task.includes('TOOL_JSON_FIXTURE_INNER') ? complete.slice(0,-2)
      : task.includes('TOOL_JSON_FIXTURE_STRING') ? complete.slice(0,complete.indexOf('another color')+7)
      : complete.replace('ask_user_question','undeclared_tool')
    for (const chunk of ['\\n', 'BUDDY_DSH_', 'TOOL ', text]) send({method:'session/update',params:{update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:chunk}}}})
    return send({id,result:{stopReason:'end_turn'}})
  }
  if (params.prompt[0].text.includes('REPORT_EFFORT')) {
    send({ method: 'session/update', params: { update: {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: thoughtLevel }
    } } })
    return send({ id, result: { stopReason: 'end_turn' } })
  }
  if (params.prompt[0].text.includes('CHECK_LARGE_TOOL_RESULT')) {
    const text = params.prompt[0].text.includes('LARGE_TOOL_TAIL_7425') ? 'Long result preserved.' : 'Long result lost.'
    send({ method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } })
    return send({ id, result: { stopReason: 'end_turn' } })
  }
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
      : ['Preparing document parser.\\n', 'BUDDY_DSH_', 'TOOL ' + JSON.stringify({name:'functions.pwsh',arguments:{description:'Read Word XML',command:process.env.BUDDY_DOC_TEST_COMMAND,timeoutMs:1000}}) + ' ']
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
  for (const [options, expected] of [
    [{reasoning_effort:'low'},'low'], [{reasoning_effort:'medium'},'high'],
    [{reasoning_effort:'max'},'max'], [{reasoning:{effort:'xhigh'}},'max'],
    [{reasoning_effort:'none'},'disabled'], [{reasoning:{enabled:false}},'disabled']
  ]) {
    const answer = await prompt('REPORT_EFFORT', {...options,stream:false}).then((res) => res.json())
    assert.equal(answer.choices[0].message.content, expected)
    const state = await readState()
    assert.equal(state.codeBuddy.lastRequest.effectiveEffort, expected)
    assert.equal(state.codeBuddy.lastRequest.model, 'deepseek-v4.1-flash')
  }
  assert.equal((await prompt('REPORT_EFFORT',{reasoning_effort:'unsupported'})).status,400)
  const questionTools = [{type:'function',function:{name:'ask_user_question',parameters:{type:'object',properties:{questions:{type:'array',items:{type:'object'}}},required:['questions']}}}]
  for (const stream of [false,true]) {
    const response = await prompt('TOOL_JSON_FIXTURE_ENVELOPE', {tools:questionTools,stream})
    if (stream) {
      const text = await response.text()
      assert.match(text,/"finish_reason":"tool_calls"/)
      assert.doesNotMatch(text,/"error"|未执行|BUDDY_DSH/)
    } else {
      const body = await response.json()
      const call = body.choices[0].message.tool_calls[0]
      assert.equal(body.choices[0].finish_reason,'tool_calls')
      assert.equal(call.function.name,'ask_user_question')
      assert.equal(JSON.parse(call.function.arguments).questions[0].options[0].label,'Keep {current}')
    }
  }
  for (const fixture of ['INNER','STRING','UNKNOWN']) {
    const response = await prompt('TOOL_JSON_FIXTURE_'+fixture,{tools:questionTools,stream:false})
    assert.equal(response.status,502)
    const body = await response.json()
    assert.match(body.error.upstream_code,/^CODEBUDDY_TOOL_/)
    assert.equal(body.choices,undefined)
  }
  const streamError = await prompt('TOOL_JSON_FIXTURE_INNER',{tools:questionTools}).then(res=>res.text())
  assert.match(streamError,/"error"/)
  assert.doesNotMatch(streamError,/"finish_reason":"stop"|"finish_reason":"tool_calls"/)
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
  const longResult = await prompt('', { tools, stream: false, messages: [
    {role:'user',content:'CHECK_LARGE_TOOL_RESULT'},
    {role:'assistant',content:null,tool_calls:[call]},
    {role:'tool',tool_call_id:call.id,content:'x'.repeat(25000)+'LARGE_TOOL_TAIL_7425'}
  ] }).then((res) => res.json())
  assert.equal(longResult.choices[0].message.content,'Long result preserved.')
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
    const response = await prompt(content, { ...options, stream: false })
    const blocked = await response.json()
    if (options.tool_choice === 'none') {
      assert.equal(blocked.choices[0].finish_reason, 'stop')
      assert.match(blocked.choices[0].message.content, /工具请求未执行/)
      assert.doesNotMatch(blocked.choices[0].message.content, /DSML/)
    } else {
      assert.equal(response.status,502)
      assert.match(blocked.error.message,/工具未在 DSH 中声明/)
    }
  }
  console.log('Clean profile: detected CLI, reported login requirement, and streamed after simulated CN login.')
} finally {
  await server.close()
}
