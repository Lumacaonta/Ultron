const {
  app,
  BrowserWindow,
  globalShortcut,
  screen,
  session,
  protocol,
  net: electronNet,
  dialog,
  ipcMain,
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
let backendDesktopPickerSecret = null
// The account bearer token lives only in Electron main for the lifetime of
// this window. It lets the native picker prove both the local account and the
// native dialog result to the loopback Core; it is never written to disk.
let backendSessionToken = null
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

const PRELOAD_PATH = path.join(__dirname, 'preload.cjs')

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

function backendExecutableName() {
  return process.platform === 'win32'
    ? 'ultron-backend.exe'
    : 'ultron-backend'
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

/*
 * Media is the only browser permission ULTRON needs. Keep the decision in one
 * place so a newly-added web surface cannot accidentally gain camera or screen
 * capture access through Electron's broad `media` permission category.
 */
function isLocalMicrophonePermission(
  webContents,
  permission,
  requestingOrigin,
  requestedMedia
) {
  if (
    permission !== 'media' ||
    !webContents ||
    !isRendererUrl(webContents.getURL()) ||
    (requestingOrigin && !isRendererUrl(requestingOrigin))
  ) {
    return false
  }

  if (Array.isArray(requestedMedia)) {
    return requestedMedia.length === 1 && requestedMedia[0] === 'audio'
  }

  return requestedMedia === 'audio'
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
  protocol.handle(RENDERER_SCHEME, async request => {
    const file = rendererFileForRequest(request.url)

    if (!file || !fs.existsSync(file)) {
      return new Response('Not found', { status: 404 })
    }

    // The renderer is packaged locally and is replaced on every update. Do
    // not let Chromium reuse an older HTML shell or asset after an app update.
    const response = await electronNet.fetch(pathToFileURL(file).toString())
    const headers = new Headers(response.headers)
    headers.set('Cache-Control', 'no-store')

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
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

function callDesktopBackend(pathname, payload) {
  if (
    !backendPort ||
    !backendLaunchSecret ||
    !backendDesktopPickerSecret
  ) {
    return Promise.reject(
      new Error('Ultron AI is not ready.')
    )
  }

  if (!backendSessionToken) {
    return Promise.reject(
      new Error('Sign in to Ultron AI before selecting a local file or application.')
    )
  }

  const body = JSON.stringify(payload)

  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: HOST,
        port: backendPort,
        path: pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'Authorization': `Bearer ${backendSessionToken}`,
          'X-Ultron-Launch-Secret': backendLaunchSecret,
          'X-Ultron-Desktop-Picker': backendDesktopPickerSecret,
        },
        timeout: 15000,
      },
      response => {
        let responseBody = ''
        response.setEncoding('utf8')
        response.on('data', chunk => {
          responseBody += chunk
          if (responseBody.length > 1024 * 1024) {
            request.destroy()
            reject(new Error('The Ultron AI Core returned an invalid response.'))
          }
        })
        response.on('end', () => {
          let parsed = null
          try {
            parsed = JSON.parse(responseBody || '{}')
          } catch {
            reject(new Error('The Ultron AI Core returned an invalid response.'))
            return
          }

          if (
            response.statusCode < 200 ||
            response.statusCode >= 300 ||
            parsed?.ok === false
          ) {
            reject(
              new Error(
                parsed?.detail ||
                parsed?.error ||
                'Ultron AI could not register this local selection.'
              )
            )
            return
          }

          resolve(parsed)
        })
      }
    )

    request.once('timeout', () => {
      request.destroy()
      reject(new Error('Ultron AI did not respond in time.'))
    })
    request.once('error', reject)
    request.end(body)
  })
}

