import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const { default: runtime } = await import(process.env.BUDDY_TEST_RUNTIME_MODULE ?? '../packages/server/src/codebuddy-cn-runtime.cjs')

const home = mkdtempSync(join(tmpdir(), 'buddy-runtime-'))
const entry = join(home, 'fixture.cjs')
const countFile = join(home, 'attempts.txt')
Object.assign(process.env, {
  APPDATA: join(home, 'Roaming'), LOCALAPPDATA: join(home, 'Local'), USERPROFILE: home,
  PATH: '', BUDDY_CODEBUDDY_ENTRY: entry, BUDDY_NODE_EXE: process.execPath,
  BUDDY_RUNTIME_TEST_ATTEMPTS: countFile
})
delete process.env.BUDDY_CODEBUDDY_EXE
delete process.env.npm_config_prefix

// This isolated local fixture implements ACP without network or user data.
writeFileSync(entry, `
const {appendFileSync,readFileSync}=require('node:fs')
const {createInterface}=require('node:readline')
const scenario=process.env.BUDDY_RUNTIME_TEST_SCENARIO
const countFile=process.env.BUDDY_RUNTIME_TEST_ATTEMPTS
appendFileSync(countFile,'attempt\\n')
const attempt=readFileSync(countFile,'utf8').trim().split('\\n').length
const send=obj=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...obj})+'\\n')
const delta=(kind,text)=>send({method:'session/update',params:{update:{sessionUpdate:kind,content:{type:'text',text}}}})
const options=()=>[{id:'model',currentValue:'deepseek-v4.1-flash',options:[{value:'deepseek-v4.1-flash'}]},{id:'thought_level',currentValue:'high',options:[{value:'high'}]}]
if(scenario==='startup-fail'||scenario==='startup-retry'&&attempt===1)process.exit(17)
createInterface({input:process.stdin}).on('line',line=>{
 const {id,method}=JSON.parse(line)
 if(method==='initialize')return send({id,result:{protocolVersion:1}})
 if(method==='session/new')return send({id,result:{sessionId:'fixture',configOptions:options()}})
 if(method==='session/set_config_option')return send({id,result:{configOptions:options()}})
 if(method!=='session/prompt')return
 if(scenario==='submitted-exit')return process.exit(23)
 if(scenario==='partial-exit')return process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{update:{sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'PARTIAL_SYNTHETIC_REASONING'}}}})+'\\n',()=>process.exit(24))
 if(scenario==='stderr-oom'){
  const chunks=['FATAL ERROR: Reached heap limit Allo','cation failed - JavaScript heap out of mem','ory\\n']
  const next=()=>{if(!chunks.length)return process.exit(134);process.stderr.write(chunks.shift(),()=>setTimeout(next,10))}
  return next()
 }
 if(scenario==='stderr-module')return process.stderr.write("Error: Cannot find module 'PRIVATE_MODULE_NAME'\\n",()=>process.exit(1))
 if(scenario==='stderr-permission')return process.stderr.write('Error: EPERM: operation not permitted, open PRIVATE_FILE\\n',()=>process.exit(1))
 if(scenario==='stderr-network')return process.stderr.write('Error: read ECONNRESET\\n',()=>process.exit(1))
 if(scenario==='stderr-private'){
  const privateText='Bearer PRIVATE_TOKEN_4973\\n'+('PRIVATE_CONTENT_'.repeat(100000))+'\\nUser prompt: FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\\n'+JSON.stringify({content:'Error: Cannot find module PRIVATE_MODULE_NAME'})+'\\n'
  return process.stderr.write(privateText,()=>process.exit(25))
 }
 if(scenario==='cancel')return delta('agent_thought_chunk','READY_TO_CANCEL')
 if(scenario.startsWith('credits-')){
  const credits=snapshot=>send({method:'session/update',params:{update:{sessionUpdate:'usage_update',_meta:{'codebuddy.ai/requestCredits':snapshot}}}})
  if(scenario==='credits-repeat')for(let i=0;i<3;i++)credits({'PRIVATE_REQUEST_ID_A':1.43})
  if(scenario==='credits-grow'){
   credits({'PRIVATE_REQUEST_ID_A':1.43})
   credits({'PRIVATE_REQUEST_ID_A':2.14})
   credits({'PRIVATE_REQUEST_ID_A':1.99,'PRIVATE_REQUEST_ID_B':0.81})
  }
  if(scenario==='credits-malformed'){
   credits({'PRIVATE_REQUEST_ID_A':1.43})
   for(const value of [null,[],[2.99],'9.99',7,{'PRIVATE_REQUEST_ID_A':-2,bad:'8',missing:null,nested:{credit:9},infinity:1e308}])credits(value)
   process.stdout.write('{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"usage_update","_meta":{"codebuddy.ai/requestCredits":{"badInfinity":1e999}}}}}\\n')
   credits({'PRIVATE_REQUEST_ID_A':1.42})
  }
  if(scenario==='credits-unknown')send({method:'session/update',params:{update:{sessionUpdate:'usage_update',cost:{amount:9.99,currency:''},_meta:{usage:{credit:9.99}}}}})
  if(scenario==='credits-zero')credits({'PRIVATE_REQUEST_ID_A':0})
  if(scenario==='credits-bounded'){
   credits(Object.fromEntries(Array.from({length:300},(_,i)=>['PRIVATE_REQUEST_ID_'+i,1])))
   credits({'PRIVATE_REQUEST_ID_0':2,'PRIVATE_REQUEST_ID_NEW':1000})
  }
  if(scenario==='credits-rounding')credits({'PRIVATE_REQUEST_ID_A':0.13,'PRIVATE_REQUEST_ID_B':0.22})
 }
 delta('agent_message_chunk','OK')
 send({id,result:{stopReason:'end_turn'}})
})
`)

