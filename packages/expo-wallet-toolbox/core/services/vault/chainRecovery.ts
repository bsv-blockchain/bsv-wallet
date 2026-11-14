/**
 * Chain recovery — clean-device discovery of v7 Vault outputs (spec v7 §1.2
 * item 3; ledger rows INT-01, INT-06, XQ-012, and the backup-independence
 * half of XR-005/INT-02).
 *
 * A v7 vault output publishes its own recoverable index on-chain: a marker
 * (a 1-sat P2PKH output to `wallet.getPublicKey([2,'vault marker'], keyID
 * "${chain}:${k}", counterparty 'self')`, an ordinary indexer can answer)
 * and an encrypted descriptor (a 0-sat `OP_FALSE OP_RETURN 'r1c7' <ciphertext>`
 * output carrying the exact v7 recovery record). Neither the local SQLite
 * database, SecureStore, nor any backup service is needed to find or
 * authenticate a v7 output — only the wallet root (the mnemonic), a chain
 * lookup, and — to actually SPEND it — one physically-present enrolled
 * YubiKey, through the unchanged withdraw path. The YubiKey is NOT needed to
 * restore.
 *
 * SCOPE (deliberate, disclosed — design v7 §1.3 "rejected: rebuilding
 * zero-conf ancestor BEEF assembly"): recovery claims CONFIRMED deposits.
 * internalizeAction's own SPV gate (@bsv/sdk Beef.verify with
 * allowTxidOnly=false) requires either a BUMP or a present raw-input chain
 * back to one; teaching this module to assemble an arbitrary-depth
 * unconfirmed ancestor chain from a public indexer is real, open-ended
 * complexity for a narrow confirmation-window edge case that isn't required
 * by I1's core promise (survive phone loss of a SETTLED deposit). A marker
 * whose transaction the injected lookup reports as not-yet-confirmed is
 * reported back as `pendingConfirmation`, never thrown and never silently
 * dropped, and does not consume a gap-scan slot.
 *
 * KEY FILTER: every setup of the same YubiKeys writes fresh PIV keys (and a
 * new vaultId), yet its deposits still authenticate here — the marker and
 * descriptor derive from the wallet root, not the keys. So a scan also finds
 * deposits from earlier setups that nothing the owner still holds can open.
 * Only candidates sharing a key with the live set are internalized: this
 * device's authenticated key list when it has one, otherwise every key of the
 * newest setup the scan found (latest createdAt). The rest are counted as
 * `unreachable`, never inserted.
 */
import { Transaction } from '@bsv/sdk'
import {
  buildLock,
  commitment,
  decodeVaultInstructionsV7,
  encodeVaultInstructionsV7,
  type VaultInstructionKey,
  type VaultInstructionsV7,
  type VaultSaltChain
} from './r1comb'
import { VaultError } from './types'
import { vaultStore } from './vaultStore'
import { verifyVaultMetaAuthorityTag, type HmacCapableWallet } from './metaAuthority'
import {
  VAULT_BASKET,
  liveVaultPubkeys,
  opensWithAny,
  deriveVaultMarkerScript,
  deriveVaultSalt,
  decryptVaultDescriptorPlaintext,
  parseVaultDescriptorScript,
  listVaultBasketOutpoints,
  recoverVaultMetaFromOutputs,
  vaultChainKeyId,
  type VaultWallet
} from './transfers'
import {
  VAULT_SCAN_MIN_SATS,
  lookupMarker,
  noteSaltFloor,
  type MarkerHistory,
  type VaultChainLookup
} from './markerLookup'
import { p2pkhAddressFromScript } from './wocLookup'

/** Default, caller-raisable gap: consecutive indices with NO marker history
 * (a found-but-unusable record does not count — see below) before the scan
 * stops. */
export const VAULT_RECOVERY_GAP_DEFAULT = 20

/**
 * Hard ceiling on CONSECUTIVE marker-derivation/lookup failures within a
 * single scan — distinct from `consecutiveMisses`, which only ever counts
 * genuine no-history results. A wallet-layer failure (cannot derive our own
 * marker key) or a lookup-layer failure (the injected VaultChainLookup
 * threw) is not evidence of "no marker" — same reasoning as the
 * found-but-unusable contract below — but it also cannot be scanned past
 * indefinitely: without this bound, a lookup that keeps throwing (a
 * persistent outage, or a bug) spins `recoverVaultFromChain`'s `while` loop
 * forever, because neither failure ever touches `consecutiveMisses`. This is
 * a real, empirically-reproduced livelock, not a theoretical one: a tight
 * recursive async loop with no genuine timer/I/O yield drains the microtask
 * queue ahead of any macrotask, which starves even a `setTimeout`-based
 * test/command timeout. Not caller-tunable — this is a safety net, not a
 * recovery parameter. */
