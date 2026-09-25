/**
 * The address rail — payments to and from conventional wallets.
 *
 * This is the only bridge between this wallet and the rest of the ecosystem,
 * so every line here is a straight port from app/legacy-payments.tsx. The
 * derivation in particular is load-bearing in a way that is easy to miss: the
 * key ID is `base64(YYYY-MM-DD) + ' ' + base64('legacy')`, so the date string
 * IS part of the private key path. Any change to how that string is produced
 * makes previously-issued addresses — and the money sitting on them —
 * unreachable. getCurrentDate's local-time/UTC mix is therefore deliberate and
 * must not be "corrected".
 */
import {
  Beef,
  P2PKH,
  PrivateKey,
  PublicKey,
  Transaction,
  Utils,
  type InternalizeActionArgs,
  type InternalizeOutput,
  type WalletProtocol
} from '@bsv/sdk'
import type { AppChain } from '../../config'
import { abbreviateKey, addressLabel, FROM_ADDRESS_LABEL_PREFIX, TO_ADDRESS_LABEL_PREFIX } from '../counterparty'
import { addressNetwork, isValidBsvAddress } from './index'

export const BRC29_PROTOCOL_ID: WalletProtocol = [2, '3241645161d8']

/** Whether the address rail can carry a particular payment, and why not when it cannot. */
export type AddressRailAvailability = { kind: 'available' } | { kind: 'unavailable'; reason: string }

/**
 * D4: the address rail cannot carry a Mandala token, ever.
 *
 * Not a policy and not a UI opinion — a protocol fact. A token output's owner
 * key is ECDH-derived against the recipient's IDENTITY key
 * (`MandalaToken.lockBRC29`), and the issuer's overlay refuses a transaction
 * carrying an FT output whose owner it cannot name from a linkage. A base58
 * address names a hash, not an identity, so there is nothing to derive against
 * and nothing to reveal — the transaction would be refused if it were ever
 * built, and the money would be locked to a script no one can spend if it
 * were not.
 *
 * The reason text comes from the runtime (`recipientRefusal`, which is the
 * lib's own `guardTokenRecipient`) rather than from a string here, so the
 * wallet and the lib cannot come to say two different things about the same
 * refusal. A caller with no runtime still gets a correct refusal, just a
 * shorter one.
 */
export function addressRailAvailability(args: {
  address: string
  /** Set when the payment is denominated in a token rather than in satoshis. */
  assetId?: string
  /** `MandalaRuntime.recipientRefusal`. */
  recipientRefusal?: (recipient: string) => string | null
}): AddressRailAvailability {
  if (args.assetId === undefined || args.assetId === '') {
    return isValidBsvAddress(args.address)
      ? { kind: 'available' }
      : { kind: 'unavailable', reason: 'Invalid BSV address' }
  }
  const reason = args.recipientRefusal?.(args.address)
  return {
    kind: 'unavailable',
    reason:
      reason ??
      'Mandala tokens can only be sent to an identity key, not to an address — the token output is derived against the recipient identity and the overlay refuses anything else'
  }
}

export const LEGACY_DERIVATION_SUFFIX = Utils.toBase64(Utils.toArray('legacy', 'utf8'))

/**
 * How far back the manual recovery stepper may reach. The background sweeper
 * has its own, much tighter bound (see pay/watchlist.ts): this one exists
 * because an address a payer sat on for three weeks still holds real money.
 */
export const MAX_RECOVERY_DAYS = 30

/**
 * Verbatim from legacy-payments.tsx. `setDate` on a local Date then
 * `toISOString()` — the mix is what previously-issued addresses were derived
 * with, so it stays. `now` is injectable for tests only; production always
 * takes the default.
 */
export const getCurrentDate = (daysOffset: number, now: Date = new Date()): string => {
  const today = new Date(now.getTime())
  today.setDate(today.getDate() - daysOffset)
  return today.toISOString().split('T')[0]
}

export function derivationPrefixFor(date: string): string {
  return Utils.toBase64(Utils.toArray(date, 'utf8'))
}

/**
 * XR-055. Upper bound for the MANUAL recovery stepper only (AddressReceive.tsx) — distinct
 * from MAX_RECOVERY_DAYS, which also bounds runWalletCheck's automatic bulk repair scan (see
 * recoveryDatesToScan below) and stays small there because that scan makes one WhatsOnChain
 * round trip per candidate day. Nothing in this codebase tracks a wallet-creation timestamp
 * to bound the manual, one-address-at-a-time stepper by, so it uses a generous constant
 * instead: comfortably longer than this project has existed, so a user with a genuinely old
 * address is never blocked from reaching it by hand — the one recovery path that must keep
 * working even on a device with no persisted issued-date history at all (a fresh import with
 * no backup, so pay/receiveHistory.ts has nothing recorded).
 */
