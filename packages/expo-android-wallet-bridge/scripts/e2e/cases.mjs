// Emulator end-to-end cases (spec 10). Each case is `{ id, name, run(ctx) }`; `run` throws on failure and returns a
// short pass note. Dev tooling (node), not part of the shipped kit. The page origin is `http://localhost:3001` (the iOS
// demo owns 3000 and the ngrok tunnel); `ctx.origin` carries it.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { adb, dumpUi, screenshot, shell, sleep, tapXY, waitForNode } from './adb.mjs'
import { clickGesture, connect, firstPage, forwardDevtools, grantLoopback } from './chrome.mjs'
import { center, findById, findByText, parseNotification, parseTopResumed } from './parse.mjs'
import { dismissDevMenu, launchApp, setAnimationScale, unlockIfNeeded } from './wallet.mjs'
import { hold, release } from './sockets.mjs'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { ADB, adbArgs } from './adb.mjs'
import * as ov from './overlay.mjs'

export const APP = 'org.bsvblockchain.wallet'
export const CHROME = 'com.android.chrome'
export const CHROME_MAIN = `${CHROME}/com.google.android.apps.chrome.Main`
// Sheet buttons by coordinates (1080x2424): used when uiautomator cannot reach an idle state.
export const APPROVE_XY = { x: 789, y: 2248 }
export const DENY_XY = { x: 290, y: 2248 }

const shotName = (ctx, n) => path.join(ctx.shots, n.endsWith('.png') ? n : `${n}.png`)
export const shot = (ctx, n) => screenshot(shotName(ctx, n))

