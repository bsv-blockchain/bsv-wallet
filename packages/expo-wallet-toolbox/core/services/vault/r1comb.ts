/**
 * R1C — the 1-of-N P-256 comb-verifier vault template (spec §2).
 *
 * Pure: no I/O, no React, no process.env; imports only @bsv/sdk and
 * @noble/curves. Ported from docs/example-txs/spike/gen.mjs, gen2.mjs,
 * unlock.mjs and unlock2.mjs. The G-table / comb-loop / tail region of every
 * lock is byte-identical to the mined testnet fixture
 * docs/example-txs/51c5…579a_0.hex (asserted in __tests__/vault/r1comb.test.ts).
 *
 * Script numbers are BSV little-endian sign-magnitude; "minimal scriptnum" is
 * what BigNumber.toSm('little') produces. Every constant is emitted minimally.
 *
 * SECURITY: nothing secret passes through this module — public keys, per-output
 * salts, signatures the card already produced, and script bytes.
 */
import { Hash, LockingScript, OP, PrivateKey, Script, Transaction, TransactionSignature, Utils } from '@bsv/sdk'
import { p256 } from '@noble/curves/nist.js'
import { VaultError } from './types'

// ───────────────────────── comb geometry and sizes (spec §2) ─────────────────────────
export const COMB_ROWS = 6
export const COMB_COLS = 43
/** Entries per base point = 2^(COMB_ROWS − 1). */
export const TABLE_SIZE = 32
/** OP_NUM2BIN width per coordinate in the canonical (hashed) serialisation. */
export const COORD_WIDTH = 33
export const SALT_BYTES = 32
/** Declared unlockingScriptLength; the measured hard maximum is 2,539 B. */
export const R1C_UNLOCK_LEN = 2560
export const R1C_MAX_KEYS = 5
/** BIP143 preimage length with subscript `ac` (2 B) and scope 0x41. */
export const R1C_PREIMAGE_LEN = 158
/** SIGHASH_ALL | SIGHASH_FORKID — the only scope the template supports. */
export const R1C_SIGHASH = 0x41

/** Exact lock size: 27,855 B at N = 1; 27,831 + 25N B for N = 2..5 (ANALYSIS.md §9.2). */
export function R1C_LOCK_LEN(n: number): number {
  if (n === 1) return 27855
  if (Number.isInteger(n) && n >= 2 && n <= R1C_MAX_KEYS) return 27831 + 25 * n
  throw new VaultError('template-invalid', `R1C_LOCK_LEN: N must be 1..${R1C_MAX_KEYS}, got ${String(n)}`)
}

// ───────────────────────── curve constants ─────────────────────────
const P256_CURVE = p256.Point.CURVE()
export const P256_P: bigint = P256_CURVE.p
export const P256_N: bigint = P256_CURVE.n
/** secp256k1 group order — the OP_PUSH_TX leg only. */
export const SECP_N: bigint = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
/** secp256k1 generator x — the OP_PUSH_TX signature's r (nonce k = 1). */
export const SECP_GX: bigint = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n
const RECODE_BITS = COMB_ROWS * COMB_COLS // 258 signed digits
/** 2^258 − 1: the recode constant at H2 (ANALYSIS.md §5.2). */
export const RECODE_CONST: bigint = (1n << BigInt(RECODE_BITS)) - 1n

// ───────────────────────── bigint / byte helpers ─────────────────────────
const mod = (a: bigint, m: bigint): bigint => ((a % m) + m) % m
function modpow(base: bigint, exp: bigint, m: bigint): bigint {
  let r = 1n
  let b = mod(base, m)
  let e = exp
  while (e > 0n) {
    if ((e & 1n) === 1n) r = (r * b) % m
    b = (b * b) % m
    e >>= 1n
  }
  return r
}
/** Inverse modulo a prime. */
const modinv = (a: bigint, m: bigint): bigint => modpow(a, m - 2n, m)
const bytesOf = (h: string): number[] => Utils.toArray(h, 'hex') as number[]
const beToBig = (b: number[]): bigint => BigInt('0x' + (b.length > 0 ? Utils.toHex(b) : '0'))
const leToBig = (b: number[]): bigint => beToBig([...b].reverse())
const invalid = (message: string): VaultError => new VaultError('template-invalid', message)
// Keep the helper referenced until a later task uses it (TypeScript strict does not
// flag unused module-level consts, but this documents intent).
void leToBig

