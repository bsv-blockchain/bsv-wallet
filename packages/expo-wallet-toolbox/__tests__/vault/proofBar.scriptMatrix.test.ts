/**
 * Proof bar §4.1 — script acceptance matrix for the exact r1comb.ts bytes.
 *
 * For N = 1..5 and every committed position, a witness built from a real
 * P-256 signature is accepted by the local strict interpreter, and the same
 * witness is re-checked independently of r1comb.ts: noble verifies the
 * (r mod n, s) pair against the committed key, and the commitment is
 * recomputed from noble points and noble hashes. For every N the rejects
 * cover an outsider key, a signature-free CRT/cross-modulus r, a wrong salt,
 * a manually encoded high-S s, a signature over a different preimage, a
 * pushed preimage that is not the spending transaction's, and a version-2
 * transaction. The OP_PUSH_TX covenant keys are public constants; a witness
 * that carries a valid secp256k1 signature from one of them instead of the
 * P-256 data is rejected.
 *
 * Lock length by N and witness depth are asserted so the closure report can
 * quote them from a test rather than from prose.
 */
import { Hash, LockingScript, P2PKH, PrivateKey, Script, Transaction, TransactionSignature, UnlockingScript, Utils } from '@bsv/sdk'
import { p256 } from '@noble/curves/nist.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { ripemd160 } from '@noble/hashes/legacy.js'
import {
  P256_N,
  P256_P,
  P256_LOW_S_MAX,
  R1C_LOCK_LEN,
  R1C_MAX_KEYS,
  R1C_SIGHASH,
  R1C_UNLOCK_LEN,
  SECP_GX,
  SECP_N,
  bakedCommitments,
  buildLock,
  buildUnlock,
  combTable,
  commitment,
  decodeDerSignature,
  encNum,
  pushData,
  pushTxDerCheck,
  recode,
  sighashPreimage,
  signerDigest,
  verifyVaultInput
} from '../../core/services/vault/r1comb'

jest.setTimeout(600_000)

