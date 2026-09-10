/**
 * R1C template module tests — the cryptographic arbiter for the vault script.
 *
 * Goldens come from the mined testnet fixture (docs/example-txs/51c5…579a_0.hex
 * + its spend 4766…4b80.hex) and from the spike generators that reproduce it
 * byte-for-byte (docs/example-txs/spike/gen.mjs, gen2.mjs). Round trips run the
 * real @bsv/sdk Spend interpreter with explicit strict flags.
 */
import fs from 'fs'
import path from 'path'
import { BigNumber, Curve, Hash, LockingScript, P2PKH, PrivateKey, Script, Spend, Transaction, UnlockingScript, Utils } from '@bsv/sdk'
import { p256 } from '@noble/curves/nist.js'
import {
  COMB_COLS, COMB_ROWS, COORD_WIDTH, SALT_BYTES, TABLE_SIZE, R1C_LOCK_LEN, R1C_MAX_KEYS, R1C_UNLOCK_LEN,
  P256_N, P256_P, SECP_GX, SECP_N, RECODE_CONST,
  asm, encNum, pushData, scriptNum,
  compressPubkey, combTable, combTableScalar, gTable, le33, canonicalTableBytes, commitment,
  buildLock, bakedCommitments, recode, sharedSuffix, shiftFor,
  sighashPreimage, signerDigest, pushTxSignatureS, peelLoopNonMinimalAt, pushTxDerCheck, decodeDerSignature, R1C_PREIMAGE_LEN, R1C_SIGHASH,
  fullR, buildUnlock, verifyVaultInput, R1C_VERIFY_FLAGS,
  encodeVaultInstructions, decodeVaultInstructions, type VaultInstructionsV4
} from '../../core/services/vault/r1comb'
import { VaultError } from '../../core/services/vault/types'

jest.setTimeout(180_000)

const REPO = path.resolve(__dirname, '../../../../')
export const FIXTURE_LOCK_HEX = fs
  .readFileSync(path.join(REPO, 'docs/example-txs/51c53430fe63108a2a1ddd231253df069fb424cc6f1bb0ee60b4b07792d3579a_0.hex'), 'utf8')
  .trim()
export const FIXTURE_TX_HEX = fs
  .readFileSync(path.join(REPO, 'docs/example-txs/476611a431172df767a73349522536fa78d63a83b560efbb695b853bf60b4b80.hex'), 'utf8')
  .trim()

const hex = (a: number[]): string => Utils.toHex(a)

describe('r1comb constants', () => {
  it('pins the comb geometry and size constants from spec §2', () => {
    expect(COMB_ROWS).toBe(6)
    expect(COMB_COLS).toBe(43)
    expect(TABLE_SIZE).toBe(32)
    expect(COORD_WIDTH).toBe(33)
    expect(SALT_BYTES).toBe(32)
    expect(R1C_UNLOCK_LEN).toBe(2560)
    expect(R1C_MAX_KEYS).toBe(5)
    expect(RECODE_CONST).toBe((1n << 258n) - 1n)
  })

  it('R1C_LOCK_LEN is 27855 for N=1 and 27831 + 25N for N=2..5, throws otherwise', () => {
    expect(R1C_LOCK_LEN(1)).toBe(27855)
    expect(R1C_LOCK_LEN(2)).toBe(27881)
    expect(R1C_LOCK_LEN(3)).toBe(27906)
    expect(R1C_LOCK_LEN(4)).toBe(27931)
    expect(R1C_LOCK_LEN(5)).toBe(27956)
    for (const bad of [0, 6, -1, 1.5, NaN]) {
      expect(() => R1C_LOCK_LEN(bad)).toThrow(VaultError)
      try { R1C_LOCK_LEN(bad) } catch (e) { expect((e as VaultError).code).toBe('template-invalid') }
    }
  })

  it('curve constants match ANALYSIS.md §2 and the SDK secp256k1 curve', () => {
    expect(P256_P.toString(16)).toBe('ffffffff00000001000000000000000000000000ffffffffffffffffffffffff')
    expect(P256_N.toString(16)).toBe('ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551')
    const secp = new Curve()
    expect(SECP_N.toString(16)).toBe(secp.n.toHex())
    expect(SECP_GX.toString(16)).toBe((secp.g.x as BigNumber).toHex())
  })
})

describe('script-number encoding', () => {
  // (value, scriptNum hex, encNum hex) — from gen.mjs run against the SDK's BigNumber.toSm('little')
  const vectors: Array<[bigint, string, string]> = [
    [0n, '', '00'],
    [1n, '01', '51'],
    [16n, '10', '60'],
    [17n, '11', '0111'],
    [127n, '7f', '017f'],
    [128n, '8000', '028000'],
    [255n, 'ff00', '02ff00'],
    [256n, '0001', '020001'],
    [-1n, '81', '4f'],
    [-127n, 'ff', '01ff'],
    [-128n, '8080', '028080'],
    [32767n, 'ff7f', '02ff7f'],
    [32768n, '008000', '03008000'],
    [(1n << 247n) - 1n, 'ff'.repeat(30) + '7f', '1f' + 'ff'.repeat(30) + '7f'],
    [1n << 247n, '00'.repeat(30) + '8000', '20' + '00'.repeat(30) + '8000'],
    [(1n << 255n) - 1n, 'ff'.repeat(31) + '7f', '20' + 'ff'.repeat(31) + '7f'],
    [1n << 255n, '00'.repeat(31) + '8000', '21' + '00'.repeat(31) + '8000'],
    [P256_N, '512563fcc2cab9f3849e17a7adfae6bcffffffffffffffff00000000ffffffff00', '21512563fcc2cab9f3849e17a7adfae6bcffffffffffffffff00000000ffffffff00'],
    [P256_P, 'ffffffffffffffffffffffff00000000000000000000000001000000ffffffff00', '21ffffffffffffffffffffffff00000000000000000000000001000000ffffffff00'],
    [RECODE_CONST, 'ff'.repeat(32) + '03', '21' + 'ff'.repeat(32) + '03']
  ]

  it.each(vectors)('scriptNum / encNum of %s', (v, sm, enc) => {
    expect(hex(scriptNum(v))).toBe(sm)
    expect(hex(encNum(v))).toBe(enc)
  })

  it('scriptNum equals BigNumber.toSm("little") for every vector', () => {
    for (const [v] of vectors) {
      const neg = v < 0n
      const bn = new BigNumber((neg ? -v : v).toString(16), 16)
      const sdk = (neg ? bn.neg() : bn).toSm('little')
      expect(hex(scriptNum(v))).toBe(hex(sdk))
    }
  })

  it('pushData picks the minimal push opcode', () => {
    expect(hex(pushData([]))).toBe('00')
    expect(hex(pushData([7]))).toBe('0107')
    expect(hex(pushData(new Array(75).fill(1)))).toBe('4b' + '01'.repeat(75))
    expect(hex(pushData(new Array(76).fill(1)))).toBe('4c4c' + '01'.repeat(76))
    expect(hex(pushData(new Array(158).fill(2)))).toBe('4c9e' + '02'.repeat(158))
    expect(hex(pushData(new Array(256).fill(3)))).toBe('4d0001' + '03'.repeat(256))
  })
})

describe('asm mini-assembler', () => {
  it('assembles region H0 of the lock', () => {
    expect(hex(asm('OP_DUP OP_HASH256 <00> OP_CAT OP_BIN2NUM OP_SWAP OP_TOALTSTACK'))).toBe('76aa01007e817c6b')
  })

  it('expands the MODP and NORM macros', () => {
    expect(hex(asm('MODP'))).toBe('6c766b97')
    expect(hex(asm('NORM'))).toBe('76009f636c766b9368')
  })

  it('encodes numeric tokens and bigint / number / byte-array params', () => {
    expect(hex(asm('0 1 16 17 -1 257'))).toBe('005160011' + '14f020101')
    expect(hex(asm('{N} OP_TOALTSTACK', { N: P256_N }))).toBe('21512563fcc2cab9f3849e17a7adfae6bcffffffffffffffff00000000ffffffff006b')
    expect(hex(asm('{D} OP_PICK', { D: 70 }))).toBe('014679')
    expect(hex(asm('{S} OP_CAT', { S: [0x41] }))).toBe('01417e')
  })

  it('rejects unknown opcodes and missing params with template-invalid', () => {
    expect(() => asm('OP_NOPE')).toThrow(VaultError)
    expect(() => asm('{MISSING}')).toThrow(VaultError)
  })
})

