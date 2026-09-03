/**
 * `HeaderStore.append` validates every header in a chunk on the JS thread —
 * two SHA-256 passes and a difficulty check each. At the default 2,000-header
 * chunk that was ~2.8s of solid JS on a mid-range Android, repeated ~30 times
 * on a first-launch sync of 57,754 headers (2026-09-02 logs). Nothing else
 * ran: a nearby payment's ack missed the payer's 20s window and the payee's
 * screen froze. The loop must hand the event loop back periodically.
 */
import { HeaderStore } from '../../core/headers/headerStore'
import { memoryHeaderFs } from '../../core/headers/fs'
import { Utils } from '@bsv/sdk'

const TTN_ANCHOR = { height: 0, hash: '000000000499eabba0a88f5b3747231c74b9191c1a4a04b2c2ea817976b7776d' }
// prettier-ignore
const TTN_1_AND_2 = '000000206d77b7767981eac2b2044a1a1c19b9741c2347375b8fa8a0bbea990400000000f824a7d1f9f896347f9b5272b0ba7db7af6934d02fa94ed9c8545b70e90e652e0dcaa468ffff001dd21635fa000000204bd109783c507e98b9da565c304e1313b085a54e0d4618ccf1e3d8b000000000fc8f1cc1c283eb968aea8d6217ce8e1868c4dd1bc90dc4afeeba622e21de176817caa468ffff001d05d356b3'

const bytes = () => new Uint8Array(Utils.toArray(TTN_1_AND_2, 'hex'))

describe('HeaderStore.append yielding', () => {
  it('lets a queued macrotask run before a chunk finishes validating', async () => {
    const store = await HeaderStore.open(memoryHeaderFs(), 'ttn', TTN_ANCHOR)
    store.yieldEvery = 1

    // Queued BEFORE append: if append never yields, this only runs after the
    // awaited append has already resolved, and the flag is still false below.
    let ranDuringAppend = false
    setTimeout(() => {
      ranDuringAppend = true
    }, 0)

    const added = await store.append(bytes(), 1)
    expect(added).toBe(2)
    expect(ranDuringAppend).toBe(true)
  })

  it('does not yield inside a chunk smaller than the cadence', async () => {
    const store = await HeaderStore.open(memoryHeaderFs(), 'ttn', TTN_ANCHOR)
    store.yieldEvery = 100

    let ranDuringAppend = false
    setTimeout(() => {
      ranDuringAppend = true
    }, 0)

    await store.append(bytes(), 1)
    // memoryHeaderFs writes are microtask-only, so a two-header append with a
    // 100-header cadence completes without ever reaching the macrotask queue.
    expect(ranDuringAppend).toBe(false)
  })

  it('defaults to a cadence that keeps each validation slice short', () => {
    // 100 headers ≈ 140ms on the device that produced the 2.8s stalls: well
    // under a BLE ack budget and short enough that a tap still lands.
    expect(HeaderStore.DEFAULT_YIELD_EVERY).toBe(100)
  })
})
