/**
 * Vault transfers — internal movements between the `default` change basket
 * and the `admin vault` basket, over 1-of-N P-256 comb-verifier outputs
 * (r1comb.ts, spec §2).
 *
 * Deposit: NO hardware. A vault output is a fresh 32-byte salt committed to
 * every enrolled key's comb table (`commitment(pubkey, salt)` per meta.keys
 * entry), baked into one ~28 KB lock; the salt and the key list travel in
 * the output's customInstructions (v4). Funding and change stay with the
 * toolbox, out of the default basket. Because the salt lives only in the
 * wallet database, a deposit is refused while encrypted backup push is off
 * (D13) — and while the release flag is off (D15).
 *
 * Withdraw (Task 10): the user names a key BEFORE the tap. Only outputs
 * committed to that key are selected (filter → sort → cap), each one's REAL
 * lock out of the listed BEEF is checked for the key's commitment, and the
 * card then signs one 32-byte digest per input in batches of
 * VAULT_INPUTS_PER_TAP (ceremonyHost). Every unlock is validated locally with
 * strict Spend flags before signAction. The toolbox returns the withdrawn
 * value (minus fee, minus any re-vaulted remainder) as change into the default
 * basket — that change IS the internal transfer.
 *
 * Re-lock (Task 11): the same selection with amount 'all', but the ONLY
 * output is a new vault output committed to the CURRENT key set — how a key
 * added later gains access to old deposits, and how a removed key loses it
 * (spec §4.3).
 *
 * The deferred-broadcast finish on withdrawal (see the PAST THE POINT OF NO
 * ABORT comment) survives from the earlier designs on its own merits. What
 * remains of the two-transaction staging machinery exists only to recover
 * money the old flow stranded on real wallets (see reclaimStagingOutputs).
 *
 * The `admin vault` basket name is admin-reserved: WalletPermissionsManager
 * blocks any non-admin originator (web pages) from listing, inserting into, or
 * relinquishing it. All calls here use the admin originator.
 *
 * SECURITY: no key material passes through this module — ever. A VaultSigner
 * (serial, public key, sign()) arrives from ceremonyHost for the length of ONE
 * withdrawal or re-lock and is released in a finally. Salts are public once
 * spent and are never logged before that.
 */
import { Beef, Hash, LockingScript, P2PKH, PublicKey, Transaction, TransactionSignature, UnlockingScript, Utils } from '@bsv/sdk'
import { isBackupPushEnabled } from '../../backup/preference'
import { isVaultEnabled } from '../../toolboxConfig'
import { noteVaultProgress, requestVaultSigner } from './ceremonyHost'
import {
  R1C_LOCK_LEN,
  R1C_UNLOCK_LEN,
  SALT_BYTES,
  VaultInstructionsV4,
  bakedCommitments,
  buildLock,
  buildUnlock,
  commitment,
  decodeVaultInstructions,
  encodeVaultInstructions,
  pushTxDerCheck,
  sighashPreimage,
  signerDigest,
  verifyVaultInput
} from './r1comb'
import { randomBytes } from './random'
import { VaultError } from './types'
import { VAULT_MIN_KEYS } from './VaultKeyService'
import { vaultStore, VaultKeyRecord } from './vaultStore'

export const VAULT_BASKET = 'admin vault'

/**
 * LEGACY — the intermediate basket the retired two-transaction deposit split
 * its funding into (tx1 carved out deposit + tx2 fee here; tx2 spent it into
 * the vault). No new outputs are ever created in it. It survives only so that
 * reclaimStagingOutputs can find and recover coins the old flow stranded on
 * real wallets (tx1 landed, tx2 failed). Spec §5.2: kept until the user
 * confirms nothing is stranded; a follow-up then removes it.
 */
export const VAULT_STAGING_BASKET = 'vault staging'

/** LEGACY — BRC-42 protocol the staging output's P2PKH key was derived under.
 * Reclaim-only: the key lives in the ordinary wallet key deriver (counterparty
 * 'self'), so spending a staging coin needs no ceremony and no YubiKey. */
const STAGING_PROTOCOL: [number, string] = [2, 'vault deposit staging']

/** P2PKH unlock, worst case: push(73-byte DER+hashtype sig) + push(33-byte key). */
const STAGING_UNLOCK_LEN = 108

interface StagingInstructions {
  v: 1
  type: 'staging'
  keyID: string
}

function decodeStagingInstructions(s: string | undefined): StagingInstructions | null {
  if (!s) return null
  try {
    const o = JSON.parse(s)
    return o && o.v === 1 && o.type === 'staging' && typeof o.keyID === 'string' ? o : null
  } catch {
    return null
  }
}

/**
 * Storage-backed lookup of the transactions reserving a set of outpoints.
 *
 * Injected rather than imported so this module stays testable without a database
 * — and optional, so a caller that has no storage handle keeps the original
 * paged-scan heal. See findSpendingReferences in StorageExpoSQLite.
 */
export type SpendingReferenceLookup = (
  outpoints: string[]
) => Promise<{ reference: string; status: string }[]>

/**
 * Injected dependencies for a vault transfer.
 *
 * Injected rather than imported so the module stays testable without native
 * modules, a database or a configured host, and optional so a caller that has
 * none of them still works.
 */
export interface VaultTransferOptions {
  /** Storage-backed reservation heal. See SpendingReferenceLookup. */
  findSpendingReferences?: SpendingReferenceLookup
  /**
   * The app's single online signal.
   *
   * Vault transfers are refused while offline. The offline queue exists for
   * small casual default-basket payments: processOfflineActions holds every held
   * request's full rawTx and inputBEEF in one in-memory Beef, and a held row has
   * no attempt cap, no expiry and no local terminal state that releases its
   * reservation — so a vault transaction landing there would freeze real money
   * with no way out. Refusing up front is also what makes "no vault row ever
   * reaches the offline drain" a testable invariant.
   */
  isOnline?: () => Promise<boolean>
  /** Injected gates so the module stays config-free in tests. Defaults:
   * isVaultEnabled() (toolboxConfig) and isBackupPushEnabled() (backup/preference). */
  vaultEnabled?: () => boolean
  backupEnabled?: () => Promise<boolean>
}

export interface VaultSpendResult {
  txid: string
  /**
   * Vault outputs the chosen key COULD open but which were left untouched by
   * the input cap (VAULT_MAX_INPUTS). Non-zero means the withdrawal was
   * partial: repeating it with the same key moves them (each pass also
   * consolidates, so the next one needs fewer inputs).
   */
  cappedInputs: number
  /**
   * Outputs the chosen key is NOT committed to (spec §4.2 step 8): they need
   * one of `keys`. `serial` is present when the pubkey is still in meta —
   * absent for a key that has since been removed.
   */
  unreachable: { count: number; satoshis: number; keys: { serial?: string; pubkey: string }[] }
}

/** How the vault's outputs relate to the CURRENT key list (spec §3.4 badges). */
export interface VaultKeyCoverage {
  /** Decodable v4 outputs in the basket. */
  outputs: number
  /** Outputs whose key set differs from the current one, in either direction. */
  stale: number
  /** Current pubkeys absent from at least one output — "not yet open to X". */
  missingKeys: string[]
  /** Outputs committed to a pubkey no longer in meta — "still open to a removed key". */
  removedKeyOutputs: number
}

