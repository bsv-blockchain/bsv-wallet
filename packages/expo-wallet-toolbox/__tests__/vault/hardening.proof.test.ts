jest.mock('@react-native-async-storage/async-storage', () => {
  const store: Record<string, string> = {}
  return {
    __esModule: true,
    default: {
      getItem: async (k: string) => store[k] ?? null,
      setItem: async (k: string, v: string) => {
        store[k] = v
      },
      removeItem: async (k: string) => {
        delete store[k]
      },
      getAllKeys: async () => Object.keys(store),
      multiRemove: async (keys: string[]) => {
        for (const k of keys) delete store[k]
      },
      clear: async () => {
        for (const k of Object.keys(store)) delete store[k]
      }
    }
  }
})
jest.mock('expo-secure-store', () => {
  const store: Record<string, string> = {}
  return {
    __esModule: true,
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'wudo',
    getItemAsync: async (k: string) => store[k] ?? null,
    setItemAsync: async (k: string, v: string) => {
      store[k] = v
    },
    deleteItemAsync: async (k: string) => {
      delete store[k]
    },
    __clear: () => {
      for (const k of Object.keys(store)) delete store[k]
    }
  }
})

/**
 * Hardening: one proof definition (audit findings planted-key, planted-lockout).
 *
 * A key is proven only by a live tap: a durable (serial, pubkey) pair that the
 * wallet tagged, or an in-memory session proof. A chain record alone, and a
 * planted record that reuses a real serial with another pubkey, prove nothing.
 */
import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'
import { CompletedProtoWallet, PrivateKey, Utils } from '@bsv/sdk'
import { p256 } from '@noble/curves/nist.js'
import { vaultStore, isVaultMeta, VaultKeyRecord, VaultMetaV6 } from '../../core/services/vault/vaultStore'
import { computeVaultMetaAuthorityTag, verifyVaultMetaAuthorityTag } from '../../core/services/vault/metaAuthority'

const ID_A = '02' + 'ab'.repeat(32)
const ADMIN = 'admin.test'
const wallet = new CompletedProtoWallet(new PrivateKey(7))

const key = (n: number, serial = `1000000${n}`): VaultKeyRecord => ({
  serial,
  slot: 0x82,
  pubkey: Utils.toHex(Array.from(p256.Point.BASE.multiply(BigInt(n)).toBytes(true))),
  nickname: `Key ${n}`,
  enrolledAt: 1_700_000_000_000 + n
})

const base = (over: Partial<VaultMetaV6> = {}): VaultMetaV6 => ({
  v: 6,
  vaultId: '11'.repeat(32),
  revision: 1,
  createdAt: 1_700_000_000_000,
  keys: [key(1), key(2)],
  ...over
})
const pair = (k: VaultKeyRecord) => ({ serial: k.serial, pubkey: k.pubkey })
const recovered = (adopted: { serial: string; pubkey: string }[] | undefined, legacy: string[] = []) => ({
  required: true as const,
  adoptedSerials: adopted ? adopted.map(p => p.serial) : legacy,
  ...(adopted ? { adopted } : {})
})
const tagger = (next: Parameters<typeof computeVaultMetaAuthorityTag>[2]) =>
  computeVaultMetaAuthorityTag(wallet, ADMIN, next, vaultStore.getScope()!)

beforeEach(async () => {
  await AsyncStorage.clear()
  ;(SecureStore as typeof SecureStore & { __clear(): void }).__clear()
  vaultStore.clearScope()
  vaultStore.configureScope({ identityKey: ID_A, chain: 'main' })
})
afterEach(() => vaultStore.clearScope())

