/**
 * The desktop window.
 *
 * ## What this is
 *
 * A real application window, not a page to open in a browser. The app's own HTTP
 * server starts on a private loopback port and the window loads it; the tray keeps
 * the process alive after the window is closed, and the endpoint stays up so a tool
 * already pointed at it does not break.
 *
 * ## Why CommonJS
 *
 * Electron's main process does not expose its API through ES module named exports,
 * and its default export is an empty object under `type: module`. Loading it as
 * CommonJS is the supported path, so the shell is CommonJS and the ESM server is
 * brought in with a dynamic import.
 *
 * @module @buddy-desktop/desktop/main
 */

const { app, BrowserWindow, Menu, Tray, nativeImage, shell, dialog, clipboard } = require('electron')
const { join } = require('node:path')
const { appendFileSync } = require('node:fs')
const { tmpdir } = require('node:os')

/** Fixed port keeps the forwarding endpoint stable across restarts. */
const PORT = Number(process.env.BUDDY_DESKTOP_PORT || 5178)

// Electron has no console when launched from a shortcut, so a failure before the
// window exists would otherwise be invisible. This writes it where it can be read.
const LOG = join(tmpdir(), 'buddy-desktop-main.log')
function trace(message) {
  try {
    appendFileSync(LOG, `${new Date().toISOString()} ${message}\n`)
  } catch {
    // Logging must never be the reason the app fails to start.
  }
}

process.on('uncaughtException', (error) => {
  trace(`uncaught: ${error && error.stack ? error.stack : String(error)}`)
  dialog.showErrorBox('Buddy Desktop 出错', error && error.message ? error.message : String(error))
  app.quit()
})
process.on('unhandledRejection', (reason) => {
  trace(`unhandled: ${reason && reason.stack ? reason.stack : String(reason)}`)
})

let mainWindow = null
let tray = null
let running = null
/** Whether the user asked to quit, so closing the window only hides it. */
let quitting = false
/** Set once the server is up, so a late `activate` can still open a window. */
let pageUrl = null

/**
 * A tray icon drawn in memory.
 *
 * A shipped image would be another file to lose during packaging; a generated
 * bitmap behaves the same and keeps the app a single artefact.
 *
 * @returns {import('electron').NativeImage} a 16x16 icon.
 */
function trayIcon() {
  const size = 16
  const buffer = Buffer.alloc(size * size * 4)
  const centre = (size - 1) / 2
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const distance = Math.hypot(x - centre, y - centre)
      if (distance > 7.2) continue
      const offset = (y * size + x) * 4
      const core = distance < 3.1
      buffer[offset] = core ? 240 : 90 // B
      buffer[offset + 1] = core ? 150 : 160 // G
      buffer[offset + 2] = core ? 90 : 240 // R
      buffer[offset + 3] = 255 // A
    }
  }
  return nativeImage.createFromBuffer(buffer, { width: size, height: size })
}

/**
 * Build the application menu.
 *
 * Deliberately small: the window has no document workflow. The one entry that
 * matters is the endpoint, which is what a user needs to actually use the app.
 *
 * @param {string} url the page URL.
 * @param {string} endpoint the model endpoint.
 */
function buildMenu(url, endpoint) {
  return Menu.buildFromTemplate([
    {
      label: '应用',
      submenu: [
        { label: '复制模型接入地址', click: () => clipboard.writeText(endpoint) },
        { label: '在浏览器中打开', click: () => shell.openExternal(url) },
        { type: 'separator' },
        { label: '退出', accelerator: 'CmdOrCtrl+Q', click: () => { quitting = true; app.quit() } }
      ]
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新载入' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' }
      ]
    }
  ])
}

/**
 * Create the main window.
 *
 * @param {string} url what to load.
 */
function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 800,
    minWidth: 560,
    minHeight: 480,
    // The page is dark; a white flash before it loads is jarring.
    backgroundColor: '#0f1115',
    title: 'Buddy Desktop',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      // The page needs no Node access: everything it does goes through the server.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  })

  // Showing only once the first paint is ready avoids a blank frame.
  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.loadURL(url)

  // External links belong in the browser, not in a window with no way back.
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target)
    return { action: 'deny' }
  })

  mainWindow.on('close', (event) => {
    // Closing hides the window; the endpoint keeps serving so a tool using it does
    // not break because the user tidied their taskbar.
    if (!quitting) {
      event.preventDefault()
      mainWindow.hide()
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

/**
 * Create the tray icon and its menu.
 *
 * @param {string} url the page URL.
 * @param {string} endpoint the model endpoint.
 */
function createTray(url, endpoint) {
  tray = new Tray(trayIcon())
  tray.setToolTip('Buddy Desktop')
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: '显示窗口',
      click: () => {
        if (mainWindow === null) createWindow(url)
        else {
          mainWindow.show()
          mainWindow.focus()
        }
      }
    },
    { label: '复制模型接入地址', click: () => clipboard.writeText(endpoint) },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit() } }
  ]))
  tray.on('double-click', () => {
    if (mainWindow === null) createWindow(url)
    else {
      mainWindow.show()
      mainWindow.focus()
    }
  })
}

// Only one instance: a second launch focuses the existing window instead of
// starting a second server.
if (app.requestSingleInstanceLock() === false) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow === null) return
    mainWindow.show()
    mainWindow.focus()
  })

  app.whenReady().then(async () => {
    trace('app ready')

    let serverModule
    try {
      serverModule = await import('@buddy-desktop/server')
      trace('server module loaded')
    } catch (error) {
      trace(`server import failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
      dialog.showErrorBox('启动失败', `无法加载本地服务：${error instanceof Error ? error.message : String(error)}`)
      app.quit()
      return
    }

    try {
      running = await serverModule.startServer({ port: PORT })
      trace(`server listening at ${running.url}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      trace(`server start failed: ${message}`)

      // A second copy, or another program, may already hold the port. Refusing to
      // start would leave the user with an error box and nothing to act on, so the
      // next few ports are tried before giving up.
      let recovered = false
      if (message.includes('EADDRINUSE')) {
        for (const candidate of [PORT + 1, PORT + 2, PORT + 3, 0]) {
          try {
            running = await serverModule.startServer({ port: candidate })
            trace(`recovered on port ${running.port}`)
            recovered = true
            break
          } catch {
            // Try the next one.
          }
        }
      }

      if (!recovered) {
        dialog.showErrorBox(
          '启动失败',
          message.includes('EADDRINUSE')
            ? `端口 ${PORT} 已被占用，且备用端口也不可用。\n\n请关闭占用该端口的程序后重试。`
            : `无法启动本地服务：${message}`
        )
        app.quit()
        return
      }
    }

    pageUrl = running.url
    const endpoint = `${pageUrl}/v1`
    Menu.setApplicationMenu(buildMenu(pageUrl, endpoint))
    createWindow(pageUrl)
    createTray(pageUrl, endpoint)
    trace(`window and tray created; endpoint ${endpoint}`)

    console.log(`界面: ${pageUrl}`)
    console.log(`接入: ${endpoint}`)
  })

  app.on('activate', () => {
    if (pageUrl === null) return
    if (mainWindow === null) createWindow(pageUrl)
    else mainWindow.show()
  })

  app.on('before-quit', async () => {
    quitting = true
    if (running !== null) {
      await running.close().catch(() => {})
      running = null
    }
  })

  // The tray owns the app's lifetime; a closed window must not end the process.
  app.on('window-all-closed', () => {})
}
