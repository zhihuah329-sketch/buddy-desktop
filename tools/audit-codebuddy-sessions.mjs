import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { decodeToolCalls } from '../packages/server/src/codebuddy-cn-tools.mjs'

const [sessionsRoot,tracesRoot]=process.argv.slice(2)
if(!sessionsRoot||!tracesRoot) throw new Error('Usage: node tools/audit-codebuddy-sessions.mjs <DSH sessions directory> <CodeBuddy traces directory>')
function newest(root,suffix,limit) {
  const files=[]
  function visit(dir) { for(const e of readdirSync(dir,{withFileTypes:true})) {
    const path=join(dir,e.name)
    if(e.isDirectory())visit(path)
    else if(e.name.endsWith(suffix))files.push({path,time:statSync(path).mtimeMs})
  } }
  visit(root)
  return files.sort((a,b)=>b.time-a.time).slice(0,limit)
}
function sessionRows(path) {
  const bytes=readFileSync(path);let offset=0;const rows=[]
  while(offset<bytes.length) {
    const frame=zstdDecompressSync(bytes.subarray(offset),{info:true})
    offset+=frame.engine.bytesWritten
    for(const line of frame.buffer.toString('utf8').split('\n'))if(line.trim())rows.push(JSON.parse(line))
  }
  return rows
}
const sessions=newest(sessionsRoot,'.zstd',20)
const rows=sessions.flatMap(({path})=>sessionRows(path))
const tools=rows.filter(row=>row.type==='request/header').map(row=>row.data.header.tools).find(tools=>tools?.length)
if(!tools)throw new Error('No DSH tool definitions found in recent sessions')
const errors={}
for(const row of rows)if(row.type==='turn/end'&&row.data.reason?.kind==='error') {
  const code=row.data.reason.error?.code??'unknown'
  errors[code]=(errors[code]??0)+1
}
const summary={sessions:sessions.length,declaredTools:tools.length,sessionErrors:errors,responses:0,parsed:0,rejected:{}}
for(const {path}of newest(tracesRoot,'.jsonl',300))for(const line of readFileSync(path,'utf8').split('\n')) {
  if(!line.trim())continue
  const row=JSON.parse(line),span=row.span
  if(row.type!=='span_end'||!span?.name?.startsWith('generation'))continue
  let output=span.toolOutput
  while(typeof output==='string') { try {output=JSON.parse(output)}catch{break} }
  const content=output?.[0]?.choices?.[0]?.message?.content
  if(typeof content!=='string')continue
  const start=content.search(/(?:^|\n)[\t ]*(?:BUDDY_DSH_(?:TOOL|READ)\s|<\s*[|｜]\s*[|｜]\s*DSML)/i)
  if(start<0)continue
  summary.responses++
  try {decodeToolCalls(content.slice(start),tools);summary.parsed++}
  catch(error) {summary.rejected[error.code??'unknown']=(summary.rejected[error.code??'unknown']??0)+1}
}
// This audit is local only. It never executes commands, uploads conversations,
// prints arguments, or reads reasoning fields from the upstream trace.
console.log(JSON.stringify(summary,null,2))
