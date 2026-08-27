// Pulled in as a side effect of importing anything from the barrel: its
// LocalStorageProvider chain reaches these native modules at module top level.
jest.mock('expo-local-authentication', () => ({
  getEnrolledLevelAsync: jest.fn(async () => 0),
  hasHardwareAsync: jest.fn(async () => false),
  isEnrolledAsync: jest.fn(async () => false),
  authenticateAsync: jest.fn(async () => ({ success: false })),
  SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
  AuthenticationType: { FINGERPRINT: 1, FACIAL_RECOGNITION: 2, IRIS: 3 }
}))
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
  WHEN_UNLOCKED: 'wu',
  AFTER_FIRST_UNLOCK: 'afu',
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'afudo',
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'wudo'
}))

import { springs, durations } from '@bsv/expo-wallet-toolbox'

describe('motion tokens', () => {
  it('defines the two approved springs', () => {
    expect(springs.snappy).toEqual({ mass: 1, stiffness: 380, damping: 36 })
    expect(springs.settle).toEqual({ mass: 1, stiffness: 280, damping: 32 })
  })
  it('caps every duration at 350ms (Quiet Precision)', () => {
    expect(durations.instant).toBe(150)
    expect(durations.quick).toBe(250)
    expect(durations.moderate).toBe(350)
    Object.values(durations).forEach(d => expect(d).toBeLessThanOrEqual(350))
  })
})
