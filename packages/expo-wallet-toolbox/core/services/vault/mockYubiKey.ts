/**
 * Software YubiKey for development and tests.
 *
 * Implements VaultDriver against in-memory P-256 keypairs — ONE RECORD PER
 * SERIAL, so a test (or the DEV present-key selector) can stand in for a
 * multi-key vault by switching serials with insertKey(). Emulates the
 * behaviours the real ceremony must survive: PIN retries and lockout per key,
 * touch timeouts, key removal mid-operation, and DER signatures exactly like
 * both real platforms (not low-S normalised).
 *
 * DEV/test only. Never bundled into a path a production user reaches.
 */
import { p256 } from '@noble/curves/nist.js'
import { Utils } from '@bsv/sdk'
import { VaultDriver, KeyEvent } from './driver'
import { VaultError } from './types'

type TouchBehavior = 'instant' | 'timeout'

const DEFAULT_PIN = '123456'
const DEFAULT_PUK = '12345678'
const VAULT_SLOT = 0x82
const PIV_CODE = /^[0-9]{6,8}$/

function requirePivCode(value: string, label: 'PIN' | 'PUK'): void {
  if (!PIV_CODE.test(value)) throw new VaultError('template-invalid', `PIV ${label} must be 6 to 8 ASCII digits`)
}

interface MockKeyRecord {
  priv: Uint8Array | null
  pub: string | null
  pin: string
  pinRetries: number
  pinVerified: boolean
  puk: string
  pukRetries: number
  managementProtected: boolean
  /** Explicit DEV/test simulation of the native manufacturer chain gate. */
  manufacturerAttested: boolean
  otherPivSlotOccupied: boolean
}

const freshRecord = (): MockKeyRecord => ({
  priv: null,
  pub: null,
  pin: DEFAULT_PIN,
  pinRetries: 3,
  pinVerified: false,
  puk: DEFAULT_PUK,
  pukRetries: 3,
  managementProtected: false,
  manufacturerAttested: true,
  otherPivSlotOccupied: false
})

export class MockYubiKey implements VaultDriver {
  private listeners = new Set<(e: KeyEvent) => void>()
  private present = false
  private serial = 'MOCK-1'
  private keys = new Map<string, MockKeyRecord>()
  private touch: TouchBehavior = 'instant'
  private lastStartMessage: string | undefined

  /** The current serial's record, created on first use. */
  private record(): MockKeyRecord {
    let r = this.keys.get(this.serial)
    if (!r) {
      r = freshRecord()
      this.keys.set(this.serial, r)
    }
    return r
  }

  // ---- test controls ---------------------------------------------------
  /** Present the key with this serial (creating its record on first use). A
   * swap ends the previous session, so PIN verification resets; the record's
   * own PIN and lockout state persist like a real card's would. */
  insertKey(serial = 'MOCK-1'): void {
    if (this.present) this.record().pinVerified = false
    this.serial = serial
    this.present = true
    this.record().pinVerified = false
    this.emit({ type: 'attached', serial, transport: 'mock' })
  }

  removeKey(): void {
    if (!this.present) return
    const serial = this.serial
    this.present = false
    this.record().pinVerified = false
    this.emit({ type: 'detached', serial, transport: 'mock' })
  }

  setTouchBehavior(b: TouchBehavior): void {
    this.touch = b
  }

  /** Set the CURRENT serial's PIN. */
  setPin(pin: string): void {
    this.record().pin = pin
  }

  /** Simulate the NFC session dying before any key connected — the system
   * scan sheet being cancelled (user-cancelled) or timing out / failing to
   * present (no-key). Mirrors the real adapter's `failed:<code>` events from
   * the native didFailConnectingNFC handler. */
  failSession(code: 'user-cancelled' | 'no-key'): void {
    this.emit({ type: 'session-failed', code, transport: 'mock' })
  }

  /** Simulate a slot that already holds a key on the current serial (e.g. an
   * age-plugin-yubikey identity in retired slot 82). generateVaultKey replaces
   * it — spec D6 never adopts an existing key. */
  occupySlot(): void {
    const r = this.record()
    r.priv = p256.utils.randomSecretKey()
    r.pub = Utils.toHex(Array.from(p256.getPublicKey(r.priv, false)))
  }

