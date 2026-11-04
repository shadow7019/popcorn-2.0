/**
 * Builds the PopcornTime web UI (Next.js, standalone output) and copies it
 * into desktop/resources/renderer so electron-builder can embed it.
 *
 * Cross-platform (works on macOS CI and local builds alike).
 *
 * Steps:
 *   1. apply the native-webrtc node_modules patch (root package postinstall
 *      already does it; repeated here so a fresh CI checkout can't skip it)
 *   2. `npx next build` in the project root with POPCORN_PACK_BUILD=1
 *      → builds into .next-pack (never touches the live dev server's .next)
 *   3. copy .next-pack/standalone         → desktop/resources/renderer
 *   4. copy .next-pack/static             → desktop/resources/renderer/.next-pack/static
 *   5. copy public/                       → desktop/resources/renderer/public
 *   6. create a schema-initialized template SQLite database
 *      (desktop/resources/popcorntime-template.db) that the Electron main
 *      process copies into the user profile on first launch
 *
 * TMDB credentials are baked into the site source (src/lib/tmdb-server.ts),
 * so no env file is needed inside the packaged app.
 */
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DESKTOP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PROJECT_ROOT = path.resolve(DESKTOP_ROOT, '..')
const DEST = path.join(DESKTOP_ROOT, 'resources', 'renderer')
const PACK_DIST = path.join(PROJECT_ROOT, '.next-pack')

function cp(src, dest) {
  if (!fs.existsSync(src)) throw new Error(`Missing build artifact: ${src}`)
  fs.cpSync(src, dest, { recursive: true })
  console.log(`[prepare-renderer] copied ${path.relative(PROJECT_ROOT, src)} → ${path.relative(DESKTOP_ROOT, dest)}`)
}

function rm(dir) {
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log('[prepare-renderer] applying native-webrtc node_modules patch…')
execSync('node scripts/patch-native-webrtc.mjs', {
  cwd: PROJECT_ROOT,
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: 'production' },
})

console.log('[prepare-renderer] building web UI (npx next build, POPCORN_PACK_BUILD=1)…')
execSync('npx next build', {
  cwd: PROJECT_ROOT,
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_ENV: 'production',
    NEXT_TELEMETRY_DISABLED: '1',
    POPCORN_PACK_BUILD: '1',
    // Build-time placeholder only; the desktop main process injects the real
    // per-user DB path (userData/popcorntime.db) at runtime.
    DATABASE_URL: process.env.DATABASE_URL || 'file:./db/build-placeholder.db',
  },
})

console.log('[prepare-renderer] assembling standalone renderer…')
rm(DEST)
fs.mkdirSync(DEST, { recursive: true })

cp(path.join(PACK_DIST, 'standalone'), DEST)
// distDir is ".next-pack" during packaging (POPCORN_PACK_BUILD=1) — static
// assets must live INSIDE the dist dir the standalone server actually reads.
cp(path.join(PACK_DIST, 'static'), path.join(DEST, '.next-pack', 'static'))
cp(path.join(PROJECT_ROOT, 'public'), path.join(DEST, 'public'))

// --- Symlink sanitation ------------------------------------------------------
// Next's output tracing can emit symlinks whose target is an ABSOLUTE path on
// the BUILD machine (seen on the macOS CI runner: .next-pack/node_modules/
// @prisma/client-<hash> → /Users/runner/work/…/.next-pack/standalone/
// node_modules/@prisma/client). Inside a packaged app that path does not exist,
// so the link dangles forever on every user machine. At THIS point the build
// machine still holds the referenced content, so replace every absolute (or
// otherwise escaping) symlink with a real copy of what it points to, and drop
// symlinks whose target is already gone. Healthy relative symlinks stay.
function sanitizeSymlinks(root) {
  let rewritten = 0
  let dropped = 0
  const queue = [root]
  while (queue.length) {
    const dir = queue.pop()
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        queue.push(full)
        continue
      }
      if (!entry.isSymbolicLink()) continue

      const rawTarget = fs.readlinkSync(full)
      let realTarget = null
      try {
        realTarget = fs.realpathSync(full) // throws when the link dangles
      } catch {
        realTarget = null
      }

      // Healthy link = resolvable AND stays inside the renderer folder.
      const relFromDest = path.relative(DEST, realTarget || DEST)
      const insideDest =
        relFromDest === '' ||
        (!relFromDest.startsWith('..') && !path.isAbsolute(relFromDest))
      if (insideDest && realTarget && !path.isAbsolute(rawTarget)) continue // healthy relative link — keep

      const rel = path.relative(DEST, full)
      fs.rmSync(full, { recursive: true, force: true })
      if (realTarget) {
        fs.cpSync(realTarget, full, { recursive: true, dereference: true })
        rewritten += 1
        console.log(`[prepare-renderer] symlink fixed: ${rel} (${rawTarget} → real copy)`)
      } else {
        dropped += 1
        console.warn(`[prepare-renderer] dangling symlink dropped: ${rel} (${rawTarget})`)
      }
    }
  }
  console.log(
    `[prepare-renderer] symlink scan done: ${rewritten} rewritten, ${dropped} dropped, rest healthy`
  )
}
sanitizeSymlinks(DEST)

if (!fs.existsSync(path.join(DEST, 'server.js'))) {
  throw new Error('Standalone server.js not found after copy — build output format changed?')
}

// --- Sanity: Prisma engines --------------------------------------------------
// The native engine AND the cross-target engines (both darwin DMGs are built
// from one runner; prisma generator carries binaryTargets darwin-arm64+x64)
// must be inside the standalone bundle.
const prismaDir = path.join(DEST, 'node_modules', '.prisma', 'client')
if (fs.existsSync(prismaDir)) {
  const engines = fs
    .readdirSync(prismaDir)
    .filter((f) => f.includes('engine') || f.endsWith('.dll.node') || f.endsWith('.so.node'))
  console.log(`[prepare-renderer] bundled Prisma engines: ${engines.join(', ') || 'NONE'}`)
  if (!engines.some((f) => f.includes('darwin'))) {
    console.warn('[prepare-renderer] WARNING: no darwin engine present — add binaryTargets to prisma/schema.prisma')
  }
} else {
  console.warn('[prepare-renderer] WARNING: no .prisma/client in standalone — check outputFileTracingIncludes')
}

// --- Template database -------------------------------------------------------
// The packaged app gets a fresh userData dir — an EMPTY SQLite file would make
// favorites/history 500 (P2021). Create a schema-initialized template at build
// time; the Electron main process copies it to userData/popcorntime.db on
// first run.
const TEMPLATE_DB = path.join(DESKTOP_ROOT, 'resources', 'popcorntime-template.db')
console.log('[prepare-renderer] creating template SQLite database…')
execSync('npx prisma db push --skip-generate', {
  cwd: PROJECT_ROOT,
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: `file:${TEMPLATE_DB}` },
})

fs.writeFileSync(
  path.join(DEST, 'popcorntime-build-info.json'),
  JSON.stringify({ builtAt: new Date().toISOString(), platform: process.platform }, null, 2),
)

console.log('[prepare-renderer] renderer ready at desktop/resources/renderer')
