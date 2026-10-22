/**
 * Token reads over the color module's `listOutputs` views (plan 07 Task 11).
 *
 *  · `p color assets` is the inventory: one record per real outpoint, with a
 *    wallet-authored state tag and, for an offline credit, `color_offline`
 *    (0207:396-404, 0207:620-660).
 *  · `p color balance <assetTag>` is the exact available sum, as a canonical
 *    decimal string with no 2^53 ceiling (0207:674-697).
 *  · Asset metadata comes from the deploy tx through lib `readDeploy` (W7),
 *    hash-bound to the asset id and cached for offline reads.
 *
 * Review Focus 4 is pinned here: offline units come ONLY from records that
 * carry both `color_state_available` and `color_offline`.
 */
import type { DatabaseSync } from 'node:sqlite'
import {
  LockingScript,
  PrivateKey,
  Hash,
  Transaction,
  UnlockingScript,
  Utils,
  Beef,
  type WalletInterface
} from '@bsv/sdk'
import { OneColor } from '@bsv/templates'
import { assetTag } from '@bsv/mandala'
import type { ColorOverlayProvider } from '@bsv/color-permission-module'
import {
  createAssetMetadata,
  offlineUnitsOf,
  readAvailable,
  readInventory,
  shortAssetId,
  type InventoryRecord
} from '../../core/mandala/assets'
import type { WalletKv } from '../../core/mandala/kvStore'
import { openTestDb } from '../__helpers__/nodeSqlite'

const ADMIN = 'admin.example'
const ASSET = `${'ab'.repeat(32)}_0`
const OTHER = `${'cd'.repeat(32)}_0`

/** IC §4 fixture F-REQ: K = the C.0 signer, `{dec:2, req, sym:'TUSD', label:'Test Dollar'}`. */
const K = '02798b81951a6a8c7ef8beda09b06a23031d7efaf37b663265e0188ab378124046'
const REQ_HEX =
  'a2781c68747470733a2f2f6272632e6465762f3230372f6174746573746564a266706172616d73a26974727573744d6f6465686964656e746974796b6964656e746974794b657978423032373938623831393531613661386337656638626564613039623036613233303331643765666166333762363633323635653031383861623337383132343034366776657273696f6e01785068747470733a2f2f6769746875622e636f6d2f6273762d626c6f636b636861696e2f6d616e64616c612f626c6f622f6d61737465722f646f63732f70726f66696c65732f6973737565722d76312e6d64a266706172616d73a16b6964656e746974794b657978423032373938623831393531613661386337656638626564613039623036613233303331643765666166333762363633323635653031383861623337383132343034366776657273696f6e01'
const PAYLOAD_HEX = `a4636465630263726571${REQ_HEX}6373796d6454555344656c6162656c6b5465737420446f6c6c6172`
const DEPLOY_SCRIPT_HEX = `00006d4d6d01${PAYLOAD_HEX}7576a914a1d8edf2f9ebd6d2fe4728e0eb3bd369ab78d76a88ac`

/** A 1-input tx whose output 0 is the F-REQ deploy script. */
function deployTx(): Transaction {
  const tx = new Transaction()
  tx.addInput({ sourceTXID: '11'.repeat(32), sourceOutputIndex: 0, unlockingScript: UnlockingScript.fromHex('00') })
  tx.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex(DEPLOY_SCRIPT_HEX) })
  return tx
}
const F_REQ_DEPLOY_TX_HEX = deployTx().toHex()
const F_REQ_ASSET = `${deployTx().id('hex')}_0`

const pkh = (): number[] => Hash.hash160(PrivateKey.fromRandom().toPublicKey().encode(true) as number[])
const valueScript = (assetId: string, amount: bigint): string => new OneColor().lock(assetId, amount, pkh()).toHex()

function rec(over: Partial<InventoryRecord> = {}): InventoryRecord {
  return { outpoint: `${'ee'.repeat(32)}.0`, assetId: ASSET, role: 'value', units: 1n, tags: [], ...over }
}

