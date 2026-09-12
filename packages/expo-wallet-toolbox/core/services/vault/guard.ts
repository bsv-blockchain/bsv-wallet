/**
 * External-wallet boundary for the Vault.
 *
 * Vault ownership is determined from authenticated wallet history and the exact
 * current R1C locking script. It is never inferred from a basket name supplied
 * by an external caller. This matters because BRC-100 operations can name an
 * existing output by outpoint: without this guard an application that learned a
 * Vault outpoint could reserve it with createAction or reclassify it with
 * internalizeAction without first obtaining access to the `admin vault` basket.
 */
import {
  LockingScript,
  Transaction,
  Validation,
  type ListActionsArgs,
  type ListActionsResult,
  type WalletAction,
  type WalletInterface
} from '@bsv/sdk'
import { bakedCommitments, R1C_LOCK_LEN, R1C_MAX_KEYS } from './r1comb'

const VAULT_BASKET = 'admin vault'
const VAULT_LABEL = 'vault'
// An R1C locking script is about 45 KB before JS string/object overhead. Keep
// only a small enriched page live at once; the scanners below stream rows and
// retain only compact identifiers or the caller's requested visible slice.
const ACTION_PAGE = 32
const MAX_ACTION_SCAN = 10_000
const MAX_EXTERNAL_ACTION_RESULTS = 500
const MAX_EXTERNAL_ACTION_LABELS = 64
const MAX_EXTERNAL_ACTION_LABEL_BYTES = 4096
const MAX_EXTERNAL_ACTION_OFFSET = MAX_ACTION_SCAN
/** Permission-backed reads must never retain the exclusive inventory slot
 * indefinitely while a connected origin leaves a prompt unanswered. */
export const EXTERNAL_ACTION_READ_TIMEOUT_MS = 30_000
/** Bound queued scans as well as active scans. A connected origin can issue
 * concurrent RPCs, so serialization alone would otherwise turn the promise
 * queue into another unbounded memory sink. */
const MAX_GUARDED_QUEUE = 16
const LIST_ACTION_BOOLEAN_FIELDS = [
  'includeLabels',
  'includeInputs',
  'includeInputSourceLockingScripts',
  'includeInputUnlockingScripts',
  'includeOutputs',
  'includeOutputLockingScripts',
  'seekPermission'
] as const
const LIST_ACTION_FIELDS = new Set<string>([
  'labels',
  'labelQueryMode',
  ...LIST_ACTION_BOOLEAN_FIELDS,
  'limit',
  'offset'
])

/** BRC-100 methods that accept `privileged: true` and would return or use the
 * wallet's root key. Vault keys do not live in that hierarchy, but exposing the
 * root key to a connected application would still compromise the wallet. */
const PRIVILEGED_CAPABLE = new Set<keyof WalletInterface>([
  'getPublicKey',
  'revealCounterpartyKeyLinkage',
  'revealSpecificKeyLinkage',
  'encrypt',
  'decrypt',
  'createHmac',
  'verifyHmac',
  'createSignature',
  'verifySignature',
  'acquireCertificate',
  'proveCertificate',
  'listCertificates'
])
/** Protocol namespaces whose derived keys are internal Vault state. The
 * permissions manager deliberately exempts ordinary public-key revelation,
 * so this boundary must reserve them even when `privileged` is false. */
const VAULT_PROTOCOL_NAMES = new Set(['vault', 'vault salt'])

function requestsVaultProtocol(args: unknown): boolean {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return false
  const protocolID = (args as { protocolID?: unknown }).protocolID
  // Match KeyDeriver.computeInvoiceNumber's namespace normalization exactly.
  // Otherwise e.g. ` VAULT SALT ` reaches the same child key while evading a
  // literal boundary comparison. Reject matching malformed/extended tuples
  // here too; validation deeper in the wallet is not an authorization layer.
  return Array.isArray(protocolID) &&
    typeof protocolID[1] === 'string' &&
    VAULT_PROTOCOL_NAMES.has(protocolID[1].toLowerCase().trim())
}

/** Operations that can name an existing output or unsigned action without
 * going through basket-listing permission checks. */
const OUTPUT_NAMING = new Set<keyof WalletInterface>([
  'createAction',
  'internalizeAction',
  'relinquishOutput',
  'signAction',
  'abortAction'
])

interface ExtendedWalletAction extends WalletAction {
  reference?: string
}

interface VaultInventory {
  outpoints: Set<string>
  references: Set<string>
  /** Signed noSend Vault actions can be released by options.sendWith, so their
   * transaction ids are capabilities too, even when no protected outpoint is
   * named in the outer request. */
  txids: Set<string>
}

