// layout2-probe.mjs — dump the gen2 header chunk listing with byte offsets, and VERIFY (by stepping the SDK interpreter)
// the stack/altstack layout at comb-loop entry and at the tail's r-check, for N=1 and N=5.
import { Spend, Transaction, OP, Utils, P2PKH, PrivateKey, MerklePath, Script, Hash } from '@bsv/sdk'
import { p256 } from '@noble/curves/nist.js'
import { buildLock2, commitmentFor, layout2, scriptNum, combTable, recode, P256_P, P256_N } from './gen2.mjs'
import { buildUnlock2, decodeUnlock2 } from './unlock2.mjs'
import { sighashPreimage } from './unlock.mjs'

const hex = a => Buffer.from(a).toString('hex')
const chunkLen = k => 1 + (k.data ? (k.op <= 75 ? k.data.length : k.op === 76 ? 1 + k.data.length : k.op === 77 ? 2 + k.data.length : 4 + k.data.length) : 0)
function listing (lock, from, to) {
  let off = 0; const rows = []
  lock.chunks.forEach((k, i) => { if (i >= from && i <= to) rows.push(`${String(i).padStart(5)} @${String(off).padStart(5)} ${k.data ? '<' + (k.data.length > 12 ? hex(k.data).slice(0, 16) + '..len' + k.data.length : hex(k.data)) + '>' : OP[k.op]}`); off += chunkLen(k) })
  return rows.join('\n')
}
const randSalt = () => Uint8Array.from(Array.from({ length: 32 }, () => Math.floor(Math.random() * 256)))
let fails = 0
const check = (n, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${d ? ' :: ' + d : ''}`); if (!ok) fails++ }

for (const N of [1, 5]) {
  const members = [...Array(N)].map(() => { const priv = p256.utils.randomSecretKey(); return { priv, q: hex(p256.getPublicKey(priv, true)), salt: randSalt() } })
  const lock = buildLock2({ commitments: members.map(m => commitmentFor({ qCompressedHex: m.q, salt: m.salt })) })
  const L = layout2(lock)
  console.log(`\n===== N=${N}: ${L.totalBytes} bytes / ${L.totalChunks} chunks =====`)
  for (const r of L.regions) console.log(`  ${r.name.padEnd(48)} chunks ${String(r.chunks[0]).padStart(5)}..${String(r.chunks[1]).padStart(5)}  bytes ${String(r.bytes[0]).padStart(5)}..${String(r.bytes[1]).padStart(5)}  (${r.size} B)`)
  const h160 = lock.chunks.findIndex(k => k.op === OP.OP_HASH160)
  console.log('--- header listing (chunks 0..80) ---\n' + listing(lock, 0, 80))
  console.log(`--- ... chunks ${h160 - 12}..${L.regions[7].chunks[0] + 9} (end of concat, HASH160, compare chain, start of G table, preloop, loop start) ---\n` + listing(lock, h160 - 12, L.regions[9].chunks[0] + 3))
  // spend
  const sats = 12345, m = members[N - 1]
  const src = new Transaction(); src.addOutput({ satoshis: sats, lockingScript: lock }); src.merklePath = MerklePath.fromCoinbaseTxidAndHeight(src.id('hex'), 1755177)
  let tx, unlock
  for (let o = sats - 300; ; o--) {
    tx = new Transaction(1, [], [], 0); tx.addInput({ sourceTransaction: src, sourceOutputIndex: 0, sequence: 0xffffffff }); tx.addOutput({ satoshis: o, lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()) })
    try { unlock = buildUnlock2({ tx, inputIndex: 0, sourceSatoshis: sats, lockingScript: lock, p256PrivateKey: m.priv, salt: m.salt }); break } catch (e) { if (!e.code) throw e }
  }
  const u = decodeUnlock2(unlock)
  const sp = new Spend({ sourceTXID: src.id('hex'), sourceOutputIndex: 0, sourceSatoshis: sats, lockingScript: lock, transactionVersion: 1, otherInputs: [], outputs: tx.outputs, unlockingScript: unlock, inputSequence: 0xffffffff, inputIndex: 0, lockTime: 0 })
  const stepTo = pc => { let n = 0; while (!(sp.context === 'LockingScript' && sp.programCounter === pc)) { sp.step(); if (++n > 2e6) throw new Error('overflow') } }
  // (a) after the unlocking script: 71 items (the context switch to LockingScript happens inside the step that executes lock chunk 0)
  { let n = 0; while (!(sp.context === 'UnlockingScript' && sp.programCounter === unlock.chunks.length)) { sp.step(); if (++n > 1000) throw new Error('unlock overflow') } }
  check(`N=${N} unlock has 71 chunks and leaves 71 items; top = preimage (158 B)`, unlock.chunks.length === 71 && sp.stack.length === 71 && sp.stack.at(-1).length === 158, `unlock=${unlock.toBinary().length} B`)
  // (b) at loop entry (first chunk of the comb loop): stack must be [r u2' u1' Q0..Q63 G0..G63 1 1 0], alt [preimage p]
  const loopStart = L.regions[9].chunks[0]
  stepTo(loopStart)
  const st = sp.stack.map(hex)
  const Qtab = combTable(p256.Point.fromHex(m.q)), Gtab = combTable(p256.Point.BASE)
  const expected = [scriptNum(u.r), scriptNum(u.u2p), scriptNum(u.u1p), ...Qtab.flatMap(p => [scriptNum(p.x), scriptNum(p.y)]), ...Gtab.flatMap(p => [scriptNum(p.x), scriptNum(p.y)]), [1], [1], []].map(hex)
  const same = st.length === expected.length && st.every((x, i) => x === expected[i])
  let firstDiff = -1; for (let i = 0; i < Math.max(st.length, expected.length); i++) if (st[i] !== expected[i]) { firstDiff = i; break }
  check(`N=${N} loop entry (chunk ${loopStart}) stack == [r u2' u1' Q0..Q63 G0..G63 1 1 0] (${expected.length} items)`, same, `depth=${st.length} firstDiff=${firstDiff}`)
  const pre = sighashPreimage({ tx, inputIndex: 0, sourceSatoshis: sats, scope: 0x41 })
  check(`N=${N} loop entry altstack == [preimage, p]`, sp.altStack.length === 2 && hex(sp.altStack[0]) === hex(pre) && hex(sp.altStack[1]) === hex(scriptNum(P256_P)))
  const eLE = BigInt('0x' + hex([...Hash.hash256(pre)].reverse())); const mod = (a, m) => ((a % m) + m) % m
  check(`N=${N} pushed u1' == recode(e*sInv), u2' == recode(r*sInv), s*sInv == 1 (independent recompute from the preimage)`, recode(mod(eLE * u.sInv, P256_N)) === u.u1p && recode(mod(u.r * u.sInv, P256_N)) === u.u2p && mod(u.s * u.sInv, P256_N) === 1n)
  // (c) at the tail entry (rCheck's OP_DUP): [r u2' u1' 128 coords X Y Z] = 134 items, item 0 == r; then after
  //     `OP_DUP 0 OP_NUMEQUAL OP_NOTIF OP_DUP OP_DUP OP_MUL MODP` (11 chunks) the stack is 135 deep and `134 OP_PICK` must yield r
  const tailStart = L.regions[10].chunks[0]
  stepTo(tailStart)
  check(`N=${N} tail entry (chunk ${tailStart}, ${L.tailChunks} tail chunks): depth 134, item 0 == r, coords 3..130 unchanged`, sp.stack.length === 134 && hex(sp.stack[0]) === hex(scriptNum(u.r)) && sp.stack.slice(3, 131).map(hex).every((x, i) => x === expected[3 + i]), `depth=${sp.stack.length}`)
  stepTo(tailStart + 11)
  check(`N=${N} after rCheck prologue: depth 135 and next op is <134> OP_PICK reaching r`, sp.stack.length === 135 && lock.chunks[tailStart + 11].data?.[0] === 134 && lock.chunks[tailStart + 12].op === OP.OP_PICK, `depth=${sp.stack.length} chunk=${hex(lock.chunks[tailStart + 11].data ?? [])}`)
  // (d) continue stepping from the tail entry to the end WITHOUT resetting (validate() would re-run from scratch): the
  //     final state must be a single truthy item (CHECKSIG result), i.e. the intermediate states above are the real ones
  let err = null; try { while (sp.programCounter < lock.chunks.length) sp.step() } catch (e) { err = e.message.split('\n')[0] }
  check(`N=${N} stepping on from the tail entry completes: pc=${sp.programCounter}, stack == [true]`, !err && sp.programCounter === lock.chunks.length && sp.stack.length === 1 && hex(sp.stack[0]) === '01', err ?? `depth=${sp.stack.length} top=${hex(sp.stack.at(-1) ?? [])}`)
  // (e) and a fresh validate() agrees
  const sp2 = new Spend({ sourceTXID: src.id('hex'), sourceOutputIndex: 0, sourceSatoshis: sats, lockingScript: lock, transactionVersion: 1, otherInputs: [], outputs: tx.outputs, unlockingScript: unlock, inputSequence: 0xffffffff, inputIndex: 0, lockTime: 0 })
  let ok = false; try { ok = sp2.validate() } catch (e) { console.log('ERR', e.message.split('\n')[0]) }
  check(`N=${N} fresh Spend.validate() == true`, ok, `pc=${sp2.programCounter}`)
}
console.log(fails ? `${fails} FAILURE(S)` : 'ALL PASS')
process.exitCode = fails ? 1 : 0
