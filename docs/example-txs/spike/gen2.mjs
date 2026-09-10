// gen2.mjs — GENERALIZED R1 (P-256) comb-verifier locking script (prototype).
//
//   import { buildLock2, commitmentFor } from './gen2.mjs'
//   const lock = buildLock2({ commitments: [hex160, ...] })      // N = commitments.length (1..5 tested)
//   const c    = commitmentFor({ qCompressedHex, salt })          // hash160(salt || canonical Q comb table)
//
// Self-test:  node gen2.mjs   (proves the G-table / preloop / comb-loop / tail region is byte-identical to gen.mjs)
//
// Changes vs gen.mjs (the comb verifier core is UNCHANGED, see the byte-identity self-test):
//  (1) PREIMAGE FROM UNLOCK. The unlocking script pushes the full 158-byte BIP143 preimage (subscript OP_CHECKSIG,
//      scope 0x41). The lock does DUP HASH256 <00> CAT BIN2NUM -> e and parks the preimage on the altstack for the
//      OP_PUSH_TX tail. Nothing about version / prevouts / sequence / amount / locktime is baked any more, so the lock
//      is amount-agnostic and works for any input position of a multi-input tx.
//  (2) COMMIT-TO-TABLE 1-of-N. The Q comb table (32 points = 64 coordinates) is pushed by the unlocker together with a
//      32-byte salt; the lock recomputes H = hash160(salt || NUM2BIN33(c0) || ... || NUM2BIN33(c63)) and requires
//      H == one of N baked 20-byte commitments (DUP/EQUAL/SWAP ... BOOLOR chain, OP_VERIFY).
//      Canonical serialization: every coordinate as exactly 33 bytes = OP_NUM2BIN(coord, 33) = LE magnitude zero-padded
//      (unambiguous, fixed width; +3 lock bytes per coordinate over hashing the raw pushes).
//  (3) OP_PUSH_TX tail kept verbatim (k = 1 secp256k1 signature, 2^248 dummy key — not a spend path).
//
// STACK DESIGN (keeps the comb loop body byte-identical):
//   The original loop expects [r A B C[0..63] C[64..127] X Y Z] with A paired with C[0..63] and B with C[64..127].
//   Here the UNLOCKER pushes r, u2', u1' (the recoded scalars) and the Q table, so that after the header the stack is
//        [r u2' u1' Q[0..63] G[0..63] X Y Z]         (G pushed by the lock, above Q)
//   i.e. the two halves swap roles (first add = u2'*Q, second add = u1'*G; the sum is the same point) and no item ever
//   has to be buried below the 64 Q coordinates. The lock VERIFIES the pushed u1', u2' against
//   recode(e*sInv mod n) / recode(r*sInv mod n) with the same arithmetic the original used to COMPUTE them.
//
// Unlocking script (bottom -> top), 71 pushes:
//   r  u2'  u1'  Qx0 Qy0 ... Qx31 Qy31  salt  s  sInv  preimage
import fs from 'fs'
import { LockingScript, OP, Curve, PrivateKey, Utils, Hash } from '@bsv/sdk'
import { p256 } from '@noble/curves/nist.js'
import {
  asm, encNum, pushData, scriptNum, combTable, buildLock as buildLock1,
  P256_N, P256_P, SECP_N, SECP_GX, TABLE_SIZE, COMB_ROWS, COMB_COLS, shiftFor
} from './gen.mjs'

export { asm, encNum, pushData, scriptNum, combTable, P256_N, P256_P, SECP_N, SECP_GX }

const hex = a => Buffer.from(a).toString('hex')
const bytesOf = h => [...Buffer.from(h, 'hex')]
const mod = (a, m) => ((a % m) + m) % m
const modpow = (b, e, m) => { let r = 1n; b = mod(b, m); while (e > 0n) { if (e & 1n) r = r * b % m; b = b * b % m; e >>= 1n } return r }
const modinv = (a, m) => modpow(a, m - 2n, m)

const RECODE_BITS = COMB_ROWS * COMB_COLS                 // 258
export const RECODE_CONST = (1n << BigInt(RECODE_BITS)) - 1n
export const K_Q = 2 * TABLE_SIZE                         // 64 Q coordinates pushed by the unlocker
export const COORD_WIDTH = 33                             // canonical NUM2BIN width per coordinate
export const SALT_BYTES = 32

