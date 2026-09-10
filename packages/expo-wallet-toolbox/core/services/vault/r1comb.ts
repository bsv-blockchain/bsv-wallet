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
import { OP, Utils } from '@bsv/sdk'
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
// Keep the helpers referenced until later tasks use them (TypeScript strict does not
// flag unused module-level consts, but this documents intent).
void modinv
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
