// gen.mjs — generator for the R1 (P-256) comb-verifier locking script.
//
//   import { buildLock } from './gen.mjs'
//   const lock = buildLock({ qCompressedHex, satoshis })   // -> @bsv/sdk LockingScript
//
// Self-test (diff against the fixture + Spend.validate):   node gen.mjs
//
// The script verifies a P-256 ECDSA signature (r, s, sInv) over the BIP143 sighash
// preimage that it rebuilds in-script, using a 6-row x 43-column fixed-base comb for
// both G and Q (Shamir), Jacobian coordinates with lazy reduction mod p, and then
// binds the preimage to the real spending transaction with an OP_PUSH_TX (k = 1)
// secp256k1 signature checked by OP_CHECKSIG.
//
// Every numeric constant is emitted with the minimal script-number encoding (encNum);
// byte-string fields of the preimage (version, sequence, amount, locktime, sighash),
// the <00> unsigned pads, and the DER/sighash constants are emitted as raw pushes.
import fs from 'fs'
import { LockingScript, OP, BigNumber, Curve, PrivateKey, Utils, Spend, Transaction } from '@bsv/sdk'
import { p256 } from '@noble/curves/nist.js'

// ───────────────────────────── curve constants ─────────────────────────────
const P256 = p256.Point.CURVE()                 // { p, n, Gx, Gy, ... } as bigint
export const P256_P = P256.p
export const P256_N = P256.n
const secp = new Curve()                        // secp256k1 (for OP_PUSH_TX)
export const SECP_N = BigInt('0x' + secp.n.toHex())
export const SECP_GX = BigInt('0x' + secp.g.x.toHex())

// comb geometry: 6 rows x 43 columns = 258 signed digits (scalar recoded to u' < 2^258)
export const COMB_ROWS = 6
export const COMB_COLS = 43
export const TABLE_SIZE = 1 << (COMB_ROWS - 1)  // 32 entries per base point
const RECODE_BITS = COMB_ROWS * COMB_COLS       // 258
const RECODE_CONST = (1n << BigInt(RECODE_BITS)) - 1n   // 2^258 - 1

// ───────────────────────────── byte helpers ─────────────────────────────
const hex = a => Buffer.from(a).toString('hex')
const bytesOf = h => [...Buffer.from(h, 'hex')]
const mod = (a, m) => ((a % m) + m) % m
const modpow = (b, e, m) => { let r = 1n; b = mod(b, m); while (e > 0n) { if (e & 1n) r = r * b % m; b = b * b % m; e >>= 1n } return r }
const modinv = (a, m) => modpow(a, m - 2n, m)   // m prime

/** Raw data push with the minimal push opcode (direct length, PUSHDATA1/2/4). */
export function pushData (data) {
  const d = [...data]
  if (d.length === 0) return [OP.OP_0]
  if (d.length <= 75) return [d.length, ...d]
  if (d.length <= 0xff) return [OP.OP_PUSHDATA1, d.length, ...d]
  if (d.length <= 0xffff) return [OP.OP_PUSHDATA2, d.length & 0xff, d.length >>> 8, ...d]
  return [OP.OP_PUSHDATA4, d.length & 0xff, (d.length >>> 8) & 0xff, (d.length >>> 16) & 0xff, (d.length >>> 24) & 0xff, ...d]
}

/** Minimal script-number encoding of a bigint (sign-magnitude little-endian) == BigNumber.toSm('little'). */
export function scriptNum (v) {
  v = BigInt(v)
  if (v === 0n) return []
  const neg = v < 0n
  let m = neg ? -v : v
  const b = []
  while (m > 0n) { b.push(Number(m & 0xffn)); m >>= 8n }
  if (b[b.length - 1] & 0x80) b.push(neg ? 0x80 : 0x00)
  else if (neg) b[b.length - 1] |= 0x80
  return b
}

/** Push a bigint as a minimally-encoded script number (OP_0, OP_1..OP_16, OP_1NEGATE, or data push). */
export function encNum (v) {
  v = BigInt(v)
  if (v === 0n) return [OP.OP_0]
  if (v >= 1n && v <= 16n) return [OP.OP_1 + Number(v) - 1]
  if (v === -1n) return [OP.OP_1NEGATE]
  return pushData(scriptNum(v))
}

