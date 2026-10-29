#!/usr/bin/env node
// Emulator end-to-end runner (plan Task 24). Preconditions (EMU start, install of the host debug build, Metro on 8082,
// `node demo/serve.mjs 3001`, `adb reverse` for 3001 and 8082, a test wallet) are listed in SPIKES.md.
//   node run.mjs [--only 1,4,15] [--origin http://localhost:3001] [--out <evidence dir>]
// Each case writes screenshots to the evidence directory; a result table goes to results.json and stdout. Exit code 1
// when a case failed.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromeVersion, clearLogcat, reverse, setSerial } from './adb.mjs'
import { setupChrome } from './chrome.mjs'
import { attach, CASES } from './cases.mjs'
import { release } from './sockets.mjs'

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`)
  return i > 0 ? process.argv[i + 1] : d
}
const here = path.dirname(fileURLToPath(import.meta.url))
const out = arg('out', path.resolve(here, '../../../../docs/superpowers/evidence/android-kit'))
const only = arg('only')?.split(',').map(Number)
const origin = arg('origin', 'http://localhost:3001')
fs.mkdirSync(out, { recursive: true })

const results = []
const gates = []
const ctx = { origin, shots: out, note: m => console.log(`  note: ${m}`), gate: m => gates.push(m) }

async function main() {
  setSerial(arg('serial', 'emulator-5554'))
  await reverse(Number(new URL(origin).port))
  await reverse(8082)
  ctx.chrome = await chromeVersion()
  console.log(`Chrome ${ctx.chrome}, origin ${origin}`)
  if (!arg('keep-chrome')) await setupChrome()
  if (!only) {
    // A full run is the evidence: start from an empty directory and an empty logcat buffer (case 14 reads it whole).
    for (const f of fs.readdirSync(out)) fs.rmSync(path.join(out, f), { recursive: true, force: true })
    await clearLogcat()
  }
  await attach(ctx)
  for (const c of CASES) {
    if (only && !only.includes(c.id)) continue
    const t0 = Date.now()
    let r
    try {
      const note = await c.run(ctx)
      r = { id: c.id, name: c.name, status: 'pass', note, ms: Date.now() - t0 }
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
