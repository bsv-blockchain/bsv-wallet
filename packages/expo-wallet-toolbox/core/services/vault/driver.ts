/**
 * The single hardware surface the rest of the vault talks to.
 *
 * `VaultDriver` is deliberately declared here structurally (not imported from
 * the native package) so the entire TS layer — ceremony, service, tests —
 * compiles and runs without the `react-native-yubikey` native module resolving.
 * The real driver is a thin adapter over that module's JSON-string API; the
 * mock is a software implementation with test controls.
 *
 * Selection order: real native module > injected mock (DEV) > null. Null means
 * "no YubiKey capability on this device", and every caller treats it as such —
 * the vault UI hides, exactly like localpay's getLocalPayTransport() null path.
 */
import { vaultErrorFromNative } from './types'

export interface KeyEvent {
  type: 'attached' | 'detached' | 'session-failed'
  serial?: string
  transport: 'usb' | 'nfc' | 'mock'
  /** session-failed only: why the session ended before any key connected.
   * 'user-cancelled' = the user dismissed the system NFC sheet; 'no-key' =
   * the session timed out or died without a key ever being presented. */
  code?: 'user-cancelled' | 'no-key'
}

export interface VaultDriver {
  isSupported(): boolean
  /** True when discovery and the selected device are owned by one ceremony.
   * Real native drivers are always session-based: iOS presents its NFC sheet;
   * Android discovers either USB or NFC for the ceremony and tears both down
   * before releasing the process-wide hardware lease. Test mocks may model a
   * persistent reader. */
  sessionBased: boolean
  /** Open discovery. `message` is the localised NFC alert text shown on the
   * iOS scan sheet for this session (spec §4.2 step 6); Android and persistent
   * test readers ignore it. */
  start(message?: string): void
  stop(): void
  onKeyEvent(cb: (e: KeyEvent) => void): () => void
  getKeyInfo(): Promise<{ serial: string; firmwareVersion: string; pinRetries: number }>
  verifyPin(expectedSerial: string, pin: string): Promise<{ ok: boolean; retriesLeft: number }>
  changePin(expectedSerial: string, oldPin: string, newPin: string): Promise<{ ok: boolean; retriesLeft: number }>
  /** Rotate the PIV unblock code. Neither value may be logged or persisted. */
  changePuk(expectedSerial: string, oldPuk: string, newPuk: string): Promise<{ ok: boolean; retriesLeft: number }>
  /** Authenticate the default management key and best-effort reject occupied
   * user slots before global PIV credentials are changed. Native also verifies
   * the factory F9 certificate through the pinned production Yubico chain,
   * offline. Never mutates. */
  preflightDedicatedPiv(expectedSerial: string): Promise<{
    ok: true
    inspection: 'metadata' | 'attestation'
    manufacturerAttestation: 'verified'
  }>
  /** Generate a fresh P-256 key in the fixed Vault slot 0x82, with touch
   * policy CACHED and PIN policy ONCE (spec D6). Native returns only after a
   * same-session manufacturer attestation binds the exact key and policies. */
  generateVaultKey(expectedSerial: string): Promise<{
    publicKey: string
    manufacturerAttestation: 'verified'
  }>
  /**
   * Replace the factory management key with native CSPRNG material and discard
   * it. Called immediately after vault-key generation, in the same session.
   */
  protectManagementKey(expectedSerial: string): Promise<{ ok: true }>
  readVaultPublicKey(expectedSerial: string): Promise<{ publicKey: string } | null>
  /** Sign a pre-computed 32-byte digest (64 hex chars) with the slot's P-256
   * key. Returns a DER signature as hex. TOUCH-gated, PIN-gated. */
  signEcdsa(expectedSerial: string, pin: string, digest: string): Promise<{ signature: string }>
}

/** Shape of the native Nitro module (JSON-string API). Kept local so a missing
 * package never breaks the type-check. */
interface NativeYubiKeyPiv {
  isSupported(): boolean
  startDiscovery(message: string): void
  stopDiscovery(): void
  setKeyListener(listener: (eventType: string, serial: string, transport: string) => void): void
  clearKeyListener(): void
  getKeyInfo(): Promise<string>
  verifyPin(expectedSerial: string, pin: string): Promise<string>
  changePin(expectedSerial: string, oldPin: string, newPin: string): Promise<string>
  changePuk(expectedSerial: string, oldPuk: string, newPuk: string): Promise<string>
  preflightDedicatedPiv(expectedSerial: string): Promise<string>
  generateVaultKey(expectedSerial: string): Promise<string>
  protectManagementKey(expectedSerial: string): Promise<string>
  readVaultPublicKey(expectedSerial: string): Promise<string>
  signEcdsa(expectedSerial: string, pin: string, digest: string): Promise<string>
}

let injectedMock: VaultDriver | null = null
let nativeCache: VaultDriver | null | undefined

/** DEV/test seam: force the mock (or clear it). */
export function setMockDriver(driver: VaultDriver | null): void {
  injectedMock = driver
}

