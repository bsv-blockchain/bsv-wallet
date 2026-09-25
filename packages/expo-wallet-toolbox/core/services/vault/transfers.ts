/**
 * Vault transfers — internal movements between the `default` change basket
 * and the `admin vault` basket, over 1-of-N P-256 comb-verifier outputs
 * (r1comb.ts, spec §2).
 *
 * Deposit: NO hardware. A vault output has a wallet-derived HMAC salt and one
 * comb commitment for every enrolled key. The HMAC uses [2, "vault salt"],
 * counterparty "self", the rolling key ID "1", "2", ... and the canonically
 * framed YubiKey serials in commitment order. The lock contains only salted
 * table commitments; versioned customInstructions retain the derivation ID,
 * salt and full key records for authenticated indexing and recovery. Funding and change stay
 * with the toolbox, out of the default basket. The release and private-backup
 * configuration gates must be enabled before creating any vault output.
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
 * The staged noSend finish on output-creating spends (see the PAST THE POINT
 * OF NO ABORT comment) lets this module validate final signed bytes before the
 * initial sendWith release, without using the offline queue.
 *
 * The `admin vault` basket name is admin-reserved: WalletPermissionsManager
 * blocks any non-admin originator (web pages) from listing, inserting into, or
 * relinquishing it. All calls here use the admin originator.
 *
 * SECURITY: no private key material passes through this module — ever. A VaultSigner
 * (serial, public key, sign()) arrives from ceremonyHost for the length of ONE
 * withdrawal or re-lock and is released in a finally. Each salt is revealed
 * only by a spend's unlocking script; it provides domain separation between
 * locks, not spending authority.
 */
import { Beef, Hash, LockingScript, OP, P2PKH, PublicKey, Script, Transaction, UnlockingScript, Utils } from '@bsv/sdk'
import { isBackupPushEnabled } from '../../backup/preference'
import { getBackupUrl, isVaultAvailable, isVaultEnabled } from '../../toolboxConfig'
import { sdk as toolboxSdk } from '@bsv/wallet-toolbox-mobile'
import { noteVaultProgress, requestVaultSigner } from './ceremonyHost'
import {
  MAX_DESCRIPTOR_CIPHERTEXT_BYTES,
  R1C_LOCK_LEN,
  R1C_UNLOCK_LEN,
  SALT_BYTES,
  VaultInstructions,
  VaultInstructionsV7,
  bakedCommitments,
  buildLock,
  buildUnlock,
  commitment,
  decodeVaultInstructions,
  decodeVaultInstructionsV7,
  encodeVaultInstructions,
  encodeVaultInstructionsV7,
  pushData,
  pushTxDerCheck,
  sighashPreimage,
  signerDigest,
  vaultSaltHmacData,
  verifyVaultInput
} from './r1comb'
import { VaultError } from './types'
import { metaFromVerifiedOutputs, VAULT_MIN_KEYS } from './VaultKeyService'
import { vaultStore, VaultKeyRecord, VaultMeta, type VaultScopeToken, type VaultStoreScope } from './vaultStore'
import { computeVaultMetaAuthorityTag, verifyVaultMetaAuthorityTag, type HmacCapableWallet } from './metaAuthority'
import { forgetSerialsNoLongerEnrolledForIdentity } from './enrolledSerialRegistry'

export const VAULT_BASKET = 'admin vault'
/** Wallet HMAC domain used only for Vault output salts. */
export const VAULT_SALT_PROTOCOL = [2, 'vault salt'] as const
/** Wallet key domain for the v7 chain-published marker address. */
export const VAULT_MARKER_PROTOCOL = [2, 'vault marker'] as const
/** Wallet encryption domain for the v7 chain-published encrypted descriptor. */
export const VAULT_DESCRIPTOR_PROTOCOL = [2, 'vault descriptor'] as const
/** OP_RETURN tag identifying a v7 vault descriptor output. */
export const VAULT_DESCRIPTOR_TAG = 'r1c7'

/**
 * keyID shared by the marker and descriptor derivations for output index `k`
 * on `chain` — folds the chain in (unlike the chain-agnostic 'vault salt'
 * HMAC, which stays untouched) so an identical enrolled-serial-set reused
 * across two networks derives unrelated addresses/ciphertext keys instead of
 * reusing the same discoverable marker address.
 */
export function vaultChainKeyId(chain: VaultScopeToken['chain'], saltKeyId: string): string {
  return `${chain}:${saltKeyId}`
}

/** The deterministic P2PKH marker script for output index `saltKeyId` on
 * `chain` — reproducible from nothing but the wallet root, chain and index. */
export async function deriveVaultMarkerScript(
  w: VaultWallet,
  adminOriginator: string,
  chain: VaultScopeToken['chain'],
  saltKeyId: string
): Promise<LockingScript> {
  const { publicKey } = await w.getPublicKey({
    protocolID: [...VAULT_MARKER_PROTOCOL],
    keyID: vaultChainKeyId(chain, saltKeyId),
    counterparty: 'self',
    seekPermission: false
  }, adminOriginator)
  return new P2PKH().lock(PublicKey.fromString(publicKey).toAddress())
}

/**
 * `OP_FALSE OP_RETURN <'r1c7'> <ciphertext>` — basketless, 0-sat,
 * chain-published.
 *
 * @bsv/sdk's Script chunk parser treats OP_RETURN specially: everything after
 * it is captured as ONE raw data blob on the OP_RETURN chunk itself (nothing
 * past OP_RETURN ever executes, so no library tries to keep parsing it as
 * further opcodes — matches ordinary OP_RETURN scripts industry-wide). The
 * tag and ciphertext are still push-encoded (pushData) WITHIN that blob, so
 * parseVaultDescriptorScript can split them back out with an ordinary
 * (non-OP_RETURN) chunk parse of the blob alone.
 */
export function buildVaultDescriptorScript(ciphertext: number[]): LockingScript {
  const tagBytes = Utils.toArray(VAULT_DESCRIPTOR_TAG, 'utf8') as number[]
  const payload = [...pushData(tagBytes), ...pushData(ciphertext)]
  return new LockingScript([{ op: OP.OP_FALSE }, { op: OP.OP_RETURN, data: payload }])
}

/** Parse a script built by buildVaultDescriptorScript. Returns null for
 * anything else — including an oversized ciphertext, which is never trusted,
 * only reported as unusable by the caller. */
export function parseVaultDescriptorScript(lockingScript: LockingScript): { ciphertext: number[] } | null {
  const chunks = lockingScript.chunks
  if (chunks.length !== 2) return null
  if (chunks[0].op !== OP.OP_0 && chunks[0].op !== OP.OP_FALSE) return null
  if (chunks[1].op !== OP.OP_RETURN || !chunks[1].data) return null
  let inner: { op: number; data?: number[] }[]
  try {
    inner = Script.fromBinary(chunks[1].data).chunks
  } catch {
    return null
  }
  if (inner.length !== 2) return null
  const tag = inner[0].data
  if (!tag || Utils.toUTF8(tag) !== VAULT_DESCRIPTOR_TAG) return null
  const ciphertext = inner[1].data
  if (!ciphertext || ciphertext.length === 0 || ciphertext.length > MAX_DESCRIPTOR_CIPHERTEXT_BYTES) return null
  return { ciphertext }
}

/** Encrypt a v7 customInstructions JSON string for the descriptor output,
 * enforcing the byte budget at creation time (fail closed, never truncate). */
export async function encryptVaultDescriptorPlaintext(
  w: VaultWallet,
  adminOriginator: string,
  chain: VaultScopeToken['chain'],
  saltKeyId: string,
  plaintext: string
): Promise<number[]> {
  const { ciphertext } = await w.encrypt({
    plaintext: Utils.toArray(plaintext, 'utf8') as number[],
    protocolID: [...VAULT_DESCRIPTOR_PROTOCOL],
    keyID: vaultChainKeyId(chain, saltKeyId),
    counterparty: 'self',
    seekPermission: false
  }, adminOriginator)
  if (!Array.isArray(ciphertext) || ciphertext.length === 0 || ciphertext.length > MAX_DESCRIPTOR_CIPHERTEXT_BYTES) {
    throw new VaultError('template-invalid', 'Vault descriptor ciphertext exceeds its byte budget')
  }
  return ciphertext
}

/** Decrypt a descriptor's ciphertext back to its plaintext customInstructions
 * JSON string. Throws (never silently returns garbage) on any wallet-level
 * decrypt failure — the caller decides how an unusable record is reported. */