// ───────────────────────────── tiny assembler ─────────────────────────────
// Tokens: OP_NAME | decimal integer (encNum) | <hex> (raw push) | {PARAM} | macro name.
const MACROS = {
  // reduce top mod p, p lives on the altstack (never consumed)
  MODP: 'OP_FROMALTSTACK OP_DUP OP_TOALTSTACK OP_MOD',
  // BSV OP_MOD keeps the dividend's sign: normalise a negative remainder into [0, p)
  NORM: 'OP_DUP 0 OP_LESSTHAN OP_IF OP_FROMALTSTACK OP_DUP OP_TOALTSTACK OP_ADD OP_ENDIF'
}
export function asm (text, params = {}) {
  const out = []
  for (const tok of text.trim().split(/\s+/)) {
    if (tok === '') continue
    if (MACROS[tok] !== undefined) { out.push(...asm(MACROS[tok], params)); continue }
    if (tok.startsWith('{') && tok.endsWith('}')) {
      const v = params[tok.slice(1, -1)]
      if (v === undefined) throw new Error('asm: missing param ' + tok)
      out.push(...(typeof v === 'bigint' || typeof v === 'number' ? encNum(v) : pushData(v)))
      continue
    }
    if (tok.startsWith('<') && tok.endsWith('>')) { out.push(...pushData(bytesOf(tok.slice(1, -1)))); continue }
    if (/^-?\d+$/.test(tok)) { out.push(...encNum(BigInt(tok))); continue }
    if (OP[tok] === undefined) throw new Error('asm: unknown opcode ' + tok)
    out.push(OP[tok])
  }
  return out
}

// ───────────────────────────── comb tables ─────────────────────────────
/**
 * Comb table scalar for entry j (0 <= j < 2^(rows-1)):
 *   T_j = 2^(w*(rows-1)) + sum_{k<rows-1} (bit_k(j) ? +1 : -1) * 2^(w*k),  w = COMB_COLS
 * i.e. the top digit is fixed +1 (the sign digit is applied by negating y in-script)
 * and the lower digits are the signed-binary digits addressed by j.
 */
export function combTableScalar (j, rows = COMB_ROWS, w = COMB_COLS) {
  let s = 1n << BigInt(w * (rows - 1))
  for (let k = 0; k < rows - 1; k++) s += ((j >> k) & 1 ? 1n : -1n) << BigInt(w * k)
  return s
}
/** 32 affine points T_j * Base as { x, y } bigints. */
export function combTable (base) {
  const pts = []
  for (let j = 0; j < TABLE_SIZE; j++) {
    const k = mod(combTableScalar(j), P256_N)
    const pt = base.multiply(k).toAffine()
    pts.push({ x: pt.x, y: pt.y })
  }
  return pts
}

// ───────────────────────────── script regions ─────────────────────────────
const le64 = v => { const w = new Utils.Writer(); w.writeUInt64LE(Number(v)); return w.toArray() }
const le32 = v => { const w = new Utils.Writer(); w.writeUInt32LE(Number(v)); return w.toArray() }

/** R0: rebuild the BIP143 preimage from the unlock pushes (hashOutputs, outpoint) + baked fields,
 *  compute e = unsigned-LE(hash256(preimage)) and park the preimage on the altstack.
 *  Entry stack: [r s sInv hashOutputs outpoint]; exit: [r s sInv e], alt: [preimage]. */
function emitPreimageBuild ({ satoshis, version, sequence, lockTime, sighash }) {
  return asm(`
    OP_DUP OP_HASH256 {VERSION} OP_SWAP OP_CAT
    {SEQUENCE} OP_HASH256 OP_CAT
    OP_SWAP OP_CAT
    <01ac> OP_CAT
    {AMOUNT} OP_CAT
    {SEQUENCE} OP_CAT
    OP_SWAP OP_CAT
    {LOCKTIME} OP_CAT
    {SIGHASH} OP_CAT
    OP_DUP OP_HASH256 <00> OP_CAT OP_BIN2NUM
    OP_SWAP OP_TOALTSTACK
  `, {
    VERSION: le32(version), SEQUENCE: le32(sequence), AMOUNT: le64(satoshis),
    LOCKTIME: le32(lockTime), SIGHASH: le32(sighash)
  })
}

/** R1: push n; require s*sInv == 1 (mod n); u1 = e*sInv mod n; u2 = r*sInv mod n; drop s, sInv.
 *  Exit stack: [r u1 u2], alt: [preimage n]. */
