/**
 * Token reads: inventory, exact balances and asset display metadata (plan 07
 * Task 11).
 *
 * Everything here reads the color module's read-only `listOutputs` views
 * (0207:606-697) through the published manager, as the admin originator:
 *
 *  · `p color assets` — the inventory. Ordinary output records for real
 *    outpoints, each with exactly one wallet-authored state tag
 *    (`color_state_available|reserved|pending|restricted`) and, for an
 *    offline credit, the additional `color_offline` tag (0207:396-404).
 *  · `p color balance <assetTag>` — the exact available sum of one asset, as
 *    a canonical decimal string with no uint64 ceiling (BRC-112).
 *
 * Every read is exact or a throw. A partial page, a non-canonical amount or a
 * record that does not decode is an error, never a smaller number: a balance
 * screen that shows less than the truth invites a second payment, and one that
 * shows offline value as settled hides settlement risk (W10, Review Focus 4).
 *
 * Display metadata (label, ticker, decimals) comes from the asset's deploy tx
 * through lib `readDeploy` (W7). It is untrusted display data, but it is
 * hash-bound: a deploy tx is only ever filed under the asset id derived from
 * its own txid, so no counterparty can rename somebody else's asset.
 */
import { Transaction, type WalletInterface } from '@bsv/sdk'
import { COLOR_OFFLINE_TAG, type ColorOverlayProvider } from '@bsv/color-permission-module'
import { assetTag, decodeToken, readDeploy } from '@bsv/mandala'
import type { WalletKv } from './kvStore'
import type { TokenAssetInfo } from './runtime'
import { devLog } from '../logging'

/** The inventory selector (0207:612). A query, never a storage basket. */
export const ASSETS_VIEW = 'p color assets'
/** The available-state tag every spendable inventory record carries (0207:643-646). */
export const STATE_AVAILABLE_TAG = 'color_state_available'

/**
 * One inventory page, and the hard stop on paging. A thousand is one round
 * trip for any realistic wallet; the page ceiling stops a wallet that reports
 * a count it never serves from spinning a balance read, and it throws rather
 * than truncating (0207:663-664).
 */
const INVENTORY_PAGE = 1000
const INVENTORY_MAX_PAGES = 1000

const CANONICAL_UNITS = /^(0|[1-9][0-9]*)$/
const ASSET_ID = /^[0-9a-f]{64}_(0|[1-9][0-9]{0,9})$/
const OUTPOINT = /^([0-9a-f]{64})\.(0|[1-9][0-9]{0,9})$/
/** IC §4: a deploy's `dec` is 0..18. */
const MAX_DECIMALS = 18

export interface InventoryRecord {
  /** `<txid>.<vout>` (IC §0). */
  outpoint: string
  /** `<64 lowercase hex>_<vout>`. */
  assetId: string
  role: 'value' | 'authority'
  /** Exact token units of this output. Zero for an authority record. */
  units: bigint
  /** Wallet-authored tags as the module reported them (state tag, `color_offline`). */
  tags: string[]
}

function inventoryError(detail: string): Error {
  return new Error(`p color assets inventory: ${detail}`)
}

/** One inventory output record decoded from its own locking script, or a throw. */
function decodeRecord(output: unknown): InventoryRecord {
  const o = output as { outpoint?: unknown; lockingScript?: unknown; tags?: unknown }
  const m = typeof o?.outpoint === 'string' ? OUTPOINT.exec(o.outpoint) : null
  if (m == null) throw inventoryError(`record with an invalid outpoint ${JSON.stringify(o?.outpoint)}`)
  const outpoint = o.outpoint as string
  if (typeof o.lockingScript !== 'string' || o.lockingScript === '') {
    throw inventoryError(`record ${outpoint} has no locking script`)
  }
  const tags = o.tags ?? []
  if (!Array.isArray(tags) || !tags.every(t => typeof t === 'string')) {
    throw inventoryError(`record ${outpoint} has invalid tags`)
  }
  // vout is an output index, not a token amount: Number() is exact here.
  const decoded = decodeToken(o.lockingScript, m[1], Number(m[2]))
  if (decoded == null || decoded.assetId == null || !ASSET_ID.test(decoded.assetId)) {
    throw inventoryError(`record ${outpoint} is not a 1Color token output`)
  }
  // A deploy output holds the new asset itself: its supply is value (deploy-fixed),
  // and a zero-amount deploy is the asset's authority (deploy-authority).
  const role: 'value' | 'authority' =
    decoded.role === 'value' || (decoded.role === 'deploy' && decoded.amount > 0n) ? 'value' : 'authority'
  return {
    outpoint,
    assetId: decoded.assetId,
    role,
    units: role === 'value' ? decoded.amount : 0n,
    tags: [...(tags as string[])]
  }
}

