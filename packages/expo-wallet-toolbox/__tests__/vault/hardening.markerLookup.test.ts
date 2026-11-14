/**
 * Hardening task 3: one chain lookup with three results (found / none /
 * unknown). Covers markerLookup.ts (lookupMarker, injection, salt floor) and
 * the WhatsOnChain markerHistory in wocLookup.ts. No network: global.fetch is
 * mocked with a function that routes by URL.
 */
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
jest.mock('expo-secure-store', () => ({
  ...(() => {
    const store: Record<string, string> = {}
    return {
      WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'wutdo',
      getItemAsync: jest.fn(async (k: string) => store[k] ?? null),
      setItemAsync: jest.fn(async (k: string, v: string) => {
        store[k] = v
      }),
      deleteItemAsync: jest.fn(async (k: string) => {
        delete store[k]
      }),
      __clear: () => {
        for (const k of Object.keys(store)) delete store[k]
      }
    }
  })()
}))

import { P2PKH, Utils } from '@bsv/sdk'
import { wocChainLookup } from '../../core/services/vault/wocLookup'
import {
  getVaultChainLookup,
  lookupMarker,
  noteSaltFloor,
  saltFloorFor,
  setVaultChainLookup,
  VAULT_SCAN_MIN_SATS,
  type VaultChainLookup
} from '../../core/services/vault/markerLookup'

type Reply = { json?: unknown; text?: string; status?: number } | 'throw'

/** Routes by URL; records every requested URL. */
function routeFetch(route: (url: string) => Reply) {
  const urls: string[] = []
  global.fetch = jest.fn(async (url: string) => {
    urls.push(String(url))
    const r = route(String(url))
    if (r === 'throw') throw new Error('network down')
    const status = r.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => r.json,
      text: async () => r.text ?? ''
    } as unknown as Response
  }) as unknown as typeof fetch
  return urls
}

const MARKER_SCRIPT_HEX = new P2PKH().lock(Utils.toArray('11'.repeat(20), 'hex') as number[]).toHex()
const tx = (n: number) => n.toString(16).padStart(64, '0')
const rows = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => ({ tx_hash: tx(from + i), height: 800000 + i }))
const isConfirmed = (u: string) => u.includes('/confirmed/history')
const isUnconfirmed = (u: string) => u.includes('/unconfirmed/history')

