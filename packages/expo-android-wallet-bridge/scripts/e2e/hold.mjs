#!/usr/bin/env node
// S5 background hold. Precondition: the page at --origin has an approved connection (open, connect and the wallet's
// Connect tap are the driver's job). This script clicks the conformance card that asks for a permission sheet
// (default `conformanceCreateSignature`: an unfunded test wallet answers createAction with an error before any sheet),
// leaves the request unanswered at the sheet with Chrome in front, optionally switches the screen off and forces Doze,
// then polls every 30 s for the card status and the wallet process. Writes a JSON log and exits non-zero on failure.
//   node hold.mjs --minutes 30 [--origin http://localhost:3001] [--card conformanceCreateSignature]
//                 [--screen-off] [--out hold-log.json]
// The request is left pending: the caller answers it (tap the attention notification, Approve) and checks that the
// page's card completes.
import fs from 'node:fs'
import puppeteer from 'puppeteer-core'
import { forwardDevtools } from './chrome.mjs'
import { shell, sleep } from './adb.mjs'

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : def
}
const minutes = Number(arg('minutes', '10'))
const origin = arg('origin', 'http://localhost:3001')
const card = arg('card', 'conformanceCreateSignature')
const screenOff = process.argv.includes('--screen-off')
const out = arg('out', 'hold-log.json')
const log = { origin, card, minutes, screenOff, startedAt: new Date().toISOString(), samples: [], result: 'running' }
const save = () => fs.writeFileSync(out, JSON.stringify(log, null, 2))

const appAlive = async () => (await shell('pidof org.bsvblockchain.wallet').catch(() => '')).length > 0
const withTimeout = (p, ms) => Promise.race([p, sleep(ms).then(() => undefined)])

async function main() {
  await forwardDevtools()
  const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null })
  await shell('am start -n com.android.chrome/com.google.android.apps.chrome.Main')
  await sleep(1500)
  let page
  for (const p of await browser.pages()) {
    if (
      p.url().startsWith(origin) &&
      (await p.evaluate(() => document.visibilityState === 'visible').catch(() => false))
    )
      page = page ?? p
  }
  if (!page) throw new Error(`no visible page at ${origin}`)
  const cardText = () => page.evaluate(c => document.querySelector(`[data-card="${c}"]`)?.textContent ?? '', card)
  await page.evaluate(c => document.querySelector(`[data-card="${c}"] button`).click(), card)
  log.sentAt = new Date().toISOString()
  await sleep(1500)
  log.statusAfterSend = await withTimeout(cardText(), 5000)
  if (screenOff) {
    await shell('input keyevent KEYCODE_SLEEP')
    await shell('dumpsys deviceidle force-idle').catch(e => {
      log.forceIdleError = String(e.message).slice(0, 200)
    })
    log.deviceIdle = await shell('dumpsys deviceidle get deep').catch(() => 'unknown')
  }
  const end = Date.now() + minutes * 60000
  let failed
  while (Date.now() < end) {
    await sleep(30000)
    const alive = await appAlive()
    // The page is frozen while Chrome is in the background with the screen off: a missing answer is not a failure.
    const status = await withTimeout(cardText(), 5000)
    log.samples.push({ at: new Date().toISOString(), appAlive: alive, card: status ?? 'page-unreachable' })
    save()
    if (!alive) {
      failed = 'wallet process died'
      break
    }
    if (status && !/running/.test(status)) {
      log.answeredEarlyAt = new Date().toISOString()
      failed = `request answered before the hold ended: ${status}`
      break
    }
  }
  if (screenOff) {
    await shell('dumpsys deviceidle unforce').catch(() => {})
    await shell('input keyevent KEYCODE_WAKEUP')
    await shell('wm dismiss-keyguard').catch(() => {})
  }
  log.result = failed ? `fail: ${failed}` : 'held'
  await browser.disconnect()
}

main()
  .catch(e => {
    log.result = `fail: ${e.message}`
  })
  .finally(() => {
    log.finishedAt = new Date().toISOString()
    save()
    process.exit(log.result.startsWith('fail') ? 1 : 0)
  })
