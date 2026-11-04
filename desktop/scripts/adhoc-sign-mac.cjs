/**
 * electron-builder afterPack hook — ad-hoc code signing for macOS builds.
 *
 * WHY: OTAMA ships unsigned (no Apple Developer certificate). electron-builder
 * with identity:null skips signing entirely, which leaves the renamed Electron
 * bundle with a broken seal. When users download the DMG, macOS adds the
 * com.apple.quarantine attribute and Gatekeeper refuses to launch the
 * unverified bundle with the notoriously misleading:
 *
 *   "OTAMA" is damaged and can't be opened. You should move it to the Bin.
 *
 * Ad-hoc signing (codesign -s -) restores a valid local signature so:
 *   1. Gatekeeper shows the friendlier "cannot verify the developer" dialog
 *      instead of "damaged" — bypassable via right-click → Open, or
 *      System Settings → Privacy & Security → Open Anyway.
 *   2. If a user still hits "damaged" (older macOS quirk), removing quarantine
 *      fixes it:  xattr -cr /Applications/OTAMA.app
 *
 * Runs for every platform but no-ops unless we are packaging the darwin app
 * ON a macOS machine (codesign is a macOS tool).
 */
const path = require('node:path')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')

const pexec = promisify(execFile)

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  if (process.platform !== 'darwin') {
    console.log('[adhoc-sign] not running on macOS — skipping ad-hoc codesign')
    return
  }

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  )

  console.log(`[adhoc-sign] ad-hoc signing ${appPath}`)
  // --force  replace any existing (broken) signature
  // --deep   sign nested frameworks / helpers too
  // -        ad-hoc identity (no certificate required)
  await pexec('codesign', ['--force', '--deep', '--sign', '-', appPath], {
    maxBuffer: 1 << 26,
  })

  const { stdout } = await pexec('codesign', ['--verify', '--deep', appPath], {
    maxBuffer: 1 << 26,
  }).catch(err => {
    throw new Error(`[adhoc-sign] codesign verification FAILED: ${err.message}`)
  })
  console.log('[adhoc-sign] codesign verify OK', stdout || '')
}