export const VAULT_RECOVERY_MAX_CONSECUTIVE_PROBLEMS = 20

export type { VaultChainLookup } from './markerLookup'

export interface VaultChainRecoveryProblem {
  /** The scan index (saltKeyId) this problem was found at. */
  index: number
  reason: string
  /** Base58 marker address of the index, set when known, so a person can look
   * it up in a block explorer. */
  markerAddress?: string
}

/** What one scan run found. `found`, `unreachable`, `pendingConfirmation`,
 * `problems` and `scanned` keep the meaning they always had. */
export interface VaultScanResult {
  /** Outputs newly internalized by this run. */
  found: number
  /** Authenticated, unspent, and no live key opens them (an earlier setup's)
   * — skipped rather than inserted. See this file's KEY FILTER note. */
  unreachable: number
  /** A valid, unspent v7 record the lookup could not yet show as confirmed —
   * the honest zero-conf scope cut (this file's docstring). Not a miss and not
   * a problem. */
  pendingConfirmation: number
  /** Valid candidates under VAULT_SCAN_MIN_SATS: counted, never internalized,
   * not pending and not a problem. */
  ignoredBelowMinimum: number
  /** Rows at a marker address that are structurally not a Vault record of
   * ours: no marker between a vault output and a descriptor, the adjacent
   * output is not a v7 descriptor, or the descriptor does not decrypt under
   * this index. Anyone can pay a public marker address, so these are counted
   * as noise: never a problem, and never a reason for status 'incomplete'. */
  ignoredNonVault: number
  /** A found-but-unusable record, an index whose lookup was incomplete, or a
   * failed internalize. Reported distinctly; none of them counts as a "no
   * marker" miss, so one bad index can never silently truncate the scan. */
  problems: VaultChainRecoveryProblem[]
  /** = problems.length */
  problemCount: number
  /** Indexes whose lookup was unknown (window full, request failed, rate
   * limited). Their rows, if any were read, were still examined. */
  unknownIndexes: number[]
  /** Highest index with any marker history or any recovered record; 0 if none. */
  maxUsedIndex: number
  /** Highest index actually scanned this run — surfaced so a UI can offer
   * "scan further" when the gap default turns out to be too small. */
  scanned: number
  /** 'incomplete' when problemCount > 0 or unknownIndexes is not empty. */
  status: 'complete' | 'incomplete'
}

/** Alias kept for existing callers. */
export type VaultChainRecoveryResult = VaultScanResult

/** An authenticated, unspent candidate, held until the scan ends so the key
 * filter can see every setup before anything is inserted. */
export interface RecoverableCandidate {
  index: number
  txid: string
  ci: VaultInstructionsV7
  beef: number[]
  vaultOutputIndex: number
}

type CandidateOutcome =
  | ({ kind: 'ready' } & RecoverableCandidate)
  | { kind: 'pending'; ci: VaultInstructionsV7 }
  | { kind: 'spent' }
  | { kind: 'below-minimum' }
  | { kind: 'non-vault' }
  | { kind: 'problem'; reason: string }

/** True only for the two ways a stranger-planted ciphertext fails to open
 * under SymmetricKey.decrypt: AES-GCM authentication failure and a ciphertext
 * too short for IV + tag. Everything else is a wallet-level failure. */
function isForeignCiphertextError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /decryption failed|ciphertext too short/i.test(message)
}

/**
 * Locate and authenticate ONE candidate marker transaction for scan index
 * `k`. Never throws — every failure mode is a distinct, reported outcome, per
 * this module's "found-but-unusable is not a miss" contract.
 */
