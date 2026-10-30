// Thin adb driver for the Pixel_9 emulator. Dev tooling (node, not part of the shipped kit).
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import { center, chromeAtLeast, findById, findByText, parseUiAutomator, parseVersionName } from './parse.mjs'

const execFileP = promisify(execFile)
export const ADB = `${homedir()}/Library/Android/sdk/platform-tools/adb`
let serial = 'emulator-5554'

export const sleep = ms => new Promise(r => setTimeout(r, ms))
export function setSerial(s) {
  serial = s
}
export function adbArgs(args) {
  return ['-s', serial, ...args]
}

/** Run `adb -s <serial> <args>`; resolves with trimmed stdout. */
export async function adb(args, { timeout = 60000, maxBuffer = 64 * 1024 * 1024 } = {}) {
  const { stdout } = await execFileP(ADB, adbArgs(args), { timeout, maxBuffer })
  return stdout.replace(/\r/g, '').trimEnd()
}
export const shell = (cmd, opts) => adb(['shell', cmd], opts)

/** The `EMU start` poll: wait for the device, then for sys.boot_completed. */
export async function waitBoot({ timeoutMs = 300000 } = {}) {
  await adb(['wait-for-device'], { timeout: timeoutMs })
  const t0 = Date.now()
  while ((await shell('getprop sys.boot_completed')) !== '1') {
    if (Date.now() - t0 > timeoutMs) throw new Error('emulator did not finish booting')
    await sleep(2000)
  }
}

export const reverse = port => adb(['reverse', `tcp:${port}`, `tcp:${port}`])
export const logcat = (extra = []) => adb(['logcat', '-d', ...extra], { timeout: 30000 })
export const clearLogcat = () => adb(['logcat', '-c'])

export async function chromeVersion() {
  return parseVersionName(await shell('dumpsys package com.android.chrome'))
}
export async function chromeIsAtLeast(major) {
  const v = await chromeVersion()
  return v ? chromeAtLeast(v, major) : false
}

/** Dump the current UI hierarchy and parse it. */
export async function dumpUi() {
  const xml = await adb(['exec-out', 'uiautomator', 'dump', '/dev/stdout'], { timeout: 30000 })
  return parseUiAutomator(xml.slice(xml.indexOf('<?xml')))
}

export async function tapXY({ x, y }) {
  await shell(`input tap ${x} ${y}`)
}

/** Poll the UI until `finder(nodes)` returns a node; resolves with it or throws on timeout. */
export async function waitForNode(finder, { timeoutMs = 15000, pollMs = 700, what = 'node' } = {}) {
  const t0 = Date.now()
  for (;;) {
    let nodes = []
    try {
      nodes = await dumpUi()
    } catch {
      // uiautomator can fail while the screen is transitioning: retry
    }
    const n = finder(nodes)
    if (n) return n
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await sleep(pollMs)
  }
}

/** Tap by `resource-id`, `content-desc` or text (the stable ids are bridge-approve, bridge-deny, bridge-connect-origin). */
export async function tapId(id, opts = {}) {
  const n = await waitForNode(nodes => findById(nodes, id) || findByText(nodes, id), { what: `ui id ${id}`, ...opts })
  await tapXY(center(n))
  return n
}
export async function tapText(text, opts = {}) {
  const n = await waitForNode(nodes => findByText(nodes, text), { what: `text "${text}"`, ...opts })
  await tapXY(center(n))
  return n
}
export async function isVisible(textOrId) {
  const nodes = await dumpUi()
  return Boolean(findByText(nodes, textOrId) || findById(nodes, textOrId))
}

export const screenshot = async file => {
  const { execFile: ex } = await import('node:child_process')
  await new Promise((resolve, reject) => {
    const p = ex(
      ADB,
      adbArgs(['exec-out', 'screencap', '-p']),
      { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
      (e, out) => {
        if (e) return reject(e)
        import('node:fs').then(fs => fs.writeFileSync(file, out)).then(resolve, reject)
      }
    )
    void p
  })
}
