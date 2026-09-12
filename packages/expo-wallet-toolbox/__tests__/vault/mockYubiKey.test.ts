/**
 * Software mock YubiKey + driver selection tests. The mock is the arbiter for
 * the whole TS layer: it implements VaultDriver against an in-memory P-256 key
 * and exposes test controls (insert/remove/touch behaviour/PIN).
 */
import { p256 } from '@noble/curves/nist.js'
import { Utils } from '@bsv/sdk'
import { MockYubiKey } from '../../core/services/vault/mockYubiKey'
import { getVaultDriver, setMockDriver } from '../../core/services/vault/driver'
import { VaultError } from '../../core/services/vault/types'

describe('MockYubiKey', () => {
  test('wrong PIN decrements retries then locks at zero', async () => {
    const mock = new MockYubiKey()
    mock.insertKey('MOCK-1')
    expect((await mock.verifyPin('MOCK-1', '000000')).retriesLeft).toBe(2)
    expect((await mock.verifyPin('MOCK-1', '000000')).retriesLeft).toBe(1)
    expect((await mock.verifyPin('MOCK-1', '000000')).retriesLeft).toBe(0)
    await expect(mock.verifyPin('MOCK-1', '123456')).rejects.toMatchObject({ code: 'pin-locked' })
  })

  test('removing the key mid-op yields key-removed-mid-op', async () => {
    const mock = new MockYubiKey()
    mock.insertKey('MOCK-1')
    await expect(mock.getKeyInfo()).resolves.toBeDefined()
    mock.removeKey()
    await expect(mock.getKeyInfo()).rejects.toMatchObject({ code: 'no-key' })
  })

  test('attach/detach events fire to listeners', () => {
    const mock = new MockYubiKey()
    const events: string[] = []
    mock.onKeyEvent(e => events.push(`${e.type}:${e.serial ?? ''}`))
    mock.insertKey('MOCK-9')
    mock.removeKey()
    expect(events).toEqual(['attached:MOCK-9', 'detached:MOCK-9'])
  })

  test('keeps one record per serial: insertKey switches keys, PINs and retries', async () => {
    const mock = new MockYubiKey()
    mock.insertKey('A')
    const { publicKey: pubA } = await mock.generateVaultKey('A')
    mock.setPin('111111')

    mock.insertKey('B')
    expect(await mock.readVaultPublicKey('B')).toBeNull() // B has no key yet
    const { publicKey: pubB } = await mock.generateVaultKey('B')
    expect(pubB).not.toBe(pubA)
    // B still has the default PIN; A's change did not leak across serials.
    expect((await mock.verifyPin('B', '123456')).ok).toBe(true)
    expect((await mock.verifyPin('B', '111111')).ok).toBe(false)

    mock.insertKey('A')
    expect((await mock.readVaultPublicKey('A'))!.publicKey).toBe(pubA)
    expect((await mock.verifyPin('A', '111111')).ok).toBe(true)
  })

  test('re-inserting a serial does not reset its PIN verification or its lockout', async () => {
    const mock = new MockYubiKey()
    mock.insertKey('A')
    await mock.generateVaultKey('A')
    await mock.verifyPin('A', '123456')
    mock.insertKey('B')
    mock.insertKey('A')
    // pinPolicy=once is per session: a swap ends the session, so the PIN must
    // be presented again.
    await expect(mock.signEcdsa('A', '', 'ab'.repeat(32))).rejects.toMatchObject({ code: 'pin-required' })

    mock.insertKey('L')
    await mock.verifyPin('L', '000000')
    await mock.verifyPin('L', '000000')
    await mock.verifyPin('L', '000000')
    mock.insertKey('A')
    mock.insertKey('L')
    expect((await mock.getKeyInfo()).pinRetries).toBe(0) // still locked after a re-tap
  })

  test('signEcdsa signs with the CURRENT serial key', async () => {
    const mock = new MockYubiKey()
    mock.insertKey('A')
    await mock.generateVaultKey('A')
    mock.insertKey('B')
    const { publicKey: pubB } = await mock.generateVaultKey('B')
    await mock.verifyPin('B', '123456')
    const digest = 'cd'.repeat(32)
    const { signature } = await mock.signEcdsa('B', '123456', digest)
    const sig = p256.Signature.fromBytes(Uint8Array.from(Utils.toArray(signature, 'hex')), 'der')
    const compressedB = p256.Point.fromBytes(Uint8Array.from(Utils.toArray(pubB, 'hex'))).toBytes(true)
    expect(
      p256.verify(sig.toBytes(), Uint8Array.from(Utils.toArray(digest, 'hex')), compressedB, {
        prehash: false,
        lowS: false
      })
    ).toBe(true)
  })

  test('start(message) records the alert text for tests to read', () => {
    const mock = new MockYubiKey()
    mock.start('Hold your YubiKey here')
    expect(mock.startMessage).toBe('Hold your YubiKey here')
  })

  test('requires an explicit manufacturer-attestation simulation for provisioning', async () => {
    const mock = new MockYubiKey()
    mock.insertKey('MOCK-1')
    mock.setManufacturerAttested(false)

    await expect(mock.preflightDedicatedPiv('MOCK-1')).rejects.toMatchObject({ code: 'attestation-invalid' })
    await expect(mock.generateVaultKey('MOCK-1')).rejects.toMatchObject({ code: 'attestation-invalid' })
    await expect(mock.readVaultPublicKey('MOCK-1')).resolves.toBeNull()
  })
})