/** Scalar recoding used by the comb: u' = ((u odd ? u : u + n) + 2^258 - 1) / 2  (== the script's R2 arithmetic). */
export function recode (u) {
  u = mod(BigInt(u), P256_N)
  if (u % 2n === 0n) u += P256_N
  return (u + RECODE_CONST) / 2n
}

/** OP_NUM2BIN(v, 33) for a non-negative v: minimal LE sign-magnitude, zero-padded to 33 bytes. */
export function le33 (v) {
  const b = scriptNum(v)
  if (BigInt(v) < 0n || b.length > COORD_WIDTH) throw new Error('coordinate out of range for NUM2BIN 33')
  while (b.length < COORD_WIDTH) b.push(0)
  return b
}

/** Canonical bytes the lock hashes: salt || le33(x0) || le33(y0) || ... || le33(y31). */
export function canonicalTableBytes ({ qCompressedHex, salt }) {
  const saltBytes = normSalt(salt)
  const Q = p256.Point.fromHex(qCompressedHex); Q.assertValidity()
  const out = [...saltBytes]
  for (const { x, y } of combTable(Q)) out.push(...le33(x), ...le33(y))
  return out
}

/** hash160(salt || canonical Q comb table) as a 40-char hex string — the value baked into the lock. */
export function commitmentFor ({ qCompressedHex, salt }) {
  return hex(Hash.hash160(canonicalTableBytes({ qCompressedHex, salt })))
}

export function normSalt (salt) {
  const b = typeof salt === 'string' ? bytesOf(salt) : [...salt]
  if (b.length !== SALT_BYTES) throw new Error(`salt must be ${SALT_BYTES} bytes`)
  return b
}

// ───────────────────────────── header (new) ─────────────────────────────
/**
 * Stack in (unlock): [r u2' u1' Q0..Q63 salt s sInv preimage]      alt: []
 * Stack out:         [r u2' u1' Q0..Q63]                           alt: [preimage n]
 */
export function emitHeader2 ({ commitments }) {
  const K = K_Q
  const out = []
  // H0: e = unsigned-LE(hash256(preimage)); preimage -> alt
  out.push(...asm('OP_DUP OP_HASH256 <00> OP_CAT OP_BIN2NUM OP_SWAP OP_TOALTSTACK'))
  // H1: n -> alt; s*sInv == 1; u1 = e*sInv; u2 = r*sInv (r sits under salt + 64 coords + u1' + u2'); drop s, sInv
  //     [.. salt s sInv u1]: u1(0) sInv(1) s(2) salt(3) Q63(4) .. Q0(3+K) u1'(4+K) u2'(5+K) r(6+K)
  out.push(...asm(`
    {N} OP_TOALTSTACK
    2 OP_PICK 2 OP_PICK OP_MUL MODP 1 OP_NUMEQUALVERIFY
    OP_OVER OP_MUL MODP
    {RDEPTH} OP_PICK 2 OP_PICK OP_MUL MODP
    2 OP_ROLL OP_DROP 2 OP_ROLL OP_DROP
  `, { N: P256_N, RDEPTH: K + 6 }))
  // H2: recode u2 then u1 (identical to gen.mjs R2) -> [.. salt u1' u2']
  const one = 'OP_DUP 2 OP_MOD OP_NOTIF {N} OP_ADD OP_ENDIF {C} OP_ADD 2 OP_DIV OP_SWAP'
  out.push(...asm(`${one} ${one}`, { N: P256_N, C: RECODE_CONST }))
  // H3: computed u2' == pushed u2' (depth K+4), then computed u1' == pushed u1' (depth K+2) -> [r u2' u1' Q.. salt]
  out.push(...asm('{DU2} OP_PICK OP_NUMEQUALVERIFY {DU1} OP_PICK OP_NUMEQUALVERIFY', { DU2: K + 4, DU1: K + 2 }))
  // H4: acc = salt; acc ||= NUM2BIN33(Q_m) for m = 0..63 (Q_m at depth K - m); H = hash160(acc)
  for (let m = 0; m < K; m++) out.push(...asm('{D} OP_PICK {W} OP_NUM2BIN OP_CAT', { D: K - m, W: COORD_WIDTH }))
  out.push(OP.OP_HASH160)
  // H5: H == any baked commitment
  const cs = commitments.map(c => typeof c === 'string' ? bytesOf(c) : [...c])
  if (cs.length === 1) out.push(...asm('{C} OP_EQUALVERIFY', { C: cs[0] }))
  else {
    for (let i = 0; i < cs.length - 1; i++) out.push(...asm('OP_DUP {C} OP_EQUAL OP_SWAP', { C: cs[i] }))
    out.push(...asm('{C} OP_EQUAL', { C: cs[cs.length - 1] }))
    for (let i = 0; i < cs.length - 1; i++) out.push(OP.OP_BOOLOR)
    out.push(OP.OP_VERIFY)
  }
  return out
}

