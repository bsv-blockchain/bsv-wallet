// edge-tests.mjs — exercise paths the fixture and ordinary random rounds do not reach:
//  (1) the OP_PUSH_TX DER screen firing (s with top bit set) and proof that such a spend really fails,
//  (2) a Q comb-table coordinate < 2^248 (short minimal push) still spends,
//  (3) a P-256 signature whose r is >= 2^255 vs < 2^255 both appear (33- vs 32-byte pushes) — counted.
import { Transaction, P2PKH, PrivateKey, Spend, Script } from '@bsv/sdk'
import { p256 } from '@noble/curves/nist.js'
import { buildLock, combTable, scriptNum } from './gen.mjs'
import { buildUnlock, sighashPreimage, pushTxDerCheck, pushTxSignature, decodeUnlock } from './unlock.mjs'
const hex = a => Buffer.from(a).toString('hex')
let fails = 0
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`); if (!ok) fails++ }
function validate ({ tx, sats, lock, unlock }) {
  const sp = new Spend({ sourceTXID: tx.inputs[0].sourceTXID, sourceOutputIndex: tx.inputs[0].sourceOutputIndex, sourceSatoshis: sats, lockingScript: lock,
    transactionVersion: tx.version, otherInputs: [], outputs: tx.outputs, unlockingScript: unlock, inputSequence: tx.inputs[0].sequence, inputIndex: 0, lockTime: tx.lockTime })
  try { return { ok: sp.validate(), pc: sp.programCounter } } catch (e) { return { ok: false, pc: sp.programCounter, err: e.message.split('\n')[0] } }
}
const mkTx = (sats, outSats, dest) => {
  const tx = new Transaction(1, [], [], 0)
  tx.addInput({ sourceTXID: hex(crypto.getRandomValues(new Uint8Array(32))), sourceOutputIndex: 0, sequence: 0xffffffff })
  tx.addOutput({ satoshis: outSats, lockingScript: dest })
  return tx
}

// (1) OP_PUSH_TX DER model: pushTxSignature(preimage) must equal the bytes the interpreter hands to OP_CHECKSIG,
//     including the "pad" case s < 2^248 with bit 247 set (scriptnum sign byte -> DER 0x00 pad), which the
//     Map-phase tail report wrongly predicted to be a negative-S rejection.
{
  const priv = p256.utils.randomSecretKey()
  const sats = 50000
  const lock = buildLock({ qCompressedHex: hex(p256.getPublicKey(priv, true)), satoshis: sats })
  const dest = new P2PKH().lock(PrivateKey.fromRandom().toAddress())
  const sigAtChecksig = ({ tx, unlock }) => {
    const sp = new Spend({ sourceTXID: tx.inputs[0].sourceTXID, sourceOutputIndex: 0, sourceSatoshis: sats, lockingScript: lock, transactionVersion: tx.version, otherInputs: [], outputs: tx.outputs, unlockingScript: unlock, inputSequence: 0xffffffff, inputIndex: 0, lockTime: 0 })
    try { while (!(sp.context === 'LockingScript' && sp.programCounter === 23066)) sp.step() } catch (e) { return `THREW at pc ${sp.programCounter}: ${e.message.split('\n')[0]}` }
    return hex(sp.stack.at(-2))
  }
  const cases = { pad: [], short: [], plain: [] }
  let scanned = 0
  while ((cases.pad.length < 3 || cases.short.length < 2 || cases.plain.length < 5) && scanned < 200000) {
    const tx = mkTx(sats, 49000, dest); scanned++
    const { s, sDer } = pushTxSignature(sighashPreimage({ tx, inputIndex: 0, sourceSatoshis: sats }))
    const kind = sDer.length === 32 && s < (1n << 248n) ? 'pad' : sDer.length < 32 ? 'short' : 'plain'
    if (cases[kind].length < (kind === 'plain' ? 5 : kind === 'pad' ? 3 : 2)) cases[kind].push(tx)
  }
  check('collected pad/short/plain PUSH_TX cases', cases.pad.length === 3 && cases.short.length === 2 && cases.plain.length === 5, `scanned ${scanned} preimages`)
  for (const kind of ['pad', 'short', 'plain']) {
    for (const tx of cases[kind]) {
      const preimage = sighashPreimage({ tx, inputIndex: 0, sourceSatoshis: sats })
      const model = pushTxSignature(preimage)
      check(`${kind}: pushTxDerCheck ok`, pushTxDerCheck(preimage).ok)
      const unlock = buildUnlock({ tx, inputIndex: 0, sourceSatoshis: sats, lockingScript: lock, p256PrivateKey: priv })
      const actual = sigAtChecksig({ tx, unlock })
      check(`${kind}: modelled PUSH_TX signature == interpreter CHECKSIG input`, actual === hex(model.sig), `${actual.slice(72, 78)}.. sDer len ${model.sDer.length}${kind === 'pad' ? ' (leading 00 pad present)' : ''}`)
      const v = validate({ tx, sats, lock, unlock })
      check(`${kind}: Spend.validate === true`, v.ok, `pc=${v.pc} ${v.err ?? ''}`)
    }
  }
  // (1b) the REAL rare failure: s scriptnum <= 31 bytes ending in a 0x00 sign byte trips the peel loop's 31st
  //      OP_0NOTEQUAL (non-minimal number). Find one with the JS model (~1/57000), then confirm with the interpreter.
  let hit = null, scannedB = 0
  while (!hit && scannedB < 3_000_000) {
    const tx = mkTx(sats, 49000, dest); scannedB++
    const chk = pushTxDerCheck(sighashPreimage({ tx, inputIndex: 0, sourceSatoshis: sats }))
    if (!chk.ok) hit = { tx, chk }
  }
  check('found a preimage the peel-loop screen rejects', hit !== null, hit ? `after ${scannedB} preimages; reason=${hit.chk.reason} peelIndex=${hit.chk.peelIndex} scriptNum(s) len=${scriptNum(hit.chk.s).length} s=0x${hit.chk.s.toString(16)}` : `none in ${scannedB}`)
  if (hit) {
    let code = null
    try { buildUnlock({ tx: hit.tx, inputIndex: 0, sourceSatoshis: sats, lockingScript: lock, p256PrivateKey: priv }) } catch (e) { code = e.code }
    check('buildUnlock throws with that error.code', code === hit.chk.reason, String(code))
    const forced = buildUnlock({ tx: hit.tx, inputIndex: 0, sourceSatoshis: sats, lockingScript: lock, p256PrivateKey: priv, skipPushTxCheck: true })
    const v = validate({ tx: hit.tx, sats, lock, unlock: forced })
    check('interpreter rejects it at pc 22986 (31st OP_0NOTEQUAL) with non-minimally encoded script number', !v.ok && v.pc === 22986 && /non-minimally/.test(v.err ?? ''), `validate=${v.ok} pc=${v.pc} ${v.err ?? ''}`)
    const tx2 = mkTx(sats, 48999, dest); tx2.inputs[0].sourceTXID = hit.tx.inputs[0].sourceTXID
    let unlock2 = null
    try { unlock2 = buildUnlock({ tx: tx2, inputIndex: 0, sourceSatoshis: sats, lockingScript: lock, p256PrivateKey: priv }) } catch (e) { code = e.code }
    const v2 = unlock2 ? validate({ tx: tx2, sats, lock, unlock: unlock2 }) : { ok: false }
    check('perturbed tx (output -1 sat) passes the screen and validates', unlock2 !== null && v2.ok, unlock2 ? `pc=${v2.pc}` : `screen again: ${code}`)
  }
  let rej = 0; const N = 200000
  for (let i = 0; i < N; i++) if (!pushTxDerCheck(sighashPreimage({ tx: mkTx(sats, 49000, dest), inputIndex: 0, sourceSatoshis: sats })).ok) rej++
  console.log(`INFO screen rejection rate over ${N} random preimages: ${rej} (~1/${Math.round(N / Math.max(rej, 1))}; model ~1/57000 = 2^-16)`)
}

// (2) short Q-table coordinate (< 2^248 => minimal push shorter than 32 bytes)
{
  let priv, Q, table, shortIdx = -1, keys = 0
  while (shortIdx < 0 && keys < 200) {
    priv = p256.utils.randomSecretKey(); Q = p256.Point.fromBytes(p256.getPublicKey(priv, true)); keys++
    table = combTable(Q)
    for (let j = 0; j < table.length && shortIdx < 0; j++) { if (table[j].x < (1n << 248n)) shortIdx = 2 * j; else if (table[j].y < (1n << 248n)) shortIdx = 2 * j + 1 }
  }
  check('found a key whose Q table has a coordinate < 2^248', shortIdx >= 0, `after ${keys} keys (P~22%/key); table const index ${shortIdx}`)
  const sats = 7777
  const lock = buildLock({ qCompressedHex: hex(Q.toBytes(true)), satoshis: sats })
  const chunk = lock.chunks[151 + shortIdx]
  const coord = shortIdx & 1 ? table[shortIdx >> 1].y : table[shortIdx >> 1].x
  const expectLen = 31 + Number((coord >> 247n) & 1n)          // 31 magnitude bytes, + 0x00 sign byte iff bit 247 set
  check('that coordinate is pushed with its minimal scriptnum (31 bytes, or 31 + 0x00 sign byte)', hex(chunk.data) === hex(scriptNum(coord)) && chunk.data.length === expectLen && chunk.op === chunk.data.length,
    `chunk ${151 + shortIdx}: ${chunk.data.length} bytes (bit247=${(coord >> 247n) & 1n})`)
  // total length = fixed part + sum of the 128 minimal coordinate pushes (differs per key: 32 vs 33 vs <32-byte coordinates)
  const fixtureLock = buildLock({ qCompressedHex: '03f4d667712d8825372cd616b0b1b1a818e5eeb3681dd45c5bdd59fed9f21d5a7d', satoshis: sats })
  const qBytes = L => L.chunks.slice(151, 215).reduce((a, c) => a + 1 + c.data.length, 0)
  check('lock byte length differs from the fixture-Q lock exactly by the Q-table push sizes',
    lock.toBinary().length - fixtureLock.toBinary().length === qBytes(lock) - qBytes(fixtureLock),
    `${lock.toBinary().length} bytes (Q table ${qBytes(lock)} B) vs ${fixtureLock.toBinary().length} (Q table ${qBytes(fixtureLock)} B)`)
  const dest = new P2PKH().lock(PrivateKey.fromRandom().toAddress())
  let unlock = null, tx
  for (let out = 7000; out > 6980 && !unlock; out--) { tx = mkTx(sats, out, dest); try { unlock = buildUnlock({ tx, inputIndex: 0, sourceSatoshis: sats, lockingScript: lock, p256PrivateKey: priv }) } catch (e) { if (!e.code) throw e } }
  const v = validate({ tx, sats, lock, unlock })
  check('spend of the short-coordinate lock validates', v.ok, `pc=${v.pc} ${v.err ?? ''}`)
}

// (3) push-size census over many signatures (r/s/sInv 32 vs 33 bytes) — all must validate
{
  const priv = p256.utils.randomSecretKey()
  const sats = 12345
  const lock = buildLock({ qCompressedHex: hex(p256.getPublicKey(priv, true)), satoshis: sats })
  const dest = new P2PKH().lock(PrivateKey.fromRandom().toAddress())
  const census = { r33: 0, r32: 0, rLt32: 0, s32: 0, sLt32: 0, sInv33: 0, sInv32: 0, sInvLt32: 0, rGeN: 0 }
  let okAll = true, n = 0, screened = 0
  const N = Number(process.env.SIGS ?? 40)
  while (n < N) {
    const tx = mkTx(sats, 12000, dest)
    let unlock
    try { unlock = buildUnlock({ tx, inputIndex: 0, sourceSatoshis: sats, lockingScript: lock, p256PrivateKey: priv }) } catch (e) { if (e.code) { screened++; continue } throw e }
    const f = decodeUnlock(unlock)
    const L = v => scriptNum(v).length
    census[L(f.r) === 33 ? 'r33' : L(f.r) === 32 ? 'r32' : 'rLt32']++
    census[L(f.s) === 32 ? 's32' : 'sLt32']++
    census[L(f.sInv) === 33 ? 'sInv33' : L(f.sInv) === 32 ? 'sInv32' : 'sInvLt32']++
    if (f.r >= p256.Point.CURVE().n) census.rGeN++
    const v = validate({ tx, sats, lock, unlock })
    if (!v.ok) { okAll = false; console.log('  FAIL detail', v) }
    n++
  }
  check(`${N} random signatures all validate`, okAll, `${JSON.stringify(census)} screened=${screened}`)
}
console.log(fails ? `${fails} FAILURE(S)` : 'ALL PASS')
process.exitCode = fails ? 1 : 0