/** The fixture's signer key, recovered from its Q comb table (ANALYSIS.md §2). */
export const FIXTURE_Q = '03f4d667712d8825372cd616b0b1b1a818e5eeb3681dd45c5bdd59fed9f21d5a7d'

describe('compressPubkey', () => {
  it('compresses a 65-byte SEC1 point and lowercases a compressed one', () => {
    const priv = p256.utils.randomSecretKey()
    const uncompressed = Utils.toHex(p256.getPublicKey(priv, false))
    const compressed = Utils.toHex(p256.getPublicKey(priv, true))
    expect(uncompressed).toHaveLength(130)
    expect(compressPubkey(uncompressed)).toBe(compressed)
    expect(compressPubkey(compressed.toUpperCase())).toBe(compressed)
    expect(compressPubkey(FIXTURE_Q)).toBe(FIXTURE_Q)
  })

  it.each([
    '', 'zz', '02' + 'ff'.repeat(32) /* x >= p */, '05' + '00'.repeat(32), '04' + '00'.repeat(64) /* off curve */,
    FIXTURE_Q.slice(0, 64), FIXTURE_Q + '00'
  ])('throws template-invalid on %s', bad => {
    expect(() => compressPubkey(bad)).toThrow(VaultError)
    try { compressPubkey(bad) } catch (e) { expect((e as VaultError).code).toBe('template-invalid') }
  })
})

describe('comb tables', () => {
  const fixtureLock = LockingScript.fromHex(FIXTURE_LOCK_HEX)

  it('combTableScalar: T_j = 2^215 + Σ (bit_k(j) ? +1 : -1)·2^(43k)', () => {
    expect(combTableScalar(0)).toBe((1n << 215n) - (1n << 172n) - (1n << 129n) - (1n << 86n) - (1n << 43n) - 1n)
    expect(combTableScalar(31)).toBe((1n << 215n) + (1n << 172n) + (1n << 129n) + (1n << 86n) + (1n << 43n) + 1n)
    expect(combTableScalar(1)).toBe(combTableScalar(0) + 2n)
  })

  it('combTable(fixture Q) equals fixture chunks 151..214 as minimal scriptnums', () => {
    const table = combTable(FIXTURE_Q)
    expect(table).toHaveLength(32)
    for (let j = 0; j < 32; j++) {
      expect(hex(fixtureLock.chunks[151 + 2 * j].data!)).toBe(hex(scriptNum(table[j].x)))
      expect(hex(fixtureLock.chunks[152 + 2 * j].data!)).toBe(hex(scriptNum(table[j].y)))
    }
    expect(table[0].x.toString(16)).toBe('954767a2ef708eeab0476600b7a681af687f511f6a92b4f365ba6fedf9be3ad')
    expect(table[31].y.toString(16)).toBe('5a5330b7f93e4fafddac56b822bbcdbfad880239d990a9623018422aff4e9083')
  })

  it('gTable() equals fixture chunks 87..150', () => {
    const g = gTable()
    for (let j = 0; j < 32; j++) {
      expect(hex(fixtureLock.chunks[87 + 2 * j].data!)).toBe(hex(scriptNum(g[j].x)))
      expect(hex(fixtureLock.chunks[88 + 2 * j].data!)).toBe(hex(scriptNum(g[j].y)))
    }
    expect(g[0].x.toString(16)).toBe('16e4abe60c4b18a476fdab0db59c1ac3767855b4118be0113bd04bb679f1952d')
  })

  it('memoises per pubkey (same array back) and normalises the key case', () => {
    const a = combTable(FIXTURE_Q)
    expect(combTable(FIXTURE_Q)).toBe(a)
    expect(combTable(FIXTURE_Q.toUpperCase())).toBe(a)
  })

  it('evicts the oldest entry once more than 8 keys are cached', () => {
    const first = combTable(FIXTURE_Q)
    for (let i = 0; i < 8; i++) combTable(Utils.toHex(p256.getPublicKey(p256.utils.randomSecretKey(), true)))
    expect(combTable(FIXTURE_Q)).not.toBe(first)
  })
})

describe('canonical table bytes and commitment', () => {
  it('le33 is OP_NUM2BIN(v, 33): minimal LE magnitude zero-padded to 33 bytes', () => {
    expect(hex(le33(0n))).toBe('00'.repeat(33))
    expect(hex(le33(1n))).toBe('01' + '00'.repeat(32))
    expect(hex(le33(1n << 255n))).toBe('00'.repeat(31) + '8000')
    expect(() => le33(-1n)).toThrow(VaultError)
    expect(() => le33(1n << 263n)).toThrow(VaultError)
  })

  it('canonicalTableBytes(fixture Q) is 2,112 bytes with the pinned sha256', () => {
    const c = canonicalTableBytes(FIXTURE_Q)
    expect(c).toHaveLength(64 * 33)
    expect(hex(Hash.sha256(c))).toBe('014d1dc4d05be751e798dc280bdd824dda0880d70f1615275ef62c66d680bf77')
  })

  it('commitment = hash160(salt ‖ canonical) — pinned for two salts', () => {
    expect(commitment(FIXTURE_Q, '01'.repeat(32))).toBe('d45e539304c629b5ef67f7d38e654e5ed2138152')
    expect(commitment(FIXTURE_Q, '00'.repeat(32))).toBe('1efb4cd1b3edc12a6772215d5f112aad53541246')
    expect(commitment(FIXTURE_Q, '01'.repeat(32))).toBe(
      hex(Hash.hash160([...(Utils.toArray('01'.repeat(32), 'hex') as number[]), ...canonicalTableBytes(FIXTURE_Q)]))
    )
  })

  it.each(['', '01'.repeat(31), '01'.repeat(33), 'zz'.repeat(32)])('commitment rejects salt %s', bad => {
    expect(() => commitment(FIXTURE_Q, bad)).toThrow(VaultError)
  })
})

/** hash160 of a small deterministic byte string — a syntactically valid commitment for structural tests. */
const fakeCommitment = (i: number): string => Utils.toHex(Hash.hash160([0xc0, i]))

/** Golden commitment set: FIXTURE_Q under the two salts pinned in Task 2. */
const GOLDEN_C2 = ['d45e539304c629b5ef67f7d38e654e5ed2138152', '1efb4cd1b3edc12a6772215d5f112aad53541246']
/** sha256 of buildLock({ commitments: GOLDEN_C2 }) — computed from docs/example-txs/spike/gen2.mjs
 *  (`buildLock2({ commitments: GOLDEN_C2 })`), the reference this module ports. If this ever differs
 *  the PORT is wrong; never re-pin to the new value. Re-derive with:
 *  cd docs/example-txs/spike && node --input-type=module -e "import { buildLock2 } from './gen2.mjs'; import { Hash, Utils } from '@bsv/sdk'; console.log(Utils.toHex(Hash.sha256(buildLock2({ commitments: ['d45e539304c629b5ef67f7d38e654e5ed2138152', '1efb4cd1b3edc12a6772215d5f112aad53541246'] }).toBinary())))" */
const GOLDEN_SHA256_N2 = '1b94d0b8453d459116694334b67f7f2c32ec77c2e0e6588805e5d0d4cd2ed472'
/** Same for N = 1 with GOLDEN_C2[0] only. */
const GOLDEN_SHA256_N1 = '680a378d65640bea8b31e70b884809a9b6aaf6cbcf011fdefa7202c3db0930a4'
/** OP_PUSH_TX dummy key d·G, d = 2^248·Gx⁻¹ mod n_k1 (ANALYSIS.md §6.1, fixture chunk 23064). */
const PUSH_TX_PUBKEY = '02b405d7f0322a89d0f9f3a98e6f938fdc1c969a8d1382a2bf66a71ae74a1e83b0'

