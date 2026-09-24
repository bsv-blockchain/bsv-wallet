/**
 * setMockDriver is the raw DEV/test seam driver.ts exports — devMock.ts's
 * setMockDriverEnabled wraps it with its own __DEV__ guard, but the raw
 * function had none of its own, so anything with JS execution in a
 * nominally-production bundle could call it directly and getVaultDriver()
 * would prefer the mock over real hardware (reviews/vault.md F-09).
 */
import { getVaultDriver, setMockDriver } from '../../core/services/vault/driver'
import { MockYubiKey } from '../../core/services/vault/mockYubiKey'

afterEach(() => setMockDriver(null))

test('setMockDriver is a no-op outside __DEV__', () => {
  const replaced = jest.replaceProperty(globalThis as any, '__DEV__', false)
  try {
    setMockDriver(new MockYubiKey())
    expect(getVaultDriver()).not.toBeInstanceOf(MockYubiKey)
  } finally {
    replaced.restore()
  }
})

test('setMockDriver still installs the mock under __DEV__ (jest-expo default)', () => {
  expect(__DEV__).toBe(true)
  const mock = new MockYubiKey()
  setMockDriver(mock)
  expect(getVaultDriver()).toBe(mock)
})