// ───────────────────────── script-number encoding ─────────────────────────
/** Raw data push with the minimal push opcode (direct length, PUSHDATA1/2/4). */
export function pushData(data: number[]): number[] {
  const d = [...data]
  if (d.length === 0) return [OP.OP_0]
  if (d.length <= 75) return [d.length, ...d]
  if (d.length <= 0xff) return [OP.OP_PUSHDATA1, d.length, ...d]
  if (d.length <= 0xffff) return [OP.OP_PUSHDATA2, d.length & 0xff, d.length >>> 8, ...d]
  return [OP.OP_PUSHDATA4, d.length & 0xff, (d.length >>> 8) & 0xff, (d.length >>> 16) & 0xff, (d.length >>> 24) & 0xff, ...d]
}

/** Minimal script-number encoding (sign-magnitude little-endian) == BigNumber.toSm('little'). */
export function scriptNum(v: bigint): number[] {
  if (v === 0n) return []
  const neg = v < 0n
  let m = neg ? -v : v
  const b: number[] = []
  while (m > 0n) {
    b.push(Number(m & 0xffn))
    m >>= 8n
  }
  if ((b[b.length - 1] & 0x80) !== 0) b.push(neg ? 0x80 : 0x00)
  else if (neg) b[b.length - 1] |= 0x80
  return b
}

/** Push a number as a minimally-encoded script number (OP_0, OP_1..OP_16, OP_1NEGATE, or a data push). */
export function encNum(v: bigint | number): number[] {
  const n = BigInt(v)
  if (n === 0n) return [OP.OP_0]
  if (n >= 1n && n <= 16n) return [OP.OP_1 + Number(n) - 1]
  if (n === -1n) return [OP.OP_1NEGATE]
  return pushData(scriptNum(n))
}

// ───────────────────────── tiny assembler ─────────────────────────
// Tokens: OP_NAME | decimal integer (encNum) | <hex> (raw push) | {PARAM} | macro name.
const MACROS: Record<string, string> = {
  // reduce top mod p; p lives on the altstack and is never consumed
  MODP: 'OP_FROMALTSTACK OP_DUP OP_TOALTSTACK OP_MOD',
  // BSV OP_MOD keeps the dividend's sign: normalise a negative remainder into [0, p)
  NORM: 'OP_DUP 0 OP_LESSTHAN OP_IF OP_FROMALTSTACK OP_DUP OP_TOALTSTACK OP_ADD OP_ENDIF'
}
export type AsmParam = bigint | number | number[]
const OPCODES = OP as unknown as Record<string, number | undefined>

export function asm(text: string, params: Record<string, AsmParam> = {}): number[] {
  const out: number[] = []
  for (const tok of text.trim().split(/\s+/)) {
    if (tok === '') continue
    const macro = MACROS[tok]
    if (macro !== undefined) {
      out.push(...asm(macro, params))
      continue
    }
    if (tok.startsWith('{') && tok.endsWith('}')) {
      const v = params[tok.slice(1, -1)]
      if (v === undefined) throw invalid(`asm: missing param ${tok}`)
      out.push(...(typeof v === 'bigint' || typeof v === 'number' ? encNum(v) : pushData(v)))
      continue
    }
    if (tok.startsWith('<') && tok.endsWith('>')) {
      out.push(...pushData(bytesOf(tok.slice(1, -1))))
      continue
    }
    if (/^-?\d+$/.test(tok)) {
      out.push(...encNum(BigInt(tok)))
      continue
    }
    const op = OPCODES[tok]
    if (op === undefined) throw invalid(`asm: unknown opcode ${tok}`)
    out.push(op)
  }
  return out
}

