// unlock2.mjs — unlocker + self-tests for the generalized lock produced by gen2.mjs.
//
//   import { buildUnlock2 } from './unlock2.mjs'
//   const unlockingScript = buildUnlock2({ tx, inputIndex, sourceSatoshis, lockingScript, p256PrivateKey, qCompressedHex, salt })
//
// Self-test:  node unlock2.mjs      (FUZZ=100 by default; ROUNDS env overrides)
//
// Unlocking script (bottom -> top), 71 pushes:
//   r      full affine x of R = u1*G + u2*Q            (minimal scriptnum, 32/33 B)
//   u2'    recode(r*sInv mod n)                        (33 B)
//   u1'    recode(e*sInv mod n)                        (33 B)
//   Qx0 Qy0 .. Qx31 Qy31   the 64 coordinates of the Q comb table (minimal scriptnums, mostly 32/33 B)
//   salt   32 raw bytes
//   s, sInv                (minimal scriptnums)
//   preimage               158 raw bytes = TransactionSignature.format(subscript OP_CHECKSIG, scope 0x41)
import { UnlockingScript, LockingScript, Script, Transaction, TransactionSignature, Spend, Hash, Utils, OP, PrivateKey, P2PKH, MerklePath } from '@bsv/sdk'
import { p256 } from '@noble/curves/nist.js'
import { performance } from 'perf_hooks'
import { buildLock2, commitmentFor, bakedCommitments, recode, normSalt, layout2, encNum, pushData, scriptNum, combTable, P256_N } from './gen2.mjs'
import { sighashPreimage, signerDigest, pushTxDerCheck, fullR } from './unlock.mjs'

const hex = a => Buffer.from(a).toString('hex')
const bytesOf = h => [...Buffer.from(h, 'hex')]
const mod = (a, m) => ((a % m) + m) % m
const beToBig = b => BigInt('0x' + (hex(b) || '0'))
const SIGHASH = 0x41

function toPriv (k) {
  if (k instanceof Uint8Array) return k
  if (typeof k === 'string') return Uint8Array.from(bytesOf(k))
  if (Array.isArray(k)) return Uint8Array.from(k)
  throw new Error('p256PrivateKey must be Uint8Array | hex string | number[]')
}

/** 71-push unlocking script from already-known values. `table` = 32 {x, y} bigint pairs (combTable(Q)). */
export function encodeUnlock2 ({ r, u2p, u1p, table, salt, s, sInv, preimage }) {
  const b = [...encNum(r), ...encNum(u2p), ...encNum(u1p)]
  for (const { x, y } of table) b.push(...encNum(x), ...encNum(y))
  b.push(...pushData(normSalt(salt)), ...encNum(s), ...encNum(sInv), ...pushData(preimage))
  return UnlockingScript.fromBinary(b)
}

/** Parse the 71 pushes back (script-number semantics for numeric items). */
export function decodeUnlock2 (unlockingScript) {
  const d = unlockingScript.chunks.map(c => c.data ?? (c.op >= OP.OP_1 && c.op <= OP.OP_16 ? [c.op - 0x50] : []))
  if (d.length !== 71) throw new Error(`expected 71 pushes, got ${d.length}`)
  const num = b => { if (!b.length) return 0n; const neg = b[b.length - 1] & 0x80; const m = [...b]; m[m.length - 1] &= 0x7f; const v = beToBig([...m].reverse()); return neg ? -v : v }
  const table = []
  for (let j = 0; j < 32; j++) table.push({ x: num(d[3 + 2 * j]), y: num(d[4 + 2 * j]) })
  return { r: num(d[0]), u2p: num(d[1]), u1p: num(d[2]), table, salt: d[67], s: num(d[68]), sInv: num(d[69]), preimage: d[70] }
}

/**
 * Build the unlocking script for input `inputIndex` of `tx` (software P-256 key). Guards (before signing):
 *   - commitmentFor(Q, salt) must be one of the lock's baked commitments (skipCommitmentCheck bypasses, for negative tests)
 *   - the OP_PUSH_TX screen (pushTxDerCheck) must pass (skipPushTxCheck bypasses); on failure err.code is set —
 *     perturb ANY free field (outputs, this input's sequence, locktime — none are baked any more) and retry.
 */
