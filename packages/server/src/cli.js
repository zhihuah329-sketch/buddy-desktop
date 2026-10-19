#!/usr/bin/env node
/**
 * Start the desktop app.
 *
 * Prints the URL to open rather than launching a browser automatically: on a
 * machine where several harnesses already run, opening the wrong port silently is
 * worse than showing the exact address.
 *
 * @module @buddy-desktop/server/cli
 */

import { startServer } from './index.js'
import { appDataDir } from '@buddy-desktop/core'

/** Read `--name value` and `--flag` from argv. */
function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const name = token.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      out[name] = true
    } else {
      out[name] = next
      i += 1
    }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const port = args.port === undefined ? 5178 : Number(args.port)
const host = typeof args.host === 'string' ? args.host : '127.0.0.1'

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`端口无效：${args.port}`)
  process.exit(1)
}

try {
  const running = await startServer({ port, host })

  console.log('')
  console.log('  Buddy Desktop 已启动')
  console.log('')
  console.log(`  地址   : ${running.url}`)
  console.log(`  数据   : ${appDataDir()}`)
  console.log('')
  console.log('  按 Ctrl+C 停止')
  console.log('')

  const shutdown = async () => {
    await running.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('EADDRINUSE')) {
    console.error(`端口 ${port} 已被占用。换一个：--port 5179`)
  } else {
    console.error(`启动失败：${message}`)
  }
  process.exit(1)
}
