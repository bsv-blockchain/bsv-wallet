/**
 * The device-level key/value store direct payments keep their state in: AsyncStorage, not the
 * wallet's own database.
 *
 * Settings are read before sign-in and survive logout. The seen store and the kept payments are
 * keyed by identity key and network, and must outlive the wallet's database: a kept payment was
 * acknowledged to its payer, who will not send it again, and its derivation is on this device
 * only, so removing a profile must not take it along. AsyncStorage is not encrypted; nothing
 * here is a secret (a kept payment can be spent only by this identity's keys).
 */
import AsyncStorage from '@react-native-async-storage/async-storage'
import type { KVStorage } from '../localpay/pending'

export const deviceKVStorage: KVStorage = {
  getKeyValue: async key => (await AsyncStorage.getItem(key)) ?? undefined,
  setKeyValue: async (key, value) => {
    await AsyncStorage.setItem(key, value)
  }
}
