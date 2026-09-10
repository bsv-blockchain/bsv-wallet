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
import { BigNumber, Curve, Hash, LockingScript, Script, Utils } from '@bsv/sdk'
import { p256 } from '@noble/curves/nist.js'
import {
  COMB_COLS, COMB_ROWS, COORD_WIDTH, SALT_BYTES, TABLE_SIZE, R1C_LOCK_LEN, R1C_MAX_KEYS, R1C_UNLOCK_LEN,
  P256_N, P256_P, SECP_GX, SECP_N, RECODE_CONST,
  asm, encNum, pushData, scriptNum,
  compressPubkey, combTable, combTableScalar, gTable, le33, canonicalTableBytes, commitment,
  buildLock, bakedCommitments, recode, sharedSuffix, shiftFor
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
