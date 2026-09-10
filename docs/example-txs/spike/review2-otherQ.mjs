// review2-otherQ.mjs — generate for random Q and non-fixture amounts; classify every differing chunk/byte region
// against the fixture; then software-sign a spend of the new lock and validate; negative controls.
import fs from 'fs'
import { LockingScript, Transaction, Spend, Utils, P2PKH, PrivateKey, Script } from '@bsv/sdk'
import { p256 } from '@noble/curves/nist.js'
import { buildLock, scriptNum, combTable } from './gen.mjs'
import { buildUnlock, decodeUnlock } from './unlock.mjs'
const hex = a => Buffer.from(a).toString('hex')
const REPO = '/Users/personal/git/bsv-wallet'
const fix = LockingScript.fromHex(fs.readFileSync(REPO + '/docs/example-txs/51c53430fe63108a2a1ddd231253df069fb424cc6f1bb0ee60b4b07792d3579a_0.hex', 'utf8').trim())
const fixBin = fix.toBinary()
const chunkLen = c => 1 + (c.data ? (c.op <= 75 ? c.data.length : c.op === 76 ? 1 + c.data.length : c.op === 77 ? 2 + c.data.length : 4 + c.data.length) : 0)
const offsets = L => { const o = []; let off = 0; for (const c of L.chunks) { o.push(off); off += chunkLen(c) } return o }
let fails = 0
const check = (n, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${d ? ' :: ' + d : ''}`); if (!ok) fails++ }
const le64 = v => { const w = new Utils.Writer(); w.writeUInt64LE(Number(v)); return w.toArray() }
const validate = ({ tx, sats, lock, unlock }) => {
  const sp = new Spend({ sourceTXID: tx.inputs[0].sourceTXID, sourceOutputIndex: tx.inputs[0].sourceOutputIndex, sourceSatoshis: sats, lockingScript: lock, transactionVersion: tx.version, otherInputs: [], outputs: tx.outputs, unlockingScript: unlock, inputSequence: tx.inputs[0].sequence, inputIndex: 0, lockTime: tx.lockTime })
  try { return { ok: sp.validate(), pc: sp.programCounter } } catch (e) { return { ok: false, pc: sp.programCounter, err: e.message.split('\n')[0] } }
}
for (const sats of [123456789, 1, 5000000000, 2100000000000000]) {
  const priv = p256.utils.randomSecretKey(); const qHex = hex(p256.getPublicKey(priv, true))
  console.log(`\n=== sats=${sats} Q=${qHex} ===`)
  const lock = buildLock({ qCompressedHex: qHex, satoshis: sats })
  check(`chunk count == fixture`, lock.chunks.length === fix.chunks.length, `${lock.chunks.length}`)
  const diff = []
  for (let i = 0; i < fix.chunks.length; i++) { const x = lock.chunks[i], y = fix.chunks[i]; if (x.op !== y.op || hex(x.data ?? []) !== hex(y.data ?? [])) diff.push(i) }
  const qtab = diff.filter(i => i >= 151 && i <= 214), other = diff.filter(i => i !== 12 && !(i >= 151 && i <= 214))
  check(`differing chunks ⊆ {12} ∪ [151,214]`, other.length === 0, `total ${diff.length}: amount ${diff.includes(12) ? 1 : 0}, Qtable ${qtab.length}, other ${other.length}${other.length ? ' -> ' + other.slice(0, 10).join(',') : ''}`)
  check(`chunk 12 == LE64(sats); fixture chunk 12 == f811000000000000`, hex(lock.chunks[12].data) === hex(le64(sats)) && hex(fix.chunks[12].data) === 'f811000000000000', hex(lock.chunks[12].data))
  check(`all 64 Q-table chunks differ from fixture`, qtab.length === 64, `${qtab.length}`)
  const T = combTable(p256.Point.fromHex(qHex))
  let tabOk = true; for (let j = 0; j < 32; j++) if (hex(lock.chunks[151 + 2 * j].data) !== hex(scriptNum(T[j].x)) || hex(lock.chunks[152 + 2 * j].data) !== hex(scriptNum(T[j].y))) tabOk = false
  check(`Q-table chunks == scriptNum(T_j*Q) recomputed with noble`, tabOk)
  let gOk = true; for (let i = 87; i <= 150; i++) if (hex(lock.chunks[i].data) !== hex(fix.chunks[i].data)) gOk = false
  check(`G-table chunks 87..150 identical to fixture`, gOk)
  const go = offsets(lock), fo = offsets(fix), gb = lock.toBinary(), fb = fixBin
  const A = hex(gb.slice(0, go[12] + 1)) === hex(fb.slice(0, fo[12] + 1))
  const B = hex(gb.slice(go[13], go[151])) === hex(fb.slice(fo[13], fo[151]))
  const C = hex(gb.slice(go[215])) === hex(fb.slice(fo[215]))
  const qBytes = L => L.chunks.slice(151, 215).reduce((s, c) => s + chunkLen(c), 0)
  check(`byte regions: [0,chunk12 op] / chunks 13..150 / chunks 215..end identical; length delta == Q-table delta`, A && B && C && (gb.length - fb.length) === (qBytes(lock) - qBytes(fix)),
    `gen ${gb.length} B vs fixture ${fb.length} B (delta ${gb.length - fb.length}); Qtable ${qBytes(lock)} vs ${qBytes(fix)} B; tail shift ${go[215] - fo[215]}; chunk-12 data offset ${go[12] + 1}`)
  const sizes = {}; for (let i = 151; i <= 214; i++) { const l = lock.chunks[i].data.length; sizes[l] = (sizes[l] || 0) + 1 }
  console.log(`  Q-table push sizes: ${JSON.stringify(sizes)}`)
  const dest = new P2PKH().lock(PrivateKey.fromRandom().toAddress())
  let unlock, tx, tries = 0, lastErr
  for (; tries < 20; tries++) {
    tx = new Transaction(1, [], [], 0)
    tx.addInput({ sourceTXID: hex(crypto.getRandomValues(new Uint8Array(32))), sourceOutputIndex: 1, sequence: 0xffffffff })
    tx.addOutput({ satoshis: Math.max(1, sats - 100), lockingScript: dest })
    tx.addOutput({ satoshis: 0, lockingScript: Script.fromASM('OP_RETURN ' + hex([tries + 1])) })
    try { unlock = buildUnlock({ tx, inputIndex: 0, sourceSatoshis: sats, lockingScript: lock, p256PrivateKey: priv }); break } catch (e) { lastErr = e; if (!e.code) throw e }
  }
  if (!unlock) { check('buildUnlock', false, lastErr?.message); continue }
  const f = decodeUnlock(unlock)
  const v = validate({ tx, sats, lock, unlock })
  check(`Spend.validate(software-signed spend of new lock) === true`, v.ok, `pc=${v.pc} r:${scriptNum(f.r).length}B s:${scriptNum(f.s).length}B sInv:${scriptNum(f.sInv).length}B screenRetries=${tries}${v.err ? ' ' + v.err : ''}`)
  const vf = validate({ tx, sats, lock: fix, unlock })
  check(`same unlock against the FIXTURE lock fails (different Q)`, !vf.ok, `pc=${vf.pc} ${vf.err ?? ''}`)
  const va = validate({ tx, sats: sats + 1, lock, unlock })
  check(`same unlock with sourceSatoshis+1 fails (baked amount enforced by OP_PUSH_TX)`, !va.ok, `pc=${va.pc} ${va.err ?? ''}`)
}
console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL PASS')
process.exitCode = fails ? 1 : 0