export const MAX_MANUAL_RECOVERY_DAYS = 3650

/**
 * Which calendar dates conventional-address recovery should try, given this device's durable
 * issued-date history if it has one (pay/receiveHistory.ts, XR-055).
 *
 * The watchlist (pay/watchlist.ts) prunes by a 7-day calendar age no matter how recently it
 * was swept, and the fixed MAX_RECOVERY_DAYS lookback below is itself only 30 days — so a
 * payer who sat on a legitimately-displayed address for longer than either window had no
 * shipped recovery path back to internalizeAction. Scanning every date this device has ever
 * actually issued fixes that regardless of age, since sweepAddress is idempotent and cheap to
 * retry for a date that turns out to hold nothing.
 *
 * Falls back to the previous fixed MAX_RECOVERY_DAYS lookback only when there is no history
 * to consult at all — a device that predates this feature, or one restored with neither a
 * backup nor any local history of its own — which is exactly today's unchanged behaviour for
 * that case.
 */
export function recoveryDatesToScan(recordedDates: readonly string[], now: Date = new Date()): string[] {
  if (recordedDates.length > 0) return [...new Set(recordedDates)]
  return Array.from({ length: MAX_RECOVERY_DAYS }, (_, day) => getCurrentDate(day, now))
}

/** One ASCII space. The wallet derives a different key for any other separator. */
export function legacyKeyId(derivationPrefix: string): string {
  return `${derivationPrefix} ${LEGACY_DERIVATION_SUFFIX}`
}

export interface WocConfig {
  apiBase: string
  segment: string
  network: 'mainnet' | 'testnet'
}

export function wocConfigFor(network: AppChain): WocConfig {
  return {
    main: { apiBase: 'https://api.whatsonchain.com', segment: 'main', network: 'mainnet' as const },
    test: { apiBase: 'https://api.whatsonchain.com', segment: 'test', network: 'testnet' as const },
    teratest: { apiBase: 'https://api.woc-ttn.bsvblockchain.tech', segment: 'test', network: 'testnet' as const }
  }[network]
}

export interface AddressDerivingWallet {
  getPublicKey(args: unknown, originator?: string): Promise<{ publicKey: string }>
}

export async function getPaymentAddress(
  wallet: AddressDerivingWallet,
  adminOriginator: string,
  derivationPrefix: string,
  network: 'mainnet' | 'testnet'
): Promise<string> {
  const { publicKey } = await wallet.getPublicKey(
    {
      protocolID: BRC29_PROTOCOL_ID,
      keyID: legacyKeyId(derivationPrefix),
      counterparty: 'anyone',
      forSelf: true
    },
    adminOriginator
  )
  return PublicKey.fromString(publicKey).toAddress(network)
}

export interface Utxo {
  txid: string
  vout: number
  satoshis: number
}

export interface ProcessedTx {
  txid: string
  satoshis: number
  status: string
  importedAt: Date | null
}

export interface AddressRailWallet extends AddressDerivingWallet {
  listActions(args: unknown, originator?: string): Promise<{ actions: any[] }>
  internalizeAction(args: unknown, originator?: string): Promise<{ accepted?: boolean } | undefined>
  createAction(args: unknown, originator?: string): Promise<unknown>
}

/**
 * Resource bounds for chain-service responses (XR-059/XR-060). Every
 * configured chain-service call this rail makes trusts the *content* of what
 * comes back (verified downstream by the real transaction bytes, a merkle
 * path, or the wallet's own ledger) but not its *size* — a compromised or
 * merely misbehaving indexer must not be able to force unbounded allocation,
 * hex-decode/BEEF-merge work, or per-row network fanout just by sending back
 * more than any real address or transaction could ever legitimately produce.
 */
export const MAX_UTXO_LISTING_ROWS = 2000
export const MAX_HEX_RESPONSE_CHARS = 8_000_000