export async function decryptVaultDescriptorPlaintext(
  w: VaultWallet,
  adminOriginator: string,
  chain: VaultScopeToken['chain'],
  saltKeyId: string,
  ciphertext: number[]
): Promise<string> {
  const { plaintext } = await w.decrypt({
    ciphertext,
    protocolID: [...VAULT_DESCRIPTOR_PROTOCOL],
    keyID: vaultChainKeyId(chain, saltKeyId),
    counterparty: 'self'
  }, adminOriginator)
  return Utils.toUTF8(plaintext)
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
  /** Injected BUILD half of the availability gate so the module stays
   * config-free in tests. Defaults to isVaultEnabled() from toolboxConfig.
   * Half-dead since task 11: it can still refuse, but `() => true` no longer
   * enables anything, because the mainnet half is not injectable and runs
   * regardless — see requireReleased. */
  vaultEnabled?: () => boolean
  /** Private encrypted backup must have a configured service and must not be
   * opted out before any operation creates a new Vault output. */
  backupEnabled?: () => Promise<boolean>
  /** Two-phase key revocation: spend only outputs still authorizing this
   * pubkey and write replacements under the remaining active keys. A durable
   * pendingRemoval tombstone must already retain the revoked key record. */
  revokePubkey?: string
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
  /** Strictly authenticated current-format outputs in the basket. */
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
 * An R1C output costs roughly 45 KB to create and ~2.5 KB of unlock plus its
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
 * contributes its ~45 KB source transaction to the inputBEEF (32 inputs ≈
 * 1.5 MB, with listOutputs' missing response cap) plus a
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
  createHmac(args: unknown, originator: string): Promise<{ hmac: number[] }>
  /** XR-002: verifies a vault-meta authority tag (metaAuthority.ts) before an
   * output-creating operation trusts local meta. */
  verifyHmac(args: unknown, originator: string): Promise<{ valid: boolean }>
  createAction(args: unknown, originator: string): Promise<CreateActionResult>
  signAction(args: unknown, originator: string): Promise<{
    txid?: string
    tx?: number[]
  }>
  listOutputs(args: unknown, originator: string): Promise<ListOutputsResult>
  abortAction(args: unknown, originator: string): Promise<unknown>
  listActions?(args: unknown, originator: string): Promise<{ actions: VaultActionRow[]; totalActions?: number }>
  /** Marker key derivation (v7 output creation and chain recovery). */
  getPublicKey(args: unknown, originator: string): Promise<{ publicKey: string }>
  /** Descriptor encryption (v7 output creation). */
  encrypt(args: unknown, originator: string): Promise<{ ciphertext: number[] }>
  /** Descriptor decryption (chain recovery). */
  decrypt(args: unknown, originator: string): Promise<{ plaintext: number[] }>
  /** Insert a chain-recovered v7 output into the admin vault basket. */
  internalizeAction(args: unknown, originator: string): Promise<{ accepted: true }>
  /** Network status lookup (mirrors storage/methods/processOfflineActions.ts'
   * networkAlreadyHas) used only by resolveHeldVaultDeposit to tell a held
   * signed deposit that already escaped to the network from one that has
   * not. Optional: a wallet that cannot answer is treated as "unknown", same
   * as networkAlreadyHas' own every-failure-is-false rule. */
  getStatusForTxids?(txids: string[]): Promise<{ results?: { txid: string; status: string }[] }>
}

/** VaultWallet's createHmac/verifyHmac require `originator`; the SDK's own
 * WalletInterface types it optional, which structurally is all
 * metaAuthority.ts's HmacCapableWallet needs. Every call in this module
 * already always supplies `adminOriginator`, so narrowing costs nothing. */
function asHmacWallet(w: VaultWallet): HmacCapableWallet {
  return w as unknown as HmacCapableWallet
}

/** The fields of a listActions row the reservation heal needs. `inputs` arrives
 * only when the call asked for `includeInputs`, and a transaction that never
 * reached signing has no `txid` — which is exactly the case the outpoint match
 * exists to cover. */
export interface VaultActionRow {
  txid?: string
  status: string
  reference?: string
  labels?: string[]
  inputs?: { sourceOutpoint?: string; sourceSatoshis?: number; sourceLockingScript?: string }[]
  outputs?: {
    satoshis: number
    spendable: boolean
    customInstructions?: string
    lockingScript?: string
    outputIndex: number
    basket: string
  }[]
}

interface CreateActionResult {
  txid?: string
  tx?: number[]
  signableTransaction?: { tx: number[]; reference: string }
  sendWithResults?: { txid?: string; status?: string }[]
}
interface ListOutputsResult {
  outputs: {
    outpoint: string
    satoshis: number
    customInstructions?: string
    lockingScript?: string
  }[]
  totalOutputs?: number
  /** Present when `include: 'entire transactions'` was requested — the
   * multi-tx BEEF covering every listed output's source transaction. Forwarded
   * verbatim as createAction's inputBEEF and read for each output's REAL lock. */
  BEEF?: number[]
}

// ── helpers ───────────────────────────────────────────────────────────────

/**
 * Process-wide serialization for every operation that can change the vault
 * basket or its authorization metadata. UI state is not a lock: two screens,
 * a fast double tap, or a disable action racing a transfer can otherwise make
 * decisions from the same stale output set.
 */
let vaultMutationTail: Promise<void> = Promise.resolve()

async function withVaultMutation<T>(work: () => Promise<T>): Promise<T> {
  let release!: () => void
  const predecessor = vaultMutationTail
  vaultMutationTail = new Promise<void>(resolve => { release = resolve })
  await predecessor
  try {
    return await work()
  } finally {
    release()
  }
}

const assertVaultScope = (scopeToken?: VaultScopeToken): void => {
  if (scopeToken) vaultStore.assertScopeToken(scopeToken)
}

const VAULT_LIST_PAGE = 64
const VAULT_ACTION_PAGE = 200
/** Rows carrying full R1C scripts are several megabytes at the normal
 * withdrawal input cap. Keep those bridge pages small without limiting how
 * many pages can be inspected. */
const VAULT_SCRIPT_ACTION_PAGE = 8

/** Accept the two outpoint separators used by wallet surfaces, then retain one
 * canonical spelling everywhere this module compares identities. Decimal
 * output indexes are canonicalized too so textual aliases cannot make one coin
 * appear to be two different Vault outputs. */
function canonicalVaultOutpoint(outpoint: string): string {
  const match = /^([0-9a-fA-F]{64})[.:](0|[1-9][0-9]*)$/.exec(outpoint)
  if (!match) throw new VaultError('no-transaction', `Vault output has invalid outpoint ${outpoint}`)
  const vout = Number(match[2])
  if (!Number.isSafeInteger(vout)) {
    throw new VaultError('no-transaction', `Vault output has invalid outpoint ${outpoint}`)
  }
  return `${match[1].toLowerCase()}.${vout}`
}

/** Page the entire basket without retaining its large scripts or BEEF. The
 * callback consumes each page (v7's per-output salt re-derivation makes this
 * async — awaited sequentially within a page before the next page is
 * fetched); only compact identities stay live across pages so pagination
 * aliases and repeats still fail closed. */
async function scanVaultOutputPages(
  w: VaultWallet,
  adminOriginator: string,
  include: 'locking scripts' | 'entire transactions',
  onPage: (outputs: ListOutputsResult['outputs'], page: ListOutputsResult) => void | Promise<void>,
  scopeToken?: VaultScopeToken,
): Promise<number> {
  const seen = new Set<string>()
  let offset = 0
  let expectedTotal: number | undefined
  for (;;) {
    assertVaultScope(scopeToken)
    const page = await w.listOutputs(
      { basket: VAULT_BASKET, include, includeCustomInstructions: true, limit: VAULT_LIST_PAGE, offset },
      adminOriginator
    )
    assertVaultScope(scopeToken)
    if (!page || !Array.isArray(page.outputs)) {
      throw new VaultError('no-transaction', 'Vault output listing returned an invalid page')
    }
    if (page.outputs.length > VAULT_LIST_PAGE) {
      throw new VaultError('no-transaction', 'Vault output listing exceeded its requested page size')
    }
    if (page.totalOutputs !== undefined) {
      if (!Number.isSafeInteger(page.totalOutputs) || page.totalOutputs < 0) {
        throw new VaultError('no-transaction', 'Vault output listing returned an invalid total')
      }
      if (expectedTotal !== undefined && expectedTotal !== page.totalOutputs) {
        throw new VaultError('no-transaction', 'Vault output listing changed while it was being read')
      }
      expectedTotal = page.totalOutputs
    } else if (expectedTotal !== undefined) {
      throw new VaultError('no-transaction', 'Vault output listing dropped its total while it was being read')
    }
    const outputs: ListOutputsResult['outputs'] = []
    for (const rawOutput of page.outputs) {
      const canonicalOutpoint = canonicalVaultOutpoint(rawOutput.outpoint)
      if (seen.has(canonicalOutpoint)) {
        throw new VaultError('no-transaction', `Vault output listing repeated ${rawOutput.outpoint}`)
      }
      seen.add(canonicalOutpoint)
      outputs.push({ ...rawOutput, outpoint: canonicalOutpoint })
    }
    await onPage(outputs, page)
    if (page.outputs.length === 0) {
      if (expectedTotal !== undefined && offset < expectedTotal) {
        throw new VaultError('no-transaction', 'Vault output listing made no progress before its reported total')
      }
      break
    }
    offset += page.outputs.length
    if (expectedTotal !== undefined) {
      if (offset > expectedTotal) throw new VaultError('no-transaction', 'Vault output listing exceeded its reported total')
      if (offset === expectedTotal) break
      // Some storage providers return fewer rows than requested. A short page
      // is not the end while the authoritative total says rows remain.
      continue
    }
    if (page.outputs.length < VAULT_LIST_PAGE) break
  }
  return offset
}

/** An empty-basket safety decision needs one authoritative row, not every
 * locking script in the basket. A contradictory total still fails closed. */
async function vaultHasOutputs(
  w: VaultWallet,
  adminOriginator: string,
  scopeToken?: VaultScopeToken
): Promise<boolean> {
  assertVaultScope(scopeToken)
  const page = await w.listOutputs(
    { basket: VAULT_BASKET, include: 'locking scripts', includeCustomInstructions: true, limit: 1, offset: 0 },
    adminOriginator
  )
  assertVaultScope(scopeToken)
  if (!page || !Array.isArray(page.outputs)) {
    throw new VaultError('no-transaction', 'Vault output listing returned an invalid page')
  }
  if (
    page.totalOutputs !== undefined &&
    (!Number.isSafeInteger(page.totalOutputs) || page.totalOutputs < page.outputs.length)
  ) {
    throw new VaultError('no-transaction', 'Vault output listing returned an invalid total')
  }
  if (page.outputs.length > 1) {
    throw new VaultError('no-transaction', 'Vault output listing exceeded its requested limit')
  }
  if (page.outputs.length === 0 && (page.totalOutputs ?? 0) > 0) {
    throw new VaultError('no-transaction', 'Vault output listing made no progress before its reported total')
  }
  return page.outputs.length > 0
}

interface VerifiedVaultOutput {
  outpoint: string
  satoshis: number
  ci: VaultInstructions
  lockingScript: LockingScript
  /** The salt that authenticates `ci` against `lockingScript`: read directly
   * off a v6 record, or re-derived (never persisted) for a v7 one. Callers
   * that need to build a v7 witness (buildUnlock) use this instead of
   * `ci.salt`, which does not exist on a v7 record. */
  salt: string
}

/**
 * Resolve the salt that authenticates `ci`'s lock. v6 carries it directly in
 * the (untrusted) record; a separate later pass, verifyVaultSaltDerivations,
 * re-derives it from the wallet to confirm the claim wasn't fabricated. v7
 * carries no salt at all — it is always freshly re-derived here via the same
 * unchanged HMAC protocol, from fields the record does carry (saltKeyId and
 * the serial list), so there is no separate claim to falsify: deriving IS
 * the authentication.
 */
export async function resolveVaultSalt(w: VaultWallet, adminOriginator: string, ci: VaultInstructions): Promise<string> {
  if (ci.v === 6) return ci.salt
  return await deriveVaultSalt(w, adminOriginator, ci.saltKeyId, ci.keys.map(key => key.serial))
}

function verifyInstructionsAgainstLock(ci: VaultInstructions, lockingScript: LockingScript, where: string, salt: string): void {
  let baked: string[]
  try {
    baked = bakedCommitments(lockingScript)
  } catch {
    throw new VaultError('template-invalid', `${where} is not an R1C lock`)
  }
  const expected = ci.keys.map(key => commitment(key.pubkey, salt))
  if (baked.length !== expected.length || baked.some((c, i) => c !== expected[i])) {
    throw new VaultError('template-invalid', `${where} recovery metadata does not match its real lock`)
  }
  const rebuilt = buildLock({ commitments: expected, saltHex64: salt })
  if (rebuilt.toHex() !== lockingScript.toHex()) {
    throw new VaultError('template-invalid', `${where} recovery metadata does not rebuild its real lock`)
  }
}

/** Validate both the recoverability record and the real source output. The
 * customInstructions are an index; authorization comes only from the exact
 * commitments baked into the locking script carried by the BEEF. Async: a v7
 * record's salt is re-derived from the wallet (see resolveVaultSalt). */
async function verifyListedVaultOutput(
  w: VaultWallet,
  adminOriginator: string,
  output: ListOutputsResult['outputs'][number],
  sources: Beef
): Promise<VerifiedVaultOutput> {
  if (!Number.isSafeInteger(output.satoshis) || output.satoshis < 0) {
    throw new VaultError('no-transaction', `Vault output ${output.outpoint} has an invalid value`)
  }
  const ci = decodeVaultInstructions(output.customInstructions)
  if (!ci) throw new VaultError('template-invalid', `Vault output ${output.outpoint} has invalid recovery metadata`)
  const canonicalOutpoint = canonicalVaultOutpoint(output.outpoint)
  const [txid, voutText] = canonicalOutpoint.split('.')
  const vout = Number(voutText)
  const source = sources.findTxid(txid)?.tx?.outputs[vout]
  if (!source) throw new VaultError('no-transaction', `No source transaction for vault output ${output.outpoint}`)
  const sourceSatoshis = source.satoshis
  if (typeof sourceSatoshis !== 'number' || !Number.isSafeInteger(sourceSatoshis) || sourceSatoshis < 0) {
    throw new VaultError('no-transaction', `Vault output ${output.outpoint} source has an invalid value`)
  }
  if (sourceSatoshis !== output.satoshis) {
    throw new VaultError('no-transaction', `Vault output ${output.outpoint} value disagrees with its source transaction`)
  }
  const salt = await resolveVaultSalt(w, adminOriginator, ci)
  verifyInstructionsAgainstLock(ci, source.lockingScript, `Vault output ${output.outpoint}`, salt)
  return { outpoint: canonicalOutpoint, satoshis: sourceSatoshis, ci, lockingScript: source.lockingScript, salt }
}

function sumVaultSatoshis(outputs: readonly Pick<VerifiedVaultOutput, 'satoshis'>[], where: string): number {
  let sum = 0
  for (const output of outputs) {
    sum += output.satoshis
    if (!Number.isSafeInteger(sum)) throw new VaultError('no-transaction', `${where} value exceeds the safe integer range`)
  }
  return sum
}

interface VerifiedVaultScan<T> {
  state: T
  inventory: VaultSaltInventory
  outputs: number
}

/** Authenticate every current Vault output against its real source
 * transaction, reducing it immediately so page BEEF and 45 KB scripts can be
 * reclaimed. The compact inventory retains every distinct HMAC claim so each
 * output's wallet provenance is authenticated before the result is returned. */
async function reduceVerifiedVaultOutputs<T>(
  w: VaultWallet,
  adminOriginator: string,
  initial: () => T,
  reduce: (state: T, output: VerifiedVaultOutput, sources: Beef) => void,
  scopeToken?: VaultScopeToken,
  pendingMode: 'block' | 'repair-unsigned' | 'allow' = 'block'
): Promise<VerifiedVaultScan<T>> {
  const expectedChain = scopeToken?.chain ?? vaultStore.getScope()?.chain
  if (!expectedChain) throw new VaultError('not-enrolled', 'Wallet vault scope is not configured')
  const state = initial()
  const inventory = emptyVaultSaltInventory()
  const outputs = await scanVaultOutputPages(w, adminOriginator, 'entire transactions', async (listed, page) => {
    if (listed.length === 0) return
    if (!page.BEEF?.length) {
      throw new VaultError('no-transaction', 'Vault output listing did not include source transactions')
    }
    let sources: Beef
    try {
      sources = Beef.fromBinary(page.BEEF)
    } catch {
      throw new VaultError('no-transaction', 'Vault output listing returned malformed source transactions')
    }
    for (const listedOutput of listed) {
      const output = await verifyListedVaultOutput(w, adminOriginator, listedOutput, sources)
      rememberVaultSalt(inventory, output.ci, output.lockingScript, output.outpoint, expectedChain, output.salt)
      reduce(state, output, sources)
    }
  }, scopeToken)
  assertVaultScope(scopeToken)
  await verifyVaultSaltDerivations(w, adminOriginator, inventory)
  assertVaultScope(scopeToken)
  if (pendingMode !== 'allow') {
    const repaired = await inspectHiddenVaultReservations(
      w,
      adminOriginator,
      scopeToken,
      pendingMode === 'repair-unsigned'
    )
    if (repaired) {
      // abortAction restores the hidden source rows. Re-read and authenticate
      // them; a second reservation is blocked rather than retried forever.
      return await reduceVerifiedVaultOutputs(w, adminOriginator, initial, reduce, scopeToken, 'block')
    }
  }
  return { state, inventory, outputs }
}

const sameInstructionKeys = (a: readonly VaultKeyRecord[], b: Readonly<VaultInstructions['keys']>): boolean =>
  a.length === b.length && a.every((key, i) => (
    key.serial === b[i].serial &&
    key.slot === b[i].slot &&
    key.pubkey === b[i].pubkey &&
    key.nickname === b[i].nickname &&
    key.enrolledAt === b[i].enrolledAt
  ))

/** Refuse to combine two enrollments or use a cache older than an output. Old
 * revisions are expected until a re-lock, but the active revision must carry
 * the exact active key records that a new output would encode. */
function requireOutputMetaConsistency(outputs: readonly VerifiedVaultOutput[], meta: VaultMeta): void {
  for (const output of outputs) {
    const { ci } = output
    if (ci.vaultId !== meta.vaultId || ci.createdAt !== meta.createdAt) {
      throw new VaultError('template-invalid', 'Vault basket contains outputs from conflicting enrollments')
    }
    if (ci.revision > meta.revision) {
      throw new VaultError('template-invalid', 'Vault recovery metadata is newer than the local enrollment')
    }
    if (ci.revision === meta.revision && !sameInstructionKeys(meta.keys, ci.keys)) {
      throw new VaultError('template-invalid', 'Vault outputs disagree on the active key metadata')
    }
  }
}

const PENDING_ACTION_STATUSES = new Set(['unsigned', 'nosend', 'nonfinal', 'unprocessed', 'sending', 'unproven'])

/**
 * The pending statuses in which the transaction has already been handed to the
 * network: it has a txid and its outputs are ordinary unconfirmed UTXOs. These
 * are LIVE transactions, not reservations — `unprocessed` is deliberately
 * absent, because the toolbox advances a request to `sending` only once it has
 * actually posted it.
 */
const BROADCAST_ACTION_STATUSES = new Set(['sending', 'unproven'])

/** Authenticate pagination while consuming one action at a time. Detailed
 * action rows may contain several 45 KB source/output scripts, so callers must
 * retain only the small facts or references they need after this callback. */
async function scanVaultActions(
  w: VaultWallet,
  adminOriginator: string,
  details: Record<string, unknown>,
  onAction: (action: VaultActionRow) => void | Promise<void>,
  scopeToken?: VaultScopeToken,
  includeFailed = false
): Promise<void> {
  if (!w.listActions) throw new VaultError('no-transaction', 'Wallet cannot inspect pending vault actions')
  const seen = new Set<string>()
  const pageSize = details.includeInputSourceLockingScripts || details.includeOutputLockingScripts
    ? VAULT_SCRIPT_ACTION_PAGE
    : VAULT_ACTION_PAGE
  const scan = async (query: Record<string, unknown>): Promise<void> => {
    let expectedTotal: number | undefined
    let offset = 0
    for (;;) {
      assertVaultScope(scopeToken)
      const page = await w.listActions!({ labels: ['vault'], limit: pageSize, offset, ...query }, adminOriginator)
      assertVaultScope(scopeToken)
      const actions = page?.actions
      if (!Array.isArray(actions)) throw new VaultError('no-transaction', 'Vault action listing returned an invalid page')
      if (actions.length > pageSize) {
        throw new VaultError('no-transaction', 'Vault action listing exceeded its requested page size')
      }
      if (page.totalActions !== undefined) {
        if (!Number.isSafeInteger(page.totalActions) || page.totalActions < 0) {
          throw new VaultError('no-transaction', 'Vault action listing returned an invalid total')
        }
        if (expectedTotal !== undefined && expectedTotal !== page.totalActions) {
          throw new VaultError('no-transaction', 'Vault action listing changed while it was being read')
        }
        expectedTotal = page.totalActions
      } else if (expectedTotal !== undefined) {
        throw new VaultError('no-transaction', 'Vault action listing dropped its total while it was being read')
      }
      for (const action of actions) {
        const identity = action.reference ?? action.txid
        if (!identity) throw new VaultError('no-transaction', 'Vault action listing returned an unidentified row')
        if (seen.has(identity)) throw new VaultError('no-transaction', `Vault action listing repeated ${identity}`)
        seen.add(identity)
        await onAction(action)
      }
      if (actions.length === 0) {
        if (expectedTotal !== undefined && offset < expectedTotal) {
          throw new VaultError('no-transaction', 'Vault action listing made no progress before its reported total')
        }
        break
      }
      offset += actions.length
      if (expectedTotal !== undefined) {
        if (offset > expectedTotal) throw new VaultError('no-transaction', 'Vault action listing exceeded its reported total')
        if (offset === expectedTotal) break
        continue
      }
      if (actions.length < pageSize) break
    }
  }
  await scan(details)
  if (!includeFailed) return
  const ordinaryLabels = Array.isArray(details.labels) ? details.labels.filter(label => typeof label === 'string') : ['vault']
  await scan({ ...details, labels: [toolboxSdk.specOpFailedActions, ...ordinaryLabels] })
}

const actionClaimsVaultSpend = (action: VaultActionRow): boolean => {
  const labels = new Set(action.labels ?? [])
  return labels.has('vault-withdraw') || labels.has('vault-relock')
}

const actionTouchesVault = (action: VaultActionRow): boolean => {
  const labels = new Set(action.labels ?? [])
  return (
    labels.has('vault-deposit') ||
    actionClaimsVaultSpend(action) ||
    (action.outputs ?? []).some(output => output.basket === VAULT_BASKET) ||
    (action.inputs ?? []).some(input => isR1CSourceScript(input.sourceLockingScript))
  )
}

/**
 * Authenticate the action-history shape produced by depositToVault before it
 * is released from noSend. The unsigned/no-txid shape can be aborted. A signed
 * noSend shape remains a manual, fail-closed case because local status alone
 * cannot disprove an earlier ambiguous sendWith attempt.
 *
 * This deliberately authenticates the R1C output and constrains every other
 * output to one ordinary P2PKH change output before allowing abortAction. A
 * label by itself is never authority to mutate another action.
 */
async function isValidHeldVaultDeposit(
  w: VaultWallet,
  adminOriginator: string,
  action: VaultActionRow,
  meta: VaultMeta,
  expectedChain: VaultScopeToken['chain'],
  saltInventory?: VaultSaltInventory
): Promise<boolean> {
  const labels = new Set(action.labels ?? [])
  if (!labels.has('vault-deposit') || labels.has('vault-withdraw') || labels.has('vault-relock')) return false
  if (!action.reference) return false
  if (action.status === 'unsigned') {
    if (action.txid) return false
  } else if (action.status === 'nosend') {
    if (!action.txid || !/^[0-9a-fA-F]{64}$/.test(action.txid)) return false
  } else {
    return false
  }

  const inputs = action.inputs ?? []
  if (inputs.length === 0 || inputs.length > VAULT_HARD_MAX_INPUTS) return false
  for (const input of inputs) {
    if (!input.sourceOutpoint || !/^[0-9a-fA-F]{64}[.:]\d+$/.test(input.sourceOutpoint)) return false
    if (!Number.isSafeInteger(input.sourceSatoshis) || input.sourceSatoshis! < 0 || !input.sourceLockingScript) return false
    try {
      const sourceLock = LockingScript.fromHex(input.sourceLockingScript)
      if (isR1CSourceScript(input.sourceLockingScript) || !isStandardP2PKH(sourceLock)) return false
    } catch {
      return false
    }
  }

  const outputs = action.outputs ?? []
  if (outputs.length < 1 || outputs.length > 4) return false
  const indices = new Set<number>()
  for (const output of outputs) {
    if (!Number.isSafeInteger(output.outputIndex) || output.outputIndex < 0 || indices.has(output.outputIndex)) return false
    indices.add(output.outputIndex)
  }
  const vaultOutputs = outputs.filter(output => output.basket === VAULT_BASKET)
  if (vaultOutputs.length !== 1 || vaultOutputs[0].outputIndex !== 0) return false
  const output = vaultOutputs[0]
  if (!Number.isSafeInteger(output.satoshis) || output.satoshis < VAULT_DEPOSIT_MIN) return false
  if (!output.customInstructions || !output.lockingScript) return false
  const ci = decodeVaultInstructions(output.customInstructions)
  if (
    !ci ||
    ci.chain !== expectedChain ||
    ci.vaultId !== meta.vaultId ||
    ci.createdAt !== meta.createdAt ||
    ci.revision > meta.revision
  ) return false
  if (ci.revision === meta.revision && !sameInstructionKeys(meta.keys, ci.keys)) return false
  let lock: LockingScript
  let salt: string
  try {
    lock = LockingScript.fromHex(output.lockingScript)
    salt = await resolveVaultSalt(w, adminOriginator, ci)
    verifyInstructionsAgainstLock(ci, lock, 'Held Vault deposit', salt)
  } catch {
    return false
  }

  // v6: everything but the vault output is at most one ordinary P2PKH
  // implicit change output — UNCHANGED, since a v6-shaped held deposit can
  // still exist from a build predating this release.
  //
  // v7: the marker (index 1) and descriptor (index 2) are fixed, expected
  // outputs — authenticated the same byte-exact/decrypt-and-compare way the
  // creation-time validators check them — with at most one implicit P2PKH
  // change at index 3. Recognizing this shape (instead of falling through to
  // the v6 1-2-output cap) is what keeps a v7 deposit from wedging every
  // subsequent vault operation behind 'action-pending' after a crash.
  if (ci.v === 7) {
    if (outputs.length < 3 || outputs.length > 4) return false
    const markerOutput = outputs.find(candidate => candidate.outputIndex === 1)
    const descriptorOutput = outputs.find(candidate => candidate.outputIndex === 2)
    if (!markerOutput || !descriptorOutput) return false
    if (markerOutput.basket || descriptorOutput.basket) return false
    if (markerOutput.satoshis !== 1 || descriptorOutput.satoshis !== 0) return false
    if (!markerOutput.lockingScript || !descriptorOutput.lockingScript) return false
    try {
      const expectedMarker = await deriveVaultMarkerScript(w, adminOriginator, expectedChain, ci.saltKeyId)
      if (markerOutput.lockingScript.toLowerCase() !== expectedMarker.toHex().toLowerCase()) return false
      const parsedDescriptor = parseVaultDescriptorScript(LockingScript.fromHex(descriptorOutput.lockingScript))
      if (!parsedDescriptor) return false
      const descriptorPlaintext = await decryptVaultDescriptorPlaintext(
        w, adminOriginator, expectedChain, ci.saltKeyId, parsedDescriptor.ciphertext
      )
      if (descriptorPlaintext !== output.customInstructions) return false
    } catch {
      return false
    }
    const implicit = outputs.filter(candidate => candidate.outputIndex >= 3)
    if (implicit.length > 1) return false
    if (implicit.length === 1) {
      const change = implicit[0]
      if (!Number.isSafeInteger(change.satoshis) || change.satoshis <= 0 || !change.lockingScript) return false
      try {
        if (!isStandardP2PKH(LockingScript.fromHex(change.lockingScript))) return false
      } catch {
        return false
      }
    }
  } else {
    const implicit = outputs.filter(candidate => candidate !== output)
    if (implicit.length === 1) {
      const change = implicit[0]
      if (
        !Number.isSafeInteger(change.satoshis) ||
        change.satoshis <= 0 ||
        !change.lockingScript
      ) return false
      try {
        if (!isStandardP2PKH(LockingScript.fromHex(change.lockingScript))) return false
      } catch {
        return false
      }
    } else if (implicit.length > 1) {
      return false
    }
  }
  if (saltInventory) {
    rememberVaultSalt(
      saltInventory,
      ci,
      lock,
      vaultActionOutputId(action, output.outputIndex),
      expectedChain,
      salt
    )
  }
  return true
}

/**
 * Reconcile strictly authenticated deposit reservations left by a crash.
 * Unsigned/no-txid actions are provably unbroadcast and are aborted. Signed
 * noSend actions are never automatically sent or aborted: a crash may have
 * happened during sendWith, so either action could duplicate or conflict with
 * a transaction that already escaped. A deposit already posted to the network
 * (BROADCAST_ACTION_STATUSES) is not a reservation at all and is ignored.
 */
async function reconcileHeldVaultDeposits(
  w: VaultWallet,
  adminOriginator: string,
  meta: VaultMeta,
  scopeToken?: VaultScopeToken
): Promise<{ abortedUnsigned: number }> {
  const expectedChain = scopeToken?.chain ?? vaultStore.getScope()?.chain
  if (!expectedChain) throw new VaultError('not-enrolled', 'Wallet vault scope is not configured')
  const unsigned: string[] = []
  const saltInventory = emptyVaultSaltInventory()
  let signed = 0
  await scanVaultActions(w, adminOriginator, {
    labels: [],
    includeLabels: true,
    includeInputs: true,
    includeInputSourceLockingScripts: true,
    includeOutputs: true,
    includeOutputLockingScripts: true
  }, async action => {
    const labels = new Set(action.labels ?? [])
    if (!labels.has('vault-deposit') || action.status === 'completed' || action.status === 'failed') return
    // A deposit that reached the network is a live unconfirmed deposit, not a
    // held reservation: there is nothing to abort and nothing to reconcile,
    // and its vault output is authenticated on the ordinary listOutputs path
    // like any other. `unproven` is what the activity list shows as
    // "Accepted" and can stand for many minutes, so treating it as held would
    // block every vault transfer — including the re-lock the refusal asks
    // for — until the merkle proof arrives.
    if (BROADCAST_ACTION_STATUSES.has(action.status)) return
    if (
      !PENDING_ACTION_STATUSES.has(action.status) ||
      !(await isValidHeldVaultDeposit(w, adminOriginator, action, meta, expectedChain, saltInventory))
    ) {
      throw new VaultError('action-pending', 'A Vault deposit has an unknown or potentially broadcast state')
    }
    if (action.status === 'unsigned') unsigned.push(action.reference!)
    else signed++
  }, scopeToken)
  assertVaultScope(scopeToken)
  await verifyVaultSaltDerivations(w, adminOriginator, saltInventory)
  assertVaultScope(scopeToken)
  if (signed > 1) {
    throw new VaultError('action-pending', 'Multiple signed Vault deposits require manual reconciliation')
  }
  let abortedUnsigned = 0
  for (const reference of unsigned) {
    assertVaultScope(scopeToken)
    await w.abortAction({ reference }, adminOriginator)
    assertVaultScope(scopeToken)
    abortedUnsigned++
  }
  if (signed === 0) return { abortedUnsigned }
  throw new VaultError('action-pending', 'A signed Vault deposit needs manual broadcast-state reconciliation')
}

/** Whether the network already has `txid` ('mined' or 'known'), mirroring
 * storage/methods/processOfflineActions.ts' networkAlreadyHas exactly: no
 * status call, a transport fault, or an unexpected shape are all `false` —
 * never a reason to block the caller from re-broadcasting. */
async function vaultTxidAlreadyKnown(w: VaultWallet, txid: string): Promise<boolean> {
  try {
    if (typeof w.getStatusForTxids !== 'function') return false
    const r = await w.getStatusForTxids([txid])
    const status = r.results?.find(x => x.txid === txid)?.status
    return status === 'mined' || status === 'known'
  } catch {
    return false
  }
}

export type VaultDepositResolution =
  | { kind: 'broadcast' }
  | { kind: 'already-known' }
  | { kind: 'nothing-held' }
  | { kind: 'failed'; error: unknown }

/**
 * XR-006 / INT-03: the identical crash window exists for a withdrawal or
 * re-lock (spends existing R1C outputs) as for a deposit (creates one) — the
 * gap is between signAction and the sendWith that releases it. Unlike a
 * deposit's shape (one new vault output plus its marker/descriptor), a
 * withdraw/relock's OWN authority already comes from the hardware signature
 * already on these exact bytes; this only needs to correctly identify the
 * one held candidate to resend, not re-validate the full output plan. Every
 * input must be an authentic current R1C source (never an ordinary P2PKH
 * input, which would make this a deposit, not a spend) so a decoy action
 * cannot be resent as though it were the held vault spend.
 */
function isValidHeldVaultSpend(action: VaultActionRow): boolean {
  const labels = new Set(action.labels ?? [])
  if (!labels.has('vault-withdraw') && !labels.has('vault-relock')) return false
  if (!action.reference) return false
  if (action.status !== 'nosend' || !action.txid || !/^[0-9a-fA-F]{64}$/.test(action.txid)) return false
  const inputs = action.inputs ?? []
  if (inputs.length === 0 || inputs.length > VAULT_HARD_MAX_INPUTS) return false
  for (const input of inputs) {
    if (!input.sourceOutpoint || !/^[0-9a-fA-F]{64}[.:]\d+$/.test(input.sourceOutpoint)) return false
    if (!isR1CSourceScript(input.sourceLockingScript)) return false
  }
  return true
}

/**
 * Resolve the ONE held, signed (noSend) Vault action reconcileHeldVaultDeposits
 * refuses to touch automatically (F-04) — the crash window is between
 * signAction and the sendWith that releases it, so the transaction may or may
 * not have already escaped to the network. Covers both a held DEPOSIT
 * (creates a new R1C output) and a held WITHDRAWAL or RE-LOCK (spends
 * existing ones) — see isValidHeldVaultSpend: before XR-006/INT-03, only the
 * deposit shape was ever recognized here, so a crashed signed withdraw/
 * re-lock had no reconciliation path and froze every subsequent Vault read
 * via inspectHiddenVaultReservations indefinitely.
 *
 * Ask the network first. If it does not have the txid yet, release it with
 * the EXACT already-signed bytes via the same sendWith call depositToVault's
 * own release uses (~line 1764) — never a second transaction. If the network
 * already has it, there is nothing left to send; this is reported back as
 * `already-known` without calling sendWith at all, so a broadcaster that
 * rejects a resend of an already-mined transaction can never turn a resolved
 * deposit into a spurious failure. `abortAction` is never called here — only
 * reconcileHeldVaultDeposits' unsigned/no-txid branch may free inputs.
 */
export async function resolveHeldVaultDeposit(
  w: VaultWallet,
  adminOriginator: string,
  meta: VaultMeta,
  scopeToken?: VaultScopeToken
): Promise<VaultDepositResolution> {
  const captured = scopeToken ?? vaultStore.captureScopeToken()
  return await withVaultMutation(async () => {
    try {
      const expectedChain = captured.chain ?? vaultStore.getScope()?.chain
      if (!expectedChain) throw new VaultError('not-enrolled', 'Wallet vault scope is not configured')
      let held: VaultActionRow | undefined
      await scanVaultActions(w, adminOriginator, {
        labels: [],
        includeLabels: true,
        includeInputs: true,
        includeInputSourceLockingScripts: true,
        includeOutputs: true,
        includeOutputLockingScripts: true
      }, async action => {
        if (action.status === 'unsigned') return
        if (!PENDING_ACTION_STATUSES.has(action.status) || BROADCAST_ACTION_STATUSES.has(action.status)) return
        if (await isValidHeldVaultDeposit(w, adminOriginator, action, meta, expectedChain)) {
          held = action
        } else if (isValidHeldVaultSpend(action)) {
          held = action
        }
      }, captured)
      assertVaultScope(captured)
      if (!held?.txid) return { kind: 'nothing-held' }
      const txid = held.txid
      if (await vaultTxidAlreadyKnown(w, txid)) return { kind: 'already-known' }
      const labels = new Set(held.labels ?? [])
      const isSpend = labels.has('vault-withdraw') || labels.has('vault-relock')
      const description = isSpend ? 'Vault transfer' : 'Vault deposit'
      assertVaultScope(captured)
      const released = await w.createAction(
        { description: `Broadcast ${description}`, options: { sendWith: [txid] } },
        adminOriginator
      )
      assertVaultScope(captured)
      requireReleasedHeldTransaction(released, txid, description)
      return { kind: 'broadcast' }
    } catch (error) {
      return { kind: 'failed', error }
    }
  })
}

/** Return true only for an exact current R1C lock. */
function isR1CSourceScript(scriptHex: string | undefined): boolean {
  if (!scriptHex) return false
  try {
    const lock = LockingScript.fromHex(scriptHex)
    const commitments = bakedCommitments(lock)
    return commitments.length >= 1 && commitments.length <= 5
  } catch {
    return false
  }
}

/**
 * listOutputs exposes only spendable rows, so a reservation can otherwise
 * make a Vault source disappear from balances and safety decisions. Scan all
 * action labels and authenticate source scripts instead. A strictly unsigned,
 * txid-less action is provably unbroadcast and may be aborted to restore its
 * sources; a signed but unposted state (nosend, unprocessed, nonfinal) or a
 * malformed one blocks. An action already posted to the network holds nothing
 * back — see BROADCAST_ACTION_STATUSES at the skip below.
 */
async function inspectHiddenVaultReservations(
  w: VaultWallet,
  adminOriginator: string,
  scopeToken: VaultScopeToken | undefined,
  repairUnsigned: boolean
): Promise<boolean> {
  const abortable: string[] = []
  await scanVaultActions(w, adminOriginator, {
    labels: [],
    includeLabels: true,
    includeInputs: true,
    includeInputSourceLockingScripts: true
  }, action => {
    // Completed history cannot reserve or hide an output. Ignore it before
    // interpreting old labels or source scripts; pre-release Vault actions
    // may use a different template and are not recovery authority.
    if (action.status === 'completed') return
    const inputs = action.inputs ?? []
    const r1cInputs = inputs.filter(input => isR1CSourceScript(input.sourceLockingScript))
    const claimsVaultSpend = actionClaimsVaultSpend(action)
    if (claimsVaultSpend && (inputs.length === 0 || r1cInputs.length !== inputs.length)) {
      throw new VaultError('template-invalid', 'Vault action history has missing or malformed R1C source scripts')
    }
    if (r1cInputs.length === 0) return
    for (const input of r1cInputs) {
      if (
        input.sourceSatoshis !== undefined &&
        (!Number.isSafeInteger(input.sourceSatoshis) || input.sourceSatoshis < 0)
      ) {
        throw new VaultError('no-transaction', 'Vault action history has an invalid source value')
      }
    }
    if (repairUnsigned && action.status === 'unsigned' && !action.txid && action.reference && r1cInputs.length === inputs.length) {
      abortable.push(action.reference)
      return
    }
    // A spend already posted to the network is not holding its source back: it
    // has SPENT it, listOutputs is right to omit it, and whatever the spend
    // created is listed in its place. Blocking here would fail every balance
    // read, coverage check and transfer for as long as the spend sits at
    // 'unproven' — and, because the transfer screen waits for the balance to
    // settle, would report a completed withdrawal as a failure.
    if (BROADCAST_ACTION_STATUSES.has(action.status)) return
    throw new VaultError('action-pending', 'A pending or failed action is holding a Vault output')
  }, scopeToken)
  for (const reference of abortable) {
    assertVaultScope(scopeToken)
    await w.abortAction({ reference }, adminOriginator)
    assertVaultScope(scopeToken)
  }
  return abortable.length > 0
}

/** Include every current-format vault output in full action history. Active
 * listOutputs covers imported/recovered coins; history also covers spent and
 * completed outputs, preserving the wallet-scoped never-reuse invariant when
 * a local counter would otherwise repeat. Pending rows close the
 * pre-listOutputs visibility window. */
interface VaultSaltInventory {
  derivationClaims: Map<string, { saltKeyId: string; serials: string[]; salt: string }>
  outputFingerprints: Map<string, string>
  outputRecords: Map<string, { lockingScript: string; pubkeys: Set<string> }>
  maxKeyIndex: number
}

function emptyVaultSaltInventory(): VaultSaltInventory {
  return {
    derivationClaims: new Map(),
    outputFingerprints: new Map(),
    outputRecords: new Map(),
    maxKeyIndex: 0
  }
}

/** Stable identity for a Vault output represented in action history. */
function vaultActionOutputId(action: VaultActionRow, outputIndex: number): string {
  if (!Number.isSafeInteger(outputIndex) || outputIndex < 0) {
    throw new VaultError('template-invalid', 'Vault action history contains an invalid output index')
  }
  const actionId = typeof action.txid === 'string' && /^[0-9a-fA-F]{64}$/.test(action.txid)
    ? action.txid.toLowerCase()
    : action.reference
      ? `ref:${action.reference}`
      : undefined
  if (!actionId) throw new VaultError('template-invalid', 'Vault action history output has no stable transaction identity')
  return `${actionId}.${outputIndex}`
}

function saltKeyIndex(ci: VaultInstructions): number {
  const value = Number(ci.saltKeyId)
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new VaultError('template-invalid', 'Vault output has an invalid salt key index')
  }
  return value
}

