import { Hash, PrivateKey, Utils } from '@bsv/sdk'
import sigil from '@urbit/sigil-js/core'
import {
  FROM_ADDRESS_LABEL_PREFIX,
  PUBKEY_LABEL,
  SENTINEL_SENDER_KEY,
  TO_ADDRESS_LABEL_PREFIX,
  abbreviateKey,
  addressLabel,
  counterpartyBytes,
  counterpartyHue,
  counterpartyOf,
  counterpartySeed,
  sigilPointOf,
  type Counterparty
} from '../../core/pay/counterparty'
import { patp, u32FromHexTail } from '../../core/pay/patp'

const PAYEE_KEY = '02' + 'ab'.repeat(32)
const SENDER_KEY = '03' + 'cd'.repeat(32)
const TXID = 'f0'.repeat(28) + 'deadbeef'
const ADDRESS = new PrivateKey(42).toPublicKey().toAddress()
const TESTNET_ADDRESS = new PrivateKey(42).toPublicKey().toAddress('testnet')
const TO_LABEL = addressLabel(TO_ADDRESS_LABEL_PREFIX, ADDRESS)
const FROM_LABEL = addressLabel(FROM_ADDRESS_LABEL_PREFIX, ADDRESS)

/**
 * What a label looks like once it has been through the wallet: @bsv/sdk's
 * validateLabel folds every label to lower case before storage, and that is
 * the spelling listActions hands back.
 */
const stored = (label: string) => label.trim().toLowerCase()

describe('constants', () => {
  it('PUBKEY_LABEL accepts compressed pubkeys only', () => {
    expect(PUBKEY_LABEL.test(PAYEE_KEY)).toBe(true)
    expect(PUBKEY_LABEL.test(SENDER_KEY)).toBe(true)
    expect(PUBKEY_LABEL.test('02' + 'AB'.repeat(32))).toBe(true)
    expect(PUBKEY_LABEL.test('04' + 'ab'.repeat(32))).toBe(false)
    expect(PUBKEY_LABEL.test('02' + 'ab'.repeat(31))).toBe(false)
    expect(PUBKEY_LABEL.test('peerpay')).toBe(false)
  })

  it('SENTINEL_SENDER_KEY is the public key of private key 1', () => {
    expect(SENTINEL_SENDER_KEY).toBe(new PrivateKey(1).toPublicKey().toString())
  })

  it('label prefixes are the ones the address rail writes', () => {
    expect(TO_ADDRESS_LABEL_PREFIX).toBe('to:')
    expect(FROM_ADDRESS_LABEL_PREFIX).toBe('from:')
  })
})

describe('addressLabel', () => {
  it('encodes the version byte and hash160 as lower-case hex after the prefix', () => {
    const { prefix, data } = Utils.fromBase58Check(ADDRESS)
    const payload = Utils.toHex([...(prefix as number[]), ...(data as number[])])
    expect(payload).toHaveLength(42)
    expect(TO_LABEL).toBe('to:' + payload)
    expect(FROM_LABEL).toBe('from:' + payload)
  })

  it('survives the wallet case-folding labels before storage', () => {
    expect(stored(TO_LABEL)).toBe(TO_LABEL)
    expect(stored(FROM_LABEL)).toBe(FROM_LABEL)
    // The base58 spelling itself would not: folding it is lossy.
    expect(stored(ADDRESS)).not.toBe(ADDRESS)
  })

  it('keeps mainnet and testnet spellings of one key apart', () => {
    expect(addressLabel(TO_ADDRESS_LABEL_PREFIX, TESTNET_ADDRESS)).not.toBe(TO_LABEL)
  })

  it('rejects a string that is not a base58check address', () => {
    expect(() => addressLabel(TO_ADDRESS_LABEL_PREFIX, 'not-an-address')).toThrow()
  })
})

