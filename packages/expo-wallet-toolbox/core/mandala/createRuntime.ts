/**
 * `createMandalaRuntime` — the one construction site for `MandalaRuntime`.
 *
 * This file is the seam between the wallet and the token stack. Everything
 * above it (the UI, `useMandala()`) sees only `runtime.ts`'s pure interface;
 * everything below it is reached from here:
 *
 *  · the color permission module (`settle`, `handoffEvidence`), which holds
 *    every token and all evidence;
 *  · its read-only `listOutputs` views (`p color assets`, `p color balance
 *    <assetTag>`), read through the PUBLISHED manager as the admin originator
 *    (`assets.ts`);
 *  · `@bsv/mandala` 0.5.0 for deploy reads, admin state and the registry;
 *  · the wallet's own `color_transfers` journal, the one key the broadcast
 *    hold and the abort refusal read.
 *
 * Plan 07 Task 11 builds the reads, Task 12 settlement (`settle.ts`) and
 * Task 13 the handle rail (`handle.ts`), Task 15 the nearby payer hooks
 * (`nearby.ts`), Task 16 the nearby payee hook (`nearby.onReceived`), and
 * Task 17 the drain tick (`tick`).
 */
import { PublicKey, type WalletInterface } from '@bsv/sdk'
import type { ColorOverlayProvider, ColorPermissionModule } from '@bsv/color-permission-module'
import { fetchRegistry, registryIsLive, type OverlayRegistryRow } from '@bsv/mandala'
import { resolveAssetState, type AssetAdminStateView } from '@bsv/mandala/adminState'
import type { AppChain } from '../config'
import type { MandalaEndpointConfig } from '../toolboxConfig'
import type { StorageExpoSQLite } from '../storage/StorageExpoSQLite'
import { devLog } from '../logging'
import { makeResendBeef, type LocalBeefStorage } from '../peerpay/resendBeef'
import { findOfflineActions, type OfflineDb } from '../storage/methods/offlineActions'
import { createAssetMetadata, offlineUnitsOf, readAvailable, readInventory, STATE_AVAILABLE_TAG } from './assets'
import type { WalletKv } from './kvStore'
import {
  receiveFromInbox as receiveHandleInbox,
  redeliverPending,
  resendTransfer as resendHandle,
  sendToHandle as sendHandle,
  type HandleDeps,
  type MandalaMessageBox
} from './handle'
import {
  createSettler,
  isHandoverAdmitted as readIsHandoverAdmitted,
  reconcileHeldTransfers,
  reportIsUnreachable,
  type Settler
} from './settle'
import { createNearbyPayer } from './nearby'
import { createTransferJournal, type JournalDb, type TransferJournal } from './transferJournal'
import {
  COLOR_TRANSFER_STATES,
  STUCK_AFTER_MS,
  TERMINAL_TRANSFER_STATES,
  type ColorTransferRow,
  type ColorTransferState
} from './types'
import type {
  MandalaRuntime,
  NearbyTokenDeps,
  TokenActivityRow,
  TokenActivityStatus,
  TokenAssetInfo,
  TokenAssetStatus,
  TokenBalance,
  TokenHoldingsReview
} from './runtime'

export { createMandalaKvStorage, type WalletKv as MandalaKvStorage } from './kvStore'

export type { MandalaMessageBox } from './handle'

export interface CreateMandalaRuntimeArgs {
  /** The PUBLISHED permissions manager. Every call is bound to `adminOriginator` (see `bindOriginator`). */
  wallet: WalletInterface
  adminOriginator: string
  /** Supplies the `color_transfers` journal and the key-value cache. */
  storage: StorageExpoSQLite
  chain: AppChain
  endpoints: MandalaEndpointConfig | undefined
  /** The registered color module (`BuiltColorModule.module`). */
  color: Pick<ColorPermissionModule, 'settle' | 'handoffEvidence'> | undefined
  /** The module's Mandala overlay provider (`BuiltColorModule.provider`). */
  provider: ColorOverlayProvider | undefined
  /** Built lazily on first use so constructing a runtime does no I/O and needs no network. */
  messageBox?: () => Promise<MandalaMessageBox>
  /**
   * AtomicBEEF of a txid from the network, for a hand-over resend (Task 13).
   * This device's own stored copy is the fallback (`makeResendBeef`): a
   * hand-over that was never broadcast is known to no service.
   */
  refetchBeef?: (txid: string) => Promise<number[] | undefined>
  /** Whether this device has signal; decides whether a send takes its own settle now (Task 13). */
  isOnline?: () => Promise<boolean>
  now?: () => Date
}