/** Canonical serialisation for either version, used only to fingerprint an
 * already-authenticated record (never persisted). */
function encodeVaultInstructionsAny(ci: VaultInstructions): string {
  return ci.v === 6 ? encodeVaultInstructions(ci) : encodeVaultInstructionsV7(ci)
}

/**
 * Remember one authenticated output's salt-derivation facts. `salt` is the
 * value ALREADY confirmed (by the caller) to authenticate `ci` against
 * `lock` — see resolveVaultSalt. For v6 this is still recorded as a
 * `derivationClaims` entry: v6's stored salt is an untrusted claim inside
 * `ci`, and a separate later pass (verifyVaultSaltDerivations) independently
 * re-derives it from the wallet to confirm it wasn't fabricated, before it
 * may advance `maxKeyIndex`'s trust. v7 has no separate claim to falsify —
 * `salt` was already derived directly from the wallet by resolveVaultSalt, so
 * deriving it WAS the authentication, and no claim needs re-verifying.
 */
function rememberVaultSalt(
  inventory: VaultSaltInventory,
  ci: VaultInstructions,
  lock: LockingScript,
  outputId: string,
  expectedChain: VaultScopeToken['chain'],
  salt: string
): void {
  if (ci.chain !== expectedChain) {
    throw new VaultError('template-invalid', 'Vault output belongs to a different network')
  }
  const scriptHash = Utils.toHex(Hash.sha256(lock.toBinary()))
  const outputFingerprint = Utils.toHex(Hash.sha256(Utils.toArray(
    `${scriptHash}\u0000${encodeVaultInstructionsAny(ci)}`,
    'utf8'
  ) as number[]))
  const knownOutput = inventory.outputFingerprints.get(outputId)
  if (knownOutput !== undefined && knownOutput !== outputFingerprint) {
    throw new VaultError('template-invalid', 'One Vault output has conflicting authenticated representations')
  }
  if (ci.v === 6) {
    const serials = ci.keys.map(key => key.serial)
    const claimId = JSON.stringify([ci.saltKeyId, Utils.toHex(vaultSaltHmacData(serials)), salt])
    inventory.derivationClaims.set(claimId, { saltKeyId: ci.saltKeyId, serials, salt })
  }
  inventory.outputFingerprints.set(outputId, outputFingerprint)
  inventory.outputRecords.set(outputId.toLowerCase(), {
    lockingScript: lock.toHex(),
    pubkeys: new Set(ci.keys.map(key => key.pubkey))
  })
  inventory.maxKeyIndex = Math.max(inventory.maxKeyIndex, saltKeyIndex(ci))
}

