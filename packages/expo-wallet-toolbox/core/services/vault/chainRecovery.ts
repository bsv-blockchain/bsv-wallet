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
 */
import { Transaction, Utils } from '@bsv/sdk'
import {
  buildLock,
  commitment,
  decodeVaultInstructionsV7,
  encodeVaultInstructionsV7,
  type VaultInstructionsV7,
  type VaultSaltChain
} from './r1comb'
import { VaultError } from './types'
import {
  VAULT_BASKET,
  deriveVaultMarkerScript,
  deriveVaultSalt,
  decryptVaultDescriptorPlaintext,
  parseVaultDescriptorScript,
  recoverVaultMetaFromOutputs,
  vaultChainKeyId,
  type VaultWallet
} from './transfers'
import { wocConfigFor, type WocConfig } from '../../pay/rails/address'
import type { AppChain } from '../../config'

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

/** Defensive cap on how many candidate transactions a single scan index will
 * inspect. A v7 marker is an ordinary P2PKH address that becomes publicly
 * visible the moment its real deposit confirms; nothing stops a stranger
 * from paying arbitrary dust to it afterward. A legitimate index has exactly
 * one real deposit history, so recovery never needs more than a handful of
 * candidates to find it — this only bounds how much free decrypt-and-discard
 * work a targeted victim's recovery can be forced to do. */
const VAULT_RECOVERY_MAX_CANDIDATES_PER_INDEX = 50

/**
 * Injected chain lookup — the only network/indexer dependency this module
 * has. Unit-tested against an in-memory fake; core/services/vault/wocChainLookup.ts
 * (see below) is the production WhatsOnChain implementation.
 */
export interface VaultChainLookup {
  /** Every txid whose output list includes an output with exactly this
   * locking script — from address history and/or the current unspent set.
   * An empty result is a genuine "no marker at this index" miss. */
  transactionsForLockingScript(lockingScriptHex: string): Promise<string[]>
  /** AtomicBEEF-decodable bytes for `txid` (a plain raw-tx-only BEEF is
   * fine — recoverOneCandidate only reads `tx.outputs` from it locally; the
   * bytes handed to `wallet.internalizeAction` are these same bytes, and
   * ITS OWN chain-tracker validation is the actual SPV gate), plus whether
   * this lookup can currently show the transaction as confirmed. `null`
   * means the lookup could not produce usable bytes at all (reported as a
   * problem, not a miss — see recoverOneCandidate). `confirmed: false` is
   * the explicit, disclosed zero-conf boundary (see this file's docstring):
   * recoverOneCandidate reports it as `pendingConfirmation` rather than
   * attempting `internalizeAction`, which the toolbox's own SPV gate would
   * otherwise throw on.
   */
  transactionForTxid(txid: string): Promise<{ beef: number[]; confirmed: boolean } | null>
  /** Spent/unspent/unknown for one outpoint. 'unknown' is never trusted as
   * unspent — see recoverOneCandidate. */
  outputStatus(outpoint: { txid: string; vout: number }): Promise<'unspent' | 'spent' | 'unknown'>
}

export interface VaultChainRecoveryProblem {
  /** The scan index (saltKeyId) this problem was found at. */
  index: number
  reason: string
}

export interface VaultChainRecoveryResult {
  /** Indices newly inserted into 'admin vault' by this run. */
  found: number
  /** Marker history existed and decrypted to a valid, unspent v7 record, but
   * the lookup could not yet show it as confirmed — the honest zero-conf
   * scope cut (this file's docstring). Not a miss: does not consume a
   * gap-scan slot, and is not a "problem" (nothing is wrong; it just isn't
   * recoverable yet). */
  pendingConfirmation: number
  /** A found-but-unusable record (bad decrypt, wrong version, index/chain
   * mismatch, lock-rebuild mismatch, unreadable transaction bytes) — reported
   * distinctly and does NOT count as a "no marker" miss, so a version
   * mismatch or transient lookup hiccup at one index can never silently
   * truncate the scan. */
  problems: VaultChainRecoveryProblem[]
  /** Highest index actually scanned this run — surfaced so a UI can offer
   * "scan further" when the gap default (or a caller-raised one) turns out
   * to be too small for a heavily re-tried enrollment. */
  scanned: number
}

