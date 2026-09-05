import { Platform } from 'react-native'
import { makeBleTransport } from '../../core/localpay/transport/ble'
import { makeSocketTransport } from '../../core/localpay/transport/socket'
import { CAP_BLE_SCAN, mintSession } from '../../core/localpay/session'
import { CodecError, FRAME_VERSION, type PaymentFrame } from '../../core/localpay/codec'

jest.mock('@bsv/react-native-localpay-transport', () => ({
  getLocalPayTransport: jest.fn(),
  getLocalPayBleTransport: jest.fn(),
}))

const session = mintSession({
  identityKey: '02'.padEnd(66, 'd'),
  amount: 1,
  derivationPrefix: 'cA',
  derivationSuffix: 'cw',
  supportsAwdl: true,
  supportsBle: true,
})
const frame: PaymentFrame = {
  version: FRAME_VERSION,
  kind: 'bsv',
  senderIdentityKey: '02'.padEnd(66, 'e'),
  outputIndex: 0,
  derivationPrefix: 'cA',
  derivationSuffix: 'cw',
  transaction: new Uint8Array([1, 2, 3]),
}

describe.each(['awdl', 'nearby', 'ble-central', 'ble-peripheral'] as const)('%s cleanup', kind => {
  const originalOS = Platform.OS

  afterEach(() => {
    Platform.OS = originalOS
    jest.restoreAllMocks()
  })

  function setup() {
    Platform.OS = kind === 'ble-peripheral' ? 'android' : 'ios'
    const native = {
      startListening: jest.fn().mockResolvedValue(undefined),
      startScanning: jest.fn().mockResolvedValue(undefined),
      stopListening: jest.fn().mockResolvedValue(undefined),
      confirmFrame: jest.fn().mockResolvedValue(undefined),
      sendFrame: jest.fn().mockResolvedValue(btoa('{"ok":true}')),
      sendFrameAdvertising: jest.fn().mockResolvedValue(btoa('{"ok":true}')),
    }
    const transport = kind === 'awdl' || kind === 'nearby'
      ? makeSocketTransport(kind, () => native, 4000)
      : makeBleTransport(() => native as never, 15_000)
    const sendSession = kind === 'ble-peripheral'
      ? { ...session, caps: session.caps | CAP_BLE_SCAN }
      : session
    const send = kind === 'ble-peripheral' ? native.sendFrameAdvertising : native.sendFrame
    const controller = new AbortController()
    const added = jest.spyOn(controller.signal, 'addEventListener')
    const removed = jest.spyOn(controller.signal, 'removeEventListener')
    const expectAbortListenerRemoved = () => {
      const listener = added.mock.calls.find(([event]) => event === 'abort')?.[1]
      expect(listener).toBeDefined()
      expect(removed).toHaveBeenCalledWith('abort', listener)
    }
    return { native, transport, sendSession, send, controller, expectAbortListenerRemoved }
  }

  it('removes the abort listener when frame encoding fails', async () => {
    const { transport, sendSession, send, controller, expectAbortListenerRemoved } = setup()
    const malformed = { ...frame, senderIdentityKey: '02' }

    await expect(transport.send(sendSession, malformed, controller.signal)).rejects.toThrow(CodecError)

    expect(send).not.toHaveBeenCalled()
    expectAbortListenerRemoved()
  })

  it('removes the abort listener when the native send throws synchronously', async () => {
    const { transport, sendSession, send, controller, expectAbortListenerRemoved } = setup()
    const failure = new Error('native send failed')
    send.mockImplementation(() => { throw failure })

    await expect(transport.send(sendSession, frame, controller.signal)).rejects.toBe(failure)

    expect(send).toHaveBeenCalledTimes(1)
    expectAbortListenerRemoved()
  })

  it('cleans up when starting the native listener throws synchronously', async () => {
    const { native, transport, controller, expectAbortListenerRemoved } = setup()
    const failure = new Error('native listener failed')
    native.startListening.mockImplementation(() => { throw failure })

    await expect(transport.receive(session, controller.signal)).rejects.toBe(failure)

    expect(native.stopListening).toHaveBeenCalledTimes(1)
    expectAbortListenerRemoved()
    controller.abort()
    expect(native.stopListening).toHaveBeenCalledTimes(1)
  })

  it.each(['throw', 'reject'] as const)('settles a listener error when native teardown fails by %s', async mode => {
    const { native, transport, controller, expectAbortListenerRemoved } = setup()
    const failure = new Error('native teardown failed')
    native.stopListening.mockImplementation(() => {
      if (mode === 'throw') throw failure
      return Promise.reject(failure)
    })
    const pending = transport.receive(session, controller.signal)
    const outcome = expect(pending).rejects.toThrow('bluetooth unavailable')
    const onError = native.startListening.mock.calls[0][3]

    expect(() => onError('bluetooth unavailable')).not.toThrow()
    await outcome
    expect(native.stopListening).toHaveBeenCalledTimes(1)
    expectAbortListenerRemoved()
  })
})