describe('wocChainLookup.markerHistory', () => {
  it('markerHistory returns none when both endpoints answer 404', async () => {
    routeFetch(() => ({ status: 404, text: 'Not Found' }))
    await expect(wocChainLookup('main').markerHistory!(MARKER_SCRIPT_HEX)).resolves.toEqual({ status: 'none' })
  })

  it('markerHistory returns found with confirmed rows first (oldest first) then unconfirmed rows, without duplicates', async () => {
    routeFetch(u =>
      isConfirmed(u)
        ? {
            json: {
              result: [
                { tx_hash: tx(1), height: 1 },
                { tx_hash: tx(2), height: 2 }
              ]
            }
          }
        : { json: { result: [{ tx_hash: tx(2) }, { tx_hash: tx(3) }] } }
    )
    await expect(wocChainLookup('main').markerHistory!(MARKER_SCRIPT_HEX)).resolves.toEqual({
      status: 'found',
      txids: [tx(1), tx(2), tx(3)]
    })
  })

  it('markerHistory pages through confirmed history with the next-page token', async () => {
    const urls = routeFetch(u => {
      if (isUnconfirmed(u)) return { status: 404 }
      if (u.includes('token=')) return { json: { result: rows(2000, 5) } }
      return { json: { result: rows(0, 1000), nextPageToken: 'a b/c' } }
    })
    const res = await wocChainLookup('main').markerHistory!(MARKER_SCRIPT_HEX)
    expect(res.status).toBe('found')
    expect((res as { txids: string[] }).txids).toHaveLength(1005)
    const confirmed = urls.filter(isConfirmed)
    expect(confirmed).toHaveLength(2)
    expect(confirmed[0]).toContain('order=asc&limit=1000')
    expect(confirmed[0]).not.toContain('token=')
    expect(confirmed[1]).toContain('order=asc&limit=1000')
    expect(confirmed[1]).toContain(`token=${encodeURIComponent('a b/c')}`)
  })

  it('reads the token from the next-page field too', async () => {
    const urls = routeFetch(u => {
      if (isUnconfirmed(u)) return { status: 404 }
      if (u.includes('token=')) return { json: { result: rows(2000, 1) } }
      return { json: { result: rows(0, 1000), 'next-page': 'tok2' } }
    })
    const res = await wocChainLookup('main').markerHistory!(MARKER_SCRIPT_HEX)
    expect(res.status).toBe('found')
    expect(urls.filter(isConfirmed)[1]).toContain('token=tok2')
  })

  it('a full page with no token is unknown/window-full and keeps the rows it read', async () => {
    routeFetch(u => (isUnconfirmed(u) ? { status: 404 } : { json: { result: rows(0, 1000) } }))
    const res = await wocChainLookup('main').markerHistory!(MARKER_SCRIPT_HEX)
    expect(res.status).toBe('unknown')
    if (res.status !== 'unknown') throw new Error('unreachable')
    expect(res.reason).toBe('window-full')
    expect(res.txids).toHaveLength(1000)
  })

  it('a server cap below the requested limit with no token is unknown/window-full (100 rows)', async () => {
    routeFetch(u => (isUnconfirmed(u) ? { status: 404 } : { json: { result: rows(0, 100) } }))
    const res = await wocChainLookup('main').markerHistory!(MARKER_SCRIPT_HEX)
    expect(res.status).toBe('unknown')
    if (res.status !== 'unknown') throw new Error('unreachable')
    expect(res.reason).toBe('window-full')
    expect(res.txids).toHaveLength(100)
  })

  it('a token under an unexpected field name is still followed', async () => {
    const urls = routeFetch(u => {
      if (isUnconfirmed(u)) return { status: 404 }
      if (!u.includes('token=')) return { json: { result: rows(0, 100), nextToken: 'zz' } }
      return { json: { result: rows(100, 5) } }
    })
    const res = await wocChainLookup('main').markerHistory!(MARKER_SCRIPT_HEX)
    expect(res.status).toBe('found')
    if (res.status !== 'found') throw new Error('unreachable')
    expect(res.txids).toHaveLength(105)
    expect(urls.filter(u => u.includes('token=zz'))).toHaveLength(1)
  })

  it('a short page with no token is complete (found, not unknown)', async () => {
    routeFetch(u => (isUnconfirmed(u) ? { status: 404 } : { json: { result: rows(0, 99) } }))
    const res = await wocChainLookup('main').markerHistory!(MARKER_SCRIPT_HEX)
    expect(res.status).toBe('found')
  })

  it('more than 5 pages is unknown/window-full', async () => {
    let page = 0
    const urls = routeFetch(u => {
      if (isUnconfirmed(u)) return { status: 404 }
      page++
      return { json: { result: rows(page * 1000, 1000), nextPageToken: `t${page}` } }
    })
    const res = await wocChainLookup('main').markerHistory!(MARKER_SCRIPT_HEX)
    expect(res.status).toBe('unknown')
    if (res.status !== 'unknown') throw new Error('unreachable')
    expect(res.reason).toBe('window-full')
    expect(res.txids).toHaveLength(5000)
    expect(urls.filter(isConfirmed)).toHaveLength(5)
  })

  it('a 429 on the confirmed endpoint is unknown/rate-limited', async () => {
    routeFetch(u => (isConfirmed(u) ? { status: 429 } : { status: 404 }))
    await expect(wocChainLookup('main').markerHistory!(MARKER_SCRIPT_HEX)).resolves.toEqual({
      status: 'unknown',
      reason: 'rate-limited',
      txids: []
    })
  })

  it('a 500 is unknown/request-failed', async () => {
    routeFetch(() => ({ status: 500 }))
    await expect(wocChainLookup('main').markerHistory!(MARKER_SCRIPT_HEX)).resolves.toMatchObject({
      status: 'unknown',
      reason: 'request-failed'
    })
  })

  it('a thrown fetch is unknown/request-failed', async () => {
    routeFetch(() => 'throw')
    await expect(wocChainLookup('main').markerHistory!(MARKER_SCRIPT_HEX)).resolves.toMatchObject({
      status: 'unknown',
      reason: 'request-failed',
      txids: []
    })
  })

  it('a body without result is unknown/malformed', async () => {
    routeFetch(u => (isConfirmed(u) ? { json: { error: '' } } : { status: 404 }))
    await expect(wocChainLookup('main').markerHistory!(MARKER_SCRIPT_HEX)).resolves.toMatchObject({
      status: 'unknown',
      reason: 'malformed'
    })
  })

  it('a script that is not P2PKH is unknown/malformed and sends no request', async () => {
    const urls = routeFetch(() => ({ status: 404 }))
    await expect(wocChainLookup('main').markerHistory!('6a')).resolves.toEqual({
      status: 'unknown',
      reason: 'malformed',
      txids: []
    })
    expect(urls).toHaveLength(0)
  })

  it('a failing unconfirmed endpoint makes the whole result unknown even when confirmed rows exist', async () => {
    routeFetch(u => (isConfirmed(u) ? { json: { result: rows(0, 2) } } : { status: 503 }))
    await expect(wocChainLookup('main').markerHistory!(MARKER_SCRIPT_HEX)).resolves.toEqual({
      status: 'unknown',
      reason: 'request-failed',
      txids: [tx(0), tx(1)]
    })
  })

  it('merges requestInit into every request', async () => {
    const seen: unknown[] = []
    global.fetch = jest.fn(async (_u: string, init?: RequestInit) => {
      seen.push(init)
      return { ok: false, status: 404, json: async () => ({}), text: async () => '' } as unknown as Response
    }) as unknown as typeof fetch
    await wocChainLookup('main', { headers: { 'woc-api-key': 'k' } }).markerHistory!(MARKER_SCRIPT_HEX)
    expect(seen).toHaveLength(2)
    for (const init of seen) expect(init).toMatchObject({ headers: { 'woc-api-key': 'k' } })
  })

  it('markerAddress gives the base58 address of a P2PKH script and undefined otherwise', () => {
    const l = wocChainLookup('main')
    expect(l.markerAddress!(MARKER_SCRIPT_HEX)).toBe(Utils.toBase58Check(Utils.toArray('11'.repeat(20), 'hex'), [0x00]))
    expect(l.markerAddress!('6a')).toBeUndefined()
  })
})