describe('meta authority message', () => {
  it('a meta with no staged key and no recovery state produces the same authority message as before', async () => {
    // Tag computed once with the code before this change, over this fixture.
    const OLD_TAG = 'TjhlZclVdBY5PfEb_DYN16B3pAbQO285SXIdRT2F6nQ'
    const meta = {
      vaultId: '11'.repeat(32),
      revision: 3,
      createdAt: 1_700_000_000_000,
      keys: [
        { serial: '10000001', slot: 0x82, pubkey: '02' + 'aa'.repeat(32) },
        { serial: '10000002', slot: 0x82, pubkey: '03' + 'bb'.repeat(32) }
      ]
    } as VaultMetaV6
    const scope = { identityKey: ID_A, chain: 'main' as const }
    expect(await computeVaultMetaAuthorityTag(wallet, ADMIN, meta, scope)).toBe(OLD_TAG)
    expect(await verifyVaultMetaAuthorityTag(wallet, ADMIN, meta, scope, OLD_TAG)).toBe(true)
  })

  it('staged and adopted pairs are covered by the tag', async () => {
    const scope = { identityKey: ID_A, chain: 'main' as const }
    const plain = base()
    const t0 = await computeVaultMetaAuthorityTag(wallet, ADMIN, plain, scope)
    const staged = { ...plain, staged: key(3) }
    expect(await computeVaultMetaAuthorityTag(wallet, ADMIN, staged, scope)).not.toBe(t0)
    const rec = { ...plain, recovery: recovered([pair(key(1))]) }
    const t1 = await computeVaultMetaAuthorityTag(wallet, ADMIN, rec, scope)
    expect(t1).not.toBe(t0)
    // pair order does not matter, content does
    const rec2 = { ...plain, recovery: recovered([pair(key(2)), pair(key(1))]) }
    const rec3 = { ...plain, recovery: recovered([pair(key(1)), pair(key(2))]) }
    expect(await computeVaultMetaAuthorityTag(wallet, ADMIN, rec2, scope)).toBe(
      await computeVaultMetaAuthorityTag(wallet, ADMIN, rec3, scope)
    )
    expect(await verifyVaultMetaAuthorityTag(wallet, ADMIN, plain, scope, t1)).toBe(false)
  })
})

describe('isVaultMeta staged and adopted', () => {
  it('accepts staged and adopted pairs and rejects a staged key that duplicates a listed key, an adopted pair that names an unknown key, and keys.length + staged above 6', () => {
    expect(isVaultMeta(base({ staged: key(3) }))).toBe(true)
    expect(isVaultMeta(base({ recovery: recovered([pair(key(1))]) }))).toBe(true)

    // staged duplicates a listed key by serial or by pubkey
    expect(isVaultMeta(base({ staged: key(1) }))).toBe(false)
    expect(isVaultMeta(base({ staged: key(3, key(1).serial) }))).toBe(false)
    expect(isVaultMeta(base({ staged: { ...key(3), pubkey: key(1).pubkey } }))).toBe(false)
    // staged duplicates the key being removed
    const removed = key(4)
    const pendingRemoval = {
      key: removed,
      keyIndex: 1,
      startedAt: 1_700_000_000_001,
      revision: 1,
      state: 'prepared' as const
    }
    expect(isVaultMeta(base({ pendingRemoval, staged: removed }))).toBe(false)
    expect(isVaultMeta(base({ pendingRemoval, staged: key(5) }))).toBe(true)

    // adopted pair naming an unknown key, or a known serial with another pubkey, or duplicates
    expect(isVaultMeta(base({ recovery: recovered([pair(key(9))]) }))).toBe(false)
    expect(isVaultMeta(base({ recovery: recovered([{ serial: key(1).serial, pubkey: key(2).pubkey }]) }))).toBe(false)
    expect(
      isVaultMeta(base({ recovery: { ...recovered([pair(key(1))]), adopted: [pair(key(1)), pair(key(1))] } }))
    ).toBe(false)
    // unknown recovery field is still refused
    expect(isVaultMeta({ ...base(), recovery: { ...recovered([]), extra: 1 } })).toBe(false)

    // 6 keys is the ceiling for keys + staged
    const six = [1, 2, 3, 4, 5, 6].map(n => key(n))
    expect(isVaultMeta(base({ keys: six }))).toBe(true)
    expect(isVaultMeta(base({ keys: six.slice(0, 5), staged: key(6) }))).toBe(true)
    expect(isVaultMeta(base({ keys: six, staged: key(7) }))).toBe(false)
  })
})