// ───────────────────────── public keys ─────────────────────────
/**
 * 65-byte SEC1 (04‖X‖Y) or 33-byte compressed hex in → 33-byte compressed lowercase hex out.
 * The card returns the 65-byte form; every comparison in the app uses the compressed form.
 */
export function compressPubkey(sec1Hex: string): string {
  if (typeof sec1Hex !== 'string' || !/^([0-9a-fA-F]{66}|[0-9a-fA-F]{130})$/.test(sec1Hex)) {
    throw invalid('compressPubkey: expected 33- or 65-byte SEC1 hex')
  }
  const lower = sec1Hex.toLowerCase()
  const prefix = lower.slice(0, 2)
  if (lower.length === 66 && prefix !== '02' && prefix !== '03') throw invalid('compressPubkey: bad compressed prefix')
  if (lower.length === 130 && prefix !== '04') throw invalid('compressPubkey: bad uncompressed prefix')
  try {
    const P = p256.Point.fromHex(lower)
    P.assertValidity()
    return P.toHex(true)
  } catch {
    throw invalid('compressPubkey: not a valid P-256 point')
  }
}

// ───────────────────────── comb tables (spec §2.1) ─────────────────────────
export interface AffinePoint { x: bigint; y: bigint }
type P256Point = ReturnType<typeof p256.Point.fromHex>

/**
 * Comb table scalar for entry j (0 <= j < 32):
 *   T_j = 2^(43·5) + Σ_{k<5} (bit_k(j) ? +1 : −1) · 2^(43k)
 * The top digit is fixed +1 (the sign digit is applied in-script by negating y).
 */
export function combTableScalar(j: number): bigint {
  let s = 1n << BigInt(COMB_COLS * (COMB_ROWS - 1))
  for (let k = 0; k < COMB_ROWS - 1; k++) s += (((j >> k) & 1) !== 0 ? 1n : -1n) << BigInt(COMB_COLS * k)
  return s
}

function tableOf(base: P256Point): AffinePoint[] {
  const pts: AffinePoint[] = []
  for (let j = 0; j < TABLE_SIZE; j++) {
    const a = base.multiply(mod(combTableScalar(j), P256_N)).toAffine()
    pts.push({ x: a.x, y: a.y })
  }
  return pts
}

let gTableCache: AffinePoint[] | null = null
/** table(G) — computed once on first use (32 scalar multiplications), then constant. */
export function gTable(): AffinePoint[] {
  if (gTableCache === null) gTableCache = tableOf(p256.Point.BASE)
  return gTableCache
}

const TABLE_CACHE_MAX = 8
const qTableCache = new Map<string, AffinePoint[]>()
/** table(Q): 32 affine points T_j·Q. Memoised per compressed pubkey (Map, FIFO, max 8). Never persisted. */
export function combTable(pubkeyHex33: string): AffinePoint[] {
  const key = compressPubkey(pubkeyHex33)
  const hit = qTableCache.get(key)
  if (hit !== undefined) return hit
  const table = tableOf(p256.Point.fromHex(key))
  if (qTableCache.size >= TABLE_CACHE_MAX) {
    const oldest = qTableCache.keys().next().value
    if (oldest !== undefined) qTableCache.delete(oldest)
  }
  qTableCache.set(key, table)
  return table
}

// ───────────────────────── commitment (spec §2.2) ─────────────────────────
/** OP_NUM2BIN(v, 33) for a non-negative v: minimal LE scriptnum zero-padded to 33 bytes. */
export function le33(v: bigint): number[] {
  if (v < 0n) throw invalid('le33: negative coordinate')
  const b = scriptNum(v)
  if (b.length > COORD_WIDTH) throw invalid('le33: value does not fit in 33 bytes')
  while (b.length < COORD_WIDTH) b.push(0)
  return b
}

/** le33(x_0) ‖ le33(y_0) ‖ … ‖ le33(y_31) — 2,112 bytes; injective over integer values. */
export function canonicalTableBytes(pubkeyHex33: string): number[] {
  const out: number[] = []
  for (const { x, y } of combTable(pubkeyHex33)) out.push(...le33(x), ...le33(y))
  return out
}

