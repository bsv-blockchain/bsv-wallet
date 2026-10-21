/**
 * A stopgap for react-native-webrtc until the fix in `@bsv/webrtpay` (bsv-blockchain/ts-stack#1263)
 * is released. Pure TypeScript: the host passes in its own `RTCPeerConnection`.
 *
 * The payee takes the payer's data channel only when it is reliable, which the package reads
 * from `maxRetransmits` and `maxPacketLifeTime`: the DOM reports `null` for a channel opened
 * with no limit. react-native-webrtc cannot: Android reports -1 for a channel the peer opened,
 * and iOS passes on libwebrtc's `uint16_t`, where unset is 65535. webrtpay 0.2.1 then closes the
 * link ("Unexpected data channel 'webrtpay/1'"), so no payment can reach a phone.
 *
 * `withReactNativeDataChannels(RTCPeerConnection)` returns a subclass whose `datachannel`
 * listeners see those two fields as `null` when they hold -1 or 65535 (an own property on the
 * channel object, shadowing the getter, so the link still uses the real channel). The package
 * listens with `addEventListener('datachannel', …)` only. 65535 is also the largest limit a
 * peer can set, so a channel limited to exactly that reads as unlimited; the released fix makes
 * the same trade. Pass the result as `ToolboxConfig.directPay.RTCPeerConnection`:
 *
 *     import { RTCPeerConnection } from 'react-native-webrtc'
 *     configureToolbox({ …, directPay: { enabled: true, RTCPeerConnection: withReactNativeDataChannels(RTCPeerConnection) } })
 *
 * Drop it once the host's `@bsv/webrtpay` has the fix; it changes nothing there.
 */

/** Values react-native-webrtc reports for "no limit". */
const UNSET_LIMITS: ReadonlySet<number> = new Set([-1, 65535])

/** Reads `maxRetransmits` and `maxPacketLifeTime` as `null` on `channel` when they say "no limit". */
export function normalizeDataChannelLimits(channel: unknown): void {
  if (typeof channel !== 'object' || channel === null) return
  for (const field of ['maxRetransmits', 'maxPacketLifeTime'] as const) {
    const value = (channel as Record<string, unknown>)[field]
    if (typeof value !== 'number' || !UNSET_LIMITS.has(value)) continue
    try {
      Object.defineProperty(channel, field, { value: null, configurable: true, enumerable: true })
    } catch {
      // A channel that cannot be changed is left as it is; the link refuses it as before.
    }
  }
}

type DataChannelListener =
  | ((event: { channel?: unknown }) => void)
  | { handleEvent(event: { channel?: unknown }): void }

interface EventTargetLike {
  addEventListener(type: string, listener: never, options?: never): void
  removeEventListener(type: string, listener: never, options?: never): void
}

/**
 * `Base` with every `datachannel` listener handed a channel whose unset limits read `null`
 * (see the file header). Other events pass through unchanged.
 */
export function withReactNativeDataChannels<C extends new (...args: any[]) => EventTargetLike>(Base: C): C {
  const wrappers = new WeakMap<object, (event: { channel?: unknown }) => void>()
  const isListener = (l: unknown): l is DataChannelListener =>
    typeof l === 'function' || (typeof l === 'object' && l !== null && 'handleEvent' in l)

  return class ReactNativeDataChannels extends Base {
    addEventListener(type: string, listener: unknown, options?: unknown): void {
      if (type !== 'datachannel' || !isListener(listener)) {
        return super.addEventListener(type, listener as never, options as never)
      }
      let wrapper = wrappers.get(listener)
      if (!wrapper) {
        wrapper = (event: { channel?: unknown }) => {
          normalizeDataChannelLimits(event?.channel)
          if (typeof listener === 'function') listener.call(this, event)
          else listener.handleEvent(event)
        }
        wrappers.set(listener, wrapper)
      }
      super.addEventListener(type, wrapper as never, options as never)
    }

    removeEventListener(type: string, listener: unknown, options?: unknown): void {
      const wrapper = type === 'datachannel' && isListener(listener) ? wrappers.get(listener) : undefined
      super.removeEventListener(type, (wrapper ?? listener) as never, options as never)
    }
  }
}
