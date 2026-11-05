/**
 * Sweep: move coins that an EXTERNAL key controls into this wallet.
 *
 * Two sources of external keys:
 *  - a WIF private key (paper wallet, exported key), see sweepWif;
 *  - a BIP-39 recovery phrase from another BSV wallet, see sweepMnemonic.
 *
 * The address rail's sweepAddress cannot do this. It internalizes outputs the
 * wallet can derive a key for itself; an external key is outside the wallet's
 * key tree, so its coins must be SPENT. The spend uses the wallet's own
 * createAction with the external outpoints as inputs and no outputs: the
 * wallet adds change outputs into its default basket, sets the fee and
 * broadcasts. This module signs only the external inputs (signAction). That
 * keeps fee, change, broadcast and ledger in the wallet, where they already
 * work, and matches the mnemonic-to-brc100 demo that was the model for it.
 *
 * Every sweep is two steps, so the app can ask before it spends:
 *  1. plan (planWifSweep / scanMnemonic / decideMnemonicImport): reads
 *     WhatsOnChain only, returns the balance, UTXO count, estimated fee and
 *     what it will not spend. No wallet write, no broadcast.
 *  2. execute (sweepWif / sweepMnemonic): spends the plan's inputs in batches
 *     of at most maxInputsPerTx, one transaction per batch.
 *
 * What a sweep never spends:
 *  - 1-satoshi outputs: these are tokens (1Sat ordinals and the like), and a
 *    plain spend would burn them. They are reported as `token`.
 *  - outputs worth less than the fee for their own input: reported as `dust`.
 *  - outputs whose real locking script is not plain P2PKH to the swept
 *    address: reported as `nonstandard`.
 *
 * Secret material. The WIF and the phrase are never persisted, logged, or put
 * into a label or description; the plan holds addresses and derivation paths,
 * never keys. Byte arrays derived from them (the decoded WIF, the BIP-39 seed)
 * are filled with zeros after use. JavaScript strings are immutable and a
 * PrivateKey holds a BigNumber, so this module cannot wipe the caller's input
 * string or the key objects; it drops its references and that is all.
 */
import {
  Beef,
  Hash,
  HD,
  Mnemonic,
  P2PKH,
  PrivateKey,
  Transaction,
  UnlockingScript,
  Utils,
  type CreateActionArgs,
  type CreateActionResult,
  type SignActionArgs,
  type SignActionResult,
  type AbortActionArgs
} from '@bsv/sdk'
import type { BackupChain } from '../../backup/constants'
import { deriveProfileKeys } from '../../mnemonicWallet'
import type { ProfileProbe } from '../../profiles/discovery'
import { getUtxosForAddress, parseWocBeefBody, wocFetch, WocRateLimited, type Utxo, type WocConfig } from './address'

type Network = 'mainnet' | 'testnet'

/** The three wallet calls a sweep makes. A subset of WalletInterface. */
export interface SweepWallet {
  createAction(args: CreateActionArgs, originator?: string): Promise<CreateActionResult>
  signAction(args: SignActionArgs, originator?: string): Promise<SignActionResult>
  abortAction(args: AbortActionArgs, originator?: string): Promise<unknown>
}

// ─── Keys ────────────────────────────────────────────────────────────────────

const WIF_PREFIX: Record<number, Network> = { 0x80: 'mainnet', 0xef: 'testnet' }
const ADDRESS_VERSION: Record<Network, number> = { mainnet: 0x00, testnet: 0x6f }

export interface ParsedWif {
  key: PrivateKey
  /** False for an old-style (uncompressed public key) WIF, the `5…` / `9…` form. */
  compressed: boolean
  network: Network
}

/**
 * Decode a WIF private key. Accepts mainnet (0x80) and testnet (0xef), with
 * and without the compression flag. The SDK's PrivateKey.fromWif refuses the
 * uncompressed form and drops the network, so the decode is done here.
 */