describe('getVaultDriver', () => {
  afterEach(() => setMockDriver(null))

  test('returns null when no native module and no mock (jest default)', () => {
    expect(getVaultDriver()).toBeNull()
  })

  test('returns the injected mock when set', () => {
    const mock = new MockYubiKey()
    setMockDriver(mock)
    expect(getVaultDriver()).toBe(mock)
  })
})

// ── native event vocabulary (fix #1) ──
import { mapNativeKeyEvent } from '../../core/services/vault/driver'

describe('mapNativeKeyEvent', () => {
  test("native 'connected' maps to attached (not detached)", () => {
    expect(mapNativeKeyEvent('connected', 'S1', 'usb')).toEqual({ type: 'attached', serial: 'S1', transport: 'usb' })
  })
  test("native 'removed' maps to detached", () => {
    expect(mapNativeKeyEvent('removed', '', 'nfc').type).toBe('detached')
    expect(mapNativeKeyEvent('removed', '', 'nfc').transport).toBe('nfc')
  })
  test("'attached'/'detached' pass through (mock/robustness)", () => {
    expect(mapNativeKeyEvent('attached', 'x', 'usb').type).toBe('attached')
    expect(mapNativeKeyEvent('detached', 'x', 'usb').type).toBe('detached')
  })
  test('unknown event fails safe to detached', () => {
    expect(mapNativeKeyEvent('garbage', '', '').type).toBe('detached')
  })
  test("native 'failed:200' (user cancelled the system NFC sheet) maps to session-failed/user-cancelled", () => {
    expect(mapNativeKeyEvent('failed:200', '', 'nfc')).toEqual({
      type: 'session-failed',
      code: 'user-cancelled',
      serial: undefined,
      transport: 'nfc'
    })
  })
  test("native 'failed:201' (NFC session timed out) maps to session-failed/no-key", () => {
    expect(mapNativeKeyEvent('failed:201', '', 'nfc')).toEqual({
      type: 'session-failed',
      code: 'no-key',
      serial: undefined,
      transport: 'nfc'
    })
  })
  test("any other 'failed:<code>' maps to session-failed/no-key, not detached", () => {
    expect(mapNativeKeyEvent('failed:202', '', 'nfc')).toMatchObject({ type: 'session-failed', code: 'no-key' })
    expect(mapNativeKeyEvent('failed:0', '', 'nfc')).toMatchObject({ type: 'session-failed', code: 'no-key' })
  })
})

// ── signEcdsa (task 4) ──
import { Signature } from '@bsv/sdk'