/**
 * Deposit floor AND withdrawal-remainder fold threshold (spec §4.1 step 1,
 * §4.2 step 4).
 *
 * An R1C output costs ~28 KB to create and ~2.5 KB of unlock plus its 28 KB
 * source transaction in the BEEF to spend, so at the wallet's fee rate one
 * output is a few thousand satoshis of fees over its life. 100,000 keeps that
 * under a few percent of the smallest deposit, and gives the re-lock (whose
 * fee comes out of the vault) room to run. The screen renders the floor
 * inline; `below-dust` is the defensive service-side refusal.
 */
export const VAULT_DEPOSIT_MIN = 100_000

/**
 * Vault inputs per withdrawal.
 *
 * What bounds this is size and createAction ergonomics. Each vault input
 * contributes its ~28 KB source transaction to the inputBEEF (32 inputs ≈
 * 900 KB — spec §6 residual 4, with listOutputs' missing response cap) plus a
 * 2.5 KB unlocking script; every input is one more coin to reserve atomically
 * and release if anything fails, one more sighash preimage over a transaction
 * that grows with each input, one more on-card signature inside the tap
 * batches, and one more chance for a stuck reservation to wedge the whole
 * withdrawal. 32 drains any realistic vault in one pass while staying well
 * inside all of that; the hard ceiling is the value no future tuning may
 * exceed without redoing that reasoning. (It is also the vault-side control
 * services/walletArgLimits.ts refers to — the vault bypasses the
 * wallet-argument caps structurally, so this IS its bound.)
 *
 * Consolidation is automatic: a capped withdrawal re-vaults its remainder as one
 * output, so repeated withdrawals converge on a single vault UTXO.
 */
export const VAULT_MAX_INPUTS = 32
export const VAULT_HARD_MAX_INPUTS = 48

/** The subset of the wallet interface transfers depends on (injected so the
 * whole module is testable without the toolbox). */
export interface VaultWallet {
  createAction(args: unknown, originator: string): Promise<CreateActionResult>
  signAction(args: unknown, originator: string): Promise<{ txid?: string; tx?: number[] }>
  listOutputs(args: unknown, originator: string): Promise<ListOutputsResult>
  abortAction(args: unknown, originator: string): Promise<unknown>
  listActions?(args: unknown, originator: string): Promise<{ actions: VaultActionRow[] }>
  /**
   * LEGACY — both used ONLY by reclaimStagingOutputs (spec §5.2): the staging
   * output's BRC-42 public key (to rebuild the P2PKH subscript it signs) and
   * its signature come from the wallet's own key deriver. Nothing in the R1C
   * deposit / withdraw / re-lock paths calls either — the deposit tests pin
   * that — and both leave when the staging reclaim does.
   */
  getPublicKey(args: unknown, originator: string): Promise<{ publicKey: string }>
  createSignature(args: unknown, originator: string): Promise<{ signature: number[] }>
}

/** The fields of a listActions row the reservation heal needs. `inputs` arrives
 * only when the call asked for `includeInputs`, and a transaction that never
 * reached signing has no `txid` — which is exactly the case the outpoint match
 * exists to cover. */
export interface VaultActionRow {
  txid?: string
  status: string
  reference?: string
  inputs?: { sourceOutpoint?: string }[]
}

interface CreateActionResult {
  txid?: string
  tx?: number[]
  signableTransaction?: { tx: number[]; reference: string }
}
interface ListOutputsResult {
  outputs: {
    outpoint: string
    satoshis: number
    customInstructions?: string
  }[]
  /** Present when `include: 'entire transactions'` was requested — the
   * multi-tx BEEF covering every listed output's source transaction. Forwarded
   * verbatim as createAction's inputBEEF and read for each output's REAL lock. */
  BEEF?: number[]
}

// ── helpers ───────────────────────────────────────────────────────────────

/** True for the toolbox's WERR_REVIEW_ACTIONS — an undelayed action that needs
 * review, in our case a double-spend against a vault UTXO still reserved by a
 * stuck prior attempt whose reserving transaction DOES have a txid. */
function isReviewActionsError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false
  const anyE = e as { code?: unknown; message?: string; reviewActionResults?: unknown }
  return anyE.code === 5 || 'reviewActionResults' in anyE || /require review/i.test(anyE.message ?? '')
}

/** The txids the review error blames for the double-spend — the transactions
 * still reserving our vault UTXO. */
function competingTxids(e: unknown): string[] {
  const rr = (e as { reviewActionResults?: unknown }).reviewActionResults
  if (!Array.isArray(rr)) return []
  const out: string[] = []
  for (const r of rr) {
    const c = (r as { competingTxs?: unknown }).competingTxs
    if (Array.isArray(c)) out.push(...(c as string[]))
  }
  return out
}

/** One outpoint spelling. The toolbox writes `txid:vout` into error text and
 * `txid.vout` into outpoint fields; both mean the same coin. */
const sameOutpoint = (outpoint: string): string => outpoint.trim().toLowerCase().replace(':', '.')

/**
 * The outpoints named by the toolbox's OTHER reservation refusal:
 *
 *   The inputs[0] parameter must be spendable output. output <txid>:0 appears
 *   to have been spent (spendable=false). [WERR_INVALID_PARAMETER]
 *
 * This is the shape a failed withdrawal actually leaves behind. createAction
 * reports a double-spend review only when the output's `spentBy` transaction
 * has a txid; an attempt that died before signing never got one, so the same
 * check falls through to this plain WERR_INVALID_PARAMETER instead (see
 * storage/methods/createAction.js). It names the OUTPOINT and no txid, which
 * is why the review-actions heal below cannot see it.
 *
 * Matched on the message shape, deliberately narrowly: WERR_INVALID_PARAMETER
 * covers most argument mistakes, and mistaking one for a stuck reservation
 * would abort transactions over an unrelated bug.
 */
function unspendableInputOutpoints(e: unknown): string[] {
  if (!e || typeof e !== 'object') return []
  const msg = (e as { message?: string }).message ?? ''
  if (!/must be spendable output/i.test(msg)) return []
  return [...msg.matchAll(/\b([0-9a-fA-F]{64})[.:](\d+)\b/g)].map(m => sameOutpoint(`${m[1]}.${m[2]}`))
}

/** A locally-held reservation is never in a terminal on-chain state; these are
 * the states abortAction accepts, plus 'failed' which also holds inputs. */
const ABORTABLE = new Set(['unsigned', 'nosend', 'nonfinal', 'failed'])

/**
 * Page ALL actions and abort every one `matches` picks out, which resets its
 * inputs' `spentBy` and frees the coin. Best-effort — returns how many were
 * aborted.
 *
 * Pages everything rather than filtering by label: the transaction reserving a
 * vault UTXO may carry no vault label of its own.
 */
async function abortActions(
  w: VaultWallet,
  adminOriginator: string,
  matches: (a: VaultActionRow) => boolean,
  opts: { includeInputs?: boolean; stopAfter: number }
): Promise<number> {
  if (!w.listActions) return 0
  let scanned = 0
  const seen: string[] = []
  // By reference, so the same orphan is never aborted twice — a second
  // abortAction on it would be rejected, and counting it again would report a
  // heal that did not happen.
  const aborted = new Set<string>()
  try {
    let offset = 0
    for (let page = 0; page < 25 && aborted.size < opts.stopAfter; page++) {
      const res = await w.listActions(
        { labels: [], limit: 200, offset, ...(opts.includeInputs ? { includeInputs: true } : {}) },
        adminOriginator
      )
      const actions = res.actions ?? []
      if (actions.length === 0) break
      scanned += actions.length
      for (const a of actions) {
        if (!matches(a)) continue
        seen.push(`${a.status}${a.reference ? '' : '/no-ref'}`)
        if (a.reference && ABORTABLE.has(a.status) && !aborted.has(a.reference)) {
          aborted.add(a.reference)
          await w.abortAction({ reference: a.reference }, adminOriginator).catch(err =>
            console.log('[vault] abortAction rejected:', (err as Error)?.message)
          )
        }
      }
      offset += actions.length
    }
    console.log(
      '[vault] abort scan · scanned=%d · matches=[%s] · aborted=%d',
      scanned,
      seen.join(', ') || 'NONE',
      aborted.size
    )
  } catch (e) {
    console.log('[vault] abort scan error:', (e as Error)?.message)
  }
  return aborted.size
}

