# Buddy Desktop

A standalone Windows desktop app for managing WorkBuddy multi-account pools — with
its own window, its own installer, and no dependency on DeepSeek Harness.

<!-- Badges -->
![platform](https://img.shields.io/badge/platform-Windows%2010%2F11-0078d4)
![node](https://img.shields.io/badge/node-%E2%89%A520-339933)
![svelte](https://img.shields.io/badge/svelte-5-ff3e00)
![license](https://img.shields.io/badge/license-MIT-blue)

---

## What it does

WorkBuddy ships two separate products — 国内版 (`workbuddy.cn`) and 国际版
(`workbuddy.ai`) — each with its own login and its own quota. Buddy Desktop reads the
accounts you are already signed into on this machine and puts them in a pool that
rotates automatically:

- **Reads credentials from the desktop client** without touching its login state.
- **Rotates on quota exhaustion** — a spent account cools down until the reset time
  named in the upstream message, and the next account serves the retry.
- **Keeps the two regions apart** — they never share an account and never fall back to
  each other.
- **Forwards model calls** over an OpenAI-compatible endpoint, so any existing tool
  works by pointing its base URL here.
- **Command Code channel** — a second, independent path authenticated with an API key,
  offering Claude, GPT, DeepSeek, Kimi and GLM models.

## Screens

Five pages, one visible at a time: an overview, one page per region, Command Code, and
settings. Pages are addressed by URL hash, so any of them can be opened directly.

| Page | Contents |
| --- | --- |
| 概览 | Both regions as summary cards, account totals, accounts needing attention |
| 国内版 | Accounts, client path, read / scan / import actions |
| 国际版 | The same, fully independent |
| Command Code | API key management, 15 models, connection test |
| 设置 | Endpoint, model names, paths |

Dark and light themes, plus a follow-the-system mode.

## Install

Download `BuddyDesktop-Setup.exe` from [Releases](../../releases) and run it. It
installs per-user under `%LOCALAPPDATA%\Programs\BuddyDesktop`, adds Start-menu and
desktop shortcuts, and registers an uninstaller. No Node installation is required.

## Use it for model calls

| Setting | Value |
| --- | --- |
| Base URL | `http://127.0.0.1:5178/v1` |
| 国内版 model | `deepseek-v4.1-flash-cn` |
| 国际版 model | `deepseek-v4.1-flash-ai` |

The `-cn` / `-ai` suffix chooses the pool. A region never falls back to the other, so
retries stay inside it.

```bash
curl http://127.0.0.1:5178/v1/chat/completions \
  -H "content-type: application/json" \
  -d '{"model":"deepseek-v4.1-flash-cn","messages":[{"role":"user","content":"hi"}]}'
```

Streaming works the same way: pass `"stream": true` and the answer arrives as SSE.

## Architecture

```
buddy-desktop/
├── packages/
│   ├── core/      Framework-free logic (72 exports, 21 modules)
│   ├── server/    Local HTTP API, model forwarding, static host
│   ├── desktop/   Electron shell — window and tray
│   └── ui/        Svelte 5 interface
└── tools/         Build, capture and self-check scripts
```

`core` has no framework dependency at all: account pool, quota rotation, credential
reading, the encrypted store and check-in all live there and are reused unchanged.

### How credentials are read

The reader ships inside the `dsh-workbuddy-connect` package as a content-hashed bundle,
and it imports exactly one DSH package:

```js
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
```

That package cannot be installed outside a harness profile, but it is only used to pick
a directory for four cache files. `packages/core/src/sibling.js` removes that single
import statement, injects a local shim, and loads the bundle from a `data:` URL.
Everything else in it needs only Node builtins.

This is deliberately narrow: if the bundle ever needs another DSH package, the rewrite
stops matching and the caller gets a clear error instead of a broken reader.

## Build from source

```bash
pnpm install
pnpm build                        # build the interface
node tools/build-exe.mjs          # single-file exe (Node SEA)
node tools/build-installer.mjs    # Windows installer (NSIS)
```

The installer needs a cached or installed NSIS; `tools/build-installer.mjs` looks for
the one electron-builder leaves in `%LOCALAPPDATA%`.

### Checks

```bash
node selfcheck.mjs                # 16 checks, includes a real upstream call
node verify-packaged.mjs 5178     # verify a running instance
node tools/click-test.mjs 5178    # drive the real buttons in a browser
```

## Data and privacy

| What | Where |
| --- | --- |
| Account store | `~/.buddyhub` (reuses the DSH plugin's store when present) |
| App data | `~/.buddy-desktop` |
| Command Code key | the app's state directory, mode `0600` |

Nothing is uploaded. The server binds to `127.0.0.1` only and rejects requests whose
`Origin` is not loopback, so a page open in the same browser cannot drive it.

## Requirements

- Windows 10 or 11
- A WorkBuddy desktop client installed and signed in (for the region pools)
- The `dsh-workbuddy-connect` package, for reading credentials — a DSH profile that
  already has it is reused automatically

## License

MIT. See [LICENSE](LICENSE).