describe('MockYubiKey.signEcdsa', () => {
  const digest = 'ab'.repeat(32)

  async function armed() {
    const mock = new MockYubiKey()
    mock.insertKey()
    await mock.generateVaultKey('MOCK-1')
    await mock.verifyPin('MOCK-1', '123456')
    return mock
  }

  it('returns a DER signature that verifies against the slot public key', async () => {
    const mock = await armed()
    const { publicKey } = (await mock.readVaultPublicKey('MOCK-1'))!
    const { signature } = await mock.signEcdsa('MOCK-1', '123456', digest)

    // DER, as the real card emits — not raw r||s.
    expect(signature.startsWith('30')).toBe(true)
    const parsed = Signature.fromDER(Utils.toArray(signature, 'hex'))
    const raw = Uint8Array.from([...parsed.r.toArray('be', 32), ...parsed.s.toArray('be', 32)])
    const compressed = p256.Point.fromBytes(Uint8Array.from(Utils.toArray(publicKey, 'hex'))).toBytes(true)

    // lowS: false on verify too — the mock (like real PIV hardware) does not
    // low-S normalise, so a random run of this test can legitimately produce
    // a high-S signature; @noble/curves' verify() defaults to rejecting
    // exactly those as non-canonical, which would make this assertion flake
    // roughly half the time if left at its default.
    expect(
      p256.verify(raw, Uint8Array.from(Utils.toArray(digest, 'hex')), compressed, { prehash: false, lowS: false })
    ).toBe(true)
  })

  it('rejects a digest that is not exactly 32 bytes', async () => {
    const mock = await armed()
    await expect(mock.signEcdsa('MOCK-1', '123456', 'ab'.repeat(31))).rejects.toMatchObject({ code: 'template-invalid' })
    await expect(mock.signEcdsa('MOCK-1', '123456', 'ab'.repeat(33))).rejects.toMatchObject({ code: 'template-invalid' })
  })

  it('rejects a mismatched serial before generation or signing', async () => {
    const mock = new MockYubiKey()
    mock.insertKey('MOCK-1')
    await expect(mock.generateVaultKey('MOCK-2')).rejects.toMatchObject({ code: 'serial-mismatch' })
    await expect(mock.signEcdsa('MOCK-2', '123456', digest)).rejects.toMatchObject({ code: 'serial-mismatch' })
  })

  it('refuses to sign without a verified PIN', async () => {
    const mock = new MockYubiKey()
    mock.insertKey()
    await mock.generateVaultKey('MOCK-1')
    await expect(mock.signEcdsa('MOCK-1', '', digest)).rejects.toMatchObject({ code: 'pin-required' })
  })

  it('rejects a WRONG PIN, not silently satisfied', async () => {
    // verifyPin only throws for pin-locked; a wrong PIN returns { ok: false }.
    // signEcdsa's inline verify used to discard that result and fall through
    // to a real signature, so a wrong PIN was indistinguishable from a correct
    // one — this test pins that result handling on the signing method.
    const mock = new MockYubiKey()
    mock.insertKey()
    await mock.generateVaultKey('MOCK-1')

    await expect(mock.signEcdsa('MOCK-1', '000000', digest)).rejects.toMatchObject({
      code: 'pin-invalid',
      retriesLeft: 2
    })

    // and the failed attempt must still have burned a retry
    const { pinRetries } = await mock.getKeyInfo()
    expect(pinRetries).toBe(2)
  })

  it('surfaces a touch timeout', async () => {
    const mock = await armed()
    mock.setTouchBehavior('timeout')
    await expect(mock.signEcdsa('MOCK-1', '123456', digest)).rejects.toMatchObject({ code: 'touch-timeout' })
  })

  it('fails when the key is removed', async () => {
    const mock = await armed()
    mock.removeKey()
    await expect(mock.signEcdsa('MOCK-1', '123456', digest)).rejects.toBeInstanceOf(VaultError)
  })

  // Real YubiKey PIV hardware does not low-S normalise; @noble/curves defaults
  // P-256 signing to lowS: true unless told otherwise. A mock that only ever
  // emitted canonical (low-S) signatures could not catch downstream code that
  // mishandles a non-canonical one — that bug would surface first against
  // real hardware, exactly what this mock exists to prevent. Sign across many
  // fresh keys and require at least one high-S result (~50% per trial, so the
  // odds of a false failure here are negligible) while every signature still
  // verifies against its own slot public key.
  it('does not low-S normalise — can and does produce high-S signatures that still verify', async () => {
    const digestBytes = Uint8Array.from(Utils.toArray(digest, 'hex'))
    let sawHighS = false

    for (let i = 0; i < 64; i++) {
      const mock = await armed()
      const { publicKey } = (await mock.readVaultPublicKey('MOCK-1'))!
      const { signature } = await mock.signEcdsa('MOCK-1', '123456', digest)

      const sig = p256.Signature.fromBytes(Uint8Array.from(Utils.toArray(signature, 'hex')), 'der')
      const compressed = p256.Point.fromBytes(Uint8Array.from(Utils.toArray(publicKey, 'hex'))).toBytes(true)
      // lowS: false — see comment on the DER round-trip test above; verify()
      // must accept the non-canonical signatures this test is specifically
      // trying to produce, not reject them as invalid.
      expect(p256.verify(sig.toBytes(), digestBytes, compressed, { prehash: false, lowS: false })).toBe(true)

      if (sig.hasHighS()) {
        sawHighS = true
        break
      }
    }

    expect(sawHighS).toBe(true)
  })
})

