// unlock.mjs — unlocker for the R1 (P-256) comb-verifier locking script produced by gen.mjs.
//
//   import { buildUnlock } from './unlock.mjs'
//   const unlockingScript = buildUnlock({ tx, inputIndex, sourceSatoshis, lockingScript, p256PrivateKey })
//
// Self-test:  node unlock.mjs
//
// Unlocking script = 5 pushes (bottom -> top): r, s, sInv, hashOutputs, outpoint.
//   r, s, sInv  minimal script numbers (BigNumber.toSm('little')): 33 bytes iff value >= 2^255, else <= 32 bytes
//   r           = FULL affine x-coordinate of R = u1*G + u2*Q (== the signature's r unless R.x >= n, then r + n)
//   sInv        = s^-1 mod n
//   hashOutputs = hash256(serialized outputs)            (32 raw bytes)
//   outpoint    = reverse(sourceTXID) || LE32(vout)      (36 raw bytes)
// The signer's digest is reverse(hash256(preimage)): the script reads e = unsigned-LE(hash256(preimage)).
import fs from 'fs'
import { UnlockingScript, LockingScript, Script, Transaction, TransactionSignature, Spend, Hash, Utils, OP, PrivateKey, P2PKH, MerklePath } from '@bsv/sdk'
import { p256 } from '@noble/curves/nist.js'
import { buildLock, encNum, pushData, scriptNum, combTable, bakedSatoshis, P256_N, P256_P, SECP_N, SECP_GX } from './gen.mjs'

const hex = a => Buffer.from(a).toString('hex')
const bytesOf = h => [...Buffer.from(h, 'hex')]
const mod = (a, m) => ((a % m) + m) % m
const modpow = (b, e, m) => { let r = 1n; b = mod(b, m); while (e > 0n) { if (e & 1n) r = r * b % m; b = b * b % m; e >>= 1n } return r }
const modinv = (a, m) => modpow(a, m - 2n, m)
const beToBig = b => BigInt('0x' + (hex(b) || '0'))
const leToBig = b => beToBig([...b].reverse())
const SUBSCRIPT = Script.fromHex('ac')                 // OP_CODESEPARATOR OP_CHECKSIG => scriptCode is just OP_CHECKSIG

/** Read the fields the locking script bakes into its in-script preimage (chunks 2, 5, 12, 18, 20). */
export function bakedParams (lockingScript) {
  const c = lockingScript.chunks
  const u32 = d => new Utils.Reader(d).readUInt32LE()
  if (!c[2]?.data || c[2].data.length !== 4 || !c[20]?.data || c[20].data.length !== 4) throw new Error('not an R1 comb-verifier locking script')
  return { version: u32(c[2].data), sequence: u32(c[5].data), satoshis: bakedSatoshis(lockingScript), lockTime: u32(c[18].data), sighash: u32(c[20].data) }
}

/** BIP143 sighash preimage exactly as the locking script rebuilds it (subscript = OP_CHECKSIG, scope from the lock). */
export function sighashPreimage ({ tx, inputIndex, sourceSatoshis, scope = 0x41 }) {
  const input = tx.inputs[inputIndex]
  if (input == null) throw new Error(`input ${inputIndex} does not exist`)
  const sourceTXID = input.sourceTXID ?? input.sourceTransaction?.id('hex')
  if (!sourceTXID) throw new Error('input needs sourceTXID or sourceTransaction')
  return Array.from(TransactionSignature.format({
    sourceTXID, sourceOutputIndex: input.sourceOutputIndex, sourceSatoshis: Number(sourceSatoshis),
    transactionVersion: tx.version, otherInputs: tx.inputs.filter((_, i) => i !== inputIndex), outputs: tx.outputs,
    inputIndex, subscript: SUBSCRIPT, inputSequence: input.sequence ?? 0xffffffff, lockTime: tx.lockTime, scope
  }))
}