/** Normalize a native key event into the driver's vocabulary.
 *
 * The native modules emit `connected` / `removed` (iOS YubiKit + Android
 * yubikit-android naming); the driver — and the mock, ceremony, and tests —
 * speak `attached` / `detached`. Only an explicit connect is an attach; an
 * explicit disconnect is a detach; anything unrecognized is treated as a
 * detach (fail-safe: a stray event relocks rather than silently keeping the
 * PKM armed). Getting this wrong makes insert read as detach and aborts the
 * in-flight ceremony as `key-removed-mid-op`.
 *
 * `failed:<code>` is the native didFailConnectingNFC path — the session died
 * BEFORE any key connected, so neither attach nor detach fits (a detach would
 * misreport it as key-removed-mid-op). `<code>` is the CoreNFC invalidation
 * code: 200 = the user pressed cancel on the system sheet, anything else
 * (201 timeout, 202/203 system faults) = no key ever presented. */
export function mapNativeKeyEvent(eventType: string, serial: string, transport: string): KeyEvent {
  const t = (transport as KeyEvent['transport']) || 'usb'
  if (eventType === 'failed' || eventType.startsWith('failed:')) {
    return {
      type: 'session-failed',
      code: eventType === 'failed:200' ? 'user-cancelled' : 'no-key',
      serial: undefined,
      transport: t
    }
  }
  const attached = eventType === 'attached' || eventType === 'connected'
  return {
    type: attached ? 'attached' : 'detached',
    serial: serial || undefined,
    transport: t
  }
}

/** Wrap the native module's JSON-string surface as a VaultDriver. */
function adaptNative(native: NativeYubiKeyPiv): VaultDriver {
  const parse = async <T>(p: Promise<string>): Promise<T> => {
    try {
      return JSON.parse(await p) as T
    } catch (e) {
      throw vaultErrorFromNative(e)
    }
  }
  const listeners = new Set<(e: KeyEvent) => void>()
  return {
    isSupported: () => native.isSupported(),
    // Both native implementations scope discovery to one hardware ceremony.
    // Android listens for USB and NFC together, then synchronously tears both
    // down on stop so an NFC device object can never survive into a later run.
    sessionBased: true,
    start: (message?: string) => {
      // (Re)install the native listener each start; it forwards into the
      // persistent JS `listeners` set so app subscribers survive stop/start
      // cycles (a session-based transport starts and stops per ceremony).
      native.setKeyListener((eventType, serial, transport) => {
        const e = mapNativeKeyEvent(eventType, serial, transport)
        listeners.forEach(cb => cb(e))
      })
      try {
        native.startDiscovery(message ?? '')
      } catch (e) {
        // iOS throws VAULT_ERR:driver-unavailable when NFC reading is
        // unavailable (NFC off, or a wedged nfcd needing a device restart)
        // rather than silently not presenting the scan sheet.
        throw vaultErrorFromNative(e)
      }
    },
    stop: () => {
      native.stopDiscovery()
      native.clearKeyListener()
      // NOTE: do NOT clear `listeners` — app subscribers (WalletContext) stay
      // subscribed across ceremony sessions.
    },
    onKeyEvent: cb => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    getKeyInfo: () => parse(native.getKeyInfo()),
    verifyPin: (serial, pin) => parse(native.verifyPin(serial, pin)),
    changePin: (serial, o, n) => parse(native.changePin(serial, o, n)),
    changePuk: (serial, o, n) => parse(native.changePuk(serial, o, n)),
    preflightDedicatedPiv: serial => parse(native.preflightDedicatedPiv(serial)),
    // 'cached' (spec D6): the card signs every vault input on-chain, up to
    // VAULT_INPUTS_PER_TAP digests per tap, so one touch must cover a batch —
    // the card keeps a touch valid for 15 s. 'always' would need a touch per
    // input. 'once' lets the PIN verified at session start cover the batch.
    generateVaultKey: serial => parse(native.generateVaultKey(serial)),
    protectManagementKey: serial => parse(native.protectManagementKey(serial)),
    readVaultPublicKey: async serial => {
      const r = await parse<{ publicKey: string | null }>(native.readVaultPublicKey(serial))
      return r.publicKey ? { publicKey: r.publicKey } : null
    },
    signEcdsa: (serial, pin, digest) => parse(native.signEcdsa(serial, pin, digest))
  }
}

function loadNative(): VaultDriver | null {
  if (nativeCache !== undefined) return nativeCache
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('react-native-yubikey') as { getYubiKeyPiv?: () => NativeYubiKeyPiv | null }
    const native = mod.getYubiKeyPiv?.() ?? null
    nativeCache = native ? adaptNative(native) : null
  } catch {
    nativeCache = null
  }
  return nativeCache
}

/**
 * The active driver: an injected mock if one is installed, else native, else
 * null.
 *
 * The mock wins deliberately. It is only ever installed by the DEV-gated
 * "Use mock YubiKey" toggle, and on a simulator the native module DOES
 * resolve — it simply reports isSupported() === false. Native-first therefore
 * made that toggle a no-op on exactly the device it exists for: the vault
 * screen kept saying "needs a YubiKey" with the mock switched on.
 */
export function getVaultDriver(): VaultDriver | null {
  if (injectedMock) return injectedMock
  return loadNative()
}