/** Derive one canonical 32-byte wallet HMAC under the exact Vault domain. */
export async function deriveVaultSalt(
  w: VaultWallet,
  adminOriginator: string,
  saltKeyId: string,
  serials: readonly string[]
): Promise<string> {
  try {
    const derived = await w.createHmac({
      protocolID: [...VAULT_SALT_PROTOCOL],
      keyID: saltKeyId,
      counterparty: 'self',
      data: vaultSaltHmacData(serials),
      seekPermission: false
    }, adminOriginator)
    const hmac = derived.hmac
    if (
      !Array.isArray(hmac) || hmac.length !== SALT_BYTES ||
      hmac.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 0xff)
    ) {
      throw new Error('non-canonical HMAC')
    }
    return Utils.toHex(hmac)
  } catch {
    throw new VaultError('template-invalid', 'Wallet could not derive a canonical Vault salt HMAC')
  }
}

/** Do not let unauthenticated derivation metadata choose the next HD index.
 * Every current or historical key ID and ordered serial list must reproduce
 * its recorded HMAC salt before its index may advance the high-water mark. */
async function verifyVaultSaltDerivations(
  w: VaultWallet,
  adminOriginator: string,
  inventory: VaultSaltInventory
): Promise<void> {
  for (const claim of inventory.derivationClaims.values()) {
    const actualSalt = await deriveVaultSalt(w, adminOriginator, claim.saltKeyId, claim.serials)
    if (actualSalt !== claim.salt) {
      throw new VaultError('template-invalid', `Vault salt derivation ${claim.saltKeyId} does not belong to this wallet`)
    }
  }
}

