import { estimatePartCharLength } from '@bsv/air-gap'
import {
  encodeFrame,
  decodeFrame,
  frameToQr,
  sealedToQr,
  frameBytesFromQr,
  sealFrame,
  unsealFrame,
  CodecError,
  FRAME_BLOCK_BYTES,
  FRAME_VERSION,
  FRAME_QR_PREFIX,
  SEAL_VERSION,
  type PaymentFrame
} from '../../core/localpay/codec'
import type { TokenPayment } from '../../core/localpay/codec'

const sample = (): PaymentFrame => ({
  version: FRAME_VERSION,
  kind: 'bsv' as const,
  senderIdentityKey: '02'.padEnd(66, 'a'),
  outputIndex: 0,
  derivationPrefix: 'cHJlZml4',
  derivationSuffix: 'c3VmZml4',
  transaction: new Uint8Array([1, 2, 3, 4, 5])
})

const psk = new Uint8Array(32).fill(7)

describe('localpay codec', () => {
  it('round-trips a frame', () => {
    const f = sample()
    expect(decodeFrame(encodeFrame(f))).toEqual(f)
  })

  it('round-trips a large transaction', () => {
    const f = { ...sample(), transaction: new Uint8Array(50_000).fill(7) }
    const decoded = decodeFrame(encodeFrame(f))
    expect(decoded.transaction.length).toBe(50_000)
    expect(decoded.transaction[0]).toBe(7)
    expect(decoded.transaction[49_999]).toBe(7)
    expect(Array.from(decoded.transaction).every(b => b === 7)).toBe(true)
  })

  it('carries no amount field: the transaction is the only source of the figure', () => {
    const decoded = decodeFrame(encodeFrame(sample())) as unknown as Record<string, unknown>
    expect('amount' in decoded).toBe(false)
  })

  it('rejects a v1 frame, whose layout put an amount after the identity key', () => {
    const v1 = encodeFrame(sample())
    v1[0] = 1
    expect(() => decodeFrame(v1)).toThrow('unsupported frame version 1')
  })

  it('is version 6', () => {
    expect(FRAME_VERSION).toBe(6)
    expect(encodeFrame(sample())[0]).toBe(6)
  })

  it('round-trips an optional note', () => {
    const f = { ...sample(), note: 'lunch split' }
    expect(decodeFrame(encodeFrame(f))).toEqual(f)
  })

  it('omits the note key entirely when no note was set', () => {
    const decoded = decodeFrame(encodeFrame(sample())) as unknown as Record<string, unknown>
    expect('note' in decoded).toBe(false)
  })

  it('treats an explicit empty-string note the same as no note at all', () => {
    const decoded = decodeFrame(encodeFrame({ ...sample(), note: '' })) as unknown as Record<string, unknown>
    expect('note' in decoded).toBe(false)
  })

  it('round-trips a note alongside a token frame', () => {
    const f = { ...tokenSample(), note: 'thanks!' }
    expect(decodeFrame(encodeFrame(f))).toEqual(f)
  })

  it('rejects truncated input', () => {
    const b = encodeFrame(sample())
    expect(() => decodeFrame(b.slice(0, b.length - 3))).toThrow(CodecError)
  })

  it('rejects an unknown version', () => {
    const b = encodeFrame(sample())
    b[0] = 99
    expect(() => decodeFrame(b)).toThrow(CodecError)
  })

  it('rejects trailing garbage', () => {
    const b = encodeFrame(sample())
    expect(() => decodeFrame(new Uint8Array([...b, 0, 0]))).toThrow(CodecError)
  })

  it('rejects a wrong-length identity key', () => {
    expect(() => encodeFrame({ ...sample(), senderIdentityKey: 'abcd' })).toThrow(CodecError)
  })

  it('normalizes uppercase identity key to lowercase', () => {
    const f = { ...sample(), senderIdentityKey: '02'.padEnd(66, 'A') }
    const decoded = decodeFrame(encodeFrame(f))
    expect(decoded.senderIdentityKey).toBe('02'.padEnd(66, 'a'))
  })
})