/** Digest to hand the P-256 signer (32 bytes, big-endian view of the script's LE e). */
export const signerDigest = preimage => Uint8Array.from(Hash.hash256(preimage)).reverse()

/**
 * Model of the OP_PUSH_TX leg (locking-script chunks 22736..23063), byte-exact against the interpreter:
 *   e_k1 = BE(hash256(preimage));  m = e_k1 + 2^248;  t = m mod n_k1;  s = t > (n_k1-1)/2 ? n_k1 - t : t
 *   s INTEGER bytes = reverse(minimal LE scriptnum(s))  — the scriptnum's 0x00 sign byte (present iff the top
 *   magnitude byte has bit 7 set) lands in front and IS the strict-DER 0x00 pad, so the INTEGER is always valid
 *   strict DER for s > 0 (32 bytes, or 31/30/... bytes when s is small). r INTEGER = Gx (k = 1), fixed.
 * Returns { sig, s, sDer } where sig = 30 len 02 20 Gx 02 len sDer || sighash.
 */
export function pushTxSignature (preimage, sighash = 0x41) {
  const e = beToBig(Hash.hash256(preimage))
  const t = mod(e + (1n << 248n), SECP_N)
  const s = t > (SECP_N - 1n) / 2n ? SECP_N - t : t
  const sDer = [...scriptNum(s)].reverse()
  const gx = bytesOf(SECP_GX.toString(16).padStart(64, '0'))
  const body = [0x02, gx.length, ...gx, 0x02, sDer.length, ...sDer]
  return { sig: [0x30, body.length, ...body, sighash], s, sDer }
}

/**
 * Screen the OP_PUSH_TX leg. Two failure modes exist for a preimage, both independent of the P-256 signature:
 *  (a) PUSH_TX_PEEL_NONMINIMAL — the byte-peel loop `(DUP 0NOTEQUAL SPLIT) x31` (chunks 22895..22987) reads the
 *      not-yet-peeled remainder of the s scriptnum as a NUMBER 31 times (k = 0..30). If scriptNum(s) has <= 31
 *      bytes and ends in a 0x00 sign byte (s in [2^(8m-1), 2^(8m)) for some m <= 30; dominated by
 *      s in [2^239, 2^240)), the k = m peel inspects the lone 0x00, which is a non-minimal script number and
 *      the SDK interpreter (MINIMALDATA for v1 txs) aborts with 'non-minimally encoded script number' at pc 22986.
 *      Probability ~2^-16 per preimage (measured 1/57000 over 2M random e; reproduced in the interpreter).
 *      The 32-byte case (s in [2^247, 2^248), sign byte present) is fine: only 31 peels happen.
 *  (b) PUSH_TX_S_ZERO — s == 0 gives an empty INTEGER (probability ~2^-256).
 * The "negative S / missing 0x00 pad" rejection predicted by the Map-phase tail report does NOT exist: the sign
 * byte of the LE scriptnum becomes the DER pad (verified byte-exact against the interpreter, see edge-tests.mjs).
 * On `ok === false`, perturb the transaction (an output amount, or add a nonce output — locktime/sequence are baked)
 * and retry; each retry is an independent ~2^-16 draw.
 */
export function pushTxDerCheck (preimage) {
  const { s } = pushTxSignature(preimage)
  if (s === 0n) return { ok: false, reason: 'PUSH_TX_S_ZERO', s }
  const k = peelLoopNonMinimalAt(scriptNum(s))
  if (k >= 0) return { ok: false, reason: 'PUSH_TX_PEEL_NONMINIMAL', s, peelIndex: k }
  return { ok: true, reason: null, s }
}

/** Index k (0..30) of the first peel whose remainder sLE[k..] is a non-minimal script number, or -1. */
export function peelLoopNonMinimalAt (sLE) {
  for (let k = 0; k <= 30; k++) {
    const rem = sLE.slice(k)
    if (rem.length === 0) continue                       // OP_0NOTEQUAL on an empty item is fine (== 0)
    const last = rem[rem.length - 1]
    if ((last & 0x7f) === 0 && (rem.length === 1 || (rem[rem.length - 2] & 0x80) === 0)) return k
  }
  return -1
}