async function recoverOneCandidate(
  w: VaultWallet,
  adminOriginator: string,
  lookup: VaultChainLookup,
  chain: VaultSaltChain,
  k: number,
  markerScriptHex: string,
  txid: string
): Promise<CandidateOutcome> {
  const saltKeyId = String(k)
  let entry: { beef: number[]; confirmed: boolean } | null
  try {
    entry = await lookup.transactionForTxid(txid)
  } catch {
    return { kind: 'problem', reason: 'chain lookup failed to fetch transaction bytes' }
  }
  if (!entry) return { kind: 'problem', reason: 'no transaction bytes available for this candidate' }

  let tx: Transaction
  try {
    tx = Transaction.fromAtomicBEEF(entry.beef)
  } catch {
    try {
      tx = Transaction.fromBEEF(entry.beef)
    } catch {
      return { kind: 'problem', reason: 'malformed transaction bytes' }
    }
  }

  const markerIndex = tx.outputs.findIndex(o => o.lockingScript.toHex() === markerScriptHex)
  const vaultOutput = markerIndex >= 1 ? tx.outputs[markerIndex - 1] : undefined
  const descriptorOutput = markerIndex >= 0 ? tx.outputs[markerIndex + 1] : undefined
  if (!vaultOutput || !descriptorOutput) {
    // Structural noise: a stranger can pay a public marker address.
    return { kind: 'non-vault' }
  }

  const parsedDescriptor = parseVaultDescriptorScript(descriptorOutput.lockingScript)
  if (!parsedDescriptor) return { kind: 'non-vault' }

  let plaintext: string
  try {
    plaintext = await decryptVaultDescriptorPlaintext(w, adminOriginator, chain, saltKeyId, parsedDescriptor.ciphertext)
  } catch (error) {
    // Only an AES-GCM authentication failure (or a ciphertext too short to
    // hold an IV and tag) proves the descriptor is not encrypted to this
    // wallet's key for this index: a stranger can plant either. Any other
    // throw (wallet locked, storage error, transient failure) says nothing
    // about the record, so a real deposit must not be dropped as noise.
    if (isForeignCiphertextError(error)) return { kind: 'non-vault' }
    return { kind: 'problem', reason: 'could not decrypt the descriptor (wallet error)' }
  }

  const ci: VaultInstructionsV7 | null = decodeVaultInstructionsV7(plaintext)
  if (!ci) return { kind: 'problem', reason: 'descriptor decoded to an invalid or non-v7 record' }
  // Hard-require: closes the "missing piece" the availability review flagged
  // — a descriptor claiming a different index or network must never be
  // accepted at this scan position.
  if (ci.saltKeyId !== saltKeyId || ci.chain !== chain) {
    return { kind: 'problem', reason: 'descriptor index/chain does not match its scan position' }
  }

  let salt: string
  try {
    salt = await deriveVaultSalt(
      w,
      adminOriginator,
      ci.saltKeyId,
      ci.keys.map(key => key.serial)
    )
  } catch {
    return { kind: 'problem', reason: 'could not derive the salt for this record' }
  }
  let rebuilt: ReturnType<typeof buildLock>
  try {
    rebuilt = buildLock({ commitments: ci.keys.map(key => commitment(key.pubkey, salt)), saltHex64: salt })
  } catch {
    return { kind: 'problem', reason: 'recovery metadata does not build a valid lock' }
  }
  if (rebuilt.toHex() !== vaultOutput.lockingScript.toHex()) {
    return { kind: 'problem', reason: 'recovery metadata does not rebuild its adjacent lock' }
  }

  const vaultOutputIndex = markerIndex - 1
  // A real Vault output is never under the frozen scan floor (every deposit,
  // remainder and re-lock is at least VAULT_DEPOSIT_MIN). Anything smaller is
  // a copy or dust: counted, never internalized, never pending.
  if (vaultOutput.satoshis === undefined || vaultOutput.satoshis < VAULT_SCAN_MIN_SATS) {
    return { kind: 'below-minimum' }
  }
  let status: 'unspent' | 'spent' | 'unknown'
  try {
    status = await lookup.outputStatus({ txid, vout: vaultOutputIndex })
  } catch {
    status = 'unknown'
  }
  if (status === 'spent') return { kind: 'spent' }
  if (status === 'unknown') return { kind: 'problem', reason: 'could not confirm the vault output is unspent' }

  if (!entry.confirmed) return { kind: 'pending', ci }
  return { kind: 'ready', index: k, txid, ci, beef: entry.beef, vaultOutputIndex }
}

