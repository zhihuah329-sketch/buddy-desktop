import Ajv from 'ajv'
import Ajv2020 from 'ajv/dist/2020.js'

export const MAX_TOOL_CHARS = 2 * 1024 * 1024
const OPEN = String.raw`<\s*\|\s*\|\s*DSML\s*\|\s*\|\s*`
const CLOSE = String.raw`<\s*/\s*\|\s*\|\s*DSML\s*\|\s*\|\s*`

function fail(code, message) { throw Object.assign(new Error(message), { code }) }

export function schemaValidator(schema) {
  if (schema === undefined) return () => true
  const Validator = /2020-12/.test(schema?.$schema ?? '') ? Ajv2020 : Ajv
  // Validation never changes tool arguments, fetches references, or grants permissions.
  const ajv = new Validator({ strict: false, validateFormats: false, allErrors: false })
  try { return ajv.compile(schema) }
  catch { fail('CODEBUDDY_SCHEMA', '调用方提供了无法校验的 JSON Schema。') }
}

export function parseJsonValue(text, completeEnvelope = false) {
  const start = text.search(/[\[{]/)
  if (start < 0) fail('CODEBUDDY_TOOL_JSON', '工具请求中没有 JSON 对象。')
  const closing = []
  let quoted = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (escaped) { escaped = false; continue }
    if (quoted && char === '\\') { escaped = true; continue }
    if (char === '"') { quoted = !quoted; continue }
    if (quoted) continue
    if (char === '{') closing.push('}')
    if (char === '[') closing.push(']')
    if (char === '}' || char === ']') {
      if (closing.pop() !== char) fail('CODEBUDDY_TOOL_JSON', '工具请求的 JSON 括号不匹配。')
      if (closing.length === 0) {
        try { return { value: JSON.parse(text.slice(start, index + 1)), end: index + 1 } }
        catch { fail('CODEBUDDY_TOOL_JSON', '工具请求 JSON 格式无效，参数未执行。') }
      }
    }
  }
  // Only the enclosing object may be completed. Inner arguments must be intact.
  if (completeEnvelope && text[start] === '{' && !quoted && !escaped && closing.length === 1 && closing[0] === '}') {
    try { return { value: JSON.parse(text.slice(start).trimEnd() + '}'), end: text.length } }
    catch { /* reject incomplete inner values */ }
  }
  fail('CODEBUDDY_TOOL_JSON', '工具请求 JSON 不完整，参数未执行。')
}

function normalizeCall(input, tools) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('CODEBUDDY_TOOL_JSON', '工具请求必须是对象。')
  const call = input.function ?? input
  if (typeof call.name !== 'string') fail('CODEBUDDY_TOOL_NAME', '工具请求缺少名称。')
  const name = call.name.replace(/^functions\./i, '').toLowerCase()
  const tool = tools.find(tool => tool.name === call.name) ?? tools.find(tool => tool.name.toLowerCase() === name)
  if (!tool) fail('CODEBUDDY_TOOL_NAME', `工具未在 DSH 中声明：${call.name.slice(0, 128)}。`)
  let args
  if (Object.hasOwn(call, 'arguments')) args = call.arguments
  else {
    // A complete flattened envelope is unambiguous only after schema validation.
    args = Object.fromEntries(Object.entries(call).filter(([key]) => key !== 'name'))
  }
  if (typeof args === 'string') {
    try { args = JSON.parse(args) }
    catch { fail('CODEBUDDY_TOOL_JSON', `工具 ${tool.name} 的 arguments 不是完整 JSON。`) }
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) fail('CODEBUDDY_TOOL_ARGUMENTS', `工具 ${tool.name} 的参数必须是对象。`)
  const validate = schemaValidator(tool.parameters)
  if (!validate(args)) {
    const error = validate.errors?.[0]
    const field = error?.params?.missingProperty ?? error?.instancePath ?? ''
    fail('CODEBUDDY_TOOL_ARGUMENTS', `工具 ${tool.name} 的参数不符合定义（${String(field).slice(0, 120) || '/'}：${error?.keyword ?? 'schema'}），未执行。`)
  }
  return { name: tool.name, arguments: JSON.stringify(args) }
}

