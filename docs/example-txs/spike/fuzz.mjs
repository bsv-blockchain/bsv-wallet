// fuzz.mjs — randomized end-to-end fuzz of gen.mjs (buildLock) + unlock.mjs (buildUnlock) against the
// @bsv/sdk Spend interpreter, followed by a battery of negative tests that MUST fail validation.
//
//   ITER=300 node fuzz.mjs            (writes fuzz-failures.json + fuzz-report.json next to this file)
//
// Positive fuzz, per iteration: random P-256 key, random satoshis in [1, 2^40], random spend tx with 1..3 outputs of
// random amounts / random script kinds, random locktime (0 or random uint32; baked into the lock), the single input
// with sequence 0xffffffff  ->  buildLock -> buildUnlock -> Spend.validate() must be true.
// Every Spend.validate() call is timed (performance.now()).
import fs from 'fs'
import { performance } from 'perf_hooks'
import { Transaction, P2PKH, PrivateKey, Spend, Script, LockingScript, UnlockingScript, Hash, Utils, OP, TransactionSignature } from '@bsv/sdk'
import { p256 } from '@noble/curves/nist.js'
import { buildLock, combTable, scriptNum, encNum, pushData, bakedSatoshis, P256_N, P256_P } from './gen.mjs'
import { buildUnlock, sighashPreimage, signerDigest, fullR, encodeUnlock, decodeUnlock, pushTxDerCheck, bakedParams } from './unlock.mjs'

const S = process.env.S ?? '/private/tmp/claude-502/-Users-personal-git-bsv-wallet/a954ef08-e7c5-49e3-8a72-1cd73ad1d771/scratchpad'
const ITER = Number(process.env.ITER ?? 300)
const hex = a => Buffer.from(a).toString('hex')
const bytesOf = h => [...Buffer.from(h, 'hex')]
const mod = (a, m) => ((a % m) + m) % m
const beToBig = b => BigInt('0x' + (hex(b) || '0'))
const randBytes = n => [...crypto.getRandomValues(new Uint8Array(n))]
const randBig = (lo, hi) => {                       // uniform-ish bigint in [lo, hi]
  const range = hi - lo + 1n
  const bits = range.toString(2).length
  const nbytes = Math.ceil(bits / 8) + 8
  return lo + beToBig(randBytes(nbytes)) % range
}
const randInt = (lo, hi) => Number(randBig(BigInt(lo), BigInt(hi)))
const pick = arr => arr[randInt(0, arr.length - 1)]

// ───────────────────────────── random tx material ─────────────────────────────
const SCRIPT_KINDS = ['p2pkh', 'op_return', 'op_1', 'push_drop_1', 'pushdata2_drop_1', 'empty', 'op_false_return']
function randomOutputScript () {
  const kind = pick(SCRIPT_KINDS)
  switch (kind) {
    case 'p2pkh': return { kind, script: new P2PKH().lock(PrivateKey.fromRandom().toAddress()) }
    case 'op_return': return { kind, script: Script.fromBinary([OP.OP_RETURN, ...pushData(randBytes(randInt(0, 80)))]) }
    case 'op_false_return': return { kind, script: Script.fromBinary([OP.OP_FALSE, OP.OP_RETURN, ...pushData(randBytes(randInt(1, 120)))]) }
    case 'op_1': return { kind, script: Script.fromBinary([OP.OP_1]) }
    case 'push_drop_1': return { kind, script: Script.fromBinary([...pushData(randBytes(randInt(1, 75))), OP.OP_DROP, OP.OP_1]) }
    case 'pushdata2_drop_1': return { kind, script: Script.fromBinary([...pushData(randBytes(randInt(256, 600))), OP.OP_DROP, OP.OP_1]) }   // output script > 255 B -> 3-byte varint
    case 'empty': return { kind, script: new Script() }
  }
}
function randomOutputs (sats) {
  const n = randInt(1, 3)
  const outs = []
  for (let i = 0; i < n; i++) {
    // amounts: mostly within the input value, sometimes anything in [0, 2^40] (Spend does not check amounts)
    const amt = Math.random() < 0.8 ? randBig(0n, BigInt(sats)) : randBig(0n, 1n << 40n)
    const { kind, script } = randomOutputScript()
    outs.push({ satoshis: Number(amt), lockingScript: script, kind })
  }
  return outs
}
function randomLockTime () { return Math.random() < 0.5 ? 0 : randInt(1, 0xffffffff) }
function mkTx ({ lockTime, sourceTXID, vout, sequence = 0xffffffff, outputs, version = 1, extraInputs = [] }) {
  const tx = new Transaction(version, [], [], lockTime)
  tx.addInput({ sourceTXID, sourceOutputIndex: vout, sequence, unlockingScript: new UnlockingScript() })
  for (const ei of extraInputs) tx.addInput({ sourceTXID: ei.sourceTXID, sourceOutputIndex: ei.vout, sequence: ei.sequence ?? 0xffffffff, unlockingScript: new UnlockingScript() })
  for (const o of outputs) tx.addOutput({ satoshis: o.satoshis, lockingScript: o.lockingScript })
  return tx
}