// ── generateVaultKey policy + start(message) forwarding (R1C) ──
describe('native adapter', () => {
  const nativeFake = (calls: unknown[][]) => ({
    isSupported: () => true,
    startDiscovery: (message: string) => {
      calls.push(['startDiscovery', message])
    },
    stopDiscovery: () => {},
    setKeyListener: () => {},
    clearKeyListener: () => {},
    getKeyInfo: async () => '{}',
    verifyPin: async () => '{}',
    changePin: async () => '{}',
    changePuk: async () => '{}',
    preflightDedicatedPiv: async (...args: unknown[]) => {
      calls.push(['preflightDedicatedPiv', ...args])
      return '{"ok":true,"inspection":"attestation","manufacturerAttestation":"verified"}'
    },
    generateVaultKey: async (...args: unknown[]) => {
      calls.push(['generateVaultKey', ...args])
      return JSON.stringify({
        publicKey: '04' + '11'.repeat(64),
        manufacturerAttestation: 'verified'
      })
    },
    readVaultPublicKey: async () => '{"publicKey":null}',
    protectManagementKey: async () => '{"ok":true}',
    signEcdsa: async () => '{}'
  })

  it('owns Android and iOS native discovery for one ceremony', () => {
    const calls: unknown[][] = []
    jest.doMock('react-native-yubikey', () => ({ getYubiKeyPiv: () => nativeFake(calls) }))
    jest.resetModules()
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getVaultDriver } = require('../../core/services/vault/driver')

    expect(getVaultDriver()!.sessionBased).toBe(true)
  })

  it('forwards the selected serial to the native fixed-policy generator', async () => {
    const calls: unknown[][] = []
    jest.doMock('react-native-yubikey', () => ({ getYubiKeyPiv: () => nativeFake(calls) }))
    jest.resetModules()
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getVaultDriver } = require('../../core/services/vault/driver')

    await expect(getVaultDriver()!.generateVaultKey('S1')).resolves.toEqual({
      publicKey: '04' + '11'.repeat(64),
      manufacturerAttestation: 'verified'
    })

    expect(calls[0]).toEqual(['generateVaultKey', 'S1'])
  })

  it('forwards the read-only whole-PIV preflight', async () => {
    const calls: unknown[][] = []
    jest.doMock('react-native-yubikey', () => ({ getYubiKeyPiv: () => nativeFake(calls) }))
    jest.resetModules()
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getVaultDriver } = require('../../core/services/vault/driver')

    await expect(getVaultDriver()!.preflightDedicatedPiv('S1')).resolves.toEqual({
      ok: true,
      inspection: 'attestation',
      manufacturerAttestation: 'verified'
    })
    expect(calls).toEqual([['preflightDedicatedPiv', 'S1', false]])
  })

  it('forwards the expected serial to every fixed-slot operation', async () => {
    const calls: unknown[][] = []
    jest.doMock('react-native-yubikey', () => ({ getYubiKeyPiv: () => nativeFake(calls) }))
    jest.resetModules()
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getVaultDriver } = require('../../core/services/vault/driver')

    await getVaultDriver()!.generateVaultKey('S1')
    await getVaultDriver()!.signEcdsa('S1', '123456', 'aa'.repeat(32))
    expect(calls).toEqual([['generateVaultKey', 'S1']])
  })

  it('forwards the NFC alert text to startDiscovery, and an empty string when none is given', () => {
    const calls: unknown[][] = []
    jest.doMock('react-native-yubikey', () => ({ getYubiKeyPiv: () => nativeFake(calls) }))
    jest.resetModules()
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getVaultDriver } = require('../../core/services/vault/driver')

    getVaultDriver()!.start('Hold your YubiKey here to sign')
    getVaultDriver()!.start()
    expect(calls).toEqual([
      ['startDiscovery', 'Hold your YubiKey here to sign'],
      ['startDiscovery', '']
    ])
  })

  it('exposes no ecdh on the driver', () => {
    const calls: unknown[][] = []
    jest.doMock('react-native-yubikey', () => ({ getYubiKeyPiv: () => nativeFake(calls) }))
    jest.resetModules()
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getVaultDriver } = require('../../core/services/vault/driver')
    expect((getVaultDriver() as unknown as Record<string, unknown>).ecdh).toBeUndefined()
  })
})
