// edge.mjs — END-TO-END edge-case investigation of the OP_PUSH_TX tail (and the
// P-256 signature-encoding edges) of the R1 comb-verifier locking script.
//
// The tail computes, from the in-script BIP143 preimage:
//   e_k1 = BE(hash256(preimage))              (big-endian 256-bit)
//   m    = e_k1 + 2^248
//   s    = m > (n-1)/2 ? ( (m mod n) > (n-1)/2 ? n-(m mod n) : (m mod n) ) : m   [low-S]
//   DER  = 30 <len> 02 20 Gx 02 <slen> <BE(s)> || sighash            (k=1 secp256k1)
// s is encoded by peeling the on-stack LE scriptnum of s one byte at a time with
//   (DUP 0NOTEQUAL SPLIT) x31 and reversing -> big-endian minimal DER integer.
//
// This file:
//  (A) classifies >= 3000 (default 400k) random preimages by e-class, measures freq;
//  (B) runs the REAL Spend.validate() on a representative of every class + a random
//      sample, cross-checking the JS predicate against the interpreter's verdict;
//  (C) P-256 side: r>=2^255, r<2^248, s<2^248, and high-S vs low-S both accepted.
//
// Run:  node edge.mjs           (defaults)
//       CLASSN=600000 node edge.mjs
import fs from 'fs'
import { LockingScript, Transaction, Spend, Hash, Utils, OP, Script, PrivateKey, P2PKH, MerklePath } from '@bsv/sdk'
import { p256 } from '@noble/curves/nist.js'
import { buildLock, scriptNum, encNum, SECP_N, SECP_GX, P256_N, P256_P } from './gen.mjs'
import { buildUnlock, buildUnlockAsync, sighashPreimage, pushTxSignature, pushTxDerCheck,
         peelLoopNonMinimalAt, encodeUnlock, decodeUnlock, fullR, signerDigest } from './unlock.mjs'

const hex = a => Buffer.from(a).toString('hex')
const bytesOf = h => [...Buffer.from(h, 'hex')]
const mod = (a, m) => ((a % m) + m) % m
const modinv = (a, m) => { let [g,x,y]=[a%m,1n,0n],[b,u,v]=[m,0n,1n]; while(g){const q=b/g;[b,g]=[g,b-q*g];[u,x]=[x,u-q*x];[v,y]=[y,v-q*y]} return mod(u,m) }
const beToBig = b => BigInt('0x' + (hex(b) || '0'))
const HALF = (SECP_N - 1n) / 2n
const N2 = SECP_N / 2n            // == (n-1)/2 for odd n; matches OP_DIV(n,2)

// ───────────── serialize outputs exactly like the SDK hashOutputs ─────────────
function serializeOutputs (outs) {
  const w = new Utils.Writer()
  for (const o of outs) { w.writeUInt64LE(Number(o.satoshis)); const sb = o.lockingScript.toBinary(); w.writeVarIntNum(sb.length); w.write(sb) }
  return w.toArray()
}

// ───────────── a validatable "deposit + spend" harness ─────────────
// Build one lock from a known P-256 key so we can actually sign.
const priv = p256.utils.randomSecretKey()
const qHex = hex(p256.getPublicKey(priv, true))
const SATS = 500000
const LOCKTIME = 0
const lock = buildLock({ qCompressedHex: qHex, satoshis: SATS, lockTime: LOCKTIME })
// a "mined" source tx that pays the lock at vout 0
const src = new Transaction()
src.addOutput({ satoshis: SATS, lockingScript: lock })
src.merklePath = MerklePath.fromCoinbaseTxidAndHeight(src.id('hex'), 1755177)
const DEST = new P2PKH().lock(PrivateKey.fromRandom().toAddress())

// Deterministic spending tx for a search index i: 1 P2PKH output whose amount and a
// trailing OP_RETURN nonce both vary with i -> a fresh hashOutputs (hence fresh e) each i.
function makeTx (i, lockTime = LOCKTIME) {
  const tx = new Transaction(1, [], [], lockTime)
  tx.addInput({ sourceTransaction: src, sourceOutputIndex: 0, sequence: 0xffffffff })
  tx.addOutput({ satoshis: SATS - 300 - (i % 200), lockingScript: DEST })
  const nonce = Buffer.alloc(8); nonce.writeBigUInt64LE(BigInt(i))
  tx.addOutput({ satoshis: 0, lockingScript: Script.fromBinary([OP.OP_FALSE, OP.OP_RETURN, 8, ...nonce]) })
  return tx
}