/** Abort the orphaned transactions the review error blames, by txid. */
async function abortReservingTxids(w: VaultWallet, adminOriginator: string, txids: string[]): Promise<number> {
  if (txids.length === 0) return 0
  const want = new Set(txids)
  return await abortActions(w, adminOriginator, a => a.txid != null && want.has(a.txid), { stopAfter: want.size })
}

/** Abort the orphaned transactions holding these outpoints, matched on each
 * action's own input list — the only handle available when the reservation has
 * no txid to blame. */
async function abortReservingOutpoints(
  w: VaultWallet,
  adminOriginator: string,
  outpoints: string[],
  findSpendingReferences?: SpendingReferenceLookup
): Promise<number> {
  if (outpoints.length === 0) return 0

  // One indexed query when storage is reachable. The scan below answers the
  // same question by paging up to 5,000 actions with includeInputs, and
  // listActionsSql answers each page by loading every action's full rawTx and
  // running Transaction.fromBinary on it to read a sequence number — so a vault
  // retry parsed thousands of transactions to find one outpoint.
  if (findSpendingReferences) {
    try {
      const rows = await findSpendingReferences(outpoints)
      const aborted = new Set<string>()
      for (const r of rows) {
        if (!ABORTABLE.has(r.status) || aborted.has(r.reference)) continue
        aborted.add(r.reference)
        await w.abortAction({ reference: r.reference }, adminOriginator).catch(err =>
          console.log('[vault] abortAction rejected:', (err as Error)?.message)
        )
      }
      console.log('[vault] abort by outpoint · matched=%d · aborted=%d', rows.length, aborted.size)
      return aborted.size
    } catch (e) {
      // A storage failure must not cost the retry: fall through to the scan.
      console.log('[vault] spending-reference lookup failed, falling back to scan:', (e as Error)?.message)
    }
  }

  const want = new Set(outpoints.map(sameOutpoint))
  return await abortActions(
    w,
    adminOriginator,
    a => (a.inputs ?? []).some(i => i.sourceOutpoint != null && want.has(sameOutpoint(i.sourceOutpoint))),
    // No count to stop at: one orphan can hold several of our outpoints, and
    // several orphans can each hold one. The 25-page cap is the bound.
    { includeInputs: true, stopAfter: Number.POSITIVE_INFINITY }
  )
}

/**
 * Free a vault UTXO that a previous failed attempt left reserved, so the caller
 * can retry once. Returns how many orphaned transactions were aborted — zero
 * means "not a reservation failure, or nothing could be freed", and the caller
 * must rethrow the original error rather than retry.
 *
 * `ours` bounds the damage: only a reservation on an outpoint THIS withdrawal
 * is trying to spend justifies aborting somebody else's transaction.
 */
async function freeReservedInputs(
  w: VaultWallet,
  adminOriginator: string,
  e: unknown,
  ours: string[],
  findSpendingReferences?: SpendingReferenceLookup
): Promise<number> {
  if (isReviewActionsError(e)) {
    return await abortReservingTxids(w, adminOriginator, competingTxids(e))
  }
  const mine = new Set(ours.map(sameOutpoint))
  const wedged = unspendableInputOutpoints(e).filter(o => mine.has(o))
  return await abortReservingOutpoints(w, adminOriginator, wedged, findSpendingReferences)
}

/**
 * Refuse a vault transfer while offline.
 *
 * Checked before anything else: before the deposit's backup attestation, and
 * before the withdrawal arms the YubiKey — an offline user must not be asked to
 * present a key for a transfer that cannot proceed.
 */
async function requireOnline(opts?: VaultTransferOptions): Promise<void> {
  if (!opts?.isOnline) return
  if (!(await opts.isOnline())) {
    throw new VaultError('requires-online', 'Vault transfers need a connection')
  }
}

// ── balance ─────────────────────────────────────────────────────────────

/**
 * Sum of the DECODABLE v4 outputs in the basket (spec §2.7). An output whose
 * record is missing or malformed cannot be spent by this code and is ignored
 * here, in selection, in coverage and in the zero-balance check for Disable —
 * so the number on the screen is what a YubiKey can actually open.
 * includeCustomInstructions is required: listOutputs omits the field unless
 * asked, and without it everything would read as undecodable.
 */
export async function getVaultBalance(w: VaultWallet, adminOriginator: string): Promise<number> {
  const res = await w.listOutputs({ basket: VAULT_BASKET, includeCustomInstructions: true, limit: 1000 }, adminOriginator)
  return res.outputs.reduce(
    (sum, o) => sum + (decodeVaultInstructions(o.customInstructions) ? (o.satoshis ?? 0) : 0),
    0
  )
}

// ── vault outputs ────────────────────────────────────────────────────────

/**
 * One new vault output committed to `keys` (spec §4.1 step 3, §2.7).
 *
 * Fresh 32-byte salt per output, so outputs are unlinkable until spent and a
 * spend reveals only its own. The key list is written into the output's
 * customInstructions in commitment order — informational (the lock is the
 * truth; the withdraw path re-checks it), but it is what lets balance,
 * selection and coverage work without parsing a 28 KB script. Used by the
 * deposit, the withdraw path's re-vaulted remainder, and the re-lock.
 */
function newVaultOutput(
  keys: readonly Pick<VaultKeyRecord, 'pubkey'>[],
  satoshis: number,
  outputDescription: string
): {
  satoshis: number
  lockingScript: string
  outputDescription: string
  basket: string
  customInstructions: string
  tags: string[]
} {
  const salt = Utils.toHex(randomBytes(SALT_BYTES))
  const pubkeys = keys.map(k => k.pubkey)
  const lockingScript = buildLock({ commitments: pubkeys.map(pk => commitment(pk, salt)) })
  return {
    satoshis,
    lockingScript: lockingScript.toHex(),
    outputDescription,
    basket: VAULT_BASKET,
    customInstructions: encodeVaultInstructions({ v: 4, type: 'R1C', salt, keys: pubkeys }),
    tags: ['vault']
  }
}

/** The release gate (spec D15 / §5.5), injectable so tests stay config-free.
 * Gates every path that CREATES a vault output; never a withdrawal of
 * pre-existing outputs. */
function requireReleased(opts: VaultTransferOptions | undefined, what: string): void {
  const enabled = opts?.vaultEnabled ?? isVaultEnabled
  if (!enabled()) throw new VaultError('not-released', `${what} is switched off in this build`)
}

/** The enrolled key list, or the refusal an output-creating operation owes. */
async function requireKeys(): Promise<VaultKeyRecord[]> {
  const meta = await vaultStore.getMeta()
  if (!meta) throw new VaultError('not-enrolled', 'Vault is not set up')
  if (meta.keys.length < VAULT_MIN_KEYS) {
    throw new VaultError('not-enough-keys', `A vault needs at least ${VAULT_MIN_KEYS} keys; ${meta.keys.length} enrolled`)
  }
  return meta.keys
}

// ── deposit ─────────────────────────────────────────────────────────────