export async function getUtxosForAddress(woc: WocConfig, address: string): Promise<Utxo[]> {
  const response = await fetch(`${woc.apiBase}/v1/bsv/${woc.segment}/address/${address}/unspent/all`)
  const rp = await response.json()
  // A live receive address never legitimately carries anywhere near this many
  // UTXOs; sweepAddress fetches one BEEF per distinct txid in the result, so
  // an unbounded row count is also unbounded network fanout.
  return rp.result
    .slice(0, MAX_UTXO_LISTING_ROWS)
    .filter((r: any) => r.isSpentInMempoolTx === false)
    .map((r: any) => ({ txid: r.tx_hash, vout: r.tx_pos, satoshis: r.value }))
}

/**
 * Outputs this wallet has already internalized for `address`, keyed
 * `txid.outputIndex`. The address itself is the action label, which is why the
 * label list in sweepAddress below must keep carrying it.
 *
 * A read failure returns an empty set rather than throwing: the caller's next
 * step is internalizeAction, which is idempotent per output, so the cost of a
 * false "nothing imported" is a rejected duplicate — while a throw here would
 * strand real money behind a transient database error.
 */
export async function getInternalizedUtxos(
  wallet: AddressRailWallet,
  adminOriginator: string,
  address: string
): Promise<Set<string>> {
  try {
    const response = await wallet.listActions(
      { labels: [address], labelQueryMode: 'all', includeOutputs: true, limit: 1000 },
      adminOriginator
    )
    const set = new Set<string>()
    for (const action of response.actions) {
      if (action.outputs) {
        for (const output of action.outputs) {
          if (action.txid) set.add(`${action.txid}.${output.outputIndex}`)
        }
      }
    }
    return set
  } catch {
    return new Set()
  }
}

export function availableUtxos(all: Utxo[], internalized: Set<string>): Utxo[] {
  return all.filter(u => !internalized.has(`${u.txid}.${u.vout}`))
}

export async function fetchBalance(
  wallet: AddressRailWallet,
  adminOriginator: string,
  woc: WocConfig,
  address: string
): Promise<number> {
  const all = await getUtxosForAddress(woc, address)
  const internalized = await getInternalizedUtxos(wallet, adminOriginator, address)
  return availableUtxos(all, internalized).reduce((acc, u) => acc + u.satoshis, 0)
}

export async function getProcessedTransactions(
  wallet: AddressRailWallet,
  adminOriginator: string,
  address: string
): Promise<ProcessedTx[]> {
  try {
    const response = await wallet.listActions(
      { labels: [address], labelQueryMode: 'all', includeLabels: true, includeOutputs: true, limit: 1000 },
      adminOriginator
    )
    return response.actions
      .map((action: any) => {
        const totalSats = action.outputs
          ? action.outputs.reduce((sum: number, o: any) => sum + o.satoshis, 0)
          : action.satoshis
        const tsLabel = action.labels?.find((l: string) => l.startsWith('ts:'))
        const importedAt = tsLabel ? new Date(Number(tsLabel.slice(3)) * 1000) : null
        return { txid: action.txid, satoshis: totalSats, status: action.status, importedAt }
      })
      .sort((a: ProcessedTx, b: ProcessedTx) => {
        if (a.importedAt && b.importedAt) return b.importedAt.getTime() - a.importedAt.getTime()
        if (a.importedAt) return -1
        if (b.importedAt) return 1
        return 0
      })
  } catch {
    return []
  }
}

/**
 * Bytes of a WhatsOnChain `/tx/{txid}/beef` body, or undefined if the
 * response is not a usable even-length hex payload. A 404 body is prose;
 * feeding it to `Utils.toArray(..., 'hex')` throws and would abort the rest
 * of an address's UTXOs.
 */
export function parseWocBeefBody(resp: { ok: boolean; text: string }): number[] | undefined {
  if (!resp.ok) return undefined
  const hex = resp.text.trim()
  if (hex.length === 0 || hex.length > MAX_HEX_RESPONSE_CHARS || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex))
    return undefined
  try {
    return Utils.toArray(hex, 'hex')
  } catch {
    return undefined
  }
}

/**
 * The address a conventional wallet paid from, read off the zeroth input's
 * P2PKH unlocking script: a signature push followed by a 33-byte compressed
 * key. That is the only place the sweep can learn anything about the payer,
 * since the remittance carries a sentinel sender rather than a real one.
 * Anything else (coinbase, unsigned, multisig, a key that will not parse)
 * yields undefined so the caller falls back to a generic description instead
 * of guessing at a face; a throw here would count a good payment as failed.
 */
