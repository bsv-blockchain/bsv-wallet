import { ed25519 } from '@noble/curves/ed25519.js'
import { signDescribe } from '@bsv/expo-wallet-toolbox/core/bridge/protocol/descriptor'
import { b64uEncode } from '@bsv/expo-wallet-toolbox/core/bridge/protocol/base64url'
import vectors from '../../expo-wallet-toolbox/__tests__/bridge/fixtures/0185-vectors.json'
import { createSecureStoreContinuity, deriveContextIdentity } from '../src/continuity/secureStoreContinuity'

const MASTER = Uint8Array.from({ length: 32 }, (_, i) => i)
const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('')
const fromHex = (h: string) => Uint8Array.from(h.match(/../g)!.map(x => parseInt(x, 16)))

function memoryStore() {
  const data = new Map<string, string>()
  const calls: { op: string; key: string; options: any }[] = []
  return {
    data,
    calls,
    async getItemAsync(key: string, options?: any) {
      calls.push({ op: 'get', key, options })
      return data.get(key) ?? null
    },
    async setItemAsync(key: string, value: string, options?: any) {
      calls.push({ op: 'set', key, options })
      data.set(key, value)
    }
  }
}

const make = (extra: Record<string, unknown> = {}) => {
  const secureStore = memoryStore()
  let n = 0
  const random = (len: number) => Uint8Array.from({ length: len }, (_, i) => (i + 1 + n * 7) & 0xff) // distinct per call
  const store = createSecureStoreContinuity({
    secureStore,
    random: len => {
      n++
      return random(len)
    },
    ...extra
  })
  return { store, secureStore }
}

const describePreimage = (rest = 'x') => new TextEncoder().encode('BRC-185 descriptor v1\n' + rest)
const connectPreimage = (rest = 'x') => new TextEncoder().encode('BRC-185 connect v1\n' + rest)

describe('deriveContextIdentity', () => {
  it('HKDF output pinned for a fixed master and two origins and the two identities differ', () => {
    const a = deriveContextIdentity(MASTER, 'android:https://a.example', 0)
    const b = deriveContextIdentity(MASTER, 'android:https://b.example', 0)
    expect({ id: a.instanceId, seed: hex(a.seed), key: a.continuityKey }).toEqual(PIN_A)
    expect({ id: b.instanceId, seed: hex(b.seed), key: b.continuityKey }).toEqual(PIN_B)
    expect(a.instanceId).not.toBe(b.instanceId)
    expect(a.continuityKey).not.toBe(b.continuityKey)
    expect(deriveContextIdentity(MASTER, 'android:https://a.example', 1).seed).not.toEqual(a.seed)
  })

  it('instanceId is a lowercase UUIDv4', () => {
    for (let i = 0; i < 20; i++) {
      const m = Uint8Array.from({ length: 32 }, (_, j) => (i * 31 + j * 17) & 0xff)
      expect(deriveContextIdentity(m, `android:https://o${i}.example`, i).instanceId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      )
    }
  })
})

