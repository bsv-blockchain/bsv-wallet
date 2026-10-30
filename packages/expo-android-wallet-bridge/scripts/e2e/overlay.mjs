// Helpers for the overlay-mode cases (plan M2 Task 13). Dev tooling (node), not part of the shipped kit. They read the
// platform's own state (`dumpsys`) and the uiautomator tree; with `FLAG_SECURE` on the sheet, pixels are black, so every
// check reads ids and bounds, never screenshots.
import { adb, dumpUi, shell, sleep } from './adb.mjs'
import { findById, parseResumedActivities } from './parse.mjs'

export const APP = 'org.bsvblockchain.wallet'
export const SHEET_CLASS = 'org.bsv.walletbridge.BridgeSheetActivity'

const activitiesDump = () => shell('dumpsys activity activities', { timeout: 30000 })

/** Component names of every resumed activity, top first. */
export const resumedActivities = async () => parseResumedActivities(await activitiesDump())
export const sheetResumed = async () => (await resumedActivities()).some(c => c.includes('BridgeSheetActivity'))
export const mainResumed = async () => (await resumedActivities()).some(c => c.includes('.MainActivity'))

/** `package/class` of the top resumed activity (the focused one), or undefined. */
export async function topResumed() {
  const m = /topResumedActivity=ActivityRecord\{[^ ]+ u\d+ ([\w.$]+\/[\w.$]+)/.exec(await activitiesDump())
  return m ? m[1] : undefined
}
export const topIsSheet = async () => /BridgeSheetActivity$/.test((await topResumed()) ?? '')

/** The state word (`RESUMED`, `PAUSED`, `STOPPED`, ...) of the first activity record matching `re`, or undefined. */
export async function activityState(re) {
  const lines = (await activitiesDump()).split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (!/ActivityRecord\{/.test(lines[i]) || !re.test(lines[i])) continue
    for (let j = i; j < Math.min(i + 60, lines.length); j++) {
      const m = /\bstate=([A-Z_]+)/.exec(lines[j])
      if (m) return m[1]
    }
  }
  return undefined
}
/** Is a `BridgeSheetActivity` record listed at all (resumed, paused or stopped)? Counts only the task/activity rows. */
export async function sheetListed() {
  const t = await activitiesDump()
  return t
    .split('\n')
    .some(
      l =>
        /^\s*\*\s*ActivityRecord\{.*BridgeSheetActivity/.test(l) ||
        /Hist\s+#\d+: ActivityRecord\{.*BridgeSheetActivity/.test(l)
    )
}

export async function screenSize() {
  const m = /Physical size: (\d+)x(\d+)/.exec(await shell('wm size'))
  return m ? { w: +m[1], h: +m[2] } : { w: 1080, h: 2424 }
}

/** Bounds of a test id in the current window dump, or undefined. */
export async function boundsOf(testId) {
  let nodes = []
  for (let i = 0; i < 3 && !nodes.length; i++) nodes = await dumpUi().catch(() => [])
  return findById(nodes, testId)?.bounds
}
/**
 * "Sheet shown": the Approve button exists and lies inside the screen rectangle and in the lower part the sheet occupies
 * (a view translated off screen still appears in the dump, so presence alone proves nothing).
 */
export async function approveInSheetRegion() {
  const [b, { w, h }] = await Promise.all([boundsOf('bridge-approve'), screenSize()])
  if (!b) return { ok: false, why: 'no bridge-approve node', b }
  const inside = b.x1 >= 0 && b.y1 >= 0 && b.x2 <= w && b.y2 <= h && b.x2 > b.x1 && b.y2 > b.y1
  const lower = b.y1 >= h * 0.3
  return {
    ok: inside && lower,
    why: inside
      ? lower
        ? 'ok'
        : `above the lower region (y1 ${b.y1} < ${Math.round(h * 0.3)})`
      : 'outside the screen',
    b,
    w,
    h
  }
}

export async function waitFor(cond, { timeoutMs = 15000, pollMs = 400, what = 'condition' } = {}) {
  const t0 = Date.now()
  for (;;) {
    const v = await cond()
    if (v) return v
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await sleep(pollMs)
  }
}

/** The per-app language: the toolbox reads the device locale once at module load, so the app restarts after this. */
export async function setLanguage(code) {
  await shell(`cmd locale set-app-locales ${APP} --locales ${code}`)
}
export async function clearLanguage() {
  await shell(`cmd locale set-app-locales ${APP} --locales ""`).catch(() => {})
}

/** `logcat -d` lines matching `re` (the whole buffer; `clearLogcat` before a run that needs a window). */
export async function logLines(re) {
  const t = await adb(['logcat', '-d'], { timeout: 30000 })
  return t.split('\n').filter(l => re.test(l))
}
/** The last `n=<count>` of a log marker, or 0. */
export async function lastCount(marker) {
  const ls = await logLines(new RegExp(marker))
  const m = ls.length ? /n=(\d+)/.exec(ls[ls.length - 1]) : null
  return m ? Number(m[1]) : 0
}
/** Window flags of the sheet's window from `dumpsys window windows`, e.g. `NOT_FOCUSABLE NOT_TOUCHABLE ... SECURE`. */
export async function sheetWindowFlags() {
  const t = await shell('dumpsys window windows', { timeout: 30000 })
  const blocks = t.split(/(?=^\s*Window #\d+ )/m)
  const b = blocks.find(x => /^\s*Window #\d+ .*BridgeSheetActivity/.test(x))
  if (!b) return undefined
  const m = /\bfl=([^\n]*?)(?:\s+pfl=|\s*\n)/.exec(b)
  return m ? m[1].trim() : ''
}

/** Raw uiautomator XML (evidence: with FLAG_SECURE the pixels are black, the tree is the record). */
export async function dumpXml() {
  for (let i = 0; i < 3; i++) {
    try {
      const xml = await adb(['exec-out', 'uiautomator', 'dump', '/dev/stdout'], { timeout: 30000 })
      return xml.slice(xml.indexOf('<?xml')).replace(/\n?UI hierchary dumped to: .*$/s, '')
    } catch {
      await sleep(500)
    }
  }
  return ''
}
/** Write `<name>-ui.xml` and `<name>-state.txt` (resumed activities, top, flags) into `dir`. */
export async function saveEvidence(fs, path, dir, name, extra = '') {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${name}-ui.xml`), await dumpXml())
  const state = [
    `resumed: ${(await resumedActivities()).join(', ') || '(none)'}`,
    `top: ${(await topResumed()) ?? '(none)'}`,
    `sheet window flags: ${(await sheetWindowFlags()) ?? '(no sheet window)'}`,
    extra
  ]
  fs.writeFileSync(path.join(dir, `${name}-state.txt`), state.filter(Boolean).join('\n') + '\n')
}