/**
 * Every call runs as the admin originator.
 *
 * Library code takes a `WalletInterface` and passes no originator, which
 * against the permissions manager means "an anonymous caller", and the
 * `p color` views are P-routed: an anonymous `listOutputs` would raise a
 * permission prompt for the wallet's own balance screen. Binding here keeps
 * exactly one place in the wallet that claims admin authority. An originator
 * the caller passes explicitly is kept.
 */
export function bindOriginator<T extends object>(wallet: T, originator: string): T {
  return new Proxy(wallet, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown
      if (typeof value !== 'function') return value
      return (args: unknown, callerOriginator?: string) =>
        (value as (a: unknown, o?: string) => unknown).call(target, args, callerOriginator ?? originator)
    }
  })
}

const SETTLING_STATES: readonly ColorTransferState[] = COLOR_TRANSFER_STATES.filter(
  s => !TERMINAL_TRANSFER_STATES.includes(s)
)
/** Every state the activity list shows: a cancelled send never moved money. */
const ACTIVITY_STATES: readonly ColorTransferState[] = COLOR_TRANSFER_STATES.filter(s => s !== 'cancelled')

/**
 * How a journal row reads on the activity list, or `undefined` for a row the
 * list never shows (a cancelled send).
 *
 * `settled` is the overlay's verified admission, which is exactly what the ux
 * copy means by "settled with {{issuer}}". Every other non-terminal state is
 * `settling`, or `stuck` once it is older than `olderThanMs`.
 */
export function activityStatusOf(
  row: Pick<ColorTransferRow, 'state' | 'createdAt'>,
  nowMs: number,
  olderThanMs = STUCK_AFTER_MS
): TokenActivityStatus | undefined {
  switch (row.state) {
    case 'settled':
      return 'settled'
    case 'refused':
      return 'refused'
    case 'cancelled':
      return undefined
    default: {
      const at = Date.parse(row.createdAt)
      return Number.isFinite(at) && nowMs - at >= olderThanMs ? 'stuck' : 'settling'
    }
  }
}

/**
 * The journal a runtime with no database exposes. Every method rejects: the
 * broadcast hold and the abort refusal read this journal, and a missing
 * database must read as "cannot answer" (hold, refuse), never as "no row".
 */
function unavailableJournal(): TransferJournal {
  const refuse = async (): Promise<never> => {
    throw new Error('color_transfers: the wallet database is not open')
  }
  return {
    get: refuse,
    getByReference: refuse,
    list: refuse,
    insert: refuse,
    advance: refuse,
    setDelivered: refuse,
    statesOf: refuse
  }
}

const RECIPIENT_REFUSAL =
  'Mandala tokens can only be sent to an identity key (66-hex compressed public key), not to an address — the token output is derived against the recipient identity and the overlay refuses anything else'

/**
 * Plain reason a recipient string cannot receive tokens, or null. A key must
 * be 66-hex compressed AND on the curve: an off-curve key has no derivable
 * child, so a hand-over to it could never be built. Sending to one's own
 * identity key is allowed (a self hand-over is valid, plan 07).
 */
function recipientRefusalOf(recipient: string): string | null {
  const key = typeof recipient === 'string' ? recipient.trim() : ''
  if (key === '') return 'Recipient identity key is required'
  if (!/^(02|03)[0-9a-fA-F]{64}$/.test(key)) return RECIPIENT_REFUSAL
  try {
    // Round-trip: an x that is not a field element (≥ p) parses after a
    // reduction, so it must also re-encode to the same key.
    if (PublicKey.fromString(key).toString() !== key.toLowerCase()) return RECIPIENT_REFUSAL
  } catch {
    return RECIPIENT_REFUSAL
  }
  return null
}

const ASSET_STATUS_TTL_MS = 10_000

interface AssetStatusSnapshot {
  state: AssetAdminStateView | null
  registryRows: OverlayRegistryRow[]
  registryActive: boolean
  metadataResolved: boolean
}

