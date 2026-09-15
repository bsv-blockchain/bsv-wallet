/**
 * `createMandalaRuntime` — the one construction site for `MandalaRuntime`.
 *
 * This file is the seam between the wallet and `@bsv/mandala`. Everything
 * above it (the UI, `useMandala()`) sees only `runtime.ts`'s pure interface;
 * everything below it (the lib's transfer/receive pipelines, the overlay
 * facilitator, the pure COVER walk) is reached from here and nowhere else. Two
 * consequences are deliberate:
 *
 *  · **One place knows the endpoints.** `configureMandala` is called by the
 *    wallet build (see `WalletContext`), and every lib entry point in this file
 *    reads those live bindings. A screen cannot address a different overlay,
 *    and a second Mandala deployment cannot appear behind the first.
 *  · **One place turns a lib failure into a wallet verdict.** `OverlayRefusedError`
 *    is mapped exactly once — to `TokenSendResult` for the handle rail, and to
 *    `OverlayVerdict` for the drain — so "the overlay said no permanently" and
 *    "the overlay could not be reached" can never be confused by a caller that
 *    forgot to check `retryable`. That distinction is the whole of FIX D.
 *
 * Nothing here decides money on its own. The settlement state machine lives in
 * `drain.ts`, the coverage walk in the lib, and this module only supplies both
 * with the bytes and the evidence the local tables hold.
 */
import { Beef, Transaction, Utils, type WalletInterface } from '@bsv/sdk'
import { MandalaToken } from '@bsv/templates'
import {
  blindingCommit,
  blindingPruneReserved,
  blindingReserve,
  cover as coverWalk,
  createOverlayFacilitator,
  fetchAdmission as libFetchAdmission,
  fetchRegistry,
  guardTokenRecipient,
  payloadHash,
  prepareBlindedPayment,
  receiveTokens,
  recipientCustomInstructions,
  reconcileNotifications,
  reconcileWallet,
  registryIsLive,
  resolveAssetMetadata,
  submitToOverlay,
  transferTokens,
  verifyAdmission as libVerifyAdmission,
  verifyFetchedAdmission,
  type AdmissionEntry as LibAdmissionEntry,
  type DerSignature,
  type FetchedAdmission,
  type MandalaStorage,
  type MessageBoxLike,
  type MessageBoxSender,
  type OverlayFetch,
  type OverlayRegistryRow,
  type ReceivedTransfer
} from '@bsv/mandala'
import { resolveAssetState, type AssetAdminStateView } from '@bsv/mandala/adminState'
import type { AppChain } from '../config'
import type { MandalaEndpointConfig } from '../toolboxConfig'
import type { StorageExpoSQLite } from '../storage/StorageExpoSQLite'
import { processOfflineActions, type OfflineTokenDeps } from '../storage/methods/processOfflineActions'
import { findOfflineActions } from '../storage/methods/offlineActions'
import { getPending, type KVStorage, type TokenCreditedHook } from '../localpay/pending'
import type { PaymentFrame } from '../localpay/codec'
import type { VerifyAdmissionFn } from '../localpay/settlementAck'
import type { LockToPayee, TokenBuildDeps } from '../localpay/build'
import { tokenFrameSourcesFromOfflineActions, tokenFrameSourcesFromPending } from '../offline/tokenFrames'
import type { CoverBundle, CoverVerifier } from './bundle'
import { assembleBundle } from './bundle'
import {
  deriveTokenEdges,
  listStuckSettlements,
  populateEvidenceFromFrame,
  type EvidenceFrame,
  type TokenFrameSource
} from './drain'
import { createSettlementStore, type SettlementDb } from './settlementStore'
import {
  MANDALA_BASKET,
  STUCK_AFTER_MS,
  type AdmissionEntryWire,
  type AdmissionVerifier,
  type CoverResult,
  type FetchAdmissionFn,
  type OverlayVerdict,
  type SettlementStore,
  type TokenAdmissionEdge,
  type TokenAdmissionRow,
  type TokenHandedOverHook,
  type TokenHeldHook,
  type TokenLinkageRow,
  type TokenSettlementRow,
  type TokenSettlementState
} from './types'
import type {
  MandalaRuntime,
  TokenActivityRow,
  TokenActivityStatus,
  TokenAssetInfo,
  TokenAssetStatus,
  TokenBalance,
  TokenSendResult
} from './runtime'
import { devLog } from '../logging'

// ───────────────────────── the duplicated-@bsv/sdk seam ─────────────────────────

/**
 * `@bsv/mandala`'s `cover()` (bundle.ts's `TransactionLike` / `BundleBeef`) is
 * typed STRUCTURALLY on purpose, precisely so a consuming app's own
 * `Transaction`/`Beef` objects satisfy it with no cast at the call site —
 * provided the app and the lib resolve to the SAME `@bsv/sdk` install. They do
 * not here: this wallet pins `^2.4.1`, the linked `@bsv/mandala` pins
 * `^2.1.6`, and `LockingScript` — which the walk never does anything with
 * beyond handing it to `MandalaToken.decode`, but which the type still names —
 * is consequently two classes with separately-declared private `_chunks`
 * fields, so TypeScript refuses the assignment even though the runtime values
 * are byte-identical. The crossing is therefore still a type-only cast, kept
 * in this one named place — never an anonymous `as any` at a call site — and
 * it disappears entirely the day the two packages dedupe onto one `@bsv/sdk`
 * version (nothing else about this function would need to change).
 *
 * `expectedSignerKey` is always THIS runtime's own configured
 * `overlayIdentityKey` — never `bundle.overlayIdentityKey`, which is
 * payer-supplied data on the incoming-frame path (`coverVerifier`, built from
 * `coverFromFrame`'s bundle). The lib's own `cover()` refuses with
 * `unsafe_asset` unless the bundle's claimed key equals this expectation
 * (spec amendment §9.10); passing anything else here would let a payer mint
 * their own admissions under a key of their choosing and have COVER rubber-
 * stamp them.
 */
function libCoverArgs(
  tip: Transaction,
  bundle: {
    assetId: string
    overlayIdentityKey: string
    tip: Transaction
    beef: Map<string, Transaction> | { findTxid: (txid: string) => { tx?: Transaction } | undefined }
    linkage: Map<string, number[]>
    admissions: Map<string, LibAdmissionEntry>
  },
  expectedSignerKey: string
): [Parameters<typeof coverWalk>[0], Parameters<typeof coverWalk>[1], Parameters<typeof coverWalk>[2]] {
  return [
    tip as unknown as Parameters<typeof coverWalk>[0],
    bundle as unknown as Parameters<typeof coverWalk>[1],
    { expectedSignerKey } as unknown as Parameters<typeof coverWalk>[2]
  ]
}

// ─────────────────────────── the wallet's storage ───────────────────────────

/** What the KV adapter needs: the toolbox's own key/value table, plus raw SQL for the two verbs it lacks. */
export interface MandalaKvStorage extends KVStorage {
  readonly sqliteDb?: {
    runAsync(sql: string, params: (string | number | null)[]): Promise<{ changes: number }>
    getAllAsync(sql: string, params: (string | number | null)[]): Promise<unknown[]>
  }
}

/** LIKE treats these as wildcards; a journal prefix containing one must still match literally. */
function escapeLike(prefix: string): string {
  return prefix.replace(/[\\%_]/g, c => `\\${c}`)
}

