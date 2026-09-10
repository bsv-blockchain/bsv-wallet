/**
 * Vault persistence — the enrolled key list.
 *
 * Meta v5 lives in AsyncStorage under the unchanged key 'vault_meta_v1'. It is
 * PUBLIC data only: serials, compressed P-256 public keys, nicknames, and
 * timestamps. There is no seed, no seal and no passphrase anywhere in this
 * design (spec D2): the YubiKeys ARE the keys, and each output's salt lives
 * in the wallet database's customInstructions, not here.
 *
 * Anything whose `v` is not 5 reads as "not enrolled" (a K1-era v4 record is
 * ignored, spec §8). The K1 design's SecureStore seal ('vault_seal_v1') is
 * removed by `migrateLegacySeal`, which VaultProvider calls once on mount.
 */
import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'
import { VaultError } from './types'

const LEGACY_SEAL_KEY = 'vault_seal_v1'
const META_KEY = 'vault_meta_v1'

/** How many keys may be enrolled (spec D3). Mirrored by VaultKeyService's
 * VAULT_MIN_KEYS / VAULT_MAX_KEYS; kept local so this module imports no
 * service. */
const MIN_KEYS = 2
const MAX_KEYS = 5

export interface VaultKeyRecord {
  serial: string
  slot: number
  /** 33-byte compressed P-256 public key, lowercase hex (compressPubkey). */
  pubkey: string
  nickname: string
  enrolledAt: number
}

export interface VaultMetaV5 {
  v: 5
  createdAt: number
  lastUsedAt?: number
  lastUsedSerial?: string
  keys: VaultKeyRecord[]
}

export type VaultMeta = VaultMetaV5

async function requireMeta(): Promise<VaultMeta> {
  const meta = await vaultStore.getMeta()
  if (!meta) throw new VaultError('not-enrolled', 'Vault is not set up')
  return meta
}

export const vaultStore = {
  /** Meta-only: there is nothing else an enrollment consists of. */
  async isEnrolled(): Promise<boolean> {
    return (await vaultStore.getMeta()) != null
  },

  async getMeta(): Promise<VaultMeta | null> {
    const raw = await AsyncStorage.getItem(META_KEY)
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw) as { v?: unknown; keys?: unknown }
      return parsed?.v === 5 && Array.isArray(parsed.keys) ? (parsed as VaultMeta) : null
    } catch {
      return null
    }
  },

  async setMeta(m: VaultMeta): Promise<void> {
    await AsyncStorage.setItem(META_KEY, JSON.stringify(m))
  },

  async addKey(k: VaultKeyRecord): Promise<VaultMeta> {
    const meta = await requireMeta()
    if (meta.keys.length >= MAX_KEYS) {
      throw new VaultError('too-many-keys', `The vault already has ${MAX_KEYS} keys`)
    }
    if (meta.keys.some(x => x.serial === k.serial)) {
      throw new VaultError('key-already-enrolled', k.serial, undefined, { serial: k.serial })
    }
    const next: VaultMeta = { ...meta, keys: [...meta.keys, k] }
    await vaultStore.setMeta(next)
    return next
  },

  async removeKey(serial: string): Promise<VaultMeta> {
    const meta = await requireMeta()
    if (meta.keys.length <= MIN_KEYS) {
      throw new VaultError('last-keys', `A vault needs at least ${MIN_KEYS} keys`)
    }
    if (!meta.keys.some(x => x.serial === serial)) {
      throw new VaultError('not-enrolled', `Key ${serial} is not enrolled`)
    }
    const next: VaultMeta = { ...meta, keys: meta.keys.filter(x => x.serial !== serial) }
    if (next.lastUsedSerial === serial) delete next.lastUsedSerial
    await vaultStore.setMeta(next)
    return next
  },

  async renameKey(serial: string, nickname: string): Promise<VaultMeta> {
    const meta = await requireMeta()
    const next: VaultMeta = { ...meta, keys: meta.keys.map(x => (x.serial === serial ? { ...x, nickname } : x)) }
    await vaultStore.setMeta(next)
    return next
  },

  /** Remember which key opened the vault last, so the withdraw chooser can
   * default to it. Silently skipped when nothing is enrolled. */
  async noteLastUsed(serial: string): Promise<void> {
    const meta = await vaultStore.getMeta()
    if (!meta) return
    await vaultStore.setMeta({ ...meta, lastUsedAt: Date.now(), lastUsedSerial: serial })
  },

  /** Remove the K1-era sealed blob from the Keychain. Idempotent and silent:
   * a locked Keychain must not stop the app from mounting. */
  async migrateLegacySeal(): Promise<void> {
    try {
      await SecureStore.deleteItemAsync(LEGACY_SEAL_KEY)
    } catch {
      /* best-effort */
    }
  },

  /** Forget the key list (Disable vault). The keys stay on the YubiKeys. */
  async clear(): Promise<void> {
    await vaultStore.migrateLegacySeal()
    await AsyncStorage.removeItem(META_KEY)
  }
}