async function addHistoricalVaultSaltInventory(
  w: VaultWallet,
  adminOriginator: string,
  inventory: VaultSaltInventory,
  meta: VaultMeta,
  scopeToken?: VaultScopeToken
): Promise<void> {
  const expectedChain = scopeToken?.chain ?? vaultStore.getScope()?.chain
  if (!expectedChain) throw new VaultError('not-enrolled', 'Wallet vault scope is not configured')
  await scanVaultActions(w, adminOriginator, {
    labels: [],
    includeOutputs: true,
    includeOutputLockingScripts: true
  }, async action => {
    for (const output of action.outputs ?? []) {
      if (output.basket !== VAULT_BASKET) continue
      const ci = decodeVaultInstructions(output.customInstructions)
      if (!ci || !output.lockingScript) {
        throw new VaultError('template-invalid', 'Vault history contains unreadable recovery metadata or script')
      }
      let lock: LockingScript
      try {
        lock = LockingScript.fromHex(output.lockingScript)
      } catch {
        throw new VaultError('template-invalid', 'Vault history contains a malformed locking script')
      }
      const salt = await resolveVaultSalt(w, adminOriginator, ci)
      verifyInstructionsAgainstLock(ci, lock, 'Vault history output', salt)
      // Salt/script reuse is wallet-global, so retain valid history from prior
      // enrollments after a drained Vault is disabled and set up again. Only a
      // record claiming the current enrollment ID must agree with its immutable
      // creation time, may not be newer than the local active revision, and
      // must carry the active ordered key set when revisions are equal.
      if (
        ci.vaultId === meta.vaultId &&
        (
          ci.createdAt !== meta.createdAt ||
          ci.revision > meta.revision ||
          (ci.revision === meta.revision && !sameInstructionKeys(meta.keys, ci.keys))
        )
      ) {
        throw new VaultError('template-invalid', 'Vault history conflicts with the active vault enrollment')
      }
      rememberVaultSalt(inventory, ci, lock, vaultActionOutputId(action, output.outputIndex), expectedChain, salt)
    }
  }, scopeToken, true)
  assertVaultScope(scopeToken)
  await verifyVaultSaltDerivations(w, adminOriginator, inventory)
  assertVaultScope(scopeToken)
}

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
  opts: { includeInputs?: boolean; stopAfter: number },
  scopeToken?: VaultScopeToken
): Promise<number> {
  if (!w.listActions) return 0
  let scanned = 0
  const seen: string[] = []
  const seenRows = new Set<string>()
  // References this scan has already attempted, so the same orphan is never
  // aborted twice — a second abortAction on it would be rejected regardless
  // of the first attempt's outcome.
  const attempted = new Set<string>()
  // Only references whose abortAction call actually SUCCEEDED. A refused or
  // rejected abort never released the input, so it must not be counted as
  // freed — the caller (freeReservedInputs) uses this size to decide whether
  // a retry can proceed, and a miscount here would retry against an input
  // that is still genuinely reserved.
  const aborted = new Set<string>()
  try {
    let offset = 0
    let expectedTotal: number | undefined
    while (aborted.size < opts.stopAfter) {
      assertVaultScope(scopeToken)
      const res = await w.listActions(
        { labels: [], limit: 200, offset, ...(opts.includeInputs ? { includeInputs: true } : {}) },
        adminOriginator
      )
      assertVaultScope(scopeToken)
      const actions = res.actions ?? []
      if (res.totalActions !== undefined) {
        if (!Number.isSafeInteger(res.totalActions) || res.totalActions < 0) throw new Error('invalid action total')
        if (expectedTotal !== undefined && expectedTotal !== res.totalActions) throw new Error('action total changed')
        expectedTotal = res.totalActions
      } else if (expectedTotal !== undefined) {
        throw new Error('action total disappeared')
      }
      if (actions.length === 0) {
        if (expectedTotal !== undefined && offset < expectedTotal) throw new Error('action listing made no progress')
        break
      }
      scanned += actions.length
      for (let i = 0; i < actions.length; i++) {
        const a = actions[i]
        const rowId = a.reference ?? a.txid
        if (!rowId || seenRows.has(rowId)) throw new Error(`action listing repeated or omitted identity at ${offset + i}`)
        seenRows.add(rowId)
        if (!matches(a)) continue
        seen.push(`${a.status}${a.reference ? '' : '/no-ref'}`)
        if (a.reference && ABORTABLE.has(a.status) && !attempted.has(a.reference)) {
          attempted.add(a.reference)
          assertVaultScope(scopeToken)
          try {
            await w.abortAction({ reference: a.reference }, adminOriginator)
            aborted.add(a.reference)
          } catch (err) {
            console.log('[vault] abortAction rejected:', (err as Error)?.message)
          }
          assertVaultScope(scopeToken)
        }
      }
      offset += actions.length
      if (expectedTotal !== undefined) {
        if (offset > expectedTotal) throw new Error('action listing exceeded its total')
        if (offset === expectedTotal) break
      } else if (actions.length < 200) {
        break
      }
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
async function abortReservingTxids(
  w: VaultWallet,
  adminOriginator: string,
  txids: string[],
  scopeToken?: VaultScopeToken
): Promise<number> {
  if (txids.length === 0) return 0
  const want = new Set(txids)
  return await abortActions(w, adminOriginator, a => a.txid != null && want.has(a.txid), { stopAfter: want.size }, scopeToken)
}

/** Abort the orphaned transactions holding these outpoints, matched on each
 * action's own input list — the only handle available when the reservation has
 * no txid to blame. */
async function abortReservingOutpoints(
  w: VaultWallet,
  adminOriginator: string,
  outpoints: string[],
  findSpendingReferences?: SpendingReferenceLookup,
  scopeToken?: VaultScopeToken
): Promise<number> {
  if (outpoints.length === 0) return 0

  // One indexed query when storage is reachable. The scan below answers the
  // same question by paging up to 5,000 actions with includeInputs, and
  // listActionsSql answers each page by loading every action's full rawTx and
  // running Transaction.fromBinary on it to read a sequence number — so a vault
  // retry parsed thousands of transactions to find one outpoint.
  if (findSpendingReferences) {
    try {
      assertVaultScope(scopeToken)
      const rows = await findSpendingReferences(outpoints)
      assertVaultScope(scopeToken)
      const attempted = new Set<string>()
      const aborted = new Set<string>()
      for (const r of rows) {
        if (!ABORTABLE.has(r.status) || attempted.has(r.reference)) continue
        attempted.add(r.reference)
        assertVaultScope(scopeToken)
        try {
          await w.abortAction({ reference: r.reference }, adminOriginator)
          aborted.add(r.reference)
        } catch (err) {
          console.log('[vault] abortAction rejected:', (err as Error)?.message)
        }
        assertVaultScope(scopeToken)
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
    // several orphans can each hold one. Pagination is guarded by row identity
    // and the provider's stable total rather than an arbitrary page cap.
    { includeInputs: true, stopAfter: Number.POSITIVE_INFINITY },
    scopeToken
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
 *
 * Exported (XQ-016 review follow-up) ONLY so its interaction with the real,
 * non-mocked vendor `abortAction` can be exercised directly —
 * __tests__/vault/xq016VaultAbortRealVendorInteraction.test.ts. `ABORTABLE`
 * above includes `'nosend'`, and this function (via `abortReservingOutpoints`
 * / `abortActions`) is reachable from the live withdrawal-creation retry path
 * in `createSignableVaultTx`, so it DOES call the vendor's `abortAction` on a
 * real signed `nosend` orphan — see that test for the verified behavior.
 * Every other caller in this module still calls it unexported-style, from
 * within the same module scope; this export adds no new call site.
 */
export async function freeReservedInputs(
  w: VaultWallet,
  adminOriginator: string,
  e: unknown,
  ours: string[],
  findSpendingReferences?: SpendingReferenceLookup,
  scopeToken?: VaultScopeToken
): Promise<number> {
  if (isReviewActionsError(e)) {
    return await abortReservingTxids(w, adminOriginator, competingTxids(e), scopeToken)
  }
  const mine = new Set(ours.map(sameOutpoint))
  const wedged = unspendableInputOutpoints(e).filter(o => mine.has(o))
  return await abortReservingOutpoints(w, adminOriginator, wedged, findSpendingReferences, scopeToken)
}

/**
 * Refuse a vault transfer while offline.
 *
 * Checked before anything else, including before a withdrawal arms the
 * YubiKey: an offline user must not be asked to present a key for a transfer
 * that cannot proceed.
 */
async function requireOnline(opts?: VaultTransferOptions): Promise<void> {
  if (!opts?.isOnline) return
  if (!(await opts.isOnline())) {
    throw new VaultError('requires-online', 'Vault transfers need a connection')
  }
}

// ── balance ─────────────────────────────────────────────────────────────

/**
 * Sum of every strictly authenticated current-format output in the basket.
 * Missing instructions, malformed data, source-value mismatches, and locks
 * that do not exactly match their records fail the whole scan closed.
 * includeCustomInstructions is required: listOutputs omits the field unless
 * asked, and without it everything would read as undecodable.
 */
export async function getVaultBalance(w: VaultWallet, adminOriginator: string): Promise<number> {
  const scopeToken = vaultStore.captureScopeToken()
  const { state } = await reduceVerifiedVaultOutputs(
    w,
    adminOriginator,
    () => ({ satoshis: 0 }),
    (balance, output) => {
      balance.satoshis += output.satoshis
      if (!Number.isSafeInteger(balance.satoshis)) {
        throw new VaultError('no-transaction', 'Vault balance value exceeds the safe integer range')
      }
    },
    scopeToken
  )
  assertVaultScope(scopeToken)
  return state.satoshis
}

/** Restore a missing scoped cache only from currently spendable outputs whose
 * real source values, exact R1C locks, salted commitments, v6 recovery records, and
 * wallet salt-key derivations all authenticate. Conflict selection belongs to
 * VaultKeyService; possession of a restored key is still required separately
 * before any spend. */
/** F-06: whether a scan-derived record should replace an existing local one —
 * a strictly higher revision, or the same revision naming a strict superset
 * of the existing key set (a partial local record catching up to what chain
 * evidence already shows). Anything else (equal, older, or merely
 * different) keeps the existing record: this is a one-way ratchet, never a
 * merge or an overwrite by a same-revision disagreement. */
function recoveredSupersedesExisting(existing: VaultMeta, recovered: VaultMeta): boolean {
  if (recovered.revision > existing.revision) return true
  if (recovered.revision < existing.revision) return false
  const existingKeys = new Set(existing.keys.map(k => k.pubkey))
  const recoveredKeys = new Set(recovered.keys.map(k => k.pubkey))
  if (recoveredKeys.size <= existingKeys.size) return false
  for (const pubkey of existingKeys) {
    if (!recoveredKeys.has(pubkey)) return false
  }
  return true
}

/** Restore a missing scoped cache only from currently spendable outputs whose
 * real source values, exact R1C locks, salted commitments, v6 recovery records, and
 * wallet salt-key derivations all authenticate. Conflict selection belongs to
 * VaultKeyService; possession of a restored key is still required separately
 * before any spend.
 *
 * F-06: an existing local record is no longer trusted unconditionally — a
 * post-reinstall SecureStore snapshot (WHEN_UNLOCKED_THIS_DEVICE_ONLY items
 * survive app deletion on iOS) can be stale relative to what chain outputs
 * now show. The SAME authenticated scan the no-record branch always ran now
 * always runs; the existing record is kept only when it is not superseded
 * (recoveredSupersedesExisting), and restored the same way — through
 * vaultStore.restoreVerifiedMeta — when it is. */
export async function recoverVaultMetaFromOutputs(
  w: VaultWallet,
  adminOriginator: string
): Promise<VaultMeta | null> {
  const scopeToken = vaultStore.captureScopeToken()
  return await withVaultMutation(async () => {
    assertVaultScope(scopeToken)
    const existing = await vaultStore.getMeta(scopeToken)
    const scan = await reduceVerifiedVaultOutputs(
      w,
      adminOriginator,
      () => [] as { instructions: VaultInstructions; txid: string }[],
      (records, output) => records.push({
        instructions: output.ci,
        txid: output.outpoint.slice(0, 64).toLowerCase()
      }),
      scopeToken
    )
    if (scan.outputs === 0) return existing
    await verifyVaultSaltDerivations(w, adminOriginator, scan.inventory)
    const recovered = metaFromVerifiedOutputs(scan.state)
    if (existing && !recoveredSupersedesExisting(existing, recovered)) return existing
    const scope = vaultStore.getScope()
    await vaultStore.restoreVerifiedMeta(
      recovered,
      scopeToken,
      scope ? next => computeVaultMetaAuthorityTag(asHmacWallet(w), adminOriginator, next, scope) : undefined
    )
    return await vaultStore.getMeta(scopeToken)
  })
}

/**
 * XR-002 (SEC2-088): the gate every operation that builds a NEW R1C output
 * from local vault metadata must pass first — `meta.keys`/`meta.revision`
 * become that output's lock directly (newVaultOutput). A SecureStore-only
 * attacker who forges a higher revision or a substituted key set cannot
 * compute metaAuthority.ts's wallet-root tag, so a mismatch here means
 * `meta` was never written by this package's own legitimate code.
 *
 * A missing/invalid tag is not immediately fatal — it is exactly the state
 * every enrollment created before this fix shipped is in. Recover instead of
 * refusing outright, using the SAME authenticated on-chain scan
 * recoverVaultMetaFromOutputs already uses, but with STRICT equality (never
 * the "supersedes" ratchet, which exists for a different problem — a stale
 * local cache after reinstall — and would let a forged revision that happens
 * to be LOWER than real chain evidence slip through as "not superseded,
 * keep it"): if a verified on-chain output for this exact vaultId proves
 * `meta` byte-for-byte, adopt it and tag it going forward
 * (vaultStore.restoreVerifiedMeta). Chain evidence that DISAGREES, or a
 * vault with no chain evidence at all yet (a genuinely first-ever deposit,
 * which legitimately shipped code always tags immediately at
 * finalizeEnrollment), is the "never silently trust-on-first-use when a
 * safer route exists" case: refuse and point at the safer route already
 * available — disable (offered exactly at this zero-balance state) and
 * re-enroll, which produces a freshly, correctly tagged record.
 *
 * Deliberately NEVER called for withdrawing an EXISTING output: that spend's
 * authority is the output's own REAL R1C lock, independently verified
 * against chain-listed BEEF (verifyListedVaultOutput / spendVaultOutputs) —
 * never local meta. Gating a plain withdrawal here would block access to
 * funds I1 requires stay reachable, over data that was never load-bearing
 * for that spend in the first place.
 */
export async function requireAuthenticatedMeta(
  w: VaultWallet,
  adminOriginator: string,
  scopeToken: VaultScopeToken,
  meta: VaultMeta
): Promise<VaultMeta> {
  assertVaultScope(scopeToken)
  const scope = vaultStore.getScope()
  if (!scope) throw new VaultError('not-enrolled', 'Wallet vault scope is not configured')
  const tag = await vaultStore.getMetaTag(scopeToken)
  if (await verifyVaultMetaAuthorityTag(asHmacWallet(w), adminOriginator, meta, scope, tag)) return meta

  const scan = await reduceVerifiedVaultOutputs(
    w,
    adminOriginator,
    () => [] as { instructions: VaultInstructions; txid: string }[],
    (records, output) => {
      if (output.ci.vaultId !== meta.vaultId) return
      records.push({ instructions: output.ci, txid: output.outpoint.slice(0, 64).toLowerCase() })
    },
    scopeToken
  )
  if (scan.state.length === 0) {
    throw new VaultError(
      'template-invalid',
      'Vault enrollment metadata could not be authenticated and has no on-chain history to verify it against; disable and re-enroll this vault'
    )
  }
  await verifyVaultSaltDerivations(w, adminOriginator, scan.inventory)
  const recovered = metaFromVerifiedOutputs(scan.state)
  if (
    recovered.vaultId !== meta.vaultId ||
    recovered.createdAt !== meta.createdAt ||
    recovered.revision !== meta.revision ||
    !sameInstructionKeys(meta.keys, recovered.keys)
  ) {
    throw new VaultError(
      'template-invalid',
      'Local vault enrollment metadata disagrees with authenticated on-chain history; re-verify before continuing'
    )
  }
  await vaultStore.restoreVerifiedMeta(recovered, scopeToken, next =>
    computeVaultMetaAuthorityTag(asHmacWallet(w), adminOriginator, next, scope)
  )
  const reconciled = await vaultStore.getMeta(scopeToken)
  if (!reconciled) throw new VaultError('not-enrolled', 'Vault is not set up')
  return reconciled
}

/**
 * Clear authorization metadata only after an authoritative, serialized empty
 * check. In addition to spendable outputs, any non-final vault action blocks
 * disablement: a signed withdrawal/re-lock may temporarily reserve its source
 * while its replacement is not listable yet.
 *
 * Returns false for a funded or pending vault and leaves metadata untouched.
 * Read errors throw and therefore also fail closed.
 */
export async function disableVaultWhenSafe(
  w: VaultWallet,
  adminOriginator: string,
  clearMetadata: (scopeToken?: VaultScopeToken) => Promise<void>
): Promise<boolean> {
  const scopeToken = vaultStore.captureScopeToken()
  return await withVaultMutation(async () => {
    assertVaultScope(scopeToken)
    const meta = await vaultStore.getMeta(scopeToken)
    if (!meta || meta.pendingRemoval) return false
    await reconcileHeldVaultDeposits(w, adminOriginator, meta, scopeToken)
    if (await vaultHasOutputs(w, adminOriginator, scopeToken)) return false

    let blocked = false
    await scanVaultActions(w, adminOriginator, {
      labels: [],
      includeLabels: true,
      includeInputs: true,
      includeInputSourceLockingScripts: true,
      includeOutputs: true,
      includeOutputLockingScripts: true
    }, async action => {
      const labels = new Set(action.labels ?? [])
      const inputs = action.inputs ?? []
      const r1cInputs = inputs.filter(input => isR1CSourceScript(input.sourceLockingScript))
      const claimsSpend = actionClaimsVaultSpend(action)
      // A posted transaction (BROADCAST_ACTION_STATUSES) reserves nothing this
      // check cannot already see: it has a txid and its outputs are ordinary
      // unconfirmed UTXOs, which is why reconcileHeldVaultDeposits skips the
      // same statuses. Only a signed-but-unposted action can hold a Vault
      // source back invisibly, and `unproven` can stand for hours — or never
      // resolve locally — so treating it as live refuses a drained Vault its
      // disablement for as long as the merkle proof is missing.
      const reserving =
        PENDING_ACTION_STATUSES.has(action.status) && !BROADCAST_ACTION_STATUSES.has(action.status)
      // Only a live action can still be holding a Vault source back, and its
      // source scripts are evidence for that decision only while it is live.
      // Settled history cannot satisfy this rule and must not be asked to:
      // storage RESTORES the sources of a terminally failed action and clears
      // their `spentBy`, which is exactly what empties `inputs` here, and
      // completed pre-release spends predate this template (see
      // inspectHiddenVaultReservations). Demanding exact R1C sources from
      // either shape reads an ordinary drained history as malformed and
      // refuses to disable an empty Vault for good.
      if (reserving && claimsSpend && (inputs.length === 0 || r1cInputs.length !== inputs.length)) {
        throw new VaultError('template-invalid', 'Vault action history has missing or malformed R1C source scripts')
      }
      const vaultOutputs = (action.outputs ?? []).filter(output => output.basket === VAULT_BASKET)
      for (const output of vaultOutputs) {
        const ci = decodeVaultInstructions(output.customInstructions)
        if (!ci || !output.lockingScript) {
          throw new VaultError('template-invalid', 'Vault action history has unreadable output metadata or script')
        }
        if (ci.chain !== scopeToken.chain) {
          throw new VaultError('template-invalid', 'Vault action history output belongs to a different network')
        }
        let lock: LockingScript
        try {
          lock = LockingScript.fromHex(output.lockingScript)
        } catch {
          throw new VaultError('template-invalid', 'Vault action history has a malformed output script')
        }
        const salt = await resolveVaultSalt(w, adminOriginator, ci)
        verifyInstructionsAgainstLock(ci, lock, 'Vault action history output', salt)
      }
      const touchesVault =
        r1cInputs.length > 0 ||
        vaultOutputs.length > 0 ||
        labels.has('vault-withdraw') ||
        labels.has('vault-relock') ||
        labels.has('vault-deposit')
      if (reserving && touchesVault) blocked = true
      if (action.status === 'failed') {
        // A failed deposit has no Vault source to hide. A failed spend still
        // listing inputs has NOT been unwound — storage drops `spentBy` in the
        // same write that makes the source spendable again — so it may still
        // be hiding a Vault output from listOutputs, and labels/scripts that
        // cannot classify it fail closed the same way. A failed spend listing
        // no inputs at all is holding nothing back, and the authoritative
        // empty check is then the only word that counts.
        if (r1cInputs.length > 0 || (claimsSpend && inputs.length > 0)) {
          blocked = true
        }
      }
    }, scopeToken, true)
    if (blocked) return false
    // A completed output can be absent from listOutputs but still be the only
    // durable recovery record for this enrollment. Authenticate every history
    // HMAC before allowing its local descriptor to be cleared.
    await addHistoricalVaultSaltInventory(
      w,
      adminOriginator,
      emptyVaultSaltInventory(),
      meta,
      scopeToken
    )
    // The monitor is outside the JS mutex. Re-read immediately before the
    // destructive metadata clear so an output that became visible during the
    // action scan blocks the operation.
    if (await vaultHasOutputs(w, adminOriginator, scopeToken)) return false
    assertVaultScope(scopeToken)
    await clearMetadata(scopeToken)
    assertVaultScope(scopeToken)
    return true
  })
}

// ── vault outputs ────────────────────────────────────────────────────────

/**
 * One new vault output committed to `keys` (spec §4.1 step 3, §2.7), plus its
 * v7 marker and encrypted descriptor (design v7 §1.2 item 2). New creations
 * are v7 only — existing v6 outputs are unaffected and keep working through
 * the unchanged v6 read path.
 *
 * Each salt is the wallet's 32-byte createHmac result under the next positive
 * decimal key ID, with the ordered YubiKey serial list as canonically framed
 * input — UNCHANGED from v6, and never persisted for v7: it is derived here,
 * used to build the lock, and then dropped. A unique key ID normally makes
 * commitments and script hashes distinct when the enrolled key set is
 * unchanged. Disconnected devices can reuse an index, and identical scripts
 * remain valid and independently spendable.
 *
 * The marker (1-sat P2PKH to a wallet-derived address keyed by chain+index)
 * and the descriptor (0-sat OP_RETURN carrying the same v7 JSON, BRC-2
 * encrypted under a wallet-derived key keyed by chain+index) are chain-
 * published, basketless, and are what let a clean device with only the
 * mnemonic find and decrypt this output's recovery record (chainRecovery.ts)
 * without the local DB or backup. The vault output's own customInstructions
 * is still written too — informational, exactly as v6's was — but is no
 * longer the only copy of anything.
 *
 * Used by the deposit, the withdraw path's re-vaulted remainder, and the
 * re-lock. Every caller must push all three returned outputs into its
 * transaction's outputs array, in this order, so validateDepositPlan /
 * validateSignableVaultPlan can pin them byte-exact.
 */
interface VaultOutputSpec {
  satoshis: number
  lockingScript: string
  outputDescription: string
  basket?: string
  customInstructions?: string
  tags?: string[]
}

async function newVaultOutput(
  w: VaultWallet,
  adminOriginator: string,
  meta: Pick<VaultMeta, 'vaultId' | 'revision' | 'createdAt' | 'keys'>,
  satoshis: number,
  outputDescription: string,
  inventory: VaultSaltInventory,
  chain: VaultScopeToken['chain']
): Promise<[vault: VaultOutputSpec, marker: VaultOutputSpec, descriptor: VaultOutputSpec]> {
  const pubkeys = meta.keys.map(k => k.pubkey)
  const keyIndex = inventory.maxKeyIndex + 1
  if (!Number.isSafeInteger(keyIndex)) {
    throw new VaultError('template-invalid', 'Vault salt key index is exhausted')
  }
  const saltKeyId = String(keyIndex)
  const salt = await deriveVaultSalt(w, adminOriginator, saltKeyId, meta.keys.map(key => key.serial))
  const lockingScript = buildLock({ commitments: pubkeys.map(pk => commitment(pk, salt)), saltHex64: salt })
  const v7: VaultInstructionsV7 = {
    v: 7,
    type: 'R1C',
    saltKeyId,
    chain,
    vaultId: meta.vaultId,
    revision: meta.revision,
    createdAt: meta.createdAt,
    keys: meta.keys.map(key => ({ ...key }))
  }
  const customInstructions = encodeVaultInstructionsV7(v7)
  const vaultOutput: VaultOutputSpec = {
    satoshis,
    lockingScript: lockingScript.toHex(),
    outputDescription,
    basket: VAULT_BASKET,
    customInstructions,
    tags: ['vault']
  }

  const markerScript = await deriveVaultMarkerScript(w, adminOriginator, chain, saltKeyId)
  const markerOutput: VaultOutputSpec = {
    satoshis: 1,
    lockingScript: markerScript.toHex(),
    outputDescription: 'Vault marker'
  }

  const descriptorCiphertext = await encryptVaultDescriptorPlaintext(w, adminOriginator, chain, saltKeyId, customInstructions)
  const descriptorOutput: VaultOutputSpec = {
    satoshis: 0,
    lockingScript: buildVaultDescriptorScript(descriptorCiphertext).toHex(),
    outputDescription: 'Vault descriptor'
  }

  const ci = decodeVaultInstructionsV7(customInstructions)
  if (!ci) throw new VaultError('template-invalid', 'Derived Vault output metadata is invalid')
  rememberVaultSalt(inventory, ci, lockingScript, `pending:${saltKeyId}`, chain, salt)
  return [vaultOutput, markerOutput, descriptorOutput]
}

/**
 * The availability gate (spec D15 / §5.5, task 11). Gates every path that
 * CREATES a vault output; never a withdrawal of pre-existing outputs.
 *
 * Two halves, matching `isVaultAvailable`. The build flag is injectable so this
 * module stays config-free in tests; the mainnet rule is not injectable and
 * takes its chain from the operation's own scope token rather than a module
 * read of `vaultStore.getScope()`. That token is captured before the first
 * await and re-asserted by the `assertVaultScope` immediately preceding every
 * call here, so a network switch landing mid-flight aborts the operation
 * instead of letting it write an output under the wrong chain — a live
 * `getScope()` read would simply see the new chain and carry on.
 *
 * In production `opts.vaultEnabled` is never supplied, so the first check is
 * exactly the build half and the second reduces to the chain half.
 */
function requireReleased(opts: VaultTransferOptions | undefined, scopeToken: VaultScopeToken, what: string): void {
  const enabled = opts?.vaultEnabled ?? isVaultEnabled
  if (!enabled()) throw new VaultError('not-released', `${what} is switched off in this build`)
  if (!isVaultAvailable(scopeToken.chain)) {
    throw new VaultError('not-on-mainnet', `${what} is only available on mainnet`)
  }
}

/** A real private-backup configuration needs both a host endpoint and the
 * user's permission to push. The preference alone defaults to true and is not
 * evidence that any backup service exists. */
async function defaultPrivateBackupEnabled(): Promise<boolean> {
  try {
    return getBackupUrl() !== '' && await isBackupPushEnabled()
  } catch {
    return false
  }
}

/** Gate creation of an R1C output. This confirms configuration only; the
 * asynchronous backup monitor does not provide an exact-record receipt. */
async function requirePrivateBackup(opts: VaultTransferOptions | undefined, what: string): Promise<void> {
  const enabled = opts?.backupEnabled ?? defaultPrivateBackupEnabled
  if (!(await enabled())) {
    throw new VaultError('backup-off', `${what} requires encrypted private backup`)
  }
}

/** The enrolled key list, or the refusal an output-creating operation owes. */
async function requireMeta(scopeToken?: VaultScopeToken): Promise<VaultMeta> {
  const meta = await vaultStore.getMeta(scopeToken)
  if (!meta) throw new VaultError('not-enrolled', 'Vault is not set up')
  if (meta.keys.length < VAULT_MIN_KEYS) {
    throw new VaultError('not-enough-keys', `A vault needs at least ${VAULT_MIN_KEYS} keys; ${meta.keys.length} enrolled`)
  }
  return meta
}

/**
 * A `sendWith` release is successful only when the wallet reports exactly the
 * transaction we asked it to release in a state the toolbox defines as
 * accepted or queued for retry. Missing, duplicate, unrelated, failed, and
 * future/unknown statuses are all ambiguous and therefore remain held.
 */
function requireReleasedHeldTransaction(
  released: CreateActionResult,
  txid: string,
  description: string
): void {
  const results = released.sendWithResults
  if (
    !Array.isArray(results) ||
    results.length !== 1 ||
    typeof results[0]?.txid !== 'string' ||
    results[0].txid.toLowerCase() !== txid.toLowerCase() ||
    (results[0].status !== 'sending' && results[0].status !== 'unproven')
  ) {
    throw new VaultError('no-transaction', `Wallet did not confirm release of the held ${description}`)
  }
}

type VaultOutputPlan = readonly [vault: VaultOutputSpec, marker: VaultOutputSpec, descriptor: VaultOutputSpec]

/**
 * Check the wallet-funded deposit transaction before it is released from
 * `noSend`. The three requested outputs (vault, marker, descriptor) are
 * byte-exact and pinned at outputs 0..2, mirroring how the vault output alone
 * used to be pinned at output zero; the wallet may add only one standard
 * P2PKH change output after them. BRC-100 does not expose a derivation proof
 * for wallet-selected inputs or change, so ownership of those standard wallet
 * coins remains the narrow wallet-core trust boundary — pinning the marker
 * and descriptor byte-exact the same way keeps a bug or compromise in that
 * boundary from silently substituting a different marker/descriptor than
 * admin code itself built (an availability regression future recovery would
 * hit, not a spend-authority break: output 0, the actual spend authority,
 * stays independently pinned either way).
 */
function validateDepositPlan(tx: Transaction, expected: VaultOutputPlan): void {
  if (tx.version !== 1) {
    throw new VaultError('bad-version', `Vault deposit is version ${tx.version}; expected 1`)
  }
  if (tx.inputs.length === 0 || tx.inputs.length > VAULT_HARD_MAX_INPUTS) {
    throw new VaultError('no-transaction', 'Vault deposit has an invalid wallet funding input count')
  }

  let inputValue = 0
  const seenInputs = new Set<string>()
  for (const input of tx.inputs) {
    const txid = (input.sourceTXID ?? input.sourceTransaction?.id('hex'))?.toLowerCase()
    const vout = input.sourceOutputIndex
    if (!txid || !/^[0-9a-f]{64}$/.test(txid) || !Number.isSafeInteger(vout) || vout < 0) {
      throw new VaultError('no-transaction', 'Vault deposit has an invalid wallet funding outpoint')
    }
    const outpoint = `${txid}.${vout}`
    if (seenInputs.has(outpoint)) throw new VaultError('no-transaction', `Vault deposit repeats funding input ${outpoint}`)
    seenInputs.add(outpoint)
    const source = input.sourceTransaction?.outputs[vout]
    const sourceSatoshis = source?.satoshis
    if (typeof sourceSatoshis !== 'number' || !Number.isSafeInteger(sourceSatoshis) || sourceSatoshis < 0) {
      throw new VaultError('no-transaction', `Vault deposit has no authenticated value for funding input ${outpoint}`)
    }
    inputValue += sourceSatoshis
    if (!Number.isSafeInteger(inputValue)) throw new VaultError('no-transaction', 'Vault deposit input value overflow')
  }

  let explicitValue = 0
  for (let i = 0; i < expected.length; i++) {
    const actual = tx.outputs[i]
    const expectedOutput = expected[i]
    if (
      !actual ||
      !Number.isSafeInteger(actual.satoshis) ||
      actual.satoshis !== expectedOutput.satoshis ||
      actual.lockingScript.toHex() !== expectedOutput.lockingScript
    ) {
      throw new VaultError('no-transaction', `Wallet changed the approved Vault deposit output ${i}`)
    }
    explicitValue += expectedOutput.satoshis
  }
  const implicit = tx.outputs.slice(expected.length)
  if (implicit.length > 1) throw new VaultError('no-transaction', 'Wallet injected an unexpected Vault deposit output')
  let outputValue = explicitValue
  if (implicit.length === 1) {
    const change = implicit[0]
    const changeSatoshis = change.satoshis
    if (
      typeof changeSatoshis !== 'number' ||
      !Number.isSafeInteger(changeSatoshis) ||
      changeSatoshis <= 0 ||
      !isStandardP2PKH(change.lockingScript)
    ) {
      throw new VaultError('no-transaction', 'Vault deposit has invalid implicit wallet change')
    }
    outputValue += changeSatoshis
    if (!Number.isSafeInteger(outputValue)) throw new VaultError('no-transaction', 'Vault deposit output value overflow')
  }
  const fee = inputValue - outputValue
  // Add a conservative P2PKH witness allowance when checking the unsigned
  // proposal; on the signed pass this merely makes the same ceiling looser by
  // a small fixed amount.
  const signedSizeCeiling = tx.toBinary().length + tx.inputs.length * 110
  const maxFee = Math.max(200, Math.ceil(signedSizeCeiling / 1000) * 200)
  if (!Number.isSafeInteger(fee) || fee < 0 || fee > maxFee) {
    throw new VaultError('no-transaction', `Vault deposit fee ${fee} exceeds the safety ceiling ${maxFee}`)
  }
  if (implicit.length === 0 && inputValue - explicitValue > maxFee) {
    throw new VaultError('no-transaction', 'Vault deposit omitted expected wallet change')
  }
}

// ── deposit ─────────────────────────────────────────────────────────────

/**
 * Move `satoshis` from the default basket into the vault (spec §4.1).
 *
 * No hardware: a deposit needs the key LIST, not a key. Every refusal is
 * checked BEFORE the one createAction below, cheapest first, and nothing is
 * spent until it runs. A pre-creation refusal consumes no numeric salt ID.
 * Once createAction persists an output, pending and failed history retain its
 * ID so a later output cannot reuse it.
 *
 * Salt derivation is deterministic, but the full ordered YubiKey serial/public
 * key descriptor remains separate wallet metadata. A configured, enabled
 * encrypted private backup is therefore a precondition for moving new funds.
 */
export async function depositToVault(
  w: VaultWallet,
  adminOriginator: string,
  satoshis: number,
  opts?: VaultTransferOptions
): Promise<{ txid: string }> {
  const scopeToken = vaultStore.captureScopeToken()
  return await withVaultMutation(async () => {
  assertVaultScope(scopeToken)
  requireReleased(opts, scopeToken, 'Vault deposit')
  if (!Number.isSafeInteger(satoshis) || satoshis < VAULT_DEPOSIT_MIN) {
    throw new VaultError('below-dust', `Vault deposits must be at least ${VAULT_DEPOSIT_MIN} satoshis`)
  }
  await requireOnline(opts)
  assertVaultScope(scopeToken)
  await requirePrivateBackup(opts, 'Vault deposit')
  assertVaultScope(scopeToken)
  // XR-002: authenticate meta BEFORE it is used to build a new output.
  const meta = await requireAuthenticatedMeta(w, adminOriginator, scopeToken, await requireMeta(scopeToken))
  if (meta.pendingRemoval) throw new VaultError('relock-required', 'Finish the pending key removal before depositing')
  if (meta.recovery?.required) {
    const adopted = new Set(meta.recovery.adoptedSerials)
    if (meta.keys.filter(key => adopted.has(key.serial)).length < VAULT_MIN_KEYS) {
      throw new VaultError('key-not-adopted', 'Verify at least two recovered YubiKeys before depositing new funds')
    }
  }
  await reconcileHeldVaultDeposits(w, adminOriginator, meta, scopeToken)
  const existing = await reduceVerifiedVaultOutputs(
    w,
    adminOriginator,
    () => undefined,
    (_state, output) => requireOutputMetaConsistency([output], meta),
    scopeToken,
    'repair-unsigned'
  )
  const saltInventory = existing.inventory
  await addHistoricalVaultSaltInventory(w, adminOriginator, saltInventory, meta, scopeToken)

  const output = await newVaultOutput(
    w,
    adminOriginator,
    meta,
    satoshis,
    'Vault deposit',
    saltInventory,
    scopeToken.chain
  )
  let reference: string | undefined
  let heldTxid: string | undefined
  let broadcastAttempted = false
  try {
    // Build and sign into `noSend` first. This gives this module a real
    // transaction to inspect before any deposit can leave the device.
    assertVaultScope(scopeToken)
    const created = await w.createAction(
      {
        description: 'Vault deposit',
        version: 1,
        outputs: [...output],
        labels: ['vault', 'vault-deposit'],
        options: { randomizeOutputs: false, noSend: true, signAndProcess: false }
      },
      adminOriginator
    )
    assertVaultScope(scopeToken)

    let signedBytes: number[] | undefined
    let reportedTxid = created.txid
    if (created.signableTransaction) {
      reference = created.signableTransaction.reference
      const unsigned = Transaction.fromAtomicBEEF(created.signableTransaction.tx)
      validateDepositPlan(unsigned, output)
      assertVaultScope(scopeToken)
      const signed = await w.signAction(
        { reference, spends: {}, options: { noSend: true } },
        adminOriginator
      )
      assertVaultScope(scopeToken)
      signedBytes = signed.tx
      reportedTxid = signed.txid ?? reportedTxid
    } else {
      signedBytes = created.tx
    }
    if (!signedBytes) throw new VaultError('no-transaction', 'Vault deposit produced no inspectable transaction')

    const signedTx = Transaction.fromAtomicBEEF(signedBytes)
    validateDepositPlan(signedTx, output)
    heldTxid = signedTx.id('hex')
    if (reportedTxid && reportedTxid.toLowerCase() !== heldTxid) {
      throw new VaultError('no-transaction', 'Vault deposit transaction ID disagrees with its signed transaction')
    }
    // `sendWith` releases this already-inspected noSend action. Once the call
    // begins its broadcast outcome can be ambiguous, so cleanup below must no
    // longer free its inputs.
    assertVaultScope(scopeToken)
    broadcastAttempted = true
    const released = await w.createAction(
      { description: 'Broadcast Vault deposit', options: { sendWith: [heldTxid] } },
      adminOriginator
    )
    assertVaultScope(scopeToken)
    requireReleasedHeldTransaction(released, heldTxid, 'Vault deposit')
    return { txid: heldTxid }
  } catch (e) {
    // noSend guarantees the transaction cannot leave before sendWith. A
    // locally detected plan/signing failure before that call may therefore
    // release its reservation, even if signAction already produced bytes.
    if (!broadcastAttempted && reference) {
      await w.abortAction({ reference }, adminOriginator).catch(() => {})
    }
    throw e
  }
  })
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
  ci: VaultInstructions
  /** The output's REAL locking script, read from the listed BEEF. */
  lockingScript: LockingScript
  /** The salt authenticating `ci` against `lockingScript` — see
   * resolveVaultSalt. Used to build the withdraw witness instead of
   * `ci.salt`, which a v7 record does not carry. */
  salt: string
}

interface VaultSelection {
  /** Full current metadata snapshot used by any replacement output. */
  meta: VaultMeta
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
  /** Salts, derivation IDs and script hashes already present in authenticated history. */
  saltInventory: VaultSaltInventory
}

/**
 * list → authenticate current records and exact locks → filter to the chosen
 * key → sort largest first → cap →
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
  amount: number | 'all',
  requiredPubkey?: string,
  scopeToken?: VaultScopeToken,
  // P1: 'repair-unsigned' aborts a genuinely stale, provably-unbroadcast
  // reservation from a past crash — exactly what a real withdraw/re-lock
  // needs before reserving new inputs. A "read-only" preview must not do
  // that: it can otherwise abort a LIVE in-flight ceremony's own unsigned
  // reservation out from under it. previewVaultWithdrawal passes false;
  // every mutating caller keeps the default.
  repair = true
): Promise<VaultSelection> {
  const meta = await vaultStore.getMeta(scopeToken)
  if (!meta) throw new VaultError('not-enrolled', 'Vault is not set up')
  if (meta.pendingRemoval) {
    if (!requiredPubkey || requiredPubkey !== meta.pendingRemoval.key.pubkey) {
      throw new VaultError('relock-required', 'Finish the pending key removal before another vault transfer')
    }
  } else if (requiredPubkey) {
    throw new VaultError('not-enrolled', 'No matching key removal is pending')
  }
  const chosen = meta.keys.find(k => k.serial === chosenSerial)
  if (!chosen) throw new VaultError('not-enrolled', `Key ${chosenSerial} is not one of this vault's keys`)
  await vaultStore.requireKeyAdopted(chosen.serial, scopeToken)

  // Hand the JS thread back once so React can paint before the bridge and
  // database work below; one 64-output page can carry roughly 3 MB of BEEF.
  await new Promise<void>(resolve => setTimeout(resolve, 0))
  assertVaultScope(scopeToken)
  const hasPubkey = (output: VerifiedVaultOutput, pubkey: string): boolean =>
    output.ci.keys.some(key => key.pubkey === pubkey)
  const cap = Math.min(VAULT_MAX_INPUTS, VAULT_HARD_MAX_INPUTS)
  interface Candidate {
    output: SelectedVaultOutput
    sourceBeef: number[]
  }
  interface SelectionScan {
    decodable: number
    mine: number
    total: number
    reachable: number
    unreachableCount: number
    unreachableSatoshis: number
    otherPubkeys: Set<string>
    selected: Candidate[]
  }
  const add = (current: number, value: number, where: string): number => {
    const next = current + value
    if (!Number.isSafeInteger(next)) throw new VaultError('no-transaction', `${where} value exceeds the safe integer range`)
    return next
  }
  const verified = await reduceVerifiedVaultOutputs(
    w,
    adminOriginator,
    (): SelectionScan => ({
      decodable: 0,
      mine: 0,
      total: 0,
      reachable: 0,
      unreachableCount: 0,
      unreachableSatoshis: 0,
      otherPubkeys: new Set(),
      selected: []
    }),
    (state, output, sources) => {
      requireOutputMetaConsistency([output], meta)
      if (requiredPubkey && !hasPubkey(output, requiredPubkey)) return
      state.decodable++
      state.total = add(state.total, output.satoshis, 'Vault selection')
      if (!hasPubkey(output, chosen.pubkey)) {
        state.unreachableCount++
        state.unreachableSatoshis = add(state.unreachableSatoshis, output.satoshis, 'Unreachable vault outputs')
        for (const key of output.ci.keys) state.otherPubkeys.add(key.pubkey)
        return
      }
      state.mine++
      state.reachable = add(state.reachable, output.satoshis, 'Reachable vault outputs')

      // Maintain the same stable, largest-first top-N selection as sort/slice,
      // but extract and retain a source proof only when this row enters it.
      let position = state.selected.findIndex(candidate => candidate.output.satoshis < output.satoshis)
      if (position < 0) position = state.selected.length
      if (position >= cap && state.selected.length >= cap) return
      let sourceBeef: number[]
      try {
        sourceBeef = sources.toBinaryAtomic(output.outpoint.slice(0, 64))
      } catch {
        throw new VaultError('no-transaction', `Vault output ${output.outpoint} has no complete source proof`)
      }
      state.selected.splice(position, 0, { output, sourceBeef })
      if (state.selected.length > cap) state.selected.pop()
    },
    scopeToken,
    repair ? 'repair-unsigned' : 'block'
  )
  const scan = verified.state
  if (scan.decodable === 0) throw new VaultError('vault-empty', 'Vault is empty')

  const otherPubkeys = [...scan.otherPubkeys]
  const unreachable: VaultSpendResult['unreachable'] = {
    count: scan.unreachableCount,
    satoshis: scan.unreachableSatoshis,
    keys: otherPubkeys.map(pubkey => ({ serial: meta.keys.find(k => k.pubkey === pubkey)?.serial, pubkey }))
  }
  if (scan.mine === 0) {
    throw new VaultError('key-not-committed', `Key ${chosen.serial} is not committed to any vault output`)
  }
  const cappedInputs = scan.mine - scan.selected.length

  // Every row was already checked against its real BEEF source, including
  // exact value and exact commitment list. Merge only the bounded input set's
  // dependency closures; unrelated source transactions never accumulate.
  const sourceBeef = new Beef()
  try {
    for (const candidate of scan.selected) sourceBeef.mergeBeef(candidate.sourceBeef)
  } catch {
    throw new VaultError('no-transaction', 'Selected Vault inputs have malformed source proofs')
  }
  const selected = scan.selected.map(candidate => candidate.output)
  const acc = sumVaultSatoshis(selected, 'Selected vault outputs')

  if (amount !== 'all') {
    if (amount > scan.total) throw new VaultError('amount-exceeds-balance', 'Withdrawal exceeds vault balance')
    if (amount > scan.reachable && scan.reachable < scan.total) {
      // Another key could open more: say which, rather than blaming the balance.
      throw new VaultError(
        'key-cannot-cover',
        `Key ${chosen.serial} can open ${scan.reachable} of the ${scan.total} satoshis in the vault`,
        undefined,
        { reachable: scan.reachable, total: scan.total }
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
  return {
    meta,
    keys: meta.keys,
    chosen,
    selected,
    acc,
    cappedInputs,
    unreachable,
    beef: sourceBeef.toBinary(),
    saltInventory: verified.inventory
  }
}

// ── withdraw / re-lock: build, sign on the card, verify, finalise ─────────

/** What a spend adds to the transaction beyond its vault inputs. */
interface VaultSpendPlan {
  outputs: VaultOutputSpec[]
  labels: string[]
  inputDescription: string
  /** The action's own description — fixed per operation, unlike `reason`
   * (the ceremony's NFC prompt text, which names the amount and varies call
   * to call). Kept separate so the amount never leaks into what the activity
   * list shows for a withdrawal, and so a copy change to one never touches
   * the other. */
  description: string
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

const isStandardP2PKH = (lockingScript: LockingScript): boolean => {
  const b = lockingScript.toBinary()
  return b.length === 25 && b[0] === 0x76 && b[1] === 0xa9 && b[2] === 0x14 && b[23] === 0x88 && b[24] === 0xac
}

/**
 * How many implicit default-basket change outputs a vault SPEND may carry.
 *
 * The wallet core grows its UTXO pool by splitting change across several
 * outputs (`generateChange`'s `targetNetCount`, itself capped per transaction
 * at `maxChangeOutputsPerTransaction`, currently 8). createAction exempts the
 * `vault-deposit` label from that growth, so a deposit still arrives with a
 * single change output and validateDepositPlan stays strict; `vault-withdraw`
 * and `vault-relock` are NOT exempted and arrive with up to eight. Mirror the
 * toolbox's cap rather than assume one, and raise this if the toolbox ever
 * raises its own.
 */
const VAULT_MAX_IMPLICIT_CHANGE = 8

/**
 * Validate the wallet core's proposed transaction before the display-less
 * YubiKey signs it. Vault sources and caller-approved explicit outputs are
 * exact. The one irreducible trust boundary is ownership of the toolbox's
 * implicit default-basket change scripts: BRC-100 exposes no derivation proof
 * for them. We therefore permit only standard P2PKH change outputs, bound
 * their TOTAL by the selected inputs minus explicit outputs, and cap the fee.
 *
 * The count is not part of that boundary — one unprovable change script is
 * the same trust as eight — so it is capped only to keep the plan, and the
 * size the fee ceiling is derived from, bounded. See
 * VAULT_MAX_IMPLICIT_CHANGE for why a vault spend arrives with more than one.
 */
function validateSignableVaultPlan(tx: Transaction, sel: VaultSelection, plan: VaultSpendPlan): void {
  const selectedByOutpoint = new Map<string, SelectedVaultOutput>()
  for (const selected of sel.selected) {
    const canonical = sameOutpoint(selected.outpoint)
    if (selectedByOutpoint.has(canonical)) {
      throw new VaultError('no-transaction', `Duplicate selected vault input ${selected.outpoint}`)
    }
    selectedByOutpoint.set(canonical, selected)
  }
  if (tx.inputs.length !== selectedByOutpoint.size) {
    throw new VaultError('no-transaction', 'Signable transaction changed the approved vault input set')
  }

  const seen = new Set<string>()
  for (const input of tx.inputs) {
    const txid = (input.sourceTXID ?? input.sourceTransaction?.id('hex'))?.toLowerCase()
    const vout = input.sourceOutputIndex
    if (!txid || !Number.isSafeInteger(vout) || vout < 0) {
      throw new VaultError('no-transaction', 'Signable transaction contains an invalid input outpoint')
    }
    const outpoint = `${txid}.${vout}`
    const selected = selectedByOutpoint.get(outpoint)
    if (!selected || seen.has(outpoint)) {
      throw new VaultError('no-transaction', `Signable transaction contains an unapproved or duplicate input ${outpoint}`)
    }
    const source = input.sourceTransaction?.outputs[vout]
    if (
      !source ||
      source.satoshis !== selected.satoshis ||
      source.lockingScript.toHex() !== selected.lockingScript.toHex()
    ) {
      throw new VaultError('no-transaction', `Signable input ${outpoint} changed its authenticated source`)
    }
    seen.add(outpoint)
  }
  if (seen.size !== selectedByOutpoint.size) {
    throw new VaultError('no-transaction', 'Signable transaction omitted an approved vault input')
  }

  let explicitValue = 0
  for (let i = 0; i < plan.outputs.length; i++) {
    const expected = plan.outputs[i]
    const actual = tx.outputs[i]
    const actualSatoshis = actual?.satoshis
    if (
      !actual ||
      typeof actualSatoshis !== 'number' ||
      !Number.isSafeInteger(actualSatoshis) ||
      actualSatoshis < 0 ||
      actualSatoshis !== expected.satoshis ||
      actual.lockingScript.toHex() !== expected.lockingScript
    ) {
      throw new VaultError('no-transaction', `Signable transaction changed approved output ${i}`)
    }
    explicitValue += expected.satoshis
    if (!Number.isSafeInteger(explicitValue)) throw new VaultError('no-transaction', 'Approved output value overflow')
  }

  const implicit = tx.outputs.slice(plan.outputs.length)
  if (implicit.length > VAULT_MAX_IMPLICIT_CHANGE) {
    throw new VaultError('no-transaction', 'Signable transaction injected an unexpected output')
  }
  let implicitValue = 0
  for (const change of implicit) {
    const changeSatoshis = change.satoshis
    if (
      typeof changeSatoshis !== 'number' ||
      !Number.isSafeInteger(changeSatoshis) ||
      changeSatoshis <= 0 ||
      !isStandardP2PKH(change.lockingScript)
    ) {
      throw new VaultError('no-transaction', 'Signable transaction has invalid implicit wallet change')
    }
    implicitValue += changeSatoshis
    if (!Number.isSafeInteger(implicitValue)) {
      throw new VaultError('no-transaction', 'Implicit change value overflow')
    }
  }

  const inputValue = sumVaultSatoshis(sel.selected, 'Signable vault inputs')
  if (explicitValue > inputValue || implicitValue > inputValue - explicitValue) {
    throw new VaultError('no-transaction', 'Signable transaction outputs exceed approved vault inputs')
  }
  const fee = inputValue - explicitValue - implicitValue
  // Empty unlock placeholders understate final size. Add the maximum R1C
  // witnesses, then allow twice the wallet's normal 100 sat/kB policy rate.
  const signedSizeCeiling = tx.toBinary().length + sel.selected.length * R1C_UNLOCK_LEN
  const maxFee = Math.max(200, Math.ceil(signedSizeCeiling / 1000) * 200)
  if (!Number.isSafeInteger(fee) || fee < 0 || fee > maxFee) {
    throw new VaultError('no-transaction', `Signable transaction fee ${fee} exceeds the Vault safety ceiling ${maxFee}`)
  }
  if (implicit.length === 0 && inputValue - explicitValue > maxFee) {
    throw new VaultError('no-transaction', 'Signable transaction omitted expected wallet change')
  }
}

/**
 * createAction with transaction version 1, then the two checks that must
 * pass before the FIRST card signature: the parsed signable transaction is
 * version 1 (`bad-version`), and every input's preimage passes pushTxDerCheck
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
  opts?: VaultTransferOptions,
  scopeToken?: VaultScopeToken
): Promise<SignableBuild> {
  const outpoints = sel.selected.map(o => o.outpoint)
  /** outpoint → sequenceNumber override, set by a pushTxDerCheck hit. */
  const sequences = new Map<string, number>()

  for (let attempt = 1; ; attempt++) {
    const caArgs = {
      description: plan.description,
      version: 1,
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

    const createOnce = async (): Promise<CreateActionResult> => {
      assertVaultScope(scopeToken)
      const result = await w.createAction(caArgs, adminOriginator)
      try {
        assertVaultScope(scopeToken)
      } catch (scopeError) {
        // The original wallet object is still pinned to scope A. If it made a
        // reservation before the scope switched, release that reversible A
        // action without touching the now-current scope B.
        const reference = result.signableTransaction?.reference
        if (reference) await w.abortAction({ reference }, adminOriginator).catch(() => {})
        throw scopeError
      }
      return result
    }

    let created: CreateActionResult
    try {
      created = await createOnce()
    } catch (e) {
      if (e instanceof VaultError && e.code === 'scope-changed') throw e
      assertVaultScope(scopeToken)
      const freed = await freeReservedInputs(w, adminOriginator, e, outpoints, opts?.findSpendingReferences, scopeToken)
      if (freed === 0) throw e
      created = await createOnce()
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
      if (tx.version !== 1) {
        throw new VaultError('bad-version', `Signable transaction is version ${tx.version}; expected 1`)
      }
      validateSignableVaultPlan(tx, sel, plan)
      const prepared: PreparedInput[] = sel.selected.map(o => {
        const [txid, voutStr] = o.outpoint.split('.')
        const vout = Number(voutStr)
        // Locate each approved vault input by outpoint. The plan validator has
        // already rejected extra, missing, and duplicate inputs.
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
    assertVaultScope(scopeToken)
    await w.abortAction({ reference }, adminOriginator).catch(() => {})
    assertVaultScope(scopeToken)
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
  opts?: VaultTransferOptions,
  scopeToken?: VaultScopeToken
): Promise<VaultSpendResult> {
  const { tx, reference, prepared } = await createSignableVaultTx(w, adminOriginator, sel, reason, plan, opts, scopeToken)
  const result = (txid: string): VaultSpendResult => ({ txid, cappedInputs: sel.cappedInputs, unreachable: sel.unreachable })
  const { chosen, selected } = sel
  const total = selected.length

  const unlocks: { inputIndex: number; unlockingScript: UnlockingScript }[] = []
  try {
    // ── the tap(s): one on-card signature per input ────────────────────
    const signer = await requestVaultSigner(reason, chosen.serial)
    assertVaultScope(scopeToken)
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
        assertVaultScope(scopeToken)
        // buildUnlock throws template-invalid if fullR is the point at
        // infinity — a 2^-256 event; it unwinds through the abort below.
        unlocks.push({
          inputIndex,
          unlockingScript: buildUnlock({
            preimage,
            derSig: der,
            pubkeyHex33: signer.pubkey,
            saltHex64: selected[i].salt
          })
        })
      }
    } finally {
      // Dismisses the NFC sheet and drops the PIN whether or not every input
      // was signed; the local verification below needs no card.
      signer.release()
    }

    // ── strict local Spend per input (spec §4.2 step 7) ────────────────
    // Honest unlocks are minimal, so the strict local flags are at least as
    // strong as the node policy used for the same version-1 transaction.
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

  // PAST THE POINT OF NO ABORT. Output-creating spends are first signed into a
  // held noSend action and revalidated before sendWith. A plain withdrawal has
  // no new Vault output and can go directly to the broadcaster. A throw after
  // either signAction begins remains ambiguous and is never followed by
  // abortAction.
  //
  // The broadcasting note is inert once the signer is released (noteProgress
  // ignores notes with nothing armed); the transfer screen shows its own
  // spinner. Kept so the phase sequence reads complete.
  noteVaultProgress({ phase: 'broadcasting' })
  assertVaultScope(scopeToken)
  const createsVaultOutput = plan.outputs.some(output => output.basket === VAULT_BASKET)
  const signed = await w.signAction(
    {
      reference,
      spends,
      options: createsVaultOutput ? { noSend: true } : { acceptDelayedBroadcast: false }
    },
    adminOriginator
  )
  assertVaultScope(scopeToken)
  let txid = signed.txid ?? (signed.tx ? Transaction.fromAtomicBEEF(signed.tx).id('hex') : undefined)
  if (!txid) throw new VaultError('no-transaction', 'Vault spend produced no transaction')
  txid = txid.toLowerCase()

  if (createsVaultOutput) {
    if (!signed.tx) throw new VaultError('no-transaction', 'Held Vault spend returned no inspectable signed transaction')
    const signedTx = Transaction.fromAtomicBEEF(signed.tx)
    if (signedTx.id('hex') !== txid) {
      throw new VaultError('no-transaction', 'Held Vault spend transaction ID disagrees with its signed transaction')
    }
    validateSignableVaultPlan(signedTx, sel, plan)
    for (const unlock of unlocks) {
      if (signedTx.inputs[unlock.inputIndex]?.unlockingScript?.toHex() !== unlock.unlockingScript.toHex()) {
        throw new VaultError('no-transaction', 'Wallet changed a verified Vault unlocking script while signing')
      }
    }
    assertVaultScope(scopeToken)
    const released = await w.createAction(
      { description: `Broadcast ${plan.description}`, options: { sendWith: [txid] } },
      adminOriginator
    )
    assertVaultScope(scopeToken)
    requireReleasedHeldTransaction(released, txid, plan.description)
  }
  // Best-effort: the transaction is already with the monitor, so a failed
  // SecureStore write here (the chooser's "last used" default) must never
  // turn a completed transfer into a reported failure.
  try {
    await vaultStore.noteLastUsed(chosen.serial, scopeToken)
  } catch (e) {
    console.log('[vault] noteLastUsed failed (transfer already complete):', (e as Error)?.message)
  }
  return result(txid)
}

// ── withdraw ────────────────────────────────────────────────────────────

/**
 * Cheapest refusal first, shared by the preview and the withdrawal. Every
 * amount comparison in selectVaultInputs is `amount > x`, which is false for
 * NaN, 0 and negatives: unguarded, NaN would withdraw everything the key can
 * open, a negative would fund a re-vault output LARGER than the inputs from
 * the hot wallet (bypassing the deposit gates), 0 would pay a fee to re-lock
 * everything.
 */
function requireWithdrawalAmount(amount: number | 'all'): void {
  if (amount !== 'all' && (!Number.isSafeInteger(amount) || amount <= 0)) {
    throw new VaultError('below-dust', 'Withdrawal amount must be a positive integer number of satoshis')
  }
}

/**
 * What a withdrawal with the CHOSEN key would select, without reserving,
 * tapping or signing anything (spec §4.2 step 4 needs it BEFORE the tap).
 *
 * `selectedTotal` is the chosen key's selectable total — its committed
 * outputs, largest first, within the input cap — which is what
 * withdrawFromVault folds or re-vaults the remainder against, and which can
 * be LESS than the vault balance when other keys hold part of it or the cap
 * applies. The screen computes the remainder-fold confirmation from this
 * figure, never from the whole balance. Throws exactly what the withdrawal's
 * own selection would (`not-enrolled`, `vault-empty`, `key-not-committed`,
 * `key-cannot-cover`, `amount-exceeds-balance`, `too-many-inputs`,
 * `below-dust`), so those surface inline before any NFC sheet. Reads the
 * wallet database only; no network, so it is not gated on being online.
 */
export async function previewVaultWithdrawal(
  w: VaultWallet,
  adminOriginator: string,
  chosenSerial: string,
  amount: number | 'all'
): Promise<{ selectedTotal: number; cappedInputs: number; unreachable: VaultSpendResult['unreachable'] }> {
  requireWithdrawalAmount(amount)
  const scopeToken = vaultStore.captureScopeToken()
  return await withVaultMutation(async () => {
    assertVaultScope(scopeToken)
    // repair: false — this reads only; a genuinely stale unsigned reservation
    // from a past crash is still cleaned up by the next real withdraw/re-lock
    // (see selectVaultInputs' `repair` param and the P1 fix note there).
    const sel = await selectVaultInputs(w, adminOriginator, chosenSerial, amount, undefined, scopeToken, false)
    return { selectedTotal: sel.acc, cappedInputs: sel.cappedInputs, unreachable: sel.unreachable }
  })
}

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
  const scopeToken = vaultStore.captureScopeToken()
  return await withVaultMutation(async () => {
  assertVaultScope(scopeToken)
  // Cheapest refusal first, as in depositToVault — see requireWithdrawalAmount.
  requireWithdrawalAmount(amount)
  // An offline user is never asked to present a key for a transfer that
  // cannot proceed.
  await requireOnline(opts)
  assertVaultScope(scopeToken)
  const meta = await requireMeta(scopeToken)
  const sel = await selectVaultInputs(w, adminOriginator, chosenSerial, amount, undefined, scopeToken)
  const want = amount === 'all' ? sel.acc : amount
  const remainder = sel.acc - want
  const outputs: VaultSpendPlan['outputs'] = []
  if (remainder >= VAULT_DEPOSIT_MIN) {
    // P2-774: reconcileHeldVaultDeposits' gate exists only to protect
    // salt-index-allocation integrity for a call that is about to allocate a
    // NEW one (spec's high-water-mark check) — a full-balance withdrawal
    // (no remainder here) creates no vault output and does not need it, so
    // only THIS branch, which re-vaults the remainder, still requires it.
    await reconcileHeldVaultDeposits(w, adminOriginator, meta, scopeToken)
    // Re-vaulting CREATES a vault output, which the release flag gates (spec
    // §5.5). Withdrawing pre-existing outputs — 'all' — never is.
    requireReleased(opts, scopeToken, 'Re-vaulting a remainder')
    await requirePrivateBackup(opts, 'Re-vaulting a remainder')
    assertVaultScope(scopeToken)
    // XR-002: authenticate meta BEFORE it is used to build the re-vaulted
    // remainder's new output. Scoped to exactly this branch — the only one
    // that creates an output — so an otherwise-unauthenticated meta never
    // blocks a plain 'all' withdrawal, whose authority is its spent outputs'
    // own real locks, never local meta (see requireAuthenticatedMeta).
    const authenticatedMeta = await requireAuthenticatedMeta(w, adminOriginator, scopeToken, sel.meta)
    await addHistoricalVaultSaltInventory(w, adminOriginator, sel.saltInventory, authenticatedMeta, scopeToken)
    outputs.push(...await newVaultOutput(
      w,
      adminOriginator,
      authenticatedMeta,
      remainder,
      'Vault change',
      sel.saltInventory,
      scopeToken.chain
    ))
  }
  return await spendVaultOutputs(
    w,
    adminOriginator,
    sel,
    reason,
    { outputs, labels: ['vault', 'vault-withdraw'], inputDescription: 'Vault withdrawal', description: 'Vault withdrawal' },
    opts,
    scopeToken
  )
  })
}

// ── re-lock (spec §4.3) ──────────────────────────────────────────────────

/** Fixed byte cost of the v7 marker output: 8-byte value + a 3-byte
 * script-length prefix (the existing formula's own conservative convention)
 * + the 25-byte P2PKH script. */
const VAULT_MARKER_OUTPUT_BYTES = 8 + 3 + 25

/** Worst-case byte cost of the v7 descriptor output: OP_FALSE OP_RETURN (2 B)
 * + the tag push (1 + tag length) + the ciphertext push at its hard cap
 * (MAX_DESCRIPTOR_CIPHERTEXT_BYTES, needing a 3-byte PUSHDATA2 header at that
 * size), plus the same 8-byte value + 3-byte length-prefix convention. */
const VAULT_MAX_DESCRIPTOR_OUTPUT_BYTES =
  8 + 3 + 2 + (1 + Utils.toArray(VAULT_DESCRIPTOR_TAG, 'utf8').length) + (3 + MAX_DESCRIPTOR_CIPHERTEXT_BYTES)

/**
 * Fee reserve for a re-lock, in the toolbox's own arithmetic (100 sat/kB,
 * rounded up per kB) plus 10 %.
 *
 *   size = 10 + inputCount·(41 + 3 + R1C_UNLOCK_LEN) + (3 + lockLen + 8)
 *          + marker + descriptor
 *
 * — version/locktime/counts (10); per input the outpoint + sequence (41), a
 * 3-byte script-length prefix and the DECLARED unlock length; the vault
 * output itself: an 8-byte value, a 3-byte prefix and the new lock; plus the
 * v7 marker and descriptor outputs that ride alongside every re-lock output
 * (VAULT_MARKER_OUTPUT_BYTES, VAULT_MAX_DESCRIPTOR_OUTPUT_BYTES — the latter
 * priced at its hard worst case, not the actual per-key-count size, so the
 * estimate never under-reserves). The +10 % is computed in integers
 * (`ceil(kb·satPerKb·11 / 10)`): `11200 * 1.1` is `12320.000000000002` in
 * doubles, and a float ceil would over-charge by one.
 *
 * The re-lock output is `acc − this`; the toolbox's real fee is at most this
 * and the surplus becomes ordinary default-basket change (folded into the fee
 * when below dust).
 */
export function estimateRelockFee(inputCount: number, lockLen: number, satPerKb = 100): number {
  const size = 10 + inputCount * (41 + 3 + R1C_UNLOCK_LEN) + (3 + lockLen + 8) +
    VAULT_MARKER_OUTPUT_BYTES + VAULT_MAX_DESCRIPTOR_OUTPUT_BYTES
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
  const scopeToken = vaultStore.captureScopeToken()
  return await withVaultMutation(async () => {
  assertVaultScope(scopeToken)
  requireReleased(opts, scopeToken, 'Re-locking the vault')
  await requireOnline(opts)
  assertVaultScope(scopeToken)
  await requirePrivateBackup(opts, 'Re-locking the vault')
  assertVaultScope(scopeToken)
  // XR-002: authenticate meta BEFORE anything below uses it — relockVault
  // always builds a new output, so unlike withdrawFromVault this runs
  // unconditionally, and early enough that a reconciled/retagged meta is
  // what selectVaultInputs (re-reading vaultStore.getMeta itself) and the
  // fee estimate below both see.
  const meta = await requireAuthenticatedMeta(w, adminOriginator, scopeToken, await requireMeta(scopeToken))
  await reconcileHeldVaultDeposits(w, adminOriginator, meta, scopeToken)
  const revokePubkey = opts?.revokePubkey
  const sel = await selectVaultInputs(w, adminOriginator, chosenSerial, 'all', revokePubkey, scopeToken)
  if (sel.meta.pendingRemoval && !revokePubkey) {
    throw new VaultError('relock-required', 'Finish the pending key removal before another re-lock')
  }
  if (revokePubkey && sel.chosen.pubkey === revokePubkey) {
    throw new VaultError('wrong-key', 'The key being revoked cannot authorize its own replacement')
  }
  if (revokePubkey && sel.meta.pendingRemoval?.key.pubkey !== revokePubkey) {
    throw new VaultError('not-enrolled', 'The key being revoked does not match the pending removal')
  }
  if (sel.keys.length < VAULT_MIN_KEYS) {
    throw new VaultError('not-enough-keys', `A vault needs at least ${VAULT_MIN_KEYS} keys; ${sel.keys.length} remain`)
  }
  await addHistoricalVaultSaltInventory(w, adminOriginator, sel.saltInventory, sel.meta, scopeToken)
  const fee = estimateRelockFee(sel.selected.length, R1C_LOCK_LEN(sel.keys.length))
  const relocked = sel.acc - fee
  if (relocked < VAULT_DEPOSIT_MIN) {
    throw new VaultError(
      'too-small-to-relock',
      `Re-locking ${sel.acc} satoshis would leave ${relocked} after fees, below the ${VAULT_DEPOSIT_MIN} floor`
    )
  }
  const result = await spendVaultOutputs(
    w,
    adminOriginator,
    sel,
    reason,
    {
      outputs: await newVaultOutput(
        w,
        adminOriginator,
        sel.meta,
        relocked,
        'Vault re-lock',
        sel.saltInventory,
        scopeToken.chain
      ),
      labels: ['vault', 'vault-relock'],
      inputDescription: 'Vault re-lock',
      // Fixed, like the deposit and withdrawal descriptions (see
      // VaultSpendPlan): the caller's `reason` is NFC-prompt copy that names
      // the keys to tap, which read as nonsense in the activity list.
      description: 'Vault relock'
    },
    opts,
    scopeToken
  )
  if (revokePubkey) await vaultStore.markKeyRemovalBroadcast(scopeToken)
  return result
  })
}

// ── coverage (spec §3.4 badges) ──────────────────────────────────────────

/**
 * How the vault's outputs relate to the CURRENT key list, from each output's
 * v6 record (the authenticated full key list — sufficient for a badge; the
 * withdraw path checks the real lock). `stale` counts outputs whose set
 * differs in EITHER direction; `missingKeys` are the current pubkeys some
 * output lacks ("{{count}} deposits not yet open to {{nickname}}");
 * `removedKeyOutputs` are outputs a pubkey no longer in meta can still open
 * ("still open to a removed key"). Any unreadable candidate fails the whole
 * authenticated scan rather than disappearing from the safety decision.
 */
export async function getVaultKeyCoverage(w: VaultWallet, adminOriginator: string): Promise<VaultKeyCoverage> {
  const scopeToken = vaultStore.captureScopeToken()
  const meta = await vaultStore.getMeta(scopeToken)
  const current = meta?.keys.map(k => k.pubkey) ?? []
  const currentSet = new Set(current)
  const scan = await reduceVerifiedVaultOutputs(
    w,
    adminOriginator,
    () => ({ stale: 0, removedKeyOutputs: 0, missing: new Set<string>() }),
    (coverage, output) => {
      const set = new Set(output.ci.keys.map(key => key.pubkey))
      const same = set.size === currentSet.size && current.every(pk => set.has(pk))
      if (!same) coverage.stale++
      for (const pk of current) if (!set.has(pk)) coverage.missing.add(pk)
      if (output.ci.keys.some(key => !currentSet.has(key.pubkey))) coverage.removedKeyOutputs++
    },
    scopeToken
  )
  assertVaultScope(scopeToken)
  return {
    outputs: scan.outputs,
    stale: scan.state.stale,
    missingKeys: current.filter(pk => scan.state.missing.has(pk)), // meta order, each once
    removedKeyOutputs: scan.state.removedKeyOutputs
  }
}

/**
 * How many vault outputs would lose every remaining committed key if `pubkey`
 * were removed (spec §3.4) — the exact predicate Remove must satisfy: an
 * output stays spendable after removal only if its baked key set (the
 * authenticated v6 record — sufficient here, as in getVaultKeyCoverage; the
 * withdraw path checks the real lock) intersects the CURRENT key list minus
 * the one being removed. Reads the same strict listOutputs scan as
 * getVaultKeyCoverage; an unreadable candidate fails closed.
 */
export async function orphanedIfRemoved(w: VaultWallet, adminOriginator: string, pubkey: string): Promise<number> {
  const scopeToken = vaultStore.captureScopeToken()
  const meta = await vaultStore.getMeta(scopeToken)
  const remaining = new Set((meta?.keys.map(k => k.pubkey) ?? []).filter(pk => pk !== pubkey))
  const { state } = await reduceVerifiedVaultOutputs(
    w,
    adminOriginator,
    () => ({ orphaned: 0 }),
    (result, output) => {
      if (!output.ci.keys.some(key => remaining.has(key.pubkey))) result.orphaned++
    },
    scopeToken
  )
  assertVaultScope(scopeToken)
  return state.orphaned
}

/**
 * Start key removal only after a fully authenticated scan proves every current
 * output remains open to an active key. The store transition is the durable
 * point of no return for new deposits: it removes the target from active keys
 * while retaining the full record in pendingRemoval before any createAction.
 */
export async function beginVaultKeyRemoval(
  w: VaultWallet,
  adminOriginator: string,
  serial: string
): Promise<{ complete: boolean; meta: VaultMeta }> {
  const scopeToken = vaultStore.captureScopeToken()
  return await withVaultMutation(async () => {
    assertVaultScope(scopeToken)
    // XR-002: this is a meta-mutating write (beginKeyRemoval), not an
    // output-creating one, but its own `next` must still be tagged from an
    // already-trustworthy `meta` — see vaultStore.addKey's laundering
    // caveat, which applies identically here.
    const meta = await requireAuthenticatedMeta(w, adminOriginator, scopeToken, await requireMeta(scopeToken))
    const scope = vaultStore.getScope()
    if (!scope) throw new VaultError('not-enrolled', 'Wallet vault scope is not configured')
    const target = meta.keys.find(key => key.serial === serial)
    if (!target) throw new VaultError('not-enrolled', `Key ${serial} is not enrolled`)
    if (meta.keys.length <= VAULT_MIN_KEYS) {
      throw new VaultError('last-keys', `A vault needs at least ${VAULT_MIN_KEYS} keys`)
    }
    // P2-774: beginVaultKeyRemoval allocates no new salt index — the tombstone
    // transition below creates no vault output — so reconcileHeldVaultDeposits'
    // allocation-integrity gate does not apply here (unlike depositToVault and
    // relockVault, which do). A held signed deposit reserves only ordinary
    // wallet inputs, not any vault-basket output this removal's eventual
    // re-lock would need, so it must not block starting a removal either —
    // see the 'vault-deposit' exemption just below.
    let pendingAction = false
    await scanVaultActions(
      w,
      adminOriginator,
      { includeLabels: true },
      // Only an action that has NOT reached the network blocks: it reserves
      // the very outputs the removal re-lock has to spend. A broadcast one
      // reserves nothing — its vault output is an ordinary unconfirmed UTXO
      // the listOutputs scan below authenticates like any other. 'unproven' is
      // what the activity list shows as "Accepted" and stands until the merkle
      // proof arrives, so blocking on it refused every removal on a funded
      // vault and told the user to re-lock — the step this refusal itself
      // prevented. A 'vault-deposit' holds no EXISTING vault output — see the
      // note above — so it is exempt from this check the same way.
      action => {
        if (
          !(action.labels ?? []).includes('vault-deposit') &&
          PENDING_ACTION_STATUSES.has(action.status) &&
          !BROADCAST_ACTION_STATUSES.has(action.status)
        ) {
          pendingAction = true
        }
      },
      scopeToken
    )
    if (pendingAction) {
      throw new VaultError('action-pending', 'Wait for pending vault actions before removing a key')
    }
    const remaining = new Set(meta.keys.filter(key => key.serial !== serial).map(key => key.pubkey))
    const before = await reduceVerifiedVaultOutputs(
      w,
      adminOriginator,
      () => ({ wouldOrphan: false }),
      (state, output) => {
        requireOutputMetaConsistency([output], meta)
        if (!output.ci.keys.some(key => remaining.has(key.pubkey))) state.wouldOrphan = true
      },
      scopeToken,
      'repair-unsigned'
    )
    if (before.state.wouldOrphan) {
      throw new VaultError('relock-required', 'A vault output would lose every remaining key')
    }
    const pending = await vaultStore.beginKeyRemoval(serial, scopeToken, next =>
      computeVaultMetaAuthorityTag(asHmacWallet(w), adminOriginator, next, scope)
    )
    if (before.outputs > 0) return { complete: false, meta: pending }

    // Empty removal has no transaction to prove. Recheck after the metadata
    // transition because the wallet monitor is outside the process mutex.
    const after = await reduceVerifiedVaultOutputs(
      w,
      adminOriginator,
      () => undefined,
      () => {},
      scopeToken
    )
    if (after.outputs > 0) {
      await vaultStore.cancelUnbroadcastKeyRemoval(scopeToken, next =>
        computeVaultMetaAuthorityTag(asHmacWallet(w), adminOriginator, next, scope)
      )
      throw new VaultError('action-pending', 'A vault output appeared while removing the key')
    }
    const finalMeta = await vaultStore.finalizeEmptyKeyRemoval(scopeToken, next =>
      computeVaultMetaAuthorityTag(asHmacWallet(w), adminOriginator, next, scope)
    )
    // XQ-014: `serial` is now fully removed from this chain — forget it
    // device-wide unless another chain of this same identity still holds it.
    await forgetSerialsNoLongerEnrolledForIdentity([serial], () => vaultStore.enrolledSerialsAcrossChains(scopeToken))
    return { complete: true, meta: finalMeta }
  })
}

async function actionCarriesCurrentRelock(
  w: VaultWallet,
  adminOriginator: string,
  action: VaultActionRow,
  meta: VaultMeta,
  expectedChain: VaultScopeToken['chain'],
  saltInventory?: VaultSaltInventory
): Promise<boolean> {
  if (action.status === 'failed' || !action.labels?.includes('vault-relock')) return false
  const vaultOutputs = (action.outputs ?? []).filter(output => output.basket === VAULT_BASKET)
  if (vaultOutputs.length !== 1) return false
  const output = vaultOutputs[0]
  if (!Number.isSafeInteger(output.satoshis) || output.satoshis < 0) {
    throw new VaultError('no-transaction', 'Vault re-lock action has an invalid output value')
  }
  if (!output.customInstructions || !output.lockingScript) {
    throw new VaultError('template-invalid', 'Vault re-lock action has unreadable output metadata or script')
  }
  const ci = decodeVaultInstructions(output.customInstructions)
  if (!ci) throw new VaultError('template-invalid', 'Vault re-lock action has invalid recovery metadata')
  if (ci.chain !== expectedChain) {
    throw new VaultError('template-invalid', 'Vault re-lock action belongs to a different network')
  }
  let lock: LockingScript
  try {
    lock = LockingScript.fromHex(output.lockingScript)
  } catch {
    throw new VaultError('template-invalid', 'Vault re-lock action has a malformed locking script')
  }
  const salt = await resolveVaultSalt(w, adminOriginator, ci)
  verifyInstructionsAgainstLock(ci, lock, `Vault re-lock ${action.txid ?? action.reference ?? ''}`, salt)
  const carriesCurrentRelock = (
    ci.vaultId === meta.vaultId &&
    ci.createdAt === meta.createdAt &&
    ci.revision === meta.revision &&
    sameInstructionKeys(meta.keys, ci.keys)
  )
  if (carriesCurrentRelock && saltInventory) {
    rememberVaultSalt(
      saltInventory,
      ci,
      lock,
      vaultActionOutputId(action, output.outputIndex),
      expectedChain,
      salt
    )
  }
  return carriesCurrentRelock
}

/** Every source of a removal re-lock must be an exact R1C output that still
 * authorizes the tombstoned key. This binds action-history evidence to the
 * authority being revoked rather than trusting a label or replacement alone. */
function actionSpendsPendingRemovalKey(
  action: VaultActionRow,
  meta: VaultMeta,
  inventory: VaultSaltInventory
): boolean {
  const pending = meta.pendingRemoval
  const inputs = action.inputs ?? []
  if (!pending || inputs.length === 0) return false
  return inputs.every(input => {
    if (!input.sourceOutpoint || !input.sourceLockingScript) return false
    try {
      const lock = LockingScript.fromHex(input.sourceLockingScript)
      bakedCommitments(lock)
      const record = inventory.outputRecords.get(input.sourceOutpoint.toLowerCase())
      return record !== undefined &&
        record.lockingScript === lock.toHex() &&
        record.pubkeys.has(pending.key.pubkey)
    } catch {
      return false
    }
  })
}

/** A crash before signAction can leave an unsigned re-lock reserving all of
 * its sources. It is safe to abort only when the action has no txid, its exact
 * replacement authenticates against the pending revision, and every input is
 * a real R1C lock that still authorizes the tombstoned key. Anything less is
 * an unknown broadcast/source state and remains fail-closed. */
async function isUnbroadcastPendingRemovalRelock(
  w: VaultWallet,
  adminOriginator: string,
  action: VaultActionRow,
  meta: VaultMeta,
  expectedChain: VaultScopeToken['chain'],
  saltInventory: VaultSaltInventory
): Promise<boolean> {
  const pending = meta.pendingRemoval
  if (!pending || action.status !== 'unsigned' || !!action.txid || !action.reference) return false
  if (!(await actionCarriesCurrentRelock(w, adminOriginator, action, meta, expectedChain, saltInventory))) return false
  return actionSpendsPendingRemovalKey(action, meta, saltInventory)
}

/** Reconcile a durable pending removal. A bounded broadcast marker is inferred
 * after a crash only from an authenticated matching re-lock action. The
 * tombstone is cleared only when no pending/failed Vault action exists, a
 * matching re-lock is completed, and two authenticated scans find no lock
 * authorizing the key. */
export async function finalizeVaultKeyRemoval(
  w: VaultWallet,
  adminOriginator: string
): Promise<boolean> {
  const scopeToken = vaultStore.captureScopeToken()
  return await withVaultMutation(async () => {
    assertVaultScope(scopeToken)
    // XR-002: same laundering caveat as beginVaultKeyRemoval — this function
    // writes meta (markKeyRemovalBroadcast / finalizeEmptyKeyRemoval /
    // finalizeProvenKeyRemoval below) from whatever `meta` currently is.
    let meta = await requireAuthenticatedMeta(w, adminOriginator, scopeToken, await requireMeta(scopeToken))
    const scope = vaultStore.getScope()
    if (!scope) throw new VaultError('not-enrolled', 'Wallet vault scope is not configured')
    const tagger = (next: Parameters<typeof computeVaultMetaAuthorityTag>[2]) =>
      computeVaultMetaAuthorityTag(asHmacWallet(w), adminOriginator, next, scope)
    const pendingAtStart = meta.pendingRemoval
    if (!pendingAtStart) return false
    const first = await reduceVerifiedVaultOutputs(
      w,
      adminOriginator,
      () => ({ authorizesPendingKey: false }),
      (state, output) => {
        requireOutputMetaConsistency([output], meta)
        if (output.ci.keys.some(key => key.pubkey === pendingAtStart.key.pubkey)) {
          state.authorizesPendingKey = true
        }
      },
      scopeToken,
      'allow'
    )

    const unsignedRelockReferences: string[] = []
    let invalidCurrentRelock = false
    let matchingRelock = false
    let completedMatchingRelock = false
    let actionStateBlocks = false
    const actionSaltInventory = emptyVaultSaltInventory()
    await addHistoricalVaultSaltInventory(w, adminOriginator, actionSaltInventory, meta, scopeToken)
    await scanVaultActions(w, adminOriginator, {
      labels: [],
      includeLabels: true,
      includeInputs: true,
      includeInputSourceLockingScripts: true,
      includeOutputs: true,
      includeOutputLockingScripts: true
    }, async action => {
      if (await isUnbroadcastPendingRemovalRelock(w, adminOriginator, action, meta, scopeToken.chain, actionSaltInventory)) {
        unsignedRelockReferences.push(action.reference!)
      }
      if (action.txid && await actionCarriesCurrentRelock(w, adminOriginator, action, meta, scopeToken.chain, actionSaltInventory)) {
        if (!actionSpendsPendingRemovalKey(action, meta, actionSaltInventory)) invalidCurrentRelock = true
        else {
          matchingRelock = true
          if (action.status === 'completed') completedMatchingRelock = true
        }
      }
      if (!actionTouchesVault(action)) return
      if (PENDING_ACTION_STATUSES.has(action.status)) {
        actionStateBlocks = true
      } else if (action.status === 'failed') {
        const labels = new Set(action.labels ?? [])
        if (!(labels.has('vault-deposit') && !labels.has('vault-withdraw') && !labels.has('vault-relock'))) {
          actionStateBlocks = true
        }
      } else if (action.status !== 'completed') {
        actionStateBlocks = true
      }
    }, scopeToken, true)

    assertVaultScope(scopeToken)
    await verifyVaultSaltDerivations(w, adminOriginator, actionSaltInventory)
    assertVaultScope(scopeToken)

    // A process death between createAction and signAction is provably
    // unbroadcast only in the strict unsigned/no-txid shape above. Release that
    // reservation, then require an authenticated rescan to show the old locks
    // again. The pending-removal tombstone stays in place for an explicit retry.
    let abortedUnsigned = false
    for (const reference of unsignedRelockReferences) {
      try {
        assertVaultScope(scopeToken)
        await w.abortAction({ reference }, adminOriginator)
        assertVaultScope(scopeToken)
        abortedUnsigned = true
      } catch {
        return false
      }
    }
    if (abortedUnsigned) {
      const restored = await reduceVerifiedVaultOutputs(
        w,
        adminOriginator,
        () => ({ authorizesPendingKey: false }),
        (state, output) => {
          requireOutputMetaConsistency([output], meta)
          if (output.ci.keys.some(key => key.pubkey === pendingAtStart.key.pubkey)) {
            state.authorizesPendingKey = true
          }
        },
        scopeToken,
        'allow'
      )
      if (!restored.state.authorizesPendingKey) {
        throw new VaultError('no-transaction', 'Aborted re-lock did not restore its reserved vault sources')
      }
      return false
    }

    if (invalidCurrentRelock) return false
    if (matchingRelock) await vaultStore.markKeyRemovalBroadcast(scopeToken, tagger)
    meta = await requireMeta(scopeToken)
    const pending = meta.pendingRemoval
    if (!pending) return true
    if (actionStateBlocks) return false
    if (first.state.authorizesPendingKey) return false

    if (pending.state === 'prepared') {
      // No output ever needed a re-lock and no matching broadcast was found.
      const second = await reduceVerifiedVaultOutputs(
        w,
        adminOriginator,
        () => ({ authorizesPendingKey: false }),
        (state, output) => {
          requireOutputMetaConsistency([output], meta)
          if (output.ci.keys.some(key => key.pubkey === pending.key.pubkey)) state.authorizesPendingKey = true
        },
        scopeToken,
        'allow'
      )
      if (second.state.authorizesPendingKey) return false
      await vaultStore.finalizeEmptyKeyRemoval(scopeToken, tagger)
      // XQ-014: the tombstoned key is now fully removed from this chain.
      await forgetSerialsNoLongerEnrolledForIdentity([pending.key.serial], () =>
        vaultStore.enrolledSerialsAcrossChains(scopeToken)
      )
      return true
    }

    if (!completedMatchingRelock) return false

    const second = await reduceVerifiedVaultOutputs(
      w,
      adminOriginator,
      () => ({ authorizesPendingKey: false }),
      (state, output) => {
        requireOutputMetaConsistency([output], meta)
        if (output.ci.keys.some(key => key.pubkey === pending.key.pubkey)) state.authorizesPendingKey = true
      },
      scopeToken,
      'allow'
    )
    if (second.state.authorizesPendingKey) return false
    await vaultStore.finalizeProvenKeyRemoval(scopeToken, tagger)
    // XQ-014: the tombstoned key is now fully removed from this chain.
    await forgetSerialsNoLongerEnrolledForIdentity([pending.key.serial], () =>
      vaultStore.enrolledSerialsAcrossChains(scopeToken)
    )
    return true
  })
}
