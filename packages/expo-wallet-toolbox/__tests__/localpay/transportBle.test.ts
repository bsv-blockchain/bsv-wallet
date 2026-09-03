import { BLE_CONNECT_TIMEOUT_MS, bleTransport } from '../../core/localpay/transport/ble'
import { AckError } from '../../core/localpay/types'
import { mintSession, instanceName } from '../../core/localpay/session'
import { CodecError, FRAME_VERSION, SEAL_VERSION, encodeFrame, sealFrame, unsealFrame, type PaymentFrame } from '../../core/localpay/codec'
import type { LocalPayBleTransport } from 'react-native-localpay-transport'

jest.mock('react-native-localpay-transport', () => ({
  getLocalPayBleTransport: jest.fn(),
}))

const { getLocalPayBleTransport } = jest.requireMock('react-native-localpay-transport') as {
  getLocalPayBleTransport: jest.Mock
}

function fakeNative(overrides: Partial<LocalPayBleTransport> = {}) {
  return {
    isSupported: () => true,
    bluetoothState: () => 'poweredOn',
    nfcAvailable: () => false,
    prepare: jest.fn().mockResolvedValue('poweredOn'),
    startListening: jest.fn(),
    stopListening: jest.fn().mockResolvedValue(undefined),
    confirmFrame: jest.fn().mockResolvedValue(undefined),
    sendFrame: jest.fn(),
    ...overrides,
  }
}

const session = mintSession({
  identityKey: '02'.padEnd(66, 'd'),
  amount: 1,
  derivationPrefix: 'cA',
  derivationSuffix: 'cw',
  supportsAwdl: false,
  supportsBle: true,
})

const frame: PaymentFrame = {
  version: FRAME_VERSION,
  kind: 'bsv' as const,
  senderIdentityKey: '02'.padEnd(66, 'e'),
  outputIndex: 0,
  derivationPrefix: 'cA',
  derivationSuffix: 'cw',
  transaction: new Uint8Array([1, 2, 3]),
}

function toAckBase64(payload: unknown): string {
  return globalThis.btoa(JSON.stringify(payload))
}

function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (const byte of bytes) s += String.fromCharCode(byte)
  return globalThis.btoa(s)
}

describe('bleTransport', () => {
  it('is attributed as the ble rung', () => {
    expect(bleTransport.kind).toBe('ble')
  })

  it('exposes the 15 s connect budget as a named constant', () => {
    expect(BLE_CONNECT_TIMEOUT_MS).toBe(15_000)
  })
})

