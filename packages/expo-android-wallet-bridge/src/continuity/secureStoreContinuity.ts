/**
 * `ContinuityStore` on Android (spec 6.9). One master seed in `expo-secure-store`, a pseudonymous Ed25519 identity per
 * origin derived from it with HKDF-SHA256. Works with the wallet locked: no authentication binding, no unlock state.
 * Seeds, the master and derived bytes are never logged.
 */
import { ed25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { b64uDecode, b64uEncode } from '@bsv/expo-wallet-toolbox/core/bridge/protocol/base64url'
import type { ContinuityHandle, ContinuityStore } from '@bsv/expo-wallet-toolbox/core/bridge/protocol/continuity'
import { CONNECT_PREFIX, DESCRIBE_PREFIX } from '@bsv/expo-wallet-toolbox/core/bridge/protocol/descriptor'

export const CONTINUITY_STORAGE_KEY = 'bsv.androidBridge.continuity'
export const CONTINUITY_KEYCHAIN_SERVICE = 'org.bsv.walletbridge.continuity'
const HKDF_SALT = new TextEncoder().encode('BRC-185 android continuity v1')
const LRU_SIZE = 32

export interface ContinuitySecureStore {
  getItemAsync(key: string, options?: any): Promise<string | null>
  setItemAsync(key: string, value: string, options?: any): Promise<void>
  deleteItemAsync?(key: string, options?: any): Promise<void>
}

export interface ContinuityDeps {
  secureStore?: ContinuitySecureStore
  random?: (n: number) => Uint8Array
  /** Called after `reset(ctx)` and `reset('all')` have rotated identity; the controller closes that origin's bindings. */
  onReset?: (ctx: string) => void
  /** Test-only: awaited inside the serialised signing section, before the signature is made. */
  signGate?: () => Promise<void>
}

export interface DerivedIdentity {
  instanceId: string
  seed: Uint8Array
  continuityKey: string
}

/**
 * The single derivation seam (6.9). `okm = HKDF-SHA256(master, salt, info = ctx || 0x00 || gen, L = 48)`: bytes 0 to
 * 31 are the Ed25519 seed, bytes 32 to 47 become a lowercase UUIDv4. The single-key fallback is a change here only.
 */
export function deriveContextIdentity(master: Uint8Array, ctx: string, gen: number): DerivedIdentity {
  const enc = new TextEncoder()
  const ctxBytes = enc.encode(ctx)
  const genBytes = enc.encode(String(gen))
  const info = new Uint8Array(ctxBytes.length + 1 + genBytes.length)
  info.set(ctxBytes, 0)
  info[ctxBytes.length] = 0
  info.set(genBytes, ctxBytes.length + 1)
  const okm = hkdf(sha256, master, HKDF_SALT, info, 48)
  const seed = okm.slice(0, 32)
  const u = okm.slice(32, 48)
  u[6] = (u[6] & 0x0f) | 0x40
  u[8] = (u[8] & 0x3f) | 0x80
  const hex = Array.from(u, b => b.toString(16).padStart(2, '0')).join('')
  const instanceId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  okm.fill(0)
  return { instanceId, seed, continuityKey: b64uEncode(ed25519.getPublicKey(seed)) }
}

const startsWith = (bytes: Uint8Array, prefix: string): boolean => {
  const p = new TextEncoder().encode(prefix)
  if (bytes.length < p.length) return false
  for (let i = 0; i < p.length; i++) if (bytes[i] !== p[i]) return false
  return true
}

function defaultSecureStore(): ContinuitySecureStore {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('expo-secure-store') as ContinuitySecureStore
}

function defaultRandom(n: number): Uint8Array {
  const out = new Uint8Array(n)
  globalThis.crypto.getRandomValues(out)
  return out
}

interface Persisted {
  master: string
  gen: Record<string, number>
}

interface Entry {
  handle: ContinuityHandle
  seed: Uint8Array
}

export function createSecureStoreContinuity(
  deps: ContinuityDeps = {}
): ContinuityStore & { setTestSeed?(seed: Uint8Array): void } {
  const secureStore = deps.secureStore ?? defaultSecureStore()
  const random = deps.random ?? defaultRandom
  const storeOptions = { keychainService: CONTINUITY_KEYCHAIN_SERVICE, requireAuthentication: false }

  let master: Uint8Array | undefined
  let gens: Record<string, number> = {}
  const cache = new Map<string, Entry>()
  let testSeed: Uint8Array | undefined

  // One chain for state changes and signing: describe signing is serialised, and the 32-connection cap bounds it.
  let chain: Promise<unknown> = Promise.resolve()
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn)
    chain = run.catch(() => undefined)
    return run
  }

  const persist = () =>
    secureStore.setItemAsync(
      CONTINUITY_STORAGE_KEY,
      JSON.stringify({ master: b64uEncode(master!), gen: gens } satisfies Persisted),
      storeOptions
    )

  const ensureLoaded = async (): Promise<void> => {
    if (master) return
    const raw = await secureStore.getItemAsync(CONTINUITY_STORAGE_KEY, storeOptions)
    if (raw) {
      try {
        const p = JSON.parse(raw) as Persisted
        const m = b64uDecode(p.master)
        if (m.length === 32) {
          master = m
          gens = p.gen && typeof p.gen === 'object' ? p.gen : {}
          return
        }
      } catch {
        // Unreadable record: fall through and mint a new master (a new provider identity for every origin).
      }
    }
    master = random(32)
    gens = {}
    await persist()
  }

  const wipeCache = () => {
    for (const e of cache.values()) e.seed.fill(0)
    cache.clear()
  }

  const makeEntry = (ctx: string): Entry => {
    const d = deriveContextIdentity(master!, ctx, gens[ctx] ?? 0)
    const seed = testSeed ? testSeed.slice() : d.seed
    const continuityKey = testSeed ? b64uEncode(ed25519.getPublicKey(seed)) : d.continuityKey
    const entry: Entry = {
      seed,
      handle: {
        instanceId: d.instanceId,
        continuityKey,
        sign: preimage =>
          serial(async () => {
            if (!startsWith(preimage, DESCRIBE_PREFIX) && !startsWith(preimage, CONNECT_PREFIX)) {
              throw new Error('continuity key signs only BRC-185 descriptor and connect preimages')
            }
            if (deps.signGate) await deps.signGate()
            if (seed.every(b => b === 0)) throw new Error('continuity identity was reset')
            return ed25519.sign(preimage, seed)
          })
      }
    }
    return entry
  }

  return {
    getOrCreate: ctx =>
      serial(async () => {
        const hit = cache.get(ctx)
        if (hit) {
          cache.delete(ctx)
          cache.set(ctx, hit)
          return hit.handle
        }
        await ensureLoaded()
        const entry = makeEntry(ctx)
        cache.set(ctx, entry)
        if (cache.size > LRU_SIZE) cache.delete(cache.keys().next().value as string)
        return entry.handle
      }),

    reset: async ctx => {
      await serial(async () => {
        await ensureLoaded()
        if (ctx === 'all') {
          master!.fill(0)
          master = random(32)
          gens = {}
          wipeCache()
        } else {
          gens[ctx] = (gens[ctx] ?? 0) + 1
          const hit = cache.get(ctx)
          if (hit) {
            hit.seed.fill(0)
            cache.delete(ctx)
          }
        }
        await persist()
      })
      deps.onReset?.(ctx)
    },

    setTestSeed(seed: Uint8Array) {
      testSeed = seed.slice()
      wipeCache()
    }
  }
}
