/**
 * withKeySession — the one-tap bracket enrollment runs inside. It used to wait
 * forever when the NFC sheet was cancelled or died; it now rejects (spec §3.3
 * step 2): session-failed → user-cancelled / no-key, detached before `work`
 * resolves → key-removed-mid-op, silence past the watchdog → no-key.
 */
import { MockYubiKey } from '../../core/services/vault/mockYubiKey'
import { withKeySession } from '../../core/services/vault/session'

const nfcMock = (): MockYubiKey => {
  const m = new MockYubiKey()
  ;(m as unknown as { sessionBased: boolean }).sessionBased = true
  return m
}
const flush = () => new Promise<void>(r => setTimeout(r, 0))

describe('withKeySession', () => {
  test('persistent reader: runs work immediately, no start/stop', async () => {
    const m = new MockYubiKey()
    const startSpy = jest.spyOn(m, 'start')
    const stopSpy = jest.spyOn(m, 'stop')
    expect(await withKeySession(m, async () => 42)).toBe(42)
    expect(startSpy).not.toHaveBeenCalled()
    expect(stopSpy).not.toHaveBeenCalled()
  })

  test('NFC: waits for attach, runs work, then stops; forwards the alert text', async () => {
    const m = nfcMock()
    const stopSpy = jest.spyOn(m, 'stop')
    const order: string[] = []
    const p = withKeySession(
      m,
      async () => {
        order.push('work')
        return 'ok'
      },
      () => order.push('waiting'),
      { nfcMessage: 'Hold your YubiKey here to set it up' }
    )
    await flush()
    expect(m.startMessage).toBe('Hold your YubiKey here to set it up')
    m.insertKey('MOCK-1')
    expect(await p).toBe('ok')
    expect(order).toEqual(['waiting', 'work'])
    expect(stopSpy).toHaveBeenCalledTimes(1)
  })

  test('NFC: the user cancelling the system sheet rejects with user-cancelled and stops', async () => {
    const m = nfcMock()
    const stopSpy = jest.spyOn(m, 'stop')
    const p = withKeySession(m, async () => 'never')
    await flush()
    m.failSession('user-cancelled')
    await expect(p).rejects.toMatchObject({ code: 'user-cancelled' })
    expect(stopSpy).toHaveBeenCalledTimes(1)
  })

  test('NFC: a session dying with no key rejects with no-key', async () => {
    const m = nfcMock()
    const p = withKeySession(m, async () => 'never')
    await flush()
    m.failSession('no-key')
    await expect(p).rejects.toMatchObject({ code: 'no-key' })
  })

  test('NFC: the key detaching while work is in flight rejects with key-removed-mid-op', async () => {
    const m = nfcMock()
    let finish!: () => void
    const p = withKeySession(m, () => new Promise<string>(resolve => {
      finish = () => resolve('late')
    }))
    await flush()
    m.insertKey('MOCK-1')
    await flush()
    m.removeKey()
    await expect(p).rejects.toMatchObject({ code: 'key-removed-mid-op' })
    finish() // the abandoned work settling later changes nothing
  })

  test('NFC: silence past attachTimeoutMs rejects with no-key', async () => {
    const m = nfcMock()
    const p = withKeySession(m, async () => 'never', undefined, { attachTimeoutMs: 30 })
    await expect(p).rejects.toMatchObject({ code: 'no-key' })
  })

  test('NFC: a detach AFTER work resolved is ignored', async () => {
    const m = nfcMock()
    const p = withKeySession(m, async () => 'done')
    await flush()
    m.insertKey('MOCK-1')
    expect(await p).toBe('done')
    expect(() => m.removeKey()).not.toThrow()
  })
})