describe('bleTransport.send', () => {
  afterEach(() => jest.clearAllMocks())

  // A null accessor is how a missing native lib floors to QR; it must be a
  // rejection the flow can attribute, never a throw out of send().
  it('rejects when the BLE HybridObject is unavailable', async () => {
    getLocalPayBleTransport.mockReturnValue(null)

    await expect(bleTransport.send(session, frame, new AbortController().signal)).rejects.toThrow(
      'ble transport unavailable'
    )
  })

  it('rejects immediately on an already-aborted signal without calling sendFrame', async () => {
    const native = fakeNative()
    getLocalPayBleTransport.mockReturnValue(native)
    const controller = new AbortController()
    controller.abort()

    await expect(bleTransport.send(session, frame, controller.signal)).rejects.toThrow('cancelled')
    expect(native.sendFrame).not.toHaveBeenCalled()
  })

  it('passes the 15 s connect budget and 30 s send budget to sendFrame', async () => {
    const native = fakeNative({ sendFrame: jest.fn().mockResolvedValue(toAckBase64({ ok: true })) })
    getLocalPayBleTransport.mockReturnValue(native)

    await bleTransport.send(session, frame, new AbortController().signal)
    const call = (native.sendFrame as jest.Mock).mock.calls[0]
    expect(call[0]).toBe(instanceName(session.sessionId))
    expect(call[1]).toBe(toBase64(session.psk))
    expect(call[3]).toBe(30000)
    expect(call[4]).toBe(15000)
  })

  // Spec §3 step 8: the native central rejects with this exact string when
  // scan + connect + discovery do not finish inside connectTimeoutMs. It is
  // the string NearbyFlow's executeSend already treats as radios-off /
  // peer-gone, so the payer drops to the fountain without aborting the built
  // action. The wrapper must forward it untouched.
  it('rejects with the native connect-timeout message so NearbyFlow falls back to the QR', async () => {
    const native = fakeNative({
      sendFrame: jest.fn().mockRejectedValue(new Error('connect timeout: no route to peer')),
    })
    getLocalPayBleTransport.mockReturnValue(native)

    await expect(bleTransport.send(session, frame, new AbortController().signal)).rejects.toThrow(
      'connect timeout: no route to peer'
    )
  })

  // Spec §3 (framing): the payer's native side refuses a sealed frame over
  // MAX_BLE_FRAME_BYTES. That is a radio failure (fountain next), not an
  // AckError — an AckError would suggest the payee answered.
  it('propagates the oversize rejection as a plain radio failure, not an AckError', async () => {
    const native = fakeNative({
      sendFrame: jest.fn().mockRejectedValue(new Error('frame too large for a BLE payload')),
    })
    getLocalPayBleTransport.mockReturnValue(native)

    const outcome = bleTransport.send(session, frame, new AbortController().signal)
    await expect(outcome).rejects.toThrow('frame too large for a BLE payload')
    await expect(outcome).rejects.not.toBeInstanceOf(AckError)
  })

  it.each([null, 42, [], {}])('throws AckError for a malformed ack payload %p', async bad => {
    const native = fakeNative({ sendFrame: jest.fn().mockResolvedValue(toAckBase64(bad)) })
    getLocalPayBleTransport.mockReturnValue(native)

    await expect(bleTransport.send(session, frame, new AbortController().signal)).rejects.toThrow(AckError)
  })

  it('resolves a well-formed success ack', async () => {
    const native = fakeNative({ sendFrame: jest.fn().mockResolvedValue(toAckBase64({ ok: true })) })
    getLocalPayBleTransport.mockReturnValue(native)

    await expect(bleTransport.send(session, frame, new AbortController().signal)).resolves.toEqual({ ok: true })
  })

  it('resolves a genuine peer decline rather than throwing', async () => {
    const native = fakeNative({
      sendFrame: jest.fn().mockResolvedValue(toAckBase64({ ok: false, error: 'declined' })),
    })
    getLocalPayBleTransport.mockReturnValue(native)

    await expect(bleTransport.send(session, frame, new AbortController().signal))
      .resolves.toEqual({ ok: false, error: 'declined' })
  })

  it('seals outgoing frames: sendFrame carries ciphertext the session PSK opens', async () => {
    const native = fakeNative({ sendFrame: jest.fn().mockResolvedValue(toAckBase64({ ok: true })) })
    getLocalPayBleTransport.mockReturnValue(native)

    await bleTransport.send(session, frame, new AbortController().signal)
    const sentBase64 = (native.sendFrame as jest.Mock).mock.calls[0][2] as string
    const sentBytes = Uint8Array.from(globalThis.atob(sentBase64), c => c.charCodeAt(0))
    expect(sentBytes[0]).toBe(SEAL_VERSION)
    expect(unsealFrame(sentBytes, session.psk)).toEqual(frame)
  })
})