// ───────────────────────────── shared suffix (copied verbatim from gen.mjs; byte-identity is asserted in selfTest) ─────────────────────────────
function emitGTable () {
  const out = []
  for (const { x, y } of combTable(p256.Point.BASE)) out.push(...encNum(x), ...encNum(y))
  return out
}
function emitPreloop () { return asm('{P} OP_FROMALTSTACK OP_DROP OP_TOALTSTACK 1 1 0', { P: P256_P }) }

const DOUBLE = `
  OP_DUP OP_DUP OP_MUL
  3 OP_PICK OP_OVER OP_SUB
  4 OP_PICK 2 OP_ROLL OP_ADD
  1 OP_ROLL 1 OP_ROLL
  OP_MUL 3 OP_MUL
  2 OP_PICK OP_DUP OP_MUL
  4 OP_ROLL OP_OVER OP_MUL 4 OP_MUL
  2 OP_PICK OP_DUP OP_MUL
  OP_OVER OP_2MUL
  1 OP_ROLL 1 OP_ROLL
  OP_SUB MODP NORM
  1 OP_ROLL OP_OVER OP_SUB
  3 OP_ROLL 1 OP_ROLL OP_MUL
  2 OP_ROLL OP_DUP OP_MUL 8 OP_MUL
  1 OP_ROLL 1 OP_ROLL OP_SUB MODP NORM
  3 OP_ROLL 3 OP_ROLL OP_MUL OP_2MUL MODP NORM
  2 OP_ROLL 2 OP_ROLL 2 OP_ROLL
`
const DIGITS_AND_LOOKUP = `
  {DEPTH0} OP_PICK {SHIFT0} OP_RSHIFTNUM 2 OP_MOD
  {DEPTH1} OP_PICK {SHIFT1} OP_RSHIFTNUM 2 OP_MOD OP_OVER OP_NUMEQUAL OP_2MUL
  {DEPTH2} OP_PICK {SHIFT2} OP_RSHIFTNUM 2 OP_MOD 2 OP_PICK OP_NUMEQUAL OP_ADD OP_2MUL
  {DEPTH2} OP_PICK {SHIFT3} OP_RSHIFTNUM 2 OP_MOD 2 OP_PICK OP_NUMEQUAL OP_ADD OP_2MUL
  {DEPTH2} OP_PICK {SHIFT4} OP_RSHIFTNUM 2 OP_MOD 2 OP_PICK OP_NUMEQUAL OP_ADD OP_2MUL
  {DEPTH2} OP_PICK {SHIFT5} OP_RSHIFTNUM 2 OP_MOD 2 OP_PICK OP_NUMEQUAL OP_ADD
  OP_DUP OP_2MUL {BASE} OP_SWAP OP_SUB OP_PICK
  OP_OVER OP_2MUL {BASE} OP_SWAP OP_SUB OP_PICK
  2 OP_ROLL OP_DROP 2 OP_ROLL
  OP_NOTIF OP_FROMALTSTACK OP_DUP OP_TOALTSTACK OP_SWAP OP_SUB OP_ENDIF
`
const GUARD_PREFIX = '2 OP_PICK 0 OP_NUMEQUAL OP_IF OP_TOALTSTACK OP_TOALTSTACK OP_DROP OP_DROP OP_DROP OP_FROMALTSTACK OP_FROMALTSTACK 1 OP_ELSE'
const GUARD_SUFFIX = 'OP_ENDIF'
const MADD = `
  2 OP_PICK OP_DUP OP_MUL
  2 OP_ROLL OP_OVER OP_MUL
  3 OP_PICK 2 OP_ROLL OP_MUL
  2 OP_ROLL 1 OP_ROLL OP_MUL
  1 OP_ROLL 4 OP_PICK OP_SUB
  1 OP_ROLL 3 OP_PICK OP_SUB
  OP_OVER OP_DUP OP_MUL
  2 OP_PICK OP_OVER OP_MUL
  6 OP_ROLL 2 OP_ROLL OP_MUL
  2 OP_PICK OP_DUP OP_MUL
  OP_OVER OP_2MUL
  1 OP_ROLL 3 OP_PICK OP_SUB
  1 OP_ROLL OP_SUB MODP NORM
  1 OP_ROLL OP_OVER OP_SUB
  3 OP_ROLL 1 OP_ROLL OP_MUL
  5 OP_ROLL 3 OP_ROLL OP_MUL
  1 OP_ROLL 1 OP_ROLL OP_SUB MODP NORM
  3 OP_ROLL 3 OP_ROLL OP_MUL MODP NORM
  2 OP_ROLL 2 OP_ROLL 2 OP_ROLL
`
const K_CONSTS = 2 * 2 * TABLE_SIZE            // 128 table coordinates on the stack (Q[0..63] then G[0..63])
const BELOW = 3 + K_CONSTS                     // items under the accumulator (X Y Z)
const scalarDepth = half => BELOW + 1 - half   // half 0 -> stack index 1 (= u2' here), half 1 -> index 2 (= u1' here)
const tableBase = half => (BELOW + 1) - 2 * TABLE_SIZE * half   // half 0 -> C[0..63] (= Q here), half 1 -> C[64..127] (= G here)

