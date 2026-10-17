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
    // ...and must accept the right one, every time: an uninitialised auth-tag
    // state in the same file made good decrypts fail at random (patched too).
    let failures = 0
    for (let i = 0; i < 64; i++) {
      const k = QuickCrypto.randomBytes(32)
      const n = QuickCrypto.randomBytes(32)
      const c = QuickCrypto.createCipheriv('aes-256-gcm', k, n)
      const body = Buffer.concat([Buffer.from(c.update(Buffer.from('canary ' + i))), Buffer.from(c.final())])
      const d = QuickCrypto.createDecipheriv('aes-256-gcm', k, n)
      d.setAuthTag(Buffer.from(c.getAuthTag()))
      try {
        d.update(body)
        d.final()
      } catch {
        failures += 1
      }
    }
    if (failures) console.error(`[Crypto Setup] AES-GCM refused ${failures}/64 good tags: decrypts fail at random`)
    // Again once the app has been running: an uninitialised field reads 0 on
    // fresh memory (iOS zero-fills it) but garbage on reused heap (Android),
    // so only a check after real allocation churn catches it on a device.
    setTimeout(() => {
      let late = 0
      for (let i = 0; i < 300; i++) {
        const k = QuickCrypto.randomBytes(32)
        const n = QuickCrypto.randomBytes(32)
        const c = QuickCrypto.createCipheriv('aes-256-gcm', k, n)
        const body = Buffer.concat([Buffer.from(c.update(QuickCrypto.randomBytes(16 + (i % 400)))), Buffer.from(c.final())])
        const d = QuickCrypto.createDecipheriv('aes-256-gcm', k, n)
        d.setAuthTag(Buffer.from(c.getAuthTag()))
        try {
          d.update(body)
          d.final()
        } catch {
          late += 1
        }
      }
      if (late) console.error(`[Crypto Setup] AES-GCM refused ${late}/300 good tags after startup: decrypts fail at random`)
    }, 15_000)
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