// ───────────────────────────── interpreter harness ─────────────────────────────
function mkSpend ({ tx, inputIndex = 0, sourceSatoshis, lockingScript, unlockingScript }) {
  const inp = tx.inputs[inputIndex]
  return new Spend({
    sourceTXID: inp.sourceTXID, sourceOutputIndex: inp.sourceOutputIndex, sourceSatoshis: Number(sourceSatoshis),
    lockingScript, transactionVersion: tx.version, otherInputs: tx.inputs.filter((_, i) => i !== inputIndex), outputs: tx.outputs,
    unlockingScript, inputSequence: inp.sequence, inputIndex, lockTime: tx.lockTime
  })
}
/** Run validate(); returns { ok, pc, err, ms, mode } with mode = 'returned true' | 'returned false' | 'threw'. */
function runValidate (args) {
  const sp = mkSpend(args)
  const t0 = performance.now()
  try {
    const ok = sp.validate()
    return { ok: ok === true, pc: sp.programCounter, err: null, ms: performance.now() - t0, mode: ok === true ? 'returned true' : 'returned false' }
  } catch (e) {
    return { ok: false, pc: sp.programCounter, err: e.message.split('\n')[0], ms: performance.now() - t0, mode: 'threw' }
  }
}
/** Step the locking script to `pc` (inclusive: stops when about to execute chunk pc) and return the Spend. */
function stepTo (args, pc) {
  const sp = mkSpend(args)
  let n = 0
  while (!(sp.context === 'LockingScript' && sp.programCounter === pc)) { sp.step(); if (++n > 2e6) throw new Error('stepTo overflow') }
  return sp
}
/** Interpreter's in-script preimage: stack top when chunk 22 (OP_DUP before HASH256) is about to run. */
function inScriptPreimage (args) { return [...stepTo(args, 22).stack.at(-1)] }
/** Does the P-256 leg pass? i.e. does execution reach OP_CHECKSIG (chunk 23066)? Returns { reached, checksigTop, pc, err }. */
function checksigProbe (args) {
  const sp = mkSpend(args)
  const LAST = args.lockingScript.chunks.length - 1
  try {
    let n = 0
    while (!(sp.context === 'LockingScript' && sp.programCounter === LAST)) { sp.step(); if (++n > 2e6) throw new Error('overflow') }
    sp.step()                                       // execute OP_CHECKSIG
    return { reached: true, checksigTop: hex(sp.stack.at(-1)), pc: sp.programCounter, err: null }
  } catch (e) { return { reached: false, checksigTop: null, pc: sp.programCounter, err: e.message.split('\n')[0] } }
}
/** The preimage the interpreter's OP_CHECKSIG actually signs over (same TransactionSignature.format Spend uses internally). */
function realPreimage ({ tx, inputIndex = 0, sourceSatoshis }) { return sighashPreimage({ tx, inputIndex, sourceSatoshis, scope: 0x41 }) }

/** Build an unlock "by hand" from an arbitrary preimage to sign (bypasses buildUnlock's guards). */
function manualUnlock ({ preimageToSign, priv, Q, outpointPush, hashOutputsPush, tamper = {} }) {
  const digest = signerDigest(preimageToSign)
  const e = beToBig(digest)
  const sig = p256.Signature.fromBytes(p256.sign(digest, priv, { prehash: false }), 'compact')
  const { x: Rx, sInv } = fullR({ e, r: sig.r, s: sig.s, Q })
  let r = Rx, s = sig.s, si = sInv
  if (tamper.r) r = tamper.r(r); if (tamper.s) s = tamper.s(s); if (tamper.sInv) si = tamper.sInv(si, s)
  return encodeUnlock({ r, s, sInv: si, hashOutputs: hashOutputsPush ?? preimageToSign.slice(118, 150), outpoint: outpointPush ?? preimageToSign.slice(68, 104) })
}
const modinv = (a, m) => { let r = 1n, b = mod(a, m), e = m - 2n; while (e > 0n) { if (e & 1n) r = r * b % m; b = b * b % m; e >>= 1n } return r }

