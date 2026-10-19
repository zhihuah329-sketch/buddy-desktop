<script>
  /**
   * The application shell.
   *
   * Four pages, one visible at a time: an overview, one page per region, and
   * settings. The regions get their own pages rather than sharing one, because they
   * are separate products — an account, a client, a pool and a model name all belong
   * to exactly one of them, and a shared page invited the two to be read together.
   */
  import { onMount, onDestroy } from 'svelte'
  import { fade } from 'svelte/transition'
  import Sidebar from './lib/Sidebar.svelte'
  import Overview from './lib/Overview.svelte'
  import RegionPanel from './lib/RegionPanel.svelte'
  import Settings from './lib/Settings.svelte'
  import CommandCode from './lib/CommandCode.svelte'
  import Checkin from './lib/Checkin.svelte'
  import Toasts from './lib/Toasts.svelte'
  import { createClient } from './lib/client.js'
  import { MODES, applyMode, initialMode, onSystemChange } from './lib/theme.js'

  const client = createClient()

  const REGIONS = [
    {
      site: 'cn',
      title: '国内版',
      host: 'workbuddy.cn',
      note: '客户端加密保存凭据，登录后建议直接「从桌面版读取」。'
    },
    {
      site: 'ai',
      title: '国际版',
      host: 'workbuddy.ai',
      note: '凭据为明文，登录后可直接导入。'
    }
  ]

  /** The chosen theme mode: dark, light, or follow the system. */
  let themeMode = $state(initialMode())

  /** Step to the next mode and apply it. */
  function cycleTheme() {
    const next = MODES[(MODES.indexOf(themeMode) + 1) % MODES.length]
    themeMode = next
    applyMode(next)
  }

  /** The most recent state document, or null before the first load. */
  let state = $state(null)
  /** Every page the shell can show. */
  const PAGE_IDS = ['overview', 'cn', 'ai', 'checkin', 'command-code', 'settings']

  /** The page named by the URL hash, or the overview. */
  function pageFromHash() {
    const candidate = window.location.hash.replace(/^#\/?/, '')
    return PAGE_IDS.includes(candidate) ? candidate : 'overview'
  }

  /**
   * The visible page.
   *
   * Kept in the URL hash so a page can be opened directly, survives a reload, and
   * can be captured for review without simulating a click.
   */
  let page = $state(pageFromHash())

  /** Follow the URL when the user navigates with the browser. */
  function onHashChange() {
    page = pageFromHash()
  }

  /** Navigate to a page and record it in the URL. */
  function go(next) {
    page = next
    if (window.location.hash !== `#/${next}`) window.location.hash = `#/${next}`
  }
  /** Messages shown over the page. */
  let toasts = $state([])
  /** The running action, as `kind:site`. */
  let busy = $state(null)
  /** The most recent scan, kept until the next one. */
  let scanResult = $state(null)

  let timer = null
  /** Stops following the system preference; set on mount. */
  let stopTheme = null

  function accountsOf(site) {
    return (state?.accounts ?? []).filter((account) => account.site === site)
  }

  function usableOf(site) {
    return accountsOf(site).filter((account) => account.usable === true).length
  }

  /**
   * The verdict for a region.
   *
   * One usable account cannot survive a quota window, so a region with exactly one
   * is called out instead of shown as healthy: that is the difference between "it
   * will rotate" and "it stops working when this one runs out".
   */
  function verdictOf(site) {
    const usable = usableOf(site)
    const total = accountsOf(site).length
    if (total === 0) return { tone: 'idle', label: '未配置', note: '还没有账号' }
    if (usable === 0) return { tone: 'bad', label: '不可用', note: '等待额度重置' }
    if (usable === 1) return { tone: 'warn', label: '单账号', note: '用尽后无法切换' }
    return { tone: 'good', label: '已就绪', note: '自动切换' }
  }

  function toast(tone, text) {
    const id = Math.random().toString(36).slice(2)
    toasts = [...toasts, { id, tone, text }]
    setTimeout(() => {
      toasts = toasts.filter((entry) => entry.id !== id)
    }, 4200)
  }

  async function refresh({ quiet = false } = {}) {
    try {
      state = await client.fetchState()
    } catch (error) {
      if (!quiet) toast('bad', error.message)
    }
  }

  /** Run one action, guarding against overlapping runs. */
  async function run(kind, action, onDone) {
    if (busy !== null) return
    busy = kind
    try {
      const result = await action()
      if (result !== null && onDone !== undefined) onDone(result)
      await refresh({ quiet: true })
    } catch (error) {
      toast('bad', error.message)
    } finally {
      busy = null
    }
  }

  async function onReadDesktop(site) {
    await run(`desktop:${site}`, () => client.readFromDesktop(site), (result) => {
      const read = result.read
      if (read?.ok === true) {
        const name = read.credential?.label ?? read.credential?.uid?.slice(0, 8) ?? ''
        toast('good', `已读到账号 ${name}`)
      } else {
        toast('bad', read?.error ?? '读取失败')
      }
    })
  }

  async function onScan(site) {
    await run(`scan:${site}`, () => client.discover(site), (result) => {
      const found = result.discovery?.files?.length ?? 0
      toast(
        found > 0 ? 'good' : 'warn',
        found > 0 ? `找到 ${found} 个凭据文件` : '没有找到凭据，请先在客户端登录'
      )
      scanResult = { site, ...(result.discovery ?? {}) }
    })
  }

  async function onImport(site) {
    await run(`import:${site}`, () => client.importAll(site), (result) => {
      const imported = result.importResult
      if (imported?.ok === true) {
        const changed = (imported.added ?? 0) + (imported.updated ?? 0)
        toast('good', changed > 0 ? `已导入 ${changed} 个账号` : '没有新凭据可导入')
      } else {
        toast('bad', imported?.error ?? '导入失败')
      }
    })
  }

  async function onRemove(account) {
    const name = account.label || account.id.slice(0, 8)
    if (!window.confirm(`从号池移除「${name}」？\n\nWorkBuddy 客户端里的登录不受影响。`)) return
    await run(`remove:${account.id}`, () => client.removeAccount(account.id), () => {
      toast('good', `已移除「${name}」`)
    })
  }

  /** Save a Command Code key, reporting what the server decided. */
  async function onSaveCommandCodeKey(key) {
    if (busy !== null) return false
    busy = 'cc:save'
    try {
      const result = await client.saveCommandCodeKey(key)
      if (result.ok === true) {
        state = result.state ?? state
        toast('good', 'API Key 已保存')
        return true
      }
      toast('bad', result.error ?? '保存失败')
      return false
    } catch (error) {
      toast('bad', error.message)
      return false
    } finally {
      busy = null
    }
  }

  /** Ask the server to verify the stored key. */
  async function onTestCommandCode() {
    if (busy !== null) return null
    busy = 'cc:test'
    try {
      const result = await client.testCommandCode()
      if (result.state !== undefined) state = result.state
      return result.result ?? null
    } catch (error) {
      toast('bad', error.message)
      return { ok: false, message: error.message }
    } finally {
      busy = null
    }
  }

  /** Forget the stored key. */
  async function onClearCommandCodeKey() {
    if (busy !== null) return
    busy = 'cc:clear'
    try {
      const result = await client.clearCommandCodeKey()
      if (result.state !== undefined) state = result.state
      toast('good', 'API Key 已清除')
    } catch (error) {
      toast('bad', error.message)
    } finally {
      busy = null
    }
  }

  /** Run a check-in cycle now, and show what the server reports. */
  async function onRunCheckin() {
    if (busy !== null) return
    busy = 'checkin'
    try {
      const result = await client.runCheckin()
      if (result.checkin !== undefined) {
        // The reply is a snapshot, so it can be merged without a second read.
        state = state === null ? state : { ...state, checkin: result.checkin }
      }
      const claimed = (result.checkin?.checkinAccounts ?? []).filter(
        (account) => account.outcome === 'claimed'
      ).length
      toast(
        claimed > 0 ? 'good' : 'warn',
        claimed > 0 ? `已为 ${claimed} 个账号领取签到` : '今日已经签过了'
      )
    } catch (error) {
      toast('bad', error.message)
    } finally {
      busy = null
    }
  }

  async function onCopyEndpoint() {
    const value = state?.endpoint
    if (typeof value !== 'string' || value.length === 0) return
    try {
      await navigator.clipboard.writeText(value)
      toast('good', '接入地址已复制')
    } catch {
      toast('warn', `请手动复制：${value}`)
    }
  }

  /** The region definition for a page id, when it names one. */
  function regionOf(id) {
    return REGIONS.find((region) => region.site === id)
  }

  onMount(() => {
    window.addEventListener('hashchange', onHashChange)

    // Applied again here rather than only in main.js so a mode change made while
    // the app is open is re-applied after a reload for the right reasons.
    applyMode(themeMode)
    stopTheme = onSystemChange(() => {
      // Only a following user should react; an explicit choice stays put.
      if (themeMode === 'system') applyMode('system')
    })

    refresh()
    // Quota windows expire while the window is open, so the view is re-read rather
    // than only after an action.
    timer = setInterval(() => refresh({ quiet: true }), 20000)
  })

  onDestroy(() => {
    window.removeEventListener('hashchange', onHashChange)
    stopTheme?.()
    clearInterval(timer)
  })
</script>

<div class="shell">
  <Sidebar
    {state}
    {page}
    themeMode={themeMode}
    onSelect={(next) => go(next)}
    onRefresh={() => refresh()}
    onCycleTheme={cycleTheme}
    busy={busy !== null}
  />

  <main class="main">
    {#key page}
      <div class="page-wrap" in:fade={{ duration: 170 }} out:fade={{ duration: 90 }}>
        {#if page === 'overview'}
          <Overview {state} onOpen={(site) => go(site)} />
        {:else if page === 'checkin'}
          <Checkin {state} busyKind={busy} onRun={onRunCheckin} />
        {:else if page === 'command-code'}
          <CommandCode
            appState={state}
            busyKind={busy}
            onSaveKey={onSaveCommandCodeKey}
            onTest={onTestCommandCode}
            onClearKey={onClearCommandCodeKey}
          />
        {:else if page === 'settings'}
          <Settings {state} onCopy={onCopyEndpoint} />
        {:else if regionOf(page) !== undefined}
          <RegionPanel
            region={regionOf(page)}
            verdict={verdictOf(page)}
            accounts={accountsOf(page)}
            client={state?.clients?.[page] ?? null}
            scan={scanResult !== null && scanResult.site === page ? scanResult : null}
            busyKind={busy}
            onReadDesktop={() => onReadDesktop(page)}
            onScan={() => onScan(page)}
            onImport={() => onImport(page)}
            onRemove={onRemove}
          />
        {/if}
      </div>
    {/key}
  </main>
</div>

<Toasts items={toasts} />