describe('recode and shiftFor', () => {
  it("recode(u) = ((u odd ? u : u + n) + 2^258 − 1) / 2 and inverts to u mod n", () => {
    expect(recode(1n)).toBe(1n << 257n)
    expect(recode(P256_N - 1n)).toBe(P256_N + (1n << 257n) - 1n)
    // fixture u1 (ANALYSIS.md §2, even → +n branch)
    const u1 = 0x051fd0dba16ab0f7a8ba9127e52a45c1316ab230f807d243ec88788eb1d8d2e6n
    expect(recode(u1)).toBe((u1 + P256_N + RECODE_CONST) / 2n)
    for (let i = 0; i < 50; i++) {
      const u = BigInt('0x' + Utils.toHex(Array.from(p256.utils.randomSecretKey()))) % P256_N
      const up = recode(u)
      expect(up < (1n << 258n)).toBe(true)
      expect((up >> 257n) & 1n).toBe(1n)
      expect((((2n * up - RECODE_CONST) % P256_N) + P256_N) % P256_N).toBe(u)
    }
  })

  it('shiftFor(c, k) = 257 − c − 43k', () => {
    expect(shiftFor(0, 0)).toBe(257)
    expect(shiftFor(42, 5)).toBe(0)
    expect(shiftFor(0, 5)).toBe(42)
    expect(shiftFor(42, 0)).toBe(215)
    for (let c = 0; c < 43; c++) for (let k = 0; k < 6; k++) expect(shiftFor(c, k)).toBe(257 - c - 43 * k)
  })
})

describe('buildLock goldens', () => {
  const fixtureLock = LockingScript.fromHex(FIXTURE_LOCK_HEX)

  it('sharedSuffix() equals fixture chunks [87..150] ++ [215..end] byte-for-byte (27,160 B)', () => {
    const fixtureSuffix = new LockingScript([...fixtureLock.chunks.slice(87, 151), ...fixtureLock.chunks.slice(215)])
    const mine = sharedSuffix()
    expect(mine).toHaveLength(27160)
    expect(hex(mine)).toBe(fixtureSuffix.toHex())
    expect(sharedSuffix()).toEqual(mine) // cached and stable
  })

  it.each([1, 2, 3, 4, 5])('N=%i: exact byte length R1C_LOCK_LEN(N) and chunk count', N => {
    const commitments = [...Array(N)].map((_, i) => fakeCommitment(i))
    const lock = buildLock({ commitments })
    expect(lock.toBinary()).toHaveLength(R1C_LOCK_LEN(N))
    expect(lock.chunks).toHaveLength(N === 1 ? 23310 : 23306 + 5 * N)
    // the lock ends with the shared suffix
    const bin = lock.toBinary()
    expect(hex(bin.slice(bin.length - 27160))).toBe(hex(sharedSuffix()))
  })

  it('pins sha256 for the golden commitment sets (N = 1 and N = 2)', () => {
    expect(hex(Hash.sha256(buildLock({ commitments: [GOLDEN_C2[0]] }).toBinary()))).toBe(GOLDEN_SHA256_N1)
    expect(hex(Hash.sha256(buildLock({ commitments: GOLDEN_C2 }).toBinary()))).toBe(GOLDEN_SHA256_N2)
    // uppercase commitments produce the same bytes
    expect(hex(buildLock({ commitments: GOLDEN_C2.map(c => c.toUpperCase()) }).toBinary())).toBe(hex(buildLock({ commitments: GOLDEN_C2 }).toBinary()))
  })

  it('tail ends with <dummy pubkey> OP_CODESEPARATOR OP_CHECKSIG', () => {
    const c = buildLock({ commitments: [fakeCommitment(0)] }).chunks
    expect(hex(c[c.length - 3].data!)).toBe(PUSH_TX_PUBKEY)
    expect(c[c.length - 2].op).toBe(0xab)
    expect(c[c.length - 1].op).toBe(0xac)
    expect(hex(fixtureLock.chunks[23064].data!)).toBe(PUSH_TX_PUBKEY)
  })

  it('H5 layout: N=1 is <C0> EQUALVERIFY; N>=2 is (DUP <Ci> EQUAL SWAP)×(N−1) <C_last> EQUAL BOOLOR×(N−1) VERIFY', () => {
    const one = buildLock({ commitments: [fakeCommitment(0)] }).chunks
    expect(one[391].op).toBe(0xa9) // OP_HASH160
    expect(hex(one[392].data!)).toBe(fakeCommitment(0))
    expect(one[393].op).toBe(0x88) // OP_EQUALVERIFY
    const three = buildLock({ commitments: [0, 1, 2].map(fakeCommitment) }).chunks
    expect(three[391].op).toBe(0xa9)
    expect(three.slice(392, 392 + 4 * 2 + 2 + 2 + 1).map(k => (k.data !== undefined ? hex(k.data) : k.op))).toEqual([
      0x76, fakeCommitment(0), 0x87, 0x7c,
      0x76, fakeCommitment(1), 0x87, 0x7c,
      fakeCommitment(2), 0x87,
      0x9b, 0x9b, 0x69
    ])
  })

  it.each([
    [[]],
    [[0, 1, 2, 3, 4, 5].map(fakeCommitment)],
    [['zz'.repeat(20)]],
    [[fakeCommitment(0).slice(0, 38)]],
    [[fakeCommitment(0) + '00']],
    [[fakeCommitment(0), fakeCommitment(0)]],
    [[fakeCommitment(0), fakeCommitment(0).toUpperCase()]]
  ])('buildLock rejects %j with template-invalid', bad => {
    expect(() => buildLock({ commitments: bad })).toThrow(VaultError)
    try { buildLock({ commitments: bad }) } catch (e) { expect((e as VaultError).code).toBe('template-invalid') }
  })
})

describe('bakedCommitments', () => {
  it.each([1, 2, 3, 4, 5])('round-trips N=%i commitments in order', N => {
    const commitments = [...Array(N)].map(() => Utils.toHex(Hash.hash160(Array.from(p256.utils.randomSecretKey()))))
    const lock = buildLock({ commitments })
    expect(bakedCommitments(lock)).toEqual(commitments)
    // also from a re-parsed copy (what a BEEF gives Plan 2)
    expect(bakedCommitments(Script.fromHex(lock.toHex()))).toEqual(commitments)
  })

  it('returns lowercase even when built from uppercase input', () => {
    expect(bakedCommitments(buildLock({ commitments: GOLDEN_C2.map(c => c.toUpperCase()) }))).toEqual(GOLDEN_C2)
  })

  it.each<[string, () => Script]>([
    ['empty script', () => Script.fromHex('')],
    ['P2PKH', () => Script.fromASM('OP_DUP OP_HASH160 ' + 'ab'.repeat(20) + ' OP_EQUALVERIFY OP_CHECKSIG')],
    ['the original fixture lock (Q table baked, no H5)', () => LockingScript.fromHex(FIXTURE_LOCK_HEX)],
    ['R1C lock with its last byte dropped', () => { const b = buildLock({ commitments: GOLDEN_C2 }).toBinary(); return Script.fromBinary(b.slice(0, -1)) }],
    ['R1C lock with one suffix byte flipped', () => { const b = buildLock({ commitments: GOLDEN_C2 }).toBinary(); b[10_000] ^= 0x01; return Script.fromBinary(b) }],
    ['R1C lock with one header byte flipped', () => { const b = buildLock({ commitments: GOLDEN_C2 }).toBinary(); b[3] ^= 0x01; return Script.fromBinary(b) }],
    ['R1C lock whose H5 BOOLOR was replaced by OP_BOOLAND', () => { const b = buildLock({ commitments: GOLDEN_C2 }).toBinary(); const i = b.length - 27160 - 2; expect(b[i]).toBe(0x9b); b[i] = 0x9a; return Script.fromBinary(b) }]
  ])('throws template-invalid on %s', (_name, mk) => {
    expect(() => bakedCommitments(mk())).toThrow(VaultError)
    try { bakedCommitments(mk()) } catch (e) { expect((e as VaultError).code).toBe('template-invalid') }
  })
})

/** Minimal LE sign-magnitude scriptnum bytes → bigint (inverse of scriptNum; test-side only). */
export const fromScriptNum = (b: number[]): bigint => {
  if (b.length === 0) return 0n
  const m = [...b]
  const neg = (m[m.length - 1] & 0x80) !== 0
  m[m.length - 1] &= 0x7f
  const v = BigInt('0x' + hex([...m].reverse()))
  return neg ? -v : v
}
export const beBig = (b: number[]): bigint => BigInt('0x' + (b.length > 0 ? hex(b) : '0'))
/** 158 random bytes — a synthetic preimage for functions that only hash their input (test-side only). */
const syntheticPreimage = (): number[] => {
  const out: number[] = []
  while (out.length < R1C_PREIMAGE_LEN) out.push(...Array.from(p256.utils.randomSecretKey()))
  return out.slice(0, R1C_PREIMAGE_LEN)
}