export function buildUnlock2 ({ tx, inputIndex, sourceSatoshis, lockingScript, p256PrivateKey, qCompressedHex, salt, skipPushTxCheck = false, skipCommitmentCheck = false }) {
  const priv = toPriv(p256PrivateKey)
  const derived = hex(p256.getPublicKey(priv, true))
  if (qCompressedHex && qCompressedHex.toLowerCase() !== derived) throw new Error('qCompressedHex does not match p256PrivateKey')
  return buildUnlock2FromSigner({
    tx, inputIndex, sourceSatoshis, lockingScript, qCompressedHex: derived, salt, skipPushTxCheck, skipCommitmentCheck,
    signDigest: digest => p256.sign(digest, priv, { prehash: false })
  })
}

/** External-signer variant: signDigest(digest32) -> 64-byte compact r||s or DER (may be a Promise). */
export async function buildUnlock2Async (a) {
  const sig = await a.signDigest(signerDigest(sighashPreimage({ tx: a.tx, inputIndex: a.inputIndex, sourceSatoshis: a.sourceSatoshis, scope: SIGHASH })))
  return buildUnlock2FromSigner({ ...a, signDigest: () => sig })
}

function buildUnlock2FromSigner ({ tx, inputIndex, sourceSatoshis, lockingScript, qCompressedHex, salt, signDigest, skipPushTxCheck, skipCommitmentCheck, tableOverride, saltForTable }) {
  const Q = p256.Point.fromHex(qCompressedHex)
  const saltBytes = normSalt(salt)
  if (!skipCommitmentCheck) {
    const c = commitmentFor({ qCompressedHex, salt: saltBytes })
    const baked = bakedCommitments(lockingScript)
    if (!baked.includes(c)) { const e = new Error('this (key, salt) pair is not committed in the locking script'); e.code = 'NOT_COMMITTED'; throw e }
  }
  const preimage = sighashPreimage({ tx, inputIndex, sourceSatoshis, scope: SIGHASH })
  if (preimage.length !== 158) throw new Error(`unexpected preimage length ${preimage.length}`)
  if (!skipPushTxCheck) {
    const chk = pushTxDerCheck(preimage)
    if (!chk.ok) { const err = new Error(`OP_PUSH_TX leg would fail for this transaction (${chk.reason}); perturb the transaction and retry`); err.code = chk.reason; throw err }
  }
  const digest = signerDigest(preimage)
  const e = beToBig(digest)
  const sigBytes = Uint8Array.from(signDigest(digest))
  const sig = sigBytes[0] === 0x30 && sigBytes.length !== 64 ? p256.Signature.fromBytes(sigBytes, 'der') : p256.Signature.fromBytes(sigBytes, 'compact')
  if (mod(sig.s, P256_N) === 0n) throw new Error('signature s == 0')
  const { x: Rx, sInv } = fullR({ e, r: sig.r, s: sig.s, Q })
  if (mod(Rx, P256_N) !== mod(sig.r, P256_N)) throw new Error('signature does not verify against Q')
  const u1 = mod(e * sInv, P256_N), u2 = mod(Rx * sInv, P256_N)
  return encodeUnlock2({ r: Rx, u2p: recode(u2), u1p: recode(u1), table: tableOverride ?? combTable(Q), salt: saltBytes, s: sig.s, sInv, preimage })
}

/** ScriptTemplateUnlock adapter for tx.sign(). */
export function r1CombUnlock2Template ({ sourceSatoshis, lockingScript, p256PrivateKey, salt }) {
  return {
    sign: async (tx, inputIndex) => buildUnlock2({ tx, inputIndex, sourceSatoshis, lockingScript, p256PrivateKey, salt }),
    estimateLength: async () => 3 * 34 + 64 * 34 + 33 + 34 + 34 + 3 + 158
  }
}