async function internalizeCandidate(
  w: VaultWallet,
  adminOriginator: string,
  candidate: RecoverableCandidate
): Promise<string | undefined> {
  try {
    await w.internalizeAction(
      {
        tx: candidate.beef,
        outputs: [
          {
            outputIndex: candidate.vaultOutputIndex,
            protocol: 'basket insertion',
            insertionRemittance: {
              basket: VAULT_BASKET,
              customInstructions: encodeVaultInstructionsV7(candidate.ci),
              tags: ['vault']
            }
          }
        ],
        description: 'Recovered vault deposit',
        seekPermission: false
      },
      adminOriginator
    )
  } catch (e) {
    return `could not internalize the recovered output: ${(e as Error)?.message ?? 'unknown error'}`
  }
  return undefined
}

/**
 * The keys a recovered deposit must share one of (KEY FILTER). A local key
 * list counts only when its authority tag verifies: a forged list would
 * otherwise hide every real deposit. Without one, the newest setup found
 * wins — an older setup's PIV keys were replaced by the reset that made it.
 */
async function recoveryLiveKeys(
  w: VaultWallet,
  adminOriginator: string,
  records: readonly VaultInstructionsV7[]
): Promise<ReadonlySet<string>> {
  const scopeToken = vaultStore.captureScopeToken()
  const scope = vaultStore.getScope()
  const meta = await vaultStore.getMeta(scopeToken)
  if (meta && scope) {
    const tag = await vaultStore.getMetaTag(scopeToken)
    if (await verifyVaultMetaAuthorityTag(w as unknown as HmacCapableWallet, adminOriginator, meta, scope, tag)) {
      return liveVaultPubkeys(meta)
    }
  }
  if (records.length === 0) return new Set()
  const newest = records.reduce((a, b) => (b.createdAt > a.createdAt ? b : a))
  return new Set(
    records
      .filter(r => r.vaultId === newest.vaultId && r.createdAt === newest.createdAt)
      .flatMap(r => r.keys.map(key => key.pubkey))
  )
}

/**
 * "Scan the blockchain for deposits": scan k = 1.. for chain-published v7
 * Vault outputs and internalize every confirmed, unspent, authenticated one
 * that is not already in 'admin vault' (merge by outpoint, so a second run is a
 * no-op for known outputs). Then rebuilds local vault metadata from the
 * now-listed outputs via the unchanged recoverVaultMetaFromOutputs (which
 * itself re-authenticates everything).
 *
 * It works with or without local metadata, and the result says what was found
 * and what went wrong: `status` is 'incomplete' when any index had a problem
 * or an unknown lookup, so a caller never shows a partial scan as complete.
 *
 * `wallet` need only satisfy VaultWallet (already used throughout
 * transfers.ts) — getPublicKey/encrypt/decrypt/createHmac/internalizeAction
 * must be backed by the wallet's real root key derivation for this to prove
 * anything (a stub wallet with no live mnemonic session cannot reproduce the
 * marker, decrypt the descriptor, or derive the salt — see INT-10's fail-closed
 * claim in restoreSalt.test.ts).
 */
export async function scanVaultDeposits(
  w: VaultWallet,
  adminOriginator: string,
  lookup: VaultChainLookup,
  chain: VaultSaltChain,
  gap: number = VAULT_RECOVERY_GAP_DEFAULT
): Promise<VaultScanResult> {
  const scan = await scanVaultChain(w, adminOriginator, lookup, chain, gap)
  const live = await recoveryLiveKeys(w, adminOriginator, [...scan.ready.map(c => c.ci), ...scan.pending])
  return await restoreScannedDeposits(w, adminOriginator, scan, live)
}

/** The first-restore entry point, kept for existing callers: the same scan. */
export async function recoverVaultFromChain(
  w: VaultWallet,
  adminOriginator: string,
  lookup: VaultChainLookup,
  chain: VaultSaltChain,
  gap: number = VAULT_RECOVERY_GAP_DEFAULT
): Promise<VaultChainRecoveryResult> {
  return await scanVaultDeposits(w, adminOriginator, lookup, chain, gap)
}

/**
 * Restore with one tapped YubiKey (no local key list needed, and no guessing
 * between setups): scan the chain, let `prove` pick and prove the key the
 * card holds (proveHeldVaultKey), then restore every deposit of the setups
 * that key belongs to. The proven key is marked adopted, so it can withdraw
 * without a second challenge.
 */
