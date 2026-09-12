/**
 * DEV mock wiring: one module-held MockYubiKey that survives toggles (so the
 * keys "generated" on MOCK-DEV-1/2/3 persist within the session) and a
 * present-key selector the wallet-config DEV row drives.
 */
import { getVaultDriver } from '../../core/services/vault/driver'
import { MockYubiKey } from '../../core/services/vault/mockYubiKey'
import { getMockPresentKey, setMockDriverEnabled, setMockPresentKey } from '../../core/services/vault/devMock'

afterEach(() => setMockDriverEnabled(false))

test('enabling installs a MockYubiKey with MOCK-DEV-1 present by default', async () => {
  setMockDriverEnabled(true)
  const d = getVaultDriver()
  expect(d).toBeInstanceOf(MockYubiKey)
  expect((await d!.getKeyInfo()).serial).toBe('MOCK-DEV-1')
  expect(getMockPresentKey()).toBe('MOCK-DEV-1')
})

test('setMockPresentKey switches the present serial on the live mock', async () => {
  setMockDriverEnabled(true)
  setMockPresentKey('MOCK-DEV-2')
  expect((await getVaultDriver()!.getKeyInfo()).serial).toBe('MOCK-DEV-2')
  expect(getMockPresentKey()).toBe('MOCK-DEV-2')
})

test('keys generated on a serial survive a disable/enable cycle', async () => {
  setMockDriverEnabled(true)
  setMockPresentKey('MOCK-DEV-3')
  const { publicKey } = await getVaultDriver()!.generateVaultKey('MOCK-DEV-3')
  setMockDriverEnabled(false)
  expect(getVaultDriver()).toBeNull()
  setMockDriverEnabled(true)
  expect((await getVaultDriver()!.readVaultPublicKey('MOCK-DEV-3'))!.publicKey).toBe(publicKey)
  expect(getMockPresentKey()).toBe('MOCK-DEV-3')
})

test('selecting a key while the mock is off only records the choice', () => {
  setMockPresentKey('MOCK-DEV-2')
  expect(getVaultDriver()).toBeNull()
  expect(getMockPresentKey()).toBe('MOCK-DEV-2')
})