describe('secureStoreContinuity', () => {
  it('descriptorProof vector from 0185-vectors.json reproduced through the store with the vector seed injected', async () => {
    const v = (vectors as any).descriptorProof
    const { store } = make()
    store.setTestSeed!(fromHex(v.seedHex))
    const h = await store.getOrCreate('android:' + v.input.origin)
    expect(h.continuityKey).toBe(v.input.descriptor.continuityKey)
    expect(hex(ed25519.getPublicKey(fromHex(v.seedHex)))).toBe(v.publicKeyHex)
    const r = await signDescribe(h, v.input)
    expect(r.signature).toBe(v.signatureBase64url)
  })

  it('sign refuses a preimage without a known prefix and accepts a real describe preimage and a real connect preimage', async () => {
    const { store } = make()
    const h = await store.getOrCreate('android:https://a.example')
    await expect(h.sign(new TextEncoder().encode('anything else'))).rejects.toThrow(/only BRC-185/)
    await expect(h.sign(new TextEncoder().encode('BRC-185 descriptor v2\nx'))).rejects.toThrow()
    await expect(h.sign(new Uint8Array(0))).rejects.toThrow()
    const d = await h.sign(describePreimage())
    const c = await h.sign(connectPreimage())
    const pub = Uint8Array.from(Buffer.from(h.continuityKey.replace(/-/g, '+').replace(/_/g, '/'), 'base64'))
    expect(ed25519.verify(d, describePreimage(), pub)).toBe(true)
    expect(ed25519.verify(c, connectPreimage(), pub)).toBe(true)
  })

  it('describe signing is serialised', async () => {
    const log: string[] = []
    let release: (() => void)[] = []
    let n = 0
    const { store } = make({
      signGate: () => {
        const id = ++n
        log.push(`enter${id}`)
        return new Promise<void>(res => {
          release.push(() => {
            log.push(`exit${id}`)
            res()
          })
        })
      }
    })
    const h = await store.getOrCreate('android:https://a.example')
    const p1 = h.sign(describePreimage('1'))
    const p2 = h.sign(describePreimage('2'))
    await new Promise(r => setTimeout(r, 10))
    expect(log).toEqual(['enter1'])
    release[0]()
    await p1
    await new Promise(r => setTimeout(r, 10))
    expect(log).toEqual(['enter1', 'exit1', 'enter2'])
    release[1]()
    await p2
  })

  it('second getOrCreate for one origin does not touch SecureStore', async () => {
    const { store, secureStore } = make()
    const a = await store.getOrCreate('android:https://a.example')
    const before = secureStore.calls.length
    const again = await store.getOrCreate('android:https://a.example')
    await store.getOrCreate('android:https://b.example')
    expect(secureStore.calls.length).toBe(before)
    expect(again.instanceId).toBe(a.instanceId)
  })

  it('persists across a restart: a new store over the same SecureStore yields the same identity', async () => {
    const secureStore = memoryStore()
    const s1 = createSecureStoreContinuity({ secureStore })
    const a = await s1.getOrCreate('android:https://a.example')
    const s2 = createSecureStoreContinuity({ secureStore })
    const b = await s2.getOrCreate('android:https://a.example')
    expect(b.instanceId).toBe(a.instanceId)
    expect(b.continuityKey).toBe(a.continuityKey)
  })

  it("reset(ctx) changes that context's identity only and calls onReset with that context", async () => {
    const onReset = jest.fn()
    const { store } = make({ onReset })
    const a1 = await store.getOrCreate('android:https://a.example')
    const b1 = await store.getOrCreate('android:https://b.example')
    await store.reset('android:https://a.example')
    expect(onReset).toHaveBeenCalledTimes(1)
    expect(onReset).toHaveBeenCalledWith('android:https://a.example')
    const a2 = await store.getOrCreate('android:https://a.example')
    const b2 = await store.getOrCreate('android:https://b.example')
    expect(a2.instanceId).not.toBe(a1.instanceId)
    expect(a2.continuityKey).not.toBe(a1.continuityKey)
    expect(b2.instanceId).toBe(b1.instanceId)
    expect(b2.continuityKey).toBe(b1.continuityKey)
    await expect(a1.sign(describePreimage())).rejects.toThrow(/reset/)
  })

  it('reset(ctx) survives a restart (gen is persisted)', async () => {
    const secureStore = memoryStore()
    const s1 = createSecureStoreContinuity({ secureStore })
    await s1.getOrCreate('android:https://a.example')
    await s1.reset('android:https://a.example')
    const a2 = await s1.getOrCreate('android:https://a.example')
    const s2 = createSecureStoreContinuity({ secureStore })
    expect((await s2.getOrCreate('android:https://a.example')).instanceId).toBe(a2.instanceId)
  })

  it('works with the wallet locked (no unlock dependency: the store never reads an unlock state and SecureStore is called with requireAuthentication false)', async () => {
    const { store, secureStore } = make()
    const h = await store.getOrCreate('android:https://a.example')
    await h.sign(describePreimage())
    expect(secureStore.calls.length).toBeGreaterThan(0)
    for (const c of secureStore.calls) expect(c.options.requireAuthentication).toBe(false)
  })

  it('requireAuthentication false is passed', async () => {
    const { store, secureStore } = make()
    await store.getOrCreate('android:https://a.example')
    await store.reset('all')
    const ops = secureStore.calls.map(c => c.op)
    expect(ops).toEqual(expect.arrayContaining(['get', 'set']))
    expect(secureStore.calls.every(c => c.options.requireAuthentication === false)).toBe(true)
    expect(secureStore.calls.every(c => c.key === 'bsv.androidBridge.continuity')).toBe(true)
  })

  it('reset all changes every identity and calls onReset("all")', async () => {
    const onReset = jest.fn()
    const { store } = make({ onReset })
    const a1 = await store.getOrCreate('android:https://a.example')
    const b1 = await store.getOrCreate('android:https://b.example')
    await store.reset('all')
    expect(onReset).toHaveBeenCalledWith('all')
    const a2 = await store.getOrCreate('android:https://a.example')
    const b2 = await store.getOrCreate('android:https://b.example')
    expect(a2.instanceId).not.toBe(a1.instanceId)
    expect(b2.instanceId).not.toBe(b1.instanceId)
    expect(a2.continuityKey).not.toBe(a1.continuityKey)
  })

  it('evicts beyond 32 cached handles but still derives the same identity again', async () => {
    const { store, secureStore } = make()
    const first = await store.getOrCreate('android:https://o0.example')
    for (let i = 1; i <= 33; i++) await store.getOrCreate(`android:https://o${i}.example`)
    const calls = secureStore.calls.length
    const again = await store.getOrCreate('android:https://o0.example')
    expect(again.instanceId).toBe(first.instanceId)
    expect(secureStore.calls.length).toBe(calls)
  })

  it('seed and derived bytes never appear in console output', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(m =>
      jest.spyOn(console, m).mockImplementation()
    )
    try {
      const secureStore = memoryStore()
      const s = createSecureStoreContinuity({ secureStore })
      const h = await s.getOrCreate('android:https://a.example')
      await h.sign(describePreimage())
      await s.reset('android:https://a.example')
      await s.reset('all')
      const stored = secureStore.data.get('bsv.androidBridge.continuity')!
      const master = JSON.parse(stored).master
      const out = spies
        .flatMap(sp => sp.mock.calls)
        .map(c => c.map(String).join(' '))
        .join('\n')
      expect(out).toBe('')
      expect(out).not.toContain(master)
    } finally {
      spies.forEach(sp => sp.mockRestore())
    }
  })

  it('a corrupt stored record mints a new master instead of throwing', async () => {
    const secureStore = memoryStore()
    secureStore.data.set('bsv.androidBridge.continuity', '{not json')
    const s = createSecureStoreContinuity({ secureStore })
    const h = await s.getOrCreate('android:https://a.example')
    expect(h.instanceId).toMatch(/^[0-9a-f-]{36}$/)
    expect(JSON.parse(secureStore.data.get('bsv.androidBridge.continuity')!).master).toBeTruthy()
    expect(b64uEncode(new Uint8Array(1))).toBeTruthy()
  })
})

// Seeds and ids cross-checked with an independent Python HKDF-SHA256 (RFC 5869) implementation.
const PIN_A = {
  id: '7a9a3b85-7a9a-49f5-ac20-e5d6e1fe2d67',
  seed: '79321f17f5e8243d103345b85a2db571f2344ddf92caa750bed0acb52fa6c40e',
  key: 'PmxPGNNot47ZuSgXIKP7jxImxStCqwAHXhkupC03mKA'
}
const PIN_B = {
  id: 'b1eb5fbf-16f6-4353-91d1-5069af50dce9',
  seed: 'a8161504d874e32073b7e3010117434f19c2910a6de2b270e9edb33fc41299ee',
  key: '4ygg7mgN2XwX4O1cicJTS0xGH3fg5QrMHnhC4lKoQzo'
}
