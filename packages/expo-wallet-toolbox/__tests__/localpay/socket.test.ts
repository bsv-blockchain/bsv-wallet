/**
 * XR-090. Nothing on the receive side of `transport/socket.ts` bounded how
 * many bytes a counterparty's payload could claim before this device ran
 * atob() -> AES-GCM decrypt -> JSON.parse on it in full: an oversized frame or
 * ack reached every one of those steps regardless of size. These tests pin
 * the ceiling this module now enforces BEFORE `atob()` ever runs, on both the
 * frame path (shared by AWDL, Nearby and BLE — all go through `fromBase64`)
 * and the ack path (`parseAck`).
 */
import {
  fromBase64,
  parseAck,
  MAX_INBOUND_ACK_BYTES,
  MAX_INBOUND_FRAME_BYTES
} from '../../core/localpay/transport/socket'
import { AckError } from '../../core/localpay/types'

function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return globalThis.btoa(s)
}

describe('fromBase64 (XR-090)', () => {
  it('decodes an ordinary payload normally', () => {
    const b64 = toBase64(new Uint8Array([1, 2, 3, 4]))
    expect(Array.from(fromBase64(b64))).toEqual([1, 2, 3, 4])
  })

  it('XR-090: rejects a payload over the given byte ceiling before decoding it', () => {
    const bytes = new Uint8Array(100).fill(7)
    const b64 = toBase64(bytes)
    expect(() => fromBase64(b64, 16)).toThrow(/exceeds/)
  })

  it('XR-090: the default ceiling matches the sealed-frame wire limit (@bsv/air-gap MAX_MESSAGE_BYTES)', () => {
    expect(MAX_INBOUND_FRAME_BYTES).toBe(65536)
    const bytes = new Uint8Array(MAX_INBOUND_FRAME_BYTES + 1).fill(1)
    const b64 = toBase64(bytes)
    expect(() => fromBase64(b64)).toThrow(/exceed/)
  })

  it('accepts a payload exactly at the ceiling', () => {
    const bytes = new Uint8Array(MAX_INBOUND_FRAME_BYTES).fill(1)
    const b64 = toBase64(bytes)
    expect(fromBase64(b64).length).toBe(MAX_INBOUND_FRAME_BYTES)
  })
})

describe('parseAck (XR-090)', () => {
  it('parses an ordinary ack normally', () => {
    expect(parseAck(globalThis.btoa(JSON.stringify({ ok: true })))).toEqual({ ok: true })
  })

  // The concrete DoS: a counterparty (or a bug on either side) returning a
  // many-megabyte "ack" used to reach atob() -> JSON.parse in full before
  // anything refused it. It must now be refused as malformed, same as any
  // other unparseable ack, well before its full size is ever decoded.
  it('XR-090: refuses an oversized ack payload as malformed, never decoding it in full', () => {
    const hugeError = 'x'.repeat(MAX_INBOUND_ACK_BYTES * 4)
    const b64 = globalThis.btoa(JSON.stringify({ ok: false, error: hugeError }))
    expect(() => parseAck(b64)).toThrow(AckError)
  })

  it('still parses a legitimate decline reason string comfortably under the ceiling', () => {
    expect(parseAck(globalThis.btoa(JSON.stringify({ ok: false, error: 'not_covered' })))).toEqual({
      ok: false,
      error: 'not_covered'
    })
  })
})