describe('provenKeyRecords', () => {
  it('returns every key for a meta without recovery.required', () => {
    const meta = base()
    expect(vaultStore.provenKeyRecords(meta)).toEqual(meta.keys)
  })

  it('returns only adopted pairs for a recovered meta', () => {
    const meta = base({ recovery: recovered([pair(key(2))]) })
    expect(vaultStore.provenKeyRecords(meta)).toEqual([key(2)])
  })

  it('an adopted serial with a different pubkey is not proven (planted record reusing a real serial)', () => {
    const real = key(2)
    const planted = key(8, real.serial)
    // the real tap proved (serial 2, pubkey 2); the planted list swaps in pubkey 8 under the same serial
    const meta = base({ keys: [key(1), planted], recovery: { ...recovered([pair(real)]) } })
    expect(isVaultMeta(meta)).toBe(false) // the pair names no key of this list
    const unchecked = { ...meta } as VaultMetaV6
    expect(vaultStore.provenKeyRecords(unchecked)).toEqual([])
  })

  it('a legacy meta (adoptedSerials only) reads as unproven', () => {
    const meta = base({ recovery: recovered(undefined, [key(1).serial, key(2).serial]) })
    expect(isVaultMeta(meta)).toBe(true)
    expect(vaultStore.provenKeyRecords(meta)).toEqual([])
  })
})

describe('markKeyAdopted', () => {
  it('with a tagger writes the pair and a valid new tag; without a tagger it records a session proof and leaves stored meta and tag byte-identical', async () => {
    const token = vaultStore.captureScopeToken()
    const meta = base({ recovery: recovered([]) })
    await vaultStore.setMeta(meta, token, tagger)

    await vaultStore.markKeyAdopted(pair(key(1)), token, tagger, (await vaultStore.getMeta())!)
    const stored = await vaultStore.getMeta()
    expect(stored?.recovery?.adopted).toEqual([pair(key(1))])
    expect(stored?.recovery?.adoptedSerials).toEqual([key(1).serial])
    const tag = await vaultStore.getMetaTag(token)
    expect(await verifyVaultMetaAuthorityTag(wallet, ADMIN, stored!, vaultStore.getScope()!, tag)).toBe(true)

    const rawBefore = JSON.stringify(await vaultStore.getMeta())
    const tagBefore = await vaultStore.getMetaTag(token)
    await vaultStore.markKeyAdopted(pair(key(2)), token)
    expect(JSON.stringify(await vaultStore.getMeta())).toBe(rawBefore)
    expect(await vaultStore.getMetaTag(token)).toBe(tagBefore)
    expect(vaultStore.provenKeyRecords(stored!, token).map(k => k.serial)).toEqual([key(1).serial, key(2).serial])
  })

  it('refuses a pair that matches no key of the meta, and is a no-op when the meta has no recovery state', async () => {
    const token = vaultStore.captureScopeToken()
    await vaultStore.setMeta(base({ recovery: recovered([]) }), token, tagger)
    await expect(
      vaultStore.markKeyAdopted(
        { serial: key(1).serial, pubkey: key(2).pubkey },
        token,
        tagger,
        (await vaultStore.getMeta())!
      )
    ).rejects.toMatchObject({ code: 'wrong-key' })

    await vaultStore.setMeta(base(), token, tagger)
    const before = JSON.stringify(await vaultStore.getMeta())
    await vaultStore.markKeyAdopted(pair(key(1)), token, tagger, (await vaultStore.getMeta())!)
    expect(JSON.stringify(await vaultStore.getMeta())).toBe(before)
  })

  it('a staged key can be adopted', async () => {
    const token = vaultStore.captureScopeToken()
    await vaultStore.setMeta(base({ staged: key(3), recovery: recovered([]) }), token, tagger)
    await vaultStore.markKeyAdopted(pair(key(3)), token, tagger, (await vaultStore.getMeta())!)
    expect((await vaultStore.getMeta())?.recovery?.adopted).toEqual([pair(key(3))])
  })
})