describe('lookupMarker', () => {
  const base = {
    transactionForTxid: async () => null,
    outputStatus: async () => 'unknown' as const
  }
  it('lookupMarker falls back to transactionsForLockingScript: [] is none, rows are found, a throw is unknown/request-failed', async () => {
    const mk = (fn: () => Promise<string[]>): VaultChainLookup => ({ ...base, transactionsForLockingScript: fn })
    await expect(
      lookupMarker(
        mk(async () => []),
        'aa'
      )
    ).resolves.toEqual({ status: 'none' })
    await expect(
      lookupMarker(
        mk(async () => ['t1', 't2']),
        'aa'
      )
    ).resolves.toEqual({
      status: 'found',
      txids: ['t1', 't2']
    })
    await expect(
      lookupMarker(
        mk(async () => {
          throw new Error('boom')
        }),
        'aa'
      )
    ).resolves.toEqual({ status: 'unknown', reason: 'request-failed', txids: [] })
  })

  it('uses markerHistory when the lookup has it', async () => {
    const legacy = jest.fn(async () => ['never'])
    const l: VaultChainLookup = {
      ...base,
      transactionsForLockingScript: legacy,
      markerHistory: async () => ({ status: 'unknown', reason: 'window-full', txids: ['t9'] })
    }
    await expect(lookupMarker(l, 'aa')).resolves.toEqual({ status: 'unknown', reason: 'window-full', txids: ['t9'] })
    expect(legacy).not.toHaveBeenCalled()
  })
})

describe('injected lookup and salt floor', () => {
  afterEach(() => setVaultChainLookup(null))

  it('getVaultChainLookup uses the injected lookup and setVaultChainLookup(null) restores the default', () => {
    const fake: VaultChainLookup = {
      transactionsForLockingScript: async () => [],
      transactionForTxid: async () => null,
      outputStatus: async () => 'unknown'
    }
    setVaultChainLookup(fake)
    expect(getVaultChainLookup('main')).toBe(fake)
    setVaultChainLookup(null)
    const def = getVaultChainLookup('main')
    expect(def).not.toBe(fake)
    expect(typeof def.markerHistory).toBe('function')
  })

  it('getVaultChainLookup fails closed for a chain without WhatsOnChain', () => {
    expect(() => getVaultChainLookup('teratestnet' as any)).toThrow()
  })

  it('setVaultChainLookup is a no-op outside __DEV__ (positive control under __DEV__)', () => {
    const fake: VaultChainLookup = {
      transactionsForLockingScript: async () => [],
      transactionForTxid: async () => null,
      outputStatus: async () => 'unknown'
    }
    const replaced = jest.replaceProperty(globalThis as any, '__DEV__', false)
    try {
      setVaultChainLookup(fake)
      expect(getVaultChainLookup('main')).not.toBe(fake)
      expect(typeof getVaultChainLookup('main').markerHistory).toBe('function')
    } finally {
      replaced.restore()
    }
    expect(__DEV__).toBe(true)
    setVaultChainLookup(fake)
    expect(getVaultChainLookup('main')).toBe(fake)
  })

  it('wocChainLookup(chain).transactionsForLockingScript still uses the plain /history request', async () => {
    const urls = routeFetch(() => ({ json: [{ tx_hash: tx(1), height: 1 }] }))
    await expect(wocChainLookup('main').transactionsForLockingScript(MARKER_SCRIPT_HEX)).resolves.toEqual([tx(1)])
    expect(urls).toHaveLength(1)
    expect(urls[0]).toMatch(/\/address\/[^/]+\/history$/)
    expect(urls[0]).not.toContain('confirmed')
  })

  it('salt floor only rises and is 0 when unset', () => {
    expect(saltFloorFor('k-unset')).toBe(0)
    noteSaltFloor('k1', 5)
    noteSaltFloor('k1', 3)
    expect(saltFloorFor('k1')).toBe(5)
    noteSaltFloor('k1', 7)
    expect(saltFloorFor('k1')).toBe(7)
    expect(saltFloorFor('k2')).toBe(0)
  })

  it('the scan floor is frozen at 100000', () => {
    expect(VAULT_SCAN_MIN_SATS).toBe(100_000)
  })
})