// ───────────────────────────── self-test ─────────────────────────────
let fails = 0
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`); if (!ok) fails++ }
const validateTimes = []

function mkSpend ({ tx, inputIndex, sourceSatoshis, lockingScript, unlockingScript }) {
  const inp = tx.inputs[inputIndex]
  return new Spend({
    sourceTXID: inp.sourceTXID ?? inp.sourceTransaction.id('hex'), sourceOutputIndex: inp.sourceOutputIndex, sourceSatoshis: Number(sourceSatoshis),
    lockingScript, transactionVersion: tx.version, otherInputs: tx.inputs.filter((_, i) => i !== inputIndex), outputs: tx.outputs,
    unlockingScript, inputSequence: inp.sequence ?? 0xffffffff, inputIndex, lockTime: tx.lockTime
  })
}
function validate (args) {
  const sp = mkSpend(args)
  const t0 = performance.now()
  try { const ok = sp.validate(); validateTimes.push(performance.now() - t0); return { ok, pc: sp.programCounter, ms: validateTimes.at(-1) } } catch (e) { const ms = performance.now() - t0; return { ok: false, pc: sp.programCounter, err: e.message.split('\n')[0], ms } }
}
function regionOf (lock, pc) { const r = layout2(lock).regions.find(r => pc >= r.chunks[0] && pc <= r.chunks[1]); return r ? r.name : '?' }

/** Funding stub: `lock` at output `vout` of a zero-input tx with a fake merkle path so tx.verify('scripts only') stops there. */
function fundingTx (lock, sats, vout = 0) {
  const src = new Transaction()
  for (let k = 0; k < vout; k++) src.addOutput({ satoshis: 1, lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()) })
  src.addOutput({ satoshis: sats, lockingScript: lock })
  src.merklePath = MerklePath.fromCoinbaseTxidAndHeight(src.id('hex'), 1755177)
  return src
}
const randSalt = () => Uint8Array.from(Array.from({ length: 32 }, () => Math.floor(Math.random() * 256)))
const P2PKH_OUT = () => new P2PKH().lock(PrivateKey.fromRandom().toAddress())

/** Build a spend of the given inputs ([{src, vout, sats, priv, salt, lock}]) with `nOut` outputs; retries on PUSH_TX screen by bumping the change. */
function buildSpend (inputs, { nOut = 1, sequence = 0xffffffff, lockTime = 0, version = 1, extra = {} } = {}) {
  const total = inputs.reduce((a, i) => a + i.sats, 0)
  let tx, unlocks
  for (let tries = 0, out0 = total - 500 * inputs.length; tries < 40; tries++, out0--) {
    tx = new Transaction(version, [], [], lockTime)
    for (const i of inputs) tx.addInput({ sourceTransaction: i.src, sourceOutputIndex: i.vout, sequence })
    tx.addOutput({ satoshis: out0, lockingScript: P2PKH_OUT() })
    if (nOut >= 2) tx.addOutput({ satoshis: 100, lockingScript: Script.fromASM('OP_RETURN 6e6f6e6365') })
    if (nOut >= 3) tx.addOutput({ satoshis: 200, lockingScript: P2PKH_OUT() })
    unlocks = []
    try {
      for (let k = 0; k < inputs.length; k++) {
        const i = inputs[k]
        unlocks.push(buildUnlock2({ tx, inputIndex: k, sourceSatoshis: i.sats, lockingScript: i.lock, p256PrivateKey: i.priv, salt: i.salt, ...extra }))
      }
      break
    } catch (e) { if (e.code === 'PUSH_TX_PEEL_NONMINIMAL' || e.code === 'PUSH_TX_S_ZERO') { unlocks = null; continue } throw e }
  }
  if (!unlocks) throw new Error('PUSH_TX screen failed 40 times (should be ~2^-16 each)')
  unlocks.forEach((u, k) => { tx.inputs[k].unlockingScript = u })
  return { tx, unlocks }
}

const sizeTable = []

async function testOneOfN () {
  console.log('── (i) N=1..5: each of the N keys spends; (ii) foreign key fails; (iii) wrong salt fails ──')
  for (let N = 1; N <= 5; N++) {
    const members = [...Array(N)].map(() => { const priv = p256.utils.randomSecretKey(); return { priv, q: hex(p256.getPublicKey(priv, true)), salt: randSalt() } })
    const lock = buildLock2({ commitments: members.map(m => commitmentFor({ qCompressedHex: m.q, salt: m.salt })) })
    const sats = 10_000 + Math.floor(Math.random() * 1e6)
    const src = fundingTx(lock, sats, N % 3)
    let unlockBytes = null, txBytes = null
    for (let k = 0; k < N; k++) {
      const m = members[k]
      const { tx, unlocks } = buildSpend([{ src, vout: N % 3, sats, priv: m.priv, salt: m.salt, lock }], { nOut: 1 + (k % 2) })
      const v = validate({ tx, inputIndex: 0, sourceSatoshis: sats, lockingScript: lock, unlockingScript: unlocks[0] })
      check(`N=${N} key#${k} validates`, v.ok, `pc=${v.pc} ${v.err ?? ''} ${v.ms.toFixed(1)}ms unlock=${unlocks[0].toBinary().length}B tx=${tx.toBinary().length}B`)
      unlockBytes = unlocks[0].toBinary().length; txBytes = tx.toBinary().length
      if (k === 0) {
        // (ii) key NOT in the set: honest builder refuses; forced build fails in the interpreter at the commitment check
        const foreign = p256.utils.randomSecretKey()
        let threw = null
        try { buildUnlock2({ tx, inputIndex: 0, sourceSatoshis: sats, lockingScript: lock, p256PrivateKey: foreign, salt: m.salt }) } catch (e) { threw = e.code }
        check(`N=${N} (ii) foreign key refused before signing`, threw === 'NOT_COMMITTED', threw ?? 'no throw')
        const forced = buildUnlock2({ tx, inputIndex: 0, sourceSatoshis: sats, lockingScript: lock, p256PrivateKey: foreign, salt: m.salt, skipCommitmentCheck: true })
        const vf = validate({ tx, inputIndex: 0, sourceSatoshis: sats, lockingScript: lock, unlockingScript: forced })
        check(`N=${N} (ii) foreign key (own valid table+sig) fails in script`, !vf.ok, `pc=${vf.pc} [${regionOf(lock, vf.pc)}] ${vf.err ?? 'returned false'}`)
        // (iii) correct key & table, wrong salt
        const wrongSalt = randSalt()
        threw = null
        try { buildUnlock2({ tx, inputIndex: 0, sourceSatoshis: sats, lockingScript: lock, p256PrivateKey: m.priv, salt: wrongSalt }) } catch (e) { threw = e.code }
        check(`N=${N} (iii) wrong salt refused before signing`, threw === 'NOT_COMMITTED', threw ?? 'no throw')
        const forcedSalt = buildUnlock2({ tx, inputIndex: 0, sourceSatoshis: sats, lockingScript: lock, p256PrivateKey: m.priv, salt: wrongSalt, skipCommitmentCheck: true })
        const vs = validate({ tx, inputIndex: 0, sourceSatoshis: sats, lockingScript: lock, unlockingScript: forcedSalt })
        check(`N=${N} (iii) wrong salt fails in script`, !vs.ok, `pc=${vs.pc} [${regionOf(lock, vs.pc)}] ${vs.err ?? 'returned false'}`)
        // cross-member salt: member k's key with member (k+1)'s salt (N>=2) -> fails
        if (N >= 2) {
          const x = buildUnlock2({ tx, inputIndex: 0, sourceSatoshis: sats, lockingScript: lock, p256PrivateKey: m.priv, salt: members[1].salt, skipCommitmentCheck: true })
          const vx = validate({ tx, inputIndex: 0, sourceSatoshis: sats, lockingScript: lock, unlockingScript: x })
          check(`N=${N} key#0 with key#1's salt fails in script`, !vx.ok, `pc=${vx.pc}`)
        }
      }
    }
    sizeTable.push({ N, lockBytes: lock.toBinary().length, lockChunks: lock.chunks.length, unlockBytes, txBytes1in: txBytes })
  }
}