// ───────────────────────────── positive fuzz ─────────────────────────────
const failures = []
const stats = { iterations: 0, pass: 0, fail: 0, pushTxScreened: 0, validateMs: [], buildLockMs: [], buildUnlockMs: [], outputsHist: { 1: 0, 2: 0, 3: 0 }, lockTimeNonZero: 0, scriptKinds: {}, pushLens: { r33: 0, r32: 0, rLt32: 0, s33: 0, s32: 0, sLt32: 0, sInv33: 0, sInv32: 0, sInvLt32: 0 }, lockBytesMin: Infinity, lockBytesMax: 0, unlockBytes: {}, satsMax: 0n, nobleVerifyAgree: 0 }
console.log(`fuzz: ${ITER} iterations`)
const tAll = performance.now()
for (let i = 0; i < ITER; i++) {
  const priv = p256.utils.randomSecretKey()
  const qHex = hex(p256.getPublicKey(priv, true))
  const Q = p256.Point.fromHex(qHex)
  const sats = randBig(1n, 1n << 40n)
  const lockTime = randomLockTime()
  const sourceTXID = hex(randBytes(32))
  const vout = Math.random() < 0.8 ? randInt(0, 20) : randInt(0, 0xffffffff)
  let lock, tGen
  try { const t0 = performance.now(); lock = buildLock({ qCompressedHex: qHex, satoshis: sats, lockTime }); tGen = performance.now() - t0 } catch (e) {
    failures.push({ i, stage: 'buildLock', err: e.message, priv: hex(priv), qHex, sats: sats.toString(), lockTime }); stats.fail++; stats.iterations++; continue
  }
  stats.buildLockMs.push(tGen)
  const lb = lock.toBinary().length; stats.lockBytesMin = Math.min(stats.lockBytesMin, lb); stats.lockBytesMax = Math.max(stats.lockBytesMax, lb)
  if (bakedSatoshis(lock) !== Number(sats)) { failures.push({ i, stage: 'bakedSatoshis', got: bakedSatoshis(lock), sats: sats.toString() }); stats.fail++; stats.iterations++; continue }
  // random tx; retry with fresh outputs if the OP_PUSH_TX screen (~2^-16) fires
  let tx, outputs, unlock, tUnl, screened = 0, unlockErr = null
  for (let attempt = 0; attempt < 20 && !unlock; attempt++) {
    outputs = randomOutputs(sats)
    tx = mkTx({ lockTime, sourceTXID, vout, outputs })
    try { const t0 = performance.now(); unlock = buildUnlock({ tx, inputIndex: 0, sourceSatoshis: sats, lockingScript: lock, p256PrivateKey: priv }); tUnl = performance.now() - t0 } catch (e) {
      if (e.code === 'PUSH_TX_PEEL_NONMINIMAL' || e.code === 'PUSH_TX_S_ZERO') {
        screened++; stats.pushTxScreened++
        // confirm the screen is right: force the unlock and expect the interpreter to reject it
        const forced = buildUnlock({ tx, inputIndex: 0, sourceSatoshis: sats, lockingScript: lock, p256PrivateKey: priv, skipPushTxCheck: true })
        const v = runValidate({ tx, sourceSatoshis: sats, lockingScript: lock, unlockingScript: forced })
        console.log(`  iter ${i}: PUSH_TX screen fired (${e.code}); forced spend -> validate ok=${v.ok} pc=${v.pc} ${v.err ?? ''}`)
        if (v.ok) failures.push({ i, stage: 'pushTxScreenFalsePositive', code: e.code, txHex: tx.toHex(), priv: hex(priv), qHex, sats: sats.toString(), lockTime })
        continue
      }
      unlockErr = e; break
    }
  }
  stats.iterations++
  if (!unlock) { failures.push({ i, stage: 'buildUnlock', err: unlockErr?.message ?? 'screened 20x', priv: hex(priv), qHex, sats: sats.toString(), lockTime, txHex: tx?.toHex() }); stats.fail++; continue }
  stats.buildUnlockMs.push(tUnl)
  stats.outputsHist[outputs.length]++
  if (lockTime !== 0) stats.lockTimeNonZero++
  for (const o of outputs) stats.scriptKinds[o.kind] = (stats.scriptKinds[o.kind] || 0) + 1
  if (sats > stats.satsMax) stats.satsMax = sats
  const f = decodeUnlock(unlock)
  const L = v => scriptNum(v).length
  stats.pushLens[L(f.r) === 33 ? 'r33' : L(f.r) === 32 ? 'r32' : 'rLt32']++
  stats.pushLens[L(f.s) === 33 ? 's33' : L(f.s) === 32 ? 's32' : 'sLt32']++
  stats.pushLens[L(f.sInv) === 33 ? 'sInv33' : L(f.sInv) === 32 ? 'sInv32' : 'sInvLt32']++
  const ub = unlock.toBinary().length; stats.unlockBytes[ub] = (stats.unlockBytes[ub] || 0) + 1
  // independent oracle for the signature itself: noble verifies (r mod n, s) over the signer digest
  const preimage = realPreimage({ tx, sourceSatoshis: sats })
  const nobleOk = p256.verify(new p256.Signature(mod(f.r, P256_N), f.s).toBytes('compact'), signerDigest(preimage), Q.toBytes(true), { prehash: false, lowS: false })
  if (nobleOk) stats.nobleVerifyAgree++
  // the oracle
  const v = runValidate({ tx, sourceSatoshis: sats, lockingScript: lock, unlockingScript: unlock })
  stats.validateMs.push(v.ms)
  if (v.ok && nobleOk && mod(f.s * f.sInv, P256_N) === 1n) stats.pass++
  else {
    stats.fail++
    failures.push({ i, stage: 'validate', ok: v.ok, mode: v.mode, pc: v.pc, err: v.err, nobleOk, sInvOk: mod(f.s * f.sInv, P256_N) === 1n, priv: hex(priv), qHex, sats: sats.toString(), lockTime, sourceTXID, vout, outputs: outputs.map(o => ({ satoshis: o.satoshis, kind: o.kind, script: o.lockingScript.toHex() })), txHex: tx.toHex(), unlockHex: unlock.toHex(), r: f.r.toString(16), s: f.s.toString(16), sInv: f.sInv.toString(16), lockHex: lock.toHex() })
    console.log(`  iter ${i}: FAIL ${v.mode} pc=${v.pc} ${v.err ?? ''}`)
  }
  if ((i + 1) % 50 === 0) console.log(`  ${i + 1}/${ITER} done, pass=${stats.pass} fail=${stats.fail} screened=${stats.pushTxScreened} (${((performance.now() - tAll) / 1000).toFixed(1)} s)`)
}
const summ = arr => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); const mean = arr.reduce((a, b) => a + b, 0) / arr.length; return { n: arr.length, mean: +mean.toFixed(2), median: +s[Math.floor(s.length / 2)].toFixed(2), min: +s[0].toFixed(2), max: +s[s.length - 1].toFixed(2), p95: +s[Math.floor(s.length * 0.95)].toFixed(2) } }
const timing = { validateMs: summ(stats.validateMs), buildLockMs: summ(stats.buildLockMs), buildUnlockMs: summ(stats.buildUnlockMs), totalFuzzSec: +((performance.now() - tAll) / 1000).toFixed(1) }
console.log(`fuzz done: iterations=${stats.iterations} pass=${stats.pass} fail=${stats.fail} pushTxScreened=${stats.pushTxScreened}`)
console.log('timing:', JSON.stringify(timing))
console.log('census:', JSON.stringify({ outputsHist: stats.outputsHist, lockTimeNonZero: stats.lockTimeNonZero, scriptKinds: stats.scriptKinds, pushLens: stats.pushLens, lockBytes: [stats.lockBytesMin, stats.lockBytesMax], unlockBytes: stats.unlockBytes, satsMax: stats.satsMax.toString(), nobleVerifyAgree: stats.nobleVerifyAgree }))
fs.writeFileSync(`${S}/fuzz-failures.json`, JSON.stringify(failures, null, 2))
console.log(`wrote ${S}/fuzz-failures.json (${failures.length} entries)`)

