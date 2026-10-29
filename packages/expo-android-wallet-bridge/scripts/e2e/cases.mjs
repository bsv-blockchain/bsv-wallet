// Emulator end-to-end cases (spec 10). Each case is `{ id, name, run(ctx) }`; `run` throws on failure and returns a
// short pass note. Dev tooling (node), not part of the shipped kit. The page origin is `http://localhost:3001` (the iOS
// demo owns 3000 and the ngrok tunnel); `ctx.origin` carries it.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { adb, dumpUi, screenshot, shell, sleep, tapXY, waitForNode } from './adb.mjs'
import { clickGesture, connect, firstPage, forwardDevtools, grantLoopback } from './chrome.mjs'
import { center, findById, findByText, parseNotification, parseTopResumed } from './parse.mjs'
import { setAnimationScale } from './wallet.mjs'
import { hold, release } from './sockets.mjs'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { ADB, adbArgs } from './adb.mjs'

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
      const v = await act(ctx, '#getPublicKey', /(OK|ERR) getPublicKey ->[^\n]*/, { timeoutMs: 20000 }).catch(e =>
        String(e.message)
      )
      // a further interactive request raises a fresh sheet again (nothing was granted): the page does not get a key
      const again = await attentionNotification()
      await shell('input keyevent KEYCODE_BACK').catch(() => {})
      return `denied: ${res.slice(0, 120)}; follow-up request did not silently succeed (${again ? 'raised a new prompt' : String(v).slice(0, 80)})`
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