type CandidateOutcome =
  | { kind: 'found' }
  | { kind: 'pending' }
  | { kind: 'spent' }
  | { kind: 'problem'; reason: string }

/**
 * Locate, authenticate and (if usable) internalize ONE candidate marker
 * transaction for scan index `k`. Never throws — every failure mode is a
 * distinct, reported outcome, per this module's "found-but-unusable is not
 * a miss" contract.
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
    return { kind: 'problem', reason: 'marker is not immediately between a vault output and a descriptor' }
  }

  const parsedDescriptor = parseVaultDescriptorScript(descriptorOutput.lockingScript)
  if (!parsedDescriptor) return { kind: 'problem', reason: 'adjacent output is not a v7 descriptor' }

  let plaintext: string
  try {
    plaintext = await decryptVaultDescriptorPlaintext(w, adminOriginator, chain, saltKeyId, parsedDescriptor.ciphertext)
  } catch {
    return { kind: 'problem', reason: 'descriptor did not decrypt under this index' }
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
    salt = await deriveVaultSalt(w, adminOriginator, ci.saltKeyId, ci.keys.map(key => key.serial))
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
  let status: 'unspent' | 'spent' | 'unknown'
  try {
    status = await lookup.outputStatus({ txid, vout: vaultOutputIndex })
  } catch {
    status = 'unknown'
  }
  if (status === 'spent') return { kind: 'spent' }
  if (status === 'unknown') return { kind: 'problem', reason: 'could not confirm the vault output is unspent' }

  if (!entry.confirmed) return { kind: 'pending' }

  try {
    await w.internalizeAction({
      tx: entry.beef,
      outputs: [{
        outputIndex: vaultOutputIndex,
        protocol: 'basket insertion',
        insertionRemittance: {
          basket: VAULT_BASKET,
          customInstructions: encodeVaultInstructionsV7(ci),
          tags: ['vault']
        }
      }],
      description: 'Recovered vault deposit',
      seekPermission: false
    }, adminOriginator)
  } catch (e) {
    return { kind: 'problem', reason: `could not internalize the recovered output: ${(e as Error)?.message ?? 'unknown error'}` }
  }
  return { kind: 'found' }
}

/**
 * Scan k = 1.. for chain-published v7 Vault outputs and internalize every
 * confirmed, unspent, authenticated one into 'admin vault'. Then rebuilds
 * local vault metadata from the now-listed outputs via the unchanged
 * recoverVaultMetaFromOutputs (which itself re-authenticates everything).
 *
 * `wallet` need only satisfy VaultWallet (already used throughout
 * transfers.ts) — getPublicKey/encrypt/decrypt/createHmac/internalizeAction
 * must be backed by the wallet's real root key derivation for this to prove
 * anything (a stub wallet with no live mnemonic session cannot reproduce the
 * marker, decrypt the descriptor, or derive the salt — see INT-10's fail-closed
 * claim in restoreSalt.test.ts).
 */