/** Fixture facts (ANALYSIS.md §2). */
export const FIXTURE_SATS = 4600
export const FIXTURE_HASH256 = '0bd94d7d0883ed0e47d4bbc903845542857cb072a85b45c7a6484f7ff532620e'
export const FIXTURE_DIGEST = '0e6232f57f4f48a6c7455ba872b07c8542558403c9bbd4470eed83087d4dd90b'
export const FIXTURE_R = 0xe3c4329684a494d2db1c99234f136d9b941c4274f40befe976b546c130f9f7c7n
export const FIXTURE_S = 0x401a6223caf9c7b57188e354044d52687ed2c69f975bc4c075369d44199d67e9n
export const FIXTURE_DER = '3045022100e3c4329684a494d2db1c99234f136d9b941c4274f40befe976b546c130f9f7c70220401a6223caf9c7b57188e354044d52687ed2c69f975bc4c075369d44199d67e9'

describe('sighashPreimage and signerDigest (fixture spend)', () => {
  const tx = Transaction.fromHex(FIXTURE_TX_HEX)
  const unlock = tx.inputs[0].unlockingScript!
  const hashOutputs = unlock.chunks[3].data!   // push #3
  const outpoint = unlock.chunks[4].data!      // push #4

  it('reconstructs the 158-byte preimage field by field', () => {
    expect(hashOutputs).toHaveLength(32)
    expect(outpoint).toHaveLength(36)
    const expected = [
      ...(Utils.toArray('01000000', 'hex') as number[]),           // version 1
      ...Hash.hash256(outpoint),                                    // hashPrevouts (single input)
      ...Hash.hash256(Utils.toArray('ffffffff', 'hex') as number[]),// hashSequence
      ...outpoint,
      ...(Utils.toArray('01ac', 'hex') as number[]),               // scriptCode = OP_CHECKSIG
      ...(Utils.toArray('f811000000000000', 'hex') as number[]),   // 4600 sat LE64
      ...(Utils.toArray('ffffffff', 'hex') as number[]),           // sequence
      ...hashOutputs,
      ...(Utils.toArray('00000000', 'hex') as number[]),           // lockTime
      ...(Utils.toArray('41000000', 'hex') as number[])            // sighash ALL|FORKID
    ]
    expect(expected).toHaveLength(R1C_PREIMAGE_LEN)
    const preimage = sighashPreimage(tx, 0, FIXTURE_SATS)
    expect(hex(preimage)).toBe(hex(expected))
    expect(hex(preimage.slice(118, 150))).toBe(hex(hashOutputs))
    expect(hex(preimage.slice(68, 104))).toBe(hex(outpoint))
    expect(hex(Hash.hash256(preimage))).toBe(FIXTURE_HASH256)
    expect(R1C_SIGHASH).toBe(0x41)
  })

  it('signerDigest is reverse(hash256(preimage)) as 64 lowercase hex', () => {
    const preimage = sighashPreimage(tx, 0, FIXTURE_SATS)
    expect(signerDigest(preimage)).toBe(FIXTURE_DIGEST)
    expect(signerDigest(preimage)).toBe(hex([...Hash.hash256(preimage)].reverse()))
    // the script's e is the LE view of hash256 == the BE view of the digest
    expect(beBig(Utils.toArray(FIXTURE_DIGEST, 'hex') as number[])).toBe(beBig([...Hash.hash256(preimage)].reverse()))
  })

  it('a different sourceSatoshis changes only the amount field', () => {
    const a = sighashPreimage(tx, 0, FIXTURE_SATS)
    const b = sighashPreimage(tx, 0, FIXTURE_SATS + 1)
    expect(hex(a.slice(0, 106))).toBe(hex(b.slice(0, 106)))
    expect(hex(a.slice(114))).toBe(hex(b.slice(114)))
    expect(hex(b.slice(106, 114))).toBe('f911000000000000')
  })

  it('rejects a missing input, an input without a source reference, and bad satoshis', () => {
    expect(() => sighashPreimage(tx, 1, FIXTURE_SATS)).toThrow(VaultError)
    const bare = new Transaction(2, [{ sourceOutputIndex: 0, sequence: 0xffffffff }], [], 0)
    expect(() => sighashPreimage(bare, 0, 1000)).toThrow(VaultError)
    expect(() => sighashPreimage(tx, 0, -1)).toThrow(VaultError)
    expect(() => sighashPreimage(tx, 0, 1.5)).toThrow(VaultError)
    expect(() => signerDigest(new Array(157).fill(0))).toThrow(VaultError)
  })
})

describe('OP_PUSH_TX model: pushTxSignatureS / peelLoopNonMinimalAt / pushTxDerCheck', () => {
  const tx = Transaction.fromHex(FIXTURE_TX_HEX)
  const preimage = sighashPreimage(tx, 0, FIXTURE_SATS)

  it('fixture: ok, and s = e_k1 + 2^248 (no wrap, below n/2)', () => {
    const eK1 = beBig(Hash.hash256(preimage))
    expect(eK1).toBe(BigInt('0x' + FIXTURE_HASH256))
    const chk = pushTxDerCheck(preimage)
    expect(chk.ok).toBe(true)
    expect(chk.s).toBe(eK1 + (1n << 248n))
    expect(pushTxSignatureS(preimage)).toBe(chk.s)
    expect(chk.s < (SECP_N - 1n) / 2n).toBe(true)
  })

  it('pushTxSignatureS applies mod n_k1 and the low-S flip', () => {
    // synthetic preimages are fine here: the function only hashes its input
    for (let i = 0; i < 200; i++) {
      const p = Array.from(p256.utils.randomSecretKey())
      const e = beBig(Hash.hash256(p))
      const t = ((e + (1n << 248n)) % SECP_N + SECP_N) % SECP_N
      const expected = t > (SECP_N - 1n) / 2n ? SECP_N - t : t
      expect(pushTxSignatureS(p)).toBe(expected)
      expect(pushTxSignatureS(p) <= (SECP_N - 1n) / 2n).toBe(true)
    }
  })

  // ANALYSIS.md §6.2 boundary table of the peel loop (k = index of the first non-minimal remainder, −1 = ok)
  it.each<[string, bigint, number, number]>([
    ['2^248 − 1', (1n << 248n) - 1n, 32, -1],
    ['2^247',     1n << 247n,        32, -1],
    ['2^247 − 1', (1n << 247n) - 1n, 31, -1],
    ['2^240',     1n << 240n,        31, -1],
    ['2^240 − 1', (1n << 240n) - 1n, 31, 30],
    ['2^239',     1n << 239n,        31, 30],
    ['2^239 − 1', (1n << 239n) - 1n, 30, -1],
    ['2^231',     1n << 231n,        30, 29],
    ['255',       255n,               2,  1],
    ['128',       128n,               2,  1],
    ['127',       127n,               1, -1],
    ['1',         1n,                 1, -1]
  ])('peelLoopNonMinimalAt(scriptNum(%s)) — %i-byte scriptnum → %i', (_n, s, len, k) => {
    const b = scriptNum(s)
    expect(b).toHaveLength(len)
    expect(peelLoopNonMinimalAt(b)).toBe(k)
  })

  it('peelLoopNonMinimalAt: empty remainder is fine; a lone 0x00 or 0x80 is not', () => {
    expect(peelLoopNonMinimalAt([])).toBe(-1)
    expect(peelLoopNonMinimalAt([0x00])).toBe(0)
    expect(peelLoopNonMinimalAt([0x80])).toBe(0)
    expect(peelLoopNonMinimalAt([0x01, 0x00])).toBe(0)   // 1 with a redundant 00: non-minimal as a whole (k = 0)
    expect(peelLoopNonMinimalAt([0xff, 0x00])).toBe(1)   // 255: minimal as a whole; the lone 00 left after one peel is not
    expect(peelLoopNonMinimalAt([0x00, 0x80])).toBe(0)   // −0 with a padded magnitude: non-minimal at k = 0
    expect(peelLoopNonMinimalAt([0x80, 0x00])).toBe(1)   // 128: minimal as a whole; lone 00 at k = 1 (the 2^(8m−1) class)
  })

  it('pushTxDerCheck agrees with the predicate on the boundary classes (ok ⇔ s ≠ 0 ∧ peel = −1)', () => {
    // Pick 4,000 synthetic 158-byte preimages; every verdict must equal the closed form.
    // (pushTxDerCheck enforces the 158-byte length, unlike pushTxSignatureS — so the inputs must be full-size.)
    for (let i = 0; i < 4000; i++) {
      const p = syntheticPreimage()
      const { ok, s } = pushTxDerCheck(p)
      expect(ok).toBe(s !== 0n && peelLoopNonMinimalAt(scriptNum(s)) === -1)
    }
  })
})