function emitAdd (half, c, guarded) {
  const params = { DEPTH0: scalarDepth(half), DEPTH1: scalarDepth(half) + 1, DEPTH2: scalarDepth(half) + 2, BASE: tableBase(half) }
  for (let k = 0; k < COMB_ROWS; k++) params['SHIFT' + k] = shiftFor(c, k)
  return asm(`${DIGITS_AND_LOOKUP} ${guarded ? GUARD_PREFIX : ''} ${MADD} ${guarded ? GUARD_SUFFIX : ''}`, params)
}
function emitCombLoop () {
  const out = []
  for (let c = 0; c < COMB_COLS; c++) {
    out.push(...asm(DOUBLE))
    out.push(...emitAdd(0, c, c === 0))     // first add: index-1 scalar (u2') with C[0..63] (Q), identity-guarded
    out.push(...emitAdd(1, c, false))       // second add: index-2 scalar (u1') with C[64..127] (G)
  }
  return out
}
function derIntBytes (v) {
  let h = v.toString(16); if (h.length % 2) h = '0' + h
  const b = bytesOf(h)
  if (b[0] & 0x80) b.unshift(0)
  return [0x02, b.length, ...b]
}
function emitTail ({ sighash }) {
  const rDepth = BELOW + 3
  const rCheck = asm(`
    OP_DUP 0 OP_NUMEQUAL OP_NOTIF
      OP_DUP OP_DUP OP_MUL MODP
      {RDEPTH} OP_PICK OP_OVER OP_MUL MODP
      4 OP_PICK OP_NUMEQUAL
    OP_ELSE 0 OP_ENDIF OP_VERIFY
    OP_FROMALTSTACK OP_DROP
  `, { RDEPTH: rDepth })
  const leftover = BELOW + 4
  const clear = [...Array(Math.floor(leftover / 2)).fill(OP.OP_2DROP), ...(leftover % 2 ? [OP.OP_DROP] : [])]
  const secp = new Curve()
  const d = mod((1n << 248n) * modinv(SECP_GX, SECP_N), SECP_N)
  const pushTxPubKey = new PrivateKey(d.toString(16).padStart(64, '0'), 16).toPublicKey().encode(true)
  const rev31 = Array(31).fill('OP_SWAP OP_CAT').join(' ')
  const pushTx = asm(`
    OP_FROMALTSTACK {SIGHASH} OP_TOALTSTACK OP_HASH256
    ${Array(31).fill('1 OP_SPLIT').join(' ')}
    ${rev31}
    <00> OP_CAT OP_BIN2NUM
    0 31 OP_NUM2BIN 1 OP_CAT OP_ADD
    {NK} OP_TUCK 2 OP_DIV OP_OVER OP_LESSTHAN
    OP_IF OP_OVER OP_MOD OP_OVER 2 OP_DIV OP_OVER OP_LESSTHAN OP_IF OP_SUB OP_ELSE OP_NIP OP_ENDIF
    OP_ELSE OP_NIP OP_ENDIF
    ${Array(31).fill('OP_DUP OP_0NOTEQUAL OP_SPLIT').join(' ')}
    ${rev31}
    OP_SIZE OP_SWAP OP_CAT
    {DERPREFIX} OP_SWAP OP_CAT
    OP_SIZE OP_SWAP OP_CAT
    <30> OP_SWAP OP_CAT
    OP_FROMALTSTACK OP_CAT
    {PUBKEY} OP_CODESEPARATOR OP_CHECKSIG
  `, { SIGHASH: [sighash], NK: SECP_N, DERPREFIX: [...derIntBytes(SECP_GX), 0x02], PUBKEY: pushTxPubKey })
  void secp
  return [...rCheck, ...clear, ...pushTx]
}

