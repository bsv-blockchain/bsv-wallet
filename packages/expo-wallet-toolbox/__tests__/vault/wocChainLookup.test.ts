/**
 * wocChainLookup — the production WhatsOnChain VaultChainLookup
 * implementation (core/services/vault/chainRecovery.ts). Exercises its
 * fetch-response-shape handling in isolation (mocked global.fetch, no
 * network — the same `mockFetchOnce` pattern __tests__/pay/addressRail.test.ts
 * already uses for this exact WhatsOnChain client) against the
 * "fail-visibly, never fail-silently" invariant the VaultChainLookup
 * interface itself documents for transactionsForLockingScript: an empty
 * array is a genuine "no marker at this index" miss. A non-2xx response or a
 * thrown exception must never be silently mapped to that SAME empty result —
 * doing so collapses "the network failed" into "there is nothing here,"
 * which can silently truncate recovery before it reaches a real, later
 * deposit (availability review, ledger XQ item). This implementation now
 * throws instead, so recoverVaultFromChain's own bounded problem-reporting
 * path (chainRecovery.test.ts's "bounded scan" describe block) handles it,
 * never the miss-counting path.
 */
// chainRecovery.ts transitively imports transfers.ts -> vaultStore.ts, which
// imports AsyncStorage/expo-secure-store directly; neither transforms under
// jest by default (expo-secure-store ships ESM `import` syntax) — same mocks
// as chainRecovery.test.ts/transfers.test.ts.
jest.mock('@react-native-async-storage/async-storage', () => {
  const store: Record<string, string> = {}
  return {
    __esModule: true,
    default: {
      getItem: async (k: string) => store[k] ?? null,
      setItem: async (k: string, v: string) => { store[k] = v },
      removeItem: async (k: string) => { delete store[k] },
      getAllKeys: async () => Object.keys(store),
      multiRemove: async (keys: string[]) => { for (const k of keys) delete store[k] },
      clear: async () => { for (const k of Object.keys(store)) delete store[k] }
    }
  }
})
jest.mock('expo-secure-store', () => ({
  ...(() => {
    const store: Record<string, string> = {}
    return {
      WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'wutdo',
      getItemAsync: jest.fn(async (k: string) => store[k] ?? null),
      setItemAsync: jest.fn(async (k: string, v: string) => { store[k] = v }),
      deleteItemAsync: jest.fn(async (k: string) => { delete store[k] }),
      __clear: () => { for (const k of Object.keys(store)) delete store[k] }
    }
  })()
}))

import { P2PKH, Utils } from '@bsv/sdk'
import { wocChainLookup } from '../../core/services/vault/chainRecovery'

function mockFetchOnce(handler: (url: string) => { json?: unknown; text?: string; ok?: boolean; status?: number }) {
  global.fetch = jest.fn(async (url: string) => {
    const r = handler(String(url))
    return {
      ok: r.ok ?? true,
      status: r.status ?? (r.ok === false ? 503 : 200),
      json: async () => r.json,
      text: async () => r.text ?? ''
    } as unknown as Response
  }) as unknown as typeof fetch
}

const MARKER_SCRIPT_HEX = new P2PKH().lock(Utils.toArray('11'.repeat(20), 'hex') as number[]).toHex()

describe('wocChainLookup.transactionsForLockingScript', () => {
  it('returns [] for a genuine 2xx empty history (a real "no marker here" miss)', async () => {
    mockFetchOnce(() => ({ ok: true, json: [] }))
    const result = await wocChainLookup('test').transactionsForLockingScript(MARKER_SCRIPT_HEX)
    expect(result).toEqual([])
  })

  it('returns the deduplicated tx_hash list for a genuine 2xx history', async () => {
    mockFetchOnce(() => ({ ok: true, json: [{ tx_hash: 'aa'.repeat(32) }, { tx_hash: 'bb'.repeat(32) }, { tx_hash: 'aa'.repeat(32) }] }))
    const result = await wocChainLookup('test').transactionsForLockingScript(MARKER_SCRIPT_HEX)
    expect(result.sort()).toEqual(['aa'.repeat(32), 'bb'.repeat(32)].sort())
  })

  it('THROWS — never silently returns [] — on a non-2xx response (rate limit / 5xx / maintenance)', async () => {
    mockFetchOnce(() => ({ ok: false, status: 503 }))
    await expect(wocChainLookup('test').transactionsForLockingScript(MARKER_SCRIPT_HEX)).rejects.toThrow()
  })

  it('THROWS — never silently returns [] — when fetch itself rejects (DNS/timeout/offline)', async () => {
    global.fetch = jest.fn(async () => { throw new Error('simulated network failure') }) as unknown as typeof fetch
    await expect(wocChainLookup('test').transactionsForLockingScript(MARKER_SCRIPT_HEX)).rejects.toThrow()
  })

  it('THROWS for a script that is not a recognizable P2PKH marker, rather than silently reporting no history', async () => {
    await expect(wocChainLookup('test').transactionsForLockingScript('006a0548656c6c6f')).rejects.toThrow()
  })
})