/**
 * Every record of the `p color assets` inventory, decoded, paged to completion.
 *
 * `totalOutputs` drives the paging (a short page is not the end: a wallet may
 * cap `limit`). An empty page ends it, which also stops a wallet that ignores
 * `offset`. Pages are separate snapshots (0207:657-660), so a record that
 * shows again on a later page is the same outpoint, never more value: records
 * are de-duplicated by outpoint.
 */
export async function readInventory(wallet: WalletInterface, originator: string): Promise<InventoryRecord[]> {
  const byOutpoint = new Map<string, InventoryRecord>()
  let offset = 0
  for (let page = 0; page < INVENTORY_MAX_PAGES; page++) {
    const chunk = (await wallet.listOutputs(
      { basket: ASSETS_VIEW, include: 'locking scripts', includeTags: true, limit: INVENTORY_PAGE, offset },
      originator
    )) as { totalOutputs?: unknown; outputs?: unknown }
    const total = chunk.totalOutputs
    if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0) {
      throw inventoryError(`invalid totalOutputs ${JSON.stringify(total)}`)
    }
    if (!Array.isArray(chunk.outputs)) throw inventoryError('page has no outputs array')
    for (const output of chunk.outputs) {
      const record = decodeRecord(output)
      if (!byOutpoint.has(record.outpoint)) byOutpoint.set(record.outpoint, record)
    }
    if (chunk.outputs.length === 0) return [...byOutpoint.values()]
    offset += chunk.outputs.length
    if (offset >= total) return [...byOutpoint.values()]
  }
  throw inventoryError(`more than ${INVENTORY_MAX_PAGES} pages; refusing to truncate`)
}

/**
 * The exact available units of `assetId`: the `p color balance <assetTag>`
 * view's `totalOutputs`, which must be a canonical decimal string (BRC-112).
 * A JSON number, a leading zero or anything else is a thrown error — a number
 * would already have lost precision above 2^53.
 */
export async function readAvailable(wallet: WalletInterface, originator: string, assetId: string): Promise<bigint> {
  return await readBalanceView(wallet, originator, assetId)
}

/**
 * The pending (offline-credited, not yet settled) units of `assetId`: the
 * same balance view filtered to `color_offline` (B7 API: "Pending balance").
 * A subset of `readAvailable`, never added to it.
 */
export async function readPending(wallet: WalletInterface, originator: string, assetId: string): Promise<bigint> {
  return await readBalanceView(wallet, originator, assetId, [COLOR_OFFLINE_TAG])
}

async function readBalanceView(
  wallet: WalletInterface,
  originator: string,
  assetId: string,
  tags?: string[]
): Promise<bigint> {
  const basket = `p color balance ${assetTag(assetId)}`
  const r = (await wallet.listOutputs(tags ? { basket, tags } : { basket }, originator)) as { totalOutputs?: unknown }
  const total = r?.totalOutputs
  if (typeof total !== 'string' || !CANONICAL_UNITS.test(total)) {
    throw new Error(`${basket}${tags ? ` [${tags.join(',')}]` : ''}: non-canonical balance ${JSON.stringify(total)}`)
  }
  return BigInt(total)
}