export async function recoverVaultFromChain(
  w: VaultWallet,
  adminOriginator: string,
  lookup: VaultChainLookup,
  chain: VaultSaltChain,
  gap: number = VAULT_RECOVERY_GAP_DEFAULT
): Promise<VaultChainRecoveryResult> {
  if (!Number.isSafeInteger(gap) || gap < 1) {
    throw new VaultError('template-invalid', 'Vault recovery gap must be a positive integer')
  }
  let found = 0
  let pendingConfirmation = 0
  const problems: VaultChainRecoveryProblem[] = []
  let consecutiveMisses = 0
  // Bounds the loop independently of consecutiveMisses — see
  // VAULT_RECOVERY_MAX_CONSECUTIVE_PROBLEMS's doc comment. Reset on any
  // iteration that gets a real answer (a miss or a hit alike), so only a
  // PERSISTENT run of failures aborts the scan, never an occasional hiccup.
  let consecutiveProblems = 0
  let scanned = 0
  let k = 1
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
      if (++consecutiveProblems >= VAULT_RECOVERY_MAX_CONSECUTIVE_PROBLEMS) {
        throw new Error(
          `Vault recovery scan could not complete: ${consecutiveProblems} consecutive derivation/lookup failures, most recently at index ${k}`
        )
      }
      k++
      continue
    }
    let txids: string[]
    try {
      txids = await lookup.transactionsForLockingScript(markerScriptHex)
    } catch {
      problems.push({ index: k, reason: 'chain lookup failed for this marker' })
      if (++consecutiveProblems >= VAULT_RECOVERY_MAX_CONSECUTIVE_PROBLEMS) {
        throw new Error(
          `Vault recovery scan could not complete: ${consecutiveProblems} consecutive derivation/lookup failures, most recently at index ${k}`
        )
      }
      k++
      continue
    }
    consecutiveProblems = 0
    if (txids.length === 0) {
      consecutiveMisses++
      k++
      continue
    }
    // Marker history exists at this index — never a "no marker" miss from
    // here on, no matter how every candidate below turns out.
    consecutiveMisses = 0
    let inspected = 0
    for (const txid of txids) {
      if (inspected >= VAULT_RECOVERY_MAX_CANDIDATES_PER_INDEX) {
        problems.push({
          index: k,
          reason: `stopped after ${VAULT_RECOVERY_MAX_CANDIDATES_PER_INDEX} candidates at this index`
        })
        break
      }
      inspected++
      const outcome = await recoverOneCandidate(w, adminOriginator, lookup, chain, k, markerScriptHex, txid)
      if (outcome.kind === 'found') { found++; break }
      else if (outcome.kind === 'pending') { pendingConfirmation++; break }
      else if (outcome.kind === 'problem') problems.push({ index: k, reason: outcome.reason })
      // 'spent': a superseded output (already withdrawn or re-locked) —
      // entirely normal, silently skipped; keep inspecting other candidates
      // at this index.
    }
    k++
  }
  await recoverVaultMetaFromOutputs(w, adminOriginator)
  return { found, pendingConfirmation, problems, scanned }
}

// ───────────────────────── default WhatsOnChain implementation ─────────────

/**
 * Production VaultChainLookup over WhatsOnChain, following the exact request
 * patterns already used by core/pay/rails/address.ts (getUtxosForAddress,
 * the `/tx/{txid}/beef` fetch, parseWocBeefBody's response-shape checks).
 *
 * NEEDS-NETWORK / UNPROVEN (see the security-review residuals this module
 * closes): the exact WhatsOnChain response shapes assumed here —
 * `/address/{address}/history` returning `[{tx_hash, ...}]`, and
 * `/tx/{hash}/out/{index}` carrying a `spentTxId`/`spent` field for the
 * unspent-vs-spent check — were not exercised against the live API as part
 * of this change (no network access in this environment). This must be
 * smoke-tested against real WhatsOnChain responses (mainnet and testnet)
 * before being relied on in production; recoverVaultFromChain's own logic
 * is unit-tested against an in-memory VaultChainLookup fake and does not
 * depend on these HTTP details being exactly right.
 */
