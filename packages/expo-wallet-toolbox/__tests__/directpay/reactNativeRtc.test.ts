/**
 * withReactNativeDataChannels (core/directpay/reactNativeRtc.ts): until @bsv/webrtpay ships the
 * fix, a `datachannel` listener must see react-native-webrtc's "no limit" values (-1 on Android,
 * 65535 on iOS) as the DOM's null, on the real channel object.
 */
import { normalizeDataChannelLimits, withReactNativeDataChannels } from '../../core/directpay/reactNativeRtc'

/** A react-native-webrtc-like channel: the limits are getters on the prototype. */
class FakeChannel {
  constructor(
    private readonly _retransmits: number | null,
    private readonly _lifetime: number | null
  ) {}
  label = 'webrtpay/1'
  ordered = true
  get maxRetransmits() {
    return this._retransmits
  }
  get maxPacketLifeTime() {
    return this._lifetime
  }
}

/** A peer connection with a minimal EventTarget. */
class FakePeerConnection {
  readonly listeners = new Map<string, Set<unknown>>()
  constructor(readonly config?: unknown) {}
  addEventListener(type: string, listener: unknown) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(listener)
  }
  removeEventListener(type: string, listener: unknown) {
    this.listeners.get(type)?.delete(listener)
  }
  emit(type: string, event: unknown) {
    for (const l of this.listeners.get(type) ?? []) {
      if (typeof l === 'function') l(event)
      else (l as { handleEvent(e: unknown): void }).handleEvent(event)
    }
  }
}

describe('withReactNativeDataChannels', () => {
  it.each([
    ['Android', -1, -1],
    ['iOS', 65535, 65535]
  ])('a %s channel opened with no limit reads as reliable', (_platform, retransmits, lifetime) => {
    const Pc = withReactNativeDataChannels(FakePeerConnection)
    const pc = new Pc({ iceServers: [] })
    expect(pc.config).toEqual({ iceServers: [] })
    const seen: unknown[] = []
    pc.addEventListener('datachannel', (event: { channel: FakeChannel }) => {
      seen.push([event.channel.maxRetransmits, event.channel.maxPacketLifeTime])
      expect(event.channel).toBeInstanceOf(FakeChannel)
    })
    pc.emit('datachannel', { channel: new FakeChannel(retransmits, lifetime) })
    expect(seen).toEqual([[null, null]])
  })

  it('leaves a real limit as it is', () => {
    const channel = new FakeChannel(3, null)
    normalizeDataChannelLimits(channel)
    expect(channel.maxRetransmits).toBe(3)
    expect(channel.maxPacketLifeTime).toBeNull()
  })

  it('serves handleEvent listeners and removes a listener it wrapped', () => {
    const Pc = withReactNativeDataChannels(FakePeerConnection)
    const pc = new Pc()
    const listener = { handleEvent: jest.fn() }
    pc.addEventListener('datachannel', listener)
    pc.emit('datachannel', { channel: new FakeChannel(-1, -1) })
    expect(listener.handleEvent.mock.calls[0][0].channel.maxRetransmits).toBeNull()
    pc.removeEventListener('datachannel', listener)
    pc.emit('datachannel', { channel: new FakeChannel(-1, -1) })
    expect(listener.handleEvent).toHaveBeenCalledTimes(1)
  })

  it('passes other events through untouched', () => {
    const Pc = withReactNativeDataChannels(FakePeerConnection)
    const pc = new Pc()
    const listener = jest.fn()
    pc.addEventListener('icecandidate', listener)
    expect(pc.listeners.get('icecandidate')!.has(listener)).toBe(true)
  })
})