/** The 5-push unlocking script from already-known values. */
export function encodeUnlock ({ r, s, sInv, hashOutputs, outpoint }) {
  return UnlockingScript.fromBinary([
    ...encNum(r), ...encNum(s), ...encNum(sInv), ...pushData(hashOutputs), ...pushData(outpoint)
  ])
}

/** Parse the 5 pushes back out of an unlocking script (script-number semantics for r, s, sInv). */
export function decodeUnlock (unlockingScript) {
  const d = unlockingScript.chunks.map(c => c.data ?? (c.op >= OP.OP_1 && c.op <= OP.OP_16 ? [c.op - 0x50] : []))
  if (d.length !== 5) throw new Error('expected 5 pushes')
  const num = b => { if (!b.length) return 0n; const neg = b[b.length - 1] & 0x80; const m = [...b]; m[m.length - 1] &= 0x7f; const v = leToBig(m); return neg ? -v : v }
  return { r: num(d[0]), s: num(d[1]), sInv: num(d[2]), hashOutputs: d[3], outpoint: d[4] }
}

/** Compute R = u1*G + u2*Q for the script's conventions and return its full affine x (the value to push as r). */
export function fullR ({ e, r, s, Q }) {
  const sInv = modinv(mod(s, P256_N), P256_N)
  const u1 = mod(e * sInv, P256_N), u2 = mod(r * sInv, P256_N)
  const R = (u1 === 0n ? p256.Point.ZERO : p256.Point.BASE.multiply(u1)).add(u2 === 0n ? p256.Point.ZERO : Q.multiply(u2))
  if (R.is0()) throw new Error('R is the point at infinity')
  return { x: R.toAffine().x, sInv, u1, u2 }
}

function checkTxAgainstLock ({ tx, inputIndex, sourceSatoshis, lockingScript }) {
  const b = bakedParams(lockingScript)
  const problems = []
  if (tx.version !== b.version) problems.push(`tx.version ${tx.version} != baked ${b.version}`)
  if (tx.inputs.length !== 1) problems.push(`tx has ${tx.inputs.length} inputs; the script bakes hashPrevouts/hashSequence for exactly 1`)
  if ((tx.inputs[inputIndex].sequence ?? 0xffffffff) !== b.sequence) problems.push(`input sequence != baked 0x${b.sequence.toString(16)}`)
  if (tx.lockTime !== b.lockTime) problems.push(`tx.lockTime ${tx.lockTime} != baked ${b.lockTime}`)
  if (Number(sourceSatoshis) !== b.satoshis) problems.push(`sourceSatoshis ${sourceSatoshis} != baked ${b.satoshis}`)
  if (problems.length) throw new Error('transaction does not match the locking script: ' + problems.join('; '))
  return b
}

function checkKeyAgainstLock ({ lockingScript, Q }) {
  // chunk 151/152 = x,y of the Q comb table entry 0 (first Q constant); one scalar multiplication
  const t0 = combTable(Q)[0]
  const c = lockingScript.chunks
  if (hex(c[151]?.data ?? []) !== hex(scriptNum(t0.x)) || hex(c[152]?.data ?? []) !== hex(scriptNum(t0.y))) {
    throw new Error('P-256 key does not match the locking script (Q comb table mismatch)')
  }
}

function toPriv (p256PrivateKey) {
  if (p256PrivateKey instanceof Uint8Array) return p256PrivateKey
  if (typeof p256PrivateKey === 'string') return Uint8Array.from(bytesOf(p256PrivateKey))
  if (Array.isArray(p256PrivateKey)) return Uint8Array.from(p256PrivateKey)
  throw new Error('p256PrivateKey must be Uint8Array | hex string | number[]')
}