/** Run `fn` with animations off: uiautomator cannot reach an idle state while Home loops its tour art. */
let uiFast = false
export const setUiFast = async on => {
  uiFast = on
  await setAnimationScale(on ? 0 : 1)
}
export async function withUi(fn) {
  if (uiFast) return fn()
  await setAnimationScale(0)
  await sleep(700)
  try {
    return await fn()
  } finally {
    await setAnimationScale(1)
  }
}
const safeDump = async () => {
  for (let i = 0; i < 3; i++) {
    try {
      return await dumpUi()
    } catch {
      await sleep(500)
    }
  }
  return []
}
export const uiNodes = () => withUi(safeDump)
export const uiHas = async idOrText => {
  const nodes = await uiNodes()
  return Boolean(findById(nodes, idOrText) || findByText(nodes, idOrText))
}
/** Poll (each poll with animations off) until the node exists; resolves with it. */
export async function uiWait(idOrText, { timeoutMs = 20000, what } = {}) {
  const t0 = Date.now()
  for (;;) {
    const nodes = await uiNodes()
    const n = findById(nodes, idOrText) || findByText(nodes, idOrText)
    if (n) return n
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what ?? idOrText}`)
    await sleep(500)
  }
}
export async function uiTap(idOrText, opts) {
  const n = await uiWait(idOrText, opts)
  await tapXY(center(n))
  return n
}

export const front = async pkg => {
  await shell(`am start -n ${pkg === 'chrome' ? CHROME_MAIN : `${APP}/.MainActivity`}`)
  await sleep(1200)
}
export const topPackage = async () => parseTopResumed(await shell('dumpsys activity activities'))
export async function waitTop(pkg, timeoutMs = 15000) {
  const t0 = Date.now()
  for (;;) {
    const top = await topPackage()
    if (top === pkg) return top
    if (Date.now() - t0 > timeoutMs) throw new Error(`top activity is ${top}, expected ${pkg}`)
    await sleep(500)
  }
}
export const walletPid = () => shell(`pidof ${APP}`).catch(() => '')

// ---- page driving --------------------------------------------------------------------------------------------
export async function attach(ctx) {
  if (!(await shell(`pidof ${CHROME}`).catch(() => ''))) await front('chrome')
  await forwardDevtools()
  ctx.browser = await connect()
  await grantLoopback(ctx.browser, ctx.origin)
}
export const pageNow = async ctx => {
  ctx.page = await firstPage(ctx.browser)
  return ctx.page
}
export const logText = page => page.evaluate(() => document.getElementById('log')?.textContent ?? '').catch(() => '')
export const seenEpochs = new Set()
export async function waitLog(page, re, { timeoutMs = 40000, what } = {}) {
  const t0 = Date.now()
  for (;;) {
    const t = await logText(page)
    for (const e of t.matchAll(/"epoch":"([0-9a-f-]{36})"/g)) seenEpochs.add(e[1])
    const m = re.exec(t)
    if (m) return m[0]
    if (Date.now() - t0 > timeoutMs)
      throw new Error(`log never matched ${what ?? re}: ${t.split('\n').slice(0, 4).join(' | ')}`)
    await sleep(600)
  }
}
/** Chrome in front, the demo loaded fresh (token forgotten when `clearToken`), page selected. */
export async function freshPage(ctx, { clearToken = true, url = ctx.origin + '/' } = {}) {
  await front('chrome')
  const page = await pageNow(ctx)
  await page.goto(url, { waitUntil: 'load' })
  if (clearToken) {
    await page.evaluate(() => localStorage.clear())
    await page.goto(url, { waitUntil: 'load' })
  }
  await page.waitForSelector('#open')
  return page
}
/** Press a page button (a trusted click for Open wallet, a scripted one for the rest). Chrome must be in front. */
export const pageClick = (page, sel) => page.evaluate(s => document.querySelector(s).click(), sel)
export async function clickOpen(ctx, page) {
  await front('chrome')
  await clickGesture(page, '#open')
}
/** The kill: the wallet process dies, the service with it. */
export async function killWallet() {
  await shell(`am force-stop ${APP}`)
  await sleep(800)
}
export const serviceListed = async () => /BridgeService/.test(await shell(`dumpsys activity services ${APP}`))

export async function approveSheet(ctx, { name, id = 'bridge-approve', fallback = APPROVE_XY } = {}) {
  let n
  try {
    n = await uiWait(id, { timeoutMs: 15000 })
    if (name) await shot(ctx, name)
    await tapXY(center(n))
  } catch (e) {
    if (name) await shot(ctx, `${name}-nouidump`)
    await tapXY(fallback)
    ctx.note(`tapped ${id} by coordinates (${e.message})`)
  }
}

// ---- flows ---------------------------------------------------------------------------------------------------
const ATTENTION_TEXT = 'A website wants to continue. Tap to review.'
const clearLog = page => page.evaluate(() => (document.getElementById('log').textContent = '')).catch(() => {})
/** Clear the log, press `sel`, wait for `re` in the log; resolves with the matched text. */
export async function act(ctx, sel, re, { timeoutMs = 20000, chromeFront = true } = {}) {
  if (chromeFront) await front('chrome')
  const page = await pageNow(ctx)
  await clearLog(page)
  await pageClick(page, sel)
  return waitLog(page, re, { timeoutMs, what: `${sel} -> ${re}` })
}

export const attentionNotification = async () =>
  parseNotification(await shell('dumpsys notification --noredact'), 'bridge-attention')

/** Tap the attention notification in the shade; the wallet comes forward with the sheet. */
export async function tapAttention() {
  await shell('cmd statusbar expand-notifications')
  await sleep(1200)
  const n = await uiWait(ATTENTION_TEXT, { timeoutMs: 15000, what: 'attention notification in the shade' })
  await tapXY(center(n))
  await sleep(800)
}

/** Open wallet from a dead (or `kill: false`: live) app: launch, discovery answered, Chrome in front again. */
export async function openWallet(ctx, { kill = true, clearToken = true, fresh = true } = {}) {
  let last
  for (let attempt = 0; attempt < 2; attempt++) {
    if (kill || attempt) await killWallet()
    const page = fresh || attempt ? await freshPage(ctx, { clearToken: clearToken || attempt > 0 }) : await pageNow(ctx)
    await front('chrome')
    await clearLog(page)
    await clickGesture(page, '#open')
    try {
      await waitLog(page, /OK open -> \[\{/, { timeoutMs: attempt ? 60000 : 30000, what: 'open wallet discovery' })
      return page
    } catch (e) {
      last = e
      ctx.note(`open wallet attempt ${attempt + 1} failed: ${e.message}`)
    }
  }
  throw last
}

/**
 * The consented flow: open, connect, then `getPublicKey` raises the Connect sheet (the first interactive request of a
 * token-less binding), approved by tapping it. Leaves the page connected with a reconnect token in its storage.
 */
export async function establish(ctx, { kill = true, shotName } = {}) {
  await openWallet(ctx, { kill })
  await act(ctx, '#connect', /OK connect ->/)
  const page = await pageNow(ctx)
  await clearLog(page)
  await pageClick(page, '#getPublicKey')
  await sleep(1500)
  await front('wallet')
  await dismissNotificationDialog()
  const origin = await uiWait('bridge-connect-origin', { timeoutMs: 25000, what: 'Connect sheet' })
  ctx.sheetOrigin = origin.text || origin.desc
  if (shotName) await shot(ctx, shotName)
  return page
}
/** The system POST_NOTIFICATIONS dialog (asked once at the first accepted launch while the permission is not granted). */
export async function dismissNotificationDialog() {
  const nodes = await uiNodes()
  const n = findByText(nodes, "Don't allow")
  if (n) {
    await tapXY(center(n))
    await sleep(800)
  }
}
export async function consent(ctx) {
  await approveSheet(ctx)
  const page = await pageNow(ctx)
  await waitLog(page, /OK getPublicKey ->/, { timeoutMs: 25000, what: 'getPublicKey answer' })
  return page
}
/** A connected page that answers: reuse the running one, else establish a new one. */
export async function ensureConnected(ctx) {
  try {
    await act(ctx, '#getVersion', /OK getVersion ->/, { timeoutMs: 6000 })
    return
  } catch {
    // not connected any more
  }
  await establish(ctx)
  await consent(ctx)
}
export const pageHasToken = async page =>
  page.evaluate(() => Object.keys(localStorage).some(k => k.includes('token') || k.includes('reconnect')))

const must = (cond, msg) => {
  if (!cond) throw new Error(msg)
}

/**
 * A request that needs the user: the conformance card `conformanceCreateSignature` (a protocol sheet). The unfunded test
 * wallet answers `createAction` with its own error before any sheet (SPIKES, Task 22), so cases that need a pending
 * request use this one. Resolves once the card is running; `.status()` reads the card's current status.
 */
export async function startHeldRequest(ctx) {
  await front('chrome')
  const page = await pageNow(ctx)
  const card = '[data-card="conformanceCreateSignature"]'
  await clearLog(page)
  await page.evaluate(c => document.querySelector(`${c} button`).click(), card)
  await sleep(1500)
  const status = () => page.evaluate(c => document.querySelector(`${c} .cf-st`)?.textContent ?? '', card)
  const first = await status()
  must(first === 'running', `the request is not held open (card status ${first})`)
  return { page, status }
}
export async function finishHeldRequest(ctx, h, { timeoutMs = 60000 } = {}) {
  // No Chrome in front here: leaving the wallet within the 400 ms grant delay parks the grant until the wallet is raised
  // again (SPIKES Task 24, finding F1); the wallet returns to the browser by itself after the answer.
  const t0 = Date.now()
  let st = ''
  while (Date.now() - t0 < timeoutMs) {
    st = await h.status()
    if (st && st !== 'running') break
    await sleep(1500)
  }
  return st
}

// ---- the 17 cases ----------------------------------------------------------------------------------------------
export const CASES = [
  {
    id: 1,
    name: 'cold launch, Connect sheet, connected',
    async run(ctx) {
      await killWallet()
      must(!(await walletPid()), 'wallet process still alive before the cold launch')
      await establish(ctx, { shotName: '01-connect-sheet' })
      must(/localhost:3001/.test(ctx.sheetOrigin), `sheet origin ${ctx.sheetOrigin}`)
      must(await uiHas('Unverified'), 'the sheet does not say Unverified')
      const top = await topPackage()
      must(top === APP, `wallet not in front (${top})`)
      await consent(ctx)
      await waitTop(CHROME, 10000).catch(() => {})
      await shot(ctx, '01-connected')
      return `cold start from a dead process, sheet origin ${ctx.sheetOrigin} Unverified, connected`
    }
  },
  {
    id: 2,
    name: 'getVersion and isAuthenticated',
    async run(ctx) {
      await ensureConnected(ctx)
      const v = await act(ctx, '#getVersion', /OK getVersion ->[^\n]*/)
      const a = await act(ctx, '#isAuthenticated', /OK isAuthenticated ->[^\n]*/)
      await shot(ctx, '02-getversion-isauthenticated')
      return `${v.slice(0, 60)}; ${a.slice(0, 60)}`
    }
  },
  {
    id: 3,
    name: 'getPublicKey and a request held open across the sheet',
    async run(ctx) {
      await ensureConnected(ctx)
      const k = await act(ctx, '#getPublicKey', /OK getPublicKey ->[^\n]*/)
      // createAction on the unfunded test wallet: the wallet's own answer, no sheet (SPIKES Task 22).
      const ca = await act(ctx, '#createAction', /(OK|ERR) createAction ->[^\n]*/, { timeoutMs: 40000 })
      const h = await startHeldRequest(ctx)
      let n
      for (let i = 0; i < 10 && !n; i++) {
        await sleep(1500)
        n = await attentionNotification()
      }
      must(n, 'no attention notification for the held request')
      await tapAttention()
      await uiWait('bridge-approve', { timeoutMs: 25000, what: 'createSignature sheet' })
      await shot(ctx, '03-held-request-sheet')
      await approveSheet(ctx)
      const final = await finishHeldRequest(ctx, h)
      await shot(ctx, '03-held-request-result')
      must(final === 'pass', `held-open createSignature ended ${final}`)
      return `getPublicKey ok (${k.slice(0, 40)}...); createAction answered by the wallet: ${ca.slice(0, 90)}; createSignature held open across the sheet, result after Approve: ${final}`
    }
  },
  {
    id: 4,
    name: "Don't connect: 403 USER_CANCELLED, nothing granted",
    async run(ctx) {
      await establish(ctx, { shotName: '04-connect-sheet' })
      await approveSheet(ctx, { id: 'bridge-deny', fallback: DENY_XY })
      const page = await pageNow(ctx)
      const res = await waitLog(page, /ERR getPublicKey ->[^\n]*/, { timeoutMs: 25000 })
      await front('chrome')
      await shot(ctx, '04-denied')
      must(/USER_CANCELLED|403/.test(res), `unexpected error ${res}`)
      let answered = true
      const v = await act(ctx, '#getPublicKey', /(OK|ERR) getPublicKey ->[^\n]*/, { timeoutMs: 20000 }).catch(e => {
        answered = false
        return String(e.message)
      })
      // a further interactive request raises a fresh sheet again (nothing was granted): the page does not get a key
      must(
        !(answered && /^OK getPublicKey/.test(String(v))),
        `follow-up getPublicKey succeeded after Deny: ${String(v).slice(0, 80)}`
      )
      const again = await attentionNotification()
      await shell('input keyevent KEYCODE_BACK').catch(() => {})
      return `denied: ${res.slice(0, 120)}; follow-up getPublicKey did not succeed (${again ? 'raised a new prompt' : String(v).slice(0, 80)})`
    }
  },
  {
    id: 5,
    name: 'warm launch and silent reconnect with the token',
    async run(ctx) {
      await establish(ctx)
      await consent(ctx)
      const page = await pageNow(ctx)
      const keys = await page.evaluate(() => Object.keys(localStorage))
      must(keys.length >= 2, `no reconnect token stored (${keys.join(',')})`)
      must(await walletPid(), 'wallet process not alive for the warm launch')
      await front('chrome')
      await page.goto(ctx.origin + '/', { waitUntil: 'load' }) // reload: token stays
      await page.waitForSelector('#open')
      await clearLog(page)
      await clickGesture(page, '#open')
      await waitLog(page, /OK open -> \[\{/, { timeoutMs: 40000 })
      await act(ctx, '#connect', /OK connect ->/)
      await clearLog(page)
      await pageClick(page, '#getPublicKey')
      await waitLog(page, /OK getPublicKey ->/, { timeoutMs: 20000, what: 'silent getPublicKey' })
      must(!(await uiHas('bridge-connect-origin')), 'a Connect sheet appeared on the silent reconnect')
      await shot(ctx, '05-silent-reconnect')
      return 'warm launch (process alive), token presented, getPublicKey answered with no Connect sheet'
    }
  },
  {
    id: 6,
    name: 'conformance panel: Run all safe',
    async run(ctx) {
      await ensureConnected(ctx)
      await front('chrome')
      const page = await pageNow(ctx)
      // Animations stay off for the whole run (one uiautomator poll per few seconds); the sheet itself was verified at
      // the normal scale in cases 1, 3 and 15.
      await setUiFast(true)
      let done = false
      let sheets = 0
      let backToChrome = 0
      try {
        await pageClick(page, '#cf-run-all')
        const t0 = Date.now()
        let sawBusy = false
        while (Date.now() - t0 < 14 * 60000) {
          await sleep(2500)
          const st = await Promise.race([
            page.evaluate(() => ({
              busy: Boolean(document.querySelector('#cf-run-all')?.disabled),
              cards: document.querySelectorAll('.cf-card').length
            })),
            sleep(5000).then(() => undefined)
          ]).catch(() => undefined)
          if (st?.busy) sawBusy = true
          if (st && sawBusy && !st.busy) {
            done = true
            break
          }
          const nodes = await safeDump()
          if (findById(nodes, 'bridge-approve')) {
            await tapXY(center(findById(nodes, 'bridge-approve')))
            sheets++
          } else if ((await topPackage()) === APP) {
            // No sheet and the wallet is in front: the page (and its run) only advances in the foreground.
            await front('chrome')
            backToChrome++
          } else if (await attentionNotification()) {
            await tapAttention().catch(() => {})
          }
        }
      } finally {
        await setUiFast(false)
      }
      await front('chrome')
      await shot(ctx, '06-conformance')
      const rows = await page.evaluate(() =>
        [...document.querySelectorAll('.cf-card')].map(c => ({
          id: c.querySelector('.cf-id')?.textContent,
          status: c.querySelector('.cf-st')?.textContent,
          code: c.querySelector('.cf-code')?.textContent,
          cases: c.querySelector('summary')?.textContent ?? '',
          message: c.querySelector('.cf-msg')?.textContent ?? '',
          failedCases: [...c.querySelectorAll('.cf-case')]
            .filter(k => k.querySelector('.cf-st')?.textContent === 'fail')
            .map(k =>
              `${k.querySelector('.cf-id')?.textContent} ${k.querySelector('.cf-code')?.textContent ?? ''}`.trim()
            )
        }))
      )
      ctx.conformance = rows
      fs.writeFileSync(path.join(ctx.shots, '06-conformance.json'), JSON.stringify(rows, null, 2))
      must(done, 'Run all safe did not finish in 14 minutes')
      const c = s => rows.filter(r => r.status === s).length
      return `finished: ${c('pass')} pass, ${c('fail')} fail, ${c('skip')} skip, ${c('-')} not run (spending cards) of ${rows.length} cards; ${sheets} sheets approved, Chrome fronted ${backToChrome} times when the wallet sat idle in front (failing cards recorded in 06-conformance.json, not hidden)`
    }
  },
  {
    id: 7,
    name: 'kill the app mid-session, page recovers through a new launch',
    async run(ctx) {
      await ensureConnected(ctx)
      await shell(`run-as ${APP} kill -9 $(pidof ${APP})`).catch(() => killWallet())
      await sleep(1500)
      must(!(await walletPid()), 'wallet process survived the kill')
      const err = await act(ctx, '#getVersion', /ERR getVersion ->[^\n]*/, { timeoutMs: 20000 })
      await shot(ctx, '07-after-kill')
      // recover: a new launch, silent reconnect with the stored token
      await openWallet(ctx, { kill: false, clearToken: false })
      await act(ctx, '#connect', /OK connect ->/)
      const v = await act(ctx, '#getVersion', /OK getVersion ->[^\n]*/)
      return `after the kill: ${err.slice(0, 100)}; a new launch recovered: ${v.slice(0, 60)}`
    }
  },
  {
    id: 8,
    name: 'MainActivity destroyed with the service alive: 412, reconnect',
    async run(ctx) {
      await ensureConnected(ctx)
      // Spec 7.1 destroys MainActivity. The "Don't keep activities" setting did not do it on Android 16 (SPIKES S5);
      // Back from the wallet destroys the activity with the process alive: the same state.
      await front('wallet')
      await sleep(800)
      await shell('input keyevent KEYCODE_BACK')
      await sleep(2000)
      const pid = await walletPid()
      const recs = (
        await shell(`dumpsys activity activities | grep -c "ActivityRecord.*${APP}/.MainActivity" || true`).catch(
          () => '0'
        )
      ).trim()
      const err = await act(ctx, '#getVersion', /ERR getVersion ->[^\n]*/, { timeoutMs: 20000 })
      must(/CONNECTION_CLOSED/.test(err), `expected CONNECTION_CLOSED, got ${err}`)
      await shot(ctx, '08-after-activity-destroyed')
      const listed = await serviceListed()
      const page = await pageNow(ctx)
      await page.goto(ctx.origin + '/', { waitUntil: 'load' })
      await page.waitForSelector('#open')
      await clickGesture(page, '#open')
      await waitLog(page, /OK open -> \[\{/, { timeoutMs: 60000 })
      await act(ctx, '#connect', /OK connect ->/)
      const v = await act(ctx, '#getVersion', /OK getVersion ->[^\n]*/)
      return `Back destroyed MainActivity (process ${pid ? 'alive' : 'dead'}, activity records ${recs}, BridgeService listed ${listed}); the page got ${err.slice(0, 130)}; a new launch reconnected: ${v.slice(0, 50)}`
    }
  },
  {
    id: 9,
    name: 'ports 3321 and 3322 held: wallet takes 3323',
    async run(ctx) {
      await killWallet()
      const held = await hold([3321, 3322], 'both')
      try {
        must(
          held.every(h => h.held),
          `could not hold: ${JSON.stringify(held.filter(h => !h.held))}`
        )
        await openWallet(ctx, { kill: false })
        await shot(ctx, '09-ports-held')
        const tcp = await shell('cat /proc/net/tcp /proc/net/tcp6')
        const listening = port =>
          tcp
            .split('\n')
            .filter(l => l.includes(`:${port.toString(16).toUpperCase().padStart(4, '0')} `) && /\s0A\s/.test(l)).length
        const n3323 = listening(3323)
        must(n3323 >= 2, `expected a 3323 listener on both families, found ${n3323}`)
        return `3321 and 3322 held on both families by test sockets; the wallet answered on 3323 (${n3323} listening sockets on 3323)`
      } finally {
        await release()
      }
    }
  },
  {
    id: 10,
    name: '::1:3321 held alone: wallet moves up',
    async run(ctx) {
      await killWallet()
      const held = await hold([3321], 'ipv6')
      try {
        if (!held.every(h => h.held)) {
          ctx.gate('case 10: `toybox nc` could not bind ::1:3321 on this AVD (no real Android bind message observed)')
          throw new Error('device gate: cannot hold ::1:3321')
        }
        await openWallet(ctx, { kill: false })
        await shot(ctx, '10-v6-held')
        const tcp = await shell('cat /proc/net/tcp /proc/net/tcp6')
        const count = hex => tcp.split('\n').filter(l => l.includes(`:${hex} `) && /\s0A\s/.test(l)).length
        const on3321 = count('0CF9')
        const on3322 = count('0CFA')
        must(on3322 >= 2, `expected the wallet on 3322 on both families, found ${on3322}`)
        return `::1:3321 held alone (${on3321} listener(s) on 3321: the test socket only), the wallet bound 127.0.0.1 and ::1 on 3322 (${on3322} sockets) and answered`
      } finally {
        await release()
      }
    }
  },
  {
    id: 11,
    name: 'squatter on 3321 with the real name: page refuses it',
    async run(ctx) {
      await killWallet()
      const here = path.dirname(fileURLToPath(import.meta.url))
      const bundle = path.join(os.tmpdir(), `bsv-squatter-${process.pid}.mjs`)
      createRequire(import.meta.url)('esbuild').buildSync({
        entryPoints: [path.join(here, 'squatter.entry.ts')],
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node20',
        outfile: bundle,
        external: ['react-native', 'expo-secure-store', 'expo-modules-core', 'expo', 'react'],
        banner: { js: "import {createRequire} from 'module';const require=createRequire(import.meta.url);" }
      })
      const lines = []
      const child = spawn(process.execPath, [bundle, '3321', ctx.origin], { stdio: ['ignore', 'pipe', 'inherit'] })
      child.stdout.on('data', d => lines.push(...String(d).split('\n').filter(Boolean)))
      try {
        for (let i = 0; i < 20 && !lines.some(l => l.includes('"ready"')); i++) await sleep(250)
        must(
          lines.some(l => l.includes('"ready"')),
          'the squatter did not start'
        )
        await adb(['reverse', 'tcp:3321', 'tcp:3321']) // the device's 3321 is now served by the host squatter
        await openWallet(ctx, { kill: false })
        const t = await logText(await pageNow(ctx))
        await shot(ctx, '11-squatter')
        must(/OK open -> \[\{/.test(t), 'the real wallet was not found past the squatter')
        must(/UNAUTHENTICATED/.test(t), `the page did not log the squatter's rejection: ${t.slice(0, 200)}`)
        const reqs = lines.filter(l => l.includes('"method"')).map(l => JSON.parse(l))
        must(reqs.length > 0, 'the squatter saw no request')
        must(
          reqs.every(r => r.method === 'GET' && r.path === '/.well-known/brc-wallet' && r.secretHeaders.length === 0),
          `the squatter saw more than describe GETs: ${JSON.stringify(reqs)}`
        )
        return `squatter on 3321 (signed descriptor under its own key, real name and vendor, no launch key): page logged UNAUTHENTICATED and found the real wallet on a higher port; the squatter saw ${reqs.length} describe GET(s) and no secret header`
      } finally {
        child.kill()
        await adb(['reverse', '--remove', 'tcp:3321']).catch(() => {})
        fs.rmSync(bundle, { force: true })
      }
    }
  },
  {
    id: 12,
    name: 'notifications revoked: bridge_notifications_off shown',
    async run(ctx) {
      // `pm revoke` kills the app process, so revoke first and establish afterwards.
      await shell(`pm revoke ${APP} android.permission.POST_NOTIFICATIONS`)
      await sleep(1500)
      try {
        await establish(ctx, { kill: true })
        await consent(ctx)
        const h = await startHeldRequest(ctx)
        await sleep(3000)
        const posted = await attentionNotification()
        await front('wallet')
        await sleep(1500)
        const has = await uiHas('bridge_notifications_off')
        const sheet = await uiHas('bridge-approve')
        await shot(ctx, '12-notifications-off')
        must(has, 'the bridge_notifications_off notice is not shown')
        must(sheet, 'Open wallet shows the pending request: no sheet is visible')
        must(!posted, 'an attention notification exists although notifications are revoked')
        await approveSheet(ctx)
        const final = await finishHeldRequest(ctx, h)
        return `notice bridge_notifications_off shown with a request pending, no notification posted, the pending request's sheet is offered when the wallet is opened; result after Approve: ${final}`
      } finally {
        await shell(`pm grant ${APP} android.permission.POST_NOTIFICATIONS`).catch(() => {})
      }
    }
  },
  {
    id: 14,
    name: 'plaintext check in logcat',
    async run(ctx) {
      const log = await shell('logcat -d')
      const lines = log.split('\n')
      const key = lines.filter(l => /\bk=[A-Za-z0-9_-]{43}\b/.test(l))
      const nonce = lines.filter(l => /\bn=[A-Za-z0-9_-]{22}\b/.test(l))
      const epochs = [...seenEpochs]
      const epochHits = lines.filter(l => epochs.some(e => l.includes(e)) || /\be=[0-9a-f]{8}-[0-9a-f]{4}-/.test(l))
      const tok = lines.filter(l => /BRC-185-Reconnect-Token|BRC-185-Android-Binding|reconnectToken/i.test(l))
      fs.writeFileSync(
        path.join(ctx.shots, '14-logcat-check.txt'),
        `logcat lines: ${lines.length}\nepochs launched in this run: ${epochs.length}\nlines with k=<43>: ${key.length}\nlines with n=<22>: ${nonce.length}\nlines naming a launched epoch or e=<uuid>: ${epochHits.length}\nlines naming a token or binding header: ${tok.length}\n`
      )
      must(key.length === 0, `${key.length} logcat lines carry k=<43 chars>`)
      must(nonce.length === 0, `${nonce.length} logcat lines carry n=<22 chars>`)
      must(epochHits.length === 0, `${epochHits.length} logcat lines carry a launched epoch`)
      must(tok.length === 0, `${tok.length} logcat lines name a token or binding header`)
      return `logcat since the start of the run (${lines.length} lines, ${epochs.length} epochs launched): no k=, n=, launched epoch, e=<uuid>, reconnect token or binding header anywhere, system lines included`
    }
  },
  {
    id: 15,
    name: 'later-prompt attention notification',
    async run(ctx) {
      await ensureConnected(ctx)
      const h = await startHeldRequest(ctx)
      let n
      for (let i = 0; i < 12 && !n; i++) {
        await sleep(1500)
        n = await attentionNotification()
      }
      must(n, 'no bridge-attention notification posted')
      must(n.text.includes(ATTENTION_TEXT), `notification text: ${n.text}`)
      must(!/localhost/i.test(n.raw), 'the notification record names the origin')
      must(
        /vis=PRIVATE/.test(n.raw) && /publicVersion=Notification/.test(n.raw),
        'visibility is not private with a public version'
      )
      fs.writeFileSync(path.join(ctx.shots, '15-attention-notification.txt'), n.raw.replace(/\n\s+/g, '\n'))
      await tapAttention()
      await uiWait('bridge-approve', { timeoutMs: 20000, what: 'sheet after the notification tap' })
      await shot(ctx, '15-sheet-after-tap')
      await approveSheet(ctx)
      const final = await finishHeldRequest(ctx, h)
      return `generic text "${ATTENTION_TEXT}", no origin anywhere in the record, vis=PRIVATE with a public version; tapping it showed the sheet (bridge-approve); request result after Approve: ${final}`
    }
  },
  {
    id: 16,
    name: 'return to browser after the last pending item',
    async run(ctx) {
      // The way back (spec 7.x) applies only when the launch trampoline raised the wallet: a cold launch from the page.
      await establish(ctx, { kill: true })
      const sheet = await uiWait('bridge-approve', { timeoutMs: 15000 })
      const tTap = Date.now()
      await tapXY(center(sheet))
      let top = await topPackage()
      while (top !== CHROME && Date.now() - tTap < 8000) {
        await sleep(300)
        top = await topPackage()
      }
      const returnMs = Date.now() - tTap
      await shot(ctx, '16-return-to-browser')
      const page = await pageNow(ctx)
      await waitLog(page, /OK getPublicKey ->/, { timeoutMs: 20000, what: 'getPublicKey answer' })
      // Control: raised by the attention notification (not the trampoline) the wallet stays where it is.
      const h = await startHeldRequest(ctx)
      await sleep(3000)
      await tapAttention()
      await uiWait('bridge-approve', { timeoutMs: 20000 })
      await approveSheet(ctx)
      await finishHeldRequest(ctx, h)
      await sleep(2500)
      const topAfterNotification = await topPackage()
      if (top !== CHROME) {
        ctx.gate(
          `case 16: ${returnMs} ms after the last Approve the top resumed activity is ${top}, not ${CHROME} on this AVD`
        )
        throw new Error(`device gate: observed top activity ${top}`)
      }
      return `after the last Approve of a trampoline-raised wallet, Chrome is the top resumed activity ${returnMs} ms after the tap; control: raised by the attention notification, the wallet stays (top ${topAfterNotification})`
    }
  },
  {
    id: 17,
    name: 'Disconnect from the service notification',
    async run(ctx) {
      await ensureConnected(ctx)
      must(await serviceListed(), 'BridgeService not listed before Disconnect')
      await shell('cmd statusbar expand-notifications')
      await sleep(1200)
      const d = await uiWait('Disconnect', { timeoutMs: 15000, what: 'Disconnect action' })
      await shot(ctx, '17-disconnect-action')
      await tapXY(center(d))
      await sleep(2500)
      await shell('cmd statusbar collapse')
      const err = await act(ctx, '#getVersion', /ERR getVersion ->[^\n]*/, { timeoutMs: 20000 })
      must(!(await serviceListed()), 'BridgeService still listed after Disconnect')
      await shot(ctx, '17-after-disconnect')
      return `the page's next call: ${err.slice(0, 120)}; BridgeService no longer listed`
    }
  },
  {
    id: 13,
    name: 'incognito tab',
    async run(ctx) {
      // Chrome ignores the incognito extra on external intents and DevTools lists no Incognito target (and its page
      // content is not in the UI tree), so the tab is opened from Chrome's own menu and driven with real taps at the
      // Open wallet button's position. A control with the same tap in a normal tab must start the trampoline.
      const OPEN_BTN = { x: 190, y: 630 }
      const startsOf = async () =>
        (await shell('logcat -d')).split('\n').filter(l => /ActivityTaskManager.*START.*bsv-wallet-bridge/.test(l))
          .length
      await shell(`am force-stop ${CHROME}`)
      await sleep(600)
      await front('chrome')
      await sleep(1500)
      await killWallet()
      await shell('logcat -c')
      let incognitoProof = ''
      try {
        await tapXY({ x: 1015, y: 215 }) // the three-dot menu
        await sleep(1200)
        await uiTap('New Incognito tab', { timeoutMs: 8000 })
        await sleep(2500)
        const ntp = await uiNodes()
        must(findByText(ntp, 'You’ve gone Incognito'), 'the Incognito new tab page is not showing')
        await tapXY({ x: 400, y: 215 }) // the address bar
        await sleep(800)
        await shell(`input text '${ctx.origin.replace('http://', '')}/'`)
        await shell('input keyevent KEYCODE_ENTER')
        await sleep(4000)
        const loaded = (await uiNodes()).find(n => /localhost:3001/.test(`${n.text}${n.desc}`))
        must(loaded, 'the demo page did not load in the Incognito tab')
        incognitoProof = 'Incognito new tab page seen, then localhost:3001 loaded'
      } catch (e) {
        ctx.gate(
          `case 13: could not open and drive an Incognito tab from Chrome's menu (${e.message}); launch from Incognito stays a device gate (SPIKES S2)`
        )
        throw new Error(`device gate: ${e.message}`)
      }
      await shot(ctx, '13-incognito')
      await tapXY(OPEN_BTN) // a real tap
      await sleep(9000)
      const starts = await startsOf()
      const top = await topPackage()
      const walletUp = Boolean(await walletPid())
      // Control: the same tap on the same page in a normal tab.
      await shell(`am force-stop ${CHROME}`)
      await sleep(600)
      await shell(`am start -a android.intent.action.VIEW -d '${ctx.origin}/' ${CHROME}`)
      await sleep(4000)
      await shell('logcat -c')
      await tapXY(OPEN_BTN)
      await sleep(9000)
      const controlStarts = await startsOf()
      must(
        controlStarts >= 1,
        `control failed: the same tap in a normal tab produced ${controlStarts} trampoline starts, so the Incognito result proves nothing`
      )
      must(
        starts === 0 && top !== APP && !walletUp,
        `Incognito: ${starts} trampoline starts, top ${top}, wallet process ${walletUp}`
      )
      await shell(`am force-stop ${CHROME}`) // last case of the run
      return `Incognito tab (${incognitoProof}), Open wallet tapped for real: ${starts} trampoline starts, the wallet did not come forward (top ${top}), no wallet process; control, same tap in a normal tab: ${controlStarts} trampoline start(s). Screen capture of Incognito is blank (FLAG_SECURE)`
    }
  }
]

