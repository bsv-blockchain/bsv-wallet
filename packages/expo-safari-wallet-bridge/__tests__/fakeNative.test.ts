import { Utils } from '@bsv/sdk'
import { createFakeNative } from '../src/testing/fakeNative'
import { connectedHash } from '../shared/mirror'

const ID = '00000000-0000-4000-8000-000000000001'
const b64 = (s: string) => Utils.toBase64(Utils.toArray(s, 'utf8'))

describe('fakeNative', () => {
  it('injected clock drives the 15 minute purge', async () => {
    let t = 1_000_000
    const fake = createFakeNative({ now: () => t })
    await fake.init({ nowMs: t })
    await fake.create(ID, b64('a'), t)
    await fake.writeResult(ID, b64('r'), t)
    t += 14 * 60_000
    expect((await fake.readResult(ID, t)).kind).toBe('result')
    t += 2 * 60_000
    expect(await fake.readResult(ID, t)).toEqual({ kind: 'purged' })
  })

  it('seals the mirror at rest and returns it to the test hook', async () => {
    const fake = createFakeNative()
    await fake.init({ nowMs: 1 })
    expect(fake.readMirrorSync()).toBeNull()
    await fake.writeMirror(b64('MIRROR-MARKER'))
    const raw = fake.rawBytesSync()
    expect(Utils.toUTF8(Array.from(raw[raw.length - 1])).includes('MIRROR-MARKER')).toBe(false)
    expect(Utils.toUTF8(Array.from(fake.readMirrorSync() as Uint8Array))).toBe('MIRROR-MARKER')
  })

  it('nudges reach subscribers until they unsubscribe', () => {
    const fake = createFakeNative()
    const cb = jest.fn()
    const off = fake.subscribeNudge(cb)
    fake.fireNudge()
    off()
    fake.fireNudge()
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('refuses calls before init', async () => {
    const fake = createFakeNative()
    await expect(fake.create(ID, b64('a'), 1)).rejects.toMatchObject({ code: 'ERR_UNAVAILABLE' })
  })
})

describe('connectedHash', () => {
  it('is the hex SHA-256 of the domain-separated origin', () => {
    expect(connectedHash('https://example.com')).toMatch(/^[0-9a-f]{64}$/)
    expect(connectedHash('https://example.com')).not.toBe(connectedHash('https://example.org'))
  })
})
