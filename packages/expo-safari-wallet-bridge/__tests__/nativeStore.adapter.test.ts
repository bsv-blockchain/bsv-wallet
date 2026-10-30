import { Utils } from '@bsv/sdk'
import { createNativeInboxStore } from '../src/nativeStore'
import { createFakeNative } from '../src/testing/fakeNative'
import type { BsvBridgeNative } from '../shared/native'

const ID = '00000000-0000-4000-8000-000000000001'
const bytes = (s: string) => Uint8Array.from(Utils.toArray(s, 'utf8'))

describe('native adapter', () => {
  it('bootId and sync members come from init', async () => {
    const fake = createFakeNative()
    const init = await fake.init({ nowMs: 1 })
    const store = createNativeInboxStore(fake, { now: () => 1, bootId: init.bootId })
    expect(init.bootId).toBeTruthy()
    expect(store.bootId()).toBe(init.bootId)
    expect(store.bootId()).toBe(store.bootId())
  })

  it('adapter has no rawBytes', async () => {
    const fake = createFakeNative()
    const { bootId } = await fake.init({ nowMs: 1 })
    expect('rawBytes' in createNativeInboxStore(fake, { now: () => 1, bootId })).toBe(false)
  })

  it('native failures map to contract return values (missing file is undefined)', async () => {
    const notFound = Object.assign(new Error('nope'), { code: 'ERR_NOT_FOUND' })
    const native = {
      read: jest.fn().mockRejectedValue(notFound),
      stat: jest.fn().mockRejectedValue(notFound),
      accept: jest.fn().mockRejectedValue(notFound),
      claim: jest.fn().mockRejectedValue(notFound),
      readResult: jest.fn().mockRejectedValue(notFound),
      ack: jest.fn().mockRejectedValue(notFound)
    } as unknown as BsvBridgeNative
    const store = createNativeInboxStore(native, { now: () => 1, bootId: 'b' })
    expect(await store.read(ID)).toBeUndefined()
    expect(await store.stat(ID)).toBeUndefined()
    expect(await store.accept(ID)).toBe(false)
    expect(await store.claim(ID, 'd')).toBe('not-accepted')
    expect(await store.readResult(ID)).toEqual({ kind: 'none' })
    await expect(store.ack(ID)).resolves.toBeUndefined()
  })

  it("real failures rethrow so the processor's warning path runs", async () => {
    const boom = Object.assign(new Error('disk'), { code: 'ERR_UNAVAILABLE' })
    const native = {
      writeResult: jest.fn().mockRejectedValue(boom),
      read: jest.fn().mockRejectedValue(boom),
      ack: jest.fn().mockRejectedValue(boom)
    } as unknown as BsvBridgeNative
    const store = createNativeInboxStore(native, { now: () => 1, bootId: 'b' })
    await expect(store.writeResult(ID, bytes('r'))).rejects.toBe(boom)
    await expect(store.read(ID)).rejects.toBe(boom)
    await expect(store.ack(ID)).rejects.toBe(boom)
  })

  it('writes after reset reject until init', async () => {
    const fake = createFakeNative()
    const first = await fake.init({ nowMs: 1 })
    const store = createNativeInboxStore(fake, { now: () => 1, bootId: first.bootId })
    expect(await store.create(ID, bytes('a'))).toBe(true)
    fake.reset()
    await expect(store.create(ID, bytes('a'))).rejects.toMatchObject({ code: 'ERR_RESET' })
    await expect(store.writeResult(ID, bytes('r'))).rejects.toMatchObject({ code: 'ERR_RESET' })
    await expect(fake.writeMirror('AA==')).rejects.toMatchObject({ code: 'ERR_RESET' })
    const second = await fake.init({ nowMs: 2 })
    expect(second.bootId).not.toBe(first.bootId)
    const fresh = createNativeInboxStore(fake, { now: () => 1, bootId: second.bootId })
    // The container was emptied: the old id is gone and can be staged again.
    expect(await fresh.stat(ID)).toBeUndefined()
    expect(await fresh.create(ID, bytes('a'))).toBe(true)
  })
})