describe('decodeDerSignature', () => {
  it('decodes the fixture signature', () => {
    expect(decodeDerSignature(Utils.toArray(FIXTURE_DER, 'hex') as number[])).toEqual({ r: FIXTURE_R, s: FIXTURE_S })
    expect(hex(Array.from(new p256.Signature(FIXTURE_R, FIXTURE_S).toBytes('der')))).toBe(FIXTURE_DER)
  })

  it("round-trips noble's DER for 200 fresh signatures (low-S and high-S)", () => {
    for (let i = 0; i < 200; i++) {
      const priv = p256.utils.randomSecretKey()
      const digest = p256.utils.randomSecretKey()
      const sig = p256.Signature.fromBytes(p256.sign(digest, priv, { prehash: false, lowS: false }))
      const der = Array.from(sig.toBytes('der'))
      expect(decodeDerSignature(der)).toEqual({ r: sig.r, s: sig.s })
      const flipped = new p256.Signature(sig.r, P256_N - sig.s)
      expect(decodeDerSignature(Array.from(flipped.toBytes('der')))).toEqual({ r: sig.r, s: P256_N - sig.s })
    }
  })

  it.each<[string, number[]]>([
    ['empty', []],
    ['just a SEQUENCE tag', [0x30]],
    ['compact r‖s', Array.from(new p256.Signature(FIXTURE_R, FIXTURE_S).toBytes('compact'))],
    ['trailing byte', [...(Utils.toArray(FIXTURE_DER, 'hex') as number[]), 0x00]],
    ['SEQUENCE length off by one', (() => { const d = Utils.toArray(FIXTURE_DER, 'hex') as number[]; d[1] -= 1; return d })()],
    ['negative r (missing 00 pad)', (() => { const d = Utils.toArray(FIXTURE_DER, 'hex') as number[]; d.splice(4, 1); d[1] -= 1; d[3] -= 1; return d })()],
    ['non-minimal s (extra 00 pad)', (() => { const d = Utils.toArray(FIXTURE_DER, 'hex') as number[]; d.splice(d.length - 32, 0, 0x00); d[1] += 1; d[d.length - 34] += 1; return d })()],
    // noble's Signature constructor refuses r = 0, so this is the DER it would otherwise emit: INTEGER 0 is `02 01 00`
    ['r = 0', [0x30, 37, 0x02, 0x01, 0x00, 0x02, 0x20, ...(Utils.toArray(FIXTURE_S.toString(16), 'hex') as number[])]],
    ['s = n', (() => { const rInt = Array.from(new p256.Signature(FIXTURE_R, 1n).toBytes('der')).slice(2, 2 + 35); const nBytes = Utils.toArray(P256_N.toString(16), 'hex') as number[]; return [0x30, 70, ...rInt, 0x02, 33, 0x00, ...nBytes] })()],
    ['INTEGER tag replaced', (() => { const d = Utils.toArray(FIXTURE_DER, 'hex') as number[]; d[2] = 0x04; return d })()]
  ])('rejects %s with template-invalid', (_name, der) => {
    expect(() => decodeDerSignature(der)).toThrow(VaultError)
    try { decodeDerSignature(der) } catch (e) { expect((e as VaultError).code).toBe('template-invalid') }
  })
})

interface Member { priv: Uint8Array; pub: string }
const newMember = (): Member => {
  const priv = p256.utils.randomSecretKey()
  return { priv, pub: Utils.toHex(Array.from(p256.getPublicKey(priv, true))) }
}
const randSalt = (): string => Utils.toHex(Array.from(p256.utils.randomSecretKey()))
const digestBytes = (digestHex: string): Uint8Array => Uint8Array.from(Utils.toArray(digestHex, 'hex') as number[])
/** DER signature over a 64-hex digest, RFC6979, lowS NOT enforced (the card does not normalise either). */
const signDer = (priv: Uint8Array, digestHex: string): number[] =>
  Array.from(p256.Signature.fromBytes(p256.sign(digestBytes(digestHex), priv, { prehash: false, lowS: false })).toBytes('der'))
const p2pkhOut = (): LockingScript => new P2PKH().lock(PrivateKey.fromRandom().toAddress())
const NONCE_OUT = (): LockingScript => new LockingScript(Script.fromASM('OP_RETURN 6e6f6e6365').chunks)

/** Funding stub: `lock` at output `vout` of a zero-input transaction; the other outputs are P2PKH dust. */
function fundingStub(lock: LockingScript, sats: number, vout: number): Transaction {
  const src = new Transaction(1, [], [], 0)
  for (let k = 0; k < vout; k++) src.addOutput({ satoshis: 1, lockingScript: p2pkhOut() })
  src.addOutput({ satoshis: sats, lockingScript: lock })
  return src
}

/** Re-encode one push of an unlocking script (tamper helper); every other chunk is re-emitted minimally. */
function withPush(unlock: UnlockingScript, index: number, data: number[]): UnlockingScript {
  const bytes: number[] = []
  unlock.chunks.forEach((c, i) => {
    if (i === index) bytes.push(...pushData(data))
    else if (c.data !== undefined) bytes.push(...pushData(c.data))
    else bytes.push(c.op)
  })
  return new UnlockingScript(Script.fromBinary(bytes).chunks)
}

/** Preimages of the given vault inputs after the D4b screen: on a failing check, decrement that input's sequence and retry (≤ 16). */
function screenedPreimages(tx: Transaction, vaultInputs: { index: number; sats: number }[]): number[][] {
  for (let attempt = 0; attempt < 16; attempt++) {
    const pres = vaultInputs.map(v => sighashPreimage(tx, v.index, v.sats))
    const bad = pres.findIndex(p => !pushTxDerCheck(p).ok)
    if (bad < 0) return pres
    const inp = tx.inputs[vaultInputs[bad].index]
    inp.sequence = ((inp.sequence ?? 0xffffffff) - 1) >>> 0
  }
  throw new Error('pushTxDerCheck failed 16 times in a row (probability ≈ 2^-256)')
}

const modpowT = (base: bigint, exp: bigint, m: bigint): bigint => {
  let r = 1n
  let b = ((base % m) + m) % m
  let e = exp
  while (e > 0n) { if ((e & 1n) === 1n) r = (r * b) % m; b = (b * b) % m; e >>= 1n }
  return r
}
const modinvT = (a: bigint, m: bigint): bigint => modpowT(a, m - 2n, m)

describe('verifyVaultInput flags and the fixture spend', () => {
  it('R1C_VERIFY_FLAGS is exactly the contract set', () => {
    expect([...R1C_VERIFY_FLAGS]).toEqual(['MINIMALDATA', 'UTXO_AFTER_CHRONICLE', 'SIGHASH_FORKID', 'STRICTENC'])
  })

  it('the mined fixture spend (version 1) validates under the strict flags; sourceSatoshis + 1 throws', () => {
    const tx = Transaction.fromHex(FIXTURE_TX_HEX)
    const lock = LockingScript.fromHex(FIXTURE_LOCK_HEX)
    const unlock = tx.inputs[0].unlockingScript!
    expect(verifyVaultInput({ tx, inputIndex: 0, sourceSatoshis: FIXTURE_SATS, lockingScript: lock, unlockingScript: unlock })).toBe(true)
    expect(() => verifyVaultInput({ tx, inputIndex: 0, sourceSatoshis: FIXTURE_SATS + 1, lockingScript: lock, unlockingScript: unlock })).toThrow(/Script evaluation error/)
  })

  it('fullR reproduces the fixture r (r < n) and differs for a foreign Q', () => {
    const tx = Transaction.fromHex(FIXTURE_TX_HEX)
    const unlock = tx.inputs[0].unlockingScript!
    const r = fromScriptNum(unlock.chunks[0].data!)
    const s = fromScriptNum(unlock.chunks[1].data!)
    expect(r).toBe(FIXTURE_R)
    expect(s).toBe(FIXTURE_S)
    const preimage = sighashPreimage(tx, 0, FIXTURE_SATS)
    expect(fullR({ preimage, rSig: r, s, pubkeyHex33: FIXTURE_Q })).toBe(r)
    expect(r < P256_N).toBe(true)
    expect(fullR({ preimage, rSig: r, s, pubkeyHex33: newMember().pub })).not.toBe(r)
    expect(() => fullR({ preimage, rSig: r, s: 0n, pubkeyHex33: FIXTURE_Q })).toThrow(VaultError)
    expect(() => fullR({ preimage: preimage.slice(1), rSig: r, s, pubkeyHex33: FIXTURE_Q })).toThrow(VaultError)
  })
})