export function wocChainLookup(chain: AppChain): VaultChainLookup {
  const woc: WocConfig = wocConfigFor(chain)
  const base = `${woc.apiBase}/v1/bsv/${woc.segment}`

  return {
    async transactionsForLockingScript(lockingScriptHex: string): Promise<string[]> {
      // The marker is always a P2PKH output; derive its address from the
      // script's hash160 rather than adding a second WoC endpoint shape.
      //
      // The VaultChainLookup contract (see this file's interface doc) treats
      // an EMPTY result as a genuine "no marker at this index" miss — so a
      // failure to even ask the question (an unrecognizable script), a
      // non-2xx response (rate limiting, a transient 5xx, a maintenance
      // window) or a thrown exception (DNS failure, timeout, offline) must
      // never collapse into that same empty array: recoverVaultFromChain's
      // OWN catch around this call (never a miss, and now bounded — see
      // VAULT_RECOVERY_MAX_CONSECUTIVE_PROBLEMS) is what has to handle these,
      // not the miss-counting branch.
      const address = p2pkhAddressFromScript(lockingScriptHex, woc.network)
      if (!address) {
        throw new Error('wocChainLookup: marker script is not a recognizable P2PKH script')
      }
      const response = await fetch(`${base}/address/${address}/history`)
      if (!response.ok) {
        throw new Error(`wocChainLookup: address history request failed (HTTP ${response.status})`)
      }
      const body = await response.json()
      const rows = Array.isArray(body) ? body : Array.isArray(body?.result) ? body.result : []
      const txids = rows.map((r: any) => r?.tx_hash).filter((h: unknown) => typeof h === 'string')
      return [...new Set<string>(txids)]
    },

    async transactionForTxid(txid: string): Promise<{ beef: number[]; confirmed: boolean } | null> {
      try {
        const [beefResp, txResp] = await Promise.all([
          fetch(`${base}/tx/${txid}/beef`),
          fetch(`${base}/tx/hash/${txid}`)
        ])
        const beef = parseWocBeefBodyText(beefResp.ok, await beefResp.text())
        if (!beef) return null
        let confirmed = false
        if (txResp.ok) {
          const info = await txResp.json()
          confirmed = Number.isInteger(info?.confirmations) && info.confirmations > 0
        }
        return { beef, confirmed }
      } catch {
        return null
      }
    },

    async outputStatus(outpoint: { txid: string; vout: number }): Promise<'unspent' | 'spent' | 'unknown'> {
      // Fail-safe default is 'unknown' (never trusted as unspent — see this
      // file's VaultChainLookup interface doc). ONLY a well-formed response
      // that explicitly carries `spentTxId: null` counts as confirmed
      // unspent; any other shape — including the field simply being ABSENT,
      // which `=== undefined` would previously conflate with an explicit
      // null — falls through to 'unknown' rather than failing open.
      try {
        const response = await fetch(`${base}/tx/${outpoint.txid}/out/${outpoint.vout}`)
        if (!response.ok) return 'unknown'
        const info = await response.json()
        if (info === null || typeof info !== 'object' || !('spentTxId' in info)) return 'unknown'
        if (info.spentTxId === null) return 'unspent'
        if (typeof info.spentTxId === 'string' && info.spentTxId.length > 0) return 'spent'
        return 'unknown'
      } catch {
        return 'unknown'
      }
    }
  }
}

/** Local copy of address.ts's parseWocBeefBody signature over (ok, text)
 * rather than a Response, so this module does not need to import it just to
 * reshape the call. */
function parseWocBeefBodyText(ok: boolean, text: string): number[] | undefined {
  if (!ok) return undefined
  const hex = text.trim()
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return undefined
  try {
    return Utils.toArray(hex, 'hex') as number[]
  } catch {
    return undefined
  }
}

/** hash160 out of a standard P2PKH script, re-encoded as a base58check
 * address for the WoC address-history endpoint, via @bsv/sdk's own public
 * `Utils.toBase58Check` (already imported for toHex/toArray above) — the
 * same primitive `PublicKey.prototype.toAddress()` uses internally elsewhere
 * in this codebase (core/pay/rails/address.ts). Returns undefined for
 * anything else (defensive — deriveVaultMarkerScript always builds P2PKH). */
function p2pkhAddressFromScript(lockingScriptHex: string, network: 'mainnet' | 'testnet'): string | undefined {
  let bytes: number[]
  try {
    bytes = Utils.toArray(lockingScriptHex, 'hex') as number[]
  } catch {
    return undefined
  }
  if (bytes.length !== 25 || bytes[0] !== 0x76 || bytes[1] !== 0xa9 || bytes[2] !== 0x14 || bytes[23] !== 0x88 || bytes[24] !== 0xac) {
    return undefined
  }
  const hash160 = bytes.slice(3, 23)
  return Utils.toBase58Check(hash160, [network === 'mainnet' ? 0x00 : 0x6f])
}
