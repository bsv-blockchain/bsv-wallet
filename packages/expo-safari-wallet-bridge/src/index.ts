/** Public API of `@bsv/expo-safari-wallet-bridge`. */
export { createNativeInboxStore, type NativeInboxStoreOptions } from './nativeStore'
export { parseHandoffUrl } from './handoffUrl'
export { SafariSetupGuide } from './ui/SafariSetupGuide'
export {
  SafariBridgeHost,
  resetSafariBridge,
  SAFARI_TRANSPORT_ID,
  type SafariBridgeHostProps
} from './SafariBridgeHost'
export * from '../shared/constants'
export { connectedHash, type Mirror, type MirrorSnapshot } from '../shared/mirror'
export type { BsvBridgeNative } from '../shared/native'

import type { BsvBridgeNative } from '../shared/native'

/**
 * The real native module as a `BsvBridgeNative`. Loaded lazily so importing the package in jest or
 * on a platform without the module does not throw until it is used.
 */
export function getBsvBridgeNative(): BsvBridgeNative {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { requireNativeModule } = require('expo-modules-core') as typeof import('expo-modules-core')
  const m = requireNativeModule('BsvBridge') as Omit<BsvBridgeNative, 'subscribeNudge'> & {
    addListener(name: 'onNudge', cb: () => void): { remove(): void }
  }
  return {
    init: o => m.init(o),
    create: (...a) => m.create(...a),
    stat: (...a) => m.stat(...a),
    read: (...a) => m.read(...a),
    accept: (...a) => m.accept(...a),
    release: (...a) => m.release(...a),
    claim: (...a) => m.claim(...a),
    writeResult: (...a) => m.writeResult(...a),
    readResult: (...a) => m.readResult(...a),
    ack: (...a) => m.ack(...a),
    list: (...a) => m.list(...a),
    writeEvent: (...a) => m.writeEvent(...a),
    readEventsAfter: (...a) => m.readEventsAfter(...a),
    writeMirror: (...a) => m.writeMirror(...a),
    sweep: o => m.sweep(o),
    reset: () => m.reset(),
    subscribeNudge: cb => {
      const sub = m.addListener('onNudge', cb)
      return () => sub.remove()
    },
    rawBytes: () => m.rawBytes()
  }
}