// ======================================================================================================================
// Overlay mode (M2 Task 13). The cases O1 to O21 (O22 is a pure test, see the plan). Evidence is the uiautomator XML and
// state text of `ov.saveEvidence`, never pixels: the sheet window is FLAG_SECURE.
// ======================================================================================================================
const CARD = id => `[data-card="${id}"]`
const SIGN_CARD = CARD('conformanceCreateSignature')
const ENCRYPT_CARD = CARD('conformanceEncrypt')
const cardStatus = (page, card) => page.evaluate(c => document.querySelector(`${c} .cf-st`)?.textContent ?? '', card)
const startCard = (page, card) => page.evaluate(c => document.querySelector(`${c} button`).click(), card)
const waitCard = async (page, card, want, timeoutMs = 40000) => {
  const t0 = Date.now()
  let st = ''
  while (Date.now() - t0 < timeoutMs) {
    st = await cardStatus(page, card)
    if (st === want) return st
    await sleep(700)
  }
  throw new Error(`card ${card} ended ${st}, wanted ${want}`)
}
const evid = (ctx, name, extra) => ov.saveEvidence(fs, path, ctx.shots, name, extra)
const createCount = () => ov.lastCount('BsvBridgeSheet.*sheet-activity create')
const mountCount = () => ov.lastCount('sheet-root mount')
const rootRuns = async () => (await ov.logLines(/Running "BsvBridgeSheet"/)).length
/** Notifications of a dead process are gone: a case that asserts a notification starts from none. */
async function freshNotifications() {
  if (await attentionNotification()) {
    await killWallet()
    await startWalletToHome()
  }
}
const chromeState = () => ov.activityState(/ActivityRecord\{[^}]*com\.android\.chrome/)
const nodeCount = async id =>
  (await uiNodes()).filter(n => n.id === id || n.id.endsWith('/' + id) || n.desc === id).length

