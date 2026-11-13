import assert from 'node:assert/strict'
import { decodeToolCalls, structuredResponse } from '../packages/server/src/codebuddy-cn-tools.mjs'
import runtime from '../packages/server/src/codebuddy-cn-runtime.cjs'
import { streamCodeBuddy } from '../packages/server/src/codebuddy-cn-stream.mjs'
import { createCodeBuddyAdapter } from '../packages/server/src/codebuddy-cn-adapter.mjs'

const tools = [
  {name:'read',parameters:{type:'object',properties:{file_path:{type:'string'},offset:{type:'integer',minimum:1},limit:{type:'integer',minimum:1}},required:['file_path'],additionalProperties:false}},
  {name:'pwsh',description:'SHELL_DESCRIPTION_END',parameters:{type:'object',properties:{description:{type:'string'},command:{type:'string',description:'PRESERVE_COMMAND_SYNTAX'},timeoutMs:{type:'integer'}},required:['description','command'],additionalProperties:false}},
  {name:'write',parameters:{type:'object',properties:{file_path:{type:'string'},content:{type:'string'}},required:['file_path','content'],additionalProperties:false}},
  {name:'ask_user_question',parameters:{type:'object',properties:{questions:{type:'array',minItems:1,items:{type:'object',properties:{id:{type:'string'},question:{type:'string'}},required:['id','question'],additionalProperties:false}}},required:['questions'],additionalProperties:false}}
]
const args = {description:'Read a path with spaces',command:'Write-Output "C:\\测试 文件\\a.txt {value}"',timeoutMs:1000}
const call = {name:'pwsh',arguments:args}
const envelope = 'BUDDY_DSH_TOOL ' + JSON.stringify(call)
const dsml = '< ｜ ｜ DSML ｜ ｜ tool_calls>< | | DSML | | invoke name="Read">< | | DSML | | parameter name="path" string="true">notes｜样本.txt</ | | DSML | | parameter>< | | DSML | | parameter name="limit" string="false">400</ | | DSML | | parameter></ | | DSML | | invoke></ ｜ ｜ DSML ｜ ｜ tool_calls>'
const cases = [
  [envelope,['pwsh']],
  ['BUDDY_DSH_TOOL '+JSON.stringify({...args,name:'pwsh'}),['pwsh']],
  ['BUDDY_DSH_TOOL '+JSON.stringify({name:'functions.PWSH',arguments:JSON.stringify(args)}),['pwsh']],
  ['BUDDY_DSH_TOOL '+JSON.stringify({type:'function',function:call}),['pwsh']],
  ['BUDDY_DSH_TOOL '+JSON.stringify([call,{name:'read',arguments:{file_path:'a.txt'}}]),['pwsh','read']],
  [envelope+'\nBUDDY_DSH_TOOL '+JSON.stringify({name:'read',arguments:{file_path:'b.txt'}}),['pwsh','read']],
  [envelope.slice(0,-1),['pwsh']],
  [envelope+'\n\n<ds_system>Tool result will follow.</ds_system>',['pwsh']],
  [envelope+'\nCommentary after the complete request.',['pwsh']],
  [dsml,['read']],
  [dsml+'\nCommentary after the complete request.',['read']],
  [dsml+'\n\n<ds_system>Tool result will follow.</ds_system>',['read']],
  [dsml+'\nCommentary between complete requests.\n'+envelope,['read','pwsh']],
  [envelope+'\nCommentary between complete requests.\n'+dsml,['pwsh','read']],
  [dsml+'\nCommentary between complete requests.\n'+dsml,['read','read']],
  [envelope+'\nProtocol example only:\n```json\n'+envelope+'\n```',['pwsh']],
  [dsml+'\nProtocol example only:\n~~~xml\n'+dsml+'\n~~~',['read']],
  [dsml.replace('</ ｜ ｜ DSML ｜ ｜ tool_calls>','< | | DSML | | invoke name="read">< | | DSML | | parameter name="file_path" string="true">b.txt</ | | DSML | | parameter></ | | DSML | | invoke></ ｜ ｜ DSML ｜ ｜ tool_calls>'),['read','read']]
]
for (const [text,names] of cases) assert.deepEqual(decodeToolCalls(text,tools).map(call=>call.name),names)
assert.deepEqual(JSON.parse(decodeToolCalls(envelope,tools)[0].arguments),args)
assert.equal(JSON.parse(decodeToolCalls(dsml,tools)[0].arguments).file_path,'notes｜样本.txt')
for (const text of [envelope.slice(0,-2),envelope.slice(0,-8),envelope.replace('"pwsh"','"Bash"'),envelope.replace('1000','"1000"'),'BUDDY_DSH_TOOL {"name":"read","arguments":{}}','BUDDY_DSH_TOOL {"name":"read","arguments":{"file_path":"a","unexpected":true}}']) {
  assert.throws(()=>decodeToolCalls(text,tools),undefined,text.slice(0,80))
}
assert.throws(()=>decodeToolCalls(envelope+'\n'+envelope,tools,1),/最多允许/)
for (const duplicate of [
  '<||DSML||parameter name="file_path" string="true">other.txt</||DSML||parameter><||DSML||parameter name="path" string="true">notes.txt</||DSML||parameter>',
  '<||DSML||parameter name="path" string="true">notes.txt</||DSML||parameter><||DSML||parameter name="file_path" string="true">other.txt</||DSML||parameter>'
]) assert.throws(()=>decodeToolCalls('<||DSML||calls><||DSML||invoke name="read">'+duplicate+'</||DSML||invoke></||DSML||calls>',tools),/重复/)
const invalidBatches = [
  dsml+'\nCommentary.\nBUDDY_DSH_UNKNOWN {}',
  envelope+'\nCommentary.\nBUDDY_DSH_UNKNOWN {}',
  dsml+'\nCommentary.\nBUDDY_DSH_TOOL {"name":"Bash","arguments":{}}',
  envelope+'\nCommentary.\nBUDDY_DSH_TOOL {"name":"read","arguments":{"file_path":"a.txt"',
  dsml+'\nCommentary.\nBUDDY_DSH_',
  envelope+'\nCommentary.\n<||DSML||calls>',
  dsml+'\nCommentary.\n<||DSML||unknown></||DSML||unknown>'
]
for (const text of invalidBatches) assert.throws(()=>decodeToolCalls(text,tools))
const unionTool = [{name:'select',parameters:{$defs:{selection:{enum:['yes','no']}},type:'object',properties:{choice:{$ref:'#/$defs/selection'}},required:['choice']}}]
assert.equal(decodeToolCalls('BUDDY_DSH_TOOL {"name":"select","choice":"yes"}',unionTool).length,1)
assert.throws(()=>decodeToolCalls('BUDDY_DSH_TOOL {"name":"select","choice":"maybe"}',unionTool),/不符合定义/)
const objectFormat={type:'json_object'}
assert.equal(structuredResponse('```json\n{"ok":true}\n```',objectFormat),'{"ok":true}')
for(const value of ['[1,2]','{"ok":true} trailing prose','{"ok":true}\n{"extra":true}','{"ok":']) assert.throws(()=>structuredResponse(value,objectFormat))
const schemaFormat={type:'json_schema',json_schema:{schema:{type:'array',items:{type:'integer'}}}}
assert.equal(structuredResponse('[1,2]',schemaFormat),'[1,2]')
assert.throws(()=>structuredResponse('["wrong"]',schemaFormat),/不符合/)