describe('counterpartyOf', () => {
  it('prefers a pubkey label (outbound peer payment)', () => {
    expect(
      counterpartyOf({
        labels: ['peerpay', PAYEE_KEY, TO_LABEL],
        senderIdentityKey: SENDER_KEY,
        txid: TXID
      })
    ).toEqual({ kind: 'identityKey', value: PAYEE_KEY })
  })

  it('uses senderIdentityKey when no label is a pubkey (inbound peer payment)', () => {
    expect(counterpartyOf({ labels: ['peerpay'], senderIdentityKey: SENDER_KEY, txid: TXID })).toEqual({
      kind: 'identityKey',
      value: SENDER_KEY
    })
  })

  it('ignores the address-sweep sentinel sender and falls through to the txid', () => {
    expect(counterpartyOf({ labels: ['sweep'], senderIdentityKey: SENTINEL_SENDER_KEY, txid: TXID })).toEqual({
      kind: 'txid',
      value: TXID
    })
  })

  it('reads a stored to: label back as the base58 address (outbound address send)', () => {
    expect(counterpartyOf({ labels: ['address', stored(TO_LABEL)], senderIdentityKey: null, txid: TXID })).toEqual({
      kind: 'address',
      value: ADDRESS
    })
  })

  it('reads a stored from: label back as the base58 address (inbound address sweep)', () => {
    expect(
      counterpartyOf({ labels: [stored(FROM_LABEL)], senderIdentityKey: SENTINEL_SENDER_KEY, txid: TXID })
    ).toEqual({ kind: 'address', value: ADDRESS })
  })

  it('restores the network the address was written for', () => {
    const label = stored(addressLabel(FROM_ADDRESS_LABEL_PREFIX, TESTNET_ADDRESS))
    expect(counterpartyOf({ labels: [label] })).toEqual({ kind: 'address', value: TESTNET_ADDRESS })
  })

  it('passes an undecodable address payload through verbatim', () => {
    // A label from a source this package does not control still identifies
    // something; the seed falls back to hashing the string.
    expect(counterpartyOf({ labels: ['to:other'] })).toEqual({ kind: 'address', value: 'other' })
  })

  it('takes the first address label when several are present', () => {
    expect(counterpartyOf({ labels: [TO_LABEL, 'from:other'] })?.value).toBe(ADDRESS)
  })

  it('skips an address label with nothing after the prefix', () => {
    expect(counterpartyOf({ labels: ['to:'], txid: TXID })).toEqual({ kind: 'txid', value: TXID })
  })

  it('falls back to the txid when only that is known', () => {
    expect(counterpartyOf({ labels: ['something'], txid: TXID })).toEqual({ kind: 'txid', value: TXID })
    expect(counterpartyOf({ txid: TXID })).toEqual({ kind: 'txid', value: TXID })
  })

  it('returns null when nothing identifies the counterparty', () => {
    expect(counterpartyOf({})).toBeNull()
    expect(counterpartyOf({ labels: [], senderIdentityKey: null, txid: '' })).toBeNull()
    expect(counterpartyOf({ labels: ['peerpay'], senderIdentityKey: '' })).toBeNull()
  })
})

describe('abbreviateKey', () => {
  it('keeps the first eight and last four characters of a 66-hex key', () => {
    const key = '02abcdef' + '11'.repeat(27) + 'beef'
    expect(key).toHaveLength(66)
    expect(abbreviateKey(key)).toBe('02abcdef…beef')
  })

  it('abbreviates a 34-character address the same way', () => {
    expect(ADDRESS).toHaveLength(34)
    expect(abbreviateKey(ADDRESS)).toBe(ADDRESS.slice(0, 8) + '…' + ADDRESS.slice(-4))
  })

  it('leaves short strings unchanged', () => {
    expect(abbreviateKey('')).toBe('')
    expect(abbreviateKey('peerpay')).toBe('peerpay')
    expect(abbreviateKey('a'.repeat(13))).toBe('a'.repeat(13))
    expect(abbreviateKey('a'.repeat(14))).toBe('a'.repeat(8) + '…' + 'aaaa')
  })
})

