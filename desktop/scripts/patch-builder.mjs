/**
 * Patches electron-builder so extraResources may bundle node_modules
 * (electron-builder#867: createFilter() hard-rejects any root-level
 * "node_modules" directory of an extraResources copy). PopcornTime's renderer
 * is SELF-CONTAINED and REQUIRES its node_modules at runtime, so the rejection
 * is dropped for our copy.
 *
 * Idempotent: safe to run on every build. Run before electron-builder.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DESKTOP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TARGET = path.join(DESKTOP_ROOT, 'node_modules', 'app-builder-lib', 'out', 'util', 'filter.js')

const ORIGINAL = `        if (relative === "node_modules") {
            return false;
        }
        else if (relative.endsWith("/node_modules")) {`
const PATCHED = `        // popcorntime patch: root node_modules rejection removed — the app bundles a self-contained renderer (with node_modules) via extraResources
        if (relative.endsWith("/node_modules")) {`

let src
try {
  src = fs.readFileSync(TARGET, 'utf8')
} catch {
  console.log('[patch-builder] electron-builder not installed — nothing to patch')
  process.exit(0)
}

if (src.includes(PATCHED)) {
  console.log('[patch-builder] util/filter.js already patched — skipping')
} else if (src.includes(ORIGINAL)) {
  fs.writeFileSync(TARGET, src.replace(ORIGINAL, PATCHED), 'utf8')
  console.log('[patch-builder] patched util/filter.js — extraResources may now bundle node_modules')
} else {
  console.error('[patch-builder] ERROR: expected code not found — electron-builder version changed?')
  process.exit(1)
}