/** G table + preloop + comb loop + tail: the region that must be byte-identical to gen.mjs's chunks [87..150] ++ [215..end]. */
export function emitSharedSuffix ({ sighash = 0x41 } = {}) {
  return [...emitGTable(), ...emitPreloop(), ...emitCombLoop(), ...emitTail({ sighash })]
}

// ───────────────────────────── public API ─────────────────────────────
/**
 * @param {object} a
 * @param {string[]} a.commitments   N >= 1 hash160 commitments (40-char hex), see commitmentFor()
 * @param {number} [a.sighash=0x41]  ALL|FORKID; appended to the OP_PUSH_TX signature (the unlocker's preimage must use it)
 */
export function buildLock2 ({ commitments, sighash = 0x41 }) {
  if (!Array.isArray(commitments) || commitments.length < 1) throw new Error('commitments: non-empty array of hash160 hex')
  for (const c of commitments) if (typeof c !== 'string' || !/^[0-9a-f]{40}$/i.test(c)) throw new Error('commitment must be 40 hex chars: ' + c)
  if (new Set(commitments.map(c => c.toLowerCase())).size !== commitments.length) throw new Error('duplicate commitment')
  if (sighash !== 0x41) throw new Error('only sighash 0x41 (ALL|FORKID) is supported: hashPrevouts/hashSequence semantics of the PUSH_TX leg')
  return LockingScript.fromBinary([...emitHeader2({ commitments }), ...emitSharedSuffix({ sighash })])
}

/** Read the baked commitments back out of a lock produced by buildLock2 (20-byte pushes between OP_HASH160 and the VERIFY). */
export function bakedCommitments (lockingScript) {
  const c = lockingScript.chunks
  const h = c.findIndex(k => k.op === OP.OP_HASH160)
  if (h < 0) throw new Error('not a gen2 locking script (no OP_HASH160)')
  const out = []
  for (let i = h + 1; i < c.length; i++) {
    if (c[i].data?.length === 20) out.push(hex(c[i].data))
    if (c[i].op === OP.OP_EQUALVERIFY || c[i].op === OP.OP_VERIFY) break
  }
  if (!out.length) throw new Error('no commitments found')
  return out
}