describe('counterpartySeed', () => {
  it('uses the last four bytes of an identity key', () => {
    const key = '02' + '00'.repeat(28) + 'deadbeef'
    expect(counterpartySeed({ kind: 'identityKey', value: key })).toBe(0xdeadbeef)
    expect(counterpartySeed({ kind: 'identityKey', value: PAYEE_KEY })).toBe(u32FromHexTail(PAYEE_KEY))
  })

  it('uses the last four bytes of a txid', () => {
    expect(counterpartySeed({ kind: 'txid', value: TXID })).toBe(0xdeadbeef)
  })

  it('uses the last four bytes of the hash160 behind an address', () => {
    const hash160 = Utils.fromBase58Check(ADDRESS).data as number[]
    expect(hash160).toHaveLength(20)
    const [b0, b1, b2, b3] = hash160.slice(16)
    const expected = ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0
    expect(counterpartySeed({ kind: 'address', value: ADDRESS })).toBe(expected)
    // The same bytes are what PublicKey.toHash() yields, so the seed is a
    // property of the key, not of the base58 spelling.
    const viaKey = new PrivateKey(42).toPublicKey().toHash() as number[]
    expect(viaKey.slice(16)).toEqual(hash160.slice(16))
    // Which is why the two networks' spellings of one key share a face.
    expect(counterpartySeed({ kind: 'address', value: TESTNET_ADDRESS })).toBe(expected)
  })

  it('reaches the hash160 from a label the wallet has case-folded', () => {
    const cp = counterpartyOf({ labels: [stored(TO_LABEL)] })
    expect(cp).not.toBeNull()
    const hash160 = Utils.fromBase58Check(ADDRESS).data as number[]
    const [b0, b1, b2, b3] = hash160.slice(16)
    expect(counterpartySeed(cp as Counterparty)).toBe(((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0)
  })

  it('is deterministic and never throws on a malformed value', () => {
    const bad: Counterparty = { kind: 'address', value: 'not-an-address' }
    expect(() => counterpartySeed(bad)).not.toThrow()
    expect(counterpartySeed(bad)).toBe(counterpartySeed(bad))
    const badKey: Counterparty = { kind: 'identityKey', value: 'zz' }
    expect(() => counterpartySeed(badKey)).not.toThrow()
    expect(counterpartySeed(badKey)).not.toBe(counterpartySeed(bad))
  })
})

describe('counterpartyBytes', () => {
  it('is the 33 bytes of a compressed identity key', () => {
    expect(counterpartyBytes({ kind: 'identityKey', value: PAYEE_KEY })).toEqual(Utils.toArray(PAYEE_KEY, 'hex'))
    expect(counterpartyBytes({ kind: 'identityKey', value: PAYEE_KEY })).toHaveLength(33)
  })

  it('is the version byte plus hash160 of an address (21 bytes)', () => {
    const { prefix, data } = Utils.fromBase58Check(ADDRESS)
    const bytes = counterpartyBytes({ kind: 'address', value: ADDRESS })
    expect(bytes).toHaveLength(21)
    expect(bytes).toEqual([...(prefix as number[]), ...(data as number[])])
    // The network lives in the version byte, so the two spellings of one key
    // share their last 20 bytes and differ only in the first.
    const testnet = counterpartyBytes({ kind: 'address', value: TESTNET_ADDRESS })
    expect(testnet.slice(1)).toEqual(bytes.slice(1))
    expect(testnet[0]).not.toBe(bytes[0])
  })

  it('is the 32 bytes of a txid', () => {
    expect(counterpartyBytes({ kind: 'txid', value: TXID })).toEqual(Utils.toArray(TXID, 'hex'))
    expect(counterpartyBytes({ kind: 'txid', value: TXID })).toHaveLength(32)
  })

  it('falls back to sha256 of the utf8 string for anything that will not parse', () => {
    const cases: Counterparty[] = [
      { kind: 'address', value: 'not-an-address' },
      { kind: 'identityKey', value: 'zz' },
      { kind: 'txid', value: 'abc' },
      { kind: 'identityKey', value: '' }
    ]
    for (const cp of cases) {
      expect(() => counterpartyBytes(cp)).not.toThrow()
      expect(counterpartyBytes(cp)).toHaveLength(32)
      expect(counterpartyBytes(cp)).toEqual(Hash.sha256(Utils.toArray(cp.value, 'utf8')))
    }
  })
})

describe('counterpartyHue', () => {
  // Bytes [-8,-4) carry the hue, the last four the shape seed, so keys are
  // built with both windows spelled out.
  const key = (hueBytes: string, seedBytes: string) => '02' + '00'.repeat(24) + hueBytes + seedBytes

  it('is the u32 of the four bytes before the seed, modulo 360', () => {
    expect(counterpartyHue({ kind: 'identityKey', value: key('00000001', 'deadbeef') })).toBe(1)
    expect(counterpartyHue({ kind: 'identityKey', value: key('00000168', 'deadbeef') })).toBe(0) // 0x168 = 360
    expect(counterpartyHue({ kind: 'identityKey', value: key('ffffffff', 'deadbeef') })).toBe(0xffffffff % 360)
    expect(counterpartyHue({ kind: 'txid', value: 'f0'.repeat(24) + '00000059' + 'deadbeef' })).toBe(89)
  })

  it('varies independently of the shape seed', () => {
    const a: Counterparty = { kind: 'identityKey', value: key('00000001', 'deadbeef') }
    const b: Counterparty = { kind: 'identityKey', value: key('00000002', 'deadbeef') }
    const c: Counterparty = { kind: 'identityKey', value: key('00000001', 'cafebabe') }
    // Same face, different colour.
    expect(counterpartySeed(a)).toBe(counterpartySeed(b))
    expect(counterpartyHue(a)).not.toBe(counterpartyHue(b))
    // Same colour, different face.
    expect(counterpartyHue(a)).toBe(counterpartyHue(c))
    expect(counterpartySeed(a)).not.toBe(counterpartySeed(c))
  })

  it('reads the hash160 behind an address so both networks share a colour', () => {
    const hash160 = Utils.fromBase58Check(ADDRESS).data as number[]
    const [b0, b1, b2, b3] = hash160.slice(12, 16)
    const expected = (((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0) % 360
    expect(counterpartyHue({ kind: 'address', value: ADDRESS })).toBe(expected)
    expect(counterpartyHue({ kind: 'address', value: TESTNET_ADDRESS })).toBe(expected)
  })

  it('always lands on an integer in [0, 359] and never throws', () => {
    const cases: Counterparty[] = [
      { kind: 'identityKey', value: PAYEE_KEY },
      { kind: 'identityKey', value: SENDER_KEY },
      { kind: 'address', value: ADDRESS },
      { kind: 'txid', value: TXID },
      { kind: 'address', value: 'not-an-address' },
      { kind: 'identityKey', value: 'zz' },
      // Valid hex but too short to hold both windows: hashed instead.
      { kind: 'identityKey', value: 'deadbeef' },
      { kind: 'txid', value: 'ab' }
    ]
    for (const cp of cases) {
      let hue = -1
      expect(() => {
        hue = counterpartyHue(cp)
      }).not.toThrow()
      expect(Number.isInteger(hue)).toBe(true)
      expect(hue).toBeGreaterThanOrEqual(0)
      expect(hue).toBeLessThanOrEqual(359)
      expect(counterpartyHue(cp)).toBe(hue)
    }
  })

  it('hashes the bytes when there are fewer than eight of them', () => {
    const short: Counterparty = { kind: 'identityKey', value: 'deadbeef' }
    const bytes = counterpartyBytes(short)
    expect(bytes).toHaveLength(4)
    const digest = Hash.sha256(bytes)
    const [b0, b1, b2, b3] = digest.slice(24, 28)
    expect(counterpartyHue(short)).toBe((((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0) % 360)
    // The seed still reads the raw tail: four bytes is enough for it.
    expect(counterpartySeed(short)).toBe(0xdeadbeef)
  })
})

describe('sigilPointOf', () => {
  const cases: Counterparty[] = [
    { kind: 'identityKey', value: PAYEE_KEY },
    { kind: 'identityKey', value: SENDER_KEY },
    { kind: 'address', value: ADDRESS },
    { kind: 'txid', value: TXID },
    { kind: 'identityKey', value: '02' + '00'.repeat(32) },
    { kind: 'identityKey', value: '02' + '00'.repeat(31) + '00ff' },
    // A star-class seed (256..65535) exercises patp's two-syllable branch.
    { kind: 'identityKey', value: '02' + '00'.repeat(30) + 'abab' }
  ]

  it('is the @p of the counterparty seed', () => {
    for (const cp of cases) {
      expect(sigilPointOf(cp)).toBe(patp(counterpartySeed(cp)))
    }
  })

  it('always names a point that sigil-js can render', () => {
    for (const cp of cases) {
      const point = sigilPointOf(cp)
      let xml = ''
      expect(() => {
        xml = sigil({ point, size: 32, foreground: '#000000', background: '#ffffff', detail: 'none', space: 'default' })
      }).not.toThrow()
      expect(xml).toContain('<svg')
    }
  })
})