function saltBytes(saltHex64: string): number[] {
  if (typeof saltHex64 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(saltHex64)) {
    throw invalid(`salt must be ${SALT_BYTES} bytes as 64 hex chars`)
  }
  return bytesOf(saltHex64)
}

/** hash160(salt ‖ canonicalTableBytes(Q)) as 40 lowercase hex chars — the value baked into the lock. */
export function commitment(pubkeyHex33: string, saltHex64: string): string {
  return Utils.toHex(Hash.hash160([...saltBytes(saltHex64), ...canonicalTableBytes(pubkeyHex33)]))
}

// ───────────────────────── scalar recoding (spec §2.4, ANALYSIS.md §5.2) ─────────────────────────
/** u' = ((u odd ? u : u + n) + 2^258 − 1) / 2 — exactly the H2 arithmetic. u' < 2^258 and bit 257 is always set. */
export function recode(u: bigint): bigint {
  let v = mod(u, P256_N)
  if (v % 2n === 0n) v += P256_N
  return (v + RECODE_CONST) / 2n
}

// ───────────────────────── header H0–H5 (spec §2.3, gen2.mjs emitHeader2) ─────────────────────────
/** 64 Q coordinates pushed by the unlocker. */
const K_Q = 2 * TABLE_SIZE

/**
 * H0–H4 (+ OP_HASH160): identical for every lock. Stack in (unlock): [r u2' u1' Q0..Q63 salt s sInv preimage]
 * alt []; stack out: [r u2' u1' Q0..Q63 H] alt [preimage n], where H = hash160(salt ‖ canonical table).
 */