/**
 * Move `satoshis` from the default basket into the vault (spec §4.1).
 *
 * No hardware: a deposit needs the key LIST, not a key. Every refusal is
 * checked BEFORE the one createAction below, cheapest first, and nothing is
 * spent until it runs — so a refusal costs nothing, and there is no deposit
 * index to burn any more (each output is self-describing via its salt).
 *
 * D13, the one gate that is not about the request itself: the salt that opens
 * this output will live ONLY in the wallet database. With backup push off, a
 * lost phone loses the vault however many YubiKeys survive.
 */
export async function depositToVault(
  w: VaultWallet,
  adminOriginator: string,
  satoshis: number,
  opts?: VaultTransferOptions
): Promise<{ txid: string }> {
  requireReleased(opts, 'Vault deposit')
  if (!Number.isInteger(satoshis) || satoshis < VAULT_DEPOSIT_MIN) {
    throw new VaultError('below-dust', `Vault deposits must be at least ${VAULT_DEPOSIT_MIN} satoshis`)
  }
  await requireOnline(opts)
  const backupEnabled = opts?.backupEnabled ?? isBackupPushEnabled
  if (!(await backupEnabled())) {
    throw new VaultError('backup-off', 'Turn wallet backup on before depositing')
  }
  const keys = await requireKeys()

  // One call builds, signs AND broadcasts: with no caller-supplied inputs
  // there is no signableTransaction step — every funding input is toolbox
  // change the toolbox signs itself. Undelayed, so a failed broadcast surfaces
  // here rather than leaving the deposit looking sent while it sits in the
  // monitor's queue. Default version (1): only spends of vault outputs need
  // version 2 (spec §2.6). The 'vault-deposit' label is load-bearing: the
  // patched toolbox (see patches/) suppresses UTXO-pool growth for it, so the
  // deposit stays minimal — at most one change output — instead of splitting
  // change toward numberOfDesiredUTXOs.
  const created = await w.createAction(
    {
      description: 'Move to vault',
      outputs: [newVaultOutput(keys, satoshis, 'Vault deposit')],
      labels: ['vault', 'vault-deposit'],
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
    },
    adminOriginator
  )
  const txid = created.txid ?? (created.tx ? Transaction.fromAtomicBEEF(created.tx).id('hex') : undefined)
  if (!txid) throw new VaultError('no-transaction', 'Deposit produced no transaction')
  return { txid }
}

// ── legacy staging reclaim ────────────────────────────────────────────────

export interface ReclaimResult {
  /** Absent when there was nothing to reclaim. */
  txid?: string
  /** How many staging outputs the reclaim spent. */
  reclaimed: number
  /** Their total value (the fee comes out of it; the rest returns as change). */
  satoshis: number
}

/**
 * Recover money the retired two-transaction deposit stranded.
 *
 * The old flow could leave a funded staging output behind (tx1 landed, tx2
 * failed — the 2026-08-22 device crash mid-deposit is exactly this shape),
 * and that money is INVISIBLE: the main balance counts only the 'default'
 * basket and the vault balance only 'admin vault', so a stranded coin shows
 * up in neither. Now that deposits no longer consume staging outputs, this
 * sweep is the only way that money comes back.
 *
 * Spends EVERY decodable staging output regardless of amount — unlike the old
 * deposit-time reuse, which matched by exact satoshis — with no outputs of its
 * own, so the toolbox returns the whole value (minus fee) as default-basket
 * change. The staging key is an ordinary BRC-42 wallet key (counterparty
 * 'self'), so no ceremony, no tap, no vault HD node is involved.
 *
 * Safe to call speculatively: returns {reclaimed: 0} without touching the
 * wallet when the basket is empty.
 */
export async function reclaimStagingOutputs(
  w: VaultWallet,
  adminOriginator: string,
  opts?: {
    /**
     * Storage-backed release of staging outputs stranded by a definitively
     * invalid spender. Returns how many outputs were made spendable again.
     *
     * Runs FIRST because a stranded coin usually sits spendable=0: when the
     * old tx2 failed, the toolbox restored its inputs but then re-stranded
     * them — markStaleInputsAsSpent asked the indexers whether the staging
     * outpoint was a UTXO seconds after tx1 broadcast, and indexer lag
     * answered "no" — and listOutputs only returns spendable coins. See
     * releaseVaultStagingStrandedByInvalidTx in StorageExpoSQLite for the
     * deliberately narrow predicate.
     */
    releaseStrandedStaging?: () => Promise<number>
    /** Storage-backed reservation heal for the retry below. See SpendingReferenceLookup. */
    findSpendingReferences?: SpendingReferenceLookup
  }
): Promise<ReclaimResult> {
  if (opts?.releaseStrandedStaging) {
    await opts.releaseStrandedStaging().catch(e => {
      console.log('[vault] stranded-staging release failed:', (e as Error)?.message)
      return 0
    })
  }

  const staged = (await w.listOutputs(
    { basket: VAULT_STAGING_BASKET, include: 'entire transactions', includeCustomInstructions: true, limit: 100 },
    adminOriginator
  )) as ListOutputsResult
  const coins = staged.outputs
    .map(o => ({ ...o, si: decodeStagingInstructions(o.customInstructions) }))
    .filter((o): o is typeof o & { si: StagingInstructions } => o.si != null)
  if (coins.length === 0) return { reclaimed: 0, satoshis: 0 }

  const totalSats = coins.reduce((s, c) => s + c.satoshis, 0)
  const caArgs = {
    description: 'Recover vault deposit funding',
    inputs: coins.map(c => ({
      outpoint: c.outpoint,
      unlockingScriptLength: STAGING_UNLOCK_LEN,
      inputDescription: 'Stranded vault deposit funding'
    })),
    outputs: [],
    // 'vault-deposit' is load-bearing twice: the patched toolbox suppresses
    // UTXO-pool growth for it (no extra funding inputs pulled in), and the
    // stranded-release predicates (both arms — spendable=0 re-strands AND
    // stale spentBy on spendable=1 coins, see findSql.ts) match on it — so if
    // THIS transaction fails at broadcast and re-strands the coins, the same
    // heal releases them for the next attempt. 'vault-reclaim' is for
    // history and forensics only.
    labels: ['vault', 'vault-deposit', 'vault-reclaim'],
    // Mandatory, not an optimization: these inputs carry unlockingScriptLength
    // and no unlockingScript, so isSignAction is true and the signer resolves
    // each input's sourceTransaction ONLY from args.inputBEEF. trustSelf just
    // skips storage re-walking proof ancestry for our own coins.
    inputBEEF: staged.BEEF?.length ? staged.BEEF : undefined,
    options: { randomizeOutputs: false, acceptDelayedBroadcast: false, trustSelf: 'known' }
  }
  let created: CreateActionResult
  try {
    created = await w.createAction(caArgs, adminOriginator)
  } catch (e) {
    // A prior failed attempt (or a concurrent reclaim from a quick screen
    // remount) can leave a coin reserved by an orphaned transaction, and until
    // that is aborted every later reclaim is refused outright — the same
    // wedge the withdraw path heals. Abort it and retry ONCE; anything else
    // frees nothing and rethrows untouched.
    const freed = await freeReservedInputs(
      w,
      adminOriginator,
      e,
      coins.map(c => c.outpoint),
      opts?.findSpendingReferences
    )
    if (freed === 0) throw e
    created = await w.createAction(caArgs, adminOriginator)
  }

  if (!created.signableTransaction) {
    const txid = created.txid ?? (created.tx ? Transaction.fromAtomicBEEF(created.tx).id('hex') : undefined)
    if (!txid) throw new VaultError('no-transaction', 'Reclaim produced no transaction')
    return { txid, reclaimed: coins.length, satoshis: totalSats }
  }

  const { tx: atomic, reference } = created.signableTransaction
  const spends: Record<number, { unlockingScript: string }> = {}
  try {
    const tx = Transaction.fromAtomicBEEF(atomic)
    for (const c of coins) {
      // Preimage formatting is O(tx size) per input; yield between inputs so a
      // large reclaim cannot hang the JS thread (same reasoning as the
      // withdraw signing loop below).
      await new Promise<void>(resolve => setTimeout(resolve, 0))

      // The toolbox is free to add funding inputs of its own, so each staging
      // input is located by outpoint, never assumed by position — and the
      // signature commits to EVERY input via otherInputs, or the nodes reject
      // the spend with "false stack entry at end of script execution" (the
      // 2026-08-21 production deposit failure).
      const [cTxid, cVoutStr] = c.outpoint.split('.')
      const cVout = Number(cVoutStr)
      const inputIndex = tx.inputs.findIndex(
        i =>
          (i.sourceTXID ?? i.sourceTransaction?.id('hex'))?.toLowerCase() === cTxid.toLowerCase() &&
          i.sourceOutputIndex === cVout
      )
      if (inputIndex < 0) {
        throw new VaultError('no-transaction', 'Staging input missing from the signable transaction')
      }
      const { publicKey: stagingPub } = await w.getPublicKey(
        { protocolID: STAGING_PROTOCOL, keyID: c.si.keyID, counterparty: 'self' },
        adminOriginator
      )
      const subscript = new P2PKH().lock(PublicKey.fromString(stagingPub).toAddress())
      const input = tx.inputs[inputIndex]
      const scope = TransactionSignature.SIGHASH_ALL | TransactionSignature.SIGHASH_FORKID
      const preimage = TransactionSignature.format({
        sourceTXID: cTxid,
        sourceOutputIndex: input.sourceOutputIndex,
        sourceSatoshis: c.satoshis,
        transactionVersion: tx.version,
        otherInputs: tx.inputs.filter((_, i) => i !== inputIndex),
        outputs: tx.outputs,
        inputIndex,
        inputSequence: input.sequence ?? 0xffffffff,
        subscript,
        lockTime: tx.lockTime,
        scope
      })
      const { signature } = await w.createSignature(
        {
          protocolID: STAGING_PROTOCOL,
          keyID: c.si.keyID,
          counterparty: 'self',
          hashToDirectlySign: Array.from(Hash.hash256(preimage))
        },
        adminOriginator
      )
      spends[inputIndex] = {
        unlockingScript: new UnlockingScript([
          { op: signature.length + 1, data: [...signature, scope] },
          { op: 33, data: Utils.toArray(stagingPub, 'hex') }
        ]).toHex()
      }
    }
  } catch (e) {
    // Nothing was signed: release the reservation so the coins stay listed
    // for the next reclaim attempt.
    await w.abortAction({ reference }, adminOriginator).catch(() => {})
    throw e
  }

  const signed = await w.signAction(
    { reference, spends, options: { acceptDelayedBroadcast: false } },
    adminOriginator
  )
  const txid = signed.txid ?? (signed.tx ? Transaction.fromAtomicBEEF(signed.tx).id('hex') : undefined)
  if (!txid) throw new VaultError('no-transaction', 'Reclaim produced no transaction')
  return { txid, reclaimed: coins.length, satoshis: totalSats }
}

