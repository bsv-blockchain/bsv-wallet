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

// Dev canary: an AES-GCM decipher must refuse a wrong tag. react-native-quick-crypto
// 0.7.17 returned unauthenticated output instead (patches/react-native-quick-crypto+0.7.17.patch);
// this says so loudly if a bump brings that back.
if (__DEV__) {
  try {
    const key = QuickCrypto.randomBytes(32)
    const iv = QuickCrypto.randomBytes(32)
    const cipher = QuickCrypto.createCipheriv('aes-256-gcm', key, iv)
    const ct = Buffer.concat([Buffer.from(cipher.update(Buffer.from('canary'))), Buffer.from(cipher.final())])
    const tag = Buffer.from(cipher.getAuthTag())
    tag[0] ^= 1
    const decipher = QuickCrypto.createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    decipher.update(ct)
    let refused = false
    try {
      decipher.final()
    } catch {
      refused = true
    }
    if (!refused) console.error('[Crypto Setup] AES-GCM accepted a wrong tag: decrypts are not authenticated')
  } catch (e) {
    console.error('[Crypto Setup] AES-GCM canary failed to run', e)
  }
}

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

require('@bsv/expo-wallet-toolbox/core/context/startupPrewarm').prewarmStartup()
require('expo-router/entry')