// Fast preimage for index i: reuse a reference preimage, swap in hashOutputs[118..150].
const refTx = makeTx(0)
const refPre = sighashPreimage({ tx: refTx, inputIndex: 0, sourceSatoshis: SATS })
if (refPre.length !== 158) throw new Error('preimage len ' + refPre.length)
const PRE_PREFIX = refPre.slice(0, 118)
const PRE_SUFFIX = refPre.slice(150, 158)
// Fast serialize-outputs template that must reproduce makeTx(i).outputs byte-for-byte.
const DEST_BIN = DEST.toBinary()
const OUT_TMPL = [
  0, 0, 0, 0, 0, 0, 0, 0,               // [0..8)  out0 amount LE (patched)
  DEST_BIN.length, ...DEST_BIN,          // out0 script (varint len + P2PKH)
  0, 0, 0, 0, 0, 0, 0, 0,               // out1 amount = 0
  11, OP.OP_FALSE, OP.OP_RETURN, 8,      // out1 script varint(11) + OP_FALSE OP_RETURN PUSH8
  0, 0, 0, 0, 0, 0, 0, 0                // nonce (patched)
]
const NONCE_OFF = OUT_TMPL.length - 8
function fastOutputsBytes (i) {
  const b = OUT_TMPL.slice()
  let amt = BigInt(SATS - 300 - (i % 200))
  for (let k = 0; k < 8; k++) { b[k] = Number(amt & 0xffn); amt >>= 8n }
  let n = BigInt(i)
  for (let k = 0; k < 8; k++) { b[NONCE_OFF + k] = Number(n & 0xffn); n >>= 8n }
  return b
}
function preimageFor (i) {
  const ho = Hash.hash256(fastOutputsBytes(i))
  return [...PRE_PREFIX, ...ho, ...PRE_SUFFIX]
}
// sanity: fast path == real path (and fast outputs == real serialized outputs) for several indices
for (const i of [0, 1, 7, 99, 12345, 205890, 3000000]) {
  const real = sighashPreimage({ tx: makeTx(i), inputIndex: 0, sourceSatoshis: SATS })
  if (hex(fastOutputsBytes(i)) !== hex(serializeOutputs(makeTx(i).outputs))) throw new Error('fast outputs mismatch at i=' + i)
  if (hex(preimageFor(i)) !== hex(real)) throw new Error('fast preimage mismatch at i=' + i)
}

// ───────────── e-class computation (pure JS model, matches the script) ─────────────
function classify (pre) {
  const e = beToBig(Hash.hash256(pre))
  const m = e + (1n << 248n)
  const wrap = m >= SECP_N
  const t = wrap ? m - SECP_N : m
  const lowS = m > N2 && t > N2          // inner low-S SUB only reachable inside outer IF
  const s = m <= N2 ? m : (t > N2 ? SECP_N - t : t)
  const sLE = scriptNum(s)
  const signByte = sLE.length > 0 && sLE[sLE.length - 1] === 0x00   // trailing 0x00 sign byte
  const peelK = peelLoopNonMinimalAt(sLE)
  const sZero = s === 0n
  const peelFail = peelK >= 0
  return {
    e, m, wrap, t, lowS, s,
    sLen: sLE.length,
    signByte,
    sLt2_248: s < (1n << 248n),
    sGe2_255: s >= (1n << 255n),
    sZero,
    peelFail,
    peelK,
    okPredicate: !(peelFail || sZero)          // == pushTxDerCheck(pre).ok (asserted once below)
  }
}
// one-time assertion that the inline predicate equals the library pushTxDerCheck
for (const i of [0, 1, 175, 205890, 219]) {
  const c = classify(preimageFor(i))
  if (c.okPredicate !== pushTxDerCheck(preimageFor(i)).ok) throw new Error('predicate/pushTxDerCheck disagree at i=' + i)
}