describe('round trips through Spend (version 2, strict flags)', () => {
  it('25 rounds: random N in 1..5, signer index, salt, sats <= 2^40, vout, 1-3 outputs, sequence, lockTime', () => {
    for (let round = 0; round < 25; round++) {
      const N = 1 + Math.floor(Math.random() * 5)
      const members = [...Array(N)].map(newMember)
      const salt = randSalt()                                    // one salt per output (spec §2.7)
      const lock = buildLock({ commitments: members.map(m => commitment(m.pub, salt)) })
      const signer = members[Math.floor(Math.random() * N)]
      const sats = Number(1n + (BigInt('0x' + randSalt()) & ((1n << 40n) - 1n)))
      const vout = Math.floor(Math.random() * 3)
      const src = fundingStub(lock, sats, vout)
      const final = Math.random() < 0.5
      const sequence = final ? 0xffffffff : (Math.random() < 0.5 ? 0xfffffffe : Math.floor(Math.random() * 0xfffffffe))
      const lockTime = final ? 0 : Math.floor(Math.random() * 800_000)
      const nOut = 1 + Math.floor(Math.random() * 3)
      const tx = new Transaction(2, [], [], lockTime)
      tx.addInput({ sourceTransaction: src, sourceOutputIndex: vout, sequence })
      tx.addOutput({ satoshis: Math.max(1, sats - 500), lockingScript: p2pkhOut() })
      if (nOut >= 2) tx.addOutput({ satoshis: 100, lockingScript: NONCE_OUT() })
      if (nOut >= 3) tx.addOutput({ satoshis: 200, lockingScript: p2pkhOut() })
      const [preimage] = screenedPreimages(tx, [{ index: 0, sats }])
      expect(hex(preimage.slice(0, 4))).toBe('02000000')
      const unlock = buildUnlock({ preimage, derSig: signDer(signer.priv, signerDigest(preimage)), pubkeyHex33: signer.pub, saltHex64: salt })
      expect(unlock.chunks).toHaveLength(71)
      expect(unlock.toBinary().length).toBeLessThanOrEqual(2539)
      expect(unlock.toBinary().length).toBeLessThanOrEqual(R1C_UNLOCK_LEN)
      expect(hex(unlock.chunks[67].data!)).toBe(salt)
      expect(hex(unlock.chunks[70].data!)).toBe(hex(preimage))
      // pushes #1/#2 are the recoded scalars for the pushed r and e
      const r = fromScriptNum(unlock.chunks[0].data!)
      const s = fromScriptNum(unlock.chunks[68].data!)
      const sInv = fromScriptNum(unlock.chunks[69].data!)
      expect((s * sInv) % P256_N).toBe(1n)
      const e = beBig(Utils.toArray(signerDigest(preimage), 'hex') as number[])
      expect(fromScriptNum(unlock.chunks[1].data!)).toBe(recode((r * sInv) % P256_N))
      expect(fromScriptNum(unlock.chunks[2].data!)).toBe(recode((e * sInv) % P256_N))
      tx.inputs[0].unlockingScript = unlock
      expect(verifyVaultInput({ tx, inputIndex: 0, sourceSatoshis: sats, lockingScript: lock, unlockingScript: unlock })).toBe(true)
    }
  })

  it('2 vault inputs (different keys, salts, locks) + 1 P2PKH input signed by tx.sign()', async () => {
    const a = newMember(), b = newMember(), c = newMember()
    const saltA = randSalt(), saltB = randSalt()
    const lockA = buildLock({ commitments: [commitment(a.pub, saltA), commitment(b.pub, saltA)] })   // N = 2, signer b
    const lockB = buildLock({ commitments: [commitment(c.pub, saltB)] })                             // N = 1, signer c
    const satsA = 40_000, satsB = 25_000, satsP = 7_000
    const srcA = fundingStub(lockA, satsA, 0)
    const srcB = fundingStub(lockB, satsB, 2)
    const p2pkhPriv = PrivateKey.fromRandom()
    const p2pkhLock = new P2PKH().lock(p2pkhPriv.toAddress())
    const srcP = fundingStub(p2pkhLock, satsP, 1)
    const tx = new Transaction(2, [], [], 0)
    tx.addInput({ sourceTransaction: srcA, sourceOutputIndex: 0, sequence: 0xffffffff })
    tx.addInput({ sourceTransaction: srcP, sourceOutputIndex: 1, sequence: 0xffffffff, unlockingScriptTemplate: new P2PKH().unlock(p2pkhPriv, 'all', false, satsP, p2pkhLock) })
    tx.addInput({ sourceTransaction: srcB, sourceOutputIndex: 2, sequence: 0xffffffff })
    tx.addOutput({ satoshis: satsA + satsB + satsP - 1000, lockingScript: p2pkhOut() })
    tx.addOutput({ satoshis: 100, lockingScript: NONCE_OUT() })
    const [preA, preB] = screenedPreimages(tx, [{ index: 0, sats: satsA }, { index: 2, sats: satsB }])
    tx.inputs[0].unlockingScript = buildUnlock({ preimage: preA, derSig: signDer(b.priv, signerDigest(preA)), pubkeyHex33: b.pub, saltHex64: saltA })
    tx.inputs[2].unlockingScript = buildUnlock({ preimage: preB, derSig: signDer(c.priv, signerDigest(preB)), pubkeyHex33: c.pub, saltHex64: saltB })
    await tx.sign()   // signs only the templated input; inputs without a template are left as set
    expect(verifyVaultInput({ tx, inputIndex: 0, sourceSatoshis: satsA, lockingScript: lockA, unlockingScript: tx.inputs[0].unlockingScript! })).toBe(true)
    expect(verifyVaultInput({ tx, inputIndex: 2, sourceSatoshis: satsB, lockingScript: lockB, unlockingScript: tx.inputs[2].unlockingScript! })).toBe(true)
    // the P2PKH input validates under the same strict flags
    const p2pkhSpend = new Spend({
      sourceTXID: srcP.id('hex'), sourceOutputIndex: 1, sourceSatoshis: satsP, lockingScript: p2pkhLock,
      transactionVersion: 2, otherInputs: [tx.inputs[0], tx.inputs[2]], outputs: tx.outputs, inputIndex: 1,
      unlockingScript: tx.inputs[1].unlockingScript!, inputSequence: 0xffffffff, lockTime: 0, verifyFlags: [...R1C_VERIFY_FLAGS]
    })
    expect(p2pkhSpend.validate()).toBe(true)
    // the two vault preimages share everything but outpoint (68..104) and amount (106..114)
    expect(hex(preA.slice(0, 68))).toBe(hex(preB.slice(0, 68)))
    expect(hex(preA.slice(114))).toBe(hex(preB.slice(114)))
    expect(hex(preA.slice(68, 104))).not.toBe(hex(preB.slice(68, 104)))
  })

  it('accepts both the low-S and the high-S form of one signature', () => {
    const m = newMember()
    const salt = randSalt()
    const lock = buildLock({ commitments: [commitment(m.pub, salt)] })
    const sats = 12_345
    const src = fundingStub(lock, sats, 0)
    const tx = new Transaction(2, [], [], 0)
    tx.addInput({ sourceTransaction: src, sourceOutputIndex: 0, sequence: 0xffffffff })
    tx.addOutput({ satoshis: 12_000, lockingScript: p2pkhOut() })
    const [preimage] = screenedPreimages(tx, [{ index: 0, sats }])
    const { r, s } = decodeDerSignature(signDer(m.priv, signerDigest(preimage)))
    const low = s <= (P256_N - 1n) / 2n ? s : P256_N - s
    const high = P256_N - low
    expect(high > (P256_N - 1n) / 2n).toBe(true)
    for (const sv of [low, high]) {
      const unlock = buildUnlock({ preimage, derSig: Array.from(new p256.Signature(r, sv).toBytes('der')), pubkeyHex33: m.pub, saltHex64: salt })
      expect(fromScriptNum(unlock.chunks[68].data!)).toBe(sv)
      expect(verifyVaultInput({ tx, inputIndex: 0, sourceSatoshis: sats, lockingScript: lock, unlockingScript: unlock })).toBe(true)
    }
  })

  it('a key whose comb table has a sub-2^247 coordinate (31-byte push) spends', () => {
    let found: Member | null = null
    for (let tries = 0; tries < 200 && found === null; tries++) {
      const m = newMember()
      if (combTable(m.pub).some(pt => pt.x < (1n << 247n) || pt.y < (1n << 247n))) found = m
    }
    if (found === null) {
      // P(a coordinate < 2^247) = 2^-9, so P(a key has at least one such coordinate among 64) =
      // 1 − (1 − 2^-9)^64 ≈ 11.8 %; 200 misses ≈ 0.882^200 ≈ 2^-36.
      console.warn('r1comb.test: no 31-byte coordinate in 200 random keys — skipping the short-coordinate round trip')
      return
    }
    const salt = randSalt()
    const lock = buildLock({ commitments: [commitment(found.pub, salt)] })
    const sats = 22_222
    const src = fundingStub(lock, sats, 1)
    const tx = new Transaction(2, [], [], 0)
    tx.addInput({ sourceTransaction: src, sourceOutputIndex: 1, sequence: 0xffffffff })
    tx.addOutput({ satoshis: 22_000, lockingScript: p2pkhOut() })
    const [preimage] = screenedPreimages(tx, [{ index: 0, sats }])
    const unlock = buildUnlock({ preimage, derSig: signDer(found.priv, signerDigest(preimage)), pubkeyHex33: found.pub, saltHex64: salt })
    expect(unlock.chunks.slice(3, 67).some(ch => ch.data!.length <= 31)).toBe(true)
    expect(verifyVaultInput({ tx, inputIndex: 0, sourceSatoshis: sats, lockingScript: lock, unlockingScript: unlock })).toBe(true)
  })

  it('constructed R.x >= n (review4-rgen port): the full x is required and accepted, x mod n is rejected', () => {
    const p = P256_P, n = P256_N, b = p256.Point.CURVE().b
    const sats = 31_337
    const tx = new Transaction(2, [], [], 0)
    tx.addInput({ sourceTXID: randSalt(), sourceOutputIndex: 2, sequence: 0xffffffff })
    tx.addOutput({ satoshis: 31_000, lockingScript: p2pkhOut() })
    const [preimage] = screenedPreimages(tx, [{ index: 0, sats }])
    const digest = signerDigest(preimage)
    const e = beBig(Utils.toArray(digest, 'hex') as number[])
    for (let round = 0; round < 2; round++) {
      // R with x in [n, n + 2^120) ⊂ [n, p): y = sqrt(x³ − 3x + b) via the p ≡ 3 (mod 4) exponent
      let x = 0n, y = 0n
      for (;;) {
        x = n + BigInt('0x' + Utils.toHex(Array.from(p256.utils.randomSecretKey()).slice(0, 15)))
        const rhs = (((x * x * x - 3n * x + b) % p) + p) % p
        y = modpowT(rhs, (p + 1n) / 4n, p)
        if ((y * y) % p === rhs) break
      }
      const R = p256.Point.fromAffine({ x, y })
      R.assertValidity()
      const rSig = x % n
      expect(rSig).toBe(x - n)
      const s = BigInt('0x' + randSalt()) % n
      const sInv = modinvT(s, n)
      const u1 = (e * sInv) % n
      const u2 = (rSig * sInv) % n
      const Q = R.subtract(p256.Point.BASE.multiply(u1)).multiply(modinvT(u2, n))   // Q = (R − u1·G)·u2⁻¹
      Q.assertValidity()
      const qHex = Q.toHex(true)
      const sig = new p256.Signature(rSig, s)
      expect(p256.verify(sig.toBytes('compact'), digestBytes(digest), Q.toBytes(true), { prehash: false, lowS: false })).toBe(true)
      expect(fullR({ preimage, rSig, s, pubkeyHex33: qHex })).toBe(x)
      const salt = randSalt()
      const lock = buildLock({ commitments: [commitment(qHex, salt)] })
      const unlock = buildUnlock({ preimage, derSig: Array.from(sig.toBytes('der')), pubkeyHex33: qHex, saltHex64: salt })
      expect(hex(unlock.chunks[0].data!)).toBe(hex(scriptNum(x)))
      expect(fromScriptNum(unlock.chunks[0].data!) >= n).toBe(true)
      expect(verifyVaultInput({ tx, inputIndex: 0, sourceSatoshis: sats, lockingScript: lock, unlockingScript: unlock })).toBe(true)
      const modN = withPush(unlock, 0, scriptNum(rSig))
      expect(() => verifyVaultInput({ tx, inputIndex: 0, sourceSatoshis: sats, lockingScript: lock, unlockingScript: modN })).toThrow(/Script evaluation error/)
    }
  })
})

