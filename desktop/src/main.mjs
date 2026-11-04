/**
 * PopcornTime — Electron main process (macOS desktop shell).
 *
 * Architecture (mirrors the OTAMA desktop lineage, simplified — the torrent
 * engine runs IN-PROCESS inside the Next.js server, no separate engine child):
 *
 *   ┌──────────────────────────── Electron ────────────────────────────┐
 *   │  BrowserWindow ── loads ──► Next.js standalone server (child)    │
 *   │        │                         127.0.0.1:<free port>           │
 *   │        │ webtorrent + Prisma live inside that server            │
 *   └──────────────────────────────────────────────────────────────────┘
 *
 * The renderer bundle is the exact same Next.js app used on the web, served
 * locally so the app is fully self-contained. Users do NOT need Node.js:
 * the child runs through Electron's own binary (ELECTRON_RUN_AS_NODE=1).
 */
import { app, BrowserWindow, Menu, dialog, shell } from 'electron'
import { spawn } from 'node:child_process'
import { createServer, get } from 'node:http'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DESKTOP_ROOT = path.resolve(__dirname, '..') // .../desktop

const DEV_URL = process.env.POPCORN_DEV_URL || '' // e.g. http://localhost:3000 while developing the web UI
const APP_VERSION = readOwnVersion()

let mainWindow = null
let rendererChild = null
let quitting = false
let rendererUrl = ''
let rendererPort = 0

/* ------------------------------ small utils ------------------------------ */

function readOwnVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(DESKTOP_ROOT, 'package.json'), 'utf8'))
    return pkg.version || '1.0.0'
  } catch {
    return '1.0.0'
  }
}

function log(...args) {
  console.log(`[popcorntime] ${new Date().toISOString()}`, ...args)
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/** GET a URL and resolve with { ok, status, body }. */
function httpGet(url, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let settled = false
    const done = (result) => {
      if (!settled) {
        settled = true
        resolve(result)
      }
    }
    try {
      const req = get(url, { timeout: timeoutMs }, (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => done({ ok: res.statusCode >= 200 && res.statusCode < 400, status: res.statusCode, body }))
      })
      req.on('error', () => done({ ok: false, status: 0, body: '' }))
      req.on('timeout', () => {
        req.destroy()
        done({ ok: false, status: 0, body: '' })
      })
    } catch {
      done({ ok: false, status: 0, body: '' })
    }
  })
}

/** Poll a URL until it answers ok, or timeout. */
async function waitUntilReady(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const res = await httpGet(url, 2500)
    if (res.ok) return true
    await sleep(500)
  }
  return false
}