/**
 * Build the unlocking script for input `inputIndex` of `tx`, spending an output locked with gen.mjs's script.
 * Synchronous; signs with a software P-256 key via @noble/curves (prehash: false, RFC6979 deterministic).
 * Throws if the tx shape/amount/key do not match the lock, or (probability ~2^-16) if the OP_PUSH_TX leg would
 * fail for this preimage (error.code === 'PUSH_TX_PEEL_NONMINIMAL' | 'PUSH_TX_S_ZERO'; perturb the tx and retry —
 * see pushTxDerCheck). The screen runs BEFORE signing so a hardware signer is never asked for a doomed signature.
 */
export function buildUnlock ({ tx, inputIndex, sourceSatoshis, lockingScript, p256PrivateKey, skipPushTxCheck = false }) {
  const priv = toPriv(p256PrivateKey)
  const Q = p256.Point.fromBytes(p256.getPublicKey(priv, true))
  return buildUnlockFromSigner({
    tx, inputIndex, sourceSatoshis, lockingScript, Q, skipPushTxCheck,
    signDigest: digest => p256.sign(digest, priv, { prehash: false })
  })
}

/**
 * Same as buildUnlock but with an external signer (e.g. a YubiKey): `signDigest(digest32) -> 64-byte compact
 * r||s or DER bytes` (may return a Promise). `Q` is the signer's public key (compressed hex or noble Point).
 */
export async function buildUnlockAsync (a) {
  const sig = await a.signDigest(signerDigest(sighashPreimage({ tx: a.tx, inputIndex: a.inputIndex, sourceSatoshis: a.sourceSatoshis, scope: bakedParams(a.lockingScript).sighash })))
  return buildUnlockFromSigner({ ...a, signDigest: () => sig })
}

function buildUnlockFromSigner ({ tx, inputIndex, sourceSatoshis, lockingScript, Q, signDigest, skipPushTxCheck }) {
  if (typeof Q === 'string') Q = p256.Point.fromHex(Q)
  const baked = checkTxAgainstLock({ tx, inputIndex, sourceSatoshis, lockingScript })
  checkKeyAgainstLock({ lockingScript, Q })
  const preimage = sighashPreimage({ tx, inputIndex, sourceSatoshis, scope: baked.sighash })
  if (preimage.length !== 158) throw new Error(`unexpected preimage length ${preimage.length}`)
  if (!skipPushTxCheck) {
    const chk = pushTxDerCheck(preimage)
    if (!chk.ok) { const err = new Error(`OP_PUSH_TX leg would fail for this transaction (${chk.reason}); perturb the transaction and retry`); err.code = chk.reason; throw err }
  }
  const digest = signerDigest(preimage)
  const e = beToBig(digest)                                   // == unsigned-LE(hash256(preimage)), the script's e
  const sigBytes = Uint8Array.from(signDigest(digest))
  const sig = sigBytes.length === 64 ? p256.Signature.fromBytes(sigBytes, 'compact') : p256.Signature.fromBytes(sigBytes, 'der')
  if (sig.s === 0n || mod(sig.s, P256_N) === 0n) throw new Error('signature s == 0')
  const { x: Rx, sInv } = fullR({ e, r: sig.r, s: sig.s, Q })
  if (mod(Rx, P256_N) !== mod(sig.r, P256_N)) throw new Error('signature does not verify against Q (R.x mod n != r)')
  // Fields the script concatenates verbatim; both are also recomputed here and cross-checked against the preimage.
  const outpoint = preimage.slice(68, 104)
  const hashOutputs = preimage.slice(118, 150)
  const input = tx.inputs[inputIndex]
  const sourceTXID = input.sourceTXID ?? input.sourceTransaction.id('hex')
  const w = new Utils.Writer(); w.writeUInt32LE(input.sourceOutputIndex)
  if (hex(outpoint) !== hex([...bytesOf(sourceTXID).reverse(), ...w.toArray()])) throw new Error('outpoint mismatch')
  const ow = new Utils.Writer()
  for (const o of tx.outputs) { ow.writeUInt64LE(Number(o.satoshis)); const sb = o.lockingScript.toBinary(); ow.writeVarIntNum(sb.length); ow.write(sb) }
  if (hex(hashOutputs) !== hex(Hash.hash256(ow.toArray()))) throw new Error('hashOutputs mismatch')
  return encodeUnlock({ r: Rx, s: sig.s, sInv, hashOutputs, outpoint })
}