export async function recoverVaultWithKey(
  w: VaultWallet,
  adminOriginator: string,
  lookup: VaultChainLookup,
  chain: VaultSaltChain,
  prove: (records: readonly VaultInstructionsV7[]) => Promise<VaultInstructionKey>,
  gap: number = VAULT_RECOVERY_GAP_DEFAULT
): Promise<VaultChainRecoveryResult & { key: VaultInstructionKey }> {
  const scan = await scanVaultChain(w, adminOriginator, lookup, chain, gap)
  const records = [...scan.ready.map(c => c.ci), ...scan.pending]
  const key = await prove(records)
  // Every key of a setup the proven key is part of, so that setup's deposits
  // come back whole and rebuild one consistent key list.
  const live = new Set(
    records.filter(r => r.keys.some(k => k.pubkey === key.pubkey)).flatMap(r => r.keys.map(k => k.pubkey))
  )
  const result = await restoreScannedDeposits(w, adminOriginator, scan, live)
  if (result.found > 0) await vaultStore.markKeyAdopted(key)
  return { ...result, key }
}

interface VaultChainScan {
  ready: RecoverableCandidate[]
  pending: VaultInstructionsV7[]
  problems: VaultChainRecoveryProblem[]
  unknownIndexes: number[]
  ignoredBelowMinimum: number
  ignoredNonVault: number
  maxUsedIndex: number
  scanned: number
}

/** The scan half of recovery: find and authenticate every candidate without
 * inserting any. */
async function scanVaultChain(
  w: VaultWallet,
  adminOriginator: string,
  lookup: VaultChainLookup,
  chain: VaultSaltChain,
  gap: number
): Promise<VaultChainScan> {
  if (!Number.isSafeInteger(gap) || gap < 1) {
    throw new VaultError('template-invalid', 'Vault recovery gap must be a positive integer')
  }
  const ready: RecoverableCandidate[] = []
  const pending: VaultInstructionsV7[] = []
  const problems: VaultChainRecoveryProblem[] = []
  const unknownIndexes: number[] = []
  let ignoredBelowMinimum = 0
  let ignoredNonVault = 0
  let maxUsedIndex = 0
  let consecutiveMisses = 0
  // Bounds the loop independently of consecutiveMisses — see
  // VAULT_RECOVERY_MAX_CONSECUTIVE_PROBLEMS's doc comment. Reset on any
  // iteration that gets a real answer (a miss or a hit alike), so only a
  // PERSISTENT run of failures aborts the scan, never an occasional hiccup.
  let consecutiveProblems = 0
  let scanned = 0
  let k = 1
  const tooManyProblems = (): VaultError =>
    // A plain Error here left VaultScreen (vaultErrorCopy(undefined)) showing
    // its generic fallback copy instead of a message actually describing what
    // happened — 'chain-scan-failed' is a code the UI already translates.
    new VaultError(
      'chain-scan-failed',
      `Vault recovery scan could not complete: ${consecutiveProblems} consecutive derivation/lookup failures, most recently at index ${k}`
    )
  while (consecutiveMisses < gap) {
    scanned = k
    const saltKeyId = String(k)
    let markerScriptHex: string
    try {
      markerScriptHex = (await deriveVaultMarkerScript(w, adminOriginator, chain, saltKeyId)).toHex()
    } catch {
      // Cannot even derive our own marker key — a wallet-layer problem, not
      // evidence this index has no deposit. Reported, not counted as a miss
      // — but still bounded, so a persistent failure fails loudly instead of
      // looping forever (INT-01/INT-06/XQ-012 availability review).
      problems.push({ index: k, reason: 'could not derive the marker key for this index' })
      if (++consecutiveProblems >= VAULT_RECOVERY_MAX_CONSECUTIVE_PROBLEMS) throw tooManyProblems()
      k++
      continue
    }
    const markerAddress = markerAddressFor(lookup, markerScriptHex, chain)
    let history: MarkerHistory
    try {
      history = await lookupMarker(lookup, markerScriptHex)
    } catch {
      history = { status: 'unknown', reason: 'request-failed', txids: [] }
    }
    if (history.status === 'none') {
      consecutiveProblems = 0
      consecutiveMisses++
      k++
      continue
    }
    const rows = [...new Set(history.txids.map(txid => txid.toLowerCase()))]
    if (history.status === 'unknown') {
      // Never a "no funds" answer: reported, kept out of the miss count, and
      // the rows that were read are still examined below.
      unknownIndexes.push(k)
      problems.push({ index: k, reason: `lookup incomplete: ${history.reason}`, markerAddress })
      if (rows.length === 0) {
        if (++consecutiveProblems >= VAULT_RECOVERY_MAX_CONSECUTIVE_PROBLEMS) throw tooManyProblems()
        k++
        continue
      }
    }
    consecutiveProblems = 0
    // Marker history exists at this index — never a "no marker" miss from
    // here on, no matter how every candidate below turns out.
    consecutiveMisses = 0
    maxUsedIndex = Math.max(maxUsedIndex, k)
    // Every row is examined. The window is already bounded by the lookup (at
    // most a few thousand rows), and a valid row never hides another.
    const seenOutpoints = new Set<string>()
    for (const txid of rows) {
      const outcome = await recoverOneCandidate(w, adminOriginator, lookup, chain, k, markerScriptHex, txid)
      if (outcome.kind === 'ready') {
        const outpoint = `${txid}.${outcome.vaultOutputIndex}`
        if (seenOutpoints.has(outpoint)) continue
        seenOutpoints.add(outpoint)
        ready.push(outcome)
      } else if (outcome.kind === 'pending') pending.push(outcome.ci)
      else if (outcome.kind === 'below-minimum') ignoredBelowMinimum++
      else if (outcome.kind === 'non-vault') ignoredNonVault++
      else if (outcome.kind === 'problem') problems.push({ index: k, reason: outcome.reason, markerAddress })
      // 'spent': a superseded output (already withdrawn or re-locked) —
      // entirely normal, silently skipped; keep inspecting other candidates
      // at this index.
    }
    k++
  }
  return { ready, pending, problems, unknownIndexes, ignoredBelowMinimum, ignoredNonVault, maxUsedIndex, scanned }
}