interface GuardRuntime {
  tail: Promise<void>
  queued: number
  /** Concurrent byte-identical external listActions reads share one scan.
   * Entries exist only while the scan is in flight; there is no stale cache. */
  reads: Map<string, Promise<ListActionsResult>>
}

/** One runtime per underlying wallet even if it is wrapped more than once. */
const GUARD_RUNTIMES = new WeakMap<object, GuardRuntime>()
/** Keep wrapping idempotent. Call sites compose wallet capabilities in several
 * layers, and wrapping an existing guard again must not acquire a second slot
 * around the first one and deadlock. Different admin authorities still get
 * distinct proxies, backed by the same underlying runtime. */
const GUARD_TARGETS = new WeakMap<object, object>()
const GUARDED_PROXIES = new WeakMap<object, Map<string, object>>()

function underlyingWallet(wallet: object): object {
  return GUARD_TARGETS.get(wallet) ?? wallet
}

function runtimeFor(wallet: object): GuardRuntime {
  let runtime = GUARD_RUNTIMES.get(wallet)
  if (!runtime) {
    runtime = { tail: Promise.resolve(), queued: 0, reads: new Map() }
    GUARD_RUNTIMES.set(wallet, runtime)
  }
  return runtime
}

/** Run one enriched-history operation at a time. The slot covers both the
 * inventory scan and the guarded mutation, so a second external request can
 * never act on a snapshot made stale by the first one. */
async function withGuardSlot<T>(runtime: GuardRuntime, work: () => Promise<T>, trusted = false): Promise<T> {
  // Trusted admin calls may enter behind a full external queue. Once queued,
  // continuous attacker traffic is rejected at the bound and cannot jump in
  // front of it; this keeps admin repair available without unbounding the
  // untrusted queue.
  if (!trusted && runtime.queued >= MAX_GUARDED_QUEUE) throw new Error('Too many guarded wallet operations')
  runtime.queued++
  const predecessor = runtime.tail
  let release!: () => void
  runtime.tail = new Promise<void>(resolve => { release = resolve })
  await predecessor
  try {
    return await work()
  } finally {
    runtime.queued--
    release()
  }
}

type ValidatedListActionsArgs = ReturnType<typeof Validation.validateListActionsArgs>

/** Apply bridge-specific structural and aggregate bounds before serialising a
 * read key. The SDK validates each label but places no bound on their count and
 * ignores unknown fields, so calling JSON.stringify on the raw object would
 * duplicate an attacker-sized graph before the guarded queue can refuse it. */
function validateExternalListActionsArgs(args: unknown): ValidatedListActionsArgs {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('Invalid listActions arguments')
  }
  const raw = args as Record<string, unknown>
  for (const key of Object.keys(raw)) {
    if (!LIST_ACTION_FIELDS.has(key)) throw new Error(`Unknown listActions field ${key}`)
  }
  if (raw.labels !== undefined && !Array.isArray(raw.labels)) throw new Error('Invalid listActions labels')
  const labels = (raw.labels ?? []) as unknown[]
  if (labels.length > MAX_EXTERNAL_ACTION_LABELS) throw new Error('Too many listActions labels')
  let labelBytes = 0
  for (const label of labels) {
    if (typeof label !== 'string' || label.length > 300) throw new Error('Invalid listActions label')
    labelBytes += new TextEncoder().encode(label).length
    if (labelBytes > MAX_EXTERNAL_ACTION_LABEL_BYTES) throw new Error('listActions labels are too large')
  }
  for (const field of LIST_ACTION_BOOLEAN_FIELDS) {
    if (raw[field] !== undefined && typeof raw[field] !== 'boolean') {
      throw new Error(`Invalid listActions ${field}`)
    }
  }
  const requested = Validation.validateListActionsArgs(args as ListActionsArgs)
  if (requested.limit > MAX_EXTERNAL_ACTION_RESULTS) throw new Error('listActions limit is too large')
  if (requested.offset > MAX_EXTERNAL_ACTION_OFFSET) throw new Error('listActions offset is too large')
  return requested
}

function externalReadKey(args: ValidatedListActionsArgs, originator: string): string {
  // `args` is a small, normalized object produced by the validator above.
  return `${originator}\0${JSON.stringify(args)}`
}

interface ReadDeadline {
  expiresAt: number
}

async function beforeReadDeadline<T>(promise: Promise<T>, deadline: ReadDeadline): Promise<T> {
  const remaining = deadline.expiresAt - Date.now()
  if (remaining <= 0) throw new Error('Guarded wallet read timed out')
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Guarded wallet read timed out')), remaining)
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) }
    )
  })
}