describe('bleTransport.receive', () => {
  afterEach(() => jest.clearAllMocks())

  it('rejects when the BLE HybridObject is unavailable', async () => {
    getLocalPayBleTransport.mockReturnValue(null)

    await expect(bleTransport.receive(session, new AbortController().signal)).rejects.toThrow(
      'ble transport unavailable'
    )
  })

  it('rejects immediately on an already-aborted signal without calling startListening', async () => {
    const native = fakeNative()
    getLocalPayBleTransport.mockReturnValue(native)
    const controller = new AbortController()
    controller.abort()

    await expect(bleTransport.receive(session, controller.signal)).rejects.toThrow('cancelled')
    expect(native.startListening).not.toHaveBeenCalled()
  })

  // Spec §6: the payee runs this listener alongside the platform radio and
  // aborts the loser. Aborting BEFORE any frame arrived must tear the BLE
  // advertiser down (native stopListening) — the loser holds no ack connection.
  it('stops the listener when aborted while still waiting for a frame', async () => {
    const startListening = jest.fn(() => Promise.resolve())
    const native = fakeNative({ startListening: startListening as never })
    getLocalPayBleTransport.mockReturnValue(native)
    const controller = new AbortController()

    const pending = bleTransport.receive(session, controller.signal)
    expect(startListening).toHaveBeenCalledTimes(1)
    controller.abort()

    await expect(pending).rejects.toThrow('cancelled')
    expect(native.stopListening).toHaveBeenCalledTimes(1)
  })

  it('resolves the decoded frame with a confirm handle', async () => {
    const startListening = jest.fn((_name: string, _psk: string, onFrame: (f: string) => void) => {
      onFrame(toBase64(sealFrame(frame, session.psk)))
      return Promise.resolve()
    })
    const native = fakeNative({ startListening: startListening as never })
    getLocalPayBleTransport.mockReturnValue(native)

    const received = await bleTransport.receive(session, new AbortController().signal)
    expect(received.frame).toEqual(frame)
    expect(typeof received.confirm).toBe('function')
    expect(startListening).toHaveBeenCalledTimes(1)
    expect(startListening.mock.calls[0][0]).toBe(instanceName(session.sessionId))
    expect(startListening.mock.calls[0][1]).toBe(toBase64(session.psk))
  })

  // Money-safety: the native side is HOLDING the payer's connection open for
  // the ack when onFrame fires, and stopListening() cancels held connections.
  // Tearing down on the success path would destroy the socket the ack has to
  // travel back over — the payer would time out on a payment the payee saved.
  it('does NOT stop the listener on the success path', async () => {
    const startListening = jest.fn((_name: string, _psk: string, onFrame: (f: string) => void) => {
      onFrame(toBase64(sealFrame(frame, session.psk)))
      return Promise.resolve()
    })
    const native = fakeNative({ startListening: startListening as never })
    getLocalPayBleTransport.mockReturnValue(native)

    await bleTransport.receive(session, new AbortController().signal)
    expect(native.stopListening).not.toHaveBeenCalled()
  })

  it('acks positively through the native confirmFrame, exactly once', async () => {
    const startListening = jest.fn((_name: string, _psk: string, onFrame: (f: string) => void) => {
      onFrame(toBase64(sealFrame(frame, session.psk)))
      return Promise.resolve()
    })
    const native = fakeNative({ startListening: startListening as never })
    getLocalPayBleTransport.mockReturnValue(native)

    const { confirm } = await bleTransport.receive(session, new AbortController().signal)
    await confirm(true)
    await confirm(true)
    expect(native.confirmFrame).toHaveBeenCalledTimes(1)
    expect(native.confirmFrame).toHaveBeenCalledWith(true, '')
  })

  it('forwards a decline reason verbatim so the payer can localize it', async () => {
    const startListening = jest.fn((_name: string, _psk: string, onFrame: (f: string) => void) => {
      onFrame(toBase64(sealFrame(frame, session.psk)))
      return Promise.resolve()
    })
    const native = fakeNative({ startListening: startListening as never })
    getLocalPayBleTransport.mockReturnValue(native)

    const { confirm } = await bleTransport.receive(session, new AbortController().signal)
    await confirm(false, 'already_paid')
    expect(native.confirmFrame).toHaveBeenCalledWith(false, 'already_paid')
  })

  // A failed ack is not a failed payment on the payee's side: the frame is
  // already durable by then, so this must never surface as a rejection that
  // could flip a settled screen.
  it('never rejects when the native ack fails', async () => {
    const startListening = jest.fn((_name: string, _psk: string, onFrame: (f: string) => void) => {
      onFrame(toBase64(sealFrame(frame, session.psk)))
      return Promise.resolve()
    })
    const native = fakeNative({
      startListening: startListening as never,
      confirmFrame: jest.fn().mockRejectedValue(new Error('peer disconnected before acking')) as never,
    })
    getLocalPayBleTransport.mockReturnValue(native)

    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const { confirm } = await bleTransport.receive(session, new AbortController().signal)
    await expect(confirm(true)).resolves.toBeUndefined()
    warn.mockRestore()
  })

  it('rejects rather than hanging when the delivered frame cannot be decoded', async () => {
    const startListening = jest.fn((_name: string, _psk: string, onFrame: (f: string) => void) => {
      onFrame(toBase64(new Uint8Array([0xff, 0xff, 0xff])))
      return Promise.resolve()
    })
    const native = fakeNative({ startListening: startListening as never })
    getLocalPayBleTransport.mockReturnValue(native)

    let timer: ReturnType<typeof setTimeout> | undefined
    const outcome = await Promise.race([
      bleTransport
        .receive(session, new AbortController().signal)
        .then(() => 'resolved' as const, () => 'rejected' as const),
      new Promise<'hung'>(resolve => {
        timer = setTimeout(() => resolve('hung'), 500)
      })
    ])
    clearTimeout(timer)

    expect(outcome).toBe('rejected')
  })

  it('rejects with the CodecError raised by the decoder', async () => {
    const startListening = jest.fn((_name: string, _psk: string, onFrame: (f: string) => void) => {
      onFrame(toBase64(new Uint8Array([0xff, 0xff, 0xff])))
      return Promise.resolve()
    })
    getLocalPayBleTransport.mockReturnValue(fakeNative({ startListening: startListening as never }))

    await expect(bleTransport.receive(session, new AbortController().signal)).rejects.toThrow(CodecError)
  })

  // receive() rejects on a decode failure, so no confirm handle ever reaches
  // the screen. Without the transport declining here the payer would sit on a
  // green "Sent" until its own timeout, having queued nothing at the payee.
  it('declines to the payer when the delivered frame cannot be decoded', async () => {
    const startListening = jest.fn((_name: string, _psk: string, onFrame: (f: string) => void) => {
      onFrame(toBase64(new Uint8Array([0xff, 0xff, 0xff])))
      return Promise.resolve()
    })
    const native = fakeNative({ startListening: startListening as never })
    getLocalPayBleTransport.mockReturnValue(native)

    await expect(bleTransport.receive(session, new AbortController().signal)).rejects.toThrow(CodecError)
    expect(native.confirmFrame).toHaveBeenCalledWith(false, 'decode_failed')
    // Same reason as the success path: stopListening would cancel the very
    // connection the decline has to go out on.
    expect(native.stopListening).not.toHaveBeenCalled()
  })

  it('declines decode_failed on an UNSEALED frame: raw v3 bytes are not accepted on the wire', async () => {
    const startListening = jest.fn((_name: string, _psk: string, onFrame: (f: string) => void) => {
      onFrame(toBase64(encodeFrame(frame))) // raw, not sealed
      return Promise.resolve()
    })
    const native = fakeNative({ startListening: startListening as never })
    getLocalPayBleTransport.mockReturnValue(native)

    await expect(bleTransport.receive(session, new AbortController().signal)).rejects.toThrow(CodecError)
    expect(native.confirmFrame).toHaveBeenCalledWith(false, 'decode_failed')
  })

  // The native listener's onError path (e.g. the 60 s ack reaper expiring
  // with "payee never confirmed the payment; connection released") is a
  // terminal failure for THIS receive(): reject with the message and tear
  // down, so the flow can restart the listener under a fresh epoch.
  it('rejects with the native onError message and tears the listener down', async () => {
    const startListening = jest.fn(
      (_name: string, _psk: string, _onFrame: (f: string) => void, onError: (m: string) => void) => {
        onError('bluetooth unavailable')
        return Promise.resolve()
      }
    )
    const native = fakeNative({ startListening: startListening as never })
    getLocalPayBleTransport.mockReturnValue(native)

    await expect(bleTransport.receive(session, new AbortController().signal)).rejects.toThrow('bluetooth unavailable')
    expect(native.stopListening).toHaveBeenCalledTimes(1)
  })
})