export function parseWif(wif: string): ParsedWif {
  let decoded: { prefix: number[] | string; data: number[] | string }
  try {
    decoded = Utils.fromBase58Check(wif.trim())
  } catch {
    throw new Error('Not a valid private key (WIF)')
  }
  const prefix = decoded.prefix as number[]
  const data = decoded.data as number[]
  try {
    const network = prefix.length === 1 ? WIF_PREFIX[prefix[0]] : undefined
    if (network === undefined) throw new Error('Not a BSV private key (unknown WIF network)')
    let compressed: boolean
    if (data.length === 33 && data[32] === 0x01) compressed = true
    else if (data.length === 32) compressed = false
    else throw new Error('Not a valid private key (WIF length)')
    const key = new PrivateKey(data.slice(0, 32), 16, 'be', 'error')
    return { key, compressed, network }
  } finally {
    wipe(data)
  }
}

/** Whether a string is a WIF private key, for the app's Import screen to route on. */
export function isWif(text: string): boolean {
  try {
    parseWif(text)
    return true
  } catch {
    return false
  }
}

/** The P2PKH address of a key, in the compressed or uncompressed public key form. */
export function addressForKey(key: PrivateKey, compressed: boolean, network: Network): string {
  const pub = key.toPublicKey().encode(compressed) as number[]
  return Utils.toBase58Check(Hash.hash160(pub) as number[], [ADDRESS_VERSION[network]])
}

function wipe(bytes: number[] | Uint8Array | undefined): void {
  if (bytes) bytes.fill(0)
}

// ─── Derivation paths ────────────────────────────────────────────────────────

/**
 * One wallet's derivation scheme. `receive` is the chain prefix: address i is
 * `${receive}/${i}`. `change` is the change chain; left out, it is
 * changeChainFor(receive); `null` means the scheme has none. The change chain
 * is scanned only when the receive chain has at least one used address.
 */
export interface SweepPathSpec {
  name: string
  receive: string
  change?: string | null
}

/**
 * The change chain of a receive chain: a trailing non-hardened `/0` becomes
 * `/1` (BIP-32/44: external chain 0, internal chain 1). Undefined when the
 * receive chain does not end in `/0`.
 */
export function changeChainFor(receive: string): string | undefined {
  const match = /^(.*)\/0$/.exec(normalizePath(receive))
  return match ? `${match[1]}/1` : undefined
}

function spec(name: string, receive: string): SweepPathSpec {
  return { name, receive }
}

/**
 * The default scan. A PLACEHOLDER, to be replaced by the list the product
 * owner supplies; pass `paths` to override it.
 *
 * Taken from the mnemonic-to-brc100 demo (bsv-blockchain-demos), with one
 * change: the demo appends the address index straight onto `m/44'/236'/0'`
 * and `m/44'/0'/0'`, which skips the BIP-44 chain level. ElectrumSV and other
 * BIP-44 wallets put address i at `m/44'/coin'/0'/0/i` (change: `/1/i`), so
 * those entries carry the `/0` here.
 */
export const DEFAULT_SWEEP_PATHS: readonly SweepPathSpec[] = [
  spec('Centbee', "m/44'/0/0"),
  spec('RockWallet', "m/0'/0"),
  spec('ElectrumSV', "m/44'/236'/0'/0"),
  spec('BIP-44 (coin 0)', "m/44'/0'/0'/0")
]

/** Consecutive unused addresses that end the scan of one chain. */
export const DEFAULT_GAP_LIMIT = 20
/** Hard ceiling on the index scanned in one chain, whatever the gap rule says. */
export const MAX_SCAN_INDEX = 10_000

function normalizePath(path: string): string {
  return path.trim().replace(/[’h]/g, "'")
}