function dsmlCalls(text) {
  const normalized = text.replace(/(<\s*\/?\s*)[|｜]\s*[|｜](\s*DSML\s*)[|｜]\s*[|｜]/gi, '$1||$2||')
  const envelope = new RegExp(String.raw`^${OPEN}((?:tool_)?calls)\s*>([\s\S]*?)${CLOSE}\1\s*>\s*(?:\x60{3})?\s*$`, 'i').exec(normalized)
  if (!envelope) fail('CODEBUDDY_TOOL_JSON', 'DSML 工具请求不完整。')
  const invoke = new RegExp(String.raw`\s*${OPEN}invoke\s+name="([\w.-]+)"\s*>([\s\S]*?)${CLOSE}invoke\s*>`, 'iy')
  const parameter = new RegExp(String.raw`\s*${OPEN}parameter\s+name="([\w.-]+)"\s+string="(true|false)"\s*>([\s\S]*?)${CLOSE}parameter\s*>`, 'iy')
  const calls = []
  let rest = envelope[2].trim()
  while (rest) {
    invoke.lastIndex = 0
    const match = invoke.exec(rest)
    if (!match) fail('CODEBUDDY_TOOL_JSON', 'DSML 工具调用格式无效。')
    const args = Object.create(null)
    let params = match[2].trim()
    while (params) {
      parameter.lastIndex = 0
      const field = parameter.exec(params)
      if (!field || Object.hasOwn(args, field[1])) fail('CODEBUDDY_TOOL_ARGUMENTS', 'DSML 参数无效或重复。')
      const key = /^read$/i.test(match[1]) && field[1] === 'path' ? 'file_path' : field[1]
      try { args[key] = field[2].toLowerCase() === 'true' ? field[3] : JSON.parse(field[3]) }
      catch { fail('CODEBUDDY_TOOL_ARGUMENTS', 'DSML 参数中的 JSON 无效。') }
      params = params.slice(parameter.lastIndex).trim()
    }
    calls.push({ name: match[1], arguments: args })
    rest = rest.slice(invoke.lastIndex).trim()
  }
  if (!calls.length) fail('CODEBUDDY_TOOL_JSON', 'DSML 没有工具调用。')
  return calls
}

export function decodeToolCalls(text, tools, maxCalls = 32) {
  if (text.length > MAX_TOOL_CHARS) fail('CODEBUDDY_TOOL_LIMIT', '工具请求超过 2 MiB 字符限制。')
  let rest = text.trim().replace(/^```(?:json|xml)?\s*/i, '').replace(/\s*```$/, '').trim()
  let calls = []
  if (/^<\s*[|｜]/.test(rest)) calls = dsmlCalls(rest)
  else {
    while (rest) {
      const marker = /^(BUDDY_DSH_TOOL|BUDDY_DSH_READ)\s+/.exec(rest)
      if (marker) rest = rest.slice(marker[0].length)
      if (!/^[{[]/.test(rest)) fail('CODEBUDDY_TOOL_JSON', '工具请求包含无法解析的额外内容。')
      const parsed = parseJsonValue(rest, marker?.[1] === 'BUDDY_DSH_TOOL')
      const value = marker?.[1] === 'BUDDY_DSH_READ' ? { name: 'read', arguments: parsed.value } : parsed.value
      calls.push(...(Array.isArray(value) ? value : Array.isArray(value.tool_calls) ? value.tool_calls : [value]))
      rest = rest.slice(parsed.end).trim()
      if (rest && !/^(?:BUDDY_DSH_|[\[{,}\]])/.test(rest)) {
        const next = /(?:^|\n)[\t ]*BUDDY_DSH_(?:READ|TOOL)\s/.exec(rest)
        rest = next ? rest.slice(next.index).trimStart() : ''
      }
    }
  }
  if (calls.length > maxCalls) fail('CODEBUDDY_TOOL_LIMIT', `本次请求最多允许 ${maxCalls} 个工具调用。`)
  // Validate all calls before returning any, so partial batches never execute.
  return calls.map(call => normalizeCall(call, tools))
}

export function structuredResponse(text, format) {
  const value = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  let parsed
  try { parsed = JSON.parse(value) }
  catch { fail('CODEBUDDY_RESPONSE_JSON', 'CodeBuddy 没有返回完整的 JSON 结果。') }
  if (format.type === 'json_object' && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))) {
    fail('CODEBUDDY_RESPONSE_JSON', '请求要求返回一个 JSON 对象。')
  }
  if (format.type === 'json_schema' && !schemaValidator(format.json_schema?.schema)(parsed)) {
    fail('CODEBUDDY_RESPONSE_SCHEMA', 'CodeBuddy 返回的 JSON 不符合请求的 Schema。')
  }
  return JSON.stringify(parsed)
}