describe('negatives — each must throw from verifyVaultInput (or buildUnlock where stated)', () => {
  const a = newMember(), b = newMember(), outsider = newMember()
  const salt = randSalt()
  const lock = buildLock({ commitments: [commitment(a.pub, salt), commitment(b.pub, salt)] })
  const sats = 50_000
  const src = fundingStub(lock, sats, 1)
  const verify = (tx: Transaction, unlock: UnlockingScript): true =>
    verifyVaultInput({ tx, inputIndex: 0, sourceSatoshis: sats, lockingScript: lock, unlockingScript: unlock })
  let tx: Transaction
  let preimage: number[]
  let good: UnlockingScript

  beforeAll(() => {
    tx = new Transaction(2, [], [], 0)
    tx.addInput({ sourceTransaction: src, sourceOutputIndex: 1, sequence: 0xffffffff })
    tx.addOutput({ satoshis: 49_000, lockingScript: p2pkhOut() })
    tx.addOutput({ satoshis: 100, lockingScript: NONCE_OUT() })
    ;[preimage] = screenedPreimages(tx, [{ index: 0, sats }])
    good = buildUnlock({ preimage, derSig: signDer(b.priv, signerDigest(preimage)), pubkeyHex33: b.pub, saltHex64: salt })
    expect(verify(tx, good)).toBe(true)   // positive control
  })

  it('wrong salt (fails at H5)', () => {
    const u = buildUnlock({ preimage, derSig: signDer(b.priv, signerDigest(preimage)), pubkeyHex33: b.pub, saltHex64: randSalt() })
    expect(() => verify(tx, u)).toThrow(/Script evaluation error/)
  })

  it('key not committed: outsider signs with its own table and the right salt (H5)', () => {
    const u = buildUnlock({ preimage, derSig: signDer(outsider.priv, signerDigest(preimage)), pubkeyHex33: outsider.pub, saltHex64: salt })
    expect(() => verify(tx, u)).toThrow(/Script evaluation error/)
  })

  it('one table coordinate + 1 (H5)', () => {
    const x0 = fromScriptNum(good.chunks[3].data!)
    expect(() => verify(tx, withPush(good, 3, scriptNum(x0 + 1n)))).toThrow(/Script evaluation error/)
  })

  it("signature from another key, presented as b's (tail r-check)", () => {
    const u = buildUnlock({ preimage, derSig: signDer(outsider.priv, signerDigest(preimage)), pubkeyHex33: b.pub, saltHex64: salt })
    expect(() => verify(tx, u)).toThrow(/Script evaluation error/)
  })

  it('r + 1 (H3: pushed u2\' no longer matches)', () => {
    const r = fromScriptNum(good.chunks[0].data!)
    expect(() => verify(tx, withPush(good, 0, scriptNum(r + 1n)))).toThrow(/Script evaluation error/)
  })

  it('s + 1 with a stale sInv (H1)', () => {
    const s = fromScriptNum(good.chunks[68].data!)
    expect(() => verify(tx, withPush(good, 68, scriptNum(s + 1n)))).toThrow(/Script evaluation error/)
  })

  it('a flipped preimage byte (final CHECKSIG)', () => {
    const p = [...preimage]
    p[120] ^= 1
    expect(() => verify(tx, withPush(good, 70, p))).toThrow(/Script evaluation error/)
  })

  it('preimage of another input: same lock, same key, same salt on both inputs — only OP_PUSH_TX can reject', () => {
    const src2 = fundingStub(lock, sats + 7, 0)
    const tx2 = new Transaction(2, [], [], 0)
    tx2.addInput({ sourceTransaction: src, sourceOutputIndex: 1, sequence: 0xffffffff })
    tx2.addInput({ sourceTransaction: src2, sourceOutputIndex: 0, sequence: 0xffffffff })
    tx2.addOutput({ satoshis: 2 * sats - 1000, lockingScript: p2pkhOut() })
    const [p0, p1] = screenedPreimages(tx2, [{ index: 0, sats }, { index: 1, sats: sats + 7 }])
    const u0 = buildUnlock({ preimage: p0, derSig: signDer(a.priv, signerDigest(p0)), pubkeyHex33: a.pub, saltHex64: salt })
    const u1 = buildUnlock({ preimage: p1, derSig: signDer(a.priv, signerDigest(p1)), pubkeyHex33: a.pub, saltHex64: salt })
    expect(verifyVaultInput({ tx: tx2, inputIndex: 0, sourceSatoshis: sats, lockingScript: lock, unlockingScript: u0 })).toBe(true)
    expect(verifyVaultInput({ tx: tx2, inputIndex: 1, sourceSatoshis: sats + 7, lockingScript: lock, unlockingScript: u1 })).toBe(true)
    expect(() => verifyVaultInput({ tx: tx2, inputIndex: 0, sourceSatoshis: sats, lockingScript: lock, unlockingScript: u1 })).toThrow(/Script evaluation error/)
    expect(() => verifyVaultInput({ tx: tx2, inputIndex: 1, sourceSatoshis: sats + 7, lockingScript: lock, unlockingScript: u0 })).toThrow(/Script evaluation error/)
  })

  it('version-1 transaction: buildUnlock refuses with template-invalid and a message naming the version', () => {
    const v1 = new Transaction(1, [], [], 0)
    v1.addInput({ sourceTransaction: src, sourceOutputIndex: 1, sequence: 0xffffffff })
    v1.addOutput({ satoshis: 49_000, lockingScript: p2pkhOut() })
    const p = sighashPreimage(v1, 0, sats)
    expect(hex(p.slice(0, 4))).toBe('01000000')
    let err: unknown
    try { buildUnlock({ preimage: p, derSig: signDer(b.priv, signerDigest(p)), pubkeyHex33: b.pub, saltHex64: salt }) } catch (e) { err = e }
    expect(err).toBeInstanceOf(VaultError)
    expect((err as VaultError).code).toBe('template-invalid')
    expect((err as VaultError).message).toMatch(/version/)
  })

  it('buildUnlock rejects a short preimage, a bad salt, a bad key and garbage DER with template-invalid', () => {
    const der = signDer(b.priv, signerDigest(preimage))
    for (const bad of [
      () => buildUnlock({ preimage: preimage.slice(1), derSig: der, pubkeyHex33: b.pub, saltHex64: salt }),
      () => buildUnlock({ preimage, derSig: der, pubkeyHex33: b.pub, saltHex64: salt.slice(2) }),
      () => buildUnlock({ preimage, derSig: der, pubkeyHex33: '02' + 'ff'.repeat(32), saltHex64: salt }),
      () => buildUnlock({ preimage, derSig: der.slice(1), pubkeyHex33: b.pub, saltHex64: salt })
    ]) {
      expect(bad).toThrow(VaultError)
      try { bad() } catch (e) { expect((e as VaultError).code).toBe('template-invalid') }
    }
  })

  it('verifyVaultInput rejects a missing input with template-invalid', () => {
    expect(() => verifyVaultInput({ tx, inputIndex: 3, sourceSatoshis: sats, lockingScript: lock, unlockingScript: good })).toThrow(VaultError)
  })
})

