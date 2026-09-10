// review1-diff.mjs — independent byte-exact + chunk-exact diff of buildLock(fixture Q, 4600) against the fixture,
// oracle sanity (fixture unlock validates against both; wrong amount fails), and a scan of literal-hex tokens in gen.mjs.
import fs from 'fs'
import { LockingScript, Transaction, Spend, Hash, Utils } from '@bsv/sdk'
import { buildLock } from './gen.mjs'
const REPO = '/Users/personal/git/bsv-wallet'
const FIX_LOCK = REPO + '/docs/example-txs/51c53430fe63108a2a1ddd231253df069fb424cc6f1bb0ee60b4b07792d3579a_0.hex'
const FIX_TX = REPO + '/docs/example-txs/476611a431172df767a73349522536fa78d63a83b560efbb695b853bf60b4b80.hex'
const fixHex = fs.readFileSync(FIX_LOCK, 'utf8').trim()
const t0 = Date.now()
const lock = buildLock({ qCompressedHex: '03f4d667712d8825372cd616b0b1b1a818e5eeb3681dd45c5bdd59fed9f21d5a7d', satoshis: 4600 })
const dt = Date.now() - t0
const genHex = lock.toHex()
const a = Buffer.from(genHex, 'hex'), b = Buffer.from(fixHex, 'hex')
let nd = 0, first = -1
for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) { nd++; if (first < 0) first = i }
console.log(`gen ${a.length} B, fixture ${b.length} B, differing bytes ${nd}, first diff ${first}, gen time ${dt} ms`)
console.log('sha256 gen    ', Utils.toHex(Hash.sha256([...a])))
console.log('sha256 fixture', Utils.toHex(Hash.sha256([...b])))
const fix = LockingScript.fromHex(fixHex)
let cd = 0
for (let i = 0; i < Math.max(lock.chunks.length, fix.chunks.length); i++) {
  const x = lock.chunks[i], y = fix.chunks[i]
  if (!x || !y || x.op !== y.op || Utils.toHex(x.data ?? []) !== Utils.toHex(y.data ?? [])) cd++
}
console.log(`chunks gen ${lock.chunks.length}, fixture ${fix.chunks.length}, differing chunks ${cd}`)
const tx = Transaction.fromHex(fs.readFileSync(FIX_TX, 'utf8').trim())
const mk = (L, sats) => new Spend({ sourceTXID: tx.inputs[0].sourceTXID, sourceOutputIndex: tx.inputs[0].sourceOutputIndex, sourceSatoshis: sats, lockingScript: L, transactionVersion: tx.version, otherInputs: [], outputs: tx.outputs, unlockingScript: tx.inputs[0].unlockingScript, inputSequence: tx.inputs[0].sequence, inputIndex: 0, lockTime: tx.lockTime })
for (const [label, L, sats] of [['fixture lock, 4600', fix, 4600], ['generated lock, 4600', lock, 4600], ['generated lock, sourceSatoshis 4601 (must FAIL)', lock, 4601]]) {
  const sp = mk(L, sats); let ok, err
  try { ok = sp.validate() } catch (e) { ok = false; err = e.message.split('\n')[0] }
  console.log(`validate(fixture unlock, ${label}) = ${ok} pc=${sp.programCounter}${err ? ' :: ' + err : ''}`)
}
console.log('unlock pushes:', tx.inputs[0].unlockingScript.chunks.map(c => (c.data ?? []).length + 'B').join(' '), 'tx.version', tx.version, 'seq', tx.inputs[0].sequence.toString(16), 'lockTime', tx.lockTime)
const src = fs.readFileSync('./gen.mjs', 'utf8')
console.log('literal <hex> tokens in gen.mjs asm:', [...new Set([...src.matchAll(/<([0-9a-f]+)>/g)].map(m => m[1]))])
const longHex = [...src.matchAll(/[0-9a-f]{16,}/g)].map(m => m[0])
console.log('hex strings >= 16 chars anywhere in gen.mjs:', longHex)