/** A listOutputs answer per basket; anything else rejects like a missing basket. */
function walletAnswering(answers: Record<string, unknown | ((args: Record<string, unknown>) => unknown)>) {
  const listOutputs = jest.fn(async (args: Record<string, unknown>, _originator?: string) => {
    const a = answers[args.basket as string]
    if (a === undefined) throw new Error(`no basket ${String(args.basket)}`)
    return typeof a === 'function' ? (a as (x: Record<string, unknown>) => unknown)(args) : a
  })
  return Object.assign({ listOutputs } as unknown as WalletInterface, { listOutputs })
}

function inventoryRecord(i: number, over: Record<string, unknown> = {}) {
  const txid = i.toString(16).padStart(64, '0')
  return {
    outpoint: `${txid}.0`,
    satoshis: 1,
    spendable: true,
    lockingScript: valueScript(ASSET, BigInt(i + 1)),
    tags: ['color_state_available'],
    ...over
  }
}

describe('offlineUnitsOf', () => {
  it('offline units come only from color_offline-tagged available records', () => {
    const recs = [
      rec({ units: 100n, tags: ['color_state_available'] }),
      rec({ units: 40n, tags: ['color_state_available', 'color_offline'] }),
      rec({ units: 7n, tags: ['color_state_reserved', 'color_offline'] }),
      rec({ units: 9n, tags: ['color_state_available', 'color_offline'], assetId: OTHER })
    ]
    expect(offlineUnitsOf(recs, ASSET)).toBe(40n)
  })

  it('ignores authority records and sums past 2^64 exactly', () => {
    const big = 18446744073709551615n
    const recs = [
      rec({ units: big, tags: ['color_state_available', 'color_offline'] }),
      rec({ outpoint: `${'ef'.repeat(32)}.1`, units: big, tags: ['color_state_available', 'color_offline'] }),
      rec({ role: 'authority', units: 0n, tags: ['color_state_available', 'color_offline'] })
    ]
    expect(offlineUnitsOf(recs, ASSET)).toBe(2n * big)
  })
})

describe('readAvailable', () => {
  it('reads the exact balance view as bigint', async () => {
    const w = walletAnswering({
      ['p color balance ' + assetTag(ASSET)]: { totalOutputs: '18446744073709551616', outputs: [] }
    })
    expect(await readAvailable(w, ADMIN, ASSET)).toBe(18446744073709551616n)
    expect(w.listOutputs).toHaveBeenCalledWith({ basket: `p color balance ${ASSET.replace('_', 'v')}` }, ADMIN)
  })

  it('reads "0" as zero', async () => {
    const w = walletAnswering({ ['p color balance ' + assetTag(ASSET)]: { totalOutputs: '0', outputs: [] } })
    expect(await readAvailable(w, ADMIN, ASSET)).toBe(0n)
  })

  it.each([[1000], ['01'], ['-1'], ['1.5'], [''], [' 1'], [null], [undefined]])(
    'rejects a non-canonical balance %p',
    async totalOutputs => {
      const w = walletAnswering({ ['p color balance ' + assetTag(ASSET)]: { totalOutputs, outputs: [] } })
      await expect(readAvailable(w, ADMIN, ASSET)).rejects.toThrow(/balance/)
    }
  )

  it('propagates a wallet failure instead of reading zero', async () => {
    await expect(readAvailable(walletAnswering({}), ADMIN, ASSET)).rejects.toThrow(/no basket/)
  })
})