// ───────────────────────────── negative tests ─────────────────────────────
console.log('\nnegative tests (each MUST fail: validate() throws or returns false)')
const neg = []
const negCheck = (name, v, expectFail = true, extra = {}) => {
  const failed = !v.ok
  const okTest = expectFail ? failed : v.ok
  const row = { name, expected: expectFail ? 'FAIL' : 'PASS', result: v.mode, pc: v.pc, err: v.err, testOk: okTest, ...extra }
  neg.push(row)
  console.log(`${okTest ? 'OK  ' : 'BAD '} ${name} :: ${v.mode}${v.pc != null ? ' pc=' + v.pc : ''}${v.err ? ' "' + v.err + '"' : ''}${Object.keys(extra).length ? ' ' + JSON.stringify(extra) : ''}`)
}
// base case: fresh key/lock/tx that validates (retry outputs if the PUSH_TX screen fires)
const priv1 = p256.utils.randomSecretKey(), q1 = hex(p256.getPublicKey(priv1, true)), Q1 = p256.Point.fromHex(q1)
const priv2 = p256.utils.randomSecretKey(), q2 = hex(p256.getPublicKey(priv2, true)), Q2 = p256.Point.fromHex(q2)
const bSats = randBig(1n, 1n << 40n), bLockTime = 0
const lock1 = buildLock({ qCompressedHex: q1, satoshis: bSats, lockTime: bLockTime })
const lock2 = buildLock({ qCompressedHex: q2, satoshis: bSats, lockTime: bLockTime })
const bTXID = hex(randBytes(32)), bVout = randInt(0, 5)
let bTx, bUnlock
for (let a = 0; a < 20 && !bUnlock; a++) {
  bTx = mkTx({ lockTime: bLockTime, sourceTXID: bTXID, vout: bVout, outputs: randomOutputs(bSats) })
  try { bUnlock = buildUnlock({ tx: bTx, inputIndex: 0, sourceSatoshis: bSats, lockingScript: lock1, p256PrivateKey: priv1 }) } catch (e) { if (!e.code) throw e }
}
const base = { tx: bTx, sourceSatoshis: bSats, lockingScript: lock1 }
const bF = decodeUnlock(bUnlock)
const bPre = realPreimage({ tx: bTx, sourceSatoshis: bSats })
negCheck('control: base spend validates', runValidate({ ...base, unlockingScript: bUnlock }), false, { sats: bSats.toString(), outputs: bTx.outputs.length })
// helper: does the P-256 leg pass and CHECKSIG fail (OP_PUSH_TX binding), or does the P-256 leg itself fail?
const where = (args) => { const p = checksigProbe(args); return p.reached ? (p.checksigTop === '' ? 'P-256 leg PASSED, OP_CHECKSIG returned false' : 'P-256 leg passed, OP_CHECKSIG true') : `P-256 leg (or earlier) failed at pc ${p.pc}: ${p.err}` }
const withUnlock = (u) => ({ ...base, unlockingScript: u })