/**
 * `MandalaStorage` over `StorageExpoSQLite`'s `key_value_store` (D3c).
 *
 * The lib's journals are the recovery contract: an overlay-accepted but
 * not-yet-broadcast transaction is recoverable only because its `'accepted'`
 * entry outlives the process that wrote it. React Native has no
 * `localStorage`, so without this adapter the lib silently falls back to a
 * process-lifetime Map and an interrupted broadcast becomes unrecoverable.
 *
 * `removeItem`/`keys` go straight to SQL because `StorageExpoSQLite` exposes
 * neither — and both are deliberately hard failures when the database is
 * closed rather than silent no-ops: a `removeItem` that quietly did nothing
 * would leave a completed broadcast's journal entry behind forever, which the
 * lib's reconcile pass reads as work still outstanding.
 */
export function createMandalaKvStorage(storage: MandalaKvStorage): MandalaStorage {
  const db = (): NonNullable<MandalaKvStorage['sqliteDb']> => {
    const handle = storage.sqliteDb
    if (!handle) throw new Error('Mandala journal storage: the wallet database is not open')
    return handle
  }
  return {
    getItem: async key => (await storage.getKeyValue(key)) ?? null,
    setItem: async (key, value) => {
      await storage.setKeyValue(key, value)
    },
    removeItem: async key => {
      await db().runAsync('DELETE FROM key_value_store WHERE key = ?', [key])
    },
    keys: async prefix => {
      const rows = (await db().getAllAsync(`SELECT key FROM key_value_store WHERE key LIKE ? ESCAPE '\\'`, [
        `${escapeLike(prefix)}%`
      ])) as { key: string }[]
      return rows.map(r => r.key)
    }
  }
}

// ─────────────────────────────── construction ───────────────────────────────

/** The MessageBox surface both lib pipelines need, as one structural type. */
export type MandalaMessageBox = MessageBoxSender & MessageBoxLike

export interface CreateMandalaRuntimeArgs {
  /** The guarded permissions manager. Every lib call is bound to `adminOriginator` (see `bindOriginator`). */
  wallet: WalletInterface
  adminOriginator: string
  /** Supplies the settlement tables, the release drain and the pending queue. */
  storage: StorageExpoSQLite
  chain: AppChain
  endpoints: MandalaEndpointConfig | undefined
  /** Built lazily on first use so constructing a runtime does no I/O and needs no network. */
  messageBox?: () => Promise<MandalaMessageBox>
  /** Test seam for the overlay facilitator's transport. */
  fetchImpl?: OverlayFetch
  /** Opens a payer-side sealed `offline_actions.framePayload`; see `offline/tokenFrames.ts`. */
  decodeSealedFrame?: (framePayload: string) => EvidenceFrame | undefined
  /** Injected so the drain can rebuild a graph a missing ancestor broke. */
  refetchBeef?: (txid: string) => Promise<number[] | undefined>
  /** Test seam: the asset registry lookup (network + SPV in production). */
  resolveMetadata?: (assetId: string) => Promise<{ label?: string; ticker?: string; decimals?: number } | null>
  now?: () => Date
}

/**
 * Every lib call runs as the admin originator.
 *
 * `@bsv/mandala` takes a `WalletInterface` and passes no originator, which
 * against `WalletPermissionsManager` means "an anonymous caller" — and the
 * `'p mandala'` basket is P-routed, so an anonymous `listOutputs` would raise a
 * permission prompt for the wallet's own balance screen. Binding here rather
 * than teaching the lib about originators keeps the lib host-agnostic and keeps
 * exactly one place in the wallet that can claim admin authority.
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

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** The lib's structured refusal, recognised by shape as well as by identity. */
interface RefusalLike {
  code: string
  retryable: boolean
  spendTxid?: string
  httpStatus: number
  message: string
}

function asOverlayRefusal(e: unknown): RefusalLike | undefined {
  const candidate = e as Partial<RefusalLike> & { name?: string }
  if (candidate?.name !== 'OverlayRefusedError') return undefined
  if (typeof candidate.code !== 'string') return undefined
  return {
    code: candidate.code,
    retryable: candidate.retryable === true,
    spendTxid: candidate.spendTxid,
    httpStatus: typeof candidate.httpStatus === 'number' ? candidate.httpStatus : 0,
    message: typeof candidate.message === 'string' ? candidate.message : candidate.code
  }
}

/**
 * The wire contract's verdict for one `/submit`, from whatever the lib threw.
 *
 * Direction matters more than precision here: anything that is not provably a
 * FINAL manager verdict becomes `unavailable`, because a retryable fault
 * mistaken for a refusal burns a payment that would have settled, while a
 * refusal mistaken for a fault costs one idempotent re-submit.
 */
export function verdictFromError(e: unknown): OverlayVerdict {
  const refusal = asOverlayRefusal(e)
  if (!refusal) return { kind: 'unavailable', code: 'ERR_UNAVAILABLE', retryable: true }
  if (refusal.code === 'ERR_EVICTED' || refusal.httpStatus === 410) return { kind: 'evicted' }
  if (refusal.retryable) return { kind: 'unavailable', code: refusal.code, retryable: true }
  return { kind: 'refused', code: refusal.code, spendTxid: refusal.spendTxid }
}

/** A store for a runtime with no database: every read is empty, every write a no-op. */
function nullStore(): SettlementStore {
  return {
    getSettlement: async () => undefined,
    listSettlements: async () => [],
    upsertSettlement: async () => undefined,
    advanceSettlement: async () => false,
    getAdmission: async () => undefined,
    putAdmission: async () => undefined,
    putEdges: async () => undefined,
    parentsOf: async () => [],
    getLinkage: async () => undefined,
    putLinkage: async () => undefined
  }
}

/** States a row reached by an overlay verdict; their money is not "unsettled", it is gone. */
const TERMINAL_BY_VERDICT = new Set<TokenSettlementState>(['refused', 'orphaned'])

/**
 * States whose money is settled, and therefore NOT part of "settling…".
 *
 * `admitted` belongs here for the same reason it reads as `settled` on the
 * activity list (see `activityStatusOf`): σ_I is the issuer's overlay having
 * folded the transaction into its own state, which is the entire meaning of
 * settlement. The broadcast that follows is this device's bookkeeping. Leaving
 * `admitted` in the unsettled figure told a holder their money was still in
 * flight for as long as they happened to be offline after it had, in fact,
 * settled — and did it in the one number they check to decide whether to spend.
 */
const SETTLED_STATES = new Set<TokenSettlementState>(['broadcast', 'admitted'])

interface ListedTokenOutput {
  outpoint: string
  txid: string
  vout: number
  assetId: string
  amount: number
  spendable: boolean
}

/**
 * How a settlement row reads on the activity list.
 *
 * `admitted` is `settled`, not "nearly settled": σ_I is the issuer's overlay
 * having folded the transaction into its own state, which is exactly what the
 * ux copy means by "settled with {{issuer}}". The broadcast that follows is
 * this device's bookkeeping, not the payment's fate.
 */
export function activityStatusOf(row: TokenSettlementRow, nowMs: number, olderThanMs = STUCK_AFTER_MS): TokenActivityStatus {
  switch (row.state) {
    case 'broadcast':
    case 'admitted':
      return 'settled'
    case 'refused':
      return 'refused'
    case 'orphaned':
      return 'reversed'
    default: {
      const at = Date.parse(row.createdAt)
      return Number.isFinite(at) && nowMs - at >= olderThanMs ? 'stuck' : 'settling'
    }
  }
}