// ── withdraw / re-lock: selection (spec §4.2 steps 2–3) ───────────────────

/** How many times the signable transaction may be re-created to dodge a
 * pushTxDerCheck hit (spec D4b) before giving up. Each re-creation bumps the
 * offending input's sequence number, which changes every preimage. */
const PUSH_TX_RETRY_MAX = 8

/** One vault output the chosen key can open, with its real lock in hand. */
interface SelectedVaultOutput {
  outpoint: string
  satoshis: number
  ci: VaultInstructionsV4
  /** The output's REAL locking script, read from the listed BEEF. */
  lockingScript: LockingScript
}

interface VaultSelection {
  /** The CURRENT key list (meta.keys) — what a re-vault or re-lock commits to. */
  keys: VaultKeyRecord[]
  chosen: VaultKeyRecord
  /** Largest first, capped, every one proven committed to `chosen`. */
  selected: SelectedVaultOutput[]
  /** Sum of `selected`. */
  acc: number
  cappedInputs: number
  unreachable: VaultSpendResult['unreachable']
  beef?: number[]
}

/**
 * list → decode v4 → filter to the chosen key → sort largest first → cap →
 * prove each selected output's REAL lock commits to the chosen key → amount
 * checks. Nothing is reserved, tapped or signed here, so every refusal is free.
 *
 * `include: 'entire transactions'` IS required, twice over. Structurally:
 * every input carries unlockingScriptLength but no unlockingScript, so
 * @bsv/sdk's validateCreateActionArgs sets isSignAction=true and
 * buildSignableTransaction resolves each input's sourceTransaction ONLY from
 * args.inputBEEF (buildSignableTransaction.js:14,101) — omit it and
 * createAction.js's makeSignableTransactionBeef throws WERR_INTERNAL before
 * signing starts. And for the commitment check: the BEEF is where each
 * output's REAL lock comes from — customInstructions are never trusted over
 * it (a record can claim any key list; only the lock says who can spend).
 * `include` is one-of, so this call cannot also ask for 'locking scripts'.
 * includeCustomInstructions is required too: listOutputs omits the field
 * unless asked, and without it every output decodes as null.
 */