// 1. tampered s (s+1), sInv untouched
{ const u = encodeUnlock({ ...bF, s: bF.s + 1n }); negCheck('tampered s (s+1), original sInv', runValidate(withUnlock(u)), true, { where: where(withUnlock(u)) }) }
// 1b. tampered s (s+1) with a CONSISTENT sInv = (s+1)^-1 (gets past NUMEQUALVERIFY; must fail the R.x == r check)
{ const s2 = bF.s + 1n; const u = encodeUnlock({ ...bF, s: s2, sInv: modinv(s2, P256_N) }); negCheck('tampered s (s+1) with consistent sInv', runValidate(withUnlock(u)), true, { where: where(withUnlock(u)) }) }
// 2. tampered sInv (sInv+1)
{ const u = encodeUnlock({ ...bF, sInv: bF.sInv + 1n }); negCheck('tampered sInv (sInv+1)', runValidate(withUnlock(u)), true, { where: where(withUnlock(u)) }) }
// 2b. tampered r (+1) (control from unlock.mjs)
{ const u = encodeUnlock({ ...bF, r: bF.r + 1n }); negCheck('tampered r (r+1)', runValidate(withUnlock(u)), true, { where: where(withUnlock(u)) }) }
// 3a. wrong outpoint push, original signature
{ const u = encodeUnlock({ ...bF, outpoint: randBytes(36) }); negCheck('wrong outpoint in unlock, original signature', runValidate(withUnlock(u)), true, { where: where(withUnlock(u)) }) }
// 3b. wrong outpoint: key holder SIGNS the wrong-outpoint preimage (P-256 leg must pass; OP_PUSH_TX must catch it)
{
  const txW = mkTx({ lockTime: bLockTime, sourceTXID: hex(randBytes(32)), vout: bVout, outputs: bTx.outputs.map(o => ({ satoshis: o.satoshis, lockingScript: o.lockingScript })) })
  const preW = realPreimage({ tx: txW, sourceSatoshis: bSats })
  const u = manualUnlock({ preimageToSign: preW, priv: priv1, Q: Q1 })
  const inScript = inScriptPreimage(withUnlock(u))
  negCheck('wrong outpoint, signed by key holder (OP_PUSH_TX binding)', runValidate(withUnlock(u)), true, { where: where(withUnlock(u)), inScriptPreimageEqualsSigned: hex(inScript) === hex(preW), inScriptPreimageEqualsReal: hex(inScript) === hex(bPre) })
}
// 4a. wrong hashOutputs: signer signs a DIFFERENT output set than the tx has (P-256 passes; OP_PUSH_TX must catch it)
{
  let txO, preO
  do { txO = mkTx({ lockTime: bLockTime, sourceTXID: bTXID, vout: bVout, outputs: randomOutputs(bSats) }); preO = realPreimage({ tx: txO, sourceSatoshis: bSats }) } while (hex(preO) === hex(bPre))
  const u = manualUnlock({ preimageToSign: preO, priv: priv1, Q: Q1 })
  const inScript = inScriptPreimage(withUnlock(u))
  negCheck('wrong hashOutputs: signed a different output set (OP_PUSH_TX binding)', runValidate(withUnlock(u)), true, { where: where(withUnlock(u)), inScriptPreimageEqualsSigned: hex(inScript) === hex(preO), hashOutputsDiffer: hex(preO.slice(118, 150)) !== hex(bPre.slice(118, 150)) })
}
// 4b. wrong hashOutputs push, original signature
{ const u = encodeUnlock({ ...bF, hashOutputs: randBytes(32) }); negCheck('wrong hashOutputs in unlock, original signature', runValidate(withUnlock(u)), true, { where: where(withUnlock(u)) }) }
// 5. signature from a different key (lock for Q1, unlock is a fully well-formed Q2 unlock)
{
  const u = manualUnlock({ preimageToSign: bPre, priv: priv2, Q: Q2 })
  negCheck('signature from a different key (Q2 sig vs Q1 lock)', runValidate(withUnlock(u)), true, { where: where(withUnlock(u)) })
  negCheck('  control: that same Q2 unlock validates against a Q2 lock', runValidate({ ...base, lockingScript: lock2, unlockingScript: u }), false)
}
// 6a. table from a different key: Q1 lock with Q2's comb table spliced into chunks 151..214, signed by Q1
{
  const chunks = lock1.chunks.map(c => ({ ...c }))
  const t2 = combTable(Q2)
  for (let j = 0; j < 32; j++) { chunks[151 + 2 * j] = { op: scriptNum(t2[j].x).length, data: scriptNum(t2[j].x) }; chunks[152 + 2 * j] = { op: scriptNum(t2[j].y).length, data: scriptNum(t2[j].y) } }
  const spliced = new LockingScript(chunks)
  const splicedMatchesLock2 = hex(spliced.chunks.slice(151, 215).flatMap(c => c.data)) === hex(lock2.chunks.slice(151, 215).flatMap(c => c.data))
  negCheck('table from a different key (Q1 lock, Q2 table spliced, Q1 signature)', runValidate({ ...base, lockingScript: spliced, unlockingScript: bUnlock }), true, { where: where({ ...base, lockingScript: spliced, unlockingScript: bUnlock }), splicedTableEqualsLock2Table: splicedMatchesLock2 })
  // 6b. same thing generated the other way round: buildLock(Q2) spent with a Q1 signature
  negCheck('table from a different key (buildLock(Q2), Q1 signature)', runValidate({ ...base, lockingScript: lock2, unlockingScript: bUnlock }), true, { where: where({ ...base, lockingScript: lock2, unlockingScript: bUnlock }) })
}
// 7. sequence != 0xffffffff on the input
for (const seq of [0xfffffffe, 0]) {
  const txS = mkTx({ lockTime: bLockTime, sourceTXID: bTXID, vout: bVout, sequence: seq, outputs: bTx.outputs.map(o => ({ satoshis: o.satoshis, lockingScript: o.lockingScript })) })
  let guard = null; try { buildUnlock({ tx: txS, inputIndex: 0, sourceSatoshis: bSats, lockingScript: lock1, p256PrivateKey: priv1 }) } catch (e) { guard = e.message }
  // (a) honest signature over the REAL preimage (which carries the real sequence)
  const preS = realPreimage({ tx: txS, sourceSatoshis: bSats })
  const ua = manualUnlock({ preimageToSign: preS, priv: priv1, Q: Q1 })
  negCheck(`sequence 0x${seq.toString(16)}: signed the real preimage`, runValidate({ tx: txS, sourceSatoshis: bSats, lockingScript: lock1, unlockingScript: ua }), true, { where: where({ tx: txS, sourceSatoshis: bSats, lockingScript: lock1, unlockingScript: ua }), buildUnlockGuard: guard })
  // (b) signature over the in-script preimage (baked ffffffff) -> P-256 passes, OP_PUSH_TX must catch it
  const ub = manualUnlock({ preimageToSign: bPre, priv: priv1, Q: Q1 })
  const args = { tx: txS, sourceSatoshis: bSats, lockingScript: lock1, unlockingScript: ub }
  negCheck(`sequence 0x${seq.toString(16)}: signed the in-script (baked ffffffff) preimage`, runValidate(args), true, { where: where(args), inScriptPreimageEqualsSigned: hex(inScriptPreimage(args)) === hex(bPre), realPreimageDiffersAt: diffFields(bPre, preS) })
}
// 8. a spend tx with TWO inputs (our lock at input 0; a second unrelated input)
{
  const extra = { sourceTXID: hex(randBytes(32)), vout: randInt(0, 5), sequence: 0xffffffff }
  const tx2 = mkTx({ lockTime: bLockTime, sourceTXID: bTXID, vout: bVout, outputs: bTx.outputs.map(o => ({ satoshis: o.satoshis, lockingScript: o.lockingScript })), extraInputs: [extra] })
  let guard = null; try { buildUnlock({ tx: tx2, inputIndex: 0, sourceSatoshis: bSats, lockingScript: lock1, p256PrivateKey: priv1 }) } catch (e) { guard = e.message }
  const pre2 = realPreimage({ tx: tx2, sourceSatoshis: bSats })
  // confirm WHY: real hashPrevouts = hash256(op0||op1), real hashSequence = hash256(ffffffff ffffffff); in-script uses single-input versions
  const op = (txid, vout) => [...bytesOf(txid).reverse(), ...(() => { const w = new Utils.Writer(); w.writeUInt32LE(vout); return w.toArray() })()]
  const op0 = op(bTXID, bVout), op1 = op(extra.sourceTXID, extra.vout)
  const hp2 = hex(Hash.hash256([...op0, ...op1])), hp2rev = hex(Hash.hash256([...op1, ...op0])), hp1 = hex(Hash.hash256(op0))
  const hs2 = hex(Hash.hash256([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])), hs1 = hex(Hash.hash256([0xff, 0xff, 0xff, 0xff]))
  const why = { realHashPrevouts_is_hash256_op0_op1: hex(pre2.slice(4, 36)) === hp2, realHashPrevouts_is_hash256_op1_op0: hex(pre2.slice(4, 36)) === hp2rev, inScriptHashPrevouts_is_hash256_op0: hex(bPre.slice(4, 36)) === hp1, realHashSequence_is_hash256_ff8: hex(pre2.slice(36, 68)) === hs2, inScriptHashSequence_is_hash256_ff4: hex(bPre.slice(36, 68)) === hs1, fieldsDiffering: diffFields(bPre, pre2) }
  // (a) honest signature over the real 2-input preimage
  const ua = manualUnlock({ preimageToSign: pre2, priv: priv1, Q: Q1 })
  negCheck('two inputs: signed the real 2-input preimage', runValidate({ tx: tx2, sourceSatoshis: bSats, lockingScript: lock1, unlockingScript: ua }), true, { where: where({ tx: tx2, sourceSatoshis: bSats, lockingScript: lock1, unlockingScript: ua }), buildUnlockGuard: guard })
  // (b) signature over the in-script (single-input) preimage -> P-256 passes, OP_PUSH_TX must catch it
  const ub = manualUnlock({ preimageToSign: bPre, priv: priv1, Q: Q1 })
  const args = { tx: tx2, sourceSatoshis: bSats, lockingScript: lock1, unlockingScript: ub }
  negCheck('two inputs: signed the in-script (single-input) preimage', runValidate(args), true, { where: where(args), inScriptPreimageEqualsSigned: hex(inScriptPreimage(args)) === hex(bPre), ...why })
  // (c) our lock at input index 1 instead
  const tx2b = mkTx({ lockTime: bLockTime, sourceTXID: extra.sourceTXID, vout: extra.vout, outputs: bTx.outputs.map(o => ({ satoshis: o.satoshis, lockingScript: o.lockingScript })), extraInputs: [{ sourceTXID: bTXID, vout: bVout }] })
  const pre2b = realPreimage({ tx: tx2b, inputIndex: 1, sourceSatoshis: bSats })
  const uc = manualUnlock({ preimageToSign: pre2b, priv: priv1, Q: Q1 })
  negCheck('two inputs, lock at input 1: signed the real preimage', runValidate({ tx: tx2b, inputIndex: 1, sourceSatoshis: bSats, lockingScript: lock1, unlockingScript: uc }), true, { where: where({ tx: tx2b, inputIndex: 1, sourceSatoshis: bSats, lockingScript: lock1, unlockingScript: uc }) })
  const ud = manualUnlock({ preimageToSign: [...bPre.slice(0, 68), ...pre2b.slice(68, 104), ...bPre.slice(104)], priv: priv1, Q: Q1, outpointPush: pre2b.slice(68, 104) })
  const argsD = { tx: tx2b, inputIndex: 1, sourceSatoshis: bSats, lockingScript: lock1, unlockingScript: ud }
  // in-script preimage for input 1 = hashPrevouts(op1 only) || hashSeq(ff4) || op1 || ... ; build exactly that and sign it
  const inS1 = inScriptPreimage(argsD)
  const ue = manualUnlock({ preimageToSign: inS1, priv: priv1, Q: Q1 })
  const argsE = { ...argsD, unlockingScript: ue }
  negCheck('two inputs, lock at input 1: signed the in-script preimage', runValidate(argsE), true, { where: where(argsE), inScriptPreimageEqualsSigned: hex(inScriptPreimage(argsE)) === hex(inS1) })
}
// extras (not requested; cheap and informative)
// E1. tx.lockTime != baked (honest sig over the real preimage, and sig over the in-script preimage)
{
  const txL = mkTx({ lockTime: 777777, sourceTXID: bTXID, vout: bVout, outputs: bTx.outputs.map(o => ({ satoshis: o.satoshis, lockingScript: o.lockingScript })) })
  const preL = realPreimage({ tx: txL, sourceSatoshis: bSats })
  const ua = manualUnlock({ preimageToSign: preL, priv: priv1, Q: Q1 })
  negCheck('extra: lockTime != baked, signed real preimage', runValidate({ tx: txL, sourceSatoshis: bSats, lockingScript: lock1, unlockingScript: ua }), true, { where: where({ tx: txL, sourceSatoshis: bSats, lockingScript: lock1, unlockingScript: ua }) })
  const ub = manualUnlock({ preimageToSign: bPre, priv: priv1, Q: Q1 })
  negCheck('extra: lockTime != baked, signed in-script preimage', runValidate({ tx: txL, sourceSatoshis: bSats, lockingScript: lock1, unlockingScript: ub }), true, { where: where({ tx: txL, sourceSatoshis: bSats, lockingScript: lock1, unlockingScript: ub }) })
}
// E2. UTXO value != baked satoshis (the real sighash amount differs from the in-script one)
{
  const ub = manualUnlock({ preimageToSign: bPre, priv: priv1, Q: Q1 })
  const args = { tx: bTx, sourceSatoshis: bSats + 1n, lockingScript: lock1, unlockingScript: ub }
  negCheck('extra: sourceSatoshis != baked, signed in-script preimage', runValidate(args), true, { where: where(args) })
}
// E3. tx version 2 against a version-1-baked lock
{
  const txV = mkTx({ lockTime: bLockTime, sourceTXID: bTXID, vout: bVout, outputs: bTx.outputs.map(o => ({ satoshis: o.satoshis, lockingScript: o.lockingScript })), version: 2 })
  const ub = manualUnlock({ preimageToSign: bPre, priv: priv1, Q: Q1 })
  const args = { tx: txV, sourceSatoshis: bSats, lockingScript: lock1, unlockingScript: ub }
  negCheck('extra: tx version 2 vs baked version 1, signed in-script preimage', runValidate(args), true, { where: where(args) })
}
// E4. empty / missing unlock pushes
{
  negCheck('extra: empty unlocking script', runValidate(withUnlock(new UnlockingScript())), true)
  negCheck('extra: 4 pushes only (outpoint missing)', runValidate(withUnlock(UnlockingScript.fromBinary([...encNum(bF.r), ...encNum(bF.s), ...encNum(bF.sInv), ...pushData(bF.hashOutputs)]))), true)
}