function emitScalarMath () {
  return asm(`
    {N} OP_TOALTSTACK
    2 OP_PICK 2 OP_PICK OP_MUL MODP 1 OP_NUMEQUALVERIFY
    OP_OVER OP_MUL MODP
    3 OP_PICK 2 OP_PICK OP_MUL MODP
    2 OP_ROLL OP_DROP 2 OP_ROLL OP_DROP
  `, { N: P256_N })
}

/** R2: recode u -> u' = ((u odd ? u : u + n) + 2^258 - 1) / 2, so that u = sum (2*bit_i(u') - 1) 2^i.
 *  Applied to u2 then u1 (SWAP in between); exit stack: [r u1' u2']. */
function emitRecode () {
  const one = 'OP_DUP 2 OP_MOD OP_NOTIF {N} OP_ADD OP_ENDIF {C} OP_ADD 2 OP_DIV OP_SWAP'
  return asm(`${one} ${one}`, { N: P256_N, C: RECODE_CONST })
}

/** R3: 128 constants = 32 (x, y) pairs for G then 32 for Q. */
function emitTables (Q) {
  const out = []
  for (const base of [p256.Point.BASE, Q]) {
    for (const { x, y } of combTable(base)) out.push(...encNum(x), ...encNum(y))
  }
  return out
}

/** R4+R5: push p; swap altstack top n -> p; accumulator := Jacobian infinity (1, 1, 0). */
function emitPreloop () {
  return asm('{P} OP_FROMALTSTACK OP_DROP OP_TOALTSTACK 1 1 0', { P: P256_P })
}

// Jacobian doubling, a = -3 (dbl-2001-b): M = 3(X-Z^2)(X+Z^2), S = 4XY^2,
// X3 = M^2 - 2S, Y3 = M(S - X3) - 8Y^4, Z3 = 2YZ. Only X3, Y3, Z3 are reduced.
// The `1 OP_ROLL 1 OP_ROLL` pairs and the trailing 3x `2 OP_ROLL` are no-ops kept for byte-exactness.
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

// Digit extraction + table lookup + conditional negation. Stack in: [.. X Y Z]; out: [.. X Y Z x y].
// Row 0 bit = sign digit; rows 1..4 are XNOR'd against it to form the 5-bit table index j.
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

// Identity guard (column 0, G add only): if Z == 0 replace the accumulator by (x, y, 1).
const GUARD_PREFIX = '2 OP_PICK 0 OP_NUMEQUAL OP_IF OP_TOALTSTACK OP_TOALTSTACK OP_DROP OP_DROP OP_DROP OP_FROMALTSTACK OP_FROMALTSTACK 1 OP_ELSE'
const GUARD_SUFFIX = 'OP_ENDIF'

// Mixed Jacobian + affine addition: U2 = xZ^2, S2 = yZ^3, H = U2 - X, R = S2 - Y,
// X3 = R^2 - H^3 - 2XH^2, Y3 = R(XH^2 - X3) - YH^3, Z3 = ZH. Only X3, Y3, Z3 are reduced.
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

/** Stack layout beneath the accumulator: [r u1' u2' C[0..K-1]] with K = 2 * 2 * TABLE_SIZE constants. */
const K_CONSTS = 2 * 2 * TABLE_SIZE            // 128
const BELOW = 3 + K_CONSTS                     // items under the accumulator (X Y Z)
// With [.. X Y Z] on top (BELOW + 3 items): u1' is item index 1 -> depth (BELOW + 3) - 1 - 1 = 132; u2' -> 131.
const scalarDepth = half => BELOW + 1 - half
// With [.. X Y Z sign j] on top (BELOW + 5 items), C[m] (index 3 + m) sits at depth (BELOW + 5) - 1 - (3 + m) = 132 - m;
// x_j = C[2*TABLE_SIZE*half + 2j] -> depth BASE - 2j with BASE = 132 - 64*half (same constant works for y:
// the stack is one deeper and y is one index higher, the offsets cancel).
const tableBase = half => (BELOW + 1) - 2 * TABLE_SIZE * half
/** Shift for column c, row k: bit position 43k + 42 - c of the recoded scalar. */
export const shiftFor = (c, k) => COMB_COLS * (COMB_ROWS - 1 - k) + (COMB_COLS - 1 - c)   // 257 - c - 43k

function emitAdd (half, c, guarded) {
  const params = {
    DEPTH0: scalarDepth(half), DEPTH1: scalarDepth(half) + 1, DEPTH2: scalarDepth(half) + 2,
    BASE: tableBase(half)
  }
  for (let k = 0; k < COMB_ROWS; k++) params['SHIFT' + k] = shiftFor(c, k)
  return asm(`${DIGITS_AND_LOOKUP} ${guarded ? GUARD_PREFIX : ''} ${MADD} ${guarded ? GUARD_SUFFIX : ''}`, params)
}