describe('readInventory', () => {
  it('pages the inventory to completion and decodes each record', async () => {
    const all = Array.from({ length: 1003 }, (_, i) => inventoryRecord(i))
    const w = walletAnswering({
      'p color assets': (args: Record<string, unknown>) => {
        const offset = args.offset as number
        const limit = args.limit as number
        return { totalOutputs: all.length, outputs: all.slice(offset, offset + limit) }
      }
    })
    const recs = await readInventory(w, ADMIN)
    expect(recs).toHaveLength(1003)
    expect(w.listOutputs).toHaveBeenCalledTimes(2)
    expect(w.listOutputs.mock.calls[0]).toEqual([
      { basket: 'p color assets', include: 'locking scripts', includeTags: true, limit: 1000, offset: 0 },
      ADMIN
    ])
    expect(w.listOutputs.mock.calls[1][0]).toMatchObject({ offset: 1000 })
    expect(recs[1002]).toEqual({
      outpoint: all[1002].outpoint,
      assetId: ASSET,
      role: 'value',
      units: 1003n,
      tags: ['color_state_available']
    })
  })

  it('keeps an amount above 2^53 exact and reads an authority record as zero units', async () => {
    const big = 18446744073709551615n
    const records = [
      inventoryRecord(0, { lockingScript: valueScript(ASSET, big), tags: ['color_state_available', 'color_offline'] }),
      inventoryRecord(1, { lockingScript: new OneColor().lock(ASSET, 0n, pkh()).toHex() })
    ]
    const w = walletAnswering({ 'p color assets': { totalOutputs: records.length, outputs: records } })
    const recs = await readInventory(w, ADMIN)
    expect(recs[0]).toMatchObject({ units: big, role: 'value', tags: ['color_state_available', 'color_offline'] })
    expect(recs[1]).toMatchObject({ role: 'authority', units: 0n, assetId: ASSET })
  })

  it('counts a record repeated across pages once', async () => {
    const a = inventoryRecord(0)
    const b = inventoryRecord(1)
    const pages = [
      [a, b],
      [b] // the inventory moved between snapshots: b shows again
    ]
    let call = 0
    const w = walletAnswering({
      'p color assets': () => ({ totalOutputs: 3, outputs: pages[call++] ?? [] })
    })
    const recs = await readInventory(w, ADMIN)
    expect(recs.map(r => r.outpoint)).toEqual([a.outpoint, b.outpoint])
  })

  it('refuses a record it cannot decode rather than dropping it', async () => {
    const w = walletAnswering({
      'p color assets': {
        totalOutputs: 1,
        outputs: [inventoryRecord(0, { lockingScript: '76a914' + '00'.repeat(20) + '88ac' })]
      }
    })
    await expect(readInventory(w, ADMIN)).rejects.toThrow(/inventory/)
  })

  it('throws past the page ceiling instead of truncating', async () => {
    let i = 0
    const w = walletAnswering({
      'p color assets': () => ({ totalOutputs: Number.MAX_SAFE_INTEGER, outputs: [inventoryRecord(i++)] })
    })
    await expect(readInventory(w, ADMIN)).rejects.toThrow(/pages/)
  })

  it('rejects a non-numeric inventory count', async () => {
    const w = walletAnswering({ 'p color assets': { totalOutputs: '3', outputs: [inventoryRecord(0)] } })
    await expect(readInventory(w, ADMIN)).rejects.toThrow(/inventory/)
  })
})