// ───────────── real interpreter run ─────────────
function validateAtIndex (i, { forceBuild = true, lockTime = LOCKTIME } = {}) {
  const tx = makeTx(i, lockTime)
  let unlock, buildErr = null
  try {
    unlock = buildUnlock({ tx, inputIndex: 0, sourceSatoshis: SATS, lockingScript: lock, p256PrivateKey: priv, skipPushTxCheck: forceBuild })
  } catch (e) { buildErr = e }
  if (!unlock) return { built: false, buildErr: buildErr?.code || buildErr?.message?.split('\n')[0] }
  const inp = tx.inputs[0]
  const sp = new Spend({
    sourceTXID: inp.sourceTransaction.id('hex'), sourceOutputIndex: 0, sourceSatoshis: SATS,
    lockingScript: lock, transactionVersion: tx.version, otherInputs: [], outputs: tx.outputs,
    unlockingScript: unlock, inputSequence: inp.sequence, inputIndex: 0, lockTime: tx.lockTime
  })
  let ok = false, err = null
  try { ok = sp.validate() } catch (e) { err = e.message.split('\n')[0] }
  const f = decodeUnlock(unlock)
  return { built: true, ok, pc: sp.programCounter, err, rBytes: encNum(f.r).length - 1, sBytes: encNum(f.s).length - 1, sInvBytes: encNum(f.sInv).length - 1 }
}

// ══════════════════════════════════════════════════════════════════════════
// PART A: classify a large random sample
// ══════════════════════════════════════════════════════════════════════════
const CLASSN = Number(process.env.CLASSN ?? 400000)
console.log(`\n=== PART A: classifying ${CLASSN} random preimages (fixed lock, varying outputs) ===`)
const tally = {
  total: 0,
  bulk_noBranch: 0,          // m <= (n-1)/2 : s = m  (no low-S, no wrap)
  a_lowS: 0,                 // m in ((n-1)/2, n) : s = n - m
  d_wrap: 0,                 // m >= n : s = m - n
  b_sLt2_248: 0,
  c_sGe2_255: 0,
  peelFail: 0,
  sZero: 0,
  signByte32: 0,             // trailing 0x00 sign byte but 32-byte scriptnum (peel OK, DER pad)
  predicateFail: 0
}
// keep the first index that produced each interesting class
const rep = {}   // className -> index
const t0 = Date.now()
for (let i = 0; i < CLASSN; i++) {
  const c = classify(preimageFor(i))
  tally.total++
  if (c.m <= N2) tally.bulk_noBranch++
  else if (!c.wrap) tally.a_lowS++
  else tally.d_wrap++
  if (c.sLt2_248) tally.b_sLt2_248++
  if (c.sGe2_255) tally.c_sGe2_255++
  if (c.peelFail) tally.peelFail++
  if (c.sZero) tally.sZero++
  if (c.signByte && c.sLen === 32) tally.signByte32++
  if (!c.okPredicate) tally.predicateFail++
  // capture representatives
  if (c.m <= N2 && rep.bulk === undefined) rep.bulk = i
  if (c.lowS && !c.wrap && rep.a_lowS === undefined) rep.a_lowS = i
  if (c.wrap && rep.d_wrap === undefined) rep.d_wrap = i
  if (c.sLt2_248 && !c.peelFail && rep.b_sLt2_248_ok === undefined) rep.b_sLt2_248_ok = i
  if (c.peelFail && rep.peelFail === undefined) rep.peelFail = i
  if (c.signByte && c.sLen === 32 && rep.signByte32 === undefined) rep.signByte32 = i
  if (c.wrap && c.sLt2_248 && rep.wrap_small === undefined) rep.wrap_small = i
}
const dt = Date.now() - t0
console.log(`classified in ${dt} ms (${(dt / CLASSN * 1000).toFixed(1)} us/preimage)`)
const pct = n => (n / tally.total * 100).toFixed(4) + '%'
const oneIn = n => n === 0 ? '—' : '1/' + Math.round(tally.total / n)
console.log('\nclass frequencies:')
console.log(`  bulk (m<=(n-1)/2, s=m, no branch)   ${tally.bulk_noBranch}\t${pct(tally.bulk_noBranch)}`)
console.log(`  (a) low-S branch  (s=n-(e+2^248))    ${tally.a_lowS}\t${pct(tally.a_lowS)}`)
console.log(`  (d) wraparound    (e+2^248>=n)       ${tally.d_wrap}\t${pct(tally.d_wrap)}\t${oneIn(tally.d_wrap)}`)
console.log(`  (b) s < 2^248                        ${tally.b_sLt2_248}\t${pct(tally.b_sLt2_248)}\t${oneIn(tally.b_sLt2_248)}`)
console.log(`  (c) s >= 2^255                       ${tally.c_sGe2_255}\t${pct(tally.c_sGe2_255)}   (expected 0: unreachable, (n-1)/2 < 2^255)`)
console.log(`  PEEL-NONMINIMAL fail                 ${tally.peelFail}\t${pct(tally.peelFail)}\t${oneIn(tally.peelFail)}`)
console.log(`  s == 0                               ${tally.sZero}\t${pct(tally.sZero)}`)
console.log(`  sign-byte but 32B scriptnum (OK)     ${tally.signByte32}\t${pct(tally.signByte32)}`)
console.log(`  predicate says FAIL (peel or sZero)  ${tally.predicateFail}\t${pct(tally.predicateFail)}\t${oneIn(tally.predicateFail)}`)
console.log('representatives found:', JSON.stringify(rep))