async function selectVaultInputs(
  w: VaultWallet,
  adminOriginator: string,
  chosenSerial: string,
  amount: number | 'all'
): Promise<VaultSelection> {
  const meta = await vaultStore.getMeta()
  if (!meta) throw new VaultError('not-enrolled', 'Vault is not set up')
  const chosen = meta.keys.find(k => k.serial === chosenSerial)
  if (!chosen) throw new VaultError('not-enrolled', `Key ${chosenSerial} is not one of this vault's keys`)

  // Hand the JS thread back once so React can paint before the bridge and
  // database work below; the listOutputs payload is up to ~900 KB of BEEF.
  await new Promise<void>(resolve => setTimeout(resolve, 0))
  const list = await w.listOutputs(
    { basket: VAULT_BASKET, include: 'entire transactions', includeCustomInstructions: true, limit: 1000 },
    adminOriginator
  )
  const decodable = list.outputs
    .map(o => ({ outpoint: o.outpoint, satoshis: o.satoshis, ci: decodeVaultInstructions(o.customInstructions) }))
    .filter((o): o is typeof o & { ci: VaultInstructionsV4 } => o.ci != null)
  if (decodable.length === 0) throw new VaultError('vault-empty', 'Vault is empty')

  const total = decodable.reduce((s, o) => s + o.satoshis, 0)
  const mine = decodable.filter(o => o.ci.keys.includes(chosen.pubkey)).sort((a, b) => b.satoshis - a.satoshis)
  const others = decodable.filter(o => !o.ci.keys.includes(chosen.pubkey))
  const otherPubkeys = [...new Set(others.flatMap(o => o.ci.keys))]
  const unreachable: VaultSpendResult['unreachable'] = {
    count: others.length,
    satoshis: others.reduce((s, o) => s + o.satoshis, 0),
    keys: otherPubkeys.map(pubkey => ({ serial: meta.keys.find(k => k.pubkey === pubkey)?.serial, pubkey }))
  }
  if (mine.length === 0) {
    throw new VaultError('key-not-committed', `Key ${chosen.serial} is not committed to any vault output`)
  }
  const reachable = mine.reduce((s, o) => s + o.satoshis, 0)

  // Bounded input count — see VAULT_MAX_INPUTS. Largest first (already
  // sorted), so the fewest inputs cover the most value.
  const cap = Math.min(VAULT_MAX_INPUTS, VAULT_HARD_MAX_INPUTS)
  const capped = mine.slice(0, cap)
  const cappedInputs = mine.length - capped.length

  // THE COMMITMENT CHECK, against the script the output is ACTUALLY locked
  // with — never a lock rebuilt from the output's own record, which is
  // self-consistent by construction. Runs before anything is reserved, so a
  // lying record costs nothing to refuse.
  const sources = list.BEEF?.length ? Beef.fromBinary(list.BEEF) : undefined
  const selected: SelectedVaultOutput[] = capped.map(o => {
    const [txid, voutStr] = o.outpoint.split('.')
    // Beef indexes by exact txid string; storage writes lowercase, but so does
    // every other txid comparison in this file — match them rather than trust it.
    const lockingScript = sources?.findTxid(txid.toLowerCase())?.tx?.outputs[Number(voutStr)]?.lockingScript
    if (!lockingScript) {
      // Fail closed rather than sign blind — and createAction would refuse
      // this input moments later anyway (see the listOutputs comment).
      throw new VaultError('no-transaction', `No source transaction for vault output ${o.outpoint}`)
    }
    let baked: string[]
    try {
      baked = bakedCommitments(lockingScript)
    } catch (e) {
      if (e instanceof VaultError && e.code === 'template-invalid') {
        throw new VaultError('key-not-committed', `Vault output ${o.outpoint} is not an R1C lock`)
      }
      throw e
    }
    if (!baked.includes(commitment(chosen.pubkey, o.ci.salt))) {
      throw new VaultError('key-not-committed', `Vault output ${o.outpoint} is not committed to key ${chosen.serial}`)
    }
    return { outpoint: o.outpoint, satoshis: o.satoshis, ci: o.ci, lockingScript }
  })
  const acc = selected.reduce((s, o) => s + o.satoshis, 0)

  if (amount !== 'all') {
    if (amount > total) throw new VaultError('amount-exceeds-balance', 'Withdrawal exceeds vault balance')
    if (amount > reachable && reachable < total) {
      // Another key could open more: say which, rather than blaming the balance.
      throw new VaultError(
        'key-cannot-cover',
        `Key ${chosen.serial} can open ${reachable} of the ${total} satoshis in the vault`,
        undefined,
        { reachable, total }
      )
    }
    if (amount > acc) {
      // The key holds enough (checked above) but not within the input cap. The
      // remedy is a smaller withdrawal, which also consolidates.
      throw new VaultError(
        'too-many-inputs',
        `Withdrawing ${amount} satoshis would need more than ${cap} vault inputs; withdraw a smaller amount first`
      )
    }
  }
  return { keys: meta.keys, chosen, selected, acc, cappedInputs, unreachable, beef: list.BEEF }
}

// ── withdraw / re-lock: build, sign on the card, verify, finalise ─────────

/** What a spend adds to the transaction beyond its vault inputs. */
interface VaultSpendPlan {
  outputs: ReturnType<typeof newVaultOutput>[]
  labels: string[]
  inputDescription: string
}

interface PreparedInput {
  /** Position in the signable transaction — located by outpoint, never assumed. */
  inputIndex: number
  preimage: number[]
}

/** A reserved, parsed, D4b-clean signable transaction awaiting the card. This
 * is the ONLY shape createSignableVaultTx returns: a vault spend that came back
 * already signed is an invariant violation, and it throws (see below). */
interface SignableBuild {
  tx: Transaction
  reference: string
  prepared: PreparedInput[]
}

/**
 * createAction with `version: 2` (spec §2.6), then the two checks that must
 * pass before the FIRST card signature: the parsed signable transaction is
 * version 2 (`bad-version`), and every input's preimage passes pushTxDerCheck
 * (D4b). A D4b hit aborts the reservation and re-creates the action with that
 * input's `sequenceNumber` bumped — the toolbox default is 0xffffffff, so
 * "bumped" means decremented; lockTime is 0, so any value is final — which
 * changes every preimage. Bounded by PUSH_TX_RETRY_MAX.
 *
 * The freeReservedInputs retry-once around createAction is unchanged: a prior
 * failed attempt can leave a vault UTXO reserved by an orphaned transaction,
 * in either of the two error shapes freeReservedInputs recognises.
 */
async function createSignableVaultTx(
  w: VaultWallet,
  adminOriginator: string,
  sel: VaultSelection,
  reason: string,
  plan: VaultSpendPlan,
  opts?: VaultTransferOptions
): Promise<SignableBuild> {
  const outpoints = sel.selected.map(o => o.outpoint)
  /** outpoint → sequenceNumber override, set by a pushTxDerCheck hit. */
  const sequences = new Map<string, number>()

  for (let attempt = 1; ; attempt++) {
    const caArgs = {
      description: reason,
      version: 2,
      inputs: sel.selected.map(o => ({
        outpoint: o.outpoint,
        unlockingScriptLength: R1C_UNLOCK_LEN,
        inputDescription: plan.inputDescription,
        ...(sequences.has(o.outpoint) ? { sequenceNumber: sequences.get(o.outpoint) } : {})
      })),
      outputs: plan.outputs,
      labels: plan.labels,
      // From the 'entire transactions' listOutputs call — required, not
      // optional (see selectVaultInputs). trustSelf: 'known' lets storage skip
      // re-walking each source transaction's own merkle-proof ancestry for a
      // basket this wallet already trusts; it does not replace inputBEEF.
      inputBEEF: sel.beef?.length ? sel.beef : undefined,
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false, trustSelf: 'known' }
    }

    let created: CreateActionResult
    try {
      created = await w.createAction(caArgs, adminOriginator)
    } catch (e) {
      const freed = await freeReservedInputs(w, adminOriginator, e, outpoints, opts?.findSpendingReferences)
      if (freed === 0) throw e
      created = await w.createAction(caArgs, adminOriginator)
    }

    if (!created.signableTransaction) {
      // Inputs carrying unlockingScriptLength always come back signable. If the
      // toolbox ever handed back a finished transaction here it would have
      // spent R1C outputs WITHOUT our unlocks — never a success to report, so
      // this fails closed. A non-signable result carries no reference (the
      // toolbox has already finalised whatever it built), so there is nothing
      // reservable left to abort; refusing is the whole remedy.
      if (created.txid || created.tx) {
        throw new VaultError('no-transaction', 'createAction returned a signed transaction for vault inputs; refusing')
      }
      throw new VaultError('no-transaction', 'Vault spend produced no transaction')
    }

    const { reference } = created.signableTransaction
    try {
      const tx = Transaction.fromAtomicBEEF(created.signableTransaction.tx)
      if (tx.version !== 2) {
        throw new VaultError('bad-version', `Signable transaction is version ${tx.version}; expected 2`)
      }
      const prepared: PreparedInput[] = sel.selected.map(o => {
        const [txid, voutStr] = o.outpoint.split('.')
        const vout = Number(voutStr)
        // The toolbox is free to add funding inputs of its own, so each vault
        // input is located by outpoint, never assumed by position.
        const inputIndex = tx.inputs.findIndex(
          i =>
            (i.sourceTXID ?? i.sourceTransaction?.id('hex'))?.toLowerCase() === txid.toLowerCase() &&
            i.sourceOutputIndex === vout
        )
        if (inputIndex < 0) {
          throw new VaultError('no-transaction', `Vault input ${o.outpoint} missing from the signable transaction`)
        }
        return { inputIndex, preimage: sighashPreimage(tx, inputIndex, o.satoshis) }
      })

      const badAt = prepared.findIndex(p => !pushTxDerCheck(p.preimage).ok)
      if (badAt < 0) return { tx, reference, prepared }
      if (attempt >= PUSH_TX_RETRY_MAX) {
        throw new VaultError(
          'no-transaction',
          `Could not build a signable vault transaction in ${PUSH_TX_RETRY_MAX} attempts`
        )
      }
      const bad = sel.selected[badAt]
      const current = sequences.get(bad.outpoint) ?? (tx.inputs[prepared[badAt].inputIndex].sequence ?? 0xffffffff)
      sequences.set(bad.outpoint, current - 1)
    } catch (e) {
      await w.abortAction({ reference }, adminOriginator).catch(() => {})
      throw e
    }
    // D4b hit: this reservation is worthless — release it and rebuild with the
    // bumped sequence.
    await w.abortAction({ reference }, adminOriginator).catch(() => {})
  }
}

