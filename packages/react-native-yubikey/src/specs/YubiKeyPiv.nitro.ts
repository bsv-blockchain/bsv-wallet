import type { HybridObject } from 'react-native-nitro-modules'

export interface YubiKeyPiv extends HybridObject<{ ios: 'swift'; android: 'kotlin' }> {
  isSupported(): boolean
  /** Open discovery. `message` is the localised text the iOS NFC scan sheet
   * shows for this session (set from JS per tap — spec §4.2 step 6); Android
   * ignores it (system NFC has no per-session prompt, USB has none). An empty
   * string selects the native default wording. */
  startDiscovery(message: string): void
  stopDiscovery(): void
  setKeyListener(listener: (eventType: string, serial: string, transport: string) => void): void
  clearKeyListener(): void
  getKeyInfo(): Promise<string> // JSON {serial, firmwareVersion, pinRetries}
  /** Every operation after discovery is bound to the serial selected by JS.
   * Native verifies it on the same PIV session immediately before use. */
  verifyPin(expectedSerial: string, pin: string): Promise<string> // JSON {ok, retriesLeft}
  changePin(expectedSerial: string, oldPin: string, newPin: string): Promise<string>
  changePuk(expectedSerial: string, oldPuk: string, newPuk: string): Promise<string>
  /** Verify the factory F9 certificate through the pinned production Yubico
   * chain, authenticate the factory management key, and reject occupied user
   * PIV slots. Explicit replacement may exempt only Vault slot 0x82. Offline
   * and non-mutating. */
  preflightDedicatedPiv(expectedSerial: string, allowOccupiedVaultSlot: boolean): Promise<string> // JSON {ok:true,inspection,manufacturerAttestation:'verified'}
  /** Fixed to PIV slot 0x82, P-256, PIN once, touch cached. Resolves only
   * after same-session manufacturer attestation of the generated key. */
  generateVaultKey(expectedSerial: string): Promise<string> // JSON {publicKey,manufacturerAttestation:'verified'}
  /** Authenticate the factory management key, replace it with native CSPRNG
   * material, then discard that material without crossing the JS bridge. */
  protectManagementKey(expectedSerial: string): Promise<string>
  /** Reads only the fixed Vault slot 0x82. */
  readVaultPublicKey(expectedSerial: string): Promise<string> // JSON {publicKey|null}
  /** Sign a pre-computed 32-byte digest with the slot's P-256 key.
   *
   * `digest` is 64 hex chars, passed to the card UNCHANGED — no hashing on
   * either side. Resolves JSON {signature} as DER hex. TOUCH-gated. */
  signEcdsa(expectedSerial: string, pin: string, digest: string): Promise<string>
}