export function payerAddressOf(tx: Transaction, network: 'mainnet' | 'testnet' = 'mainnet'): string | undefined {
  const chunks = tx.inputs[0]?.unlockingScript?.chunks
  if (chunks === undefined || chunks.length !== 2) return undefined
  const key = chunks[1].data
  if (key === undefined || key.length !== 33 || (key[0] !== 0x02 && key[0] !== 0x03)) return undefined
  try {
    return PublicKey.fromString(Utils.toHex(key)).toAddress(network)
  } catch {
    return undefined
  }
}

/**
 * The sweep. Ported from legacy-payments.tsx's handleImportFunds with one
 * change to its trigger. What it writes has since grown a payer-facing
 * description and a `from:` label so the activity list can name and draw the
 * payer; both are additive and derived, and the dedup contract below is
 * untouched. The label carries the address as hex (see addressLabel): the
 * wallet lower-cases labels on the way in, which base58 does not survive.
 *
 * The sentinel sender key (PrivateKey(1)'s public key) and the label list are
 * both load-bearing: the labels are how getInternalizedUtxos recognises what
 * has already been imported, and the bare address label in particular is what
 * makes a second sweep a no-op instead of a double credit. The `from:` label
 * is a different string from the bare address, so the `labelQueryMode: 'all'`
 * lookups and the `ts:` parse in getProcessedTransactions never see it.
 *
 * Each UTXO is fetched and internalized in its own try/catch so one bad BEEF
 * cannot skip the rest of the address.
 */
/**
 * XR-054: the number of distinct transactions sweepAddress will fetch+verify+
 * internalize in a single call. getUtxosForAddress already caps the raw UTXO
 * listing at MAX_UTXO_LISTING_ROWS (XR-059), but that still allows up to that
 * many distinct txids, each costing one sequential network fetch — dusting a
 * published receive address with many small, distinct-txid payments would
 * otherwise make every 30-second sweeper.ts pass do that many fetches, over
 * and over, forever. Capping here bounds the work any one pass can do; any
 * txid left over this pass is simply still "available" (not yet
 * internalized) and gets picked up by a later pass — nothing is lost or
 * double-credited, since internalizeAction is idempotent per output.
 */
export const MAX_SWEEP_TXIDS_PER_PASS = 200

export async function sweepAddress(args: {
  wallet: AddressRailWallet
  adminOriginator: string
  woc: WocConfig
  address: string
  derivationPrefix: string
  nowSeconds?: number
}): Promise<{ importedSatoshis: number; failureCount: number; foundOnChain: boolean }> {
  const { wallet, adminOriginator, woc, address, derivationPrefix } = args
  const nowSeconds = args.nowSeconds ?? Math.floor(Date.now() / 1000)

  const all = await getUtxosForAddress(woc, address)
  const internalized = await getInternalizedUtxos(wallet, adminOriginator, address)
  const utxos = availableUtxos(all, internalized)
  if (utxos.length === 0) return { importedSatoshis: 0, failureCount: 0, foundOnChain: false }

  const senderIdentityKey = new PrivateKey(1).toPublicKey().toString()
  let importedSatoshis = 0
  let failureCount = 0

  // XR-054: a single linear grouping pass (was: one `.filter()` over the
  // whole `utxos` array per unique txid inside this same loop, i.e. O(n^2)
  // for n outputs), plus the per-pass txid cap above.
  const byTxid = new Map<string, Utxo[]>()
  for (const utxo of utxos) {
    const group = byTxid.get(utxo.txid)
    if (group) group.push(utxo)
    else byTxid.set(utxo.txid, [utxo])
  }
  const txids = Array.from(byTxid.keys()).slice(0, MAX_SWEEP_TXIDS_PER_PASS)

  for (const txid of txids) {
    const relevant = byTxid.get(txid) as Utxo[]
    try {
      const resp = await fetch(`${woc.apiBase}/v1/bsv/${woc.segment}/tx/${txid}/beef`)
      const bytes = parseWocBeefBody({ ok: resp.ok, text: await resp.text() })
      if (!bytes) {
        failureCount++
        continue
      }
      const beef = new Beef()
      beef.mergeBeef(bytes)
      const tx = beef.findAtomicTransaction(txid)
      if (!tx) {
        failureCount++
        continue
      }
      // XR-056: `o.satoshis` here is the chain-indexer's own unauthenticated
      // `value` field (see getUtxosForAddress) — a faulty or malicious
      // indexer can report any figure it likes. `tx` is the cryptographically
      // parsed, atomic-BEEF-verified transaction the wallet is about to
      // internalize, so its own outputs are the only trustworthy amount.
      // A listing row whose vout doesn't even exist on the real transaction
      // is dropped rather than internalized.
      const verified = relevant.filter(o => tx.outputs[o.vout] !== undefined)
      if (verified.length === 0) {
        failureCount++
        continue
      }
      const outputs: InternalizeOutput[] = verified.map(o => ({
        outputIndex: o.vout,
        protocol: 'wallet payment' as const,
        paymentRemittance: {
          senderIdentityKey,
          derivationPrefix,
          derivationSuffix: LEGACY_DERIVATION_SUFFIX
        }
      }))
      // Same network the rail derives its own receive addresses on, so payer
      // and payee addresses read consistently in one history.
      const payerAddress = payerAddressOf(tx, woc.network)
      const internalizeArgs: InternalizeActionArgs = {
        tx: tx.toAtomicBEEF(),
        description: payerAddress !== undefined ? abbreviateKey(payerAddress) : 'Payment to your address',
        outputs,
        labels: [
          'legacy',
          'inbound',
          'bsvbrowser',
          address,
          `ts:${nowSeconds}`,
          ...(payerAddress !== undefined ? [addressLabel(FROM_ADDRESS_LABEL_PREFIX, payerAddress)] : [])
        ]
      }
      const response = await wallet.internalizeAction(internalizeArgs, adminOriginator)
      if (response?.accepted) {
        importedSatoshis += verified.reduce((sum, o) => sum + (tx.outputs[o.vout]?.satoshis ?? 0), 0)
      } else failureCount++
    } catch {
      failureCount++
    }
  }
  return { importedSatoshis, failureCount, foundOnChain: true }
}