/**
 * Spec §4.2 steps 5–8, shared by withdrawFromVault and relockVault.
 *
 * ORDER, and why: build + screen (no card) → tap (requestVaultSigner) → sign
 * every input SEQUENTIALLY → release the signer → verify every unlock locally
 * with the strict flags → signAction. Verification runs after release so the
 * NFC sheet is down while the interpreter works; anything failing before
 * signAction aborts the reservation; nothing after it does.
 *
 * SEQUENTIAL BY DESIGN — do not "simplify" this into an
 * unlockingScriptTemplate + tx.sign(). @bsv/sdk's Transaction.sign() fans
 * every template's sign() out through Promise.all and takes ownership of the
 * whole input set; this loop keeps each input's script ours to build, in a
 * known order, one card round trip at a time (the card signs one digest per
 * command). The yield before each signature keeps the JS thread responsive
 * for the sheet.
 */
async function spendVaultOutputs(
  w: VaultWallet,
  adminOriginator: string,
  sel: VaultSelection,
  reason: string,
  plan: VaultSpendPlan,
  opts?: VaultTransferOptions
): Promise<VaultSpendResult> {
  const { tx, reference, prepared } = await createSignableVaultTx(w, adminOriginator, sel, reason, plan, opts)
  const result = (txid: string): VaultSpendResult => ({ txid, cappedInputs: sel.cappedInputs, unreachable: sel.unreachable })
  const { chosen, selected } = sel
  const total = selected.length

  const unlocks: { inputIndex: number; unlockingScript: UnlockingScript }[] = []
  try {
    // ── the tap(s): one on-card signature per input ────────────────────
    const signer = await requestVaultSigner(reason, chosen.serial)
    // The commitment check above ran against chosen.pubkey, but every unlock
    // is built with signer.pubkey — they must be the same key, or the card
    // would sign for a lock it cannot open (a stale slot, or a ceremony that
    // failed to enforce the serial). Release first: the signing loop's own
    // finally has not been entered yet.
    if (signer.pubkey !== chosen.pubkey) {
      signer.release()
      throw new VaultError(
        'serial-mismatch',
        'Signer public key does not match the chosen key',
        undefined,
        { tapped: signer.serial, chosen: chosen.serial }
      )
    }
    try {
      for (let i = 0; i < total; i++) {
        await new Promise<void>(resolve => setTimeout(resolve, 0))
        noteVaultProgress({ phase: 'preparing', signed: i, total })
        const { inputIndex, preimage } = prepared[i]
        const der = await signer.sign(signerDigest(preimage), { index: i, total })
        // buildUnlock throws template-invalid if fullR is the point at
        // infinity — a 2^-256 event; it unwinds through the abort below.
        unlocks.push({
          inputIndex,
          unlockingScript: buildUnlock({ preimage, derSig: der, pubkeyHex33: signer.pubkey, saltHex64: selected[i].ci.salt })
        })
      }
    } finally {
      // Dismisses the NFC sheet and drops the PIN whether or not every input
      // was signed; the local verification below needs no card.
      signer.release()
    }

    // ── strict local Spend per input (spec §4.2 step 7) ────────────────
    // Honest unlocks are minimal, so MINIMALDATA on is strictly stronger than
    // the node's version-2 rules: anything that passes here is accepted there.
    for (let i = 0; i < total; i++) {
      verifyVaultInput({
        tx,
        inputIndex: unlocks[i].inputIndex,
        sourceSatoshis: selected[i].satoshis,
        lockingScript: selected[i].lockingScript,
        unlockingScript: unlocks[i].unlockingScript
      })
    }
  } catch (e) {
    // Nothing reached signAction, so the reservation is worthless — release
    // it, or the vault UTXO stays spendable=false and the next attempt is
    // refused outright.
    await w.abortAction({ reference }, adminOriginator).catch(() => {})
    throw e
  }

  const spends: Record<number, { unlockingScript: string }> = {}
  for (const u of unlocks) spends[u.inputIndex] = { unlockingScript: u.unlockingScript.toHex() }

  // PAST THE POINT OF NO ABORT.
  //
  // acceptDelayedBroadcast: true hands the signed transaction to storage and
  // lets the monitor's SendWaiting task carry it to the network. A slow or
  // timing-out broadcaster therefore cannot cost the user a signed
  // transaction, and this call no longer waits on the network before the UI
  // can move on.
  //
  // Deliberately OUTSIDE the try above: once a transaction is signed, aborting
  // it is the dangerous move, not the safe one — the network may already have
  // accepted it, and abandoning it locally would leave the wallet blind to
  // funds that really moved. A failure here is reported as "we will try
  // again", never as a cancellation.
  //
  // The broadcasting note is inert once the signer is released (noteProgress
  // ignores notes with nothing armed); the transfer screen shows its own
  // spinner. Kept so the phase sequence reads complete.
  noteVaultProgress({ phase: 'broadcasting' })
  const signed = await w.signAction({ reference, spends, options: { acceptDelayedBroadcast: true } }, adminOriginator)
  const txid = signed.txid ?? (signed.tx ? Transaction.fromAtomicBEEF(signed.tx).id('hex') : undefined)
  if (!txid) throw new VaultError('no-transaction', 'Vault spend produced no transaction')
  await vaultStore.noteLastUsed(chosen.serial)
  return result(txid)
}

// ── withdraw ────────────────────────────────────────────────────────────

/**
 * Withdraw from the vault with the CHOSEN key (spec §4.2).
 *
 * `amount: 'all'` means "as much as one transaction can carry of what this
 * key can open": the untouched outputs stay in the vault and are reported as
 * `cappedInputs` (repeat to move them); outputs other keys own are reported as
 * `unreachable` (repeat with one of those keys). A remainder ≥ VAULT_DEPOSIT_MIN
 * is re-vaulted as one output committed to the CURRENT key set (so a partial
 * withdrawal also brings old deposits up to date with the key list); a smaller
 * one is folded into the withdrawal as toolbox change.
 */
