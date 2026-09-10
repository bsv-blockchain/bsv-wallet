// gen2-hardened.mjs — PROTOTYPE fix for the unlock-malleability findings of adv-review.mjs.
// Adds three range checks to H1 (right after `<n> OP_TOALTSTACK`), everything else byte-identical to gen2.mjs:
//   s    in [1, (n-1)/2]   (range + low-S: kills s -> n-s, s + k*n, -s)
//   sInv in [1, n-1]       (kills sInv + k*n, -sInv)
//   r    in [0, p-1]       (kills r + k*p*n)
// Together with MINIMALDATA (version-1 spends) every remaining unlock field is value-fixed AND encoding-fixed, so the
// unlocking script — and hence the txid — is canonical for a given (tx, key, salt).
// The unlocker must normalise s to low-S before pushing (flip s -> n-s, recompute sInv, u1', u2'); see lowSNormalize().
import { LockingScript, OP } from '@bsv/sdk'
import { asm, encNum, emitSharedSuffix, K_Q, COORD_WIDTH, RECODE_CONST, P256_N, P256_P, recode } from './gen2.mjs'
import { encodeUnlock2, decodeUnlock2 } from './unlock2.mjs'

const mod = (a, m) => ((a % m) + m) % m
const modpow = (b, e, m) => { let r = 1n; b = mod(b, m); while (e > 0n) { if (e & 1n) r = r * b % m; b = b * b % m; e >>= 1n } return r }
const modinv = (a, m) => modpow(a, m - 2n, m)
const bytesOf = h => [...Buffer.from(h, 'hex')]
export const HALF_N = (P256_N - 1n) / 2n

export function emitHeader2Hardened ({ commitments }) {
  const K = K_Q
  const out = []
  out.push(...asm('OP_DUP OP_HASH256 <00> OP_CAT OP_BIN2NUM OP_SWAP OP_TOALTSTACK'))
  // stack: [r u2' u1' Q0..Q63 salt s sInv e]  -> e(0) sInv(1) s(2) salt(3) Q63..Q0(4..67) u1'(68) u2'(69) r(70)
  out.push(...asm(`
    {N} OP_TOALTSTACK
    2 OP_PICK 1 {HALFP1} OP_WITHIN OP_VERIFY
    OP_OVER 1 {N} OP_WITHIN OP_VERIFY
    {RDEPTH} OP_PICK 0 {P} OP_WITHIN OP_VERIFY
    2 OP_PICK 2 OP_PICK OP_MUL MODP 1 OP_NUMEQUALVERIFY
    OP_OVER OP_MUL MODP
    {RDEPTH} OP_PICK 2 OP_PICK OP_MUL MODP
    2 OP_ROLL OP_DROP 2 OP_ROLL OP_DROP
  `, { N: P256_N, HALFP1: HALF_N + 1n, P: P256_P, RDEPTH: K + 6 }))
  const one = 'OP_DUP 2 OP_MOD OP_NOTIF {N} OP_ADD OP_ENDIF {C} OP_ADD 2 OP_DIV OP_SWAP'
  out.push(...asm(`${one} ${one}`, { N: P256_N, C: RECODE_CONST }))
  out.push(...asm('{DU2} OP_PICK OP_NUMEQUALVERIFY {DU1} OP_PICK OP_NUMEQUALVERIFY', { DU2: K + 4, DU1: K + 2 }))
  for (let m = 0; m < K; m++) out.push(...asm('{D} OP_PICK {W} OP_NUM2BIN OP_CAT', { D: K - m, W: COORD_WIDTH }))
  out.push(OP.OP_HASH160)
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

export function buildLock2Hardened ({ commitments }) {
  return LockingScript.fromBinary([...emitHeader2Hardened({ commitments }), ...emitSharedSuffix({ sighash: 0x41 })])
}

/** Take an honest gen2 unlock and normalise s to low-S (same R.x, so the signature stays valid). */
export function lowSNormalize (unlockingScript, e) {
  const g = decodeUnlock2(unlockingScript)
  if (g.s <= HALF_N) return unlockingScript
  const s = P256_N - g.s, sInv = modinv(s, P256_N)
  return encodeUnlock2({ ...g, s, sInv, u1p: recode(mod(e * sInv, P256_N)), u2p: recode(mod(g.r * sInv, P256_N)) })
}