const original = runtime.askCodeBuddyDetailed
let output = envelope
let width = 1
let captured
let capturedEffort
runtime.askCodeBuddyDetailed = async (task,signal,_node,onDelta,effort) => {
  captured=task
  capturedEffort=effort
  onDelta('reasoning','live thought')
  for(let i=0;i<output.length;i+=width) { signal.throwIfAborted(); onDelta('text',output.slice(i,i+width)) }
  return {text:output,usage:{prompt_tokens:100,completion_tokens:20,prompt_cache_hit_tokens:40,completion_thinking_tokens:10}}
}
let count=0
let fencedCount=0
let invalidCount=0
try {
  for(const [text,names] of cases) for(const chunkWidth of [1,2,3,7,31,1024]) {
    output=text;width=chunkWidth
    const events=[]
    for await(const event of streamCodeBuddy({messages:[{role:'user',content:[{type:'text',text:'Synthetic protocol request.'}]}],tools},{})) events.push(event)
    assert.equal(events.at(-1).reason.kind,'stop',JSON.stringify(events.at(-1)))
    assert.deepEqual(events.filter(e=>e.type==='tool-call').map(e=>e.name),names)
    assert.ok(events.find(e=>e.type==='reasoning-delta'))
    assert.doesNotMatch(events.filter(e=>e.type==='text-delta').map(e=>e.text).join(''),/BUDDY_DSH|DSML/)
    const usage=events.find(e=>e.type==='usage').usage
    assert.equal(usage.cacheReadTokens,40);assert.equal(usage.reasoningTokens,10)
    count++
  }
  const fencedExamples = [
    'Here is a protocol example; do not execute it:\n```json\n'+envelope+'\n```',
    '```json\n'+envelope+'\n```\nThis remains ordinary text.',
    '~~~xml\n'+dsml+'\n~~~',
    '````text\n```json\n'+envelope+'\n```\n'+envelope+'\n````',
    '  ```json\r\n'+envelope+'\r\n  ```\r\nDone.',
    '```xml\n'+dsml+'\n'+envelope+'\n```',
    '```json\n'+envelope
  ]
  for (const text of fencedExamples) for (const chunkWidth of [1,2,3,7,31,1024]) {
    output=text;width=chunkWidth
    const events=[]
    for await(const event of streamCodeBuddy({messages:[{role:'user',content:[{type:'text',text:'Explain the protocol without using tools.'}]}],tools},{}))events.push(event)
    assert.equal(events.at(-1).reason.kind,'stop',JSON.stringify(events.at(-1)))
    assert.equal(events.filter(e=>e.type==='tool-call').length,0)
    assert.equal(events.filter(e=>e.type==='text-delta').map(e=>e.text).join(''),text)
    fencedCount++
  }
  for (const text of invalidBatches) for (const chunkWidth of [1,7,1024]) {
    output=text;width=chunkWidth
    const events=[]
    for await(const event of streamCodeBuddy({messages:[{role:'user',content:[{type:'text',text:'Reject the complete batch if any request is invalid.'}]}],tools},{}))events.push(event)
    assert.equal(events.at(-1).reason.kind,'error',JSON.stringify(events.at(-1)))
    assert.equal(events.filter(e=>e.type==='tool-call').length,0)
    invalidCount++
  }
  for (const chunkWidth of [1,2,3,7,31,1024]) {
    const example='```json\n'+envelope+'\n```\n'
    output=example+envelope;width=chunkWidth
    const events=[]
    for await(const event of streamCodeBuddy({messages:[{role:'user',content:[{type:'text',text:'Show an example, then perform one real call.'}]}],tools},{}))events.push(event)
    assert.equal(events.at(-1).reason.kind,'stop')
    assert.equal(events.filter(e=>e.type==='tool-call').length,1)
    assert.equal(events.filter(e=>e.type==='text-delta').map(e=>e.text).join(''),example)
    fencedCount++
  }
  output='BUDDY_DSH_TOOL '+JSON.stringify({name:'write',arguments:{file_path:'long.svg',content:'x'.repeat(100000)+'TAIL_9274'}});width=1024
  let events=[]
  for await(const e of streamCodeBuddy({messages:[{role:'user',content:[{type:'text',text:'x'.repeat(140000)}]}],tools},{}))events.push(e)
  assert.equal(JSON.parse(events.find(e=>e.type==='tool-call').arguments).content.slice(-9),'TAIL_9274')
  assert.ok(captured.includes('PRESERVE_COMMAND_SYNTAX'))
  output='{"ok":true}';events=[]
  for await(const e of streamCodeBuddy({messages:[{role:'user',content:[{type:'text',text:'JSON with tools declared.'}]}],tools,responseFormat:objectFormat},{}))events.push(e)
  assert.equal(events.filter(e=>e.type==='text-delta').map(e=>e.text).join(''),'{"ok":true}')
  output=envelope;events=[]
  for await(const e of streamCodeBuddy({messages:[{role:'user',content:[{type:'text',text:'Tool with JSON response format.'}]}],tools,responseFormat:objectFormat},{}))events.push(e)
  assert.equal(events.find(e=>e.type==='tool-call').name,'pwsh')
  output='```json\n'+envelope+'\n```';events=[]
  for await(const e of streamCodeBuddy({messages:[{role:'user',content:[{type:'text',text:'Return JSON without executing an example.'}]}],tools,responseFormat:objectFormat},{}))events.push(e)
  assert.equal(events.at(-1).reason.kind,'error')
  assert.equal(events.filter(e=>e.type==='tool-call').length,0)
  output=envelope
  const adapter=createCodeBuddyAdapter(class {},{})
  const metadata=await adapter.resolveModel()
  assert.ok(metadata.context.contextWindow>65536+8192)
  assert.equal(metadata.reasoning.defaultEffort,'high')
  events=[]
  for await(const e of adapter.stream({messages:[{role:'user',content:[{type:'text',text:'Native DSH request.'}]}],tools,reasoningEffort:'max'}))events.push(e)
  assert.equal(capturedEffort,'max')
  assert.equal(events.at(-1).reason.kind,'tool-calls')
  const nativeCall=events.find(e=>e.type==='tool-call-delta')
  assert.equal(nativeCall.name,'pwsh')
  assert.deepEqual(JSON.parse(nativeCall.argumentsDelta),args)
  assert.equal(events.filter(e=>e.type==='block-end'&&e.block.type==='tool-call').length,1)
  output='Result received.';events=[]
  for await(const e of streamCodeBuddy({messages:[{role:'user',content:[{type:'text',text:'Use the previous result.'},{type:'tool-result',toolCallId:'call_result',isError:true,content:[{type:'text',text:'NESTED_TOOL_TAIL_5932'}]}]}],tools},{}))events.push(e)
  assert.ok(captured.includes('NESTED_TOOL_TAIL_5932'))
  assert.ok(captured.includes('error=true'))
  for await(const e of streamCodeBuddy({messages:[{role:'user',content:[{type:'text',text:'Use the empty tool result.'}]},{role:'tool',toolCallId:'empty_result_7358',content:[]}],tools},{})) {}
  assert.ok(captured.includes('empty_result_7358'))
  output='For example, `'+envelope+'` is a quoted protocol example.';events=[]
  for await(const e of streamCodeBuddy({messages:[{role:'user',content:[{type:'text',text:'Describe the protocol.'}]}],tools},{}))events.push(e)
  assert.equal(events.filter(e=>e.type==='tool-call').length,0)
  assert.equal(events.at(-1).reason.kind,'stop')
  assert.equal(events.filter(e=>e.type==='text-delta').map(e=>e.text).join(''),output)
  for(const text of ['BUDDY_DSH_TOOL ', 'BUDDY_DSH_', '<||DSML||calls>']) {
    output=text;events=[]
    for await(const e of streamCodeBuddy({messages:[{role:'user',content:[{type:'text',text:'Incomplete control request.'}]}],tools},{}))events.push(e)
    assert.equal(events.at(-1).reason.kind,'error')
  }
} finally { runtime.askCodeBuddyDetailed=original }
console.log(`CodeBuddy protocol: ${count} fragmented tool cases, ${fencedCount} fenced-example cases, ${invalidCount} atomic invalid-batch cases plus schema, long file, structured output, and usage checks passed.`)