describe('customInstructions v4 codec', () => {
  const keys5 = [...Array(5)].map(() => newMember().pub)
  const salt = randSalt()

  it.each([1, 2, 3, 4, 5])('round-trips %i keys in order and writes the canonical field order', n => {
    const rec: VaultInstructionsV4 = { v: 4, type: 'R1C', salt, keys: keys5.slice(0, n) }
    const s = encodeVaultInstructions(rec)
    expect(s).toBe(JSON.stringify({ v: 4, type: 'R1C', salt, keys: keys5.slice(0, n) }))
    expect(s.length).toBeLessThan(4096)
    expect(decodeVaultInstructions(s)).toEqual(rec)
  })

  it('ignores extra fields and accepts a re-ordered object', () => {
    const s = JSON.stringify({ keys: [keys5[0]], extra: 1, type: 'R1C', salt, v: 4 })
    expect(decodeVaultInstructions(s)).toEqual({ v: 4, type: 'R1C', salt, keys: [keys5[0]] })
  })

  it.each<[string, string | undefined]>([
    ['undefined', undefined],
    ['empty', ''],
    ['not JSON', 'not json'],
    ['{}', '{}'],
    ['[]', '[]'],
    ['null', 'null'],
    ['a string', JSON.stringify('R1C')],
    ['v3 K1 record', JSON.stringify({ v: 3, type: 'K1', keyID: 'bip32/7' })],
    ['v2 R1K1 record', JSON.stringify({ v: 2, type: 'R1K1', keyID: 'bip32/7', salt: 'aa', r1PublicKey: 'bb', slot: 130 })],
    ['v4 with type K1', JSON.stringify({ v: 4, type: 'K1', salt, keys: [keys5[0]] })],
    ['v 5', JSON.stringify({ v: 5, type: 'R1C', salt, keys: [keys5[0]] })],
    ['v as string', JSON.stringify({ v: '4', type: 'R1C', salt, keys: [keys5[0]] })],
    ['missing salt', JSON.stringify({ v: 4, type: 'R1C', keys: [keys5[0]] })],
    ['salt 62 hex', JSON.stringify({ v: 4, type: 'R1C', salt: salt.slice(2), keys: [keys5[0]] })],
    ['salt 66 hex', JSON.stringify({ v: 4, type: 'R1C', salt: salt + '00', keys: [keys5[0]] })],
    ['salt not hex', JSON.stringify({ v: 4, type: 'R1C', salt: 'zz'.repeat(32), keys: [keys5[0]] })],
    ['salt uppercase', JSON.stringify({ v: 4, type: 'R1C', salt: salt.toUpperCase(), keys: [keys5[0]] })],
    ['0 keys', JSON.stringify({ v: 4, type: 'R1C', salt, keys: [] })],
    ['6 keys', JSON.stringify({ v: 4, type: 'R1C', salt, keys: [...keys5, newMember().pub] })],
    ['keys not an array', JSON.stringify({ v: 4, type: 'R1C', salt, keys: keys5[0] })],
    ['key uppercase', JSON.stringify({ v: 4, type: 'R1C', salt, keys: [keys5[0].toUpperCase()] })],
    ['key uncompressed (65 B)', JSON.stringify({ v: 4, type: 'R1C', salt, keys: [Utils.toHex(Array.from(p256.getPublicKey(p256.utils.randomSecretKey(), false)))] })],
    ['key off-curve', JSON.stringify({ v: 4, type: 'R1C', salt, keys: ['02' + 'ff'.repeat(32)] })],
    ['key wrong prefix', JSON.stringify({ v: 4, type: 'R1C', salt, keys: ['05' + keys5[0].slice(2)] })],
    ['key too short', JSON.stringify({ v: 4, type: 'R1C', salt, keys: [keys5[0].slice(0, 64)] })],
    ['duplicate keys', JSON.stringify({ v: 4, type: 'R1C', salt, keys: [keys5[0], keys5[0]] })],
    ['non-string key', JSON.stringify({ v: 4, type: 'R1C', salt, keys: [1] })],
    ['over 4096 chars', JSON.stringify({ v: 4, type: 'R1C', salt, keys: [keys5[0]], pad: 'x'.repeat(4100) })]
  ])('fails closed on %s', (_name, ci) => {
    expect(decodeVaultInstructions(ci)).toBeNull()
  })

  it('encode refuses what decode would refuse', () => {
    for (const bad of [
      { v: 4, type: 'R1C', salt, keys: [] },
      { v: 4, type: 'R1C', salt, keys: [...keys5, newMember().pub] },
      { v: 4, type: 'R1C', salt: salt.toUpperCase(), keys: [keys5[0]] },
      { v: 4, type: 'R1C', salt, keys: [keys5[0].toUpperCase()] },
      { v: 4, type: 'R1C', salt: 'ab', keys: [keys5[0]] },
      { v: 4, type: 'R1C', salt, keys: [keys5[0], keys5[0]] }
    ] as VaultInstructionsV4[]) {
      expect(() => encodeVaultInstructions(bad)).toThrow(VaultError)
      try { encodeVaultInstructions(bad) } catch (e) { expect((e as VaultError).code).toBe('template-invalid') }
    }
  })
})