async function testNegatives () {
  console.log('── extra negatives (N=2) ──')
  const a = { priv: p256.utils.randomSecretKey(), salt: randSalt() }; a.q = hex(p256.getPublicKey(a.priv, true))
  const b = { priv: p256.utils.randomSecretKey(), salt: randSalt() }; b.q = hex(p256.getPublicKey(b.priv, true))
  const lock = buildLock2({ commitments: [commitmentFor({ qCompressedHex: a.q, salt: a.salt }), commitmentFor({ qCompressedHex: b.q, salt: b.salt })] })
  const sats = 50_000
  const src = fundingTx(lock, sats, 1)
  const { tx, unlocks } = buildSpend([{ src, vout: 1, sats, priv: b.priv, salt: b.salt, lock }], { nOut: 2 })
  const good = decodeUnlock2(unlocks[0])
  const v0 = validate({ tx, inputIndex: 0, sourceSatoshis: sats, lockingScript: lock, unlockingScript: unlocks[0] })
  check('positive control (key b of {a,b})', v0.ok, `pc=${v0.pc}`)
  const re = encodeUnlock2({ ...good })
  check('decodeUnlock2/encodeUnlock2 round-trip is byte-exact', re.toHex() === unlocks[0].toHex(), `${re.toBinary().length} B`)
  const cases = [
    ['r+1', { r: good.r + 1n }],
    ['u1\'+1 (pushed recoded scalar tampered)', { u1p: good.u1p + 1n }],
    ['u2\'+1', { u2p: good.u2p + 1n }],
    ['s+1 (sInv stale)', { s: good.s + 1n }],
    ['table coord Qx0+1 (same salt)', { table: good.table.map((p, j) => j === 0 ? { x: p.x + 1n, y: p.y } : p) }],
    ['table coord Qy31 -> Qy31 with two coords swapped', { table: good.table.map((p, j) => j === 31 ? { x: p.y, y: p.x } : p) }],
    ['salt byte flipped', { salt: good.salt.map((x, i) => i === 5 ? x ^ 1 : x) }],
    ['preimage byte flipped (hashOutputs region)', { preimage: good.preimage.map((x, i) => i === 120 ? x ^ 1 : x) }]
  ]
  for (const [name, patch] of cases) {
    const u = encodeUnlock2({ ...good, ...patch })
    const v = validate({ tx, inputIndex: 0, sourceSatoshis: sats, lockingScript: lock, unlockingScript: u })
    check(`tamper: ${name} -> fails`, !v.ok, `pc=${v.pc} [${regionOf(lock, v.pc)}] ${v.err ?? 'returned false'}`)
  }
  // signature over a DIFFERENT tx's preimage (P-256 leg passes, PUSH_TX must reject): rebuild with the same key against tx2 and run it against tx
  const { tx: tx2, unlocks: un2 } = buildSpend([{ src, vout: 1, sats, priv: b.priv, salt: b.salt, lock }], { nOut: 3 })
  const v2 = validate({ tx: tx2, inputIndex: 0, sourceSatoshis: sats, lockingScript: lock, unlockingScript: un2[0] })
  check('control: tx2 unlock validates against tx2', v2.ok)
  const vx = validate({ tx, inputIndex: 0, sourceSatoshis: sats, lockingScript: lock, unlockingScript: un2[0] })
  check('tx2\'s unlock (valid P-256 sig over tx2 preimage) fails against tx (PUSH_TX binding)', !vx.ok, `pc=${vx.pc} [${regionOf(lock, vx.pc)}] ${vx.err ?? 'returned false (CHECKSIG)'}`)
  // wrong sourceSatoshis at validation time (amount no longer baked, so the preimage amount is bound only by CHECKSIG)
  const va = validate({ tx, inputIndex: 0, sourceSatoshis: sats + 1, lockingScript: lock, unlockingScript: unlocks[0] })
  check('sourceSatoshis+1 at validation -> fails at CHECKSIG', !va.ok, `pc=${va.pc} [${regionOf(lock, va.pc)}]`)
  // sequence / locktime are free: a non-final sequence and a locktime validate
  const { tx: tx3, unlocks: un3 } = buildSpend([{ src, vout: 1, sats, priv: a.priv, salt: a.salt, lock }], { nOut: 1, sequence: 0xfffffffe, lockTime: 700_000 })
  const v3 = validate({ tx: tx3, inputIndex: 0, sourceSatoshis: sats, lockingScript: lock, unlockingScript: un3[0] })
  check('key a, sequence 0xfffffffe + lockTime 700000 validates (not baked)', v3.ok, `pc=${v3.pc} ${v3.err ?? ''}`)
  const v3b = validate({ tx: Object.assign(Transaction.fromHex(tx3.toHex()), { lockTime: 700_001, inputs: tx3.inputs }), inputIndex: 0, sourceSatoshis: sats, lockingScript: lock, unlockingScript: un3[0] })
  check('same unlock evaluated with lockTime 700001 fails (CHECKSIG)', !v3b.ok, `pc=${v3b.pc}`)
  // duplicate commitments rejected by builder; N=0 rejected
  let threw = null; try { buildLock2({ commitments: [] }) } catch (e) { threw = e.message }
  check('buildLock2 rejects N=0', !!threw, threw ?? '')
  threw = null; try { buildLock2({ commitments: [commitmentFor({ qCompressedHex: a.q, salt: a.salt }), commitmentFor({ qCompressedHex: a.q, salt: a.salt })] }) } catch (e) { threw = e.message }
  check('buildLock2 rejects duplicate commitments', !!threw, threw ?? '')
}