/** ScriptTemplateUnlock adapter for `tx.sign()`: { sign, estimateLength }. */
export function r1CombUnlockTemplate ({ sourceSatoshis, lockingScript, p256PrivateKey }) {
  return {
    sign: async (tx, inputIndex) => buildUnlock({ tx, inputIndex, sourceSatoshis, lockingScript, p256PrivateKey }),
    estimateLength: async () => 1 + 33 + 1 + 33 + 1 + 33 + 1 + 32 + 1 + 36      // upper bound (r, s, sInv may be 33 bytes)
  }
}

// ───────────────────────────── self-test ─────────────────────────────
const REPO = '/Users/personal/git/bsv-wallet'
const FIXTURE_LOCK = REPO + '/docs/example-txs/51c53430fe63108a2a1ddd231253df069fb424cc6f1bb0ee60b4b07792d3579a_0.hex'
const FIXTURE_TX = REPO + '/docs/example-txs/476611a431172df767a73349522536fa78d63a83b560efbb695b853bf60b4b80.hex'
const FIXTURE_Q = '03f4d667712d8825372cd616b0b1b1a818e5eeb3681dd45c5bdd59fed9f21d5a7d'

let fails = 0
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`); if (!ok) fails++ }

function mkSpend ({ tx, inputIndex, sourceSatoshis, lockingScript, unlockingScript }) {
  const inp = tx.inputs[inputIndex]
  return new Spend({
    sourceTXID: inp.sourceTXID ?? inp.sourceTransaction.id('hex'), sourceOutputIndex: inp.sourceOutputIndex, sourceSatoshis: Number(sourceSatoshis),
    lockingScript, transactionVersion: tx.version, otherInputs: tx.inputs.filter((_, i) => i !== inputIndex), outputs: tx.outputs,
    unlockingScript, inputSequence: inp.sequence, inputIndex, lockTime: tx.lockTime
  })
}
function validate (args) {
  const sp = mkSpend(args)
  try { return { ok: sp.validate(), pc: sp.programCounter } } catch (e) { return { ok: false, pc: sp.programCounter, err: e.message.split('\n')[0] } }
}
function stepTo (sp, pc) { let n = 0; while (!(sp.context === 'LockingScript' && sp.programCounter === pc)) { sp.step(); if (++n > 1e6) throw new Error('stepTo overflow') } return sp }

async function selfTestFixture () {
  console.log('── fixture re-derivation ──')
  const lock = LockingScript.fromHex(fs.readFileSync(FIXTURE_LOCK, 'utf8').trim())
  const tx = Transaction.fromHex(fs.readFileSync(FIXTURE_TX, 'utf8').trim())
  const unlock = tx.inputs[0].unlockingScript
  const baked = bakedParams(lock)
  check('bakedParams', baked.version === 1 && baked.sequence === 0xffffffff && baked.satoshis === 4600 && baked.lockTime === 0 && baked.sighash === 0x41, JSON.stringify(baked))
  // 1. preimage == interpreter's (stack top when chunk 22 OP_DUP is about to run) and e == interpreter's scriptnum at pc 27
  const preimage = sighashPreimage({ tx, inputIndex: 0, sourceSatoshis: 4600 })
  const sp = stepTo(mkSpend({ tx, inputIndex: 0, sourceSatoshis: 4600, lockingScript: lock, unlockingScript: unlock }), 22)
  check('preimage == interpreter stack top at pc 22 (158 B)', hex(sp.stack.at(-1)) === hex(preimage) && preimage.length === 158)
  stepTo(sp, 27)
  const e = beToBig(signerDigest(preimage))
  check('e == interpreter scriptnum at pc 27', hex(sp.stack.at(-1)) === hex(scriptNum(e)), `e=${e.toString(16)}`)
  check('e == unsigned-LE(hash256(preimage))', e === leToBig(Hash.hash256(preimage)))
  // 2. decode fixture r, s, sInv; sInv is the inverse; re-encoding reproduces the fixture unlocking script byte-for-byte
  const f = decodeUnlock(unlock)
  check('fixture sInv == s^-1 mod n', mod(f.s * f.sInv, P256_N) === 1n && f.sInv === modinv(f.s, P256_N))
  const re = encodeUnlock({ r: f.r, s: f.s, sInv: modinv(f.s, P256_N), hashOutputs: f.hashOutputs, outpoint: f.outpoint })
  check('encodeUnlock(fixture r, s, computed sInv, hashOutputs, outpoint) == fixture unlocking script', re.toHex() === unlock.toHex(), `${re.toBinary().length} B`)
  check('preimage slices == fixture hashOutputs / outpoint pushes', hex(preimage.slice(118, 150)) === hex(f.hashOutputs) && hex(preimage.slice(68, 104)) === hex(f.outpoint))
  // 3. r == full affine x of u1*G + u2*Q for the fixture Q (verifies the r/e/u1/u2 conventions)
  const Q = p256.Point.fromHex(FIXTURE_Q)
  const { x: Rx, u1, u2 } = fullR({ e, r: f.r, s: f.s, Q })
  check('fullR(e, r, s, Q).x == fixture r (r is the full affine x, r < n here)', Rx === f.r && f.r < P256_N, `u1=${u1.toString(16).slice(0, 12)}.. u2=${u2.toString(16).slice(0, 12)}..`)
  check('noble p256.verify(fixture (r,s), digest, Q, lowS:false)', p256.verify(new p256.Signature(f.r, f.s).toBytes('compact'), signerDigest(preimage), Q.toBytes(true), { prehash: false, lowS: false }))
  // 4. the fixture preimage passes the PUSH_TX DER screen, and the fixture validates
  check('pushTxDerCheck(fixture preimage).ok', pushTxDerCheck(preimage).ok)
  const v = validate({ tx, inputIndex: 0, sourceSatoshis: 4600, lockingScript: lock, unlockingScript: re })
  check('Spend.validate(fixture lock, re-encoded unlock) === true', v.ok, `pc=${v.pc}${v.err ? ' ' + v.err : ''}`)
  // 5. the tx-shape guard accepts the fixture tx (buildUnlockFromSigner path minus the signature: use a fake signer returning the fixture sig)
  const built = await buildUnlockAsync({ tx, inputIndex: 0, sourceSatoshis: 4600, lockingScript: lock, Q: FIXTURE_Q, signDigest: () => new p256.Signature(f.r, f.s).toBytes('compact') })
  check('buildUnlockAsync(fixture tx, fixture (r,s) via external signer) == fixture unlocking script', built.toHex() === unlock.toHex())
}

async function selfTestRandom (rounds) {
  console.log(`── fresh random P-256 keys x${rounds} ──`)
  for (let i = 0; i < rounds; i++) {
    const priv = p256.utils.randomSecretKey()
    const qHex = hex(p256.getPublicKey(priv, true))
    const sats = 1000 + Math.floor(Math.random() * 1_000_000)
    const t0 = Date.now()
    const lock = buildLock({ qCompressedHex: qHex, satoshis: sats })
    const tGen = Date.now() - t0
    // funding "source" tx: the lock at a random vout, so tx.verify('scripts only') can resolve it
    const vout = Math.floor(Math.random() * 3)
    const src = new Transaction()
    for (let k = 0; k < vout; k++) src.addOutput({ satoshis: 1, lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()) })
    src.addOutput({ satoshis: sats, lockingScript: lock })
    src.merklePath = MerklePath.fromCoinbaseTxidAndHeight(src.id('hex'), 1755177)   // "mined": verify('scripts only') must not recurse into this zero-input stub
    const dest = new P2PKH().lock(PrivateKey.fromRandom().toAddress())
    let tx, unlock, tries = 0, lastErr = null
    for (let outSats = sats - 200; tries < 20; tries++, outSats--) {     // perturb the output amount on a PUSH_TX DER screen failure
      tx = new Transaction(1, [], [], 0)
      tx.addInput({ sourceTransaction: src, sourceOutputIndex: vout, sequence: 0xffffffff })
      tx.addOutput({ satoshis: outSats, lockingScript: dest })
      if (i % 2 === 1) tx.addOutput({ satoshis: 100, lockingScript: Script.fromASM('OP_RETURN 6e6f6e6365') })   // exercise 2 outputs
      try { unlock = buildUnlock({ tx, inputIndex: 0, sourceSatoshis: sats, lockingScript: lock, p256PrivateKey: priv }); break } catch (e) { lastErr = e; if (!e.code) throw e }
    }
    if (!unlock) { check(`round ${i}: buildUnlock`, false, lastErr?.message); continue }
    const v = validate({ tx, inputIndex: 0, sourceSatoshis: sats, lockingScript: lock, unlockingScript: unlock })
    const f = decodeUnlock(unlock)
    check(`round ${i}: Spend.validate === true`, v.ok, `sats=${sats} vout=${vout} outputs=${tx.outputs.length} unlock=${unlock.toBinary().length}B r:${encNum(f.r).length - 1}B s:${encNum(f.s).length - 1}B sInv:${encNum(f.sInv).length - 1}B derRetries=${tries} gen=${tGen}ms pc=${v.pc}${v.err ? ' ' + v.err : ''}`)
    // SDK end-to-end: template sign + tx.verify('scripts only')
    tx.inputs[0].unlockingScriptTemplate = r1CombUnlockTemplate({ sourceSatoshis: sats, lockingScript: lock, p256PrivateKey: priv })
    tx.inputs[0].unlockingScript = undefined
    await tx.sign()
    let verified = false, verr = null
    try { verified = await tx.verify('scripts only') } catch (e) { verr = e.message.split('\n')[0] }
    check(`round ${i}: tx.sign() via template + tx.verify('scripts only')`, verified && tx.inputs[0].unlockingScript.toHex() === unlock.toHex(), verr ?? '')
    if (i === 0) {
      // negative controls
      const bad = encodeUnlock({ r: f.r + 1n, s: f.s, sInv: f.sInv, hashOutputs: f.hashOutputs, outpoint: f.outpoint })
      const vb = validate({ tx, inputIndex: 0, sourceSatoshis: sats, lockingScript: lock, unlockingScript: bad })
      check('round 0: tampered r (+1) fails', !vb.ok, `pc=${vb.pc} ${vb.err ?? ''}`)
      let threw = null
      try { buildUnlock({ tx, inputIndex: 0, sourceSatoshis: sats, lockingScript: lock, p256PrivateKey: p256.utils.randomSecretKey() }) } catch (e) { threw = e.message }
      check('round 0: wrong key is rejected before signing', /does not match/.test(threw ?? ''), threw ?? 'no throw')
      threw = null
      try { buildUnlock({ tx, inputIndex: 0, sourceSatoshis: sats + 1, lockingScript: lock, p256PrivateKey: priv }) } catch (e) { threw = e.message }
      check('round 0: wrong sourceSatoshis is rejected', /sourceSatoshis/.test(threw ?? ''), threw ?? 'no throw')
    }
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  await selfTestFixture()
  await selfTestRandom(Number(process.env.ROUNDS ?? 6))
  console.log(fails === 0 ? 'ALL PASS' : `${fails} FAILURE(S)`)
  process.exitCode = fails ? 1 : 0
}
