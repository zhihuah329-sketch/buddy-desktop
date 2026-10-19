/**
 * Render the page's real markup to a standalone HTML file for visual review.
 *
 * A screenshot is the only way to judge a layout; reading the source proves nothing.
 * This starts the server, fetches the live state, and writes the page with that data
 * substituted, so what is reviewed is what a user would see.
 *
 * Run: node tools/screenshot.mjs
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
// A dynamic import needs a URL, not a Windows path.
const { startServer } = await import(pathToFileURL(join(ROOT, 'packages/server/src/index.js')).href)

const running = await startServer({ port: 5399 })
try {
  const state = await (await fetch(`${running.url}/api/state`)).json()
  const html = await (await fetch(`${running.url}/`)).text()

  // Replace the module script with the live state so the page renders without a
  // server: the built bundle reads only from /api/state.
  const inlined = html.replace(
    /<script type="module"[^>]*src="([^"]+)"[^>]*><\/script>/,
    (whole, src) => `<script type="module">
      const __state = ${JSON.stringify(state)};
      const realFetch = window.fetch;
      window.fetch = async (url, options) => {
        if (String(url).includes('/api/state')) {
          return new Response(JSON.stringify(__state), { headers: { 'content-type': 'application/json' } });
        }
        return realFetch(url, options);
      };
      </script>
      <script type="module" src="${src}"></script>`
  )

  const out = join(ROOT, 'build', 'preview.html')
  writeFileSync(out, inlined, 'utf8')
  console.log(`已生成 ${out}`)
  console.log(`账号 ${state.accounts?.length ?? 0} 个，接入 ${state.endpoint}`)
} finally {
  await running.close()
}