// ══════════════════════════════════════════════════════════════════════════
// PART B: run the REAL interpreter on a representative of each class + verify
//         JS predicate agrees with the interpreter verdict.
// ══════════════════════════════════════════════════════════════════════════
// Guarantee a PEEL-NONMINIMAL representative even if the random run was unlucky:
// keep hashing (cheap) past CLASSN until one is found.
if (rep.peelFail === undefined) {
  process.stdout.write('  (searching further for a PEEL-NONMINIMAL preimage...) ')
  for (let i = CLASSN; i < CLASSN + 4000000; i++) {
    if (classify(preimageFor(i)).peelFail) { rep.peelFail = i; break }
  }
  console.log(rep.peelFail !== undefined ? `found at i=${rep.peelFail}` : 'NONE in +4M')
}

// step a Spend to a given locking-script programCounter (chunk index)
function stepToPc (sp, pc) { let n = 0; while (!(sp.context === 'LockingScript' && sp.programCounter === pc)) { sp.step(); if (++n > 2e6) throw new Error('stepTo overflow') } return sp }

// Byte-exact confirmation: the DER signature the REAL script assembles on the stack (item
// just below the pubkey, right before the final OP_CHECKSIG) equals JS pushTxSignature(preimage).
function derExactCheck (i) {
  const tx = makeTx(i)
  const unlock = buildUnlock({ tx, inputIndex: 0, sourceSatoshis: SATS, lockingScript: lock, p256PrivateKey: priv, skipPushTxCheck: true })
  const inp = tx.inputs[0]
  const sp = new Spend({
    sourceTXID: inp.sourceTransaction.id('hex'), sourceOutputIndex: 0, sourceSatoshis: SATS,
    lockingScript: lock, transactionVersion: tx.version, otherInputs: [], outputs: tx.outputs,
    unlockingScript: unlock, inputSequence: inp.sequence, inputIndex: 0, lockTime: tx.lockTime
  })
  const lastPc = lock.chunks.length - 1                 // OP_CHECKSIG
  if (lock.chunks[lastPc].op !== OP.OP_CHECKSIG) throw new Error('last chunk is not OP_CHECKSIG')
  let scriptSig = null, scriptErr = null
  try { stepToPc(sp, lastPc); scriptSig = sp.stack.at(-2) } catch (e) { scriptErr = e.message.split('\n')[0] }
  const pre = sighashPreimage({ tx, inputIndex: 0, sourceSatoshis: SATS })
  const jsSig = pushTxSignature(pre).sig
  return { i, scriptErr, match: scriptSig ? hex(scriptSig) === hex(jsSig) : false, scriptSigHex: scriptSig ? hex(scriptSig) : null, jsSigHex: hex(jsSig) }
}

