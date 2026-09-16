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
  journalRemove,
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
  type EvidenceSource,
  type FetchedAdmission,
  type MandalaStorage,
  type MessageBoxLike,
  type MessageBoxSender,
  type OverlayFetch,
  type OverlayRegistryRow,
  type ReceivedTransfer,
  type SettleFn
} from '@bsv/mandala'
import { resolveAssetState, type AssetAdminStateView } from '@bsv/mandala/adminState'
import type { AppChain } from '../config'
import type { MandalaEndpointConfig } from '../toolboxConfig'
import type { StorageExpoSQLite } from '../storage/StorageExpoSQLite'
import { postOwnedByTxid, processOfflineActions, type OfflineTokenDeps } from '../storage/methods/processOfflineActions'
import type { PostOutcome } from '../offline/plan'
import { findOfflineActions } from '../storage/methods/offlineActions'
import { getPending, type KVStorage, type TokenCreditedHook } from '../localpay/pending'
import type { PaymentFrame } from '../localpay/codec'
import type { VerifyAdmissionFn } from '../localpay/settlementAck'
import type { LockToPayee, TokenBuildDeps } from '../localpay/build'
import { tokenFrameSourcesFromOfflineActions, tokenFrameSourcesFromPending } from '../offline/tokenFrames'
import type { CoverBundle, CoverVerifier } from './bundle'
import { assembleBundle } from './bundle'
import {
  TERMINAL_SETTLEMENT_STATES,
  deriveTokenEdges,
  listStuckSettlements,
  NON_TERMINAL_SETTLEMENT_STATES,
  populateEvidenceFromFrame,
  postTokenStep,
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
  TokenHoldingsReview,
  TokenActivityStatus,
  TokenAssetInfo,
  TokenAssetStatus,
  TokenBalance,
  TokenSendResult,
  TokenSettleState
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
  /**
   * Whether this device has signal, for the ONE decision that turns on it: does
   * a send take its own submit now (`settleNow`), or leave it to the drain?
   * Never a gate on the hand-over itself — that happens either way.
   *
   * Supplied by the wallet build (`WalletContext` passes the app-wide
   * `getOnline`) rather than imported here, so this module keeps having no
   * NetInfo dependency of its own. Absent, it defaults OPTIMISTIC for the same
   * reason every other connectivity guard in this codebase does: a wrong
   * "online" costs one failed request that leaves the row exactly where it was,
   * while a wrong "offline" makes a payer wait a drain interval for money that
   * could have settled on the spot.
   */
  isOnline?: () => Promise<boolean>
  /**
   * How an admitted token tip reaches the network, for `settleNow`'s own step.
   * Defaults to the release engine's own owned post, which is the same one the
   * queue drain uses — injected only so a test can watch it without a wallet
   * database underneath.
   */
  broadcast?: (txid: string) => Promise<PostOutcome>
  now?: () => Date
}

/**
 * One `listOutputs` page of the token basket, and the hard stop on paging —
 * the same two figures the payment build uses (core/localpay/build.ts), so the
 * balance a screen shows and the coins a build can spend come from one read
 * discipline. A thousand is one round trip for any realistic basket; a
 * million outputs is far past any real one, and the ceiling is what stops a
 * wallet that reports a total it never serves from spinning a balance read.
 */
const TOKEN_LIST_PAGE = 1000
const TOKEN_LIST_MAX_PAGES = 1000

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

/**
 * `reconcileWallet`, with the one option this wallet is never allowed to omit.
 *
 * Declared here rather than inline for the same reason `tokenDeps` is assembled
 * as a value: `@bsv/mandala` is a linked working copy, the sweep opt-out lands
 * in it concurrently with this change, and a call written against the
 * not-yet-published signature would fail to compile for a parameter the lib
 * treats as optional anyway. An older lib IGNORES the second argument (it is a
 * plain extra JS argument), which means it still sweeps — so this cast is a
 * compile-time accommodation only; `abortGuard.ts` is what makes the sweep
 * harmless either way, and it is not optional.
 */
type ReconcileOptions = { sweep?: boolean; broadcast?: boolean }
type ReconcileWithOptions = (wallet: WalletInterface, options: ReconcileOptions) => ReturnType<typeof reconcileWallet>
const reconcileWalletWithOptions: ReconcileWithOptions = (wallet, options) =>
  (reconcileWallet as unknown as ReconcileWithOptions)(wallet, options)

/**
 * `{ reference }` from a lib result that carries one, or `{}`.
 *
 * A spread rather than a possibly-`undefined` field so `upsertSettlement`'s
 * COALESCE keeps whatever the row already has: a re-derivation that could not
 * find a reference must not erase one an earlier pass recorded.
 */
function hexToBytes(hex: string): Uint8Array {
  const clean = hex.length % 2 === 0 ? hex : ''
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16) || 0
  return out
}

function referenceOf(result: unknown): { reference?: string } {
  const reference = (result as { reference?: unknown } | null)?.reference
  return typeof reference === 'string' && reference.length > 0 ? { reference } : {}
}