describe('localpay frame envelope', () => {
  // `bsvpayf1:` is no longer a QR wire format — every payment code is an
  // air-gap fountain (see localpayAirGap.test.ts). It survives as the envelope
  // stored in offline_actions.framePayload and re-read to re-show a code, so
  // what these pin is that a stored string decodes back to the exact bytes,
  // and that a corrupt or foreign one fails as a CodecError rather than
  // crashing the screen that renders it.

  it('round-trips a frame through the stored envelope', () => {
    const f = sample()
    expect(unsealFrame(frameBytesFromQr(frameToQr(f, psk)), psk)).toEqual(f)
  })

  it('round-trips a realistic single-input AtomicBEEF frame', () => {
    // 1,200 bytes of pseudo-random payload: base64 of incompressible bytes is
    // the worst case for length, and this is the size band payments sit in.
    const transaction = new Uint8Array(1200)
    for (let i = 0; i < transaction.length; i++) transaction[i] = (i * 37 + 11) & 0xff
    const f = { ...sample(), transaction }
    expect(unsealFrame(frameBytesFromQr(frameToQr(f, psk)), psk)).toEqual(f)
  })

  // `sealedToQr` exists so a caller that must seal once to size-check the
  // bytes (the QR-size sanity check) can wrap those same bytes instead of
  // calling `sealFrame` a second time. It must produce the same envelope
  // shape as `frameToQr` — prefix plus base64url of the sealed bytes — and
  // round-trip through `frameBytesFromQr`/`unsealFrame` back to the frame.
  it('sealedToQr wraps already-sealed bytes into the same envelope shape as frameToQr', () => {
    const f = sample()
    const sealed = sealFrame(f, psk)
    const qr = sealedToQr(sealed)
    expect(qr.startsWith(FRAME_QR_PREFIX)).toBe(true)
    expect(frameBytesFromQr(qr)).toEqual(sealed)
    expect(unsealFrame(frameBytesFromQr(qr), psk)).toEqual(f)
  })

  it('prefixes the payload so it cannot be confused with a session QR', () => {
    expect(frameToQr(sample(), psk).startsWith(FRAME_QR_PREFIX)).toBe(true)
    expect(FRAME_QR_PREFIX.startsWith('bsvpay1:')).toBe(false)
  })

  it('emits only single-byte ASCII, so characters and QR bytes agree', () => {
    const qr = frameToQr({ ...sample(), transaction: new Uint8Array(900).fill(0xff) }, psk)
    expect(/^[\x21-\x7e]+$/.test(qr)).toBe(true)
    expect(new TextEncoder().encode(qr).length).toBe(qr.length)
  })

  it('sizes source blocks below the version-40 / EC-M capacity', () => {
    // 2,331 bytes is the hard ceiling for the symbol the renderer asks for.
    expect(estimatePartCharLength(FRAME_BLOCK_BYTES)).toBeLessThan(2331)
  })

  it('rejects a session QR', () => {
    expect(() => frameBytesFromQr('bsvpay1:AAAA')).toThrow(CodecError)
  })

  it('rejects an unprefixed payload', () => {
    expect(() => frameBytesFromQr('https://example.com')).toThrow(CodecError)
  })

  it('rejects malformed base64url behind a valid prefix', () => {
    expect(() => frameBytesFromQr(`${FRAME_QR_PREFIX}!!!!not base64!!!!`)).toThrow(CodecError)
  })

  it('rejects a truncated payload behind a valid prefix', () => {
    const qr = frameToQr(sample(), psk)
    expect(() => unsealFrame(frameBytesFromQr(qr.slice(0, qr.length - 8)), psk)).toThrow(CodecError)
  })

  it('rejects an empty payload behind a valid prefix', () => {
    expect(() => unsealFrame(frameBytesFromQr(FRAME_QR_PREFIX), psk)).toThrow(CodecError)
  })

  it('rejects non-string input, which a corrupt storage row can be', () => {
    expect(() => frameBytesFromQr(null as never)).toThrow(CodecError)
    expect(() => frameBytesFromQr(undefined as never)).toThrow(CodecError)
    expect(() => frameBytesFromQr({ toString: () => `${FRAME_QR_PREFIX}AAAA` } as never)).toThrow(CodecError)
  })

  it('never throws a non-CodecError for any single-character corruption', () => {
    const qr = frameToQr(sample(), psk)
    for (let i = FRAME_QR_PREFIX.length; i < qr.length; i += 7) {
      const corrupted = qr.slice(0, i) + (qr[i] === 'A' ? 'B' : 'A') + qr.slice(i + 1)
      try {
        unsealFrame(frameBytesFromQr(corrupted), psk)
      } catch (e) {
        expect(e).toBeInstanceOf(CodecError)
      }
    }
  })

  it('frameBytesFromQr returns the exact sealed bytes: SEAL_VERSION prefix, unseals to the frame', () => {
    const f = sample()
    const qr = frameToQr(f, psk)
    const bytes = frameBytesFromQr(qr)
    expect(bytes[0]).toBe(SEAL_VERSION)
    expect(bytes.length).toBe(1 + 32 + encodeFrame(f).length + 16)
    expect(unsealFrame(bytes, psk)).toEqual(f)
    expect(() => frameBytesFromQr('bsvpay1:xx')).toThrow()
  })
})