/** R6: 43 columns, Horner: acc = 2*acc + d1(c)*TG[j1] + d2(c)*TQ[j2]. */
function emitCombLoop () {
  const out = []
  for (let c = 0; c < COMB_COLS; c++) {
    out.push(...asm(DOUBLE))
    out.push(...emitAdd(0, c, c === 0))
    out.push(...emitAdd(1, c, false))
  }
  return out
}

/** DER INTEGER body for a non-negative bigint: minimal big-endian with a 0x00 pad if the top bit is set. */
function derIntBytes (v) {
  let h = v.toString(16); if (h.length % 2) h = '0' + h
  const b = bytesOf(h)
  if (b[0] & 0x80) b.unshift(0)
  return [0x02, b.length, ...b]
}

/** R7: Z != 0 and X == r*Z^2 (mod p); clear the stack; OP_PUSH_TX with k = 1 on secp256k1. */
function emitTail ({ sighash }) {
  // r (item index 0) with [.. X Y Z Z^2] on top (BELOW + 4 items) is at depth BELOW + 3 = 134
  const rDepth = BELOW + 3
  const rCheck = asm(`
    OP_DUP 0 OP_NUMEQUAL OP_NOTIF
      OP_DUP OP_DUP OP_MUL MODP
      {RDEPTH} OP_PICK OP_OVER OP_MUL MODP
      4 OP_PICK OP_NUMEQUAL
    OP_ELSE 0 OP_ENDIF OP_VERIFY
    OP_FROMALTSTACK OP_DROP
  `, { RDEPTH: rDepth })
  // stack now holds BELOW + 4 items (r u1' u2' C[] X Y Z Z^2): drop them all
  const leftover = BELOW + 4
  const clear = [...Array(Math.floor(leftover / 2)).fill(OP.OP_2DROP), ...(leftover % 2 ? [OP.OP_DROP] : [])]

  // OP_PUSH_TX: e_k1 = BE(hash256(preimage)); s = lowS((e_k1 + 2^248) mod n_k1); r = Gx (k = 1)
  const d = mod((1n << 248n) * modinv(SECP_GX, SECP_N), SECP_N)      // public "private" key: d*G is the checksig pubkey
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
  `, {
    SIGHASH: [sighash], NK: SECP_N,
    DERPREFIX: [...derIntBytes(SECP_GX), 0x02],   // 02 20 <Gx> 02  (s INTEGER tag appended)
    PUBKEY: pushTxPubKey
  })
  return [...rCheck, ...clear, ...pushTx]
}

// ───────────────────────────── public API ─────────────────────────────
/**
 * Build the locking script.
 * @param {object} a
 * @param {string} a.qCompressedHex  33-byte compressed P-256 public key of the signer (hex)
 * @param {number|bigint} a.satoshis output value baked into the in-script preimage (must equal the deposit output value)
 * @param {number} [a.version=1]      spending-tx version baked into the preimage
 * @param {number} [a.sequence=0xffffffff] spending-input nSequence baked into the preimage (also drives hashSequence)
 * @param {number} [a.lockTime=0]     spending-tx nLockTime baked into the preimage
 * @param {number} [a.sighash=0x41]   sighash type (ALL|FORKID); also the byte appended to the OP_PUSH_TX signature
 * @returns {LockingScript}
 */
export function buildLock ({ qCompressedHex, satoshis, version = 1, sequence = 0xffffffff, lockTime = 0, sighash = 0x41 }) {
  const qBytes = bytesOf(qCompressedHex)
  if (qBytes.length !== 33 || (qBytes[0] !== 2 && qBytes[0] !== 3)) throw new Error('qCompressedHex must be a 33-byte compressed P-256 point')
  const Q = p256.Point.fromHex(qCompressedHex)
  Q.assertValidity()
  if (!Number.isInteger(Number(satoshis)) || Number(satoshis) < 0) throw new Error('satoshis must be a non-negative integer')
  if (version !== 1) throw new Error('the SDK interpreter enforces minimal encodings only for version-1 transactions; the script requires version 1')
  const bytes = [
    ...emitPreimageBuild({ satoshis, version, sequence, lockTime, sighash }),
    ...emitScalarMath(),
    ...emitRecode(),
    ...emitTables(Q),
    ...emitPreloop(),
    ...emitCombLoop(),
    ...emitTail({ sighash })
  ]
  return LockingScript.fromBinary(bytes)
}

/** Read the baked satoshi amount back out of a generated locking script (chunk 12). */
export function bakedSatoshis (lockingScript) {
  const d = lockingScript.chunks[12]?.data
  if (!d || d.length !== 8) throw new Error('not an R1 comb-verifier locking script')
  return new Utils.Reader(d).readUInt64LEBn().toNumber()
}

// ───────────────────────────── self-test ─────────────────────────────
const FIXTURE_Q = '03f4d667712d8825372cd616b0b1b1a818e5eeb3681dd45c5bdd59fed9f21d5a7d'
const FIXTURE_SATS = 4600
const REPO = '/Users/personal/git/bsv-wallet'
const FIXTURE_LOCK = REPO + '/docs/example-txs/51c53430fe63108a2a1ddd231253df069fb424cc6f1bb0ee60b4b07792d3579a_0.hex'
const FIXTURE_TX = REPO + '/docs/example-txs/476611a431172df767a73349522536fa78d63a83b560efbb695b853bf60b4b80.hex'

function chunkIndexAt (script, byteOffset) {
  let off = 0
  for (let i = 0; i < script.chunks.length; i++) {
    const c = script.chunks[i]
    const len = 1 + (c.data ? (c.op <= 75 ? c.data.length : c.op === 76 ? 1 + c.data.length : c.op === 77 ? 2 + c.data.length : 4 + c.data.length) : 0)
    if (byteOffset < off + len) return i
    off += len
  }
  return -1
}

export function selfTest () {
  // encoder cross-check against the SDK's BigNumber.toSm('little')
  for (const v of [17n, 127n, 128n, 255n, 256n, 257n, 32767n, 32768n, P256_N, P256_P, RECODE_CONST, SECP_N, (1n << 255n), (1n << 255n) - 1n]) {
    const sdk = new BigNumber(v.toString(16), 16).toSm('little')
    if (hex(sdk) !== hex(scriptNum(v))) throw new Error(`scriptNum mismatch for ${v.toString(16)}: ${hex(scriptNum(v))} vs sdk ${hex(sdk)}`)
  }
  const fixtureHex = fs.readFileSync(FIXTURE_LOCK, 'utf8').trim()
  const t0 = Date.now()
  const lock = buildLock({ qCompressedHex: FIXTURE_Q, satoshis: FIXTURE_SATS })
  const genHex = lock.toHex()
  console.log(`generated ${genHex.length / 2} bytes / ${lock.chunks.length} chunks in ${Date.now() - t0} ms; fixture ${fixtureHex.length / 2} bytes`)
  let ok = genHex === fixtureHex
  if (!ok) {
    const a = Buffer.from(genHex, 'hex'), b = Buffer.from(fixtureHex, 'hex')
    let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++
    const fixture = LockingScript.fromHex(fixtureHex)
    console.log(`MISMATCH at byte ${i}: generated chunk #${chunkIndexAt(lock, i)} vs fixture chunk #${chunkIndexAt(fixture, i)}`)
    console.log('  generated:', hex(a.subarray(Math.max(0, i - 8), i + 24)))
    console.log('  fixture  :', hex(b.subarray(Math.max(0, i - 8), i + 24)))
    console.log(`  lengths: generated ${a.length}, fixture ${b.length}`)
  } else console.log('BYTE-EXACT: generated locking script == fixture')

  // run the fixture spend against the GENERATED lock
  const tx = Transaction.fromHex(fs.readFileSync(FIXTURE_TX, 'utf8').trim())
  const spend = new Spend({
    sourceTXID: tx.inputs[0].sourceTXID, sourceOutputIndex: 0, sourceSatoshis: FIXTURE_SATS,
    lockingScript: lock, transactionVersion: tx.version, otherInputs: [], outputs: tx.outputs,
    unlockingScript: tx.inputs[0].unlockingScript, inputSequence: tx.inputs[0].sequence, inputIndex: 0, lockTime: tx.lockTime
  })
  let valid = false, err = null
  try { valid = spend.validate() } catch (e) { err = e.message.split('\n')[0] }
  console.log(`Spend.validate(fixture unlock, generated lock) = ${valid}${err ? ' (' + err + ')' : ''} pc=${spend.programCounter}`)
  console.log(`bakedSatoshis(lock) = ${bakedSatoshis(lock)}`)
  return ok && valid
}
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  process.exitCode = selfTest() ? 0 : 1
}