describe('session proofs', () => {
  it('a session proof is scoped: a different scope token does not see it, and clearScope drops it', () => {
    const tokenA = vaultStore.captureScopeToken()
    const meta = base({ recovery: recovered([]) })
    vaultStore.noteSessionProof(pair(key(1)), tokenA)
    expect(vaultStore.provenKeyRecords(meta, tokenA)).toEqual([key(1)])

    vaultStore.clearScope()
    vaultStore.configureScope({ identityKey: '03' + 'cd'.repeat(32), chain: 'main' })
    const tokenB = vaultStore.captureScopeToken()
    expect(vaultStore.provenKeyRecords(meta, tokenB)).toEqual([])

    vaultStore.clearScope()
    vaultStore.configureScope({ identityKey: ID_A, chain: 'main' })
    // same wallet configured again after clearScope: the session proof is gone
    expect(vaultStore.provenKeyRecords(meta)).toEqual([])
  })
})

describe('restoreVerifiedMeta adoption carry-over', () => {
  it('carries adoption by serial+pubkey: a planted higher revision that reuses serial B with another pubkey does not inherit B adoption, while A pair is carried', async () => {
    const A = key(1)
    const B = key(2)
    const token = vaultStore.captureScopeToken()
    await vaultStore.setMeta(base({ recovery: recovered([pair(A), pair(B)]) }), token, tagger)

    const plantedB = key(8, B.serial)
    const restored = await vaultStore.restoreVerifiedMeta(base({ revision: 2, keys: [A, plantedB] }), token, tagger)
    expect(restored.recovery?.adopted).toEqual([pair(A)])
    expect(restored.recovery?.adoptedSerials).toEqual([A.serial])
    expect(vaultStore.provenKeyRecords(restored, token)).toEqual([A])
  })

  it('carries the staged key pair of the current meta when the higher revision lists it', async () => {
    const A = key(1)
    const B = key(2)
    const C = key(3)
    const token = vaultStore.captureScopeToken()
    await vaultStore.setMeta(base({ staged: C, recovery: recovered([pair(A)]) }), token, tagger)
    const restored = await vaultStore.restoreVerifiedMeta(base({ revision: 2, keys: [A, B, C] }), token, tagger)
    expect(restored.recovery?.adopted).toEqual([pair(A), pair(C)])
  })

  it('on a device with no recovery state carries all its pairs as adopted', async () => {
    const A = key(1)
    const B = key(2)
    const token = vaultStore.captureScopeToken()
    await vaultStore.setMeta(base(), token, tagger)
    const restored = await vaultStore.restoreVerifiedMeta(base({ revision: 2, keys: [A, B, key(3)] }), token, tagger)
    expect(restored.recovery?.required).toBe(true)
    expect(restored.recovery?.adopted).toEqual([pair(A), pair(B)])
    expect(restored.recovery?.adoptedSerials).toEqual([A.serial, B.serial])
    expect(vaultStore.provenKeyRecords(restored, token)).toEqual([A, B])
  })
})

/** Store-only attacker: rewrite the stored meta, leave the tag as it was. */
async function forgeStoredMeta(edit: (m: VaultMetaV6) => VaultMetaV6): Promise<void> {
  const storageKey = vaultStore.captureScopeToken().storageKey
  const raw = JSON.parse((await SecureStore.getItemAsync(storageKey))!)
  await SecureStore.setItemAsync(storageKey, JSON.stringify(edit(raw)))
}