export function createMandalaRuntime(args: CreateMandalaRuntimeArgs): MandalaRuntime {
  const { wallet, adminOriginator, storage, endpoints, color, provider } = args
  const now = args.now ?? (() => new Date())
  const db = storage.sqliteDb
  const available = endpoints !== undefined && color !== undefined && provider !== undefined && db !== undefined
  const config: MandalaEndpointConfig = endpoints ?? { overlayUrl: '', overlayIdentityKey: '', messageBoxUrl: '' }
  const journal: TransferJournal = db ? createTransferJournal(db as unknown as JournalDb, now) : unavailableJournal()
  const bound = bindOriginator(wallet, adminOriginator)
  const metadata = createAssetMetadata(storage as unknown as WalletKv, provider, config.overlayIdentityKey)

  const listeners = new Set<() => void>()
  const emit = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch (e) {
        devLog('[mandala] a runtime subscriber threw:', e)
      }
    }
  }

  // Lazy MessageBox (handle rail, Task 13). A FAILURE is never memoized:
  // construction can fail for transient reasons (no network at launch), and a
  // cached rejection would poison every later inbox drain for the process.
  let messageBoxPromise: Promise<MandalaMessageBox> | undefined
  const messageBox = async (): Promise<MandalaMessageBox> => {
    if (!args.messageBox) throw new Error('Mandala: no MessageBox client is configured')
    messageBoxPromise ??= args.messageBox().catch((e: unknown) => {
      messageBoxPromise = undefined
      throw e
    })
    return await messageBoxPromise
  }

  // Lazy identity key; a failed read is retried on the next call.
  let identityKeyPromise: Promise<string> | undefined
  const identityKey = async (): Promise<string> => {
    identityKeyPromise ??= bound
      .getPublicKey({ identityKey: true })
      .then(r => r.publicKey)
      .catch((e: unknown) => {
        identityKeyPromise = undefined
        throw e
      })
    return await identityKeyPromise
  }

  // ── Asset status facts (paused / frozen / access mode / admission) ──
  //
  // Display copy only, never a gate: every read is best-effort, and a stale or
  // unreachable overlay reads as the least alarming answer, never a throw.

  const assetStatusCache = new Map<string, { at: number; snapshot: AssetStatusSnapshot }>()

  const isAdmittedIn = (rows: OverlayRegistryRow[], key: string): boolean =>
    rows.some(r => r.identityKey.toLowerCase() === key.toLowerCase() && r.status === 'admitted')

  const loadAssetStatusSnapshot = async (
    assetId: string,
    opts: { force?: boolean } = {}
  ): Promise<AssetStatusSnapshot> => {
    const [state, registryRows, info] = await Promise.all([
      (async () => {
        try {
          return await resolveAssetState(assetId, opts)
        } catch (e) {
          devLog(`[mandala] could not resolve admin state for ${assetId}:`, e)
          return null
        }
      })(),
      (async () => {
        try {
          return await fetchRegistry()
        } catch (e) {
          devLog('[mandala] could not fetch the identity registry:', e)
          return [] as OverlayRegistryRow[]
        }
      })(),
      metadata.info(assetId)
    ])
    return { state, registryRows, registryActive: registryIsLive(registryRows), metadataResolved: info.resolved }
  }

  const buildAssetStatus = async (snapshot: AssetStatusSnapshot): Promise<TokenAssetStatus> => {
    const { state, registryRows, registryActive, metadataResolved } = snapshot
    let mine: string | undefined
    if (registryActive) {
      try {
        mine = await identityKey()
      } catch (e) {
        devLog('[mandala] could not read the identity key for asset status:', e)
      }
    }
    let frozenUnits = 0n
    for (const o of state?.frozenOutpoints ?? []) {
      if (typeof o.amount === 'bigint' && o.amount > 0n) frozenUnits += o.amount
    }
    return {
      paused: state?.isPaused ?? false,
      frozenUnits,
      ...(state?.accessMode !== undefined ? { accessMode: state.accessMode } : {}),
      selfAdmitted: registryActive && mine !== undefined ? isAdmittedIn(registryRows, mine) : undefined,
      recipientAdmitted: async (recipientIdentityKey: string) =>
        registryActive ? isAdmittedIn(registryRows, recipientIdentityKey) : undefined,
      metadataResolved,
      messageBoxUrl: config.messageBoxUrl
    }
  }

  /**
   * A cache entry is stamped with the time of the LOAD that produced it, never
   * the time it was last read: a self-renewing stamp would keep one snapshot
   * alive forever under a screen that polls faster than the TTL.
   */
  const assetStatus = async (assetId: string): Promise<TokenAssetStatus> => {
    const cached = assetStatusCache.get(assetId)
    if (cached && now().getTime() - cached.at < ASSET_STATUS_TTL_MS) return await buildAssetStatus(cached.snapshot)
    const snapshot = await loadAssetStatusSnapshot(assetId)
    assetStatusCache.set(assetId, { at: now().getTime(), snapshot })
    return await buildAssetStatus(snapshot)
  }

  const refreshAssetStatus = async (assetId: string): Promise<TokenAssetStatus> => {
    const snapshot = await loadAssetStatusSnapshot(assetId, { force: true })
    assetStatusCache.set(assetId, { at: now().getTime(), snapshot })
    return await buildAssetStatus(snapshot)
  }

  /** Metadata for many assets, one lookup per distinct id. */
  const infosOf = async (assetIds: Iterable<string>): Promise<Map<string, TokenAssetInfo>> => {
    const ids = [...new Set(assetIds)]
    const infos = await Promise.all(ids.map(id => metadata.info(id)))
    return new Map(ids.map((id, i) => [id, infos[i]]))
  }

  // ── Settlement (Task 12) ──
  //
  // One settler per runtime: its per-txid and settle-all single flights are
  // what keep a drain tick and a screen from settling the same txid twice.
  // Without the module or a database there is nothing to settle with, and
  // every member says so rather than pretending.
  const settler: Settler | undefined =
    color !== undefined && db !== undefined
      ? createSettler({
          color,
          journal,
          // Through the PUBLISHED manager, so the abort guard decides; the row
          // already reads `refused` when this runs.
          abort: async reference => await bound.abortAction({ reference }),
          onChange: emit
        })
      : undefined

  const reviewTokenHoldings = async (): Promise<TokenHoldingsReview> => {
    let unreachable = true
    if (settler) {
      try {
        unreachable = reportIsUnreachable((await settler.settleAllReport()).report)
      } catch (e) {
        devLog('[mandala] reviewing token holdings: settle failed:', e)
      }
    }
    const rows = await journal.list()
    const count = (pred: (s: ColorTransferState) => boolean): number => rows.filter(r => pred(r.state)).length
    return {
      settled: count(s => s === 'settled'),
      refused: count(s => s === 'refused'),
      pending: count(s => !TERMINAL_TRANSFER_STATES.includes(s)),
      unreachable
    }
  }

  /** Settles `held` receipts the module inventory shows admitted (shared by the runtime and the inbox). */
  async function reconcileHeld(txids: readonly string[]): Promise<void> {
    if (db === undefined || txids.length === 0) return
    const changed = await reconcileHeldTransfers(
      { journal, inventory: async () => await readInventory(bound, adminOriginator) },
      txids
    )
    if (changed > 0) emit()
  }

  // ── Handle rail (Task 13) ──
  //
  // One deps object per runtime: the per-asset send latch, the in-delivery set
  // and the redeliver/receive single flights hang off it.
  const handleDeps: HandleDeps | undefined =
    color !== undefined && db !== undefined
      ? {
          wallet: bound,
          identityKey,
          journal,
          color,
          messageBox,
          settleNow: async txid => (settler ? await settler.settleNow(txid) : 'unavailable'),
          isOnline: args.isOnline ?? (async () => true),
          rememberDeploy: async hex => {
            await metadata.remember(hex)
            emit()
          },
          refetch: makeResendBeef({
            refetch: args.refetchBeef ?? (async () => undefined),
            storage: storage as unknown as LocalBeefStorage
          }),
          processed: new Set<string>(),
          now,
          recipientRefusal: recipientRefusalOf,
          reconcileHeld,
          onChange: emit
        }
      : undefined

  // ── Nearby rail, payer half (Task 15) ──
  //
  // `onHandedOver` needs only the journal, so a payment built before the
  // module went away can still be parked or released. `handover` needs the
  // module too; without either it refuses rather than building a payment
  // nothing could journal or settle.
  const nearbyPayer =
    db !== undefined
      ? createNearbyPayer({ wallet: bound, identityKey, journal, recipientRefusal: recipientRefusalOf, onChange: emit })
      : undefined
  const nearbyUnavailable = async (): Promise<never> => {
    throw new Error('Stablecoins are not available on this network')
  }
  // ── Nearby rail, payee half (Task 16) ──
  //
  // Told how a nearby receipt internalize settled. A credit is journaled
  // `held` FIRST and only then promoted from the module inventory
  // (`reconcileHeld`), the handle rail's order (Task 13): a row exists before
  // any view read, and an unreadable or not-yet-listing view leaves it held,
  // never settled (Review Focus 4). A definitive refusal is journaled
  // `refused` with its code; a retriable failure writes nothing (a missing
  // row already holds, W1). Every write is INSERT OR IGNORE, so a replay, a
  // second tab or a later refusal of an already credited txid never forks or
  // downgrades the row.
  const onReceived: NearbyTokenDeps['onReceived'] = async (a, outcome) => {
    if (db === undefined) await nearbyUnavailable()
    if (outcome.ok) {
      const wrote = await journal.insert({
        txid: a.txid,
        role: 'received',
        assetId: a.assetId,
        units: a.units,
        outputIndex: a.outputIndex,
        rail: 'nearby',
        state: 'held',
        delivered: false,
        counterpartyKey: a.counterpartyKey
      })
      if (wrote) emit()
      try {
        await reconcileHeld([a.txid])
      } catch (e) {
        devLog(`[mandala] nearby: reconciling the receipt ${a.txid} failed; it stays held:`, e)
      }
      if (a.declarationTx !== undefined) {
        try {
          await metadata.remember(a.declarationTx)
          emit()
        } catch (e) {
          devLog('[mandala] nearby: caching a received deploy failed:', e)
        }
      }
      return
    }
    if (!outcome.final) return
    if (
      await journal.insert({
        txid: a.txid,
        role: 'received',
        assetId: a.assetId,
        units: a.units,
        outputIndex: a.outputIndex,
        rail: 'nearby',
        state: 'refused',
        delivered: false,
        code: outcome.code,
        counterpartyKey: a.counterpartyKey
      })
    ) {
      emit()
    }
  }

  // ── Drain tick (Task 17) ──

  /**
   * Txids of queued release rows (`offline_actions` `queued`/`posting`, where
   * the broadcast hold parks a token req) that the hold still names: a 1Color
   * tx whose journal row is not `settled`. A plain BSV row is dropped by the
   * bytes alone, so it never costs an inventory read. Every fault propagates;
   * the tick turns it into "reconcile nothing this pass".
   */
  const heldColorTxids = async (): Promise<string[]> => {
    if (db === undefined) return []
    const rows = await findOfflineActions(db as unknown as OfflineDb, { status: ['queued', 'posting'] })
    if (rows.length === 0) return []
    const reqs: { txid: string; rawTx?: number[] }[] = []
    for (const r of rows) {
      // Per row, like the release pass's own `findReq`: one unreadable request
      // must not starve the rest. With no bytes `colorHeldTxids` still names
      // it (fail closed), and the inventory read decides whether it is ours.
      let rawTx: number[] | undefined
      try {
        rawTx = (await storage.findProvenTxReqs({ partial: { txid: r.txid } }))[0]?.rawTx
      } catch (e) {
        devLog(`[mandala] tick: could not read the request for ${r.txid}:`, e)
      }
      reqs.push({ txid: r.txid, rawTx })
    }
    return [...(await storage.colorHeldTxids(reqs))]
  }

  /**
   * One drain pass, in this order, each step on its own:
   *  1. redeliver every hand-over whose MessageBox delivery is not known to
   *     have happened (W4), each one then named to `settleNow`;
   *  2. the bare module settle (IC §8.2), which moves journal rows the overlay
   *     admitted or refused;
   *  3. journal the held 1Color receipts the release queue carries (Review
   *     Focus 4): `held` while any record is `color_offline`, else `settled`.
   *
   * Never throws: a step that fails is logged and the next one still runs,
   * because each is independently useful and the caller (the monitor task)
   * must go on to the release pass. Concurrent callers coalesce below this
   * (the redeliver and settle-all single flights; INSERT OR IGNORE and CAS
   * journal writes), so a tick racing a screen moves each row once.
   */
  const tick = async (): Promise<void> => {
    if (handleDeps) {
      try {
        await redeliverPending(handleDeps)
      } catch (e) {
        devLog('[mandala] tick: redelivery failed:', e)
      }
    }
    if (settler) {
      try {
        await settler.settleAll()
      } catch (e) {
        devLog('[mandala] tick: settle failed:', e)
      }
    }
    if (db !== undefined) {
      try {
        await reconcileHeld(await heldColorTxids())
      } catch (e) {
        devLog('[mandala] tick: reconciling held receipts failed; they stay as journaled:', e)
      }
    }
    emit()
  }

  const nearby: NearbyTokenDeps = {
    handover: nearbyPayer && color !== undefined ? nearbyPayer.handover : nearbyUnavailable,
    onHandedOver: nearbyPayer ? nearbyPayer.onHandedOver : nearbyUnavailable,
    onReceived
  }

  const runtime: MandalaRuntime = {
    available,
    endpoints: config,
    journal,

    async listAssets(): Promise<TokenAssetInfo[]> {
      const ids = new Set<string>()
      for (const r of await readInventory(bound, adminOriginator)) ids.add(r.assetId)
      // Assets this wallet has ever journaled, not only ones it still holds: a
      // spent-down asset keeps its name on the activity list.
      for (const row of await journal.list()) ids.add(row.assetId)
      const infos = await infosOf([...ids].sort())
      return [...infos.values()]
    },

    async balances(): Promise<TokenBalance[]> {
      // Rejects on any read fault: the UI renders a rejection as "unknown",
      // and a partial or defaulted figure would be gated on as if it were true.
      const records = await readInventory(bound, adminOriginator)
      const ids = [...new Set(records.filter(r => r.role === 'value').map(r => r.assetId))].sort()
      const infos = await infosOf(ids)
      const out: TokenBalance[] = []
      for (const assetId of ids) {
        // The balance view counts only available outputs, so an asset whose
        // inventory has none (only pending/reserved records) is zero without a
        // query — which also spares a not-yet-created basket its BRC-100 error.
        const hasAvailable = records.some(
          r => r.assetId === assetId && r.role === 'value' && r.tags.includes(STATE_AVAILABLE_TAG)
        )
        const units = hasAvailable ? await readAvailable(bound, adminOriginator, assetId) : 0n
        let offlineUnits = offlineUnitsOf(records, assetId)
        if (offlineUnits > units) {
          // Two views, two snapshots (0207:657-660). Keep the promise that the
          // offline part is a subset: with the larger figure, ALL of it reads
          // as unsettled rather than some offline value reading as settled.
          devLog(`[mandala] ${assetId}: offline ${offlineUnits} exceeds available ${units}; clamped`)
          offlineUnits = units
        }
        out.push({ asset: infos.get(assetId) as TokenAssetInfo, units, offlineUnits })
      }
      return out
    },

    async activity(limit = 50): Promise<TokenActivityRow[]> {
      const n = Number.isSafeInteger(limit) && limit > 0 ? limit : 0
      if (n === 0) return []
      // Cancelled rows are filtered in SQL so the limit counts shown rows.
      const rows = await journal.list({ states: [...ACTIVITY_STATES], limit: n })
      const nowMs = now().getTime()
      const infos = await infosOf(rows.map(r => r.assetId))
      const out: TokenActivityRow[] = []
      for (const row of rows) {
        const status = activityStatusOf(row, nowMs)
        if (status === undefined) continue
        out.push({
          txid: row.txid,
          role: row.role,
          asset: infos.get(row.assetId) as TokenAssetInfo,
          units: row.units,
          ...(row.counterpartyKey !== undefined ? { counterpartyKey: row.counterpartyKey } : {}),
          status,
          at: row.updatedAt || row.createdAt,
          ...(status === 'refused' && row.code !== undefined ? { refusedCode: row.code } : {}),
          rail: row.rail
        })
      }
      return out
    },

    async stuck(): Promise<ColorTransferRow[]> {
      const nowMs = now().getTime()
      const rows = await journal.list({ states: [...SETTLING_STATES] })
      return rows.filter(r => activityStatusOf(r, nowMs) === 'stuck')
    },

    assetStatus,
    refreshAssetStatus,

    async rememberDeploy(declarationTxHex: string): Promise<void> {
      await metadata.remember(declarationTxHex)
      emit()
    },

    recipientRefusal(recipient: string): string | null {
      return recipientRefusalOf(recipient)
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    async settleNow(txid: string) {
      return settler ? await settler.settleNow(txid) : 'unavailable'
    },

    async settleAll() {
      return settler ? await settler.settleAll() : 0
    },

    reviewTokenHoldings,

    async isHandoverAdmitted(txid: string) {
      if (db === undefined) return undefined
      return await readIsHandoverAdmitted({ journal, provider }, txid)
    },

    reconcileHeld,

    async sendToHandle(a) {
      if (!handleDeps) return { kind: 'unavailable', message: 'Stablecoins are not available on this network' }
      return await sendHandle(handleDeps, a)
    },

    async receiveFromInbox() {
      if (!handleDeps) return { credited: 0, failed: 0, incomplete: true }
      return await receiveHandleInbox(handleDeps)
    },

    async resendTransfer(txid: string) {
      if (!handleDeps) return 'unavailable'
      return await resendHandle(handleDeps, txid)
    },

    tick,
    nearby
  }

  return runtime
}