  /** Simulate an unrelated certificate/key in any other user PIV slot. */
  occupyOtherPivSlot(): void {
    this.record().otherPivSlotOccupied = true
  }

  /** DEV/test only: simulate a missing, overwritten, or unknown factory F9
   * certificate. Production never gets this software driver. */
  setManufacturerAttested(attested: boolean): void {
    this.record().manufacturerAttested = attested
  }

  /** The last NFC alert text passed to start(), for tests. */
  get startMessage(): string | undefined {
    return this.lastStartMessage
  }

  // ---- VaultDriver -----------------------------------------------------
  isSupported(): boolean {
    return true
  }

  /** The mock behaves like a persistent reader (insert/remove under test). */
  sessionBased = false

  start(message?: string): void {
    this.lastStartMessage = message
    // Session-based flows (NFC) call start() to open a scan session and wait
    // for the tap to connect. Simulate that: if a key is "held", emit attached
    // now. Persistent flows never rely on this (they see the key via getKeyInfo).
    if (this.sessionBased && this.present) {
      this.emit({ type: 'attached', serial: this.serial, transport: 'mock' })
    }
  }

  stop(): void {
    // Matches the real adapter's contract (driver.ts adaptNative.stop): do NOT
    // clear listeners. App subscribers (WalletContext, and the ceremony's own
    // mid-flight NFC retry/batch loop) stay subscribed across a session-based
    // transport's stop/start cycles.
  }