function diffFields (a, b) {
  const F = [['version', 0, 4], ['hashPrevouts', 4, 36], ['hashSequence', 36, 68], ['outpoint', 68, 104], ['scriptCode', 104, 106], ['amount', 106, 114], ['sequence', 114, 118], ['hashOutputs', 118, 150], ['lockTime', 150, 154], ['sighash', 154, 158]]
  return F.filter(([, s, e]) => hex(a.slice(s, e)) !== hex(b.slice(s, e))).map(([n]) => n)
}

const negBad = neg.filter(r => !r.testOk)
console.log(`\nnegative tests: ${neg.length} run, ${negBad.length} unexpected outcome(s)`)
fs.writeFileSync(`${S}/fuzz-report.json`, JSON.stringify({ iterations: stats.iterations, pass: stats.pass, fail: stats.fail, pushTxScreened: stats.pushTxScreened, timing, census: { outputsHist: stats.outputsHist, lockTimeNonZero: stats.lockTimeNonZero, scriptKinds: stats.scriptKinds, pushLens: stats.pushLens, lockBytes: [stats.lockBytesMin, stats.lockBytesMax], unlockBytes: stats.unlockBytes, satsMax: stats.satsMax.toString(), nobleVerifyAgree: stats.nobleVerifyAgree }, negatives: neg }, null, 2))
console.log(`wrote ${S}/fuzz-report.json`)
process.exitCode = failures.length === 0 && negBad.length === 0 ? 0 : 1