/** The wallet process alive with a `MainActivity` record (not finishing): the "warm" state the trampoline needs. */
export async function isWarm() {
  if (!(await walletPid())) return false
  const t = await shell('dumpsys activity activities')
  return t
    .split('\n')
    .some(l => /ActivityRecord\{[^}]*org\.bsvblockchain\.wallet\/\.MainActivity/.test(l) && !/finishing/.test(l))
}
/** Wallet cold-started to Home (dev-client link), then settled so the tracker is registered and the host is ready. */
let opensSinceStart = 99 // the first open of a run starts from a fresh wallet process (earlier runs leave bindings behind)
export async function startWalletToHome() {
  opensSinceStart = 0
  await setAnimationScale(0)
  try {
    await launchApp()
    await waitForNode(nodes => nodes.find(n => /^(Settings|Get set up|Total balance.*)$/.test(n.text || n.desc)), {
      timeoutMs: 180000,
      pollMs: 2000,
      what: 'Home after the cold start'
    }).catch(async () => {
      await dismissDevMenu({ timeoutMs: 6000 })
      await unlockIfNeeded()
    })
    await dismissDevMenu({ timeoutMs: 4000 })
    await unlockIfNeeded()
  } finally {
    await setAnimationScale(1)
  }
  await sleep(4000)
}
/** Warm and unlocked, Chrome in front: the state of the overlay cases (main alive and not resumed). */
export async function warmWallet() {
  if (!(await isWarm())) await startWalletToHome()
  await front('chrome')
  await sleep(1000)
  if (!(await isWarm())) throw new Error('the wallet is not warm after the setup')
}
/** Fresh page, Open wallet clicked for real; resolves with the page once the overlay sheet is resumed. */
export async function overlayOpen(ctx, { clearToken = true, fresh = false } = {}) {
  // A permission granted to a site is remembered for the life of the wallet process (the per-process grant tag), so a
  // case that needs a prompt starts from a fresh process.
  if (fresh) {
    await killWallet()
    await startWalletToHome()
  }
  // Every page load leaves a binding behind (the core keeps up to MAX_BINDINGS_PER_ORIGIN live: "Too many open
  // connections for this site" after that), so the wallet restarts before the limit. Tokens survive a restart (M1 case 7).
  if (++opensSinceStart > 4 && (await isWarm())) {
    await killWallet()
    await startWalletToHome()
  }
  await warmWallet()
  const page = await freshPage(ctx, { clearToken })
  await clearLog(page)
  await clickOpen(ctx, page)
  await ov.waitFor(ov.sheetResumed, { timeoutMs: 12000, what: 'the overlay sheet after Open wallet' })
  return page
}
/** Inside the overlay: discovery answered, connect, then getPublicKey raises the Connect sheet (nothing pends before it). */
export async function overlayRaiseConnect(ctx, page) {
  await waitLog(page, /OK open -> \[\{/, { timeoutMs: 20000, what: 'discovery through the overlay' })
  await act(ctx, '#connect', /OK connect ->/, { chromeFront: false, timeoutMs: 20000 })
  await clearLog(page)
  await pageClick(page, '#getPublicKey')
  return uiWait('bridge-connect-origin', { timeoutMs: 20000, what: 'Connect sheet in the overlay' })
}
/** A connected page with a stored token and no sheet up: overlay open, Connect, Approve, back in Chrome. */
export async function overlayEstablish(ctx, { fresh = true } = {}) {
  const page = await overlayOpen(ctx, { fresh })
  await overlayRaiseConnect(ctx, page)
  await approveSheet(ctx)
  await waitLog(page, /OK getPublicKey ->/, { timeoutMs: 25000, what: 'getPublicKey after Approve' })
  await ov.waitFor(async () => !(await ov.sheetResumed()), {
    timeoutMs: 10000,
    what: 'the sheet to finish after Approve'
  })
  return page
}
/**
 * A sheet up with a request pending in it. A permission granted on a connection is remembered for that connection (the
 * unverified originator carries a per-connection tag), so a repeat request on a reconnect would be answered silently:
 * the connection is made fresh. The card's request is started while the Connect sheet is up (it parks behind the consent),
 * then Connect is approved and the protocol sheet follows in the same root with the sheet never idle in between.
 * Resolves with the page; the sheet shows the protocol prompt's `bridge-approve`.
 */
export async function overlayHeld(ctx, { card = SIGN_CARD, fresh = true } = {}) {
  let lastErr
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const page = await overlayOpen(ctx, { fresh: fresh || attempt > 0 })
      await overlayRaiseConnect(ctx, page)
      await startCard(page, card)
      await sleep(400)
      await approveSheet(ctx) // Connect
      await ov.waitFor(async () => (await uiNodes()).some(n => /cryptographic protocol/i.test(n.text)), {
        timeoutMs: 20000,
        pollMs: 500,
        what: 'the protocol prompt after Connect'
      })
      await uiWait('bridge-approve', { timeoutMs: 5000, what: 'the held request sheet' })
      must((await cardStatus(page, card)) === 'running', 'the held request is not running')
      return page
    } catch (e) {
      lastErr = e
      ctx.note(`held request sheet did not appear (attempt ${attempt + 1}): ${e.message}`)
      await ov.waitFor(async () => !(await ov.sheetResumed()), { timeoutMs: 8000 }).catch(() => {})
    }
  }
  throw new Error(`no held request sheet in two attempts: ${lastErr?.message}`)
}
const approveAndFinish = async (ctx, page, card = SIGN_CARD) => {
  await approveSheet(ctx)
  await waitCard(page, card, 'pass', 60000)
  await ov.waitFor(async () => !(await ov.sheetResumed()), {
    timeoutMs: 12000,
    what: 'the sheet to finish after the last Approve'
  })
}
const lowBackToChrome = async () => {
  await ov.waitFor(async () => /chrome/.test((await ov.topResumed()) ?? ''), {
    timeoutMs: 12000,
    what: 'Chrome top resumed'
  })
}
const walletToSettings = async () => {
  await front('wallet')
  await sleep(800)
  await uiTap('Settings', { timeoutMs: 15000 })
  await sleep(1500)
}