let headerPrefixCache: number[] | null = null
function emitHeaderPrefix(): number[] {
  if (headerPrefixCache !== null) return headerPrefixCache
  const out: number[] = []
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
  `, { N: P256_N, RDEPTH: K_Q + 6 }))
  // H2: recode u2 then u1 -> [.. salt u1' u2']
  const one = 'OP_DUP 2 OP_MOD OP_NOTIF {N} OP_ADD OP_ENDIF {C} OP_ADD 2 OP_DIV OP_SWAP'
  out.push(...asm(`${one} ${one}`, { N: P256_N, C: RECODE_CONST }))
  // H3: computed u2' == pushed u2' (depth K+4), then computed u1' == pushed u1' (depth K+2) -> [r u2' u1' Q.. salt]
  out.push(...asm('{DU2} OP_PICK OP_NUMEQUALVERIFY {DU1} OP_PICK OP_NUMEQUALVERIFY', { DU2: K_Q + 4, DU1: K_Q + 2 }))
  // H4: acc = salt; acc ||= NUM2BIN33(Q_m) for m = 0..63 (Q_m at depth K − m); H = hash160(acc)
  for (let m = 0; m < K_Q; m++) out.push(...asm('{D} OP_PICK {W} OP_NUM2BIN OP_CAT', { D: K_Q - m, W: COORD_WIDTH }))
  out.push(OP.OP_HASH160)
  headerPrefixCache = out
  return out
}

/** H5: H must equal one of the N baked 20-byte commitments. 22 B (N = 1) or 25N − 2 B (N >= 2). */
function emitH5(commitments: number[][]): number[] {
  const out: number[] = []
  if (commitments.length === 1) {
    out.push(...asm('{C} OP_EQUALVERIFY', { C: commitments[0] }))
    return out
  }
  for (let i = 0; i < commitments.length - 1; i++) out.push(...asm('OP_DUP {C} OP_EQUAL OP_SWAP', { C: commitments[i] }))
  out.push(...asm('{C} OP_EQUAL', { C: commitments[commitments.length - 1] }))
  for (let i = 0; i < commitments.length - 1; i++) out.push(OP.OP_BOOLOR)
  out.push(OP.OP_VERIFY)
  return out
}

// ───────────────────────── shared suffix: G table, pre-loop, comb loop, tail (verbatim from gen.mjs) ─────────────────────────
function emitGTable(): number[] {
  const out: number[] = []
  for (const { x, y } of gTable()) out.push(...encNum(x), ...encNum(y))
  return out
}

/** Push p; swap altstack top n -> p; accumulator := Jacobian infinity (1, 1, 0). */
function emitPreloop(): number[] {
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

// Identity guard (column 0, first add only): if Z == 0 replace the accumulator by (x, y, 1).
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

/** Stack layout beneath the accumulator: [r u2' u1' C[0..K-1]] with K = 128 table coordinates (Q[0..63] then G[0..63]). */
const K_CONSTS = 2 * 2 * TABLE_SIZE            // 128
const BELOW = 3 + K_CONSTS                     // 131 items under the accumulator (X Y Z)
// With [.. X Y Z] on top (BELOW + 3 items): stack index 1 (= u2') is at depth 132, index 2 (= u1') at 131.
const scalarDepth = (half: 0 | 1): number => BELOW + 1 - half
// C[m] sits at depth 132 − m once [.. X Y Z sign j] is on top; half 0 -> C[0..63] (= Q), half 1 -> C[64..127] (= G).
const tableBase = (half: 0 | 1): number => BELOW + 1 - 2 * TABLE_SIZE * half
/** Shift for column c, row k: bit position 43k + 42 − c of the recoded scalar = 257 − c − 43k. */
export const shiftFor = (c: number, k: number): number => COMB_COLS * (COMB_ROWS - 1 - k) + (COMB_COLS - 1 - c)

function emitAdd(half: 0 | 1, c: number, guarded: boolean): number[] {
  const params: Record<string, AsmParam> = {
    DEPTH0: scalarDepth(half), DEPTH1: scalarDepth(half) + 1, DEPTH2: scalarDepth(half) + 2, BASE: tableBase(half)
  }
  for (let k = 0; k < COMB_ROWS; k++) params[`SHIFT${k}`] = shiftFor(c, k)
  return asm(`${DIGITS_AND_LOOKUP} ${guarded ? GUARD_PREFIX : ''} ${MADD} ${guarded ? GUARD_SUFFIX : ''}`, params)
}

/** 43 columns, Horner: acc = 2·acc + d2(c)·TQ[j2] + d1(c)·TG[j1]; only column 0's first add is identity-guarded. */
function emitCombLoop(): number[] {
  const out: number[] = []
  for (let c = 0; c < COMB_COLS; c++) {
    out.push(...asm(DOUBLE))
    out.push(...emitAdd(0, c, c === 0))     // index-1 scalar (u2') with C[0..63] (Q)
    out.push(...emitAdd(1, c, false))       // index-2 scalar (u1') with C[64..127] (G)
  }
  return out
}

/** DER INTEGER for a non-negative bigint: minimal big-endian with a 0x00 pad if the top bit is set. */
function derIntBytes(v: bigint): number[] {
  let h = v.toString(16)
  if (h.length % 2 === 1) h = '0' + h
  const b = bytesOf(h)
  if ((b[0] & 0x80) !== 0) b.unshift(0)
  return [0x02, b.length, ...b]
}

/** The OP_PUSH_TX dummy key d·G on secp256k1, d = 2^248·Gx⁻¹ mod n_k1 (public by construction). */
let pushTxPubKeyCache: number[] | null = null
function pushTxPubKey(): number[] {
  if (pushTxPubKeyCache === null) {
    const d = mod((1n << 248n) * modinv(SECP_GX, SECP_N), SECP_N)
    pushTxPubKeyCache = new PrivateKey(d.toString(16).padStart(64, '0'), 16).toPublicKey().encode(true) as number[]
  }
  return pushTxPubKeyCache
}

/** Tail: Z != 0 and X == r·Z² (mod p); clear the stack; OP_PUSH_TX with k = 1 on secp256k1 (ANALYSIS.md §6). */
function emitTail(): number[] {
  // r (item index 0) with [.. X Y Z Z^2] on top (BELOW + 4 items) is at depth BELOW + 3 = 134
  const rCheck = asm(`
    OP_DUP 0 OP_NUMEQUAL OP_NOTIF
      OP_DUP OP_DUP OP_MUL MODP
      {RDEPTH} OP_PICK OP_OVER OP_MUL MODP
      4 OP_PICK OP_NUMEQUAL
    OP_ELSE 0 OP_ENDIF OP_VERIFY
    OP_FROMALTSTACK OP_DROP
  `, { RDEPTH: BELOW + 3 })
  // stack now holds BELOW + 4 items (r u2' u1' C[] X Y Z Z^2): drop them all
  const leftover = BELOW + 4
  const clear: number[] = [
    ...new Array<number>(Math.floor(leftover / 2)).fill(OP.OP_2DROP),
    ...(leftover % 2 === 1 ? [OP.OP_DROP] : [])
  ]
  // e_k1 = BE(hash256(preimage)); s = lowS((e_k1 + 2^248) mod n_k1); r = Gx (k = 1)
  const rev31 = new Array<string>(31).fill('OP_SWAP OP_CAT').join(' ')
  const pushTx = asm(`
    OP_FROMALTSTACK {SIGHASH} OP_TOALTSTACK OP_HASH256
    ${new Array<string>(31).fill('1 OP_SPLIT').join(' ')}
    ${rev31}
    <00> OP_CAT OP_BIN2NUM
    0 31 OP_NUM2BIN 1 OP_CAT OP_ADD
    {NK} OP_TUCK 2 OP_DIV OP_OVER OP_LESSTHAN
    OP_IF OP_OVER OP_MOD OP_OVER 2 OP_DIV OP_OVER OP_LESSTHAN OP_IF OP_SUB OP_ELSE OP_NIP OP_ENDIF
    OP_ELSE OP_NIP OP_ENDIF
    ${new Array<string>(31).fill('OP_DUP OP_0NOTEQUAL OP_SPLIT').join(' ')}
    ${rev31}
    OP_SIZE OP_SWAP OP_CAT
    {DERPREFIX} OP_SWAP OP_CAT
    OP_SIZE OP_SWAP OP_CAT
    <30> OP_SWAP OP_CAT
    OP_FROMALTSTACK OP_CAT
    {PUBKEY} OP_CODESEPARATOR OP_CHECKSIG
  `, {
    SIGHASH: [R1C_SIGHASH], NK: SECP_N,
    DERPREFIX: [...derIntBytes(SECP_GX), 0x02],   // 02 20 <Gx> 02  (s INTEGER tag appended)
    PUBKEY: pushTxPubKey()
  })
  return [...rCheck, ...clear, ...pushTx]
}

let sharedSuffixCache: number[] | null = null
/** G table + pre-loop + comb loop + tail: 27,160 B, byte-identical to fixture chunks [87..150] ++ [215..end]. Computed once. */
export function sharedSuffix(): number[] {
  if (sharedSuffixCache === null) sharedSuffixCache = [...emitGTable(), ...emitPreloop(), ...emitCombLoop(), ...emitTail()]
  return sharedSuffixCache.slice()
}

// ───────────────────────── public: buildLock / bakedCommitments (spec §2.3) ─────────────────────────
function parseCommitments(commitments: unknown): number[][] {
  if (!Array.isArray(commitments) || commitments.length < 1 || commitments.length > R1C_MAX_KEYS) {
    throw invalid(`buildLock: commitments must be 1..${R1C_MAX_KEYS} hash160 hex strings`)
  }
  const lower: string[] = commitments.map(c => {
    if (typeof c !== 'string' || !/^[0-9a-fA-F]{40}$/.test(c)) throw invalid('buildLock: commitment must be 40 hex chars')
    return c.toLowerCase()
  })
  if (new Set(lower).size !== lower.length) throw invalid('buildLock: duplicate commitment')
  return lower.map(bytesOf)
}

/** N in 1..5 commitments (40-hex each), in the order given. Byte-exact per spec §2.3; length asserted against R1C_LOCK_LEN. */
export function buildLock(a: { commitments: string[] }): LockingScript {
  const cs = parseCommitments(a.commitments)
  const bytes = [...emitHeaderPrefix(), ...emitH5(cs), ...sharedSuffix()]
  const expected = R1C_LOCK_LEN(cs.length)
  if (bytes.length !== expected) throw invalid(`buildLock: emitted ${bytes.length} bytes, expected ${expected}`)
  return new LockingScript(Script.fromBinary(bytes).chunks)
}

/**
 * Parse region H5 of a lock built by buildLock → the commitments in order (lowercase hex).
 * Fail-closed: the header prefix, the H5 skeleton AND the whole shared suffix must be byte-identical
 * to what buildLock emits for the extracted commitments; anything else is 'template-invalid'.
 */
export function bakedCommitments(lock: Script): string[] {
  const bin = lock.toBinary()
  let n = -1
  for (let k = 1; k <= R1C_MAX_KEYS; k++) if (bin.length === R1C_LOCK_LEN(k)) n = k
  if (n < 0) throw invalid(`bakedCommitments: ${bin.length} bytes is not an R1C lock length`)
  const prefix = emitHeaderPrefix()
  const suffix = sharedSuffix()
  const h5 = bin.slice(prefix.length, bin.length - suffix.length)
  const cs: number[][] = []
  if (n === 1) {
    cs.push(h5.slice(1, 21))
  } else {
    for (let i = 0; i < n - 1; i++) cs.push(h5.slice(24 * i + 2, 24 * i + 22))
    cs.push(h5.slice(24 * (n - 1) + 1, 24 * (n - 1) + 21))
  }
  const rebuilt = [...prefix, ...emitH5(cs), ...suffix]
  if (rebuilt.length !== bin.length || rebuilt.some((b, i) => b !== bin[i])) {
    throw invalid('bakedCommitments: not an R1C lock')
  }
  return cs.map(c => Utils.toHex(c))
}

// ───────────────────────── sighash preimage and signer digest (spec §2.5) ─────────────────────────
/** OP_CODESEPARATOR OP_CHECKSIG ⇒ the scriptCode the lock's CHECKSIG hashes is the single byte `ac`. */
const SUBSCRIPT = Script.fromHex('ac')

function requirePreimage(preimage: number[], where: string): void {
  if (!Array.isArray(preimage) || preimage.length !== R1C_PREIMAGE_LEN) {
    throw invalid(`${where}: preimage must be ${R1C_PREIMAGE_LEN} bytes`)
  }
}

/** BIP143 preimage, subscript `ac`, scope 0x41, for input `inputIndex` of `tx` whose source output carried `sourceSatoshis`. 158 bytes. */
export function sighashPreimage(tx: Transaction, inputIndex: number, sourceSatoshis: number): number[] {
  const input = tx.inputs[inputIndex]
  if (input === undefined) throw invalid(`sighashPreimage: input ${inputIndex} does not exist`)
  const sourceTXID = input.sourceTXID ?? input.sourceTransaction?.id('hex')
  if (sourceTXID === undefined) throw invalid('sighashPreimage: input needs sourceTXID or sourceTransaction')
  if (!Number.isSafeInteger(sourceSatoshis) || sourceSatoshis < 0) throw invalid('sighashPreimage: sourceSatoshis must be a non-negative integer')
  const preimage = TransactionSignature.format({
    sourceTXID,
    sourceOutputIndex: input.sourceOutputIndex,
    sourceSatoshis,
    transactionVersion: tx.version,
    otherInputs: tx.inputs.filter((_, i) => i !== inputIndex),
    outputs: tx.outputs,
    inputIndex,
    subscript: SUBSCRIPT,
    inputSequence: input.sequence ?? 0xffffffff,
    lockTime: tx.lockTime,
    scope: R1C_SIGHASH
  })
  if (preimage.length !== R1C_PREIMAGE_LEN) throw invalid(`sighashPreimage: expected ${R1C_PREIMAGE_LEN} bytes, got ${preimage.length}`)
  return preimage
}

/** reverse(hash256(preimage)) as 64 lowercase hex — the raw digest the P-256 signer signs (the script reads e little-endian). */
export function signerDigest(preimage: number[]): string {
  requirePreimage(preimage, 'signerDigest')
  return Utils.toHex([...Hash.hash256(preimage)].reverse())
}

// ───────────────────────── OP_PUSH_TX model (ANALYSIS.md §6) ─────────────────────────
/** The s the tail assembles: lowS((BE(hash256(preimage)) + 2^248) mod n_k1). r is fixed at Gx (k = 1). */
export function pushTxSignatureS(preimage: number[]): bigint {
  const e = beToBig(Hash.hash256(preimage))
  const t = mod(e + (1n << 248n), SECP_N)
  return t > (SECP_N - 1n) / 2n ? SECP_N - t : t
}

/**
 * Model of the byte-peel loop `(DUP 0NOTEQUAL SPLIT)×31`: it reads the not-yet-peeled remainder of the s scriptnum
 * as a NUMBER at k = 0..30. Returns the first k whose remainder is a non-minimal script number (a trailing 0x00/0x80
 * with no high bit beneath it), or −1 when every remainder is minimal. An empty remainder is fine (== 0).
 */
export function peelLoopNonMinimalAt(sLE: number[]): number {
  for (let k = 0; k <= 30; k++) {
    const rem = sLE.slice(k)
    if (rem.length === 0) continue
    const last = rem[rem.length - 1]
    if ((last & 0x7f) === 0 && (rem.length === 1 || (rem[rem.length - 2] & 0x80) === 0)) return k
  }
  return -1
}

/**
 * D4b screen — evaluate BEFORE asking the card to sign. ok = false when the OP_PUSH_TX s the lock will assemble
 * is zero (2^-256) or peel-nonminimal (2^-16: scriptnum(s) <= 31 bytes ending in a sign byte). Under strict
 * MINIMALDATA such a spend aborts at the peel loop; the remedy is to perturb the transaction (Plan 2 bumps the
 * input's sequence) and re-screen. Pure function of the preimage; independent of the P-256 signature.
 */
export function pushTxDerCheck(preimage: number[]): { ok: boolean; s: bigint } {
  requirePreimage(preimage, 'pushTxDerCheck')
  const s = pushTxSignatureS(preimage)
  if (s === 0n) return { ok: false, s }
  return { ok: peelLoopNonMinimalAt(scriptNum(s)) === -1, s }
}

// ───────────────────────── DER ─────────────────────────
/** Strict DER `SEQUENCE { INTEGER r, INTEGER s }` → (r, s), both in [1, n−1]. Short-form lengths only (max 72 B). */
export function decodeDerSignature(der: number[]): { r: bigint; s: bigint } {
  const fail = (why: string): never => { throw invalid(`decodeDerSignature: ${why}`) }
  if (!Array.isArray(der) || der.length < 8 || der.length > 72) fail('length')
  if (der[0] !== 0x30) fail('not a SEQUENCE')
  if (der[1] !== der.length - 2) fail('bad SEQUENCE length')
  let pos = 2
  const readInt = (): bigint => {
    if (der[pos] !== 0x02) fail('expected INTEGER')
    const len = der[pos + 1]
    if (len === undefined || len === 0 || len > 33 || pos + 2 + len > der.length) fail('bad INTEGER length')
    const body = der.slice(pos + 2, pos + 2 + len)
    if ((body[0] & 0x80) !== 0) fail('negative INTEGER')
    if (len > 1 && body[0] === 0x00 && (body[1] & 0x80) === 0) fail('non-minimal INTEGER')
    pos += 2 + len
    return beToBig(body)
  }
  const r = readInt()
  const s = readInt()
  if (pos !== der.length) fail('trailing bytes')
  if (r === 0n || r >= P256_N || s === 0n || s >= P256_N) fail('scalar out of range')
  return { r, s }
}