export class VaultAccessDenied extends Error {
  readonly code = 6

  constructor(method: string, originator: string) {
    super(`Wallet operation "${method}" is not permitted for origin "${originator || 'unknown'}"`)
    this.name = 'VaultAccessDenied'
  }
}

function deny(method: string, originator?: string): never {
  throw new VaultAccessDenied(method, originator ?? '')
}

/** Exact parser, including byte-for-byte regeneration of the current template. */
export function isR1CLockingScript(lockingScript: unknown): boolean {
  if (typeof lockingScript !== 'string') return false
  // The SDK trims locking-script strings during createAction validation. Match
  // that normalization here so whitespace cannot turn an exact R1C lock into
  // something the guard overlooks but the wallet later accepts.
  const normalized = lockingScript.trim()
  if (!/^[0-9a-fA-F]+$/.test(normalized) || normalized.length % 2 !== 0) {
    return false
  }
  const bytes = normalized.length / 2
  let possible = false
  for (let n = 1; n <= R1C_MAX_KEYS; n++) possible ||= bytes === R1C_LOCK_LEN(n)
  if (!possible) return false
  try {
    bakedCommitments(LockingScript.fromHex(normalized))
    return true
  } catch {
    return false
  }
}

function isSensitiveAction(action: ExtendedWalletAction): boolean {
  if (action.labels?.includes(VAULT_LABEL)) return true
  if (action.outputs?.some(output => output.basket.startsWith('admin') || isR1CLockingScript(output.lockingScript))) {
    return true
  }
  return !!action.inputs?.some(input => isR1CLockingScript(input.sourceLockingScript))
}

function enrichedArgs(args: ListActionsArgs, offset: number): ListActionsArgs {
  return {
    ...args,
    includeLabels: true,
    includeInputs: true,
    includeInputSourceLockingScripts: true,
    includeInputUnlockingScripts: false,
    includeOutputs: true,
    includeOutputLockingScripts: true,
    limit: ACTION_PAGE,
    offset
  }
}

/** Stream one stable logical list so protected rows cannot distort pagination
 * without retaining thousands of enriched R1C scripts in memory. */
async function scanAllActions(
  call: (args: ListActionsArgs, originator?: string) => Promise<ListActionsResult>,
  args: ListActionsArgs,
  originator: string,
  visit: (action: ExtendedWalletAction) => void,
  deadline?: ReadDeadline
): Promise<void> {
  const seen = new Set<string>()
  let expectedTotal: number | undefined
  let offset = 0
  for (;;) {
    const request = call(enrichedArgs(args, offset), originator)
    const page = deadline ? await beforeReadDeadline(request, deadline) : await request
    if (!page || !Array.isArray(page.actions) || !Number.isSafeInteger(page.totalActions) || page.totalActions < 0) {
      throw new Error('Wallet returned an invalid action page')
    }
    if (page.totalActions > MAX_ACTION_SCAN || page.actions.length > ACTION_PAGE) {
      throw new Error('Wallet action list exceeds the guarded scan bound')
    }
    if (expectedTotal === undefined) expectedTotal = page.totalActions
    else if (expectedTotal !== page.totalActions) throw new Error('Wallet action list changed while it was inspected')

    for (const action of page.actions as ExtendedWalletAction[]) {
      const identity = action.txid || (action.reference ? `reference:${action.reference}` : '')
      if (!identity || seen.has(identity)) throw new Error('Wallet returned a duplicate or unidentified action')
      seen.add(identity)
      visit(action)
    }
    if (page.actions.length === 0) {
      if (offset < page.totalActions) throw new Error('Wallet action list stopped before its reported total')
      break
    }
    offset += page.actions.length
    if (offset > page.totalActions) throw new Error('Wallet action list exceeded its reported total')
    if (offset === page.totalActions) break
  }
}

function sanitizeAction(action: ExtendedWalletAction, requested: ListActionsArgs): ExtendedWalletAction {
  const safe: ExtendedWalletAction = { ...action }
  if (!requested.includeLabels) delete safe.labels
  if (!requested.includeInputs) delete safe.inputs
  else if (safe.inputs) {
    safe.inputs = safe.inputs.map(input => {
      const copy = { ...input }
      if (!requested.includeInputSourceLockingScripts) delete copy.sourceLockingScript
      if (!requested.includeInputUnlockingScripts) delete copy.unlockingScript
      return copy
    })
  }
  if (!requested.includeOutputs) delete safe.outputs
  else if (!requested.includeOutputLockingScripts && safe.outputs) {
    safe.outputs = safe.outputs.map(output => {
      const copy = { ...output }
      delete copy.lockingScript
      return copy
    })
  }
  return safe
}

