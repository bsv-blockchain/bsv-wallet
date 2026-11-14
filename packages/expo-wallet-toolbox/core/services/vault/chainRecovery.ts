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
 * ADMISSION (a scan only adds outputs): the marker and descriptor derive from
 * the wallet root, so anyone holding the mnemonic can plant a record, and
 * earlier setups' deposits authenticate too. Candidates are grouped into
 * lineages (`vaultId:createdAt`) and, at a lineage's highest revision, into one
 * variant per distinct key list. With a local, authenticated meta only
 * candidates of that lineage that add no unknown key are internalized (the rest
 * are set apart). With no local meta one group is internalized; more than one
 * is a conflict: nothing is internalized and the groups are reported. A tapped
 * restore keeps only outputs whose OWN key list holds the tapped key.
 */
import { Hash, Transaction, Utils } from '@bsv/sdk'
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
import { vaultStore, type VaultMeta } from './vaultStore'
import { computeVaultMetaAuthorityTag, verifyVaultMetaAuthorityTag, type HmacCapableWallet } from './metaAuthority'
import {
  VAULT_BASKET,
  introducesUnknownKey,
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

/** One lineage (`vaultId:createdAt`), or one variant of it, found by a scan. */
export interface VaultRecoveryGroup {
  /** '<vaultId>:<createdAt>', or for a variant '<vaultId>:<createdAt>:<16 hex>'. */
  id: string
  vaultId: string
  createdAt: number
  /** Highest revision in the group. */
  revision: number
  /** Key list at that revision. */
  keys: VaultInstructionKey[]
  /** Internalizable outputs (at or above the floor, unspent, confirmed). */
  outputs: number
  satoshis: number
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
  /** Every group found (after the tapped-key filter, when there is one),
   * including set-apart ones. */
  groups?: VaultRecoveryGroup[]
  /** True when more than one group is a candidate and nothing was internalized. */
  conflict?: boolean
  /** Groups that were not internalized. */
  setApart?: VaultRecoveryGroup[]
}

/** Options that pick one group when a scan finds several. */
export interface VaultRestoreOptions {
  /** A `VaultRecoveryGroup.id`. */
  groupId?: string
  /** Alias for `groupId`; matches a lineage with exactly one group. */
  vaultId?: string
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
  satoshis: number
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
  return { kind: 'ready', index: k, txid, ci, beef: entry.beef, vaultOutputIndex, satoshis: vaultOutput.satoshis }
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

/** This device's local meta, only when its authority tag verifies: a forged
 * record must never decide what is admitted. */
async function authenticatedLocalMeta(w: VaultWallet, adminOriginator: string): Promise<VaultMeta | null> {
  const scopeToken = vaultStore.captureScopeToken()
  const scope = vaultStore.getScope()
  const meta = await vaultStore.getMeta(scopeToken)
  if (!meta || !scope) return null
  const tag = await vaultStore.getMetaTag(scopeToken)
  if (await verifyVaultMetaAuthorityTag(w as unknown as HmacCapableWallet, adminOriginator, meta, scope, tag)) {
    return meta
  }
  return null
}

const lineageId = (ci: Pick<VaultInstructionsV7, 'vaultId' | 'createdAt'>): string => `${ci.vaultId}:${ci.createdAt}`

const sameKeyList = (a: readonly VaultInstructionKey[], b: readonly VaultInstructionKey[]): boolean =>
  a.length === b.length && a.every((key, i) => key.serial === b[i].serial && key.pubkey === b[i].pubkey)

function keyListDigest(keys: readonly VaultInstructionKey[]): string {
  const json = JSON.stringify(keys.map(key => ({ serial: key.serial, pubkey: key.pubkey })))
  return Utils.toHex(Hash.sha256(Utils.toArray(json, 'utf8'))).slice(0, 16)
}

/** A group with the candidates it would internalize. */
interface InternalGroup {
  group: VaultRecoveryGroup
  ready: RecoverableCandidate[]
  pending: VaultInstructionsV7[]
}

/**
 * Form the groups of a set of records: one per lineage, split at the lineage's
 * highest revision into one per distinct key list (a variant). Outputs of a
 * lower revision belong to every variant of their lineage.
 */
function formGroups(ready: readonly RecoverableCandidate[], pending: readonly VaultInstructionsV7[]): InternalGroup[] {
  const lineages = new Map<string, { ready: RecoverableCandidate[]; pending: VaultInstructionsV7[] }>()
  const entry = (id: string) => {
    let e = lineages.get(id)
    if (!e) lineages.set(id, (e = { ready: [], pending: [] }))
    return e
  }
  for (const c of ready) entry(lineageId(c.ci)).ready.push(c)
  for (const ci of pending) entry(lineageId(ci)).pending.push(ci)

  const groups: InternalGroup[] = []
  for (const [id, members] of lineages) {
    const records = [...members.ready.map(c => c.ci), ...members.pending]
    const revision = Math.max(...records.map(ci => ci.revision))
    const variants: VaultInstructionKey[][] = []
    for (const ci of records) {
      if (ci.revision === revision && !variants.some(v => sameKeyList(v, ci.keys))) variants.push(ci.keys)
    }
    for (const keys of variants) {
      const belongs = (ci: VaultInstructionsV7): boolean => ci.revision < revision || sameKeyList(keys, ci.keys)
      const groupReady = members.ready.filter(c => belongs(c.ci))
      const first = records[0]
      groups.push({
        group: {
          id: variants.length > 1 ? `${id}:${keyListDigest(keys)}` : id,
          vaultId: first.vaultId,
          createdAt: first.createdAt,
          revision,
          keys: keys.map(key => ({ ...key })),
          outputs: groupReady.length,
          satoshis: groupReady.reduce((sum, c) => sum + c.satoshis, 0)
        },
        ready: groupReady,
        pending: members.pending.filter(belongs)
      })
    }
  }
  return groups
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
  return await restoreScannedDeposits(w, adminOriginator, scan, {})
}

/** The first-restore entry point, kept for existing callers: the same scan. It
 * has no tapped key, so it uses the variant rule only; with more than one group
 * it internalizes nothing and reports `conflict`. Picking a group needs the tap
 * (recoverVaultWithKey). */
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
 * Restore with one tapped YubiKey (no local key list needed): scan the chain,
 * let `prove` pick and prove the key the card holds (proveHeldVaultKey), then
 * keep only the outputs whose OWN key list holds that key and restore the group
 * they form. More than one group and no `options.groupId`: restore nothing and
 * report `conflict` with the groups. The proven key is marked adopted, so it
 * can withdraw without a second challenge.
 */
export async function recoverVaultWithKey(
  w: VaultWallet,
  adminOriginator: string,
  lookup: VaultChainLookup,
  chain: VaultSaltChain,
  prove: (records: readonly VaultInstructionsV7[]) => Promise<VaultInstructionKey>,
  gap: number = VAULT_RECOVERY_GAP_DEFAULT,
  options?: VaultRestoreOptions
): Promise<VaultChainRecoveryResult & { key: VaultInstructionKey }> {
  const scan = await scanVaultChain(w, adminOriginator, lookup, chain, gap)
  const records = [...scan.ready.map(c => c.ci), ...scan.pending]
  const key = await prove(records)
  const result = await restoreScannedDeposits(w, adminOriginator, scan, {
    pubkey: key.pubkey,
    groupId: options?.groupId,
    vaultId: options?.vaultId,
    requireGroup: true
  })
  if (result.found > 0) {
    // A durable proof re-tags the whole stored meta, so it is only written over
    // a meta whose own tag verifies (the restore above may have left an
    // existing meta untouched). Any other meta gets a session proof.
    const scope = vaultStore.getScope()
    const hmacWallet = w as unknown as HmacCapableWallet
    const snapshot = scope ? await vaultStore.getMeta() : null
    const tag = snapshot ? await vaultStore.getMetaTag() : null
    const authentic =
      !!scope && !!snapshot && (await verifyVaultMetaAuthorityTag(hmacWallet, adminOriginator, snapshot, scope, tag))
    await vaultStore.markKeyAdopted(
      key,
      undefined,
      authentic && scope ? next => computeVaultMetaAuthorityTag(hmacWallet, adminOriginator, next, scope) : undefined,
      authentic && snapshot ? snapshot : undefined
    )
  }
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

interface RestoreSelection {
  /** Tapped key: keep only outputs whose own key list holds it. */
  pubkey?: string
  groupId?: string
  vaultId?: string
  /** A named group must be one of the groups found (tapped restore). */
  requireGroup?: boolean
}

/**
 * With an authenticated local meta: which candidates a scan may internalize.
 * Same lineage as meta, and either older than meta or adding no unknown key.
 * Two further guards keep the later metaFromVerifiedOutputs from ever seeing a
 * disagreement: at meta's own revision the key list must equal meta's, and above
 * it a revision with more than one key list admits none of them.
 */
function admitAgainstMeta(meta: VaultMeta, ready: readonly RecoverableCandidate[]): Set<RecoverableCandidate> {
  const admitted = ready.filter(c => {
    const { ci } = c
    if (ci.vaultId !== meta.vaultId || ci.createdAt !== meta.createdAt) return false
    if (ci.revision < meta.revision) return true
    if (introducesUnknownKey(meta, ci.keys)) return false
    if (ci.revision === meta.revision) return sameKeyList(meta.keys, ci.keys)
    return true
  })
  const above = admitted.filter(c => c.ci.revision > meta.revision)
  if (above.length > 0) {
    const top = Math.max(...above.map(c => c.ci.revision))
    const atTop = above.filter(c => c.ci.revision === top)
    if (atTop.some(c => !sameKeyList(atTop[0].ci.keys, c.ci.keys))) {
      return new Set(admitted.filter(c => c.ci.revision !== top))
    }
  }
  return new Set(admitted)
}

/** The insert half: decide which groups are admitted (see this file's
 * ADMISSION note), internalize their candidates that are not yet in the basket,
 * then rebuild local vault metadata. */
async function restoreScannedDeposits(
  w: VaultWallet,
  adminOriginator: string,
  scan: VaultChainScan,
  selection: RestoreSelection
): Promise<VaultScanResult> {
  const { scanned, unknownIndexes, ignoredBelowMinimum, ignoredNonVault } = scan
  const problems = [...scan.problems]
  let found = 0
  let pendingConfirmation = 0
  let unreachable = 0
  let maxUsedIndex = scan.maxUsedIndex
  const scopeToken = vaultStore.captureScopeToken()

  // Tapped key: an output counts only if its OWN key list holds the key.
  const holds = (keys: readonly VaultInstructionKey[]): boolean =>
    !selection.pubkey || keys.some(key => key.pubkey === selection.pubkey)
  const ready = scan.ready.filter(c => holds(c.ci.keys))
  const pending = scan.pending.filter(ci => holds(ci.keys))
  unreachable += scan.ready.length - ready.length + (scan.pending.length - pending.length)
  for (const candidate of scan.ready) maxUsedIndex = Math.max(maxUsedIndex, candidate.index)

  const groups = formGroups(ready, pending)
  const meta = await authenticatedLocalMeta(w, adminOriginator)
  const admittedReady = new Set<RecoverableCandidate>()
  const admittedPending: VaultInstructionsV7[] = []
  let conflict = false
  let setApart: VaultRecoveryGroup[]

  if (meta) {
    const admitted = admitAgainstMeta(meta, ready)
    for (const c of admitted) admittedReady.add(c)
    for (const ci of pending) {
      if (ci.vaultId === meta.vaultId && ci.createdAt === meta.createdAt && !introducesUnknownKey(meta, ci.keys)) {
        admittedPending.push(ci)
      }
    }
    // Not admitted and sharing no key with this device's list (an earlier
    // setup's deposit): counted as unreachable, as well as set apart below.
    const live = liveVaultPubkeys(meta)
    unreachable += ready.filter(c => !admitted.has(c) && !opensWithAny(c.ci, live)).length
    unreachable += pending.filter(ci => !admittedPending.includes(ci) && !opensWithAny(ci, live)).length
    // A group is set apart when none of its outputs at its own revision were admitted.
    setApart = groups
      .filter(g => !g.ready.some(c => admitted.has(c) && c.ci.revision === g.group.revision))
      .filter(g => !g.pending.some(ci => admittedPending.includes(ci) && ci.revision === g.group.revision))
      .map(g => {
        // A lower-revision output shared with an admitted group is not set apart.
        const apart = g.ready.filter(c => !admitted.has(c))
        return { ...g.group, outputs: apart.length, satoshis: apart.reduce((sum, c) => sum + c.satoshis, 0) }
      })
  } else {
    const wanted = selection.groupId ?? selection.vaultId
    let chosen: InternalGroup[]
    if (wanted) {
      chosen = groups.filter(g => g.group.id === wanted)
      if (chosen.length === 0 && selection.vaultId && !selection.groupId) {
        const byLineage = groups.filter(g => `${g.group.vaultId}` === wanted)
        if (byLineage.length === 1) chosen = byLineage
      }
      if (chosen.length === 0 && selection.requireGroup) {
        throw new VaultError('key-opens-nothing', 'No vault group found for this key matches the requested group')
      }
    } else if (groups.length === 1) {
      chosen = groups
    } else {
      chosen = []
      conflict = groups.length > 1
    }
    for (const g of chosen) {
      for (const c of g.ready) admittedReady.add(c)
      for (const ci of g.pending) admittedPending.push(ci)
    }
    setApart = groups.filter(g => !chosen.includes(g)).map(g => g.group)
  }

  // Merge by outpoint: what the basket already holds is neither re-added nor
  // counted, so a second scan is a no-op for known outputs.
  const known = await listVaultBasketOutpoints(w, adminOriginator, scopeToken)
  for (const candidate of ready) {
    if (!admittedReady.has(candidate)) continue
    if (known.has(`${candidate.txid.toLowerCase()}.${candidate.vaultOutputIndex}`)) continue
    known.add(`${candidate.txid.toLowerCase()}.${candidate.vaultOutputIndex}`)
    const failure = await internalizeCandidate(w, adminOriginator, candidate)
    if (failure) problems.push({ index: candidate.index, reason: failure })
    else found++
  }
  pendingConfirmation = admittedPending.length
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
    status: problems.length > 0 || unknownIndexes.length > 0 ? 'incomplete' : 'complete',
    groups: groups.map(g => g.group),
    conflict,
    setApart
  }
}

export { wocChainLookup } from './wocLookup'
