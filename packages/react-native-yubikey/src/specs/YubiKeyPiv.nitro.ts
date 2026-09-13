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
  /** Reads only the fixed Vault slot 0x82. May report `null` for a key that IS
   * present: iOS cannot read a retired slot's certificate at all, so a caller
   * asking "is this slot empty?" must use `isVaultSlotOccupied` instead. */
  readVaultPublicKey(expectedSerial: string): Promise<string> // JSON {publicKey|null}
  /** Whether Vault slot 0x82 holds a key, answered by the card itself.
   *
   * Deliberately NOT `readVaultPublicKey() !== null`: that returns a public
   * key, and on iOS a retired slot has no readable certificate to return one
   * from. This asks the narrower question both platforms can actually answer —
   * iOS by attesting the slot, Android from its slot metadata.
   *
   * FAILS CLOSED. Only the card's explicit REFERENCE DATA NOT FOUND (0x6A88)
   * reports `false`. An imported key, an overwritten attestation slot or any
   * other status reports `true`, because none of them prove the slot is empty
   * and the caller is about to destroy whatever is in it. */
  isVaultSlotOccupied(expectedSerial: string): Promise<string> // JSON {occupied}
  /** Sign a pre-computed 32-byte digest with the slot's P-256 key.
   *
   * `digest` is 64 hex chars, passed to the card UNCHANGED — no hashing on
   * either side. Resolves JSON {signature} as DER hex. TOUCH-gated. */
  signEcdsa(expectedSerial: string, pin: string, digest: string): Promise<string>
  /** Reset the whole PIV application to just-installed state. Destroys every
   * key, certificate and credential in it, Vault slot 0x82 included. Both
   * SDKs block the PIN and the PUK first — PIV requires both blocked before
   * RESET — so the card's retry counters are spent regardless of outcome.
   * Needs neither a verified PIN nor an authenticated management key. */
  resetPivApplication(expectedSerial: string): Promise<string> // JSON {ok:true}
}