async function listActionsForExternal(
  call: (args: ListActionsArgs, originator?: string) => Promise<ListActionsResult>,
  requested: ValidatedListActionsArgs,
  originator: string,
  deadline: ReadDeadline
): Promise<ListActionsResult> {
  const { offset, limit } = requested
  let visibleCount = 0
  const visible: ExtendedWalletAction[] = []
  await scanAllActions(call, { ...requested, limit: undefined, offset: undefined }, originator, action => {
    if (isSensitiveAction(action)) return
    if (visibleCount >= offset && visible.length < limit) visible.push(sanitizeAction(action, requested))
    visibleCount++
  }, deadline)
  return {
    totalActions: visibleCount,
    actions: visible
  }
}

/** Authenticated all-action history is also a durable output inventory. The
 * exact script check protects a mislabeled R1C output as defense in depth. */
async function loadVaultInventory(
  call: (args: ListActionsArgs, originator?: string) => Promise<ListActionsResult>,
  adminOriginator: string
): Promise<VaultInventory> {
  const inventory: VaultInventory = { outpoints: new Set(), references: new Set(), txids: new Set() }
  await scanAllActions(call, { labels: [] }, adminOriginator, action => {
    const sensitive = isSensitiveAction(action)
    if (action.reference && sensitive) inventory.references.add(action.reference)
    if (action.txid && sensitive) inventory.txids.add(action.txid.toLowerCase())
    for (const output of action.outputs ?? []) {
      if (action.txid && (output.basket === VAULT_BASKET || isR1CLockingScript(output.lockingScript))) {
        inventory.outpoints.add(`${action.txid.toLowerCase()}.${output.outputIndex}`)
      }
    }
    for (const input of action.inputs ?? []) {
      if (isR1CLockingScript(input.sourceLockingScript)) inventory.outpoints.add(input.sourceOutpoint.toLowerCase())
    }
  })
  return inventory
}

/** `sendWith` is a broadcast capability for a previously signed noSend action.
 * Both createAction and signAction accept it, including when the surrounding
 * request does not otherwise touch a Vault input/output/reference. */
function requestedSendWithTxids(method: keyof WalletInterface, args: any): string[] | undefined {
  if (method !== 'createAction' && method !== 'signAction') return []
  const value = args?.options?.sendWith
  if (value === undefined) return []
  if (!Array.isArray(value)) return undefined
  const txids: string[] = []
  for (const txid of value) {
    if (typeof txid !== 'string' || !/^[0-9a-fA-F]{64}$/.test(txid)) return undefined
    txids.push(txid.toLowerCase())
  }
  return txids
}

function canonicalOutpoint(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const parts = value.split('.')
  if (parts.length !== 2 || !/^[0-9a-fA-F]{64}$/.test(parts[0])) return undefined
  // Mirror the SDK's Number(...) normalization so alternate spellings accepted
  // downstream ("00", "0e0", "-0", or even an empty suffix) cannot evade an
  // exact string comparison here.
  const vout = Number(parts[1])
  if (!Number.isSafeInteger(vout) || vout < 0) return undefined
  return `${parts[0].toLowerCase()}.${vout}`
}

function requestedOutpoints(method: keyof WalletInterface, args: any): string[] | undefined {
  let values: unknown[]
  if (method === 'createAction') values = (args?.inputs ?? []).map((input: any) => input?.outpoint)
  else if (method === 'relinquishOutput') values = [args?.output]
  else if (method !== 'internalizeAction') return []
  else {
    try {
      const txid = Transaction.fromAtomicBEEF(args?.tx).id('hex').toLowerCase()
      values = (args?.outputs ?? []).map((output: any) => `${txid}.${String(output?.outputIndex ?? '')}`)
    } catch {
      return undefined
    }
  }
  const canonical = values.map(canonicalOutpoint)
  return canonical.some(value => value === undefined) ? undefined : canonical as string[]
}

function carriesR1COutput(method: keyof WalletInterface, args: any): boolean {
  if (method === 'createAction') return !!args?.outputs?.some((output: any) => isR1CLockingScript(output?.lockingScript))
  if (method !== 'internalizeAction') return false
  try {
    const tx = Transaction.fromAtomicBEEF(args?.tx)
    return !!args?.outputs?.some((output: any) => {
      // Match the SDK's numeric coercion. Alternate spellings such as "00"
      // must identify the same output here as they do during internalization.
      const index = Number(output?.outputIndex ?? '')
      return Number.isSafeInteger(index) && index >= 0 && isR1CLockingScript(tx.outputs[index]?.lockingScript?.toHex())
    })
  } catch {
    return false
  }
}