/** Chunk-index / byte-offset map of the regions of a gen2 lock (for reporting). */
export function layout2 (lockingScript) {
  const c = lockingScript.chunks
  const offs = []; let off = 0
  for (const k of c) { offs.push(off); off += 1 + (k.data ? (k.op <= 75 ? k.data.length : k.op === 76 ? 1 + k.data.length : k.op === 77 ? 2 + k.data.length : 4 + k.data.length) : 0) }
  offs.push(off)
  const h160 = c.findIndex(k => k.op === OP.OP_HASH160)
  const firstNum2bin = c.findIndex(k => k.op === OP.OP_NUM2BIN)
  let verifyEnd = h160; while (c[verifyEnd].op !== OP.OP_VERIFY && c[verifyEnd].op !== OP.OP_EQUALVERIFY) verifyEnd++
  const gStart = verifyEnd + 1
  const pStart = gStart + 2 * TABLE_SIZE              // G table = 32 points x (x, y) = 64 coordinate pushes
  const loopStart = pStart + 7                         // {P} FROMALT DROP TOALT 1 1 0
  const nqv = []; for (let i = 0; i < c.length; i++) if (c[i].op === OP.OP_NUMEQUALVERIFY) nqv.push(i)
  // tail = rCheck + clear + PUSH_TX; rCheck opens with the unique sequence OP_DUP OP_0 OP_NUMEQUAL OP_NOTIF
  const tails = []
  for (let i = loopStart; i + 3 < c.length; i++) if (c[i].op === OP.OP_DUP && c[i + 1].op === OP.OP_0 && c[i + 2].op === OP.OP_NUMEQUAL && c[i + 3].op === OP.OP_NOTIF) tails.push(i)
  if (tails.length !== 1) throw new Error(`tail pattern not unique: ${tails.length} matches`)
  const tailStart = tails[0]
  return {
    totalBytes: off, totalChunks: c.length, tailChunks: c.length - tailStart,
    regions: [
      ['H0 preimage->e, preimage->alt', 0, 6],
      ['H1 n->alt, s*sInv==1, u1, u2, drop s sInv', 7, nqv[0] + 21],
      ['H2 recode u2, u1', nqv[0] + 22, nqv[1] - 3],
      ['H3 pushed u2\'/u1\' == computed', nqv[1] - 2, nqv[2]],
      ['H4 canonical concat (64x PICK NUM2BIN CAT)', nqv[2] + 1, h160 - 1],
      ['H4 OP_HASH160', h160, h160],
      ['H5 commitment compare chain + VERIFY', h160 + 1, verifyEnd],
      ['G table (64 pushes)', gStart, pStart - 1],
      ['preloop (p, alt swap, acc=(1,1,0))', pStart, loopStart - 1],
      ['comb loop (43 x [DOUBLE, add u2\'*Q, add u1\'*G])', loopStart, tailStart - 1],
      ['tail (r check 28, clear 68, OP_PUSH_TX+CHECKSIG 331)', tailStart, c.length - 1]
    ].map(([name, a, b]) => ({ name, chunks: [a, b], bytes: [offs[a], offs[b + 1] - 1], size: offs[b + 1] - offs[a] }))
  }
}

// ───────────────────────────── self-test ─────────────────────────────
export function selfTest () {
  const FIXTURE_Q = '03f4d667712d8825372cd616b0b1b1a818e5eeb3681dd45c5bdd59fed9f21d5a7d'
  const orig = buildLock1({ qCompressedHex: FIXTURE_Q, satoshis: 4600 })
  const oc = orig.chunks
  // byte-identity of the shared suffix: original chunks [87..150] (G table) ++ [215..end]
  const origSuffix = LockingScript.fromBinary([]); origSuffix.chunks = [...oc.slice(87, 151), ...oc.slice(215)]
  const mine = emitSharedSuffix()
  const same = hex(mine) === origSuffix.toHex()
  console.log(`shared suffix (G table + preloop + loop + tail): ${mine.length} bytes; byte-identical to gen.mjs: ${same}`)
  if (!same) {
    const a = Buffer.from(mine), b = Buffer.from(origSuffix.toHex(), 'hex')
    let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++
    console.log(`  first difference at suffix byte ${i}; lengths ${a.length} vs ${b.length}`)
  }
  const salts = [...Array(5)].map((_, i) => hex(Buffer.alloc(32, i + 1)))
  const keys = [...Array(5)].map(() => hex(p256.getPublicKey(p256.utils.randomSecretKey(), true)))
  for (let N = 1; N <= 5; N++) {
    const commitments = keys.slice(0, N).map((q, i) => commitmentFor({ qCompressedHex: q, salt: salts[i] }))
    const lock = buildLock2({ commitments })
    const back = bakedCommitments(lock)
    const ok = back.length === N && back.every((c, i) => c === commitments[i])
    console.log(`N=${N}: lock ${lock.toBinary().length} bytes / ${lock.chunks.length} chunks; bakedCommitments round-trip ${ok}`)
    for (const r of layout2(lock).regions) console.log(`   ${r.name.padEnd(52)} chunks ${String(r.chunks[0]).padStart(5)}..${String(r.chunks[1]).padStart(5)}  bytes ${String(r.bytes[0]).padStart(5)}..${String(r.bytes[1]).padStart(5)}  (${r.size} B)`)
  }
  return same
}
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  process.exitCode = selfTest() ? 0 : 1
}