async function startBackend() {
  const executable = resource(
    'backend',
    backendExecutableName()
  )

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const port = await reserveLoopbackPort()

    if (!port) {
      continue
    }

    backendPort = port
    // A new Core must receive a fresh account sync from its renderer.
    backendSessionToken = null
    backendLaunchSecret = crypto.randomBytes(32).toString('hex')
    backendInstanceId = crypto.randomBytes(18).toString('hex')
    backendDesktopPickerSecret = crypto.randomBytes(32).toString('hex')

    backend = spawn(
      executable,
      [],
      {
        stdio: 'ignore',
        detached: false,
        windowsHide: process.platform === 'win32',
        env: {
          ...process.env,
          ULTRON_PORT: String(backendPort),
          ULTRON_LAUNCH_SECRET: backendLaunchSecret,
          ULTRON_LAUNCH_INSTANCE_ID: backendInstanceId,
          ULTRON_DESKTOP_PICKER_SECRET: backendDesktopPickerSecret,
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
  backendDesktopPickerSecret = null
  backendSessionToken = null
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

function isTrustedRendererEvent(event) {
  const frameUrl = event?.senderFrame?.url || event?.sender?.getURL?.() || ''
  return Boolean(
    window &&
    event?.sender === window.webContents &&
    isRendererUrl(frameUrl)
  )
}

function normalizeDesktopSessionToken(value) {
  const token = typeof value === 'string' ? value.trim() : ''
  // Auth sessions are URL-safe random tokens. Limit the value before it can
  // become an HTTP header and reject whitespace/control-character injection.
  return /^[A-Za-z0-9_-]{32,512}$/.test(token) ? token : ''
}

function requireTrustedRendererEvent(event) {
  if (!isTrustedRendererEvent(event)) {
    throw new Error('The ULTRON desktop request was not verified.')
  }
}

function desktopFilePickerOptions() {
  return {
    title: 'Select a local 3D or fabrication file',
    buttonLabel: 'Use this file',
    properties: ['openFile'],
    // Keep this broad. The Core stores safe metadata for a regular local file
    // and renders only the formats it explicitly understands.
    filters: [
      {
        name: 'Fabrication and 3D files',
        extensions: [
          'stl', 'obj', '3mf', 'amf', 'ply', 'gcode', 'gco', 'gc', 'g',
          'nc', 'tap', 'bgcode', 'step', 'stp', 'iges', 'igs', 'x3d',
          'wrl', 'dae', 'glb', 'gltf', 'fbx', 'svg', 'dxf', 'scad',
          'f3d', 'fcstd', 'skp', 'sldprt', 'dwg', 'x3g', 'phz', 'bambu',
          'project', 'sl1', 'ctb', 'photon', 'pwmo', 'pws', 'zip',
        ],
      },
      { name: 'All files', extensions: ['*'] },
    ],
  }
}

function desktopApplicationPickerOptions() {
  if (process.platform === 'win32') {
    return {
      title: 'Select a local application to link',
      buttonLabel: 'Link application',
      properties: ['openFile'],
      filters: [{ name: 'Windows applications', extensions: ['exe'] }],
    }
  }

  if (process.platform === 'darwin') {
    return {
      title: 'Select a local application to link',
      buttonLabel: 'Link application',
      properties: ['openFile'],
      filters: [{ name: 'macOS applications', extensions: ['app'] }],
    }
  }

  return {
    title: 'Select a local application to link',
    buttonLabel: 'Link application',
    properties: ['openFile'],
    filters: [{ name: 'Applications', extensions: ['desktop', 'appimage', 'sh'] }],
  }
}

function registerDesktopPickers() {
  ipcMain.handle('ultron:sync-session-token', (event, token) => {
    requireTrustedRendererEvent(event)
    const normalized = normalizeDesktopSessionToken(token)
    if (!normalized) {
      backendSessionToken = null
      return { ok: false }
    }
    backendSessionToken = normalized
    return { ok: true }
  })

  ipcMain.handle('ultron:clear-session-token', event => {
    requireTrustedRendererEvent(event)
    backendSessionToken = null
    return { ok: true }
  })

  ipcMain.handle('ultron:select-model', async event => {
    requireTrustedRendererEvent(event)
    const result = await dialog.showOpenDialog(
      window,
      desktopFilePickerOptions()
    )
    if (result.canceled || !result.filePaths[0]) {
      return { cancelled: true }
    }

    return callDesktopBackend(
      '/api/models/register',
      { path: result.filePaths[0] }
    )
  })

  ipcMain.handle('ultron:select-external-app', async (event, label) => {
    requireTrustedRendererEvent(event)
    const result = await dialog.showOpenDialog(
      window,
      desktopApplicationPickerOptions()
    )
    if (result.canceled || !result.filePaths[0]) {
      return { cancelled: true }
    }

    return callDesktopBackend(
      '/api/models/apps/register',
      {
        path: result.filePaths[0],
        label: typeof label === 'string'
          ? label.slice(0, 80)
          : '',
      }
    )
  })

  ipcMain.handle('ultron:select-skill-app', async event => {
    requireTrustedRendererEvent(event)
    const result = await dialog.showOpenDialog(
      window,
      desktopApplicationPickerOptions()
    )
    return {
      cancelled: result.canceled || !result.filePaths[0],
      path: result.filePaths[0] || '',
    }
  })
}

function forceNormalWindow() {
  if (!window || process.platform !== 'darwin') {
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

      title: 'Ultron AI',
      backgroundColor: '#030303',
      icon: APP_ICON,

      fullscreen: false,
      fullscreenable: process.platform !== 'darwin',

      resizable: true,
      maximizable: process.platform !== 'darwin',
      minimizable: true,

      show: false,

      // Vera finestra macOS.
      titleBarStyle: 'default',

      webPreferences: {
        preload: PRELOAD_PATH,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        devTools: !app.isPackaged,
      },
    })

  if (process.platform === 'darwin') {
    window.setFullScreen(false)

    if (
      typeof window.setSimpleFullScreen ===
      'function'
    ) {
      window.setSimpleFullScreen(false)
    }
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
      backendSessionToken = null
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
    session.defaultSession.setPermissionCheckHandler(
      (webContents, permission, requestingOrigin, details) => {
        return isLocalMicrophonePermission(
          webContents,
          permission,
          details?.securityOrigin || requestingOrigin,
          details?.mediaType
        )
      }
    )

    session.defaultSession.setPermissionRequestHandler(
      (webContents, permission, callback, details) => {
        callback(
          isLocalMicrophonePermission(
            webContents,
            permission,
            details?.securityOrigin,
            details?.mediaTypes
          )
        )
      }
    )

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

    registerDesktopPickers()
    registerRendererProtocol()

    const ready = await startBackend()

    if (!ready) {
      console.error(
        'ULTRON backend did not start.'
      )
      await dialog.showMessageBox({
        type: 'error',
        title: 'Ultron AI could not start',
        message: 'The local Ultron AI Core did not start.',
        detail: 'Restart Ultron AI. If this continues, reinstall the application from a complete package.',
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