/** Ask the OS for a free TCP port, preferring the well-known one. */
async function findFreePort(preferred) {
  const portAvailable = (port, host = '127.0.0.1') =>
    new Promise((resolve) => {
      const srv = createServer()
      srv.unref()
      srv.once('error', () => resolve(false))
      srv.listen({ port, host }, () => srv.close(() => resolve(true)))
    })
  if (preferred && (await portAvailable(preferred))) return preferred
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen({ port: 0, host: '127.0.0.1' }, () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

/** Run a plain-node script through Electron's bundled Node runtime. */
function spawnAsNode(scriptPath, opts = {}) {
  return spawn(process.execPath, [scriptPath], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NODE_ENV: 'production',
      ...(opts.env || {}),
    },
    cwd: opts.cwd || path.dirname(scriptPath),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
}

function pipeChildLogs(child, tag) {
  child.stdout.on('data', (d) => process.stdout.write(`[${tag}] ${d}`))
  child.stderr.on('data', (d) => process.stderr.write(`[${tag}] ${d}`))
}

/* ------------------------- renderer (Next.js standalone) ------------------------- */

function rendererDir() {
  return app.isPackaged ? path.join(process.resourcesPath, 'renderer') : path.join(DESKTOP_ROOT, 'resources', 'renderer')
}

/**
 * First-run database bootstrap.
 *
 * Prisma does NOT create tables in an empty SQLite file, so packaging ships a
 * schema-initialized template (prepare-renderer.mjs runs `prisma db push`)
 * and we copy it into the user profile on first launch. Preserves a user's
 * favorites/history across upgrades — only copied when the file is absent.
 */
function ensureDatabaseFile(dbPath) {
  if (fs.existsSync(dbPath)) return
  const template = app.isPackaged
    ? path.join(process.resourcesPath, 'popcorntime-template.db')
    : path.join(DESKTOP_ROOT, 'resources', 'popcorntime-template.db')
  try {
    if (fs.existsSync(template)) {
      fs.copyFileSync(template, dbPath)
      log(`database initialized from template → ${dbPath}`)
      return
    }
  } catch (err) {
    log('template database copy failed:', err)
  }
  log(`no template database — Prisma will create an empty file at ${dbPath}`)
}

async function startRendererServer() {
  const dir = rendererDir()
  const serverJs = path.join(dir, 'server.js')
  if (!fs.existsSync(serverJs)) {
    throw new Error(`Renderer server missing: ${serverJs} (run "npm run prepare:renderer" first)`)
  }

  // Loopback only — the window is the only client.
  const port = await findFreePort(3001)
  rendererPort = port
  // Writable SQLite database inside the user profile (Prisma DATABASE_URL).
  // Prisma `file:` URLs MUST be percent-encoded: on macOS the userData dir is
  // "~/Library/Application Support/PopcornTime" and the SPACE in "Application
  // Support" silently broke every Prisma query (all /api/* → 500).
  const dbPath = path.join(app.getPath('userData'), 'popcorntime.db').replace(/\\/g, '/')
  const dbUrl = `file:${encodeURI(dbPath)}`
  ensureDatabaseFile(dbPath)
  log(`renderer database: ${dbUrl}`)

  rendererChild = spawnAsNode(serverJs, {
    cwd: dir,
    env: {
      PORT: String(port),
      HOSTNAME: '127.0.0.1',
      DATABASE_URL: dbUrl,
      NODE_ENV: 'production',
    },
  })
  pipeChildLogs(rendererChild, 'popcorn-web')

  rendererChild.on('exit', (code) => {
    rendererChild = null
    if (!quitting && mainWindow) {
      dialog.showErrorBox(
        'PopcornTime — server stopped',
        `The embedded web server exited unexpectedly (code ${code}).\nPlease restart the app.`,
      )
      app.quit()
    }
  })

  const url = `http://127.0.0.1:${port}`
  const ready = await waitUntilReady(url, 60_000)
  if (!ready) throw new Error('Embedded web server did not become ready in time')
  log(`renderer ready at ${url}`)
  return url
}

/* ------------------------------ window ------------------------------ */

/**
 * Boot splash (data URL) shown while the Next.js server starts.
 */
const SPLASH_HTML = `<!doctype html><html><head><meta charset="utf-8">
<style>
  html,body{height:100%;margin:0;background:#0b0b10;color:#fafafa;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;
    display:flex;align-items:center;justify-content:center;flex-direction:column;gap:18px;user-select:none}
  h1{font-size:30px;margin:0;font-weight:800;letter-spacing:-.02em;color:#f5c518;
    text-shadow:0 0 26px rgba(245,197,24,.45);animation:pulse 1.6s ease-in-out infinite}
  p{color:#a1a1aa;font-size:13px;margin:0}
  .spin{width:18px;height:18px;border:2px solid #26262e;border-top-color:#f5c518;border-radius:50%;animation:s .8s linear infinite}
  @keyframes s{to{transform:rotate(360deg)}}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.55}}
</style></head><body>
  <h1>POPCORNTIME</h1><p>starting local server…</p><div class="spin"></div>
</body></html>`

function buildMenu() {
  const template = [
    {
      label: 'PopcornTime',
      submenu: [
        { label: `PopcornTime v${APP_VERSION}`, enabled: false },
        { type: 'separator' },
        { role: 'minimize' },
        { role: 'quit', label: 'Quit PopcornTime' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#0b0b10',
    title: 'PopcornTime',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  })

  // Splash while the local server boots.
  mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(SPLASH_HTML)}`)

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  // Any navigation outside our own origin (posters are <img>, links are external) → system browser.
  const allowed = (url) => url.startsWith(rendererUrl) || url.startsWith('devtools://') || url.startsWith('data:')
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!allowed(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!allowed(url)) {
      event.preventDefault()
      void shell.openExternal(url)
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

/* ------------------------------ lifecycle ------------------------------ */

/**
 * Post-start API self-check. If the API layer is broken (e.g. a packaging
 * problem on this machine), the window still opens but every catalog call
 * fails with cryptic client errors. Surface it HERE, in plain words.
 * Provider outages do NOT trigger this — those stay JSON (502).
 */
async function apiSmokeCheck(base) {
  const smoke = await httpGet(`${base}/api/catalog?type=movie&skip=0`, 25_000)
  const looksJson = (smoke.body || '').trimStart().startsWith('{')
  if (smoke.ok && looksJson) {
    log('API self-check ok (JSON)')
    return
  }
  const bodyStart = (smoke.body || '').slice(0, 100).replace(/\s+/g, ' ')
  log(`API self-check FAILED — status=${smoke.status} body="${bodyStart}"`)
  dialog.showMessageBox({
    type: 'warning',
    title: 'PopcornTime — self-check',
    message: 'PopcornTime started, but its local API answered unexpectedly.',
    detail:
      `HTTP ${smoke.status} (expected JSON)${bodyStart ? ` — got: ${bodyStart}` : ''}\n\n` +
      'Try restarting PopcornTime once; if it keeps happening, reinstall the app.',
    buttons: ['OK'],
  })
}

function killChildren() {
  if (rendererChild && !rendererChild.killed) {
    try {
      rendererChild.kill()
    } catch {
      /* noop */
    }
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    log(`PopcornTime desktop v${APP_VERSION} — platform=${process.platform} packaged=${app.isPackaged} dev=${!!DEV_URL}`)
    buildMenu()

    try {
      if (DEV_URL) {
        rendererUrl = DEV_URL.replace(/\/$/, '')
        log(`dev mode — loading ${rendererUrl}`)
        createWindow()
        await mainWindow.loadURL(rendererUrl)
      } else {
        await startRendererServer()
        rendererUrl = `http://127.0.0.1:${rendererPort}`
        createWindow()
        await mainWindow.loadURL(rendererUrl)
        log('window loaded — PopcornTime is ready')
        void apiSmokeCheck(rendererUrl)
      }
    } catch (err) {
      log('startup failed:', err)
      dialog.showErrorBox('PopcornTime failed to start', String(err?.message || err))
      app.quit()
    }
  })

  app.on('before-quit', () => {
    quitting = true
    killChildren()
  })

  app.on('window-all-closed', () => {
    app.quit()
  })

  app.on('quit', () => {
    quitting = true
    killChildren()
  })

  process.on('exit', killChildren)
}
