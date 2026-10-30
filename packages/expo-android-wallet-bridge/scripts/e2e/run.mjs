#!/usr/bin/env node
// Emulator end-to-end runner (plan Task 24). Preconditions (EMU start, install of the host debug build, Metro on 8082,
// `node demo/serve.mjs 3001`, `adb reverse` for 3001 and 8082, a test wallet) are listed in SPIKES.md.
//   node run.mjs [--only 1,4,15 | --only O1,O2 | --only overlay] [--origin http://localhost:3001] [--out <evidence dir>] [--keep-chrome]
//                [--allow-nested-metro]
// Metro's project root (8082) must be flat: no node_modules in any ancestor directory (see metro.mjs); the run stops otherwise.
// Overlay cases (M2, `O<n>`) write to <evidence dir>/overlay and never clear the M1 evidence; `--only overlay` runs all of them in
// order after clearing that subdirectory and the logcat buffer (O13 reads the whole buffer).
// Each case writes screenshots to the evidence directory; a result table goes to results.json and stdout. Exit code 1
// when a case failed.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromeVersion, clearLogcat, reverse, setSerial } from './adb.mjs'
import { setupChrome } from './chrome.mjs'
import { attach, CASES, OVERLAY_CASES } from './cases.mjs'
import { checkMetroRoot } from './metro.mjs'
import { release } from './sockets.mjs'

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`)
  return i > 0 ? process.argv[i + 1] : d
}
const here = path.dirname(fileURLToPath(import.meta.url))
const evidence = arg('out', path.resolve(here, '../../../../docs/superpowers/evidence/android-kit'))
const onlyArg = arg('only')
const allOverlay = onlyArg === 'overlay'
const only = allOverlay ? undefined : onlyArg?.split(',').map(x => (/^\d+$/.test(x) ? Number(x) : x))
const overlayRun = allOverlay || Boolean(only?.some(x => typeof x === 'string'))
const out = overlayRun ? path.join(evidence, 'overlay') : evidence
const cases = overlayRun ? OVERLAY_CASES : CASES
const origin = arg('origin', 'http://localhost:3001')
fs.mkdirSync(out, { recursive: true })

const results = []
const gates = []
const ctx = { origin, shots: out, note: m => console.log(`  note: ${m}`), gate: m => gates.push(m) }

async function main() {
  setSerial(arg('serial', 'emulator-5554'))
  await reverse(Number(new URL(origin).port))
  await reverse(8082)
  console.log(await checkMetroRoot(8082, { allow: process.argv.includes('--allow-nested-metro') }))
  ctx.chrome = await chromeVersion()
  console.log(`Chrome ${ctx.chrome}, origin ${origin}`)
  if (!arg('keep-chrome')) await setupChrome()
  if (!only) {
    // A full run is the evidence: start from an empty directory and an empty logcat buffer (case 14 and O13 read it whole).
    // The M1 run keeps the overlay subdirectory (its own evidence).
    for (const f of fs.readdirSync(out))
      if (overlayRun || f !== 'overlay') fs.rmSync(path.join(out, f), { recursive: true, force: true })
    await clearLogcat()
  }
  await attach(ctx)
  for (const c of cases) {
    if (only && !only.includes(c.id)) continue
    const t0 = Date.now()
    let r
    ctx.resultExtra = undefined
    try {
      const note = await c.run(ctx)
      // a case may downgrade its own pass (status 'partial') and attach structured fields via ctx.resultExtra
      r = { id: c.id, name: c.name, status: 'pass', ...ctx.resultExtra, note, ms: Date.now() - t0 }
    } catch (e) {
      const note = String(e.message ?? e).slice(0, 400)
      r = {
        id: c.id,
        name: c.name,
        status: note.startsWith('device gate:') ? 'gate' : 'fail',
        note,
        ms: Date.now() - t0
      }
    }
    await release().catch(() => {})
    results.push(r)
    console.log(`case ${r.id} ${r.status.toUpperCase()} (${r.name}) ${(r.ms / 1000).toFixed(0)}s: ${r.note}`)
  }
  await ctx.browser?.disconnect().catch(() => {})
}

main()
  .catch(e => {
    console.error(e)
    results.push({ id: 0, name: 'harness', status: 'fail', note: String(e.message ?? e) })
  })
  .finally(() => {
    const file = path.join(out, only ? `results-${only.join('-')}.json` : 'results.json')
    fs.writeFileSync(
      file,
      JSON.stringify({ chrome: ctx.chrome, origin, at: new Date().toISOString(), results, gates }, null, 2)
    )
    process.exit(results.some(r => r.status === 'fail') ? 1 : 0)
  })