export function createMandalaRuntime(args: CreateMandalaRuntimeArgs): MandalaRuntime {
  const { wallet, adminOriginator, storage, chain, endpoints } = args
  const now = args.now ?? (() => new Date())
  const db = storage.sqliteDb
  const available = chain === 'main' && endpoints !== undefined && db !== undefined
  const overlayUrl = endpoints?.overlayUrl ?? ''
  const overlayIdentityKey = endpoints?.overlayIdentityKey ?? ''
  const messageBoxUrl = endpoints?.messageBoxUrl ?? ''
  const store: SettlementStore = db ? createSettlementStore(db as unknown as SettlementDb) : nullStore()
  const bound = bindOriginator(wallet, adminOriginator)

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

  // Cross-call dedup for the MessageBox inbox: a slow drain and a manual
  // refresh must not both internalize the same message.
  const processedMessages = new Set<string>()
  let messageBoxPromise: Promise<MandalaMessageBox> | undefined
  const messageBox = async (): Promise<MandalaMessageBox> => {
    if (!args.messageBox) throw new Error('Mandala: no MessageBox client is configured')
    messageBoxPromise ??= args.messageBox().catch((e: unknown) => {
      // A FAILURE is never memoized. Construction can fail for entirely
      // transient reasons (no network at launch, a host that is briefly down),
      // and a cached rejection would poison every later inbox drain and every
      // pending-notification retry for the life of the process — which is
      // exactly the window `reconcileNotifications` exists to close.
      messageBoxPromise = undefined
      throw e
    })
    return await messageBoxPromise
  }

  let identityKeyPromise: Promise<string> | undefined
  const identityKey = async (): Promise<string> => {
    identityKeyPromise ??= bound.getPublicKey({ identityKey: true }).then(r => r.publicKey)
    return await identityKeyPromise
  }

  const metadataCache = new Map<string, { label?: string; ticker?: string; decimals?: number } | null>()
  const resolveMetadata = args.resolveMetadata ?? (async (assetId: string) => await resolveAssetMetadata(assetId))
  const metadataOf = async (assetId: string): Promise<{ label?: string; ticker?: string; decimals?: number } | null> => {
    const cached = metadataCache.get(assetId)
    if (cached !== undefined) return cached
    let resolved: { label?: string; ticker?: string; decimals?: number } | null = null
    try {
      resolved = await resolveMetadata(assetId)
    } catch (e) {
      // A registry lookup is a display concern. It must never be the reason a
      // balance fails to render — the assetId itself is always a usable name.
      devLog(`[mandala] could not resolve metadata for ${assetId}:`, e)
    }
    metadataCache.set(assetId, resolved)
    return resolved
  }

  const assetInfo = async (assetId: string): Promise<TokenAssetInfo> => {
    const meta = await metadataOf(assetId)
    const issuerName = (meta as Record<string, unknown> | null)?.issuerName
    return {
      assetId,
      label: meta?.label && meta.label !== '' ? meta.label : `${assetId.slice(0, 20)}…`,
      ticker: meta?.ticker ?? '',
      decimals: Number(meta?.decimals) || 0,
      ...(typeof issuerName === 'string' && issuerName !== '' ? { issuerName } : {}),
      overlayUrl,
      overlayIdentityKey
    }
  }

  // ── Asset status facts (paused / frozen / access mode / admission) ──
  //
  // Regulatory copy the UI wants to show — a paused banner, a frozen-balance
  // notice, an access-mode refusal, "not yet admitted to send/receive" — all
  // read from the overlay's own admin state and the issuer's identity
  // registry. Never a gate anything transacts against: every read here is
  // best-effort and a stale or unreachable overlay reads as the least
  // alarming answer, never a thrown error.

  const ASSET_STATUS_TTL_MS = 10_000

  interface AssetStatusSnapshot {
    state: AssetAdminStateView | null
    registryRows: OverlayRegistryRow[]
    registryActive: boolean
    metadataResolved: boolean
  }

  const assetStatusCache = new Map<string, { at: number; snapshot: AssetStatusSnapshot }>()

  const isAdmittedIn = (rows: OverlayRegistryRow[], key: string): boolean =>
    rows.some(r => r.identityKey.toLowerCase() === key.toLowerCase() && r.status === 'admitted')

  const loadAssetStatusSnapshot = async (assetId: string, opts: { force?: boolean } = {}): Promise<AssetStatusSnapshot> => {
    const [state, registryRows, meta] = await Promise.all([
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
      metadataOf(assetId)
    ])
    return { state, registryRows, registryActive: registryIsLive(registryRows), metadataResolved: meta !== null }
  }

  const buildAssetStatus = async (snapshot: AssetStatusSnapshot): Promise<TokenAssetStatus> => {
    const { state, registryRows, registryActive, metadataResolved } = snapshot
    const mine = await identityKey()
    const frozenBaseUnits = (state?.frozenOutpoints ?? []).reduce((sum, o) => sum + (Number(o.amount) || 0), 0)
    return {
      paused: state?.isPaused ?? false,
      frozenBaseUnits,
      accessMode: state?.accessMode,
      selfAdmitted: registryActive ? isAdmittedIn(registryRows, mine) : undefined,
      recipientAdmitted: async (recipientIdentityKey: string) =>
        registryActive ? isAdmittedIn(registryRows, recipientIdentityKey) : undefined,
      metadataResolved,
      messageBoxUrl
    }
  }

  /**
   * A cache entry is stamped with the time of the LOAD that produced it, never
   * with the time it was last read.
   *
   * Re-stamping on a hit is a self-renewing cache: every read inside the TTL
   * pushes the expiry out, so a screen that polls faster than 10s (the balance
   * header, the send sheet's recipient check) would keep one snapshot alive
   * forever and never see the asset get paused, frozen or un-admitted. The
   * whole point of the TTL is that it expires while somebody is watching.
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

  /**
   * Every Mandala output this wallet holds, valued from its SCRIPT.
   *
   * `include: 'entire transactions'` is not an optimisation: a token output
   * carries one satoshi and its real figure in the locking script, so the coins
   * cannot be valued at all without their source transactions.
   */
  const listTokenOutputs = async (): Promise<ListedTokenOutput[]> => {
    let listed: Awaited<ReturnType<WalletInterface['listOutputs']>>
    try {
      listed = await bound.listOutputs({
        basket: MANDALA_BASKET,
        include: 'entire transactions',
        includeCustomInstructions: true,
        limit: 1000
      })
    } catch (e) {
      // A wallet with no Mandala basket yet, or a storage fault. Either way a
      // balance screen shows nothing rather than an error it cannot act on.
      devLog('[mandala] could not list the token basket:', e)
      return []
    }
    const beef = new Beef()
    if (listed.BEEF) {
      try {
        beef.mergeBeef(listed.BEEF)
      } catch (e) {
        devLog('[mandala] the basket listing carried unreadable BEEF:', e)
        return []
      }
    }
    const out: ListedTokenOutput[] = []
    for (const output of listed.outputs) {
      const [txid, voutText] = output.outpoint.split('.')
      const vout = Number(voutText)
      const script = beef.findTxid(txid)?.tx?.outputs[vout]?.lockingScript
      if (!script) continue
      try {
        const decoded = MandalaToken.decode(script)
        out.push({
          outpoint: output.outpoint,
          txid,
          vout,
          assetId: decoded.assetId,
          amount: decoded.amount,
          spendable: output.spendable !== false
        })
      } catch {
        // A stray non-token output in the basket is not this asset's coin.
      }
    }
    return out
  }

  /** The tip's own bytes plus its whole ancestry, from the wallet's request rows. */
  const loadBeef = async (txid: string): Promise<Beef | undefined> => {
    try {
      const api = (await storage.findProvenTxReqs({ partial: { txid } }))[0]
      if (!api?.rawTx) return undefined
      const beef = new Beef()
      beef.mergeRawTx(api.rawTx)
      if (api.inputBEEF) beef.mergeBeef(api.inputBEEF)
      return beef
    } catch (e) {
      devLog(`[mandala] could not read the stored bytes of ${txid}:`, e)
      return undefined
    }
  }

  /** A Beef that actually carries this transaction's bytes (not merely its txid). */
  const carries = (beef: Beef | undefined, txid: string): beef is Beef => beef?.findTxid(txid)?.tx !== undefined

  /**
   * The bytes of `txid`, from anywhere on this device that holds them.
   *
   * `loadBeef` can only ever find a transaction THIS wallet built or
   * internalized — `findProvenTxReqs` is keyed by the wallet's own request
   * rows. A multi-hop offline chain (spec §1.6) routinely puts a FOREIGN
   * transaction in the middle of a submit set: Alice → Bob → us, where Bob's
   * hop has no request row here at all. `cover()` covers it happily (its bytes
   * are right there in the frame's ancestry), `mustSubmit` names it, and the
   * submit that follows used to come back `ERR_LOCAL_BYTES` forever — a whole
   * chain stalled on a transaction this device was holding the entire time.
   *
   * So the fallback asks every local BEEF that could contain it: the
   * settlement rows' own tips first (their request rows carry the ancestry as
   * `inputBEEF`), then the durable frames the drain already reads for
   * evidence. The ancestor is then served with `toBinaryAtomic` out of
   * whichever one had it, exactly as if it had been ours.
   */
  const loadBeefContaining = async (txid: string): Promise<Beef | undefined> => {
    const own = await loadBeef(txid)
    if (carries(own, txid)) return own

    let rows: TokenSettlementRow[] = []
    try {
      rows = await store.listSettlements()
    } catch (e) {
      devLog(`[mandala] could not list settlements while looking for the bytes of ${txid}:`, e)
    }
    for (const row of rows) {
      if (row.txid === txid) continue
      const beef = await loadBeef(row.txid)
      if (carries(beef, txid)) return beef
    }

    for (const source of await frames()) {
      let beef: Beef | undefined
      try {
        beef = Beef.fromBinary(source.frame.transaction)
      } catch {
        continue // a frame this device cannot parse simply holds no bytes for us
      }
      if (carries(beef, txid)) return beef
    }
    return undefined
  }

  const libAdmissions = (entries: readonly AdmissionEntryWire[]): Map<string, LibAdmissionEntry> =>
    new Map(
      entries.map(entry => [
        entry.txid,
        {
          outputsToAdmit: [...entry.outputsToAdmit],
          signature: Array.from(entry.signature),
          signerKey: entry.signerKey
        }
      ])
    )

  /**
   * The pure COVER walk, over the evidence the payee's frame carried.
   *
   * This is the injection `bundle.ts` was written around: the walk and the
   * overlay's σ_I digest live together in `@bsv/mandala`, so wallet and overlay
   * cannot disagree about what a signature covers.
   *
   * `expectedSignerKey` is THIS session's own configured `overlayIdentityKey`
   * — never `bundle.overlayIdentityKey`, which is the frame's own (untrusted)
   * claim. See `libCoverArgs`.
   */
  const coverVerifier: CoverVerifier = (tip, bundle: CoverBundle) =>
    coverWalk(
      ...libCoverArgs(
        tip.tx,
        {
          assetId: bundle.assetId,
          overlayIdentityKey: bundle.overlayIdentityKey,
          tip: tip.tx,
          beef: bundle.beef,
          linkage: new Map([...bundle.linkage].map(([txid, payload]) => [txid, Array.from(payload)])),
          admissions: new Map(
            [...bundle.admissions].map(([txid, entry]) => [
              txid,
              {
                outputsToAdmit: [...entry.outputsToAdmit],
                signature: Array.from(entry.signature),
                signerKey: entry.signerKey
              }
            ])
          )
        },
        overlayIdentityKey
      )
    )

  /** FIX H, in one function: an entry proves nothing unless THIS overlay signed it. */
  const verifyAdmissionEntry: VerifyAdmissionFn = (entry, key) => {
    if (entry.signerKey.toLowerCase() !== key.toLowerCase()) return false
    try {
      return libVerifyAdmission({
        txid: entry.txid,
        outputsToAdmit: entry.outputsToAdmit,
        signature: Array.from(entry.signature),
        signerKey: entry.signerKey
      })
    } catch {
      return false
    }
  }

  /**
   * The same check with the expected signer already fixed — the only shape the
   * drain, the frame verifier and the evidence cache are allowed to take.
   *
   * Wire contract §9.10: the key a σ_I is checked against is THIS session's
   * configuration. A caller that could name the key would be able to hand in
   * `frame.token.overlayIdentityKey` or `row.overlayIdentityKey`, both of which
   * are counterparty-supplied data, and a self-signed admission would then
   * verify perfectly against the attacker's own key.
   */
  const verifyAdmission: AdmissionVerifier = entry => verifyAdmissionEntry(entry, overlayIdentityKey)

  /** What every `populateEvidenceFromFrame` call in this file anchors trust on. */
  const evidenceAnchor = { overlayIdentityKey, verifyAdmission }

  const cover = async (tipTxid: string): Promise<CoverResult> => {
    if (overlayIdentityKey === '') return { ok: false, reason: 'unsafe_asset' }
    const beef = await loadBeef(tipTxid)
    if (!beef) return { ok: false, reason: 'shape' }
    let tip: Transaction | undefined
    try {
      tip = beef.findAtomicTransaction(tipTxid) ?? beef.findTxid(tipTxid)?.tx
    } catch {
      return { ok: false, reason: 'shape' }
    }
    if (!tip) return { ok: false, reason: 'shape' }

    const row = await store.getSettlement(tipTxid)
    const assetId = row?.assetId ?? assetIdOfTx(tip)
    if (!assetId) return { ok: false, reason: 'unsafe_asset' }

    const bundle = await assembleBundle({ tipTx: tip, assetId, overlayIdentityKey, store })
    const txs = new Map<string, Transaction>()
    for (const entry of beef.txs) if (entry.tx) txs.set(entry.txid, entry.tx)
    return coverWalk(
      ...libCoverArgs(
        tip,
        {
          assetId,
          overlayIdentityKey,
          tip,
          beef: txs,
          linkage: new Map(bundle.linkage.map(l => [l.txid, Array.from(l.payload)])),
          admissions: libAdmissions(bundle.admissions)
        },
        overlayIdentityKey
      )
    )
  }

  /**
   * `POST /submit` for one txid, with the beef and linkage the local tables hold.
   *
   * An admitted response with no σ_I is still an admission — the overlay has
   * folded the transaction into its state — so the row advances. But it is
   * recorded with an EMPTY `signerKey` so neither `assembleBundle` nor the
   * drain's own `admissionStandsIn` can ever mistake it for evidence: a
   * counterparty handed an unsigned "admission" would otherwise see its
   * ancestor treated as a bottom, with the linkage that could have settled it
   * left behind.
   */
  const submit = async (txid: string): Promise<OverlayVerdict> => {
    // Not `loadBeef`: a submit set is parents-first and its middle hops are
    // routinely somebody else's transactions (spec §1.6). See
    // `loadBeefContaining`.
    const beef = await loadBeefContaining(txid)
    if (!beef) return { kind: 'unavailable', code: 'ERR_LOCAL_BYTES', retryable: true }
    let bytes: number[]
    try {
      bytes = beef.toBinaryAtomic(txid)
    } catch (e) {
      devLog(`[mandala] could not serialize ${txid} for submission:`, e)
      return { kind: 'unavailable', code: 'ERR_LOCAL_BYTES', retryable: true }
    }
    let linkage: TokenLinkageRow | undefined
    try {
      linkage = await store.getLinkage(txid)
    } catch (e) {
      devLog(`[mandala] could not read the linkage payload of ${txid}:`, e)
    }
    try {
      const admitted = await submitToOverlay(
        bytes,
        linkage ? Array.from(linkage.payloadBytes) : undefined,
        facilitator()
      )
      const signatureHex = admitted.admissionSignature ?? ''
      return {
        kind: 'admitted',
        outputsToAdmit: admitted.outputsToAdmit,
        signatureHex,
        signerKey: signatureHex === '' ? '' : (admitted.admissionIdentityKey ?? '')
      }
    } catch (e) {
      return verdictFromError(e)
    }
  }

  /** DerSignature (string | number[] | Uint8Array), as the hex string OverlayVerdict wants. */
  const derSignatureHex = (sig: DerSignature): string =>
    typeof sig === 'string' ? sig : Utils.toHex(Array.from(sig))

  /**
   * GET /admin/admission/:txid (wire contract v2 §3), mapped onto
   * `OverlayVerdict` and FIX-H-verified against this SESSION's overlay
   * identity key — `FetchAdmissionFn` carries no key of its own, and this
   * runtime speaks for exactly one Mandala deployment, so `overlayIdentityKey`
   * is the only key an answer could ever be checked against.
   *
   * An 'admitted' answer that does not verify (wrong/missing signer, bad
   * signature) is FIX H's "unverifiable ⇒ absent": it comes back `undefined`,
   * never as a decline — the caller's own local check (a cancel refusing to
   * fire, a recovery pass leaving the row alone) is what happens next either
   * way. Never throws: a network fault from the lib is itself `unavailable`,
   * and the verifier call is wrapped defensively on top of that.
   *
   * Amendment §9.1/§9.3: a persisted FINAL refusal is keyed by `(txid,
   * payloadHash)`, not by txid alone, so this passes `payloadHash(payload)`
   * whenever this device still holds the linkage bytes for `txid` — a refusal
   * recorded against a *different* off-chain payload for the same txid must
   * never be read as a verdict on the one this device holds. Every caller of
   * this closure (`recoverStaleAdmissions`, and `cancelParkedPayment` via FIX
   * J's `mandalaSettlementDeps`) gets this for free, since neither passes a
   * hash of its own. Absent a stored linkage row — this device never held the
   * payload, or already advanced past needing it — the lookup is simply
   * omitted and the fetch proceeds unqualified, exactly as before.
   *
   * **The URL argument is advisory and is deliberately ignored** (§9.10). Every
   * caller sources it from a settlement row, and a settlement row's
   * `overlayUrl` began life on a counterparty's frame — so honouring it would
   * let a payer name their own server, answer their own admission query with a
   * self-signed σ_I, and have the wallet's own recovery pass advance a row to
   * `admitted` on it. (The σ_I check would not catch it either: it is verified
   * against the configured key, but a hostile overlay can simply serve a
   * GENUINE admission for a different transaction — see the txid binding
   * below.) This runtime speaks for exactly one deployment, whose origin is
   * `overlayUrl`; anything else is data, and data does not choose endpoints.
   * A caller that names a different one is logged and answered from the
   * configured overlay anyway.
   *
   * The answer is likewise bound to the txid that was ASKED for. The wire
   * body carries its own `txid`, and `verifyFetchedAdmission` verifies σ_I over
   * *that* one — so an overlay (hostile, or merely buggy behind a cache or a
   * redirect) that answers with a real admission for some other transaction
   * would produce a perfectly-verifying entry that says nothing whatsoever
   * about the payment in hand. That is FIX H's "unverifiable ⇒ absent" again:
   * the mismatch comes back `undefined`, never a decline.
   */
  const fetchAdmission: FetchAdmissionFn = async (fetchOverlayUrl, txid) => {
    if (fetchOverlayUrl !== '' && fetchOverlayUrl !== overlayUrl) {
      devLog(
        `[mandala] fetchAdmission was asked to address ${fetchOverlayUrl} for ${txid}; ` +
          `asking this session's configured overlay instead`
      )
    }
    let hash: string | undefined
    try {
      const linkage = await store.getLinkage(txid)
      if (linkage) hash = payloadHash(linkage.payloadBytes)
    } catch (e) {
      devLog(`[mandala] fetchAdmission could not read the stored linkage payload of ${txid}:`, e)
    }
    let entry: FetchedAdmission | undefined
    try {
      entry = await libFetchAdmission(overlayUrl, txid, hash !== undefined ? { payloadHash: hash } : {})
    } catch (e) {
      devLog(`[mandala] fetchAdmission could not reach ${overlayUrl} for ${txid}:`, e)
      return { kind: 'unavailable', code: 'ERR_UNAVAILABLE', retryable: true }
    }
    if (entry === undefined) return undefined
    if (entry.kind === 'evicted') return { kind: 'evicted' }
    if (entry.kind === 'refused') {
      return { kind: 'refused', code: entry.code, ...(entry.spendTxid != null ? { spendTxid: entry.spendTxid } : {}) }
    }
    if (entry.kind === 'unavailable') return { kind: 'unavailable', code: entry.code, retryable: true }
    // The σ_I covers `entry.txid`, which is whatever the body claimed. An
    // admission for another transaction is somebody else's, however genuine.
    if (entry.txid.toLowerCase() !== txid.toLowerCase()) {
      devLog(`[mandala] fetchAdmission asked about ${txid} and was answered about ${entry.txid}; treating as absent`)
      return undefined
    }
    let verified = false
    try {
      verified = verifyFetchedAdmission(entry, overlayIdentityKey)
    } catch (e) {
      devLog(`[mandala] fetchAdmission could not verify the admission of ${txid}:`, e)
    }
    if (!verified) return undefined
    return {
      kind: 'admitted',
      outputsToAdmit: entry.outputsToAdmit,
      signatureHex: derSignatureHex(entry.signature),
      signerKey: entry.signerKey
    }
  }

  const HANDED_OVER_RECOVERY_AFTER_MS = 5 * 60 * 1000 // one drain interval (TaskSendOffline's backoff ceiling)

  /**
   * FIX C recovery: a `handed_over`/`held` row can be stuck with neither
   * ancestor bytes nor a cached σ_I — a crash between `/submit` and the
   * admission-cache write, or a counterparty that settled the hop on this
   * device's behalf without ever telling it. `postTokenStep`'s own idempotent
   * re-submit already covers a device that still holds the bytes; this covers
   * the device that has NEITHER, by simply asking the overlay whether it
   * already knows better. Read-only, best-effort, and at most one overlay ask
   * per qualifying row per call — never throws.
   */
  const recoverStaleAdmissions = async (): Promise<number> => {
    let rows: TokenSettlementRow[]
    try {
      rows = await store.listSettlements({ state: ['handed_over', 'held'] })
    } catch (e) {
      devLog('[mandala] admission recovery could not list settlement rows:', e)
      return 0
    }
    const cutoff = now().getTime() - HANDED_OVER_RECOVERY_AFTER_MS
    let advanced = 0
    for (const row of rows) {
      if (Date.parse(row.createdAt) > cutoff) continue
      try {
        if ((await store.getAdmission(row.txid)) !== undefined) continue // the ordinary drain owns this one
      } catch (e) {
        devLog(`[mandala] admission recovery could not read the admission cache for ${row.txid}:`, e)
        continue
      }
      // The configured origin, never `row.overlayUrl`: the row's copy is
      // re-derived from frames a counterparty wrote (`reconcileSettlements`),
      // so it names an endpoint this wallet has no reason to trust. Passing it
      // would be ignored by `fetchAdmission` anyway — passing the real one
      // keeps that from looking like a caller bug in the log.
      const verdict = await fetchAdmission(overlayUrl, row.txid)
      if (verdict?.kind !== 'admitted') continue
      try {
        await store.putAdmission({
          txid: row.txid,
          outputsToAdmit: verdict.outputsToAdmit,
          signatureHex: verdict.signatureHex,
          signerKey: verdict.signerKey,
          source: 'fetched',
          obtainedAt: now().toISOString()
        })
        const ok = await store.advanceSettlement(row.txid, ['handed_over', 'held', 'submitting'], 'admitted', {
          admissionOutputs: verdict.outputsToAdmit,
          admissionSignatureHex: verdict.signatureHex
        })
        if (ok) advanced++
      } catch (e) {
        devLog(`[mandala] admission recovery could not journal ${row.txid}:`, e)
      }
    }
    return advanced
  }

  const BLINDING_RESERVATION_HORIZON_MS = 24 * 60 * 60 * 1000

  /** Sweeps abandoned `lockToPayee` blinding reservations older than 24h. Never throws. */
  const pruneBlindingReservations = async (): Promise<number> => {
    try {
      return await blindingPruneReserved(BLINDING_RESERVATION_HORIZON_MS)
    } catch (e) {
      devLog('[mandala] blinding reservation prune failed:', e)
      return 0
    }
  }

  // Built lazily and once: the lib's facilitator is the one that READS the
  // structured error body (`@bsv/sdk`'s discards it), which is exactly the
  // verdict FIX D turns on.
  let facilitatorInstance: ReturnType<typeof createOverlayFacilitator> | undefined
  const facilitator = (): ReturnType<typeof createOverlayFacilitator> => {
    facilitatorInstance ??= createOverlayFacilitator(args.fetchImpl)
    return facilitatorInstance
  }

  /**
   * FIX G's supply side: every durable token frame this device holds.
   *
   * Read fresh on every pass and never filtered by the pending queue's own
   * retry ceiling — a token payment's state of record is `token_settlements`,
   * not `localpay_pending` (FIX I).
   */
  const frames = async (): Promise<TokenFrameSource[]> => {
    const sources: TokenFrameSource[] = []
    try {
      sources.push(...tokenFrameSourcesFromPending(await getPending(storage)))
    } catch (e) {
      devLog('[mandala] could not read the pending queue for drain sources:', e)
    }
    if (db && args.decodeSealedFrame) {
      try {
        const rows = await findOfflineActions(db, { status: ['queued', 'posting', 'parked'] })
        sources.push(...tokenFrameSourcesFromOfflineActions(rows, args.decodeSealedFrame))
      } catch (e) {
        devLog('[mandala] could not read the payer queue for drain sources:', e)
      }
    }
    return sources
  }

  // Assembled as a value, then narrowed: `verifyAdmission` is the drain's FIX H
  // trust anchor (`TokenStepDeps`), and passing it through an object literal
  // would make this file fail to compile against a drain that has not grown the
  // field yet — for a dependency the drain treats as optional evidence.
  const tokenDepsValue = { store, cover, submit, frames, overlayIdentityKey, verifyAdmission }
  const tokenDeps: OfflineTokenDeps = tokenDepsValue

  const lockToPayee: LockToPayee = async ({ assetId, amount, recipientKey, keyID }) => {
    const mine = await identityKey()
    const blinded = await prepareBlindedPayment(bound, {
      identityKey: mine,
      recipientKey,
      keyID
    })
    // Nearby blinding (offline-settlement design): r is minted here, before the
    // nearby build even has a txid to key it under. Reserve it under `keyID`
    // now — the build path promotes it via `blindingCommit` once the tx is
    // signed, and an abandoned reservation (the payee never accepted, the tab
    // closed) is later swept by `pruneBlindingReservations`. Best-effort: the
    // lib's own write never throws, and a failed reserve costs only the
    // sender's later ability to re-derive r from the journal — the payment
    // itself is unaffected.
    await blindingReserve(keyID, {
      r: blinded.r,
      senderBlinded: blinded.senderBlinded,
      recipient: recipientKey,
      keyID,
      at: now().getTime()
    })
    return {
      lockingScript: new MandalaToken().lock(assetId, amount, blinded.pubKeyHash).toHex(),
      senderIdentityKey: blinded.senderBlinded,
      linkage: blinded.linkage,
      customInstructions: recipientCustomInstructions({
        keyID,
        recipientKey,
        senderBlinded: blinded.senderBlinded
      })
    }
  }

  /**
   * One frame's evidence, cached under this session's own trust anchor.
   *
   * Every caller here hands `populateEvidenceFromFrame` the SAME anchor —
   * `overlayIdentityKey` + `verifyAdmission`, both closed over the
   * configuration — so a σ_I that arrived on a frame is cached only if this
   * wallet's own overlay signed it (FIX H). Errors are logged, never thrown:
   * each of these hooks runs beside money that is already committed.
   */
  const cacheFrameEvidence = async (
    frame: EvidenceFrame,
    label: string,
    opts: { admissionSource?: TokenAdmissionRow['source']; linkageSource?: 'minted' | 'forwarded' } = {}
  ): Promise<void> => {
    const evidence = await populateEvidenceFromFrame(store, frame, { now, ...evidenceAnchor, ...opts })
    if (evidence.errors.length > 0) devLog(`[mandala] evidence from ${label} reported:`, evidence.errors)
    if (evidence.admissionsDropped > 0) {
      // Not an error: an unverifiable σ_I is ABSENT, and the ancestor it named
      // is simply walked and submitted like any other. Worth saying out loud,
      // because it is also what a forged bundle looks like.
      devLog(`[mandala] ${label} carried ${evidence.admissionsDropped} admission(s) this overlay did not sign`)
    }
  }

  /**
   * RECEIVER, BEFORE `internalizeAction`: this device is now the one that has
   * to settle this hop (spec rule 3), and it says so durably first.
   *
   * Ordering is the whole contract. `internalizeAction` forces a broadcast
   * attempt of its own, and the only thing standing between that and an
   * unadmitted token going out is `attemptToPostReqsToNetwork`'s lookup of
   * exactly this row — a row written after the credit fails open on the first
   * internalize, which is the one that matters. So this throws rather than
   * swallowing: the frame is already durable in `localpay_pending`, and a
   * failure here means "do not credit yet", not "credit anyway".
   *
   * The row carries the CONFIGURED overlay, never `frame.token.overlayUrl` /
   * `overlayIdentityKey`: those are the payer's claim about which deployment
   * this asset belongs to, and a row is what later tells recovery where to ask
   * and whose signature to believe (§9.10).
   */
  const onTokenHeld: TokenHeldHook = async (frame, txid) => {
    const token = frame.token
    if (!token) return
    await cacheFrameEvidence(frame, 'a held frame')
    const existing = await store.getSettlement(txid)
    await store.upsertSettlement({
      txid,
      role: 'received',
      assetId: token.assetId,
      state: existing?.state ?? 'held',
      counterpartyKey: frame.senderIdentityKey,
      overlayUrl,
      overlayIdentityKey,
      createdAt: existing?.createdAt
    })
    emit()
  }

  /**
   * PAYER, at park/hold: the frame is still plaintext here, and this is the
   * only moment it is.
   *
   * `offline_actions.framePayload` is sealed with the nearby session's
   * pre-shared key, which lives in memory and dies with the process — so a
   * payer that restarts can no longer open its own frame, and a settlement row
   * derived only from it would never exist at all (that is what
   * `decodeSealedFrame` can only ever partially fix). Writing the row and the
   * evidence here makes the payer's half of the chain durable independently of
   * the PSK.
   *
   * `state` is the payer's own fork: `'parked'` (the code screen was left
   * without a hand-over) or `'handed_over'` (the payee took the frame). Both
   * are the USER's states, which the drain may never claim (FIX F) — so a
   * `'parked'` row is created but never dragged forward here, while a
   * hand-over is allowed to advance a row that was parked a moment ago.
   * `counterpartyKey` is deliberately left unset: on the payer's own frame
   * `senderIdentityKey` is the PAYER (blinded), not the payee.
   */
  const onTokenHandedOver: TokenHandedOverHook = async (frame, txid, state) => {
    const token = frame.token
    if (!token) return
    // `minted`: the payload that matters on the payer's own frame is the tip's,
    // and the payer is the one who minted it. (Provenance only — nothing
    // branches on it, and `putLinkage` never overwrites a row already here.)
    await cacheFrameEvidence(frame, `a ${state} frame`, { linkageSource: 'minted' })
    const existing = await store.getSettlement(txid)
    await store.upsertSettlement({
      txid,
      role: 'sent',
      assetId: token.assetId,
      state: existing?.state ?? state,
      overlayUrl,
      overlayIdentityKey,
      createdAt: existing?.createdAt
    })
    // `upsertSettlement` never rewrites `state` on conflict (a re-derivation
    // must not drag an `admitted` row back), so the one legitimate advance the
    // payer makes by hand is made explicitly — and only out of the two states
    // the payer owns.
    if (state === 'handed_over') await store.advanceSettlement(txid, ['built', 'parked'], 'handed_over')
    emit()
  }

  /**
   * The settlement row and evidence a credited token frame makes this device
   * responsible for.
   *
   * Kept beside `onTokenHeld` rather than replaced by it: the held hook runs
   * before the credit, this one after, and a frame that was credited by a
   * build that had no held hook (or whose held write lost a race with a crash)
   * still has to end up with a row. Both are idempotent re-derivations of the
   * same facts, which is exactly FIX G's point.
   */
  const onTokenCredited: TokenCreditedHook = async (frame: PaymentFrame, txid: string) => {
    if (!frame.token) return
    await onTokenHeld(frame as EvidenceFrame, txid)
  }

  /** One credited MessageBox transfer, turned into a settlement row and cached evidence. */
  const journalReceived = async (transfer: ReceivedTransfer): Promise<void> => {
    const bytes = Uint8Array.from(transfer.transaction as unknown as number[])
    let txid: string | undefined
    try {
      txid = Transaction.fromAtomicBEEF(Array.from(bytes)).id('hex')
    } catch (e) {
      devLog(`[mandala] a credited transfer's transaction would not parse:`, e)
      return
    }

    const edges: TokenAdmissionEdge[] = deriveTokenEdges(bytes, transfer.assetId)
    if (edges.length > 0) await store.putEdges(edges)

    const admission = transfer.admission
    const verified = transfer.admissionVerified && admission != null && admission.txid === txid
    if (verified && admission) {
      const row: TokenAdmissionRow = {
        txid,
        outputsToAdmit: [...admission.outputsToAdmit],
        signatureHex: admission.signature,
        signerKey: admission.signerKey,
        source: 'bundle',
        obtainedAt: now().toISOString()
      }
      await store.putAdmission(row)
    }

    const existing = await store.getSettlement(txid)
    // FIX H: a σ_I that verified against THIS overlay is the only thing that
    // may open a row already admitted. Anything else is `held` — never a
    // decline, just a row the drain will settle itself.
    const state: TokenSettlementState = existing?.state ?? (verified ? 'admitted' : 'held')
    await store.upsertSettlement({
      txid,
      role: 'received',
      assetId: transfer.assetId,
      state,
      counterpartyKey: transfer.sender,
      amountBaseUnits: Number(transfer.amount) || undefined,
      overlayUrl,
      overlayIdentityKey,
      ...(verified && admission
        ? { admissionOutputs: [...admission.outputsToAdmit], admissionSignatureHex: admission.signature }
        : {}),
      createdAt: existing?.createdAt
    })
  }

  /**
   * The payer-side build's deps, carrying the same FIX H anchor.
   *
   * `assembleBundle` forwards this device's cached admissions onward as its own
   * claim about the chain, and `buildTokenPaymentFrame` reads the asset's
   * `overlayIdentityKey` off the SESSION — i.e. off the payee's request. Handing
   * the build the configured key and verifier here is what lets it anchor on
   * configuration instead (§9.10). Narrowed from a value for the same reason
   * `tokenDeps` is.
   */
  const tokenBuildDepsValue = {
    store,
    lockToPayee,
    commitBlinding: blindingCommit,
    overlayIdentityKey,
    verifyAdmission
  }
  const tokenBuildDeps: TokenBuildDeps = tokenBuildDepsValue

  /**
   * FIX C's handle-rail sibling: drive the LIB's own durable journals once.
   *
   * `reconcileWallet` is what turns a half-finished `transferTokens` into
   * either a settled payment or released inputs — an overlay-accepted tx whose
   * broadcast never went out, a liftable refusal whose noSend action is still
   * holding its coins, a pending abort, and the stuck-`nosend` sweep behind
   * them. `reconcileNotifications` re-sends the MessageBox message a committed
   * transfer owes its recipient. Both are journaled by the lib and are
   * otherwise driven by NOBODY in this wallet: the settlement drain only knows
   * about `token_settlements` rows, and the handle rail writes none of the
   * entries these read.
   *
   * Best-effort in every direction — an unreachable overlay, a MessageBox
   * that will not open, a journal read that throws — because this rides a
   * monitor tick beside the release drain and must never be the reason the
   * rest of that pass does not happen. The entries stay journaled; the next
   * tick tries again.
   */
  const reconcileJournals = async (): Promise<void> => {
    if (!available) return
    try {
      const r = await reconcileWallet(bound)
      if (!r.skipped && (r.rebroadcast.length > 0 || r.aborted.length > 0 || r.resubmitted.length > 0 || r.swept > 0)) {
        devLog('[mandala] reconcileWallet recovered:', r)
        emit()
      }
      if (r.stranded.length > 0) devLog('[mandala] reconcileWallet parked stranded broadcasts:', r.stranded)
    } catch (e) {
      devLog('[mandala] reconcileWallet failed; its journal entries stay for the next pass:', e)
    }
    try {
      const delivered = await reconcileNotifications(await messageBox())
      if (delivered.length > 0) devLog('[mandala] delivered pending recipient notifications:', delivered)
    } catch (e) {
      devLog('[mandala] could not retry pending recipient notifications:', e)
    }
  }

  const runtime: MandalaRuntime = {
    available,
    // The configuration itself, not the endpoints any frame claims — see
    // `MandalaRuntime.endpoints`. Empty strings on a chain with no deployment.
    endpoints: { overlayUrl, overlayIdentityKey, messageBoxUrl },
    store,
    tokenDeps,
    tokenBuildDeps,
    coverVerifier,
    verifyAdmissionEntry,
    verifyAdmission,
    onTokenCredited,
    onTokenHeld,
    onTokenHandedOver,
    lockToPayee,
    cover,
    fetchAdmission,
    recoverStaleAdmissions,
    pruneBlindingReservations,
    assetStatus,
    refreshAssetStatus,

    async listAssets(): Promise<TokenAssetInfo[]> {
      const ids = new Set<string>()
      for (const output of await listTokenOutputs()) ids.add(output.assetId)
      // Assets this wallet has ever received, not only ones it still holds: a
      // spent-down asset must keep its name on the activity list.
      for (const row of await store.listSettlements()) ids.add(row.assetId)
      const assets = await Promise.all([...ids].sort().map(assetInfo))
      return assets
    },

    async balances(): Promise<TokenBalance[]> {
      const outputs = await listTokenOutputs()
      const rows = await store.listSettlements({ role: 'received' })
      const ids = new Set<string>()
      for (const output of outputs) ids.add(output.assetId)
      for (const row of rows) ids.add(row.assetId)

      const balances: TokenBalance[] = []
      for (const assetId of [...ids].sort()) {
        const baseUnits = outputs
          .filter(o => o.assetId === assetId && o.spendable)
          .reduce((sum, o) => sum + o.amount, 0)
        const unsettledBaseUnits = rows
          .filter(r => r.assetId === assetId && !SETTLED_STATES.has(r.state) && !TERMINAL_BY_VERDICT.has(r.state))
          .reduce((sum, r) => sum + (r.amountBaseUnits ?? 0), 0)
        balances.push({ asset: await assetInfo(assetId), baseUnits, unsettledBaseUnits })
      }
      return balances
    },

    async activity(limit = 50): Promise<TokenActivityRow[]> {
      const rows = await store.listSettlements()
      const outputs = await listTokenOutputs()
      const nowMs = now().getTime()
      const byTxid = new Map<string, number>()
      for (const output of outputs) byTxid.set(output.txid, (byTxid.get(output.txid) ?? 0) + output.amount)

      const ordered = [...rows].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      const out: TokenActivityRow[] = []
      for (const row of ordered.slice(0, Math.max(0, limit))) {
        out.push({
          txid: row.txid,
          role: row.role,
          asset: await assetInfo(row.assetId),
          baseUnits: row.amountBaseUnits ?? byTxid.get(row.txid) ?? 0,
          ...(row.counterpartyKey ? { counterpartyKey: row.counterpartyKey } : {}),
          status: activityStatusOf(row, nowMs),
          at: row.updatedAt || row.createdAt,
          ...(row.refusedCode ? { refusedCode: row.refusedCode } : {}),
          ...(row.refusedPayloadHash ? { refusedPayloadHash: row.refusedPayloadHash } : {})
        })
      }
      return out
    },

    async stuck(): Promise<TokenSettlementRow[]> {
      return await listStuckSettlements(store, now().getTime())
    },

    async sendToHandle({ assetId, recipientIdentityKey, baseUnits }): Promise<TokenSendResult> {
      if (!available) {
        return { kind: 'unavailable', message: 'Stablecoins are not available on this network' }
      }
      const refusal = guardTokenRecipient(recipientIdentityKey)
      if (refusal) return { kind: 'refused', code: 'ERR_RECIPIENT', message: refusal }

      let box: MandalaMessageBox
      try {
        box = await messageBox()
      } catch (e) {
        return { kind: 'unavailable', message: messageOf(e) }
      }

      try {
        const result = await transferTokens({
          wallet: bound,
          messageBoxClient: box,
          identityKey: await identityKey(),
          assetId,
          amount: baseUnits,
          recipientKey: recipientIdentityKey
        })
        const settled = result.admissionSignature != null && result.admissionIdentityKey != null
        // The overlay has already ruled — journal what it said before telling
        // the caller, so a crash here leaves a row the drain can finish rather
        // than a payment nothing on this device remembers.
        // The handle rail's own evidence (spec §4.5): the exact bytes and
        // off-chain payload just submitted, cached the same way a nearby
        // hand-over's frame would be — so a later `cover()` of this tip (this
        // device's own recovery, or a re-spend of its change) never has to
        // re-derive them from scratch. Its own try/catch: this is bookkeeping
        // on an already-committed payment, so a bad or missing bytes value
        // must cost a later reconciliation pass, never the settlement journal
        // below (still less the payment itself, which the overlay already
        // ruled on).
        try {
          if (Array.isArray(result.atomicBeef) && result.atomicBeef.length > 0) {
            const edges = deriveTokenEdges(Uint8Array.from(result.atomicBeef), assetId)
            if (edges.length > 0) await store.putEdges(edges)
          }
          if (Array.isArray(result.offChainValues) && result.offChainValues.length > 0) {
            const linkageRow: TokenLinkageRow = {
              txid: result.txid,
              payloadBytes: Uint8Array.from(result.offChainValues),
              overlayUrl,
              overlayIdentityKey,
              source: 'minted',
              createdAt: now().toISOString()
            }
            await store.putLinkage(linkageRow)
          }
        } catch (e) {
          devLog(`[mandala] sent ${result.txid} but could not cache its evidence:`, e)
        }
        try {
          if (settled) {
            await store.putAdmission({
              txid: result.txid,
              outputsToAdmit: result.outputsToAdmit ?? [],
              signatureHex: result.admissionSignature as string,
              signerKey: result.admissionIdentityKey as string,
              source: 'submitted',
              obtainedAt: now().toISOString()
            })
          }
          await store.upsertSettlement({
            txid: result.txid,
            role: 'sent',
            assetId,
            state: settled ? 'admitted' : 'handed_over',
            counterpartyKey: recipientIdentityKey,
            amountBaseUnits: baseUnits,
            overlayUrl,
            overlayIdentityKey,
            ...(settled
              ? {
                  admissionOutputs: result.outputsToAdmit ?? [],
                  admissionSignatureHex: result.admissionSignature as string
                }
              : {})
          })
        } catch (e) {
          // The transfer is committed; a journal failure costs a later
          // reconciliation pass, never the payment.
          devLog(`[mandala] sent ${result.txid} but could not journal it:`, e)
        }
        emit()
        // `notified === false` is "committed, but the payee has not been told
        // yet" — the lib journaled the notification and `reconcileJournals`
        // retries it every tick. It is reported, never retried here: a retry of
        // the SEND would be a second payment.
        return { kind: 'sent', txid: result.txid, settled, notified: result.notified !== false }
      } catch (e) {
        const overlay = asOverlayRefusal(e)
        if (overlay) {
          return overlay.retryable
            ? { kind: 'unavailable', message: overlay.message }
            : { kind: 'refused', code: overlay.code, message: overlay.message }
        }
        return { kind: 'unavailable', message: messageOf(e) }
      }
    },

    async receiveFromInbox(): Promise<{ credited: number; failed: number }> {
      if (!available) return { credited: 0, failed: 0 }
      let box: MandalaMessageBox
      try {
        box = await messageBox()
      } catch (e) {
        devLog('[mandala] no MessageBox client for the inbox drain:', e)
        return { credited: 0, failed: 0 }
      }
      const result = await receiveTokens({
        wallet: bound,
        messageBoxClient: box,
        processed: processedMessages
      })
      for (const transfer of result.accepted) {
        try {
          await journalReceived(transfer)
        } catch (e) {
          // Already credited by the lib: a journal failure must not undo it.
          devLog('[mandala] credited a transfer but could not journal it:', e)
        }
      }
      if (result.accepted.length > 0) emit()
      return { credited: result.accepted.length, failed: result.failed.length }
    },

    reconcileJournals,

    async drainNow(): Promise<void> {
      if (!db) return
      // FIX C recovery, the lib's own journals and the nearby-blinding
      // reservation sweep ride the same tick as the ordinary
      // submit-then-broadcast pass (see also the `TaskSendOffline` wiring,
      // which calls these directly alongside its own `processOfflineActions`
      // for the production drain).
      await recoverStaleAdmissions()
      await reconcileJournals()
      await pruneBlindingReservations()
      await processOfflineActions({
        storage,
        ...(args.refetchBeef ? { refetchBeef: args.refetchBeef } : {}),
        token: tokenDeps
      })
      emit()
    },

    recipientRefusal(recipient: string): string | null {
      return guardTokenRecipient(recipient)
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }

  return runtime
}

/** The first Mandala asset this transaction's own outputs name, for a tip with no settlement row. */
function assetIdOfTx(tx: Transaction): string | undefined {
  for (const output of tx.outputs) {
    if (!output.lockingScript) continue
    try {
      return MandalaToken.decode(output.lockingScript).assetId
    } catch {
      // Not a token output.
    }
  }
  return undefined
}