describe('sealed envelope', () => {
  const psk = new Uint8Array(32).fill(7)

  it('round-trips a frame under the session PSK', () => {
    const f = sample()
    expect(unsealFrame(sealFrame(f, psk), psk)).toEqual(f)
  })

  it('starts with SEAL_VERSION and is ciphertext, not a readable frame', () => {
    const sealed = sealFrame(sample(), psk)
    expect(sealed[0]).toBe(SEAL_VERSION)
    // 1 version byte + 32B IV + ciphertext + 16B tag
    expect(sealed.length).toBe(1 + 32 + encodeFrame(sample()).length + 16)
    expect(() => decodeFrame(sealed)).toThrow(CodecError) // reads version 1 → unsupported
  })

  it('refuses the wrong PSK as a CodecError, not a platform error', () => {
    const other = new Uint8Array(32).fill(8)
    expect(() => unsealFrame(sealFrame(sample(), psk), other)).toThrow(CodecError)
  })

  it('refuses a tampered body', () => {
    const sealed = sealFrame(sample(), psk)
    sealed[40] ^= 0xff
    expect(() => unsealFrame(sealed, psk)).toThrow(CodecError)
  })

  it('refuses an unknown seal version', () => {
    const sealed = sealFrame(sample(), psk)
    sealed[0] = 2
    expect(() => unsealFrame(sealed, psk)).toThrow(/unsupported seal version 2/)
  })

  it('refuses a PSK that is not 32 bytes', () => {
    expect(() => sealFrame(sample(), new Uint8Array(16))).toThrow(CodecError)
    expect(() => unsealFrame(sealFrame(sample(), psk), new Uint8Array(16))).toThrow(CodecError)
  })
})

const ASSET = 'ab'.repeat(32) + '_0'
const ATTESTED = 'https://brc.dev/207/attested'
const LEAF = {
  declarationTx: '0100',
  transactions: [],
  attestations: [{ txid: 'cd'.repeat(32), outputs: [0], signer: '03'.padEnd(66, 'b'), signature: '3006020101020102' }],
  submissions: [{ txid: 'cd'.repeat(32), offChainValues: 'beef' }]
}

const tokenSample = (): PaymentFrame => ({
  ...sample(),
  kind: 'token',
  token: {
    assetId: ASSET,
    certificates: [new Uint8Array([9, 9, 9]), new Uint8Array([])],
    profileData: JSON.stringify({ [ATTESTED]: { [ASSET]: LEAF } })
  } satisfies TokenPayment
})

const utf8 = (s: string) => new TextEncoder().encode(s)

function varint(n: number): number[] {
  const out: number[] = []
  let v = n
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80)
    v = Math.floor(v / 128)
  }
  out.push(v)
  return out
}

/**
 * A v6 token frame laid out by hand, so the DECODER's checks can be reached
 * with values the encoder refuses to write. Layout: version, kind, 33-byte
 * sender key, outputIndex, prefix, suffix, assetId, certificates,
 * profileData, note, transaction.
 */
function rawTokenFrame(opts: { version?: number; assetId?: string; profileData?: Uint8Array; profileLen?: number }) {
  const out: number[] = [opts.version ?? 6, 0x02]
  for (let i = 0; i < 33; i++) out.push(i === 0 ? 0x02 : 0xaa)
  out.push(...varint(0))
  const str = (s: string) => {
    const b = utf8(s)
    out.push(...varint(b.length), ...b)
  }
  str('cHJlZml4')
  str('c3VmZml4')
  str(opts.assetId ?? ASSET)
  out.push(...varint(0))
  const pd = opts.profileData ?? utf8('{}')
  out.push(...varint(opts.profileLen ?? pd.length), ...pd)
  str('')
  out.push(...varint(2), 1, 2)
  return new Uint8Array(out)
}