function markerAddressFor(
  lookup: VaultChainLookup,
  markerScriptHex: string,
  chain: VaultSaltChain
): string | undefined {
  try {
    return (
      lookup.markerAddress?.(markerScriptHex) ??
      p2pkhAddressFromScript(markerScriptHex, chain === 'main' ? 'mainnet' : 'testnet')
    )
  } catch {
    return undefined
  }
}

/** The insert half: internalize the scanned deposits `live` can open and that
 * are not yet in the basket, count the rest, then rebuild local vault
 * metadata. */
async function restoreScannedDeposits(
  w: VaultWallet,
  adminOriginator: string,
  scan: VaultChainScan,
  live: ReadonlySet<string>
): Promise<VaultScanResult> {
  const { ready, pending, scanned, unknownIndexes, ignoredBelowMinimum, ignoredNonVault } = scan
  const problems = [...scan.problems]
  let found = 0
  let pendingConfirmation = 0
  let unreachable = 0
  let maxUsedIndex = scan.maxUsedIndex
  const scopeToken = vaultStore.captureScopeToken()
  // Merge by outpoint: what the basket already holds is neither re-added nor
  // counted, so a second scan is a no-op for known outputs.
  const known = await listVaultBasketOutpoints(w, adminOriginator, scopeToken)
  for (const candidate of ready) {
    maxUsedIndex = Math.max(maxUsedIndex, candidate.index)
    if (known.has(`${candidate.txid.toLowerCase()}.${candidate.vaultOutputIndex}`)) continue
    if (!opensWithAny(candidate.ci, live)) {
      unreachable++
      continue
    }
    const failure = await internalizeCandidate(w, adminOriginator, candidate)
    if (failure) problems.push({ index: candidate.index, reason: failure })
    else found++
  }
  for (const ci of pending) {
    if (opensWithAny(ci, live)) pendingConfirmation++
    else unreachable++
  }
  await recoverVaultMetaFromOutputs(w, adminOriginator)
  // The next salt allocation starts above every index this scan saw in use.
  if (maxUsedIndex > 0) noteSaltFloor(scopeToken.storageKey, maxUsedIndex)
  return {
    found,
    pendingConfirmation,
    unreachable,
    ignoredBelowMinimum,
    ignoredNonVault,
    problems,
    problemCount: problems.length,
    unknownIndexes,
    maxUsedIndex,
    scanned,
    status: problems.length > 0 || unknownIndexes.length > 0 ? 'incomplete' : 'complete'
  }
}

export { wocChainLookup } from './wocLookup'
