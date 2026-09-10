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
import { BigNumber, Curve, Hash, LockingScript, Utils } from '@bsv/sdk'
import { p256 } from '@noble/curves/nist.js'
import {
  COMB_COLS, COMB_ROWS, COORD_WIDTH, SALT_BYTES, TABLE_SIZE, R1C_LOCK_LEN, R1C_MAX_KEYS, R1C_UNLOCK_LEN,
  P256_N, P256_P, SECP_GX, SECP_N, RECODE_CONST,
  asm, encNum, pushData, scriptNum,
  compressPubkey, combTable, combTableScalar, gTable, le33, canonicalTableBytes, commitment
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