describe('createAssetMetadata', () => {
  let raw: DatabaseSync
  let kv: WalletKv

  beforeEach(async () => {
    ;({ raw, kv } = await openTestDb())
  })
  afterEach(() => raw.close())

  const refusingProvider: ColorOverlayProvider = {
    spendability: async () => {
      throw new Error('offline')
    },
    admission: jest.fn(async () => {
      throw new Error('offline')
    }),
    submit: async () => {
      throw new Error('offline')
    }
  }

  it('caches deploy metadata from a declarationTx and reads it offline', async () => {
    const meta = createAssetMetadata(kv, refusingProvider, K)
    await meta.remember(F_REQ_DEPLOY_TX_HEX)
    expect(await meta.info(F_REQ_ASSET)).toMatchObject({
      assetId: F_REQ_ASSET,
      ticker: 'TUSD',
      label: 'Test Dollar',
      decimals: 2,
      resolved: true
    })
    // A second instance (a restart) reads it from the KV cache, still offline.
    const again = createAssetMetadata(kv, refusingProvider, K)
    expect(await again.info(F_REQ_ASSET)).toMatchObject({ ticker: 'TUSD', decimals: 2, resolved: true })
  })

  it('falls back to an unresolved short id when no metadata is reachable', async () => {
    const meta = createAssetMetadata(kv, refusingProvider, K)
    expect(await meta.info(ASSET)).toEqual({
      assetId: ASSET,
      label: shortAssetId(ASSET),
      ticker: '',
      decimals: 0,
      resolved: false
    })
    expect(shortAssetId(ASSET)).not.toBe(ASSET)
  })

  it('resolves through provider.admission for the deploy outpoint', async () => {
    const tx = deployTx()
    const beef = new Beef()
    beef.mergeTransaction(tx)
    const admission = jest.fn(async () => ({
      type: 'output-list' as const,
      outputs: [{ beef: beef.toBinaryAtomic(tx.id('hex')), outputIndex: 0 }]
    }))
    const provider = { ...refusingProvider, admission }
    const meta = createAssetMetadata(kv, provider, K)
    expect(await meta.info(F_REQ_ASSET)).toMatchObject({
      ticker: 'TUSD',
      label: 'Test Dollar',
      decimals: 2,
      resolved: true
    })
    expect(admission).toHaveBeenCalledWith(F_REQ_ASSET, [`${tx.id('hex')}.0`])
    // Persisted: a later instance with no provider still resolves it.
    expect(await createAssetMetadata(kv, undefined, K).info(F_REQ_ASSET)).toMatchObject({ resolved: true })
  })

  it('never resolves an asset from a deploy tx that is not its own', async () => {
    // The overlay answers the right outpoint string with some other tx's bytes.
    const other = new Transaction()
    other.addInput({
      sourceTXID: '22'.repeat(32),
      sourceOutputIndex: 0,
      unlockingScript: UnlockingScript.fromHex('00')
    })
    other.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex(DEPLOY_SCRIPT_HEX) })
    const beef = new Beef()
    beef.mergeTransaction(other)
    const provider = {
      ...refusingProvider,
      admission: async () => ({ type: 'output-list' as const, outputs: [{ beef: beef.toBinary(), outputIndex: 0 }] })
    }
    const meta = createAssetMetadata(kv, provider, K)
    expect(await meta.info(F_REQ_ASSET)).toMatchObject({ resolved: false })
  })

  it('does not resolve a deploy whose req names another overlay key', async () => {
    const meta = createAssetMetadata(kv, refusingProvider, new PrivateKey(3).toPublicKey().toString())
    await meta.remember(F_REQ_DEPLOY_TX_HEX)
    expect(await meta.info(F_REQ_ASSET)).toMatchObject({ resolved: false })
  })

  it('remember ignores bytes that are not a deploy and never throws', async () => {
    const meta = createAssetMetadata(kv, refusingProvider, K)
    await expect(meta.remember('zz')).resolves.toBeUndefined()
    await expect(meta.remember(Utils.toHex([1, 2, 3]))).resolves.toBeUndefined()
  })

  it('does not pin an unresolved answer: a later reachable read resolves', async () => {
    let online = false
    const tx = deployTx()
    const beef = new Beef()
    beef.mergeTransaction(tx)
    const provider = {
      ...refusingProvider,
      admission: async () => {
        if (!online) throw new Error('offline')
        return { type: 'output-list' as const, outputs: [{ beef: beef.toBinary(), outputIndex: 0 }] }
      }
    }
    let clock = 0
    const meta = createAssetMetadata(kv, provider, K, { now: () => clock })
    expect(await meta.info(F_REQ_ASSET)).toMatchObject({ resolved: false })
    online = true
    clock += 60_000
    expect(await meta.info(F_REQ_ASSET)).toMatchObject({ resolved: true, ticker: 'TUSD' })
  })
})
