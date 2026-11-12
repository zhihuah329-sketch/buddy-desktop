import assert from 'node:assert/strict'
import { preparePayload, normalizeFrame } from '../packages/core/src/proxy.js'
import { pumpAnswer } from '../packages/server/src/forward.js'

const model = 'deepseek-v4.1-flash'
assert.equal(preparePayload({ model }).reasoning_effort, 'high')
assert.equal(preparePayload({ model, reasoning: { enabled: false } }).reasoning_effort, undefined)
assert.equal(preparePayload({ model, reasoning_effort: 'low' }).reasoning_effort, 'low')
assert.equal(preparePayload({ model, thinking: { type: 'disabled' } }).reasoning_effort, undefined)
assert.equal(preparePayload({ model: 'other' }).reasoning_effort, undefined)

for (const field of ['reasoning', 'thinking', 'reasoning_content']) {
  const value = normalizeFrame({ choices: [{ delta: { [field]: 'test thought' } }] }, model)
  assert.equal(value.choices[0].delta.reasoning_content, 'test thought')
}

for (const ending of ['\n', '\r\n']) {
  let writer
  let outcome
  const body = new ReadableStream({ start(controller) { writer = controller } })
  const encoder = new TextEncoder()
  const pump = pumpAnswer({
    response: { body }, model, account: { id: 'test' },
    pool: { finish(_id, ok) { outcome = ok } }
  })
  const thought = JSON.stringify({ choices: [{ delta: { reasoning: 'test thought' } }] })
  const bytes = encoder.encode(`: heartbeat${ending}${ending}data: ${thought}${ending}${ending}`)
  for (const byte of bytes) writer.enqueue(Uint8Array.of(byte))
  let timeout
  try {
    const first = await Promise.race([
      pump.next(),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Thought was buffered until completion')), 1000) })
    ])
    assert.match(new TextDecoder().decode(first.value), /reasoning_content/)
    // The upstream is still open when the first reasoning frame arrives.
    writer.enqueue(encoder.encode(`data: {"choices":[{"delta":{"content":"OK"}}]}${ending}${ending}data: [DONE]${ending}${ending}`))
    writer.close()
    let rest = ''
    for await (const chunk of pump) rest += new TextDecoder().decode(chunk)
    assert.match(rest, /"content":"OK"/)
    assert.match(rest, /data: \[DONE\]/)
    assert.equal(outcome, true)
  } finally {
    clearTimeout(timeout)
    try { writer.close() } catch {}
  }
}
console.log('Reasoning reaches the client before completion with LF and fragmented CRLF streams.')