async function testTwoInputs () {
  console.log('── (iv) 2-input spend: both inputs are gen2 vault outputs ──')
  const k1 = p256.utils.randomSecretKey(), k2 = p256.utils.randomSecretKey(), k3 = p256.utils.randomSecretKey()
  const s1 = randSalt(), s2 = randSalt(), s3 = randSalt()
  const q = k => hex(p256.getPublicKey(k, true))
  const lockA = buildLock2({ commitments: [commitmentFor({ qCompressedHex: q(k1), salt: s1 }), commitmentFor({ qCompressedHex: q(k2), salt: s2 })] })   // N=2
  const lockB = buildLock2({ commitments: [commitmentFor({ qCompressedHex: q(k3), salt: s3 })] })                                                        // N=1
  const satsA = 40_000, satsB = 25_000
  const srcA = fundingTx(lockA, satsA, 0), srcB = fundingTx(lockB, satsB, 2)
  const inputs = [{ src: srcA, vout: 0, sats: satsA, priv: k2, salt: s2, lock: lockA }, { src: srcB, vout: 2, sats: satsB, priv: k3, salt: s3, lock: lockB }]
  const { tx, unlocks } = buildSpend(inputs, { nOut: 2 })
  for (let k = 0; k < 2; k++) {
    const v = validate({ tx, inputIndex: k, sourceSatoshis: inputs[k].sats, lockingScript: inputs[k].lock, unlockingScript: unlocks[k] })
    check(`2-input tx: input ${k} validates (lock ${k === 0 ? 'A N=2, key#2' : 'B N=1, key#3'})`, v.ok, `pc=${v.pc} ${v.err ?? ''} ${v.ms.toFixed(1)}ms unlock=${unlocks[k].toBinary().length}B`)
  }
  console.log(`2-input spend tx size: ${tx.toBinary().length} B (${tx.inputs.length} inputs, ${tx.outputs.length} outputs)`)
  sizeTable.push({ N: 'A(2)+B(1)', twoInputTxBytes: tx.toBinary().length, unlock0: unlocks[0].toBinary().length, unlock1: unlocks[1].toBinary().length })
  // preimages differ per input; swapping the unlocks must fail both ways (P-256 sig over the other input's preimage; PUSH_TX rejects)
  const vs0 = validate({ tx, inputIndex: 0, sourceSatoshis: satsA, lockingScript: lockA, unlockingScript: unlocks[1] })
  check('input 0 evaluated with input 1\'s unlock (different lock/key) fails', !vs0.ok, `pc=${vs0.pc} [${regionOf(lockA, vs0.pc)}] ${vs0.err ?? 'returned false'}`)
  // SHARPER multi-input binding test: both inputs spend the SAME lock with the SAME key+salt (commitment and P-256 legs are
  // both satisfied by the swapped unlock, since each unlock carries its own preimage) -> only OP_PUSH_TX/CHECKSIG can reject.
  {
    const srcA2 = fundingTx(lockA, satsA + 7, 1)
    const same = [{ src: srcA, vout: 0, sats: satsA, priv: k2, salt: s2, lock: lockA }, { src: srcA2, vout: 1, sats: satsA + 7, priv: k2, salt: s2, lock: lockA }]
    const { tx: txS, unlocks: uS } = buildSpend(same, { nOut: 1 })
    const c0 = validate({ tx: txS, inputIndex: 0, sourceSatoshis: satsA, lockingScript: lockA, unlockingScript: uS[0] })
    const c1 = validate({ tx: txS, inputIndex: 1, sourceSatoshis: satsA + 7, lockingScript: lockA, unlockingScript: uS[1] })
    check('same-lock same-key 2-input: both inputs validate', c0.ok && c1.ok, `pc=${c0.pc}/${c1.pc}`)
    const x0 = validate({ tx: txS, inputIndex: 0, sourceSatoshis: satsA, lockingScript: lockA, unlockingScript: uS[1] })
    const x1 = validate({ tx: txS, inputIndex: 1, sourceSatoshis: satsA + 7, lockingScript: lockA, unlockingScript: uS[0] })
    check('same-lock same-key 2-input: SWAPPED unlocks fail only at the end (P-256 + commitment pass; CHECKSIG false)', !x0.ok && !x1.ok && x0.pc === lockA.chunks.length && x1.pc === lockA.chunks.length, `pc=${x0.pc}/${x1.pc} (chunks=${lockA.chunks.length}) ${x0.err ?? ''}`)
    // and the swapped unlock's preimage really is the other input's (outpoint+amount differ; the rest is shared)
    const d0 = decodeUnlock2(uS[0]), d1 = decodeUnlock2(uS[1])
    check('swapped case: the two preimages differ exactly in outpoint (68..104) and amount (106..114)', hex(d0.preimage) !== hex(d1.preimage) && hex(d0.preimage.slice(0, 68)) === hex(d1.preimage.slice(0, 68)) && hex(d0.preimage.slice(114)) === hex(d1.preimage.slice(114)))
  }
  // input 1's unlock re-signed for input 0's slot but carrying input 1's preimage: build by hand -> CHECKSIG must fail
  const pre0 = sighashPreimage({ tx, inputIndex: 0, sourceSatoshis: satsA, scope: 0x41 })
  const pre1 = sighashPreimage({ tx, inputIndex: 1, sourceSatoshis: satsB, scope: 0x41 })
  check('the two inputs\' preimages differ only in outpoint/amount (hashPrevouts/hashSequence shared)', hex(pre0.slice(0, 68)) === hex(pre1.slice(0, 68)) && hex(pre0.slice(68, 104)) !== hex(pre1.slice(68, 104)) && hex(pre0.slice(106, 114)) !== hex(pre1.slice(106, 114)) && hex(pre0.slice(114)) === hex(pre1.slice(114)))
  // SDK end-to-end: templates + tx.sign() + tx.verify('scripts only')
  const tx2 = new Transaction(1, [], [], 0)
  tx2.addInput({ sourceTransaction: srcA, sourceOutputIndex: 0, sequence: 0xffffffff, unlockingScriptTemplate: r1CombUnlock2Template({ sourceSatoshis: satsA, lockingScript: lockA, p256PrivateKey: k1, salt: s1 }) })
  tx2.addInput({ sourceTransaction: srcB, sourceOutputIndex: 2, sequence: 0xffffffff, unlockingScriptTemplate: r1CombUnlock2Template({ sourceSatoshis: satsB, lockingScript: lockB, p256PrivateKey: k3, salt: s3 }) })
  tx2.addOutput({ satoshis: satsA + satsB - 2000, lockingScript: P2PKH_OUT() })
  let verified = false, verr = null
  try { await tx2.sign(); verified = await tx2.verify('scripts only') } catch (e) { verr = e.message.split('\n')[0] }
  check('2-input tx via templates: tx.sign() + tx.verify(\'scripts only\') (key#1 on A, key#3 on B)', verified, verr ?? `tx=${tx2.toBinary().length}B`)
  if (!verified && verr && /PUSH_TX/.test(verr)) console.log('   (PUSH_TX screen hit in template path — ~2^-16 event; rerun)')
  sizeTable.push({ N: 'A(2)+B(1) via templates', twoInputTxBytes: tx2.toBinary().length })
  // 1-input spend of the same lock for the tx-size comparison
  const { tx: tx1 } = buildSpend([inputs[0]], { nOut: 1 })
  console.log(`1-input spend tx size (lock A, 1 output): ${tx1.toBinary().length} B`)
  sizeTable.push({ N: 'A(2) 1-input 1-output', oneInputTxBytes: tx1.toBinary().length })
}