export async function withdrawFromVault(
  w: VaultWallet,
  adminOriginator: string,
  amount: number | 'all',
  reason: string,
  chosenSerial: string,
  opts?: VaultTransferOptions
): Promise<VaultSpendResult> {
  // Cheapest refusal first, as in depositToVault. Every amount comparison in
  // selectVaultInputs is `amount > x`, which is false for NaN, 0 and negatives:
  // unguarded, NaN would withdraw everything the key can open, a negative
  // would fund a re-vault output LARGER than the inputs from the hot wallet
  // (bypassing the deposit gates), 0 would pay a fee to re-lock everything.
  if (amount !== 'all' && (!Number.isInteger(amount) || amount <= 0)) {
    throw new VaultError('below-dust', 'Withdrawal amount must be a positive integer number of satoshis')
  }
  // An offline user is never asked to present a key for a transfer that
  // cannot proceed.
  await requireOnline(opts)
  const sel = await selectVaultInputs(w, adminOriginator, chosenSerial, amount)
  const want = amount === 'all' ? sel.acc : amount
  const remainder = sel.acc - want
  const outputs: VaultSpendPlan['outputs'] = []
  if (remainder >= VAULT_DEPOSIT_MIN) {
    // Re-vaulting CREATES a vault output, which the release flag gates (spec
    // §5.5). Withdrawing pre-existing outputs — 'all' — never is.
    requireReleased(opts, 'Re-vaulting a remainder')
    outputs.push(newVaultOutput(sel.keys, remainder, 'Vault change'))
  }
  return spendVaultOutputs(
    w,
    adminOriginator,
    sel,
    reason,
    { outputs, labels: ['vault', 'vault-withdraw'], inputDescription: 'Vault withdrawal' },
    opts
  )
}

// ── re-lock (spec §4.3) ──────────────────────────────────────────────────

/**
 * Fee reserve for a re-lock, in the toolbox's own arithmetic (100 sat/kB,
 * rounded up per kB) plus 10 %.
 *
 *   size = 10 + inputCount·(41 + 3 + R1C_UNLOCK_LEN) + (3 + lockLen + 8)
 *
 * — version/locktime/counts (10); per input the outpoint + sequence (41), a
 * 3-byte script-length prefix and the DECLARED unlock length; one output: an
 * 8-byte value, a 3-byte prefix and the new lock. The +10 % is computed in
 * integers (`ceil(kb·satPerKb·11 / 10)`): `11200 * 1.1` is
 * `12320.000000000002` in doubles, and a float ceil would over-charge by one.
 *
 * The re-lock output is `acc − this`; the toolbox's real fee is at most this
 * and the surplus becomes ordinary default-basket change (folded into the fee
 * when below dust). ≈ 2,900 sat per pass plus ≈ 260 sat per input.
 */
export function estimateRelockFee(inputCount: number, lockLen: number, satPerKb = 100): number {
  const size = 10 + inputCount * (41 + 3 + R1C_UNLOCK_LEN) + (3 + lockLen + 8)
  const kb = Math.ceil(size / 1000)
  return Math.ceil((kb * satPerKb * 11) / 10)
}

/**
 * Re-lock the vault with the chosen key (spec §4.3): a distinct spend mode,
 * NOT withdrawFromVault('all') — whose remainder is zero and would sweep the
 * vault into the hot wallet. Selects exactly as a withdrawal of 'all' does
 * (filter → sort → cap → commitment check), then creates ONE output of
 * `acc − estimateRelockFee(...)` committed to the CURRENT key set, and no
 * withdrawal output. This is how a key added later gains access to old
 * deposits and how a removed key loses it — on-chain the removed key can still
 * spend the outputs it was committed to, so the re-lock IS the revocation.
 *
 * The screen runs one pass per tap while `cappedInputs > 0`, and asks for
 * another key when only `unreachable` outputs remain.
 */
export async function relockVault(
  w: VaultWallet,
  adminOriginator: string,
  reason: string,
  chosenSerial: string,
  opts?: VaultTransferOptions
): Promise<VaultSpendResult> {
  requireReleased(opts, 'Re-locking the vault')
  await requireOnline(opts)
  const sel = await selectVaultInputs(w, adminOriginator, chosenSerial, 'all')
  if (sel.keys.length < VAULT_MIN_KEYS) {
    throw new VaultError('not-enough-keys', `A vault needs at least ${VAULT_MIN_KEYS} keys; ${sel.keys.length} enrolled`)
  }
  const fee = estimateRelockFee(sel.selected.length, R1C_LOCK_LEN(sel.keys.length))
  const relocked = sel.acc - fee
  if (relocked < VAULT_DEPOSIT_MIN) {
    throw new VaultError(
      'too-small-to-relock',
      `Re-locking ${sel.acc} satoshis would leave ${relocked} after fees, below the ${VAULT_DEPOSIT_MIN} floor`
    )
  }
  return spendVaultOutputs(
    w,
    adminOriginator,
    sel,
    reason,
    {
      outputs: [newVaultOutput(sel.keys, relocked, 'Vault re-lock')],
      labels: ['vault', 'vault-relock'],
      inputDescription: 'Vault re-lock'
    },
    opts
  )
}

// ── coverage (spec §3.4 badges) ──────────────────────────────────────────

/**
 * How the vault's outputs relate to the CURRENT key list, from each output's
 * v4 record (the informational key list — good enough for a badge; the
 * withdraw path checks the real lock). `stale` counts outputs whose set
 * differs in EITHER direction; `missingKeys` are the current pubkeys some
 * output lacks ("{{count}} deposits not yet open to {{nickname}}");
 * `removedKeyOutputs` are outputs a pubkey no longer in meta can still open
 * ("still open to a removed key"). Undecodable outputs are ignored, as
 * everywhere.
 */
export async function getVaultKeyCoverage(w: VaultWallet, adminOriginator: string): Promise<VaultKeyCoverage> {
  const meta = await vaultStore.getMeta()
  const current = meta?.keys.map(k => k.pubkey) ?? []
  const currentSet = new Set(current)
  const res = await w.listOutputs({ basket: VAULT_BASKET, includeCustomInstructions: true, limit: 1000 }, adminOriginator)
  const records = res.outputs
    .map(o => decodeVaultInstructions(o.customInstructions))
    .filter((ci): ci is VaultInstructionsV4 => ci != null)

  let stale = 0
  let removedKeyOutputs = 0
  const missing = new Set<string>()
  for (const ci of records) {
    const set = new Set(ci.keys)
    const same = set.size === currentSet.size && current.every(pk => set.has(pk))
    if (!same) stale++
    for (const pk of current) if (!set.has(pk)) missing.add(pk)
    if (ci.keys.some(pk => !currentSet.has(pk))) removedKeyOutputs++
  }
  return {
    outputs: records.length,
    stale,
    missingKeys: current.filter(pk => missing.has(pk)), // meta order, each once
    removedKeyOutputs
  }
}

/**
 * How many vault outputs would lose every remaining committed key if `pubkey`
 * were removed (spec §3.4) — the exact predicate Remove must satisfy: an
 * output stays spendable after removal only if its baked key set (the
 * informational v4 record — good enough here, as in getVaultKeyCoverage; the
 * withdraw path checks the real lock) intersects the CURRENT key list minus
 * the one being removed. Reads the same listOutputs as getVaultKeyCoverage;
 * undecodable outputs are ignored, as everywhere.
 */
export async function orphanedIfRemoved(w: VaultWallet, adminOriginator: string, pubkey: string): Promise<number> {
  const meta = await vaultStore.getMeta()
  const remaining = new Set((meta?.keys.map(k => k.pubkey) ?? []).filter(pk => pk !== pubkey))
  const res = await w.listOutputs({ basket: VAULT_BASKET, includeCustomInstructions: true, limit: 1000 }, adminOriginator)
  const records = res.outputs
    .map(o => decodeVaultInstructions(o.customInstructions))
    .filter((ci): ci is VaultInstructionsV4 => ci != null)
  return records.filter(ci => !ci.keys.some(pk => remaining.has(pk))).length
}