describe('review round 1: no fresh tag over unverified adoption state', () => {
  it('same-revision restore after forged adopted + stale tag does not leave the planted pair proven', async () => {
    const A = key(1)
    const B = key(2)
    const token = vaultStore.captureScopeToken()
    await vaultStore.setMeta(base({ recovery: recovered([pair(A)]) }), token, tagger)
    await forgeStoredMeta(m => ({ ...m, recovery: recovered([pair(A), pair(B)]) }))
    const forged = (await vaultStore.getMeta())!
    expect(
      await verifyVaultMetaAuthorityTag(
        wallet,
        ADMIN,
        forged,
        vaultStore.getScope()!,
        await vaultStore.getMetaTag(token)
      )
    ).toBe(false)

    const restored = await vaultStore.restoreVerifiedMeta(base(), token, tagger)
    expect(restored.recovery?.adopted).toEqual([])
    expect(vaultStore.provenKeyRecords((await vaultStore.getMeta())!, token)).toEqual([])
  })

  it('same-revision restore drops a planted staged key when current tag does not verify, keeps it when it does', async () => {
    const token = vaultStore.captureScopeToken()
    await vaultStore.setMeta(base({ staged: key(3), recovery: recovered([pair(key(1))]) }), token, tagger)
    const kept = await vaultStore.restoreVerifiedMeta(base(), token, tagger)
    expect(kept.staged).toEqual(key(3))
    expect(kept.recovery?.adopted).toEqual([pair(key(1))])

    await forgeStoredMeta(m => ({ ...m, staged: key(4) }))
    const dropped = await vaultStore.restoreVerifiedMeta(base(), token, tagger)
    expect(dropped.staged).toBeUndefined()
    expect(dropped.recovery?.adopted).toEqual([])
  })

  it('higher-revision restore carries nothing when current has stripped recovery and its tag does not verify', async () => {
    const A = key(1)
    const B = key(2)
    const token = vaultStore.captureScopeToken()
    await vaultStore.setMeta(base({ recovery: recovered([]) }), token, tagger)
    await forgeStoredMeta(m => {
      const { recovery: _r, ...rest } = m
      return rest as VaultMetaV6
    })
    const restored = await vaultStore.restoreVerifiedMeta(base({ revision: 2, keys: [A, B] }), token, tagger)
    expect(restored.recovery?.adopted).toEqual([])
    expect(vaultStore.provenKeyRecords(restored, token)).toEqual([])
  })

  it('markKeyAdopted with a tagger and no authenticated snapshot throws and writes nothing', async () => {
    const token = vaultStore.captureScopeToken()
    await vaultStore.setMeta(base({ recovery: recovered([]) }), token, tagger)
    const before = JSON.stringify(await vaultStore.getMeta())
    await expect(vaultStore.markKeyAdopted(pair(key(1)), token, tagger)).rejects.toMatchObject({
      code: 'template-invalid'
    })
    expect(JSON.stringify(await vaultStore.getMeta())).toBe(before)
  })

  it('markKeyAdopted with a tagger and a matching snapshot writes the pair', async () => {
    const token = vaultStore.captureScopeToken()
    await vaultStore.setMeta(base({ recovery: recovered([]) }), token, tagger)
    await vaultStore.markKeyAdopted(pair(key(1)), token, tagger, (await vaultStore.getMeta())!)
    expect((await vaultStore.getMeta())?.recovery?.adopted).toEqual([pair(key(1))])
  })
})

describe('requireKeyAdopted', () => {
  it('rejects a serial whose stored pubkey differs from the adopted pair', async () => {
    const token = vaultStore.captureScopeToken()
    const A = key(1)
    // a hand-written (untagged, structurally invalid) record cannot be stored; use a valid one and a session proof on a different pubkey
    await vaultStore.setMeta(base({ recovery: recovered([pair(A)]) }), token, tagger)
    await expect(vaultStore.requireKeyAdopted(A.serial, token)).resolves.toBeUndefined()
    await expect(vaultStore.requireKeyAdopted(key(2).serial, token)).rejects.toMatchObject({ code: 'key-not-adopted' })

    // session proof for serial 2 bound to another pubkey proves nothing
    vaultStore.noteSessionProof({ serial: key(2).serial, pubkey: key(9).pubkey }, token)
    await expect(vaultStore.requireKeyAdopted(key(2).serial, token)).rejects.toMatchObject({ code: 'key-not-adopted' })
    vaultStore.noteSessionProof(pair(key(2)), token)
    await expect(vaultStore.requireKeyAdopted(key(2).serial, token)).resolves.toBeUndefined()
  })
})
