/**
 * DEV-only convenience: run the whole vault stack against the software mock
 * YubiKey without hardware. Toggled from wallet-config (DEV builds only).
 *
 * ONE module-held MockYubiKey: its per-serial records (generated keys, PINs)
 * survive toggling the driver off and on within the session, so a vault
 * enrolled with MOCK-DEV-1 and MOCK-DEV-2 can be exercised by switching the
 * "present" key with setMockPresentKey — the DEV wallet-config row's selector.
 * Kept in its own module so driver.ts never imports the mock.
 */
import { setMockDriver } from './driver'
import { MockYubiKey } from './mockYubiKey'

export type MockPresentKey = 'MOCK-DEV-1' | 'MOCK-DEV-2' | 'MOCK-DEV-3'

let instance: MockYubiKey | null = null
let present: MockPresentKey = 'MOCK-DEV-1'

export function setMockDriverEnabled(on: boolean): void {
  if (on) {
    if (!instance) instance = new MockYubiKey()
    instance.insertKey(present)
    setMockDriver(instance)
  } else {
    setMockDriver(null)
  }
}

/** Which of the three dev keys is "held to the phone". Applies immediately
 * when the mock is installed; otherwise remembered for the next enable. */
export function setMockPresentKey(serial: MockPresentKey): void {
  present = serial
  instance?.insertKey(serial)
}

export function getMockPresentKey(): MockPresentKey {
  return present
}