/**
 * The offline (not yet overlay-settled) part of `assetId`'s available units:
 * value records that carry BOTH `color_state_available` and `color_offline`.
 * A reserved or pending record is not available and is not counted, whatever
 * else it carries (0207:396-404).
 */
export function offlineUnitsOf(records: readonly InventoryRecord[], assetId: string): bigint {
  let sum = 0n
  for (const r of records) {
    if (r.assetId !== assetId || r.role !== 'value') continue
    if (r.tags.includes(STATE_AVAILABLE_TAG) && r.tags.includes(COLOR_OFFLINE_TAG)) sum += r.units
  }
  return sum
}

// ─────────────────────────────── metadata ───────────────────────────────

/** The label an asset with no readable deploy shows. The full id is always available beside it. */
export function shortAssetId(assetId: string): string {
  return `${assetId.slice(0, 20)}…`
}

/** KV key of an asset's cached deploy metadata (W7). */
export function assetMetadataKey(assetId: string): string {
  return `bsvwallet.color.asset.${assetId}`
}

interface CachedDeploy {
  v: 1
  sym?: string
  dec: number
  label?: string
}

/** How long an UNRESOLVED answer is reused before the overlay is asked again. */
const UNRESOLVED_TTL_MS = 10_000

function unresolved(assetId: string): TokenAssetInfo {
  return { assetId, label: shortAssetId(assetId), ticker: '', decimals: 0, resolved: false }
}

function fromDeploy(assetId: string, d: CachedDeploy): TokenAssetInfo {
  return {
    assetId,
    label: d.label !== undefined && d.label !== '' ? d.label : shortAssetId(assetId),
    ticker: d.sym ?? '',
    decimals: d.dec,
    resolved: true
  }
}

function parseCached(text: string): CachedDeploy | undefined {
  try {
    const v = JSON.parse(text) as Partial<CachedDeploy>
    if (v?.v !== 1 || typeof v.dec !== 'number' || !Number.isInteger(v.dec) || v.dec < 0 || v.dec > MAX_DECIMALS) {
      return undefined
    }
    if (v.sym !== undefined && typeof v.sym !== 'string') return undefined
    if (v.label !== undefined && typeof v.label !== 'string') return undefined
    return {
      v: 1,
      dec: v.dec,
      ...(v.sym !== undefined ? { sym: v.sym } : {}),
      ...(v.label !== undefined ? { label: v.label } : {})
    }
  } catch {
    return undefined
  }
}

/**
 * The deploy metadata of `tx`, filed under the asset id its OWN txid names, or
 * undefined. Only a deploy whose `req` is exactly `mandalaReq(K)` for this
 * wallet's overlay key resolves: any other asset fails closed against the
 * Mandala overlay anyway (W3), and is shown by its short id.
 */
function deployOf(tx: Transaction, overlayIdentityKey: string): { assetId: string; cached: CachedDeploy } | undefined {
  const txid = tx.id('hex')
  const script = tx.outputs[0]?.lockingScript
  if (script == null) return undefined
  const d = readDeploy(script, txid)
  if (d == null || d.assetId !== `${txid}_0` || d.mandalaKey !== overlayIdentityKey) return undefined
  if (!Number.isInteger(d.dec) || d.dec < 0 || d.dec > MAX_DECIMALS) return undefined
  return {
    assetId: d.assetId,
    cached: {
      v: 1,
      dec: d.dec,
      ...(d.sym !== undefined ? { sym: d.sym } : {}),
      ...(d.label !== undefined ? { label: d.label } : {})
    }
  }
}

/**
 * The deploy tx of `assetId` from the overlay's `color-admission` answer for
 * `<txid>.0`, checked the way the module checks it: valid BEEF, the named
 * output exists, and the tx's own id is the asset's txid.
 */
async function deployFromProvider(provider: ColorOverlayProvider, assetId: string): Promise<Transaction | undefined> {
  const txid = assetId.slice(0, 64)
  const answer = await provider.admission(assetId, [`${txid}.0`])
  if (answer?.type !== 'output-list' || !Array.isArray(answer.outputs)) return undefined
  for (const item of answer.outputs) {
    if (item.outputIndex !== 0) continue
    let tx: Transaction
    try {
      tx = Transaction.fromBEEF(item.beef, item.txid)
    } catch {
      continue
    }
    if (tx.id('hex') === txid) return tx
  }
  return undefined
}

