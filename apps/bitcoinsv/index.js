/**
 * Entry point for the Bitcoin SV Wallet app.
 *
 * The same native crypto bootstrap as the existing app's /index.js: the shared
 * wallet core (and the patched @bsv/sdk) expect these seams to be installed
 * before any SDK module loads. Keep the two in step. The existing app's dev-only
 * proof and benchmark harnesses are deliberately not carried over.
 */

// react-native-quick-crypto first: sets global.Buffer and global.crypto via JSI.
const QuickCrypto = require('react-native-quick-crypto')
QuickCrypto.install()

if (typeof globalThis === 'undefined') {
  global.globalThis = global
}

// SDK Hash and SymmetricKey resolve their backend once at module load. Hermes
// has no process.getBuiltinModule, so expose the Node-compatible JSI backend
// before the router (and therefore any SDK module) loads.
globalThis.__bsvNativeCrypto = QuickCrypto

// The SDK's Random looks for getRandomValues on globalThis, self and window.
if (global.crypto && typeof global.crypto.getRandomValues === 'function') {
  globalThis.crypto = global.crypto
  if (typeof global.self === 'undefined') global.self = global
  else if (!global.self.crypto) global.self.crypto = global.crypto
  if (typeof global.window === 'undefined') global.window = global
  else if (!global.window.crypto) global.window.crypto = global.crypto
} else {
  console.warn('[Crypto Setup] Warning: global.crypto not properly initialized after install()')
}

// Native secp256k1 and the native tx engine (Nitro). Both are safe no-ops when
// unavailable; the SDK then uses its pure-JS paths.
try {
  require('react-native-secp-native').installSecpNative()
} catch (e) {
  if (__DEV__) console.warn('[SecpNative] install failed — using pure-JS EC', e)
}
try {
  require('react-native-engine-native').installEngineNative()
} catch (e) {
  if (__DEV__) console.warn('[EngineNative] install failed — pure-JS tx path', e)
}

// FCM background handler, registered before the router so a headless wake-up
// finds it. Without this app's own Firebase registration (see app.config.js)
// there is no default Firebase app and this throws; push is then unavailable,
// which must never stop the wallet from starting.
try {
  const { getMessaging, setBackgroundMessageHandler } = require('@react-native-firebase/messaging')
  setBackgroundMessageHandler(getMessaging(), async () => {})
} catch (e) {
  if (__DEV__) console.warn('[Push] background handler not registered — push unavailable', e)
}

// The wallet's startup reads (its secrets check, its profiles and stored
// config) begin now and run while the app renders, rather than after its first
// screen has: the wallet build waits on them.
require('@bsv/expo-wallet-toolbox/core/context/startupPrewarm').prewarmStartup()

// Required after the seams above: static imports would run first.
require('expo-router/entry')
