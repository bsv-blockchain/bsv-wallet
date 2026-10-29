#!/usr/bin/env node
// S5 background hold: connect through Chrome, send createAction, leave it at the approval sheet and poll every 30 s
// for the response and for the wallet process. Writes a JSON log; exits non-zero on failure.
//   node hold.mjs --minutes 12 [--origin http://localhost:3000] [--out hold-log.json]
import fs from 'node:fs'
import { clickGesture, connect, firstPage, forwardDevtools, grantLoopback } from './chrome.mjs'
import { shell, sleep } from './adb.mjs'

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : def
}
const minutes = Number(arg('minutes', '10'))
const origin = arg('origin', 'http://localhost:3000')
const out = arg('out', 'hold-log.json')
const log = { origin, minutes, startedAt: new Date().toISOString(), samples: [], result: 'running' }
const save = () => fs.writeFileSync(out, JSON.stringify(log, null, 2))

const appAlive = async () => (await shell('pidof org.bsvblockchain.wallet').catch(() => '')).length > 0

async function main() {
  await forwardDevtools()
  const browser = await connect()
  const page = await firstPage(browser)
  await page.goto(origin, { waitUntil: 'domcontentloaded' })
  log.permission = await grantLoopback(browser, origin)
  await page.waitForSelector('#connect')
  await clickGesture(page, '#connect')
  await page.waitForFunction(() => /connected|ok/i.test(document.getElementById('log')?.textContent || ''), {
    timeout: 60000
  })
  const before = (await page.$eval('#log', e => e.textContent)).length
  await clickGesture(page, '#createAction')
  log.sentAt = new Date().toISOString()
  const end = Date.now() + minutes * 60000
  let failed
  while (Date.now() < end) {
    await sleep(30000)
    const text = await page.$eval('#log', e => e.textContent).catch(() => '')
    const alive = await appAlive()
    log.samples.push({ at: new Date().toISOString(), appAlive: alive, logGrew: text.length > before })
    save()
    if (!alive) {
      failed = 'wallet process died'
      break
    }
    if (
      text.length > before &&
      /createAction/.test(text.slice(before)) &&
      /(error|rejected|denied|ok)/i.test(text.slice(before))
    ) {
      log.responseAt = new Date().toISOString()
      break
    }
  }
  log.result = failed ? `fail: ${failed}` : log.responseAt ? 'response-received' : 'held-no-response'
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