function assertPath(path: string): string {
  const p = normalizePath(path)
  if (!/^m(\/\d+'?)+$/.test(p)) throw new Error(`Invalid derivation path: ${path}`)
  return p
}

// ─── WhatsOnChain reads ──────────────────────────────────────────────────────

/**
 * Space WhatsOnChain requests at least `minIntervalMs` apart. The default fits
 * the anonymous limit (3 requests/s); a caller with an API key can lower it.
 */
export const DEFAULT_WOC_INTERVAL_MS = 350

function pacer(minIntervalMs: number): () => Promise<void> {
  let last = 0
  return async () => {
    const wait = last + minIntervalMs - Date.now()
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
    last = Date.now()
  }
}

/**
 * Whether an address has any on-chain history: the gap rule's "used".
 *
 * WhatsOnChain answers an address with no history with HTTP 404 and the body
 * `Not Found` (checked live, Nov 2026); an unknown route answers 404 with
 * `404 page not found`. Only the first means "unused". Any other failure
 * throws: a scan that cannot read the chain must not report "nothing found",
 * because decideMnemonicImport then restores the phrase as this wallet's root
 * and the coins of the old wallet are never looked for again.
 *
 * (`/address/{a}/used` is not an alternative: it answered `true` for a fresh
 * address in the same check.)
 */
async function addressHasHistory(woc: WocConfig, address: string): Promise<boolean> {
  const response = await wocFetch(woc, `${woc.apiBase}/v1/bsv/${woc.segment}/address/${address}/history`)
  if (response.status === 404) {
    if ((await response.text()).trim() === 'Not Found') return false
    throw new Error('WhatsOnChain history lookup is not available (404)')
  }
  if (!response.ok) throw new Error(`WhatsOnChain history lookup failed (${response.status})`)
  const body = await response.json()
  if (Array.isArray(body)) return body.length > 0
  if (Array.isArray(body?.result)) return body.result.length > 0
  throw new Error('WhatsOnChain history lookup returned an unexpected body')
}

// ─── Plan ────────────────────────────────────────────────────────────────────

export interface SweepInput extends Utxo {
  address: string
  /** Full derivation path of the key, for a mnemonic sweep. */
  path?: string
}

export type SkipReason = 'token' | 'dust' | 'nonstandard'

export interface SkippedOutput extends Utxo {
  address: string
  reason: SkipReason
}

export interface SweepPlan {
  network: Network
  /** What the sweep will spend. */
  inputs: SweepInput[]
  /** What it will not spend, and why. */
  skipped: SkippedOutput[]
  /** Sum of `inputs`, as WhatsOnChain reports it (the execute step uses the real figures). */
  totalSatoshis: number
  utxoCount: number
  estimatedFeeSatoshis: number
  /** totalSatoshis minus estimatedFeeSatoshis: "Found X BSV, sweep it?" */
  estimatedImportSatoshis: number
  batchCount: number
}

export interface FeeOptions {
  /** Rate for the preview estimate and the dust rule. Default 100, the wallet's own fee model. */
  satoshisPerKilobyte?: number
  /** Most inputs in one transaction. Default MAX_INPUTS_PER_TX. */
  maxInputsPerTx?: number
}

export const DEFAULT_SATOSHIS_PER_KB = 100
/** About 15 kB per transaction at the compressed P2PKH input size. */
export const MAX_INPUTS_PER_TX = 100
/**
 * The execute step refuses a transaction the wallet built with a higher fee
 * rate than this: ten times the wallet's own model, the same 1 sat/byte ceiling
 * the demo used.
 */
export const MAX_SWEEP_FEE_RATE = 1000

/** Unlocking script: signature push (1 + 73 at most) and public key push (1 + 33, or 1 + 65 uncompressed). */
function unlockingScriptLength(compressed: boolean): number {
  return compressed ? 108 : 140
}

/** Bytes: outpoint 36 + script length 1 + unlocking script + sequence 4. */
function inputBytes(compressed: boolean): number {
  return 41 + unlockingScriptLength(compressed)
}
const TX_OVERHEAD_BYTES = 10
const CHANGE_OUTPUT_BYTES = 34

function feeFor(bytes: number, rate: number): number {
  return Math.ceil((bytes * rate) / 1000)
}

/**
 * Turn found UTXOs into a plan. Pure: the dust rule, the token rule and the
 * batch split are all here, so they are tested without a network.
 */
export function planSweep(
  found: SweepInput[],
  network: Network,
  options: FeeOptions & { compressedFor?: (input: SweepInput) => boolean } = {}
): SweepPlan {
  const rate = options.satoshisPerKilobyte ?? DEFAULT_SATOSHIS_PER_KB
  const maxInputs = Math.max(1, options.maxInputsPerTx ?? MAX_INPUTS_PER_TX)
  const compressedFor = options.compressedFor ?? (() => true)

  const inputs: SweepInput[] = []
  const skipped: SkippedOutput[] = []
  const seen = new Set<string>()
  for (const utxo of found) {
    const id = `${utxo.txid}.${utxo.vout}`
    if (seen.has(id)) continue
    seen.add(id)
    if (utxo.satoshis === 1) skipped.push({ ...utxo, reason: 'token' })
    else if (utxo.satoshis <= feeFor(inputBytes(compressedFor(utxo)), rate)) skipped.push({ ...utxo, reason: 'dust' })
    else inputs.push(utxo)
  }

  let estimatedFeeSatoshis = 0
  const batchCount = Math.ceil(inputs.length / maxInputs)
  for (let b = 0; b < batchCount; b++) {
    const batch = inputs.slice(b * maxInputs, (b + 1) * maxInputs)
    const bytes = TX_OVERHEAD_BYTES + CHANGE_OUTPUT_BYTES + batch.reduce((n, i) => n + inputBytes(compressedFor(i)), 0)
    estimatedFeeSatoshis += feeFor(bytes, rate)
  }
  const totalSatoshis = inputs.reduce((n, i) => n + i.satoshis, 0)
  return {
    network,
    inputs,
    skipped,
    totalSatoshis,
    utxoCount: inputs.length,
    estimatedFeeSatoshis,
    estimatedImportSatoshis: Math.max(0, totalSatoshis - estimatedFeeSatoshis),
    batchCount
  }
}

function assertNetwork(woc: WocConfig, network: Network): void {
  if (woc.network !== network) {
    throw new Error(`This key is for ${network}, but the wallet is on ${woc.network}`)
  }
}

// ─── WIF ─────────────────────────────────────────────────────────────────────

/** Preview a WIF sweep: balance, UTXO count, fee. Reads WhatsOnChain only. */
export async function planWifSweep(args: { wif: string; woc: WocConfig } & FeeOptions): Promise<SweepPlan> {
  const { key, compressed, network } = parseWif(args.wif)
  assertNetwork(args.woc, network)
  const address = addressForKey(key, compressed, network)
  const utxos = await getUtxosForAddress(args.woc, address)
  return planSweep(
    utxos.map(u => ({ ...u, address })),
    network,
    { ...args, compressedFor: () => compressed }
  )
}

export interface SweepBatchResult {
  txid?: string
  inputCount: number
  inputSatoshis: number
  importedSatoshis: number
  feeSatoshis: number
  error?: string
}

export interface SweepResult {
  /** One per batch that went through. */
  txids: string[]
  importedSatoshis: number
  utxoCount: number
  feeSatoshis: number
  batches: SweepBatchResult[]
  /** The plan's skipped outputs, plus any the execute step skipped on the real transaction. */
  skipped: SkippedOutput[]
  /**
   * Set when WhatsOnChain rate-limited the sweep: the batches after the
   * limited one were not tried. Their coins are still on the external key, so
   * a new plan and sweep later picks them up.
   */
  stoppedBy?: 'rate-limit'
}

interface ExecuteArgs {
  wallet: SweepWallet
  adminOriginator: string
  woc: WocConfig
  /** From the plan step. Build a new plan if a sweep fails on a spent input. */
  plan: SweepPlan
  description: string
  maxInputsPerTx?: number
  maxFeeRate?: number
  minRequestIntervalMs?: number
}

/**
 * Spend a WIF key's coins into this wallet. Pass the plan from planWifSweep
 * (the one the user confirmed); without one, a plan is built here.
 */
export async function sweepWif(
  args: Omit<ExecuteArgs, 'plan' | 'description'> & { wif: string; plan?: SweepPlan } & FeeOptions
): Promise<SweepResult> {
  const { key, compressed, network } = parseWif(args.wif)
  assertNetwork(args.woc, network)
  const address = addressForKey(key, compressed, network)
  const plan = args.plan ?? (await planWifSweep(args))
  const { spent: _spent, ...result } = await executeSweep({
    ...args,
    plan,
    description: 'Swept from a private key',
    keyFor: input => {
      if (input.address !== address) throw new Error('The plan does not belong to this key')
      return { key, compressed }
    }
  })
  return result
}

// ─── Mnemonic ────────────────────────────────────────────────────────────────

export interface PathScanSummary {
  name: string
  receive: string
  change?: string
  /** Addresses with any on-chain history, receive and change together. */
  usedAddresses: number
  utxoCount: number
  satoshis: number
  /** Whether the change chain was scanned (only after the receive chain showed use). */
  changeScanned: boolean
}

export interface MnemonicScanPlan extends SweepPlan {
  paths: PathScanSummary[]
}

export interface MnemonicScanArgs extends FeeOptions {
  mnemonic: string
  passphrase?: string
  woc: WocConfig
  paths?: readonly SweepPathSpec[]
  gapLimit?: number
  minRequestIntervalMs?: number
}

/**
 * Lower case, single spaces. Use the same form to restore a phrase that
 * decideMnemonicImport classified, so the backup check and the restore see
 * one seed.
 */
export function normalizeMnemonic(mnemonic: string): string {
  return mnemonic.trim().toLowerCase().split(/\s+/).join(' ')
}

function withSeed<T>(mnemonic: string, passphrase: string, use: (root: HD) => T): T {
  const seed = Mnemonic.fromString(normalizeMnemonic(mnemonic)).toSeed(passphrase)
  try {
    return use(HD.fromSeed(seed))
  } finally {
    wipe(seed)
  }
}

/**
 * Scan an external recovery phrase. For each path: walk the receive chain
 * until `gapLimit` addresses in a row have no history; if any address was
 * used, walk the change chain the same way. Collect the unspent outputs of
 * every used address. Reads WhatsOnChain only.
 */
export async function scanMnemonic(args: MnemonicScanArgs): Promise<MnemonicScanPlan> {
  const network = args.woc.network
  const gapLimit = Math.max(1, args.gapLimit ?? DEFAULT_GAP_LIMIT)
  const pace = pacer(args.minRequestIntervalMs ?? DEFAULT_WOC_INTERVAL_MS)
  const specs = (args.paths ?? DEFAULT_SWEEP_PATHS).map(s => {
    const change = s.change === null ? undefined : (s.change ?? changeChainFor(s.receive))
    return {
      name: s.name,
      receive: assertPath(s.receive),
      change: change !== undefined ? assertPath(change) : undefined
    }
  })
  // The PBKDF2 seed and every chain node are built up front, synchronously,
  // so the seed is wiped before the first network await.
  const chains = withSeed(args.mnemonic, args.passphrase ?? '', root =>
    specs.map(s => ({ spec: s, receive: root.derive(s.receive), change: s.change ? root.derive(s.change) : undefined }))
  )

  const found: SweepInput[] = []
  const summaries: PathScanSummary[] = []

  const walk = async (node: HD, prefix: string): Promise<{ used: number; inputs: SweepInput[] }> => {
    let used = 0
    let unusedRun = 0
    const inputs: SweepInput[] = []
    for (let i = 0; i < MAX_SCAN_INDEX && unusedRun < gapLimit; i++) {
      const address = addressForKey(node.deriveChild(i).privKey, true, network)
      await pace()
      if (!(await addressHasHistory(args.woc, address))) {
        unusedRun++
        continue
      }
      unusedRun = 0
      used++
      await pace()
      const utxos = await getUtxosForAddress(args.woc, address)
      inputs.push(...utxos.map(u => ({ ...u, address, path: `${prefix}/${i}` })))
    }
    return { used, inputs }
  }

  for (const chain of chains) {
    const receive = await walk(chain.receive, chain.spec.receive)
    let change = { used: 0, inputs: [] as SweepInput[] }
    const changeScanned = receive.used > 0 && chain.change !== undefined
    if (changeScanned) change = await walk(chain.change!, chain.spec.change!)
    found.push(...receive.inputs, ...change.inputs)
    summaries.push({
      name: chain.spec.name,
      receive: chain.spec.receive,
      change: chain.spec.change,
      usedAddresses: receive.used + change.used,
      utxoCount: 0,
      satoshis: 0,
      changeScanned
    })
  }

  // Per-path figures count only what the sweep will spend, not tokens or dust.
  const plan = planSweep(found, network, args)
  for (const input of plan.inputs) {
    const owner = summaries.find(s => ownsPath(s, input.path!))
    if (owner) {
      owner.utxoCount++
      owner.satoshis += input.satoshis
    }
  }
  return { ...plan, paths: summaries }
}

function ownsPath(summary: { receive: string; change?: string }, path: string): boolean {
  return (
    path.startsWith(`${summary.receive}/`) || (summary.change !== undefined && path.startsWith(`${summary.change}/`))
  )
}

export interface MnemonicSweepResult extends SweepResult {
  /** Swept satoshis per path name, as spent (before the fee, which is per transaction). */
  pathTotals: Record<string, number>
}

/**
 * Spend the coins a scanMnemonic plan found. Keys are derived again from the
 * phrase for each input's path, and each must match the input's address.
 */
export async function sweepMnemonic(
  args: Omit<ExecuteArgs, 'plan' | 'description'> & Omit<MnemonicScanArgs, 'woc'> & { plan?: MnemonicScanPlan }
): Promise<MnemonicSweepResult> {
  const plan = args.plan ?? (await scanMnemonic(args))
  const network = args.woc.network
  assertNetwork(args.woc, plan.network)
  const keys = withSeed(args.mnemonic, args.passphrase ?? '', root => {
    const byPath = new Map<string, PrivateKey>()
    for (const input of plan.inputs) {
      if (!input.path) throw new Error('The plan has an input without a derivation path')
      const path = assertPath(input.path)
      if (!byPath.has(path)) byPath.set(path, root.derive(path).privKey)
    }
    return byPath
  })

  const { spent, ...result } = await executeSweep({
    ...args,
    plan,
    description: 'Swept from a recovery phrase',
    keyFor: input => {
      const key = keys.get(assertPath(input.path ?? ''))
      if (!key || addressForKey(key, true, network) !== input.address) {
        throw new Error('The plan does not belong to this recovery phrase')
      }
      return { key, compressed: true }
    }
  })
  keys.clear()

  const pathTotals: Record<string, number> = {}
  for (const summary of plan.paths) pathTotals[summary.name] = 0
  for (const input of spent) {
    const owner = plan.paths.find(p => ownsPath(p, input.path!))
    if (owner) pathTotals[owner.name] += input.satoshis
  }
  return { ...result, pathTotals }
}

// ─── Import decision ─────────────────────────────────────────────────────────

export type MnemonicImportDecision =
  /** The private backup cache knows this phrase: restore it as this wallet. */
  | { kind: 'restore' }
  /** Not backed up, and the scan found coins: preview, then sweepMnemonic. */
  | { kind: 'sweep'; plan: MnemonicScanPlan }
  /** Not backed up, nothing found: restore it as this wallet's root (a new or never-backed-up wallet). */
  | { kind: 'empty'; plan?: MnemonicScanPlan }

/**
 * What to do with a phrase the user enters on Import, in one call:
 *  1. backup cache hit for profile 0 → 'restore';
 *  2. otherwise scan the external paths; coins found → 'sweep';
 *  3. otherwise → 'empty'.
 *
 * A failed cache lookup throws rather than falling through to the scan: a
 * wallet that has a backup must never be taken for an external one.
 * `probe` is `backupProbe(baseUrl)` from profiles/discovery; leave it out when
 * the build has no backup service. Without `woc` (a network with no
 * WhatsOnChain) there is nothing to scan, so the answer is 'empty'.
 */
export async function decideMnemonicImport(
  args: Omit<MnemonicScanArgs, 'woc'> & {
    chain: BackupChain
    probe?: ProfileProbe
    woc: WocConfig | undefined
  }
): Promise<MnemonicImportDecision> {
  if (args.probe) {
    // Profile 0 of the phrase, derived exactly as the wallet derives it (deriveProfileKeys).
    const primaryKey = withSeed(args.mnemonic, args.passphrase ?? '', root => deriveProfileKeys(root, 0).primaryKey)
    try {
      if (await args.probe(primaryKey, args.chain)) return { kind: 'restore' }
    } finally {
      wipe(primaryKey)
    }
  }
  if (!args.woc) return { kind: 'empty' }
  const plan = await scanMnemonic({ ...args, woc: args.woc })
  return plan.inputs.length > 0 ? { kind: 'sweep', plan } : { kind: 'empty', plan }
}

// ─── Execute ─────────────────────────────────────────────────────────────────

async function fetchSourceBeef(woc: WocConfig, txid: string): Promise<Beef> {
  const response = await wocFetch(woc, `${woc.apiBase}/v1/bsv/${woc.segment}/tx/${txid}/beef`)
  const bytes = parseWocBeefBody({ ok: response.ok, text: await response.text() })
  if (!bytes) throw new Error(`Could not fetch the source transaction ${txid}`)
  const beef = new Beef()
  beef.mergeBeef(bytes)
  return beef
}

async function executeSweep(
  args: ExecuteArgs & { keyFor: (input: SweepInput) => { key: PrivateKey; compressed: boolean } }
): Promise<SweepResult & { spent: SweepInput[] }> {
  const { wallet, adminOriginator, woc, plan } = args
  const maxInputs = Math.max(1, args.maxInputsPerTx ?? MAX_INPUTS_PER_TX)
  const maxFeeRate = args.maxFeeRate ?? MAX_SWEEP_FEE_RATE
  const pace = pacer(args.minRequestIntervalMs ?? DEFAULT_WOC_INTERVAL_MS)
  const skipped: SkippedOutput[] = [...plan.skipped]
  const batches: SweepBatchResult[] = []
  const spent: SweepInput[] = []
  let stoppedBy: SweepResult['stoppedBy']

  // Keys are resolved before any network call, so a plan that does not belong
  // to the key fails before anything is fetched or built.
  const keyed = plan.inputs.map(input => ({ input, ...args.keyFor(input) }))
  const sources = new Map<string, Beef>()

  for (let start = 0; start < keyed.length; start += maxInputs) {
    const candidates = keyed.slice(start, start + maxInputs)
    const batch: SweepBatchResult = { inputCount: 0, inputSatoshis: 0, importedSatoshis: 0, feeSatoshis: 0 }
    let reference: string | undefined
    try {
      // Verify each input against the real source transaction: its real value
      // (not WhatsOnChain's figure) and its real script.
      const inputBeef = new Beef()
      const spend = new Map<string, (typeof keyed)[number] & { satoshis: number }>()
      for (const k of candidates) {
        let source = sources.get(k.input.txid)
        if (!source) {
          await pace()
          source = await fetchSourceBeef(woc, k.input.txid)
          sources.set(k.input.txid, source)
        }
        const output = source.findTxid(k.input.txid)?.tx?.outputs[k.input.vout]
        const expected = new P2PKH().lock(k.input.address).toHex()
        if (!output || output.lockingScript.toHex() !== expected) {
          skipped.push({ ...k.input, reason: 'nonstandard' })
          continue
        }
        const satoshis = output.satoshis ?? 0
        if (satoshis <= 1) {
          skipped.push({ ...k.input, satoshis, reason: satoshis === 1 ? 'token' : 'dust' })
          continue
        }
        inputBeef.mergeBeef(source.toBinaryAtomic(k.input.txid))
        spend.set(`${k.input.txid}.${k.input.vout}`, { ...k, satoshis })
      }
      if (spend.size === 0) continue
      batches.push(batch)

      const created = await wallet.createAction(
        {
          description: args.description,
          inputBEEF: inputBeef.toBinary(),
          inputs: [...spend.keys()].map(outpoint => ({
            outpoint,
            unlockingScriptLength: unlockingScriptLength(spend.get(outpoint)!.compressed),
            inputDescription: 'Swept coin'
          })),
          labels: ['sweep', 'inbound']
        },
        adminOriginator
      )
      const signable = created.signableTransaction
      if (!signable) throw new Error('The wallet did not return a transaction to sign')
      reference = signable.reference
      const tx = Transaction.fromAtomicBEEF(signable.tx)

      // The wallet must have added nothing of its own on the input side: a
      // sweep moves external coins in, it never spends this wallet's coins.
      if (tx.inputs.length !== spend.size) throw new Error('The wallet added inputs to the sweep')
      const spends: Record<number, { unlockingScript: string }> = {}
      for (let i = 0; i < tx.inputs.length; i++) {
        const input = tx.inputs[i]
        const outpoint = `${input.sourceTXID ?? input.sourceTransaction?.id('hex')}.${input.sourceOutputIndex}`
        const k = spend.get(outpoint)
        if (!k) throw new Error('The wallet added inputs to the sweep')
        let script = await new P2PKH()
          .unlock(k.key, 'all', false, k.satoshis, new P2PKH().lock(k.input.address))
          .sign(tx, i)
        if (!k.compressed) {
          const pub = k.key.toPublicKey().encode(false) as number[]
          script = new UnlockingScript([script.chunks[0], { op: pub.length, data: pub }])
        }
        input.unlockingScript = script
        spends[i] = { unlockingScript: script.toHex() }
      }

      const inputSatoshis = [...spend.values()].reduce((n, k) => n + k.satoshis, 0)
      const outputSatoshis = tx.outputs.reduce((n, o) => n + (o.satoshis ?? 0), 0)
      const fee = inputSatoshis - outputSatoshis
      const rate = (fee * 1000) / tx.toBinary().length
      if (fee < 0 || rate > maxFeeRate) throw new Error(`Sweep fee too high (${Math.round(rate)} sat/kB)`)

      const signed = await wallet.signAction(
        { reference, spends, options: { acceptDelayedBroadcast: false, returnTXIDOnly: true } },
        adminOriginator
      )
      reference = undefined
      // With acceptDelayedBroadcast false the wallet throws WERR_REVIEW_ACTIONS on a
      // failed broadcast (toolbox-mobile 2.15.1); this check covers a wallet that reports instead.
      const failed = signed.sendWithResults?.find(r => r.status !== 'unproven' && r.status !== 'sending')
      if (failed) throw new Error(`The sweep broadcast failed (${failed.status})`)
      if (!signed.txid) throw new Error('The wallet did not broadcast the sweep')
      Object.assign(batch, {
        txid: signed.txid,
        inputCount: spend.size,
        inputSatoshis,
        importedSatoshis: outputSatoshis,
        feeSatoshis: fee
      })
      for (const k of spend.values()) spent.push({ ...k.input, satoshis: k.satoshis })
    } catch (error) {
      if (!batches.includes(batch)) batches.push(batch)
      batch.error = error instanceof Error ? error.message : String(error)
      if (reference) {
        try {
          await wallet.abortAction({ reference }, adminOriginator)
        } catch {
          // The wallet expires an unsigned action on its own; the error above is what matters.
        }
      }
      // The next batch would be refused the same way and only deepen the limit.
      if (error instanceof WocRateLimited) {
        stoppedBy = 'rate-limit'
        break
      }
    }
  }

  const done = batches.filter(b => b.txid)
  return {
    ...(stoppedBy ? { stoppedBy } : {}),
    txids: done.map(b => b.txid!),
    importedSatoshis: done.reduce((n, b) => n + b.importedSatoshis, 0),
    utxoCount: done.reduce((n, b) => n + b.inputCount, 0),
    feeSatoshis: done.reduce((n, b) => n + b.feeSatoshis, 0),
    batches,
    skipped,
    spent
  }
}