console.log(`\n=== PART B: Spend.validate() on class representatives (interpreter is the oracle) ===`)
// byte-exact DER check across representatives spanning every class actually assembled
console.log('byte-exact: script-assembled DER signature == JS pushTxSignature(preimage):')
for (const [nm, idx] of [['bulk', rep.bulk], ['low-S', rep.a_lowS], ['wrap', rep.d_wrap], ['s<2^248', rep.b_sLt2_248_ok], ['signByte32', rep.signByte32]]) {
  if (idx === undefined) { console.log(`  ${nm}: n/a`); continue }
  const d = derExactCheck(idx)
  console.log(`  ${nm.padEnd(12)} i=${String(idx).padEnd(8)} match=${d.match}${d.scriptErr ? '  scriptErr=' + d.scriptErr : ''}`)
  if (!d.match && !d.scriptErr) console.log(`     script=${d.scriptSigHex}\n     js    =${d.jsSigHex}`)
}
// the peel-fail representative: confirm the interpreter aborts inside the peel loop
if (rep.peelFail !== undefined) {
  const d = derExactCheck(rep.peelFail)
  const c = classify(preimageFor(rep.peelFail))
  console.log(`  peelFail     i=${String(rep.peelFail).padEnd(8)} scriptErr=${d.scriptErr || '(none!)'}  (s=${c.s.toString(16)}, sLen=${c.sLen}, peelK=${c.peelK})`)
}
const bRows = []
function runClass (name, i, note = '') {
  if (i === undefined) { bRows.push({ name, i: '—', predicate: 'n/a', validates: 'NOT FOUND', pc: '', note }); return }
  const c = classify(preimageFor(i))
  const v = validateAtIndex(i)
  const agree = (v.ok === c.okPredicate)
  bRows.push({
    name, i,
    s_hex: c.s.toString(16),
    sLen: c.sLen, signByte: c.signByte, peelK: c.peelK,
    predicate: c.okPredicate ? 'OK' : (c.peelFail ? 'PEEL_FAIL' : c.sZero ? 'S_ZERO' : 'FAIL'),
    validates: v.built ? v.ok : ('BUILD:' + v.buildErr),
    pc: v.pc, err: v.err || '',
    agree,
    note
  })
}
runClass('bulk (s=m, no branch)', rep.bulk)
runClass('(a) low-S branch', rep.a_lowS)
runClass('(d) wraparound', rep.d_wrap)
runClass('(b) s<2^248 & peel-OK', rep.b_sLt2_248_ok)
runClass('(b/wrap) wrap & s<2^248', rep.wrap_small)
runClass('sign-byte, 32B (DER pad)', rep.signByte32)
runClass('PEEL-NONMINIMAL fail', rep.peelFail, 'expected to FAIL at pc ~22986')

// a random sample of 12 indices (whatever classes they land in) — all must satisfy agree
console.log('random-sample interpreter cross-check (predicate must match interpreter):')
let sampleMismatch = 0, sampleFail = 0
for (let k = 0; k < 12; k++) {
  const i = 1000000 + k * 7919
  const c = classify(preimageFor(i))
  const v = validateAtIndex(i)
  const agree = v.built && (v.ok === c.okPredicate)
  if (!agree) sampleMismatch++
  if (!v.ok) sampleFail++
  console.log(`  i=${i}  predicate=${c.okPredicate ? 'OK ' : 'FAIL'}  validates=${v.ok}  pc=${v.pc}  agree=${agree}${v.err ? '  ' + v.err : ''}`)
}

console.log('\nclass -> validates table:')
for (const r of bRows) {
  console.log(`  ${r.name.padEnd(28)} i=${String(r.i).padEnd(8)} predicate=${String(r.predicate).padEnd(10)} validates=${String(r.validates).padEnd(8)} pc=${String(r.pc ?? '').padEnd(6)} agree=${r.agree ?? ''} ${r.note}${r.err ? '  err=' + r.err : ''}`)
}

