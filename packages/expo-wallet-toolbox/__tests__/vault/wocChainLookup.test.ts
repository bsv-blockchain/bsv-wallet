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
 *
 * Also exercises outputStatus's "'unknown' is never trusted as unspent"
 * invariant: any response shape other than an explicit unspent row must fall
 * through to 'unknown', not 'unspent' — a missing or renamed field must never
 * fail open into treating an already-spent output as internalizable.
 *
 * And proves (exclusion-crypto review, low severity): address derivation
 * goes through @bsv/sdk's own public Utils.toBase58Check, not a hand-rolled
 * encoder.
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

function mockFetchOnce(
  handler: (url: string, init?: RequestInit) => { json?: unknown; text?: string; ok?: boolean; status?: number }
) {
  global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
    const r = handler(String(url), init)
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

  // Live WhatsOnChain (checked 2026-09-27): an address with no history answers
  // 404 "Not Found", never an empty 200 array. Throwing here made every scan
  // index past the last deposit a "problem", so each mainnet restore died with
  // chain-scan-failed after 20 of them.
  it('returns [] for a 404, which is how WhatsOnChain answers an address with no history', async () => {
    mockFetchOnce(() => ({ ok: false, status: 404, text: 'Not Found' }))
    const result = await wocChainLookup('main').transactionsForLockingScript(MARKER_SCRIPT_HEX)
    expect(result).toEqual([])
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

// Live WhatsOnChain (checked 2026-09-27): GET /tx/{txid}/out/{vout} answers
// 502 for every output, so the old check could never report 'unspent' and no
// deposit was ever restorable. POST /utxos/spent answers each outpoint
// explicitly: no spentIn when unspent, spentIn with the spender when spent,
// and spentIn.status "Unknown UTXO" for an output that does not exist.
describe('wocChainLookup.outputStatus — "unknown" is never trusted as unspent', () => {
  const OUTPOINT = { txid: 'a'.repeat(64), vout: 0 }
  const row = (extra: Record<string, unknown>) => [{ utxo: { txid: OUTPOINT.txid, vout: OUTPOINT.vout }, error: '', ...extra }]

  it('asks the bulk spent-status endpoint for exactly this outpoint', async () => {
    let seen: { url: string; init?: RequestInit } | undefined
    mockFetchOnce((url, init) => {
      seen = { url, init }
      return { ok: true, json: row({}) }
    })
    await wocChainLookup('main').outputStatus(OUTPOINT)
    expect(seen?.url).toBe('https://api.whatsonchain.com/v1/bsv/main/utxos/spent')
    expect(seen?.init?.method).toBe('POST')
    expect(JSON.parse(String(seen?.init?.body))).toEqual({ utxos: [OUTPOINT] })
  })

  it("'unspent' only for a row with no spentIn and no error", async () => {
    mockFetchOnce(() => ({ ok: true, json: row({}) }))
    expect(await wocChainLookup('test').outputStatus(OUTPOINT)).toBe('unspent')
  })

  it("'spent' when spentIn names the spending transaction", async () => {
    mockFetchOnce(() => ({ ok: true, json: row({ spentIn: { txid: 'b'.repeat(64), vin: 0, status: 'confirmed' } }) }))
    expect(await wocChainLookup('test').outputStatus(OUTPOINT)).toBe('spent')
  })

  it("'unknown' — NOT 'spent' or 'unspent' — for an output WhatsOnChain does not know", async () => {
    mockFetchOnce(() => ({
      ok: true,
      json: row({ spentIn: { txid: OUTPOINT.txid, vin: 0, status: 'Unknown UTXO' } })
    }))
    expect(await wocChainLookup('test').outputStatus(OUTPOINT)).toBe('unknown')
  })

  it("'unknown' for a row carrying an error", async () => {
    mockFetchOnce(() => ({ ok: true, json: row({ error: 'something went wrong' }) }))
    expect(await wocChainLookup('test').outputStatus(OUTPOINT)).toBe('unknown')
  })

  it("'unknown' when the answer is not about this outpoint", async () => {
    mockFetchOnce(() => ({ ok: true, json: [{ utxo: { txid: 'c'.repeat(64), vout: 0 }, error: '' }] }))
    expect(await wocChainLookup('test').outputStatus(OUTPOINT)).toBe('unknown')
  })

  it("'unknown' for an unrecognized body", async () => {
    mockFetchOnce(() => ({ ok: true, json: { spentTxId: null } }))
    expect(await wocChainLookup('test').outputStatus(OUTPOINT)).toBe('unknown')
  })

  it("'unknown' for a non-2xx response", async () => {
    mockFetchOnce(() => ({ ok: false, status: 500 }))
    expect(await wocChainLookup('test').outputStatus(OUTPOINT)).toBe('unknown')
  })

  it("'unknown' when fetch itself rejects", async () => {
    global.fetch = jest.fn(async () => { throw new Error('simulated network failure') }) as unknown as typeof fetch
    expect(await wocChainLookup('test').outputStatus(OUTPOINT)).toBe('unknown')
  })
})

describe('wocChainLookup address derivation (exclusion-crypto review: no hand-rolled base58check)', () => {
  it('derives the address via the public @bsv/sdk Utils.toBase58Check helper, for both mainnet and testnet prefixes', async () => {
    const hash160 = Utils.toArray('11'.repeat(20), 'hex') as number[]
    const script = new P2PKH().lock(hash160).toHex()

    let mainUrl = ''
    mockFetchOnce(url => { mainUrl = url; return { ok: true, json: [] } })
    await wocChainLookup('main').transactionsForLockingScript(script)
    expect(mainUrl).toContain(`/address/${Utils.toBase58Check(hash160, [0x00])}/history`)

    let testUrl = ''
    mockFetchOnce(url => { testUrl = url; return { ok: true, json: [] } })
    await wocChainLookup('test').transactionsForLockingScript(script)
    expect(testUrl).toContain(`/address/${Utils.toBase58Check(hash160, [0x6f])}/history`)

    // mainnet and testnet addresses for the same hash160 must differ.
    expect(mainUrl).not.toBe(testUrl)
  })
})