/** Wrap every wallet handed to an external caller. */
export function guardVaultAccess<T extends WalletInterface>(wallet: T, adminOriginator: string): T {
  const targetWallet = underlyingWallet(wallet as object) as T
  let byAuthority = GUARDED_PROXIES.get(targetWallet as object)
  const existing = byAuthority?.get(adminOriginator)
  if (existing) return existing as T

  const runtime = runtimeFor(targetWallet as object)
  const guarded = new Proxy(targetWallet, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (typeof value !== 'function') return value
      const method = prop as keyof WalletInterface
      const bound = (value as (a: any, o?: string) => Promise<any>).bind(target)

      if (method === 'listActions') {
        return async (args: ListActionsArgs, originator?: string) => {
          if (originator === adminOriginator) return await bound(args, originator)
          const externalOriginator = originator ?? ''
          try {
            if (externalOriginator.length > 250) return deny(String(method), originator)
            const requested = validateExternalListActionsArgs(args)
            const key = externalReadKey(requested, externalOriginator)
            const existing = runtime.reads.get(key)
            if (existing) return await existing
            // The deadline starts before queueing. If one permission prompt
            // stalls, later reads expire together instead of each retaining the
            // critical slot for another full timeout.
            const deadline = { expiresAt: Date.now() + EXTERNAL_ACTION_READ_TIMEOUT_MS }
            const pending = withGuardSlot(
              runtime,
              () => listActionsForExternal(bound, requested, externalOriginator, deadline)
            )
            runtime.reads.set(key, pending)
            try {
              return await pending
            } finally {
              if (runtime.reads.get(key) === pending) runtime.reads.delete(key)
            }
          } catch {
            return deny(String(method), originator)
          }
        }
      }

      if (!PRIVILEGED_CAPABLE.has(method) && !OUTPUT_NAMING.has(method)) return value.bind(target)

      return async (args: any, originator?: string) => {
        if (PRIVILEGED_CAPABLE.has(method) && originator !== adminOriginator && requestsVaultProtocol(args)) {
          return deny(String(method), originator)
        }
        if (PRIVILEGED_CAPABLE.has(method) && args?.privileged && originator !== adminOriginator) {
          return deny(String(method), originator)
        }
        // Admin output/action mutations use the same exclusive slot as the
        // external inventory scan + use. This closes the same-count/TOCTOU
        // race without caching an inventory snapshot. The raw underlying
        // wallet remains an internal trust boundary; every externally handed
        // proxy shares this runtime through the WeakMap above.
        if (originator === adminOriginator && OUTPUT_NAMING.has(method)) {
          return await withGuardSlot(runtime, () => bound(args, originator), true)
        }
        if (originator !== adminOriginator && OUTPUT_NAMING.has(method)) {
          if (runtime.queued >= MAX_GUARDED_QUEUE) return deny(String(method), originator)
          return await withGuardSlot(runtime, async () => {
            let inventory: VaultInventory
            try {
              inventory = await loadVaultInventory(
                target.listActions.bind(target) as (a: ListActionsArgs, o?: string) => Promise<ListActionsResult>,
                adminOriginator
              )
            } catch {
              return deny(String(method), originator)
            }
            const outpoints = requestedOutpoints(method, args)
            if (outpoints === undefined || outpoints.some(outpoint => inventory.outpoints.has(outpoint))) {
              return deny(String(method), originator)
            }
            if (
              (method === 'signAction' || method === 'abortAction') &&
              inventory.references.has(String(args?.reference ?? ''))
            ) {
              return deny(String(method), originator)
            }
            const sendWith = requestedSendWithTxids(method, args)
            if (sendWith === undefined || sendWith.some(txid => inventory.txids.has(txid))) {
              return deny(String(method), originator)
            }
            if (carriesR1COutput(method, args)) return deny(String(method), originator)
            return await bound(args, originator)
          })
        }
        return await bound(args, originator)
      }
    }
  })
  if (!byAuthority) {
    byAuthority = new Map()
    GUARDED_PROXIES.set(targetWallet as object, byAuthority)
  }
  byAuthority.set(adminOriginator, guarded as object)
  GUARD_TARGETS.set(guarded as object, targetWallet as object)
  return guarded
}