// ══════════════════════════════════════════════════════════════════════════
// PART C: P-256 signature-encoding edges
// ══════════════════════════════════════════════════════════════════════════
console.log(`\n=== PART C: P-256 side (r>=2^255, r<2^248, s<2^248, high-S vs low-S) ===`)
const Q = p256.Point.fromBytes(p256.getPublicKey(priv, true))
// helper: for index i, compute the P-256 signature and the FULL R.x that the unlock pushes as r.
function p256Info (i) {
  const pre = sighashPreimage({ tx: makeTx(i), inputIndex: 0, sourceSatoshis: SATS })
  const dg = signerDigest(pre)
  const e = beToBig(dg)
  const sig = p256.Signature.fromBytes(p256.sign(dg, priv, { prehash: false }), 'compact')
  const { x: Rx } = fullR({ e, r: sig.r, s: sig.s, Q })
  return { i, pre, e, sig, Rx, okPush: pushTxDerCheck(pre).ok }
}
// search indices for the desired r/s magnitude classes (only among push-tx-OK preimages so the
// tail never masks the P-256 result).
function search (predicate, max = 4000000) {
  for (let i = 3000000; i < 3000000 + max; i++) {
    const info = p256Info(i)
    if (!info.okPush) continue
    if (predicate(info)) return info
  }
  return null
}
const cRows = []
async function validateWithSig ({ i, r, s, note }) {
  // build an unlock with an explicit (r,s) via the external-signer path (fake signDigest)
  const tx = makeTx(i)
  const sigBytes = new p256.Signature(r, s).toBytes('compact')
  let unlock, buildErr = null
  try {
    unlock = await buildUnlockAsync({ tx, inputIndex: 0, sourceSatoshis: SATS, lockingScript: lock, Q, signDigest: () => sigBytes })
  } catch (e) { buildErr = e.message.split('\n')[0] }
  if (!unlock) { cRows.push({ note, i, built: false, err: buildErr }); return }
  const f = decodeUnlock(unlock)
  const inp = tx.inputs[0]
  const sp = new Spend({
    sourceTXID: inp.sourceTransaction.id('hex'), sourceOutputIndex: 0, sourceSatoshis: SATS,
    lockingScript: lock, transactionVersion: tx.version, otherInputs: [], outputs: tx.outputs,
    unlockingScript: unlock, inputSequence: inp.sequence, inputIndex: 0, lockTime: tx.lockTime
  })
  let ok = false, err = null
  try { ok = sp.validate() } catch (e) { err = e.message.split('\n')[0] }
  cRows.push({ note, i, built: true, ok, pc: sp.programCounter, err,
    r_hex: f.r.toString(16), s_hex: f.s.toString(16),
    rBytes: encNum(f.r).length - 1, sBytes: encNum(f.s).length - 1, sInvBytes: encNum(f.sInv).length - 1 })
}

// (1) r (= full R.x) >= 2^255  -> 33-byte r push
const rBig = search(o => o.Rx >= (1n << 255n))
if (rBig) await validateWithSig({ i: rBig.i, r: rBig.sig.r, s: rBig.sig.s, note: 'r=R.x >= 2^255 (33B r push)' })
else cRows.push({ note: 'r>=2^255', built: false, err: 'not found' })

// (2) r (= full R.x) < 2^248, genuinely short push (scriptnum <= 31 bytes)
const rSmall = search(o => scriptNum(o.Rx).length <= 31)
if (rSmall) await validateWithSig({ i: rSmall.i, r: rSmall.sig.r, s: rSmall.sig.s, note: 'r=R.x < 2^248 (short r push)' })
else cRows.push({ note: 'r<2^248', built: false, err: 'not found' })

// (3) P-256 s < 2^248 -> short s push (noble is low-S so s<=n/2; find a small one)
const sSmall = search(o => o.sig.s < (1n << 248n))
if (sSmall) await validateWithSig({ i: sSmall.i, r: sSmall.sig.r, s: sSmall.sig.s, note: 'P-256 s < 2^248 (short s push)' })
else cRows.push({ note: 's<2^248', built: false, err: 'not found' })

// (4) high-S vs low-S: same tx, low-S (noble default) and high-S (n - s). Both must validate.
const base = search(o => true)   // any push-tx-OK preimage
const lo = base.sig.s
const hi = P256_N - lo
console.log(`  base i=${base.i}: noble s low-S? ${lo <= P256_N / 2n} ; n-s high-S? ${hi > P256_N / 2n}`)
await validateWithSig({ i: base.i, r: base.sig.r, s: lo, note: 'P-256 low-S (noble default)' })
await validateWithSig({ i: base.i, r: base.sig.r, s: hi, note: 'P-256 high-S (n - s)' })

console.log('\nP-256 edge table:')
for (const r of cRows) {
  if (!r.built) { console.log(`  ${r.note.padEnd(34)} built=false  ${r.err ?? ''}`); continue }
  console.log(`  ${r.note.padEnd(34)} validates=${String(r.ok).padEnd(6)} pc=${String(r.pc).padEnd(6)} rB=${r.rBytes} sB=${r.sBytes} sInvB=${r.sInvBytes}${r.err ? '  err=' + r.err : ''}`)
}

console.log('\n=== DONE ===')
