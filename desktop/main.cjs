const {
  app,
  BrowserWindow,
  globalShortcut,
  screen,
  session,
  protocol,
  net: electronNet,
  dialog,
} = require('electron')

const path = require('path')
const net = require('net')
const http = require('http')
const crypto = require('crypto')
const fs = require('fs')
const { pathToFileURL } = require('url')
const { spawn } = require('child_process')

const HOST = '127.0.0.1'
const RENDERER_SCHEME = 'ultron'
const RENDERER_HOST = 'app'
const RENDERER_ORIGIN = `${RENDERER_SCHEME}://${RENDERER_HOST}`

/*
 * The packaged renderer uses an app-owned secure origin instead of file://.
 * That gives the loopback API one precise CORS origin and keeps browser
 * security features such as CSP and same-origin checks available.
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: RENDERER_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
])

let backend = null
let backendPort = null
let backendLaunchSecret = null
let backendInstanceId = null
let window = null
let f14Registered = false

const DEV_ICON = path.join(
  __dirname,
  'assets',
  'ultron-apple-black.png'
)

const APP_ICON =
  app.isPackaged
    ? path.join(
        process.resourcesPath,
        'ultron-apple-black.png'
      )
    : DEV_ICON

const gotSingleInstanceLock =
  app.requestSingleInstanceLock()

if (!gotSingleInstanceLock) {
  app.quit()
}

app.on('second-instance', () => {
  if (!window) {
    return
  }

  showUltron()
})


function resource(...parts) {
  return path.join(
    app.isPackaged
      ? process.resourcesPath
      : path.join(__dirname, 'resources'),
    ...parts
  )
}

function isRendererUrl(url) {
  try {
    const parsed = new URL(url)
    return (
      parsed.protocol === `${RENDERER_SCHEME}:` &&
      parsed.hostname === RENDERER_HOST
    )
  } catch {
    return false
  }
}

function rendererFileForRequest(requestUrl) {
  if (!isRendererUrl(requestUrl)) {
    return null
  }

  const parsed = new URL(requestUrl)

  let pathname
  try {
    pathname = decodeURIComponent(parsed.pathname || '/')
  } catch {
    return null
  }

  if (pathname === '/') {
    pathname = '/index.html'
  }

  if (pathname.includes('\0')) {
    return null
  }

  let root
  let target
  try {
    root = path.resolve(resource('frontend'))
    target = path.resolve(root, `.${pathname}`)
  } catch {
    return null
  }

  if (
    target !== root &&
    !target.startsWith(`${root}${path.sep}`)
  ) {
    return null
  }

  return target
}

function registerRendererProtocol() {
  protocol.handle(RENDERER_SCHEME, request => {
    const file = rendererFileForRequest(request.url)

    if (!file || !fs.existsSync(file)) {
      return new Response('Not found', { status: 404 })
    }

    return electronNet.fetch(pathToFileURL(file).toString())
  })
}

function reserveLoopbackPort() {
  return new Promise(resolve => {
    const server = net.createServer()

    server.once('error', () => resolve(null))
    server.listen(0, HOST, () => {
      const address = server.address()
      const port = typeof address === 'object' && address
        ? address.port
        : null

      server.close(() => resolve(port))
    })
  })
}

function backendHealthy() {
  if (!backendPort || !backendLaunchSecret || !backendInstanceId) {
    return Promise.resolve(false)
  }

  return new Promise(resolve => {
    const request = http.request(
      {
        host: HOST,
        port: backendPort,
        path: '/api/health',
        method: 'GET',
        headers: {
          'X-Ultron-Launch-Secret': backendLaunchSecret,
        },
        timeout: 700,
      },
      response => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', chunk => { body += chunk })
        response.on('end', () => {
          try {
            const status = JSON.parse(body)
            resolve(
              response.statusCode === 200 &&
              status?.status === 'online' &&
              status?.instance_id === backendInstanceId
            )
          } catch {
            resolve(false)
          }
        })
      }
    )

    request.once('timeout', () => {
      request.destroy()
      resolve(false)
    })
    request.once('error', () => resolve(false))
    request.end()
  })
}

async function startBackend() {
  const executable = resource(
    'backend',
    'ultron-backend'
  )

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const port = await reserveLoopbackPort()

    if (!port) {
      continue
    }

    backendPort = port
    backendLaunchSecret = crypto.randomBytes(32).toString('hex')
    backendInstanceId = crypto.randomBytes(18).toString('hex')

    backend = spawn(
      executable,
      [],
      {
        stdio: 'ignore',
        detached: false,
        env: {
          ...process.env,
          ULTRON_PORT: String(backendPort),
          ULTRON_LAUNCH_SECRET: backendLaunchSecret,
          ULTRON_LAUNCH_INSTANCE_ID: backendInstanceId,
        },
      }
    )

    backend.on('error', error => {
      console.error(
        'ULTRON backend error:',
        error
      )
    })

    if (await waitForBackend()) {
      return true
    }

    try {
      backend.kill()
    } catch {}

    backend = null
  }

  backendPort = null
  backendLaunchSecret = null
  backendInstanceId = null
  return false
}

async function waitForBackend() {
  const started = Date.now()

  while (Date.now() - started < 15000) {
    if (await backendHealthy()) {
      return true
    }

    await new Promise(resolve => {
      setTimeout(resolve, 250)
    })
  }

  return false
}

function forceNormalWindow() {
  if (!window) {
    return
  }

  try {
    window.setFullScreen(false)
  } catch {}

  try {
    if (
      typeof window.setSimpleFullScreen ===
      'function'
    ) {
      window.setSimpleFullScreen(false)
    }
  } catch {}

  try {
    window.unmaximize()
  } catch {}

  const display =
    screen.getPrimaryDisplay()

  const workArea =
    display.workArea

  const width = 1450
  const height = 850

  const x =
    Math.round(
      workArea.x +
      (workArea.width - width) / 2
    )

  const y =
    Math.round(
      workArea.y +
      (workArea.height - height) / 2
    )

  window.setBounds(
    {
      x,
      y,
      width,
      height,
    },
    false
  )
}

function showUltron() {
  if (!window) {
    return
  }

  forceNormalWindow()

  window.show()
  window.focus()

  console.log(
    'ULTRON: SHOW NORMAL WINDOW'
  )
}

function hideUltron() {
  if (!window) {
    return
  }

  window.hide()

  console.log(
    'ULTRON: HIDE'
  )
}

function toggleUltron() {
  if (!window) {
    return
  }

  if (window.isVisible()) {
    hideUltron()
  } else {
    showUltron()
  }
}

function createWindow(showWhenReady = false) {
  window =
    new BrowserWindow({
      width: 1450,
      height: 850,

      minWidth: 1100,
      minHeight: 700,

      title: 'ULTRON ai',
      backgroundColor: '#030303',
      icon: APP_ICON,

      fullscreen: false,
      fullscreenable: false,

      resizable: true,
      maximizable: false,
      minimizable: true,

      show: false,

      // Vera finestra macOS.
      titleBarStyle: 'default',

      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        devTools: !app.isPackaged,
      },
    })

  window.setFullScreen(false)

  if (
    typeof window.setSimpleFullScreen ===
    'function'
  ) {
    window.setSimpleFullScreen(false)
  }

  const rendererUrl = new URL(`${RENDERER_ORIGIN}/index.html`)

  if (backendPort && backendLaunchSecret) {
    rendererUrl.searchParams.set('ultronPort', String(backendPort))
    rendererUrl.searchParams.set('ultronLaunchSecret', backendLaunchSecret)
  }

  window.loadURL(rendererUrl.toString())

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (!isRendererUrl(url)) {
      event.preventDefault()
    }
  })

  window.once(
    'ready-to-show',
    () => {
      forceNormalWindow()

      if (showWhenReady) {
        showUltron()
      } else {
        hideUltron()
      }
    }
  )

  window.on(
    'enter-full-screen',
    () => {
      forceNormalWindow()
    }
  )

  window.on(
    'enter-html-full-screen',
    () => {
      forceNormalWindow()
    }
  )

  window.on(
    'maximize',
    () => {
      setTimeout(
        forceNormalWindow,
        50
      )
    }
  )

  window.on(
    'closed',
    () => {
      window = null
    }
  )

  forceNormalWindow()
  hideUltron()
}

app.whenReady().then(
  async () => {
    /*
     * Voice capture is granted only to ULTRON's packaged local interface.
     * macOS still owns the visible microphone prompt, which is triggered by
     * the operator pressing ARM VOICE in the command console.
     */
    session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
      return permission === 'media' && isRendererUrl(webContents.getURL())
    })

    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
      callback(permission === 'media' && isRendererUrl(webContents.getURL()))
    })

    if (
      process.platform ===
      'darwin'
    ) {
      app.dock.show()

      try {
        /* Set it at runtime as well so macOS refreshes an existing Dock cache. */
        app.dock.setIcon(APP_ICON)
      } catch (error) {
        console.error(
          'ULTRON Dock icon error:',
          error
        )
      }
    }

    registerRendererProtocol()

    const ready = await startBackend()

    if (!ready) {
      console.error(
        'ULTRON backend did not start.'
      )
      await dialog.showMessageBox({
        type: 'error',
        title: 'ULTRON could not start',
        message: 'The local ULTRON Core did not start.',
        detail: 'Restart ULTRON. If this continues, reinstall the application from a complete package.',
      })
      app.quit()
      return
    }

    createWindow(true)

    f14Registered =
      globalShortcut.register(
        'F14',
        toggleUltron
      )

    console.log(
      'ULTRON F14 registered:',
      f14Registered
    )

    if (
      app.isPackaged &&
      process.env.ULTRON_START_AT_LOGIN === 'true'
    ) {
      try {
        app.setLoginItemSettings({
          openAtLogin: true,
          openAsHidden: true,
        })
      } catch (error) {
        console.error(
          'Login item error:',
          error
        )
      }
    }
  }
)

app.on(
  'activate',
  () => {
    if (!window) {
      createWindow(true)
      return
    }

    showUltron()
  }
)

app.on(
  'will-quit',
  () => {
    globalShortcut.unregister(
      'F14'
    )

    globalShortcut.unregisterAll()

    if (backend) {
      try {
        backend.kill()
      } catch {}
    }
  }
)

app.on(
  'window-all-closed',
  () => {
    if (
      process.platform !==
      'darwin'
    ) {
      app.quit()
    }
  }
)