/** A store for a runtime with no database: every read is empty, every write a no-op. */
function nullStore(): SettlementStore {
  return {
    getSettlement: async () => undefined,
    getSettlementByReference: async () => undefined,
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
  // Any chain the host stated complete endpoints for; no chain is hardcoded.
  const available = endpoints !== undefined && db !== undefined
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
    // The WHOLE basket, page by page, with the same loop discipline as the
    // payment build's `listTokenBasket` (core/localpay/build.ts): one unpaged
    // read capped at 1000 was the balance this screen showed — and the figure
    // the send surfaces gate on ("more than your USDX balance") — while the
    // build spends from every page. Past 1000 outputs that under-count turned
    // into a refusal of money the wallet plainly had. The BEEF accumulates
    // across pages because a coin's value lives in its source transaction's
    // script, so page two's coins are unreadable without page two's BEEF.
    const listed: Awaited<ReturnType<WalletInterface['listOutputs']>>['outputs'] = []
    const beef = new Beef()
    try {
      let offset = 0
      for (let page = 0; page < TOKEN_LIST_MAX_PAGES; page++) {
        const chunk = await bound.listOutputs({
          basket: MANDALA_BASKET,
          include: 'entire transactions',
          includeCustomInstructions: true,
          limit: TOKEN_LIST_PAGE,
          offset
        })
        if (chunk.BEEF) beef.mergeBeef(chunk.BEEF)
        const outputs = chunk.outputs ?? []
        listed.push(...outputs)
        // An empty page always ends it — that, plus the page ceiling, is what
        // keeps a wallet that ignores `offset` from looping forever.
        if (outputs.length === 0) break
        offset += outputs.length
        if (typeof chunk.totalOutputs === 'number') {
          // The wallet's own count is the authority when it reports one. A
          // SHORT page must not end the loop here: a wallet is free to cap
          // `limit` below what was asked for, and treating its cap as "end of
          // basket" would re-introduce the very truncation this loop removes.
          if (offset >= chunk.totalOutputs) break
        } else if (outputs.length < TOKEN_LIST_PAGE) {
          break
        }
      }
    } catch (e) {
      // A wallet with no Mandala basket yet, a storage fault, or a page whose
      // BEEF would not merge. Either way a balance screen shows nothing rather
      // than a partial figure it would then gate money on, or an error it
      // cannot act on.
      devLog('[mandala] could not list the token basket:', e)
      return []
    }
    const out: ListedTokenOutput[] = []
    for (const output of listed) {
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

  /**
   * The hand-over rail's evidence, read out of this device's OWN settlement
   * tables (spec §4.5, wire contract §9.13).
   *
   * The lib's default source is its own transaction journal, which drops an
   * `'accepted'` entry as soon as the broadcast lands — so a wallet that has
   * been running for a week would hand its payee almost no admissions and
   * force it to walk (and submit) a chain that is long since settled. The
   * durable tables here are exactly the store the lib's `EvidenceSource` hook
   * was added for.
   *
   * FIX H / §9.10 applies in the outgoing direction too: a cached admission is
   * forwarded as this device's own claim about the chain, so only one signed
   * by the CONFIGURED overlay key is offered. Anything else (a foreign key, or
   * the empty `signerKey` an unsigned `/submit` answer is deliberately
   * recorded with) is ABSENT — the ancestor is walked and its linkage
   * forwarded instead, which is always correct and merely costs a submit.
   *
   * Neither lookup throws: the lib treats `undefined` as "nothing held", and a
   * storage fault at send time must cost evidence, never the payment.
   */
  const storeEvidenceSource: EvidenceSource = {
    admissionFor: async txid => {
      let row: TokenAdmissionRow | undefined
      try {
        row = await store.getAdmission(txid)
      } catch (e) {
        devLog(`[mandala] hand-over evidence could not read the admission of ${txid}:`, e)
        return undefined
      }
      if (!row) return undefined
      if (row.signerKey === '' || row.signerKey !== overlayIdentityKey) return undefined
      if (row.signatureHex === '' || row.outputsToAdmit.length === 0) return undefined
      return { outputsToAdmit: [...row.outputsToAdmit], signature: row.signatureHex, signerKey: row.signerKey }
    },
    linkageFor: async txid => {
      let row: TokenLinkageRow | undefined
      try {
        row = await store.getLinkage(txid)
      } catch (e) {
        devLog(`[mandala] hand-over evidence could not read the linkage payload of ${txid}:`, e)
        return undefined
      }
      if (!row || row.payloadBytes.length === 0) return undefined
      return Array.from(row.payloadBytes)
    }
  }

  /**
   * Pull into `beef` every parent of `tip` it does not already carry, from the
   * wallet's own ancestry lookup.
   *
   * 2026-09-15 incident: a noSend action's stored `inputBEEF` is only what the
   * lib passed to `createAction` — the token parents. The fee input the wallet
   * itself allocated (change from an earlier, still-unmined BSV send) was not
   * in it, and to the COVER walk a parent it cannot see is a hole (FIX B: it
   * could be a token). The immediate submit therefore never went out, and it
   * did so silently. The walk must see the same ancestry the wallet does.
   *
   * Best-effort per parent: a lookup that fails leaves that parent missing,
   * and the walk reports the hole exactly as before.
   */
  const completeAncestry = async (beef: Beef, tip: Transaction): Promise<void> => {
    const lookup = (
      storage as unknown as {
        getValidBeefForTxid?: (txid: string, mergeToBeef?: Beef) => Promise<Beef | undefined>
      }
    ).getValidBeefForTxid
    if (typeof lookup !== 'function') return
    for (const input of tip.inputs) {
      const parentTxid = input.sourceTXID ?? input.sourceTransaction?.id('hex')
      if (!parentTxid || beef.findTxid(parentTxid)?.tx !== undefined) continue
      try {
        await lookup.call(storage, parentTxid, beef)
      } catch (e) {
        devLog(`[mandala] could not load the ancestry of ${parentTxid} for the cover walk:`, e)
      }
    }
  }

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
    await completeAncestry(beef, tip)

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
    // Same hole as `cover`'s: a stored `inputBEEF` carries the token parents
    // the lib supplied, not the fee parent the wallet allocated. The overlay's
    // SPV check needs every input's source transaction, so complete the
    // ancestry here too (2026-09-15: a4a6b346 came back 503 "missing an
    // associated source transaction" on every pass).
    const own = beef.findTxid(txid)?.tx
    if (own) await completeAncestry(beef, own)
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
      // The lib already refuses an unsigned or unverifiable answer
      // (ERR_NO_ADMISSION / ERR_BAD_ADMISSION); this is the wallet's own
      // check on top, against ITS configured key and verifier, so no
      // answer can reach the settlement tables as an admission without a
      // σ_I that verifies here. An admitted set alone proves nothing about
      // whether the operator accepted the transaction (2026-09-15 review).
      const signatureHex = admitted.admissionSignature ?? ''
      const signerKey = admitted.admissionIdentityKey ?? ''
      if (signatureHex === '' || signerKey === '') {
        devLog(`[mandala] /submit of ${txid} admitted outputs but carried no admission signature; not an admission`)
        return { kind: 'unavailable', code: 'ERR_NO_ADMISSION', retryable: true }
      }
      const trusted = await verifyAdmission({
        txid,
        outputsToAdmit: admitted.outputsToAdmit,
        signature: hexToBytes(signatureHex),
        signerKey
      })
      if (!trusted) {
        devLog(`[mandala] /submit of ${txid}: admission signature does not verify under the configured key; not an admission`)
        return { kind: 'unavailable', code: 'ERR_BAD_ADMISSION', retryable: true }
      }
      return { kind: 'admitted', outputsToAdmit: admitted.outputsToAdmit, signatureHex, signerKey }
    } catch (e) {
      return verdictFromError(e)
    }
  }

  /**
   * Every spendable token coin's txid has a verified σ_I cached — fetched from
   * the overlay when it is missing.
   *
   * A coin can be in the basket with no admission on record: credited through
   * the plain inbox path, restored from a backup, or admitted by a counterparty
   * on this device's behalf. Such a coin spends fine online, but an OFFLINE
   * hand-over of it would carry no σ_I for its ancestor, and the payee's COVER
   * walk would have to submit the ancestor itself — impossible offline. So
   * this pass asks `GET /admin/admission/:txid` for each coin's txid that has
   * no trustworthy cached entry (FIX-H verified on the way in) and records it.
   * Best-effort, at most one ask per txid per pass, never throws.
   */
  const ensureAdmissionsForHoldings = async (): Promise<number> => {
    if (!available) return 0
    let outputs: ListedTokenOutput[]
    try {
      outputs = await listTokenOutputs()
    } catch (e) {
      devLog('[mandala] could not list token holdings to complete their admissions:', e)
      return 0
    }
    const byTxid = new Map<string, number[]>()
    for (const o of outputs) {
      if (!o.spendable) continue
      byTxid.set(o.txid, [...(byTxid.get(o.txid) ?? []), o.vout])
    }
    let fetched = 0
    for (const [txid, vouts] of byTxid) {
      let cached: TokenAdmissionRow | undefined
      try {
        cached = await store.getAdmission(txid)
      } catch (e) {
        devLog(`[mandala] could not read the cached admission of ${txid}:`, e)
        continue
      }
      if (cached && cached.signatureHex !== '' && cached.signerKey === overlayIdentityKey) continue
      const verdict = await fetchAdmission(overlayUrl, txid)
      if (verdict?.kind !== 'admitted') continue
      try {
        await store.putAdmission({
          txid,
          outputsToAdmit: verdict.outputsToAdmit,
          signatureHex: verdict.signatureHex,
          signerKey: verdict.signerKey,
          source: 'fetched',
          obtainedAt: now().toISOString()
        })
        fetched++
      } catch (e) {
        devLog(`[mandala] could not cache the fetched admission of ${txid}:`, e)
        continue
      }
      const unadmitted = vouts.filter(v => !verdict.outputsToAdmit.includes(v))
      if (unadmitted.length > 0) {
        console.warn(`[mandala] ${txid} is admitted but not for held output(s) ${unadmitted.join(',')}; those coins will not cover offline`)
      }
    }
    return fetched
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

  /**
   * THE 2026-09-15 REPAIR PASS.
   *
   * A settlement row that says `admitted`/`broadcast` and a wallet that says
   * the same transaction `failed` cannot both be right, and on that day they
   * were not: the overlay admitted a transfer (and broadcasts on admission),
   * and 0.7 s later the lib's bulk sweep aborted the still-`noSend` action that
   * built it. `proven_tx_reqs` went `nosend → abortAction → invalid`,
   * `transactions.status` went `failed`, and — the part that costs money —
   * `updateTransactionStatus('failed')` restored the input coin to spendable
   * although it was spent on chain. The next send picked it up and the overlay
   * refused the child with `ERR_INPUT_SPENT`.
   *
   * Three changes make that unreachable going forward (the sweep opt-out in
   * `reconcileJournals`, the abort guard in `abortGuard.ts`, and the lib no
   * longer clearing a journal entry for a broadcast that did not happen). This
   * pass is for the wallets it already happened to, and for any future way the
   * two records can diverge: it re-establishes the wallet's own view of a
   * transaction the chain has.
   *
   * **It never trusts the settlement row on its own.** The row is this device's
   * bookkeeping; the question "is this transaction real" is answered outside
   * it, by `refetchBeef` (the configured WhatsOnChain path the drain already
   * uses) or by the issuer's overlay confirming it holds an admission. Only
   * then is a `failed` transaction put back to `unproven`, its inputs re-marked
   * spent, its own outputs made spendable again, and its request restored to a
   * status the monitor proves from.
   *
   * Best-effort and non-throwing, like every other pass on the drain tick.
   * Returns the number of transactions repaired.
   */
  const repairAdmittedAborted = async (): Promise<number> => {
    if (!available || !db) return 0
    let rows: TokenSettlementRow[]
    try {
      rows = await store.listSettlements({ state: ['admitted', 'broadcast'] })
    } catch (e) {
      devLog('[mandala] settlement repair could not list settlement rows:', e)
      return 0
    }

    let repaired = 0
    for (const row of rows) {
      let damaged: { txStatuses: string[]; reqStatus?: string }
      try {
        damaged = await readWalletVerdict(row.txid)
      } catch (e) {
        devLog(`[mandala] settlement repair could not read the wallet's view of ${row.txid}:`, e)
        continue
      }
      // The wallet agrees with the row, or has no record at all. Nothing to do.
      if (!damaged.txStatuses.includes('failed') && damaged.reqStatus !== 'invalid') continue

      if (!(await transactionIsReal(row))) {
        devLog(
          `[mandala] ${row.txid} reads '${row.state}' locally but the wallet failed it, and neither the chain ` +
            'nor the overlay confirms it — left alone, because releasing or re-spending on a guess is the harm'
        )
        continue
      }

      try {
        const result = await storage.repairSettledTokenTransaction(row.txid)
        if (!result) continue
        repaired++
        console.warn(
          `[mandala] repaired ${row.txid}: settlement '${row.state}' but transaction ` +
            `${result.wasTxStatuses.join('/')}` +
            `${result.wasReqStatus ? ` and request '${result.wasReqStatus}'` : ''}. ` +
            `${result.inputsMarkedSpent} input(s) re-marked spent, ` +
            `${result.outputsMadeSpendable} output(s) restored to spendable` +
            `${result.reqCreated ? ', request recreated' : ''}`
        )
      } catch (e) {
        devLog(`[mandala] settlement repair could not restore ${row.txid}:`, e)
      }
    }
    if (repaired > 0) emit()
    return repaired
  }

  /** What this wallet's own tables say about a txid: every transaction status, and the request's. */
  const readWalletVerdict = async (txid: string): Promise<{ txStatuses: string[]; reqStatus?: string }> => {
    const txs = await storage.findTransactions({ partial: { txid }, noRawTx: true })
    const req = (await storage.findProvenTxReqs({ partial: { txid } }))[0]
    return { txStatuses: txs.map(t => t.status), reqStatus: req?.status }
  }

  /**
   * Is this transaction genuinely out there? Two independent witnesses, either
   * of which is enough, and neither of which is the settlement row itself.
   *
   * The chain is asked first because it is the stronger answer, but it is also
   * the one that lags: `refetchBeef` wants a verifiable BEEF, which a
   * transaction broadcast seconds ago does not have. The overlay is the witness
   * that matters in exactly that window — it admitted these bytes and it
   * broadcasts on admission, so an admission it still holds IS the statement
   * that the transaction went out. Neither answering is "no", never "unknown
   * so assume yes": the repair makes coins unspendable and must not run on a
   * guess.
   */
  const transactionIsReal = async (row: TokenSettlementRow): Promise<boolean> => {
    try {
      const beef = await args.refetchBeef?.(row.txid)
      if (beef && beef.length > 0) return true
    } catch (e) {
      devLog(`[mandala] settlement repair could not fetch ${row.txid} from the chain:`, e)
    }
    try {
      // The CONFIGURED overlay, never `row.overlayUrl` — the row's copy is
      // re-derived from counterparty frame bytes (§9.10), and the verdict this
      // returns is σ_I-verified against the configured key either way.
      return (await fetchAdmission(overlayUrl, row.txid))?.kind === 'admitted'
    } catch (e) {
      devLog(`[mandala] settlement repair could not ask the overlay about ${row.txid}:`, e)
      return false
    }
  }

  /**
   * Fail a token transaction the overlay has finally refused, so its inputs go
   * back to spendable and its outputs stop being offered. Best-effort; returns
   * whether anything was failed.
   */
  const failRefusedTransaction = async (txid: string): Promise<boolean> => {
    let failed = false
    const txs = await storage.findTransactions({ partial: { txid }, noRawTx: true })
    for (const tx of txs) {
      if (tx.status === 'failed') continue
      await storage.updateTransactionStatus('failed', tx.transactionId)
      failed = true
    }
    return failed
  }

  const reviewTokenHoldings = async (): Promise<TokenHoldingsReview> => {
    const review: TokenHoldingsReview = { settled: 0, removed: 0, unattested: 0, unreachable: false }
    if (!available) return review

    let rows: TokenSettlementRow[] = []
    try {
      rows = await store.listSettlements({ state: ['handed_over', 'held', 'submitting', 'admitted'] })
    } catch (e) {
      devLog('[mandala] token review could not list settlement rows:', e)
    }
    const reviewedTxids = new Set<string>()
    for (const row of rows) {
      reviewedTxids.add(row.txid)
      try {
        const after = await settleNow(row.txid)
        if (after === 'broadcast') {
          review.settled++
          continue
        }
        if (after === 'refused' || after === 'orphaned') {
          if (await failRefusedTransaction(row.txid)) review.removed++
          continue
        }
        const verdict = await fetchAdmission(overlayUrl, row.txid)
        if (verdict === undefined) {
          review.unattested++
          continue
        }
        if (verdict.kind === 'unavailable') {
          review.unreachable = true
          continue
        }
        if (verdict.kind === 'admitted') {
          await store.putAdmission({
            txid: row.txid,
            outputsToAdmit: verdict.outputsToAdmit,
            signatureHex: verdict.signatureHex,
            signerKey: verdict.signerKey,
            source: 'fetched',
            obtainedAt: now().toISOString()
          })
          await store.advanceSettlement(row.txid, ['handed_over', 'held', 'submitting'], 'admitted', {
            admissionOutputs: verdict.outputsToAdmit,
            admissionSignatureHex: verdict.signatureHex
          })
          continue
        }
        const to: TokenSettlementState = verdict.kind === 'evicted' ? 'orphaned' : 'refused'
        await store.advanceSettlement(row.txid, [...NON_TERMINAL_SETTLEMENT_STATES], to, {
          refusedCode: verdict.kind === 'refused' ? verdict.code : undefined,
          poisonedByTxid: verdict.kind === 'evicted' ? row.txid : undefined
        })
        await failRefusedTransaction(row.txid)
        review.removed++
      } catch (e) {
        devLog(`[mandala] token review could not settle ${row.txid}:`, e)
      }
    }

    let outputs: ListedTokenOutput[] = []
    try {
      outputs = await listTokenOutputs()
    } catch (e) {
      devLog('[mandala] token review could not list token holdings:', e)
    }
    const byTxid = new Map<string, number[]>()
    for (const o of outputs) {
      if (!o.spendable || reviewedTxids.has(o.txid)) continue
      byTxid.set(o.txid, [...(byTxid.get(o.txid) ?? []), o.vout])
    }
    for (const [txid, vouts] of byTxid) {
      try {
        const cached = await store.getAdmission(txid)
        if (
          cached &&
          cached.signatureHex !== '' &&
          cached.signerKey === overlayIdentityKey &&
          vouts.every(v => cached.outputsToAdmit.includes(v))
        ) {
          continue
        }
        const verdict = await fetchAdmission(overlayUrl, txid)
        if (verdict === undefined) {
          review.unattested++
          continue
        }
        if (verdict.kind === 'unavailable') {
          review.unreachable = true
          continue
        }
        if (verdict.kind !== 'admitted') {
          if (await failRefusedTransaction(txid)) review.removed++
          continue
        }
        await store.putAdmission({
          txid,
          outputsToAdmit: verdict.outputsToAdmit,
          signatureHex: verdict.signatureHex,
          signerKey: verdict.signerKey,
          source: 'fetched',
          obtainedAt: now().toISOString()
        })
        for (const vout of vouts) {
          if (verdict.outputsToAdmit.includes(vout)) continue
          const found = await storage.findOutputs({ partial: { txid, vout } })
          for (const output of found) {
            await storage.updateOutput(output.outputId, { spendable: false })
            review.removed++
          }
        }
      } catch (e) {
        devLog(`[mandala] token review could not check the coin(s) of ${txid}:`, e)
      }
    }
    if (review.removed > 0 || review.settled > 0) emit()
    return review
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
  const tokenDepsValue = { store, cover, submit, frames, overlayIdentityKey, verifyAdmission, journalRemove }
  const tokenDeps: OfflineTokenDeps = tokenDepsValue

  const isOnline = args.isOnline ?? (async () => true)

  /**
   * Every drainable row the PAYER's handle rail owns, stepped once.
   *
   * `sendToHandle` writes a `token_settlements` row and no queue row, and the
   * release drain only steps queue rows — so a hand-over whose immediate
   * `settleNow` did not settle (offline, a cover hole, a 503) had NOTHING
   * retrying it: `recoverStaleAdmissions` can fetch a σ_I the overlay already
   * holds but never broadcasts, and the lib's own reconcile cannot broadcast
   * through this wallet's hold at all (2026-09-15 incident). This is the
   * missing retry: on every tick, each `sent` row still in a drain-owned state
   * takes the same `settleNow` step it would have taken at send time. Rows the
   * user owns (`built`/`parked`) are never touched (FIX F); received rows have
   * their own queue entries. Never throws; returns how many rows moved.
   */
  const PAYER_DRAIN_STATES: TokenSettlementState[] = ['handed_over', 'submitting', 'admitted']
  const settlePendingSends = async (): Promise<number> => {
    if (!available) return 0
    let rows: TokenSettlementRow[]
    try {
      rows = await store.listSettlements({ state: PAYER_DRAIN_STATES })
    } catch (e) {
      devLog('[mandala] could not list the payer rows to settle:', e)
      return 0
    }
    let advanced = 0
    for (const row of rows) {
      if (row.role !== 'sent') continue
      try {
        const after = await settleNow(row.txid)
        if (after !== row.state) advanced++
      } catch (e) {
        devLog(`[mandala] settling ${row.txid} on the tick failed; next tick retries:`, e)
      }
    }
    return advanced
  }

  /**
   * The step's broadcast: the release engine's own owned post, by default.
   *
   * `postTokenStep` reaches this only once every ancestor in COVER's
   * `mustSubmit` is admitted, so nothing about the §4.3 gate changes — this is
   * simply the same `postOwned` the queue drain would have used a tick later,
   * called for one txid instead of a planned graph.
   */
  const broadcastTip =
    args.broadcast ?? (async (txid: string): Promise<PostOutcome> => await postOwnedByTxid(storage, txid))

  /**
   * One `settleNow` per txid at a time.
   *
   * Not a lock on the money — `advanceSettlement` is a CAS and `/submit` is
   * idempotent, so correctness never depended on this — but a send and a
   * re-tap, or a nearby hold and a drain tick that lands on the same
   * millisecond, would otherwise each open their own `/submit` for identical
   * bytes. Coalescing costs nothing and makes the second caller wait for the
   * first caller's answer, which is also the more useful answer.
   */
  const settlesInFlight = new Map<string, Promise<TokenSettleState>>()

  /**
   * §4.3's drain step for exactly one row, run now.
   *
   * Everything this does, the ordinary drain does too. What it never does is
   * decide anything the drain would not: a row the USER owns is left alone
   * (FIX F), a terminal row is reported as it stands, and any failure — a
   * missing row, an unreachable overlay, a throw from deep inside the walk —
   * leaves the row exactly where it was for the next tick. It cannot reject.
   */
  const runSettleStep = async (txid: string): Promise<TokenSettleState> => {
    if (!available) return 'unavailable'
    let row: TokenSettlementRow | undefined
    try {
      row = await store.getSettlement(txid)
    } catch (e) {
      devLog(`[mandala] settleNow could not read the settlement row for ${txid}:`, e)
      return 'unavailable'
    }
    if (!row) return 'unavailable'
    // Nothing left to do, and nothing that may be undone (spec §5).
    if (TERMINAL_SETTLEMENT_STATES.includes(row.state)) return row.state
    // FIX F: `built`/`parked` are the payer's own states. A payment deliberately
    // withheld is not settled by a convenience path.
    if (row.state === 'built' || row.state === 'parked') return row.state

    try {
      await postTokenStep(
        { store, cover, submit, broadcast: broadcastTip, overlayIdentityKey, verifyAdmission, journalRemove, now },
        row,
        { txid, owned: true }
      )
    } catch (e) {
      // `postTokenStep` is written not to throw, but it is reached here from a
      // money path that has already succeeded: a surprise must cost a drain
      // interval, never the send.
      devLog(`[mandala] settleNow could not complete the settlement step for ${txid}:`, e)
    }

    let after: TokenSettlementRow | undefined
    try {
      after = await store.getSettlement(txid)
    } catch (e) {
      devLog(`[mandala] settleNow could not re-read the settlement row for ${txid}:`, e)
      return 'unavailable'
    }
    if (after && after.state !== row.state) emit()
    else devLog(`[mandala] settlement step for ${txid} left the row at '${row.state}'; the drain retries next tick`)
    return after?.state ?? 'unavailable'
  }

  const settleNow = async (txid: string): Promise<TokenSettleState> => {
    const existing = settlesInFlight.get(txid)
    if (existing) return await existing
    const run = runSettleStep(txid).finally(() => {
      settlesInFlight.delete(txid)
    })
    settlesInFlight.set(txid, run)
    return await run
  }

  /**
   * How long a send waits for its own submit before handing it back to the drain.
   *
   * The hand-over is already done when this starts, so the only thing at stake
   * is whether the receipt gets to say "settled" — and a receipt that arrives
   * eight seconds late is worse than one that says "settling" and is corrected
   * by the activity list a minute later. The submit itself is NOT cancelled on
   * timeout: it is still in flight, still idempotent, and its verdict still
   * lands in the row.
   */
  const SETTLE_ON_SEND_TIMEOUT_MS = 8_000

  const settleWithinSendTimeout = async (txid: string): Promise<TokenSettleState | 'timeout'> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        settleNow(txid),
        new Promise<'timeout'>(resolve => {
          timer = setTimeout(() => resolve('timeout'), SETTLE_ON_SEND_TIMEOUT_MS)
        })
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

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
  const onTokenHandedOver: TokenHandedOverHook = async (frame, txid, state, reference) => {
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
      // The nearby rail's half of the abort guard: the action that built this
      // tip is `noSend` and stays that way until the drain broadcasts it, so
      // the reference is recorded the same moment the row is. Absent for a
      // caller that does not have one — see `TokenHandedOverHook`.
      ...(reference ? { reference } : {}),
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

  /**
   * How a credited hand-over is settled: by the DRAIN, on its next tick — not
   * inline, and never from inside the receive loop.
   *
   * The lib's own `defaultSettle` POSTs each `mustSubmit` txid to `/submit`
   * right there in `acceptOne`. That is right for the online web console and
   * wrong for a phone: a wallet that credits a payment while offline (or on a
   * flaky connection) would throw out of the receive loop, leave the message
   * un-acknowledged, and re-run the whole credit next pass — and, worse, would
   * be doing overlay I/O on the path that has just internalized money.
   *
   * So this writes DURABLE OBLIGATIONS instead: one `held` settlement row per
   * transaction the COVER walk says still needs submitting (the tip included),
   * plus the linkage payload the payer forwarded for it, through exactly the
   * same `onTokenHeld` the nearby rail uses. `postTokenStep` then owns the
   * rest — it re-runs COVER over these very tables and submits parents-first,
   * tip last, on every online tick, idempotently (§0.1 rules 3/6).
   *
   * A throw here means "do not acknowledge the message yet", which is correct:
   * the credit is idempotent (`internalizeAction` already tolerates a repeat)
   * and a row that was never written is an obligation nothing would own.
   */
  const settleThroughDrain: SettleFn = async ({ txid, mustSubmit, bytesFor }) => {
    // The tip is normally the last entry of `mustSubmit`; appending it when it
    // is absent costs nothing and makes the tip's own row unconditional.
    const ids = mustSubmit.includes(txid) ? [...mustSubmit] : [...mustSubmit, txid]
    // One asset for the whole chain — read from the tip's own bytes, never
    // from the message body, which is the payer's claim (§9.10).
    const tipBytes = bytesFor(txid)
    let assetId: string | undefined
    if (tipBytes) {
      try {
        assetId = assetIdOfTx(Transaction.fromAtomicBEEF(tipBytes.beef))
      } catch (e) {
        devLog(`[mandala] could not read the asset of hand-over tip ${txid}:`, e)
      }
    }
    if (assetId === undefined) {
      // Nothing coherent to own the obligation under. Left to the next inbox
      // pass rather than silently credited with no row.
      throw new Error(`could not write the settlement row before crediting ${txid}: unknown asset`)
    }
    for (const id of ids) {
      const bytes = bytesFor(id)
      if (!bytes) {
        // COVER only ever names transactions the bundle carries, so this is a
        // lib-side contradiction rather than a normal state.
        devLog(`[mandala] the hand-over bundle for ${txid} carries no bytes for ${id}`)
        continue
      }
      await onTokenHeld(
        {
          kind: 'token',
          token: {
            assetId,
            // The CONFIGURED deployment, never one named on the wire (§9.10).
            overlayUrl,
            overlayIdentityKey,
            linkage:
              bytes.offChainValues.length > 0
                ? [{ txid: id, payload: Uint8Array.from(bytes.offChainValues) }]
                : []
          },
          transaction: Uint8Array.from(bytes.beef)
        },
        id
      )
    }
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
   *
   * **`sweep: false`, always.** `reconcileWallet`'s last step is a BULK SWEEP:
   * it lists every stuck `noSend` mandala action the wallet holds and aborts
   * the ones no journal entry claims. That is right for a host whose wallet
   * broadcasts as soon as the overlay accepts — and exactly wrong for this one,
   * where `attemptToPostReqsToNetwork` HOLDS every token request for the
   * settlement drain, so a live, healthy, already-admitted payment looks
   * abandoned. On 2026-09-15 that sweep aborted a transfer the overlay had
   * broadcast 0.7 s earlier and released its input coin as spendable (see
   * `abortGuard.ts`). Settlement in this wallet is owned by `token_settlements`
   * and the drain over it; the lib's sweep must never run here, on any tick,
   * for any reason.
   */
  const reconcileJournals = async (): Promise<void> => {
    if (!available) return
    try {
      // `broadcast: false`: the lib may re-submit its journaled bytes (the
      // overlay is idempotent) but must NOT broadcast through
      // `createAction({ sendWith })` — this wallet's storage holds every token
      // request for the settlement drain, so that broadcast can never succeed
      // here and only burned the lib's retry cap into a 'stranded' entry
      // (2026-09-15). The drain's `postTokenStep` clears the entry when the
      // transaction really goes out (`journalRemove`).
      const r = await reconcileWalletWithOptions(bound, { sweep: false, broadcast: false })
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
    settleNow,
    settlePendingSends,
    ensureAdmissionsForHoldings,
    recoverStaleAdmissions,
    repairAdmittedAborted,
    reviewTokenHoldings,
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
          recipientKey: recipientIdentityKey,
          // 2026-09-15 maintainer decision (§4.5, §12.9, wire contract §9.13):
          // EVERY rail is hand-over-first. The SEND contacts no overlay at all —
          // the bytes are built and signed `noSend`, the payee is handed the
          // evidence, and whoever reconnects first submits. The payer's own
          // submit follows the hand-over rather than racing it: `settleNow`
          // below when this device has signal, the ordinary drain otherwise,
          // both over the `handed_over` row written below.
          mode: 'handover',
          evidence: storeEvidenceSource
        })
        // The handle rail's own evidence (spec §4.5): the exact bytes and
        // off-chain payload just handed over, cached the same way a nearby
        // hand-over's frame would be. On this rail it is no longer merely an
        // optimisation — the drain's own `submit()` reads the tip's linkage
        // row to build the `/submit` body, so without this write the payment
        // could only ever be settled by the payee. Its own try/catch: the
        // payee already holds the bytes, so a bad or missing value must cost a
        // later reconciliation pass, never the settlement journal below (still
        // less the payment itself, which is already made).
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
          await store.upsertSettlement({
            txid: result.txid,
            role: 'sent',
            assetId,
            // Always `handed_over`, never `admitted`: at THIS point the device
            // has no proof of admission and has asked for none. The row is what
            // `settleNow` claims a moment later (and failing that, what the
            // drain picks up on its next online tick — `postTokenStep` over
            // `handed_over`), and what `activityStatusOf` reads as "settling".
            state: 'handed_over',
            counterpartyKey: recipientIdentityKey,
            amountBaseUnits: baseUnits,
            overlayUrl,
            overlayIdentityKey,
            // The `createAction`/`signAction` reference of the noSend action
            // that built these bytes, when the lib reports one. It is what
            // `wrapAbortActionForSettlements` matches an `abortAction` against,
            // and it must be on the row BEFORE the submit below — the incident
            // window opens the instant the overlay admits (and broadcasts), and
            // a reference written afterwards would leave exactly that window
            // unguarded. Read structurally because `TransferResult.reference` is
            // landing in the linked lib concurrently; absent, the row simply has
            // no reference and the guard blocks nothing for it.
            ...referenceOf(result)
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
        const notified = result.notified !== false

        // ── THEN, and only then, this device's own submit (§4.3, 2026-09-15) ──
        //
        // Hand-over first is not softened by this, it is *completed* by it: the
        // v2 body is posted and the `handed_over` row is durable before a
        // single byte goes to the overlay, and both of those are above this
        // line. What changes is that a payer who has signal no longer waits a
        // drain interval to finish what they started.
        //
        // Two conditions, and both are about the hand-over rather than about
        // the overlay:
        //
        //  · `notified` — a notification that did not go out means the payee
        //    has NOT been handed anything yet, so the order is not satisfied
        //    and the submit waits for `reconcileNotifications` to deliver it.
        //  · `isOnline()` — offline there is nothing to try, and the probe is
        //    made here rather than inside `settleNow` so a send on a dead
        //    connection costs no request at all.
        //
        // Everything after this point is best-effort by construction: the
        // result is already `sent`, `settleNow` cannot throw, and a timeout
        // leaves the same in-flight submit running for the drain to observe.
        let settled = false
        if (notified) {
          try {
            if (await isOnline()) {
              const state = await settleWithinSendTimeout(result.txid)
              settled = state === 'admitted' || state === 'broadcast'
              if (state === 'timeout') {
                devLog(`[mandala] ${result.txid} was handed over; its submit runs on, and the drain will finish it`)
              }
            }
          } catch (e) {
            // Logged, never surfaced. The payment is made either way.
            devLog(`[mandala] handed ${result.txid} over but could not settle it now:`, e)
          }
        }
        return { kind: 'sent', txid: result.txid, settled, notified }
      } catch (e) {
        const overlay = asOverlayRefusal(e)
        // Always leave the real cause in the console. Nothing here contacts an
        // overlay any more, so an 'unavailable' is a LOCAL fault (MessageBox,
        // wallet, coin selection) and its full text is the only diagnosis
        // there is — the banner keeps one sentence of it.
        console.warn('[mandala] sendToHandle failed:', overlay ? `${overlay.code} ${overlay.message}` : e)
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
        processed: processedMessages,
        settle: settleThroughDrain
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
      // Before the release pass, not after: a transaction this restores to
      // 'unproven' has its inputs re-marked spent, and the whole point is that
      // the release pass below must never plan a send from a coin that is
      // already gone.
      await repairAdmittedAborted()
      await reconcileJournals()
      await settlePendingSends()
      await ensureAdmissionsForHoldings()
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