async function fuzz (rounds) {
  console.log(`── (v) fuzz x${rounds} at N=2 (random keys/salts/amounts/signer/outputs/sequence/locktime; 20% 2-input) ──`)
  let okCount = 0, screenHits = 0, twoIn = 0
  const t0 = performance.now()
  for (let i = 0; i < rounds; i++) {
    const m = [0, 1].map(() => { const priv = p256.utils.randomSecretKey(); return { priv, q: hex(p256.getPublicKey(priv, true)), salt: randSalt() } })
    const lock = buildLock2({ commitments: m.map(x => commitmentFor({ qCompressedHex: x.q, salt: x.salt })) })
    const sats = 1 + Math.floor(Math.random() * 2 ** 40)
    const vout = Math.floor(Math.random() * 3)
    const src = fundingTx(lock, sats, vout)
    const signer = m[Math.floor(Math.random() * 2)]
    const inputs = [{ src, vout, sats, priv: signer.priv, salt: signer.salt, lock }]
    if (Math.random() < 0.2) {         // second input: a different N=2 lock of the same two members, other signer
      const lock2 = buildLock2({ commitments: [1, 0].map(k => commitmentFor({ qCompressedHex: m[k].q, salt: m[k].salt })) })
      const sats2 = 1000 + Math.floor(Math.random() * 1e6)
      const other = m[1 - m.indexOf(signer)]
      inputs.push({ src: fundingTx(lock2, sats2, 0), vout: 0, sats: sats2, priv: other.priv, salt: other.salt, lock: lock2 })
      twoIn++
    }
    const final = Math.random() < 0.5
    const sequence = final ? 0xffffffff : (Math.random() < 0.5 ? 0xfffffffe : Math.floor(Math.random() * 0xfffffffe))
    const lockTime = final ? 0 : Math.floor(Math.random() * 800_000)
    const nOut = 1 + Math.floor(Math.random() * 3)
    let built
    try { built = buildSpend(inputs, { nOut, sequence, lockTime }) } catch (e) { check(`fuzz ${i}: build`, false, e.message); continue }
    const { tx, unlocks } = built
    let all = true; const det = []
    for (let k = 0; k < inputs.length; k++) {
      const v = validate({ tx, inputIndex: k, sourceSatoshis: inputs[k].sats, lockingScript: inputs[k].lock, unlockingScript: unlocks[k] })
      all &&= v.ok; det.push(`in${k}:pc=${v.pc}${v.err ? ' ' + v.err : ''} ${v.ms.toFixed(0)}ms u=${unlocks[k].toBinary().length}B`)
    }
    if (all) okCount++
    else check(`fuzz ${i}`, false, det.join(' | '))
    if (i % 20 === 0) console.log(`  fuzz ${i}: ok=${all} sats=${sats} seq=${sequence.toString(16)} lt=${lockTime} nOut=${nOut} inputs=${inputs.length} tx=${tx.toBinary().length}B ${det.join(' | ')}`)
  }
  const dt = performance.now() - t0
  check(`fuzz: ${okCount}/${rounds} validate (${twoIn} two-input cases)`, okCount === rounds, `${(dt / 1000).toFixed(1)} s total`)
  void screenHits
}

function stats (arr) {
  const s = [...arr].sort((a, b) => a - b)
  const q = p => s[Math.min(s.length - 1, Math.floor(p * s.length))]
  return { n: s.length, mean: s.reduce((a, b) => a + b, 0) / s.length, median: q(0.5), min: s[0], p95: q(0.95), max: s[s.length - 1] }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  await testOneOfN()
  await testNegatives()
  await testTwoInputs()
  await fuzz(Number(process.env.ROUNDS ?? 100))
  console.log('── sizes ──'); for (const r of sizeTable) console.log('  ' + JSON.stringify(r))
  const st = stats(validateTimes)
  console.log(`── Spend.validate() ms over ${st.n} successful validations: mean ${st.mean.toFixed(2)} median ${st.median.toFixed(2)} min ${st.min.toFixed(2)} p95 ${st.p95.toFixed(2)} max ${st.max.toFixed(2)}`)
  console.log(fails === 0 ? 'ALL PASS' : `${fails} FAILURE(S)`)
  process.exitCode = fails ? 1 : 0
}