/**
 * Display metadata for assets, from a cached deploy first and the
 * overlay's deploy answer second (W7).
 *
 *  · `remember(hex)` files a deploy tx under the asset id of its own txid
 *    (receipts carry no deploy since B7). It never throws:
 *    a bad hex string or a non-deploy is ignored.
 *  · `info(assetId)` answers from memory, then the KV cache, then
 *    `provider.admission`. A resolved answer is cached for good (it is a pure
 *    function of the hash-bound deploy). An unresolved one is reused only for
 *    ~10 s, so a read made offline does not pin "unknown" until a restart.
 *    Concurrent reads of one asset share one lookup.
 */
export function createAssetMetadata(
  kv: WalletKv,
  provider: ColorOverlayProvider | undefined,
  overlayIdentityKey: string,
  opts: { now?: () => number } = {}
): { info(assetId: string): Promise<TokenAssetInfo>; remember(declarationTxHex: string): Promise<void> } {
  const now = opts.now ?? (() => Date.now())
  const resolvedMemo = new Map<string, TokenAssetInfo>()
  const unresolvedMemo = new Map<string, number>()
  const inFlight = new Map<string, Promise<TokenAssetInfo>>()

  const store = async (assetId: string, cached: CachedDeploy): Promise<void> => {
    resolvedMemo.set(assetId, fromDeploy(assetId, cached))
    unresolvedMemo.delete(assetId)
    try {
      await kv.setKeyValue(assetMetadataKey(assetId), JSON.stringify(cached))
    } catch (e) {
      // Display data only: the in-memory answer still serves this session.
      devLog(`[mandala] could not cache metadata for ${assetId}:`, e)
    }
  }

  const lookup = async (assetId: string): Promise<TokenAssetInfo> => {
    try {
      const text = await kv.getKeyValue(assetMetadataKey(assetId))
      const cached = text === undefined ? undefined : parseCached(text)
      if (cached !== undefined) {
        const info = fromDeploy(assetId, cached)
        resolvedMemo.set(assetId, info)
        return info
      }
    } catch (e) {
      devLog(`[mandala] could not read cached metadata for ${assetId}:`, e)
    }
    if (provider !== undefined) {
      try {
        const tx = await deployFromProvider(provider, assetId)
        const d = tx === undefined ? undefined : deployOf(tx, overlayIdentityKey)
        if (d !== undefined && d.assetId === assetId) {
          await store(assetId, d.cached)
          return resolvedMemo.get(assetId) as TokenAssetInfo
        }
      } catch (e) {
        devLog(`[mandala] could not resolve the deploy of ${assetId}:`, e)
      }
    }
    unresolvedMemo.set(assetId, now())
    return unresolved(assetId)
  }

  return {
    async info(assetId) {
      const hit = resolvedMemo.get(assetId)
      if (hit !== undefined) return hit
      const at = unresolvedMemo.get(assetId)
      if (at !== undefined && now() - at < UNRESOLVED_TTL_MS) return unresolved(assetId)
      if (!ASSET_ID.test(assetId)) return unresolved(assetId)
      let p = inFlight.get(assetId)
      if (p === undefined) {
        p = lookup(assetId).finally(() => inFlight.delete(assetId))
        inFlight.set(assetId, p)
      }
      return await p
    },

    async remember(declarationTxHex) {
      try {
        if (typeof declarationTxHex !== 'string' || !/^([0-9a-f]{2})+$/.test(declarationTxHex)) return
        const d = deployOf(Transaction.fromHex(declarationTxHex), overlayIdentityKey)
        if (d !== undefined) await store(d.assetId, d.cached)
      } catch (e) {
        devLog('[mandala] ignored a declarationTx that is not a readable deploy:', e)
      }
    }
  }
}