/**
 * Pay a conventional wallet. The only route out of this wallet to the rest of
 * the ecosystem, so both guards throw before the wallet is touched: an invalid
 * address here is money burned to an unspendable script.
 */
export async function sendToAddress(args: {
  wallet: AddressRailWallet
  adminOriginator: string
  address: string
  satoshis: number
  /**
   * The sender's own note for this outbound send. There is no counterparty
   * channel on this rail — an address names no one to notify — so this is
   * purely the payer's own record: it replaces the abbreviated-address
   * description in their own activity list, nothing more.
   */
  note?: string
}): Promise<{ paidSatoshis: number }> {
  const { wallet, adminOriginator, address, satoshis, note } = args
  const sats = Math.round(Number(satoshis))
  if (!Number.isFinite(sats) || sats <= 0) throw new Error('Invalid amount')
  if (!isValidBsvAddress(address)) throw new Error('Invalid BSV address')
  // XR-057 (SEC2-065): this rail only ever builds a P2PKH lock (see the D4
  // comment above — P2SH is deliberately unsupported), so a well-formed
  // base58check address whose version byte names neither mainnet nor a test
  // chain (e.g. a P2SH `3...` address) must be refused here, as a repo-owned
  // guarantee, rather than relying on @bsv/sdk's P2PKH.lock() to keep
  // throwing for a non-P2PKH version byte.
  if (addressNetwork(address) === undefined) throw new Error('Unsupported address type')
  const lockingScript = new P2PKH().lock(address).toHex()
  // A send-max request carries maxPossibleSatoshis and the wallet rewrites the
  // output to whatever the inputs can fund, so the real figure only exists on
  // the returned transaction. randomizeOutputs: false pins it to output 0.
  const isSendMax = sats === 2099999999999999
  const result = (await wallet.createAction(
    {
      // The recipient's address is the description so the activity list has a
      // name for the row without a lookup; the to: label is what lets it draw
      // a face. A sender's own note overrides it, same as the other rails.
      description: note?.trim() || abbreviateKey(address),
      outputs: [{ lockingScript, satoshis: sats, outputDescription: 'BSV for recipient address' }],
      labels: ['legacy', 'outbound', addressLabel(TO_ADDRESS_LABEL_PREFIX, address)],
      ...(isSendMax ? { options: { randomizeOutputs: false } } : {})
    },
    adminOriginator
  )) as { tx?: number[] }
  if (!isSendMax) return { paidSatoshis: sats }
  if (!result.tx) throw new Error('Could not determine send-max amount')
  const tx = Transaction.fromAtomicBEEF(result.tx)
  const paid = tx.outputs[0]?.satoshis
  if (typeof paid !== 'number' || paid <= 0) throw new Error('Could not determine send-max amount')
  return { paidSatoshis: paid }
}