export const OVERLAY_CASES = [
  {
    id: 'O1',
    name: 'warm: Open wallet raises the sheet over Chrome, Connect, back to Chrome',
    async run(ctx) {
      const page = await overlayOpen(ctx)
      const origin = await overlayRaiseConnect(ctx, page)
      const text = origin.text || origin.desc
      must(/localhost:3001/.test(text), `sheet origin ${text}`)
      must(await uiHas('Unverified'), 'the sheet does not say Unverified')
      must(await ov.sheetResumed(), 'sheet is not resumed')
      const reg = await ov.approveInSheetRegion()
      must(reg.ok, `bridge-approve is not in the sheet region: ${reg.why} ${JSON.stringify(reg.b)}`)
      must(await uiHas('bridge-sheet-root'), 'no bridge-sheet-root node')
      must(await ov.topIsSheet(), `top resumed is ${await ov.topResumed()}, not the sheet`)
      const cs = await chromeState()
      must(cs === 'PAUSED', `Chrome state is ${cs}, expected PAUSED`)
      await evid(
        ctx,
        'O1-connect-sheet',
        `chrome state: ${cs}\napprove bounds: ${JSON.stringify(reg.b)} screen ${reg.w}x${reg.h}`
      )
      await approveSheet(ctx)
      await waitLog(page, /OK getPublicKey ->/, { timeoutMs: 25000, what: 'getPublicKey after Approve' })
      await ov.waitFor(async () => !(await ov.sheetResumed()), { timeoutMs: 10000, what: 'the sheet to go' })
      await lowBackToChrome()
      await evid(ctx, 'O1-after-connect')
      return `bridge-sheet-root and bridge-connect-origin (${text}) with Unverified; bridge-approve at ${JSON.stringify(reg.b)} on ${reg.w}x${reg.h}; top resumed was the sheet, Chrome ${cs}; after Connect the sheet is gone and Chrome is top resumed`
    }
  },
  {
    id: 'O2',
    name: 'held createSignature across the overlay sheet, one owner',
    async run(ctx) {
      const page = await overlayHeld(ctx)
      const n = await nodeCount('bridge-approve')
      must(n === 1, `${n} bridge-approve nodes in the window dump, expected exactly one (one owner)`)
      must((await cardStatus(page, SIGN_CARD)) === 'running', 'the request is not held open')
      must(await ov.topIsSheet(), `top resumed is ${await ov.topResumed()}`)
      const reg = await ov.approveInSheetRegion()
      must(reg.ok, `approve not in the sheet region: ${reg.why}`)
      await evid(ctx, 'O2-held-request', `bridge-approve nodes: ${n}`)
      await approveAndFinish(ctx, page)
      await lowBackToChrome()
      return `the page's createSignature stayed open across the overlay sheet (exactly ${n} bridge-approve node), Approve answered it (card pass), the sheet finished and Chrome is top resumed`
    }
  },
  {
    id: 'O3',
    name: 'cold regression guard: no sheet Activity in the tracker window, foreground Connect, no notification',
    async run(ctx) {
      const out = []
      for (const delay of [500, 1500, 2500]) {
        await warmWallet().catch(() => {}) // a wallet to start from; the case itself kills it
        const page = await freshPage(ctx)
        await killWallet()
        await shell('logcat -c')
        const t0 = Date.now()
        await launchApp() // am start of the dev-client link: MainActivity is created now
        await shell(`am start -a android.intent.action.VIEW -d '${ctx.origin}/' ${CHROME}`) // Chrome back in front, page kept
        await sleep(Math.max(0, delay - (Date.now() - t0)))
        const at = Date.now() - t0
        await clickGesture(await pageNow(ctx), '#open')
        let listed = false
        const seen = []
        const t1 = Date.now()
        while (Date.now() - t1 < 14000) {
          if (await ov.sheetListed()) {
            listed = true
            break
          }
          seen.push(((await ov.resumedActivities())[0] ?? '-').replace(/^org.bsvblockchain.wallet\//, ''))
          await sleep(500)
        }
        must(
          !listed,
          `delay ${delay} ms (click at ${at} ms): BridgeSheetActivity was listed (overlay in the tracker window)`
        )
        // The wallet is in front (the trampoline raised it): drive the page without touching the wallet.
        const p = await pageNow(ctx)
        await waitLog(p, /OK open -> \[\{/, { timeoutMs: 90000, what: 'cold discovery' })
        await pageClick(p, '#connect')
        await waitLog(p, /OK connect ->/, { timeoutMs: 30000, what: 'connect' })
        await clearLog(p)
        await pageClick(p, '#getPublicKey')
        const origin = await uiWait('bridge-connect-origin', { timeoutMs: 40000, what: 'foreground Connect sheet' })
        const top = await ov.topResumed()
        const note = await attentionNotification()
        must(!(await ov.sheetListed()), `delay ${delay}: a sheet Activity was listed during the connect`)
        must(/MainActivity/.test(top ?? ''), `delay ${delay}: top resumed is ${top}, not MainActivity`)
        must(!note, `delay ${delay}: a bridge-attention notification was posted during the cold foreground connect`)
        await evid(
          ctx,
          `O3-${delay}`,
          `click at ${at} ms after am start; resumed rows seen: ${[...new Set(seen)].join(' | ')}`
        )
        await approveSheet(ctx, { id: 'bridge-deny', fallback: DENY_XY })
        await sleep(1500)
        out.push(`${delay} ms (click at ${at}): no sheet listed, Connect in ${top?.split('/')[1]}, no notification`)
      }
      return out.join('; ')
    }
  },
  {
    id: 'O4',
    name: 'Back in the sheet with the main tree on Settings: request stays parked, notification follows',
    async run(ctx) {
      const inSettings = async () =>
        (await uiNodes()).some(n =>
          /Currency|Security|Language|Appearance|Notifications|Privacy|ACCOUNT/i.test(n.text || n.desc)
        )
      // The held request needs a fresh process; the main tree goes to Settings while the page is already loaded.
      await killWallet()
      await startWalletToHome()
      await walletToSettings()
      must(await inSettings(), 'the wallet did not reach Settings')
      const page = await overlayHeld(ctx, { fresh: false })
      await evid(ctx, 'O4-sheet-up')
      await shell('input keyevent KEYCODE_BACK')
      await ov.waitFor(async () => !(await ov.sheetResumed()), { timeoutMs: 6000, what: 'Back to finish the sheet' })
      const tBack = Date.now()
      let note
      while (!note && Date.now() - tBack < 8000) {
        note = await attentionNotification()
        if (!note) await sleep(250)
      }
      const noteMs = Date.now() - tBack
      must(note, 'no bridge-attention notification after Back')
      must(note.text.includes(ATTENTION_TEXT), `notification text ${note.text}`)
      must((await cardStatus(page, SIGN_CARD)) === 'running', 'the request is no longer parked after Back')
      must(!(await ov.mainResumed()), 'MainActivity became resumed after Back')
      await evid(
        ctx,
        'O4-after-back',
        `notification seen ${noteMs} ms after the sheet finished (counts only, no origin: ${!/localhost/i.test(note.raw)})`
      )
      // MainActivity is still on Settings
      await front('wallet')
      must(await inSettings(), 'MainActivity is not on Settings any more')
      await front('chrome')
      // clean up: answer the parked request through the notification
      await tapAttention()
      await uiWait('bridge-approve', { timeoutMs: 20000, what: 'sheet after the notification tap' })
      await approveAndFinish(ctx, page)
      return `Back finished the sheet, the request stayed parked (card running), MainActivity still on Settings, the attention notification (generic text, no origin) appeared ${noteMs} ms later; tapping it re-showed the sheet and Approve answered the request`
    }
  },
  {
    id: 'O5',
    name: 'Home with the sheet up: the sheet task goes, a new launch makes a fresh root',
    async run(ctx) {
      const page = await overlayHeld(ctx)
      const c0 = await createCount()
      const m0 = await mountCount()
      await shell('input keyevent KEYCODE_HOME')
      await ov.waitFor(async () => !(await ov.sheetListed()), {
        timeoutMs: 8000,
        what: 'the sheet task to leave dumpsys'
      })
      await evid(ctx, 'O5-after-home')
      // the request is parked: the notification may fire; a fresh launch brings a fresh root
      await front('chrome')
      await shell('cmd statusbar collapse').catch(() => {})
      const p = await pageNow(ctx)
      await clearLog(p)
      await clickOpen(ctx, p)
      await ov.waitFor(ov.sheetResumed, { timeoutMs: 12000, what: 'a new sheet after Home' })
      const c1 = await createCount()
      const m1 = await mountCount()
      must(c1 === c0 + 1, `sheet-activity create count went ${c0} -> ${c1}, expected +1 (a fresh Activity)`)
      must(m1 === m0 + 1, `sheet-root mount count went ${m0} -> ${m1}, expected +1 (a fresh root)`)
      // finish: the parked request is shown in the fresh root
      await uiWait('bridge-approve', { timeoutMs: 15000, what: 'the parked request in the fresh root' }).catch(() => {})
      await approveAndFinish(ctx, page).catch(async e => {
        ctx.note(`cleanup: ${e.message}`)
      })
      return `Home: the sheet left dumpsys once onStop ran; the next launch created a fresh Activity (create n ${c0} -> ${c1}) and a fresh root (mount n ${m0} -> ${m1}); counts are process-wide, so "fresh" is +1, not 1`
    }
  },
  {
    id: 'O6',
    name: 'wallet in front when the prompt arrives: in-app sheet, no overlay, no notification',
    async run(ctx) {
      await overlayEstablish(ctx)
      await front('wallet')
      const c0 = await createCount()
      const page = await pageNow(ctx)
      await clearLog(page)
      await startCard(page, SIGN_CARD)
      await uiWait('bridge-approve', { timeoutMs: 20000, what: 'the in-app sheet' })
      must(await ov.mainResumed(), 'MainActivity is not resumed')
      must(!(await ov.sheetListed()), 'BridgeSheetActivity is listed although the wallet is in front')
      must((await createCount()) === c0, 'a sheet Activity was created')
      must((await nodeCount('bridge-approve')) === 1, 'duplicate bridge-approve nodes')
      must(!(await attentionNotification()), 'an attention notification was posted while the wallet is in front')
      await evid(ctx, 'O6-in-app-sheet')
      await approveSheet(ctx)
      await waitCard(page, SIGN_CARD, 'pass', 60000)
      return 'the prompt rendered in the main tree (one bridge-approve), no BridgeSheetActivity listed, no create log, no notification'
    }
  },
  {
    id: 'O7',
    name: 'screen off then on, and a recents peek then screen off: same root, same prompt',
    async run(ctx) {
      const page = await overlayHeld(ctx)
      const c0 = await createCount()
      const m0 = await mountCount()
      const r0 = await rootRuns()
      await shell('input keyevent KEYCODE_SLEEP')
      await sleep(2500)
      await shell('input keyevent KEYCODE_WAKEUP')
      await sleep(800)
      await shell('wm dismiss-keyguard').catch(() => {})
      await sleep(1500)
      must(await ov.sheetResumed(), 'the sheet finished with the screen off (no leave mark: must stay)')
      await uiWait('bridge-approve', { timeoutMs: 8000, what: 'the same pending prompt after waking' })
      // The same root: the same Activity (no new create) and no new AppRegistry run. The inner tree re-mounts when the
      // sheet window pauses (the owner gate renders nothing while the sheet is not resumed), so the mount count may move.
      must((await createCount()) === c0 && (await rootRuns()) === r0, 'the root was recreated by the screen cycle')
      const m1 = await mountCount()
      // recents peek returns, then screen off
      // a peek that returns before the Activity stops: overview and straight back in one shell call
      await shell('input keyevent KEYCODE_APP_SWITCH; sleep 0.35; input keyevent KEYCODE_BACK').catch(() => {})
      await sleep(2500)
      const afterPeek = await ov.sheetResumed()
      let peekNote = `after the recents peek the sheet ${afterPeek ? 'is back' : 'is not resumed'}`
      if (afterPeek) {
        await shell('input keyevent KEYCODE_SLEEP')
        await sleep(2500)
        await shell('input keyevent KEYCODE_WAKEUP')
        await sleep(800)
        await shell('wm dismiss-keyguard').catch(() => {})
        await sleep(1500)
        must(await ov.sheetResumed(), 'the sheet finished after a returned recents peek followed by screen off')
        must(
          (await createCount()) === c0 && (await rootRuns()) === r0,
          'the root was recreated after peek + screen off'
        )
        peekNote += '; screen off after it did not finish it'
      } else {
        ctx.gate(
          'O7: the recents peek on this AVD did not return to the sheet through KEYCODE_APP_SWITCH, so the peek-then-screen-off half is covered by Task 4 `leave then resume then stop does not finish` only'
        )
      }
      await evid(ctx, 'O7-after-wake')
      await approveAndFinish(ctx, page).catch(e => ctx.note(`cleanup: ${e.message}`))
      return `screen off then on: the same sheet Activity (create n ${c0}) and root (no new AppRegistry run) with the same pending prompt; the inner tree re-mounted with the owner gate (mount n ${m0} -> ${m1}, expected: the sheet window was not resumed while the screen was off); ${peekNote}`
    }
  },
  {
    id: 'O8',
    name: 'a prompt for another origin while the sheet is up shows in the same root, never a second Activity',
    async run(ctx) {
      // Origin B is the same demo served on 3002 (the wallet accepts http://localhost:<port> only). B is connected first
      // through the overlay, then A raises the sheet and B's request arrives while it is up (a second Open wallet tap
      // cannot reach while the sheet is up, S3 row (g), so B must already be connected).
      const portB = 3002
      const originB = `http://localhost:${portB}`
      const here = path.dirname(fileURLToPath(import.meta.url))
      const server = spawn(process.execPath, [path.join(here, '../../demo/serve.mjs'), String(portB)], {
        stdio: 'ignore'
      })
      let pageA
      let pageB
      try {
        await adb(['reverse', `tcp:${portB}`, `tcp:${portB}`])
        await sleep(1000)
        await grantLoopback(ctx.browser, originB)
        await killWallet() // a fresh process, so both origins prompt
        await startWalletToHome()
        await warmWallet()
        await front('chrome')
        pageB = await ctx.browser.newPage()
        pageA = await ctx.browser.newPage()
        await pageB.goto(`${originB}/`, { waitUntil: 'load' })
        await pageB.bringToFront()
        await sleep(500)
        await clearLog(pageB)
        await clickGesture(pageB, '#open')
        await ov.waitFor(ov.sheetResumed, { timeoutMs: 12000, what: 'the overlay sheet for origin B' })
        const oB = await overlayRaiseConnect(ctx, pageB)
        must(/localhost:3002/.test(oB.text || oB.desc), `origin B sheet shows ${oB.text}`)
        await approveSheet(ctx)
        await waitLog(pageB, /OK getPublicKey ->/, { timeoutMs: 25000, what: 'origin B connected' })
        await ov.waitFor(async () => !(await ov.sheetResumed()), {
          timeoutMs: 12000,
          what: 'the sheet to finish for B'
        })
        // origin A raises the sheet with a held request
        await pageA.bringToFront()
        await sleep(500)
        const page = await overlayHeld(ctx, { fresh: false })
        const c0 = await createCount()
        const r0 = await rootRuns()
        const aOrigin = (await uiNodes()).find(n => /bridge-connect-origin/.test(n.id))?.text ?? ''
        must(/localhost:3001/.test(aOrigin), `the first prompt is for ${aOrigin}, expected origin A`)
        // origin B's request arrives while the sheet is up (its tab is in the background)
        await startCard(pageB, SIGN_CARD)
        await sleep(2000)
        must((await createCount()) === c0 && (await rootRuns()) === r0, 'a second sheet Activity or root was created')
        must((await nodeCount('bridge-approve')) === 1, 'two bridge-approve nodes while two prompts are pending')
        await evid(ctx, 'O8-two-origins-first')
        await approveSheet(ctx) // the head: origin A
        await sleep(2500)
        const second = await uiWait('bridge-connect-origin', { timeoutMs: 25000, what: 'the second prompt' })
        const bOrigin = second.text || second.desc
        must(/localhost:3002/.test(bOrigin), `the second prompt is for ${bOrigin}, expected origin B`)
        must(
          (await ov.sheetResumed()) && (await createCount()) === c0,
          'the second prompt did not stay in the same sheet'
        )
        must((await nodeCount('bridge-approve')) === 1, 'two bridge-approve nodes at once')
        await evid(ctx, 'O8-two-origins-second')
        await approveSheet(ctx)
        await waitCard(page, SIGN_CARD, 'pass', 60000)
        await waitCard(pageB, SIGN_CARD, 'pass', 60000)
        await ov.waitFor(async () => !(await ov.sheetResumed()), { timeoutMs: 15000, what: 'the sheet to finish' })
        return `origin A's prompt, then origin B's (${bOrigin}) arriving while it was up: one sheet Activity (create n ${c0}) and one root, one bridge-approve at a time, B's prompt shown in the same root after A's; both requests passed`
      } finally {
        await pageA?.close().catch(() => {})
        await pageB?.close().catch(() => {})
        server.kill()
        await adb(['reverse', '--remove', `tcp:${portB}`]).catch(() => {})
      }
    }
  },
  {
    id: 'O9',
    name: 'dark mode while the sheet is up: re-themes without remounting',
    async run(ctx) {
      await shell('cmd uimode night no').catch(() => {})
      await sleep(800)
      const page = await overlayHeld(ctx)
      const m0 = await mountCount()
      const c0 = await createCount()
      const before = await ov.sheetPixels?.(ctx)
      await shell('cmd uimode night yes')
      await sleep(2500)
      must(await ov.sheetResumed(), 'the sheet went away when the theme changed')
      await uiWait('bridge-approve', { timeoutMs: 8000, what: 'the prompt after the theme change' })
      const m1 = await mountCount()
      const c1 = await createCount()
      const after = await ov.sheetPixels?.(ctx)
      await shell('cmd uimode night no').catch(() => {})
      await sleep(1500)
      must(m1 === m0, `the root remounted (mount n ${m0} -> ${m1})`)
      must(c1 === c0, `the Activity was recreated (create n ${c0} -> ${c1})`)
      let colour =
        'text colours could not be read (FLAG_SECURE blanks screencap); the re-theme itself is pinned by the Task 8 relay test'
      if (before && after) colour = `sheet pixel mean ${before} -> ${after}`
      await evid(ctx, 'O9-dark')
      await approveAndFinish(ctx, page).catch(e => ctx.note(`cleanup: ${e.message}`))
      return `night mode switched with the sheet and a prompt up: same Activity (create n ${c0}), no remount (mount n ${m0}), prompt still shown; ${colour}`
    }
  },
  {
    id: 'O10',
    name: 'a second launch while the sheet is up resets the root',
    async run(ctx) {
      const page = await overlayHeld(ctx)
      const lines = async re => (await ov.logLines(re)).length
      const c0 = await lines(/sheet-activity create/)
      const n0 = await lines(/newintent reset=true/)
      const m0 = await mountCount()
      await sleep(3200) // the trampoline's 3 s start throttle
      await shell(
        `am start -W -a android.intent.action.VIEW -c android.intent.category.BROWSABLE -d 'bsv-wallet-bridge://launch?v=1'`
      )
      await sleep(2500)
      const n1 = await lines(/newintent reset=true/)
      must(n1 === n0 + 1, `"newintent reset=true" lines went ${n0} -> ${n1}, expected +1`)
      const m1 = await mountCount()
      must(m1 === m0 + 1, `mount count ${m0} -> ${m1}, expected +1`)
      must((await lines(/sheet-activity create/)) === c0, 'a second Activity was created')
      must(await ov.sheetResumed(), 'the sheet is not resumed after the second launch')
      await evid(ctx, 'O10-after-second-launch')
      await shell('input keyevent KEYCODE_BACK').catch(() => {})
      await ov.waitFor(async () => !(await ov.sheetResumed()), { timeoutMs: 8000 }).catch(() => {})
      void page
      return `second SHEETLAUNCH while up: one more "newintent reset=true", mount n ${m0} -> ${m1}, no second Activity (create lines ${c0} unchanged)`
    }
  },
  {
    id: 'O11',
    name: 'later prompt with Chrome in front and the wallet backgrounded: notification only (variant 11-N)',
    async run(ctx) {
      await freshNotifications()
      await overlayEstablish(ctx)
      await front('chrome')
      const page = await pageNow(ctx)
      const c0 = await createCount()
      await startCard(page, SIGN_CARD)
      let note
      for (let i = 0; i < 16 && !note; i++) {
        await sleep(700)
        note = await attentionNotification()
        must(
          !(await ov.sheetListed()),
          'a sheet appeared by itself in the background (showSheet must not exist in 11-N)'
        )
      }
      must(note, 'no attention notification for the later prompt')
      must(note.text.includes(ATTENTION_TEXT), `notification text ${note.text}`)
      await sleep(4000)
      must(!(await ov.sheetListed()) && (await createCount()) === c0, 'a background sheet start happened')
      await evid(ctx, 'O11-notification-only')
      // answer it for the next cases
      await tapAttention()
      await uiWait('bridge-approve', { timeoutMs: 20000 })
      await approveAndFinish(ctx, page)
      return 'variant 11-N: the later prompt raised only the generic attention notification; no sheet Activity was listed or created while Chrome stayed in front'
    }
  },
  {
    id: 'O12',
    name: 'leak: 10 open and Back cycles, Activities count stable',
    async run(ctx) {
      const readActivities = async () => {
        for (const level of ['MODERATE', 'BACKGROUND', 'COMPLETE']) {
          await shell(`am send-trim-memory ${APP} ${level}`).catch(() => {})
          await sleep(600)
        }
        const vals = []
        for (let i = 0; i < 3; i++) {
          const m = /Activities:\s*(\d+)/.exec(await shell(`dumpsys meminfo ${APP}`, { timeout: 30000 }))
          vals.push(m ? Number(m[1]) : -1)
          await sleep(3000)
        }
        return vals
      }
      await warmWallet()
      const base = await readActivities()
      const c0 = await createCount()
      for (let i = 0; i < 10; i++) {
        await front('chrome')
        await shell(
          `am start -W -a android.intent.action.VIEW -c android.intent.category.BROWSABLE -d 'bsv-wallet-bridge://launch?v=1'`
        )
        await ov.waitFor(ov.sheetResumed, { timeoutMs: 10000, what: `sheet ${i + 1}` })
        await shell('input keyevent KEYCODE_BACK')
        await ov.waitFor(async () => !(await ov.sheetResumed()), { timeoutMs: 8000, what: `Back ${i + 1}` })
        await sleep(3200) // the trampoline's start throttle
      }
      const c1 = await createCount()
      await front('wallet')
      await sleep(1500)
      await front('chrome')
      const after = await readActivities()
      fs.writeFileSync(
        path.join(ctx.shots, 'O12-meminfo.txt'),
        `baseline Activities: ${base.join(',')}\ncreates ${c0} -> ${c1}\nafter 10 cycles + a MainActivity resume: ${after.join(',')}\n`
      )
      must(c1 - c0 === 10, `${c1 - c0} sheet Activities created in 10 cycles`)
      must(new Set(after).size === 1, `Activities readings are not equal: ${after.join(',')}`)
      must(after[0] <= base[0], `Activities grew: ${base.join(',')} -> ${after.join(',')}`)
      return `10 sheet create/Back cycles: Activities ${base.join(',')} before, ${after.join(',')} after (forced trim, three equal readings)`
    }
  },
  {
    id: 'O13',
    name: 'plaintext check in logcat over the overlay run, M2 log lines are counts only',
    async run(ctx) {
      const m1 = await CASES.find(c => c.id === 14).run(ctx)
      const lines = (await shell('logcat -d')).split('\n')
      const sheetLines = lines.filter(l => /BsvBridgeSheet/.test(l))
      const shaped =
        /sheet-activity create n=\d+ seq=(\d+|none)\s*$|sheet-activity newintent reset=(true|false)\s*$|sheet-root mount n=\d+\s*$/
      const bad = sheetLines.filter(l => !shaped.test(l))
      fs.writeFileSync(path.join(ctx.shots, 'O13-sheet-log-lines.txt'), sheetLines.join('\n') + '\n')
      must(
        bad.length === 0,
        `${bad.length} BsvBridgeSheet lines carry more than counts: ${bad.slice(0, 2).join(' | ')}`
      )
      return `${m1}; ${sheetLines.length} BsvBridgeSheet lines, all counts only (create n/seq, newintent reset, mount n)`
    }
  },
  {
    id: 'O14',
    name: 'M1 regression: cases 1 to 5, 7, 15, 16, 17 in foreground mode with overlay available',
    async run(ctx) {
      const results = []
      for (const id of [1, 2, 3, 4, 5, 7, 15, 16, 17]) {
        const c = CASES.find(k => k.id === id)
        const c0 = await createCount()
        const note = await c.run(ctx)
        const c1 = await createCount()
        // cases 3, 15 and 16 legitimately open the sheet from a notification tap with the wallet warm (O16); the others
        // never raise an overlay (cold launches and the wallet in front)
        if (![3, 15, 16].includes(id))
          must(c1 === c0, `M1 case ${id} raised an overlay sheet (create n ${c0} -> ${c1})`)
        results.push(`M1 ${id} ok${c1 === c0 ? '' : ' (overlay from a notification tap)'}`)
        void note
      }
      return results.join(', ')
    }
  },
  {
    id: 'O15',
    name: 'idle sheet: nothing pending, window non-touchable, finishes by itself',
    async run(ctx) {
      await warmWallet()
      const page = await freshPage(ctx)
      await page.evaluate(() => {
        window.__taps = 0
        window.addEventListener('pointerdown', () => (window.__taps += 1), true)
      })
      await shell(
        `am start -W -a android.intent.action.VIEW -c android.intent.category.BROWSABLE -d 'bsv-wallet-bridge://launch?v=1'`
      )
      await ov.waitFor(ov.sheetResumed, { timeoutMs: 10000, what: 'the idle sheet' })
      const t0 = Date.now()
      const flags = (await ov.sheetWindowFlags()) ?? ''
      must(/NOT_TOUCHABLE/.test(flags), `FLAG_NOT_TOUCHABLE missing on the idle sheet window: ${flags}`)
      must(/SECURE/.test(flags), `FLAG_SECURE missing: ${flags}`)
      must((await nodeCount('bridge-approve')) === 0, 'an Approve button exists although nothing is pending')
      must(await uiHas('bridge-sheet-root'), 'no bridge-sheet-root')
      await evid(ctx, 'O15-idle', `window flags: ${flags}`)
      // S3 row (i): a translucent Activity above another app's Activity swallows touches whatever its flags, so a tap
      // does not reach Chrome; recorded, not asserted (the idle bound is the protection).
      await shell('input tap 540 900')
      await sleep(600)
      const taps = await page.evaluate(() => window.__taps).catch(() => -1)
      await ov.waitFor(async () => !(await ov.sheetResumed()), {
        timeoutMs: 9000,
        pollMs: 250,
        what: 'the idle sheet to finish'
      })
      const ms = Date.now() - t0
      await lowBackToChrome()
      must(ms <= 5000 + 2000 + 600, `the idle sheet took ${ms} ms to finish (bound 5000 + 2000)`)
      fs.writeFileSync(
        path.join(ctx.shots, 'O15-idle-notes.txt'),
        `window flags: ${flags}\nfinished ${ms} ms after it was first seen resumed (poll granularity about 0.5 s)\ntap at (540,900) while up: Chrome saw ${taps} pointerdown(s) (0 = swallowed by the system input sink, S3 row (i))\n`
      )
      return `idle sheet: NOT_TOUCHABLE and SECURE on its window, no Approve node; finished by itself ${ms} ms after it was seen, Chrome top resumed; a tap while up reached Chrome ${taps} time(s) (S3 row (i): swallowed by the system). The real loopback dialog of a non-exempt origin is owner gate 9`
    }
  },
  {
    id: 'O16',
    name: 'notification tap: overlay when warm and main not resumed, wallet when cold',
    async run(ctx) {
      await freshNotifications()
      await overlayEstablish(ctx)
      await front('chrome')
      const page = await pageNow(ctx)
      await startCard(page, SIGN_CARD)
      let note
      for (let i = 0; i < 16 && !note; i++) {
        await sleep(700)
        note = await attentionNotification()
      }
      must(note, 'no attention notification')
      // (a) warm and main not resumed: the sheet over the current app
      const c0 = await createCount()
      await tapAttention()
      await uiWait('bridge-approve', { timeoutMs: 20000, what: 'the sheet after the notification tap (warm)' })
      must(await ov.sheetResumed(), 'warm notification tap: the sheet Activity is not resumed')
      must((await createCount()) === c0 + 1, 'warm notification tap: no sheet Activity was created')
      await evid(ctx, 'O16-warm-tap')
      await approveAndFinish(ctx, page)
      // (b) cold: the same notification with the process dead goes to the wallet, with no React root for the sheet
      await overlayEstablish(ctx)
      await front('chrome')
      const page2 = await pageNow(ctx)
      await startCard(page2, SIGN_CARD)
      note = undefined
      for (let i = 0; i < 16 && !note; i++) {
        await sleep(700)
        note = await attentionNotification()
      }
      must(note, 'no attention notification for the cold variant')
      await shell(`run-as ${APP} kill -9 $(pidof ${APP})`).catch(() => killWallet())
      await sleep(1500)
      must(!(await walletPid()), 'the wallet process survived the kill')
      const still = await attentionNotification()
      let coldNote
      if (!still) {
        coldNote =
          'the notification did not survive the process kill on this AVD (nothing to tap); the pure SheetPolicyTest rows cover the cold choice'
        ctx.gate(`O16 cold: ${coldNote}`)
      } else {
        await shell('logcat -c')
        await tapAttention()
        await sleep(5000)
        const lines = await ov.logLines(/sheet-activity create/)
        must(lines.length === 0, 'cold notification tap created a sheet root')
        must(!(await ov.sheetResumed()), 'cold notification tap resumed a sheet')
        await ov.waitFor(async () => /MainActivity/.test((await ov.topResumed()) ?? ''), {
          timeoutMs: 60000,
          what: 'the wallet to come forward (cold)'
        })
        must(!(await ov.sheetListed()), 'the sheet Activity is still listed after the cold tap')
        await evid(ctx, 'O16-cold-tap')
        coldNote =
          'cold tap: MainActivity in front, the sheet Activity not listed and no sheet root created (no "sheet-activity create" line)'
      }
      return `warm tap: the sheet over Chrome with the pending prompt (create n ${c0} -> ${c0 + 1}), Approve answered it; ${coldNote}`
    }
  },
  {
    id: 'O17',
    name: 'fail-closed after the sheet finishes: no crash from currentActivity readers',
    async run(ctx) {
      await shell('logcat -c')
      const page = await overlayHeld(ctx)
      await approveAndFinish(ctx, page) // Approve runs haptics and the signing read while the sheet is current
      // Chrome is in front and the finished sheet is still the stale currentActivity until MainActivity resumes
      await clearLog(page)
      await pageClick(page, '#getPublicKey') // a secure-store read with nothing in front
      const k = await waitLog(page, /(OK|ERR) getPublicKey ->[^\n]*/, {
        timeoutMs: 25000,
        what: 'getPublicKey with the finished sheet'
      }).catch(e => String(e.message))
      await startCard(page, SIGN_CARD) // a prompt raises the attention notification path
      await sleep(5000)
      const log = await shell('logcat -d')
      const bad = log
        .split('\n')
        .filter(
          l =>
            /FATAL EXCEPTION|IllegalStateException|Activity .* has been destroyed|SuperNotCalledException|WindowLeaked/.test(
              l
            ) && !/monkey/.test(l)
        )
      fs.writeFileSync(path.join(ctx.shots, 'O17-bad-lines.txt'), bad.join('\n') + '\n')
      must(bad.length === 0, `${bad.length} crash-like lines after the sheet finished: ${bad[0]}`)
      ctx.gate(
        'O17: the biometric prompt (expo-local-authentication, expo-secure-store AuthenticationHelper) and the YubiKey NFC reader cannot be reached on the throwaway test wallet (no biometric, no key), so they are recorded as a deviation (no instrumented test) and covered by owner gate 1'
      )
      return `reachable readers exercised after the sheet finished (Approve while it was current, then getPublicKey and a new prompt with Chrome in front: ${String(k).slice(0, 60)}): no FATAL EXCEPTION, IllegalStateException or destroyed-Activity line in logcat; biometric and NFC readers not reachable here (SPIKES deviation, gate 1)`
    }
  },
  {
    id: 'O18',
    name: 'process recreation with the sheet up: a restored sheet finishes at once and arms nothing',
    async run(ctx) {
      await overlayHeld(ctx)
      const listeningBridge = async () => {
        const tcp = await shell('cat /proc/net/tcp /proc/net/tcp6')
        return tcp.split('\n').filter(l => /:0CF[9A-F] /i.test(l) && /\s0A\s/.test(l)).length
      }
      await shell('logcat -c')
      await shell(`am crash ${APP}`)
      await sleep(1500)
      const t0 = Date.now()
      let resumedAgain = false
      let sawCreate = false
      while (Date.now() - t0 < 6000) {
        if (await ov.sheetResumed()) resumedAgain = true
        await sleep(500)
      }
      const create = await ov.logLines(/sheet-activity create/)
      sawCreate = create.length > 0
      const listeners = await listeningBridge()
      const store = await ov.logLines(/LaunchStore/)
      await evid(
        ctx,
        'O18-after-crash',
        `sheet resumed again within 6 s: ${resumedAgain}; "sheet-activity create" lines: ${create.length}; bridge-port listeners: ${listeners}; LaunchStore lines: ${store.length}`
      )
      must(listeners === 0, `${listeners} sockets listen on the bridge ports after the crash`)
      must(store.length === 0, `${store.length} LaunchStore lines in logcat`)
      if (!(await walletPid()) && !resumedAgain && !sawCreate) {
        return 'am crash with the sheet up: Android did not restore the task (no sheet resumed, no process, no listener, no LaunchStore line); n/a for the restored-state branch, which SheetPolicyTest `restored state is FINISH` and owner gate 1 cover'
      }
      must(!resumedAgain, 'a sheet was resumed after the crash (a restored sheet must finish at once)')
      return `am crash with the sheet up: no sheet resumed within 6 s (process ${(await walletPid()) ? 'restarted' : 'gone'}), no listener on the bridge ports, no LaunchStore line`
    }
  },
  {
    id: 'O19',
    name: 'Back right after the last Approve: no ERR_NO_ACTIVITY, Chrome in front, no crash',
    async run(ctx) {
      const page = await overlayHeld(ctx)
      const pid0 = await walletPid()
      await shell('logcat -c')
      const n = await uiWait('bridge-approve', { timeoutMs: 10000 })
      await tapXY(center(n))
      await sleep(250)
      await shell('input keyevent KEYCODE_BACK')
      await sleep(1000)
      await waitCard(page, SIGN_CARD, 'pass', 30000).catch(() => {})
      const log = await shell('logcat -d')
      const bad = log.split('\n').filter(l => /ERR_NO_ACTIVITY|FATAL EXCEPTION/.test(l) && !/monkey/.test(l))
      await lowBackToChrome()
      must(bad.length === 0, `${bad.length} ERR_NO_ACTIVITY or FATAL lines: ${bad[0]}`)
      must((await walletPid()) === pid0, 'the wallet process changed (a crash)')
      await evid(ctx, 'O19-after-back-race')
      return `Back 250 ms after the last Approve: no ERR_NO_ACTIVITY and no FATAL EXCEPTION in logcat, the wallet process (pid ${pid0}) survived, Chrome is top resumed`
    }
  },
  {
    id: 'O20',
    name: 'non-English locale: the sheet shows Spanish copy',
    async run(ctx) {
      let spanish
      let english
      try {
        const shown = async () => {
          const page = await overlayOpen(ctx)
          await overlayRaiseConnect(ctx, page)
          const texts = (await uiNodes()).map(n => n.text || n.desc).filter(Boolean)
          await evid(ctx, 'O20-' + (spanish ? 'es' : 'en'))
          await approveSheet(ctx, { id: 'bridge-deny', fallback: DENY_XY })
          await ov.waitFor(async () => !(await ov.sheetResumed()), { timeoutMs: 10000 }).catch(() => {})
          return texts
        }
        english = await shown()
        await ov.setLanguage('es')
        await killWallet()
        await startWalletToHome()
        spanish = [] // marks the evidence name
        const es = await shown()
        spanish = es
        must(
          es.some(t => /^Conectar$/i.test(t)),
          `no "Conectar" in the Spanish sheet: ${es.slice(0, 12).join(' | ')}`
        )
        must(!es.some(t => /^Connect$/.test(t)), 'the English "Connect" is still on the Spanish sheet')
        must(
          english.some(t => /^Connect$/.test(t)),
          `the English control run has no "Connect": ${english.slice(0, 12).join(' | ')}`
        )
      } finally {
        await ov.clearLanguage()
        await killWallet()
        await startWalletToHome().catch(() => {})
      }
      return 'with the app locale es the overlay sheet shows "Conectar" (and not "Connect"); the English control run showed "Connect". Colours from the relay: see O9 (pixels are blank under FLAG_SECURE)'
    }
  },
  {
    id: 'O21',
    name: 'a tap outside the sheet does nothing',
    async run(ctx) {
      const page = await overlayHeld(ctx)
      await sleep(600)
      await tapXY({ x: 540, y: 300 }) // on the scrim, far above the sheet
      await sleep(1200)
      must(await ov.sheetResumed(), 'the sheet finished after a tap on the scrim')
      must(await uiHas('bridge-approve'), 'the prompt vanished after a tap on the scrim')
      must((await cardStatus(page, SIGN_CARD)) === 'running', 'the prompt was answered by a tap on the scrim')
      await evid(ctx, 'O21-after-scrim-tap')
      await approveAndFinish(ctx, page)
      return 'a tap at (540,300) on the scrim: the sheet stayed, the prompt stayed and was not answered (card running), Approve then answered it'
    }
  }
]

// A failed overlay case must not leave a pending request or a sheet behind for the next one: the next open starts from a
// fresh wallet process, and a sheet still up is closed with Back.
for (const c of OVERLAY_CASES) {
  const run = c.run
  c.run = async ctx => {
    try {
      return await run(ctx)
    } catch (e) {
      opensSinceStart = 99
      if (await ov.sheetResumed().catch(() => false)) await shell('input keyevent KEYCODE_BACK').catch(() => {})
      throw e
    }
  }
}