const hex = (a: ArrayLike<number>): string => Utils.toHex(Array.from(a))
const mod = (a: bigint, m: bigint): bigint => ((a % m) + m) % m
const modpow = (base: bigint, exp: bigint, m: bigint): bigint => {
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
const modinv = (a: bigint, m: bigint): bigint => modpow(a, m - 2n, m)
const beBig = (b: ArrayLike<number>): bigint => BigInt('0x' + (b.length > 0 ? hex(b) : '0'))
const fromScriptNum = (b: number[]): bigint => {
  if (b.length === 0) return 0n
  const le = [...b]
  const neg = (le[le.length - 1] & 0x80) !== 0
  le[le.length - 1] &= 0x7f
  const v = beBig(le.reverse())
  return neg ? -v : v
}
const digestBytes = (digestHex: string): Uint8Array => Uint8Array.from(Utils.toArray(digestHex, 'hex') as number[])

interface Member { priv: Uint8Array; pub: string }
const newMember = (): Member => {
  const priv = p256.utils.randomSecretKey()
  return { priv, pub: hex(p256.getPublicKey(priv, true)) }
}
const randSalt = (): string => hex(p256.utils.randomSecretKey())
const signDer = (priv: Uint8Array, digestHex: string): number[] =>
  Array.from(p256.Signature.fromBytes(p256.sign(digestBytes(digestHex), priv, { prehash: false, lowS: false })).toBytes('der'))
const p2pkhOut = (): LockingScript => new P2PKH().lock(PrivateKey.fromRandom().toAddress())

function fundingStub(lock: LockingScript, sats: number): Transaction {
  const src = new Transaction(1, [], [], 0)
  src.addOutput({ satoshis: 1, lockingScript: p2pkhOut() })
  src.addOutput({ satoshis: sats, lockingScript: lock })
  return src
}

/** One vault input spending output 1 of `src`; the sequence is stepped past the single covenant digest whose scalar would be zero. */
function spendTx(src: Transaction, sats: number, version = 1): { tx: Transaction; preimage: number[] } {
  const tx = new Transaction(version, [], [], 0)
  tx.addInput({ sourceTransaction: src, sourceOutputIndex: 1, sequence: 0xffffffff })
  tx.addOutput({ satoshis: sats - 600, lockingScript: p2pkhOut() })
  for (let attempt = 0; attempt < 16; attempt++) {
    const preimage = version === 1 ? sighashPreimage(tx, 0, sats) : rawPreimage(tx, src, sats)
    if (version !== 1 || pushTxDerCheck(preimage).ok) return { tx, preimage }
    tx.inputs[0].sequence = ((tx.inputs[0].sequence ?? 0xffffffff) - 1) >>> 0
  }
  throw new Error('could not screen a preimage')
}

/** BIP143 preimage without r1comb's version-1 guard (used only to build the version-2 reject). */
function rawPreimage(tx: Transaction, src: Transaction, sats: number): number[] {
  return TransactionSignature.format({
    sourceTXID: src.id('hex'),
    sourceOutputIndex: 1,
    sourceSatoshis: sats,
    transactionVersion: tx.version,
    otherInputs: [],
    outputs: tx.outputs,
    inputIndex: 0,
    subscript: Script.fromHex('ac'),
    inputSequence: tx.inputs[0].sequence ?? 0xffffffff,
    lockTime: tx.lockTime,
    scope: R1C_SIGHASH
  })
}

/** The witness layout, assembled without buildUnlock's guards so a test can place any values. */
function rawWitness(a: { r: bigint; u2: bigint; u1: bigint; pub: string; s: bigint; sInv: bigint; preimage: number[]; salt: string }): UnlockingScript {
  const bytes = [...encNum(a.r), ...encNum(recode(a.u2)), ...encNum(recode(a.u1))]
  for (const point of combTable(a.pub)) bytes.push(...encNum(point.x), ...encNum(point.y))
  bytes.push(...encNum(a.s), ...encNum(a.sInv), ...pushData(a.preimage), ...pushData(Utils.toArray(a.salt, 'hex') as number[]))
  return new UnlockingScript(Script.fromBinary(bytes).chunks)
}

/** Independent commitment: noble comb-table points, noble sha256/ripemd160. */
function independentCommitment(pub: string, salt: string): string {
  const Q = p256.Point.fromHex(pub)
  const bytes: number[] = [...(Utils.toArray(salt, 'hex') as number[])]
  const le33 = (v: bigint): number[] => {
    const out = new Array(33).fill(0)
    let x = v
    for (let i = 0; i < 33; i++) { out[i] = Number(x & 0xffn); x >>= 8n }
    return out
  }
  for (let j = 0; j < 32; j++) {
    // T_j = 2^215 + Σ_k (bit_k(j) ? +1 : -1) · 2^(43k), k = 0..4 (spec §2.4)
    let t = 1n << 215n
    for (let k = 0; k < 5; k++) t += (((j >> k) & 1) === 1 ? 1n : -1n) * (1n << BigInt(43 * k))
    const P = Q.multiply(mod(t, P256_N)).toAffine()
    bytes.push(...le33(P.x), ...le33(P.y))
  }
  return hex(ripemd160(sha256(Uint8Array.from(bytes))))
}

const expectRejected = (f: () => unknown): void => {
  expect(f).toThrow(/Script evaluation error|script evaluated to false/)
}

describe('proof bar §4.1: exact-lock acceptance matrix, N = 1..5', () => {
  it('lock length is 45,199 B for N = 1 and 45,175 + 25N B for N = 2..5; there is no N = 0 or N = 6', () => {
    const lengths: Record<number, number> = {}
    for (let n = 1; n <= R1C_MAX_KEYS; n++) {
      const salt = randSalt()
      const members = Array.from({ length: n }, newMember)
      const lock = buildLock({ commitments: members.map(m => commitment(m.pub, salt)), saltHex64: salt })
      lengths[n] = lock.toBinary().length
      expect(lengths[n]).toBe(R1C_LOCK_LEN(n))
    }
    expect(lengths).toEqual({ 1: 45_199, 2: 45_225, 3: 45_250, 4: 45_275, 5: 45_300 })
    expect(() => buildLock({ commitments: [], saltHex64: randSalt() })).toThrow()
    const six = Array.from({ length: 6 }, newMember)
    const salt = randSalt()
    expect(() => buildLock({ commitments: six.map(m => commitment(m.pub, salt)), saltHex64: salt })).toThrow()
  })

  for (let n = 1; n <= R1C_MAX_KEYS; n++) {
    describe(`N = ${n}`, () => {
      const members = Array.from({ length: n }, newMember)
      const salt = randSalt()
      const lock = buildLock({ commitments: members.map(m => commitment(m.pub, salt)), saltHex64: salt })
      const sats = 150_000
      const src = fundingStub(lock, sats)
      const verify = (tx: Transaction, unlock: UnlockingScript, l: LockingScript = lock): true =>
        verifyVaultInput({ tx, inputIndex: 0, sourceSatoshis: sats, lockingScript: l, unlockingScript: unlock })

      it('bakes exactly the N commitments, each independently recomputed from noble points and hashes', () => {
        const baked = bakedCommitments(lock)
        expect(baked).toHaveLength(n)
        members.forEach((m, i) => expect(baked[i]).toBe(independentCommitment(m.pub, salt)))
        expect(hex(lock.toBinary())).not.toContain(salt)
      })

      for (let pos = 0; pos < n; pos++) {
        it(`accepts a real signature from committed position ${pos + 1} of ${n}, and noble independently verifies the pushed (r, s)`, () => {
          const signer = members[pos]
          const { tx, preimage } = spendTx(src, sats)
          const digest = signerDigest(preimage)
          const der = signDer(signer.priv, digest)
          const unlock = buildUnlock({ preimage, derSig: der, pubkeyHex33: signer.pub, saltHex64: salt })
          // Witness depth and size.
          expect(unlock.chunks).toHaveLength(71)
          expect(unlock.toBinary().length).toBeLessThanOrEqual(R1C_UNLOCK_LEN)
          // Independent P-256 check of what the witness actually carries.
          const r = fromScriptNum(unlock.chunks[0].data!)
          const s = fromScriptNum(unlock.chunks[67].data!)
          const sInv = fromScriptNum(unlock.chunks[68].data!)
          expect(r >= 1n && r < P256_P && r !== P256_N).toBe(true)
          expect(s >= 1n && s <= P256_LOW_S_MAX).toBe(true)
          expect(mod(s * sInv, P256_N)).toBe(1n)
          const compact = new p256.Signature(mod(r, P256_N), s).toBytes('compact')
          expect(p256.verify(compact, digestBytes(digest), p256.Point.fromHex(signer.pub).toBytes(true), { prehash: false, lowS: true })).toBe(true)
          expect(hex(unlock.chunks[70].data!)).toBe(salt)
          expect(independentCommitment(signer.pub, hex(unlock.chunks[70].data!))).toBe(bakedCommitments(lock)[pos])
          tx.inputs[0].unlockingScript = unlock
          expect(verify(tx, unlock)).toBe(true)
        })
      }

      it('control: the hand-assembled witness layout used by the rejects below is accepted with honest values', () => {
        const signer = members[n - 1]
        const { tx, preimage } = spendTx(src, sats)
        const d = decodeDerSignature(signDer(signer.priv, signerDigest(preimage)))
        const s = d.s > P256_LOW_S_MAX ? P256_N - d.s : d.s
        const sInv = modinv(s, P256_N)
        const e = mod(beBig([...Hash.hash256(preimage)].reverse()), P256_N)
        const u1 = mod(e * sInv, P256_N)
        const R = (u1 === 0n ? p256.Point.ZERO : p256.Point.BASE.multiply(u1)).add(p256.Point.fromHex(signer.pub).multiply(mod(d.r * sInv, P256_N)))
        const rx = R.toAffine().x
        expect(verify(tx, rawWitness({ r: rx, u2: mod(rx * sInv, P256_N), u1, pub: signer.pub, s, sInv, preimage, salt }))).toBe(true)
      })

      it('rejects an outsider key signing with its own table and the right salt', () => {
        const outsider = newMember()
        const { tx, preimage } = spendTx(src, sats)
        const digest = signerDigest(preimage)
        const der = signDer(outsider.priv, digest)
        // The signature is genuinely valid for the outsider — only the commitment check can refuse it.
        const d = decodeDerSignature(der)
        expect(p256.verify(new p256.Signature(d.r, d.s).toBytes('compact'), digestBytes(digest), p256.Point.fromHex(outsider.pub).toBytes(true), { prehash: false, lowS: false })).toBe(true)
        expectRejected(() => verify(tx, buildUnlock({ preimage, derSig: der, pubkeyHex33: outsider.pub, saltHex64: salt })))
      })

      it('rejects a wrong salt with a real committed signature', () => {
        const { tx, preimage } = spendTx(src, sats)
        const der = signDer(members[n - 1].priv, signerDigest(preimage))
        expectRejected(() => verify(tx, buildUnlock({ preimage, derSig: der, pubkeyHex33: members[n - 1].pub, saltHex64: randSalt() })))
      })

      it('rejects the signature-free CRT forgery (one r carrying independent residues mod n and mod p)', () => {
        const target = members[0]
        const { tx, preimage } = spendTx(src, sats)
        const s = 1n, sInv = 1n, t = 1n
        const e = mod(beBig([...Hash.hash256(preimage)].reverse()), P256_N)
        const Q = p256.Point.fromHex(target.pub)
        const x = p256.Point.BASE.multiply(e).add(Q.multiply(t)).toAffine().x
        const k = mod((t - x) * modinv(mod(P256_P, P256_N), P256_N), P256_N)
        const forgedR = x + P256_P * k
        expect(mod(forgedR, P256_P)).toBe(x)
        expect(mod(forgedR, P256_N)).toBe(t)
        const forged = rawWitness({ r: forgedR, u2: t, u1: e, pub: target.pub, s, sInv, preimage, salt })
        expect(forged.chunks).toHaveLength(71)
        expectRejected(() => verify(tx, forged))
      })

      it('rejects a manually encoded high-S signature that is otherwise valid', () => {
        const signer = members[0]
        const { tx, preimage } = spendTx(src, sats)
        const digest = signerDigest(preimage)
        const d = decodeDerSignature(signDer(signer.priv, digest))
        const lowS = d.s > P256_LOW_S_MAX ? P256_N - d.s : d.s
        const highS = P256_N - lowS
        expect(highS > P256_LOW_S_MAX).toBe(true)
        // The high-S form is a valid ECDSA signature too.
        expect(p256.verify(new p256.Signature(d.r, highS).toBytes('compact'), digestBytes(digest), p256.Point.fromHex(signer.pub).toBytes(true), { prehash: false, lowS: false })).toBe(true)
        const sInv = modinv(highS, P256_N)
        const e = mod(beBig([...Hash.hash256(preimage)].reverse()), P256_N)
        const u1 = mod(e * sInv, P256_N)
        const R = (u1 === 0n ? p256.Point.ZERO : p256.Point.BASE.multiply(u1)).add(p256.Point.fromHex(signer.pub).multiply(mod(d.r * sInv, P256_N)))
        const rFull = R.toAffine().x
        const witness = rawWitness({ r: rFull, u2: mod(rFull * sInv, P256_N), u1, pub: signer.pub, s: highS, sInv, preimage, salt })
        expectRejected(() => verify(tx, witness))
      })

      it('rejects a committed signature over a different preimage, and a pushed preimage that is not the spend\'s', () => {
        const signer = members[n - 1]
        const { tx, preimage } = spendTx(src, sats)
        const other = spendTx(src, sats)
        expect(hex(other.preimage)).not.toBe(hex(preimage))
        // Signature over the other transaction, real preimage pushed: the in-script r check fails.
        const d = decodeDerSignature(signDer(signer.priv, signerDigest(other.preimage)))
        const s = d.s > P256_LOW_S_MAX ? P256_N - d.s : d.s
        const sInv = modinv(s, P256_N)
        const e = mod(beBig([...Hash.hash256(preimage)].reverse()), P256_N)
        const u1 = mod(e * sInv, P256_N)
        const R = (u1 === 0n ? p256.Point.ZERO : p256.Point.BASE.multiply(u1)).add(p256.Point.fromHex(signer.pub).multiply(mod(d.r * sInv, P256_N)))
        const rx = R.toAffine().x
        expectRejected(() => verify(tx, rawWitness({ r: rx, u2: mod(rx * sInv, P256_N), u1, pub: signer.pub, s, sInv, preimage, salt })))
        // A fully consistent witness for the OTHER transaction's preimage: only OP_PUSH_TX can refuse it.
        const otherWitness = buildUnlock({ preimage: other.preimage, derSig: signDer(signer.priv, signerDigest(other.preimage)), pubkeyHex33: signer.pub, saltHex64: salt })
        expect(verifyVaultInput({ tx: other.tx, inputIndex: 0, sourceSatoshis: sats, lockingScript: lock, unlockingScript: otherWitness })).toBe(true)
        expectRejected(() => verify(tx, otherWitness))
      })

      it('rejects a version-2 spending transaction even with a consistent witness', () => {
        const signer = members[0]
        const { tx, preimage } = spendTx(src, sats, 2)
        expect(hex(preimage.slice(0, 4))).toBe('02000000')
        const digest = hex([...Hash.hash256(preimage)].reverse())
        const d = decodeDerSignature(signDer(signer.priv, digest))
        const s = d.s > P256_LOW_S_MAX ? P256_N - d.s : d.s
        const sInv = modinv(s, P256_N)
        const e = mod(beBig([...Hash.hash256(preimage)].reverse()), P256_N)
        const u1 = mod(e * sInv, P256_N)
        const R = (u1 === 0n ? p256.Point.ZERO : p256.Point.BASE.multiply(u1)).add(p256.Point.fromHex(signer.pub).multiply(mod(d.r * sInv, P256_N)))
        const rx = R.toAffine().x
        const witness = rawWitness({ r: rx, u2: mod(rx * sInv, P256_N), u1, pub: signer.pub, s, sInv, preimage, salt })
        expectRejected(() => verify(tx, witness))
      })

      it('rejects a witness that carries a valid secp256k1 signature from the public covenant key instead of P-256 data', () => {
        const { tx, preimage } = spendTx(src, sats)
        // d1 = C1 · Gx^-1 mod n_k1 with C1 = 2^248: the covenant's public dummy scalar.
        const d1 = mod((1n << 248n) * modinv(SECP_GX, SECP_N), SECP_N)
        const e = Uint8Array.from(Hash.hash256(preimage))
        const k1 = secp256k1.sign(e, Uint8Array.from(Utils.toArray(d1.toString(16).padStart(64, '0'), 'hex') as number[]), { prehash: false })
        const k1sig = secp256k1.Signature.fromBytes(k1)
        // Place the covenant signature where the P-256 r and s go, with an arbitrary committed table.
        const witness = rawWitness({
          r: k1sig.r,
          u2: 1n,
          u1: 1n,
          pub: members[0].pub,
          s: k1sig.s > P256_LOW_S_MAX ? P256_N - mod(k1sig.s, P256_N) : k1sig.s,
          sInv: modinv(k1sig.s > P256_LOW_S_MAX ? P256_N - mod(k1sig.s, P256_N) : k1sig.s, P256_N),
          preimage,
          salt
        })
        expectRejected(() => verify(tx, witness))
      })
    })
  }
})
