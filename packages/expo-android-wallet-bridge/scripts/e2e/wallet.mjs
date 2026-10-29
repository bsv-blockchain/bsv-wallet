// Create a throwaway test wallet in the dev-client build on the emulator, and unlock it on later launches.
// maestro is not installed here (brew install maestro needs owner approval: a device gate, not a blocker), so the
// default is the uiautomator sequence equal to HW/e2e/_launch-android.yaml + onboarding.yaml. When maestro exists
// `createTestWalletMaestro(hwDir)` runs the host flows from a scratch copy that points at Metro on 8082.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { adb, dumpUi, isVisible, screenshot, shell, sleep, tapText, waitForNode } from './adb.mjs'
import { findByText } from './parse.mjs'

const APP = 'org.bsvblockchain.wallet'
const has = (nodes, re) => nodes.find(n => re.test(n.text) || re.test(n.desc))

export async function launchApp({ metroPort = 8082 } = {}) {
  await shell(`am force-stop ${APP}`)
  // dev-client deep link straight at Metro (adb reverse tcp:<metroPort> must be in place)
  const link = `exp+bsv-wallet://expo-development-client/?url=${encodeURIComponent(`http://localhost:${metroPort}`)}`
  await shell(`am start -a android.intent.action.VIEW -d '${link}' ${APP}`)
}

/** Dismiss the dev-client developer-menu intro (Continue) and any open menu (Close), when shown. */
export async function dismissDevMenu({ timeoutMs = 8000 } = {}) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const nodes = await dumpUi().catch(() => [])
    if (has(nodes, /^This is the developer menu/)) {
      await tapText('Continue')
      await sleep(500)
      continue
    }
    if (has(nodes, /^Toggle performance monitor$/)) {
      const close = findByText(nodes, 'Close')
      if (close) await tapText('Close')
      else await shell('input keyevent KEYCODE_BACK')
      await sleep(500)
      continue
    }
    await sleep(600)
  }
}

export async function createTestWallet({ metroPort = 8082, shots } = {}) {
  await launchApp({ metroPort })
  await waitForNode(nodes => has(nodes, /^(Continue|Get set up|Total balance.*|No crypto skills needed)$/), {
    timeoutMs: 120000,
    what: 'app after bundle load'
  })
  await dismissDevMenu()
  await waitForNode(nodes => findByText(nodes, 'No crypto skills needed'), { timeoutMs: 60000, what: 'welcome' })
  await tapText('Continue')
  await tapText('Continue')
  await tapText('Got it')
  await tapText('Create wallet', { timeoutMs: 15000 })
  await waitForNode(nodes => has(nodes, /^Get set up$/), {
    timeoutMs: 180000,
    pollMs: 2000,
    what: 'Home after wallet creation'
  })
  if (shots) await screenshot(path.join(shots, 'wallet-home.png'))
}

/** Later launches: if the wallet shows an unlock screen, unlock it (biometric-less test wallet: tap the unlock control). */
export async function unlockIfNeeded() {
  const nodes = await dumpUi().catch(() => [])
  const unlock = has(nodes, /^(Unlock|Unlock wallet|Use passcode)$/)
  if (!unlock) return false
  await tapText(unlock.text || unlock.desc)
  await waitForNode(n => has(n, /^(Get set up|Total balance.*)$/), { timeoutMs: 30000, what: 'Home after unlock' })
  return true
}

/** Preferred path when maestro is installed. */
export async function createTestWalletMaestro(hwDir, metroPort = 8082) {
  const execP = promisify(execFile)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-maestro-'))
  const launch = fs
    .readFileSync(path.join(hwDir, 'e2e/_launch-android.yaml'), 'utf8')
    .replace(/10\.0\.2\.2%3A8081/g, `localhost%3A${metroPort}`)
  fs.writeFileSync(path.join(tmp, '_launch-android.yaml'), launch)
  fs.copyFileSync(path.join(hwDir, 'e2e/onboarding.yaml'), path.join(tmp, 'onboarding.yaml'))
  await execP('maestro', ['test', path.join(tmp, '_launch-android.yaml')])
  await execP('maestro', ['test', path.join(tmp, 'onboarding.yaml')])
}

export { adb, isVisible }