const attempts = () => existsSync(countFile) ? readFileSync(countFile, 'utf8').trim().split('\n').filter(Boolean).length : 0
const prepare = (scenario) => {
  process.env.BUDDY_RUNTIME_TEST_SCENARIO = scenario
  writeFileSync(countFile, '')
}
const ask = (signal, onDelta) => runtime.askCodeBuddyDetailed('Synthetic runtime fixture.', signal, process.execPath, onDelta, 'high')
const failure = async (scenario, code, exitCode) => {
  prepare(scenario)
  let error
  try { await ask() } catch (caught) { error = caught }
  assert.ok(error, `${scenario} must fail`)
  assert.equal(error.code, code)
  assert.equal(error.exitCode, exitCode)
  assert.equal(error.signal, null)
  assert.equal(error.promptSubmitted, true)
  assert.equal(error.retryable, false)
  assert.match(error.message, new RegExp(`exitCode=${exitCode}`))
  assert.match(error.message, /promptSubmitted=true/)
  assert.doesNotMatch(JSON.stringify({message:error.message,...error}), /PRIVATE_|Bearer|PARTIAL_SYNTHETIC/)
  assert.equal(attempts(), 1, `${scenario} must not replay a submitted request`)
  return error
}

prepare('normal')
assert.equal((await ask()).text, 'OK')
assert.equal(attempts(), 1)
assert.equal(runtime.requestState().reportedCredits, undefined)
for (const [scenario, expected] of [
  ['credits-repeat', 1.43], ['credits-grow', 2.95], ['credits-malformed', 1.43],
  ['credits-unknown', undefined], ['credits-zero', 0], ['credits-bounded', 257],
  ['credits-rounding', 0.35], ['normal', undefined]
]) {
  prepare(scenario)
  assert.equal((await ask()).text, 'OK')
  const state = runtime.requestState()
  assert.equal(state.reportedCredits, expected, scenario)
  assert.doesNotMatch(JSON.stringify(state), /PRIVATE_REQUEST_ID/, 'request IDs stay private')
}
prepare('startup-retry')
assert.equal((await ask()).text, 'OK')
assert.equal(attempts(), 2)
prepare('startup-fail')
await assert.rejects(ask(), error => error.code === 'CODEBUDDY_PROCESS_EXIT' && error.promptSubmitted === false && error.exitCode === 17)
assert.equal(attempts(), 2, 'startup retries are capped at one')
await failure('submitted-exit', 'CODEBUDDY_PROCESS_EXIT', 23)
prepare('partial-exit')
const partial = []
await assert.rejects(ask(undefined, (kind, text) => partial.push({kind,text})), error => error.code === 'CODEBUDDY_PROCESS_EXIT' && error.exitCode === 24 && error.promptSubmitted)
assert.deepEqual(partial, [{kind:'reasoning',text:'PARTIAL_SYNTHETIC_REASONING'}])
assert.equal(attempts(), 1)
const oom = await failure('stderr-oom', 'CODEBUDDY_CLI_OOM', 134)
assert.equal(oom.diagnostic, 'NODE_HEAP_OOM')
await failure('stderr-module', 'CODEBUDDY_CLI_MODULE_MISSING', 1)
await failure('stderr-permission', 'CODEBUDDY_CLI_PERMISSION', 1)
await failure('stderr-network', 'CODEBUDDY_CLI_NETWORK', 1)
const privateFailure = await failure('stderr-private', 'CODEBUDDY_PROCESS_EXIT', 25)
assert.equal(privateFailure.diagnostic, undefined)
prepare('cancel')
const controller = new AbortController()
await assert.rejects(ask(controller.signal, () => controller.abort()), error => error.code === 'CODEBUDDY_CANCELLED' && error.promptSubmitted && !error.retryable)
assert.equal(attempts(), 1)
prepare('normal')
const cancelled = new AbortController()
cancelled.abort()
await assert.rejects(ask(cancelled.signal), error => error.code === 'CODEBUDDY_CANCELLED' && !error.promptSubmitted && !error.retryable)
assert.equal(attempts(), 0)
console.log('Runtime ACP completion, credit snapshots, bounded startup retry, submitted/partial exits, private stderr diagnostics and cancellation checks passed.')