describe('frame v6 token block', () => {
  it('round-trips a bsv frame with kind preserved', () => {
    const decoded = decodeFrame(encodeFrame(sample()))
    expect(decoded.kind).toBe('bsv')
    expect(decoded.token).toBeUndefined()
    expect(decoded).toEqual(sample())
  })

  it('round-trips a v6 token frame with a profileData carrier', () => {
    const f = tokenSample()
    expect(f.version).toBe(6)
    expect(decodeFrame(encodeFrame(f))).toEqual(f)
  })

  it('carries exactly assetId, certificates and profileData', () => {
    const decoded = decodeFrame(encodeFrame(tokenSample()))
    expect(Object.keys(decoded.token!).sort()).toEqual(['assetId', 'certificates', 'profileData'])
  })

  it('carries profileData byte-for-byte, including non-ASCII text', () => {
    const profileData = JSON.stringify({ [ATTESTED]: { [ASSET]: { ...LEAF, memo: 'café ☕ 𝄞' } } })
    const f = { ...tokenSample(), token: { ...tokenSample().token!, profileData } }
    expect(decodeFrame(encodeFrame(f)).token!.profileData).toBe(profileData)
  })

  it('decodes the hand-built layout', () => {
    expect(decodeFrame(rawTokenFrame({})).token).toEqual({ assetId: ASSET, certificates: [], profileData: '{}' })
  })

  it('seals and unseals a token frame', () => {
    const psk = new Uint8Array(32).fill(7)
    expect(unsealFrame(sealFrame(tokenSample(), psk), psk)).toEqual(tokenSample())
  })

  it('refuses frame version 5 and a non-object profileData', () => {
    const v5 = encodeFrame(tokenSample())
    v5[0] = 5
    expect(() => decodeFrame(v5)).toThrow(CodecError)
    expect(() => decodeFrame(v5)).toThrow(/unsupported frame version 5/)
    expect(() => decodeFrame(rawTokenFrame({ version: 5 }))).toThrow(/unsupported frame version 5/)
    for (const bad of ['[]', 'null', '5', '"x"', 'true', '{', '', '{"a":1} x']) {
      expect(() => decodeFrame(rawTokenFrame({ profileData: utf8(bad) }))).toThrow(CodecError)
      expect(() => encodeFrame({ ...tokenSample(), token: { ...tokenSample().token!, profileData: bad } })).toThrow(
        CodecError
      )
    }
  })

  it('refuses profileData that is not valid UTF-8 rather than rewriting it', () => {
    const bytes = new Uint8Array([...utf8('{"a":"'), 0xff, 0xfe, ...utf8('"}')])
    expect(() => decodeFrame(rawTokenFrame({ profileData: bytes }))).toThrow(CodecError)
  })

  it('rejects a v3 frame: fail-closed versioning', () => {
    const bytes = encodeFrame(sample())
    bytes[0] = 3
    expect(() => decodeFrame(bytes)).toThrow(/unsupported frame version 3/)
  })

  it('refuses profileData above 16 MiB at encode, and at decode before reading it', () => {
    const over = '{"a":"' + 'x'.repeat(16_777_216 - 8 + 1) + '"}'
    expect(utf8(over).length).toBe(16_777_217)
    expect(() => encodeFrame({ ...tokenSample(), token: { ...tokenSample().token!, profileData: over } })).toThrow(
      /profileData too large/
    )
    // Only the length prefix is hostile: the check fires before any allocation.
    expect(() => decodeFrame(rawTokenFrame({ profileLen: 16_777_217 }))).toThrow(/profileData too large/)
  })

  it.each(['ab'.repeat(32) + '.0', 'AB'.repeat(32) + '_0', 'ab'.repeat(32) + '_1', 'ab'.repeat(31) + '_0', ''])(
    'refuses assetId %p at encode and decode',
    assetId => {
      expect(() => encodeFrame({ ...tokenSample(), token: { ...tokenSample().token!, assetId } })).toThrow(CodecError)
      expect(() => decodeFrame(rawTokenFrame({ assetId }))).toThrow(CodecError)
    }
  )

  it('rejects an unknown kind byte', () => {
    const bytes = encodeFrame(sample())
    bytes[1] = 0x03
    expect(() => decodeFrame(bytes)).toThrow(/unsupported frame kind 3/)
  })

  it('refuses to encode kind token without a token block, and kind bsv with one', () => {
    expect(() => encodeFrame({ ...sample(), kind: 'token' })).toThrow(CodecError)
    expect(() => encodeFrame({ ...sample(), token: tokenSample().token })).toThrow(CodecError)
  })

  it('fails closed on a token frame truncated anywhere', () => {
    const bytes = encodeFrame(tokenSample())
    for (let cut = 1; cut < bytes.length; cut += 13) {
      expect(() => decodeFrame(bytes.slice(0, bytes.length - cut))).toThrow(CodecError)
    }
  })

  it('still rejects trailing bytes after a token frame', () => {
    const bytes = encodeFrame(tokenSample())
    const padded = new Uint8Array([...bytes, 0])
    expect(() => decodeFrame(padded)).toThrow(/trailing bytes/)
  })
})