  onKeyEvent(cb: (e: KeyEvent) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  async getKeyInfo(): Promise<{ serial: string; firmwareVersion: string; pinRetries: number }> {
    this.requirePresent()
    return { serial: this.serial, firmwareVersion: '5.7.1', pinRetries: this.record().pinRetries }
  }

  async verifyPin(expectedSerial: string, pin: string): Promise<{ ok: boolean; retriesLeft: number }> {
    requirePivCode(pin, 'PIN')
    this.requireExpectedSerial(expectedSerial)
    const r = this.record()
    if (r.pinRetries <= 0) throw new VaultError('pin-locked', 'PIN is blocked')
    if (pin === r.pin) {
      r.pinRetries = 3
      r.pinVerified = true
      return { ok: true, retriesLeft: 3 }
    }
    r.pinRetries -= 1
    r.pinVerified = false
    return { ok: false, retriesLeft: r.pinRetries }
  }

  async changePin(expectedSerial: string, oldPin: string, newPin: string): Promise<{ ok: boolean; retriesLeft: number }> {
    requirePivCode(oldPin, 'PIN')
    requirePivCode(newPin, 'PIN')
    this.requireExpectedSerial(expectedSerial)
    const r = this.record()
    if (r.pinRetries <= 0) throw new VaultError('pin-locked', 'PIN is blocked')
    if (oldPin !== r.pin) {
      r.pinRetries -= 1
      throw new VaultError('pin-invalid', 'Wrong PIN', r.pinRetries)
    }
    r.pin = newPin
    r.pinRetries = 3
    return { ok: true, retriesLeft: 3 }
  }

  async changePuk(expectedSerial: string, oldPuk: string, newPuk: string): Promise<{ ok: boolean; retriesLeft: number }> {
    requirePivCode(oldPuk, 'PUK')
    requirePivCode(newPuk, 'PUK')
    this.requireExpectedSerial(expectedSerial)
    const r = this.record()
    if (r.pukRetries <= 0) throw new VaultError('puk-locked', 'PUK is blocked')
    if (oldPuk !== r.puk) {
      r.pukRetries -= 1
      throw new VaultError('puk-invalid', 'Wrong PUK', r.pukRetries)
    }
    r.puk = newPuk
    r.pukRetries = 3
    return { ok: true, retriesLeft: 3 }
  }

  async preflightDedicatedPiv(expectedSerial: string, allowOccupiedVaultSlot = false): Promise<{
    ok: true
    inspection: 'metadata'
    manufacturerAttestation: 'verified'
  }> {
    this.requireExpectedSerial(expectedSerial)
    const r = this.record()
    if (!r.manufacturerAttested) {
      throw new VaultError('attestation-invalid', 'Factory manufacturer attestation is not trusted')
    }
    if (r.managementProtected) throw new VaultError('mgmt-key-custom', 'Default management key rejected')
    if ((!allowOccupiedVaultSlot && r.priv) || r.otherPivSlotOccupied) {
      throw new VaultError('slot-occupied', 'The PIV application already contains a user key')
    }
    return { ok: true, inspection: 'metadata', manufacturerAttestation: 'verified' }
  }

  async generateVaultKey(expectedSerial: string): Promise<{
    publicKey: string
    manufacturerAttestation: 'verified'
  }> {
    this.requireExpectedSerial(expectedSerial)
    const r = this.record()
    if (r.managementProtected) throw new VaultError('mgmt-key-custom', 'Management key is protected')
    if (!r.manufacturerAttested) {
      throw new VaultError('attestation-invalid', 'Generated key manufacturer attestation failed')
    }
    r.priv = p256.utils.randomSecretKey()
    r.pub = Utils.toHex(Array.from(p256.getPublicKey(r.priv, false)))
    return { publicKey: r.pub, manufacturerAttestation: 'verified' }
  }

  async protectManagementKey(expectedSerial: string): Promise<{ ok: true }> {
    this.requireExpectedSerial(expectedSerial)
    const r = this.record()
    if (r.managementProtected) throw new VaultError('mgmt-key-custom', 'Management key is already protected')
    r.managementProtected = true
    return { ok: true }
  }

  async readVaultPublicKey(expectedSerial: string): Promise<{ publicKey: string } | null> {
    this.requireExpectedSerial(expectedSerial)
    const r = this.record()
    return r.pub ? { publicKey: r.pub } : null
  }

  /** Software stand-in for the card's GENERAL AUTHENTICATE.
   *
   * Emits DER, exactly like both real platforms, so a DER-parsing bug cannot
   * hide behind the mock. Enforces the same 32-byte digest rule the native
   * modules do — on iOS an unrecognised algorithm constant silently signs 32
   * ZERO bytes, and on Android an over-long payload is silently truncated.
   *
   * `lowS: false` is passed explicitly: real YubiKey PIV hardware does not
   * normalise — roughly half of real signatures are high-S — and the R1C
   * script accepts both (spec §2.5). A mock that only emitted low-S could not
   * catch downstream code that mishandles a non-canonical signature.
   */
  async signEcdsa(expectedSerial: string, pin: string, digest: string): Promise<{ signature: string }> {
    this.requireExpectedSerial(expectedSerial)
    const r = this.record()
    if (!r.pinVerified) {
      if (!pin) throw new VaultError('pin-required', 'PIN required before signing')
      requirePivCode(pin, 'PIN')
      const res = await this.verifyPin(expectedSerial, pin)
      if (!res.ok) {
        if (res.retriesLeft <= 0) throw new VaultError('pin-locked', 'PIN is blocked', 0)
        throw new VaultError('pin-invalid', 'Wrong PIN', res.retriesLeft)
      }
    }
    if (!r.priv) throw new VaultError('no-key', 'No key in slot')

    const bytes = Utils.toArray(digest, 'hex')
    if (bytes.length !== 32) {
      throw new VaultError('template-invalid', `Digest must be 32 bytes, got ${bytes.length}`)
    }
    if (this.touch === 'timeout') throw new VaultError('touch-timeout', 'Touch not detected')

    const raw = p256.sign(Uint8Array.from(bytes), r.priv, { prehash: false, lowS: false })
    const der = p256.Signature.fromBytes(raw).toBytes('der')
    return { signature: Utils.toHex(Array.from(der)) }
  }

  // ---- internals -------------------------------------------------------
  private requirePresent(): void {
    if (!this.present) throw new VaultError('no-key', 'No YubiKey present')
  }

  private requireExpectedSerial(expectedSerial: string): void {
    if (!/^[A-Za-z0-9._:-]{1,64}$/.test(expectedSerial)) {
      throw new VaultError('template-invalid', 'Invalid expected YubiKey serial')
    }
    this.requirePresent()
    if (this.serial !== expectedSerial) {
      throw new VaultError('serial-mismatch', `Presented key ${this.serial}, expected ${expectedSerial}`, undefined, {
        tapped: this.serial,
        chosen: expectedSerial
      })
    }
  }

  private emit(e: KeyEvent): void {
    this.listeners.forEach(cb => cb(e))
  }
}
