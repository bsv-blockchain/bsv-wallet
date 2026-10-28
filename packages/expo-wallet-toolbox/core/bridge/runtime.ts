/**
 * Bridge runtime (spec 6.2, 6.7, 6.9): the process-wide meeting point between transports, the
 * binding registry and the wallet the host built.
 *
 * `BrowserBridgeProvider` publishes the managers, readiness, network and account context here.
 * Transports register once and learn about closes. The runtime owns the wallet revision: a
 * persisted, install-wide counter bumped whenever a built wallet's managers are replaced inside a
 * process (not on the first build after launch). A bump closes every binding with
 * `account-changed`, withdraws the departed wallet's prompts and drops pending site consent. That
 * is what covers a same-wallet rebuild, where the account context stays the same.
 *
 * Module state, like `sessionTeardown`: one wallet session exists per process. Tests reset it with
 * `resetBridgeRuntimeForTests`.
 */
import AsyncStorage from '@react-native-async-storage/async-storage'
import { Hash, Utils, type WalletInterface } from '@bsv/sdk'
import * as SecureStore from 'expo-secure-store'
import { registerSessionTeardown } from '../context/sessionTeardown'
import type { SigningPolicyPermissionsManager } from '../services/signingPermissionPolicy'
import { createBindingRegistry, type Binding, type BindingRegistry, type CloseEvent } from './bindings'
import {
  sweepConsentStorage,
  type ConnectedSite,
  type ConsentStore,
  type HmacCapableWallet,
  type KeyValue
} from './consent'
import { loadStoredPolicy, resolvePermissionPolicy, saveStoredPolicy, type PermissionPolicy } from './permissionPolicy'
import { connectionError } from './protocol/connectionError'
import type { Attestation } from './protocol/origin'
import { getBrowserBridgeConfig } from '../toolboxConfig'
import { setUnattestedTransportPresent } from './runtimeFlags'

export type BridgeReadiness = 'ready' | 'building' | 'blocked' | 'none'

/** What the cross-process mirror (project 2) reads. `schema` changes only incompatibly. */
export interface BridgeSnapshot {
  schema: 1
  baseVersion: string
  network: string
  accountContext: string
  walletRevision: string
  readiness: BridgeReadiness
  closeSeq: number
}

/**
 * The static `getVersion` answer: a BRC-205 base of 7 to 30 bytes (spec 6.6). The host can
 * override it through the provider.
 */
export const DEFAULT_BASE_VERSION = 'bsv-wallet-bridge-1'

/** A published manager: the callable wallet stack and the signing manager under it. */
export interface BridgeManager {
  /** What a request is dispatched against (the guarded, conformance-wrapped manager). */
  wallet: WalletInterface
  /** The manager itself. Its object identity detects a replacement, and it is what gets retired. */
  signing: SigningPolicyPermissionsManager
}

export interface PublishInput {
  attestedManager?: BridgeManager
  unverifiedManager?: BridgeManager
  readiness: BridgeReadiness
  network: string
  accountContext: string
}

export interface TransportRegistration {
  id: string
  attestation: Attestation
  bindingMode: 'implicit' | 'explicit'
  /** Called when a request is parked: waiting for consent, for the wallet, or for a prompt in the background. */
  requestAttention(reason: AttentionReason, binding: Binding): void
  onClosed?(event: CloseEvent): void
  /** Mandatory for `unattested`, absent otherwise: delivers the token the core minted at approval. */
  deliverReconnectToken?(binding: Binding, token: string): void
}

export type AttentionReason = 'consent' | 'wallet-not-ready' | 'prompt'

export interface TransportHandle {
  readonly id: string
  readonly attestation: Attestation
  readonly bindingMode: 'implicit' | 'explicit'
  unregister(): void
}

/** What the provider attaches: the way to withdraw prompts and pending consent for a departed wallet. */
export interface BridgeHostHooks {
  withdrawPrompts(oldManagers: SigningPolicyPermissionsManager[]): void
}

const REVISION_KEY = 'bsv-bridge-wallet-revision'
const SECRET_KEY = 'bsv-bridge-install-secret'
const CONTEXT_DOMAIN = 'bsv-bridge-account-context-v1'
const secureOptions = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY }

/** What the provider registers so the site and policy APIs can reach the store without React. */
export interface ActiveConsent {
  store: Pick<ConsentStore, 'listConnectedSites' | 'revokeSite' | 'dropRequestsFor'>
  /** Admin-scoped, guarded wallet: authenticates the stored policy. */
  adminWallet: Pick<HmacCapableWallet, 'createHmac' | 'verifyHmac'>
  adminOriginator: string
  profileKey: () => string
}

interface RuntimeState {
  storage: KeyValue
  bindings: BindingRegistry
  transports: Map<string, TransportRegistration>
  closeListeners: Set<(e: CloseEvent) => void>
  snapshotListeners: Set<(s: BridgeSnapshot) => void>
  hooks: BridgeHostHooks | undefined
  consentWithdrawals: Set<() => void>
  /** The provider's current consent store and the admin wallet that authenticates it. */
  consent: ActiveConsent | undefined
  snapshot: BridgeSnapshot
  attested: BridgeManager | undefined
  unverified: BridgeManager | undefined
  /** The signing managers of the last build seen in this process; undefined until the first. */
  lastSigning: SigningPolicyPermissionsManager[] | undefined
  loaded: Promise<void> | undefined
  isLoaded: boolean
  secretQueue: Promise<unknown>
}

function freshSnapshot(): BridgeSnapshot {
  return {
    schema: 1,
    baseVersion: DEFAULT_BASE_VERSION,
    network: '',
    accountContext: '',
    walletRevision: '0',
    readiness: 'none',
    closeSeq: 0
  }
}

function createState(storage: KeyValue): RuntimeState {
  const state: RuntimeState = {
    storage,
    transports: new Map(),
    closeListeners: new Set(),
    snapshotListeners: new Set(),
    hooks: undefined,
    consentWithdrawals: new Set(),
    consent: undefined,
    snapshot: freshSnapshot(),
    attested: undefined,
    unverified: undefined,
    lastSigning: undefined,
    loaded: undefined,
    isLoaded: false,
    secretQueue: Promise.resolve(),
    bindings: undefined as unknown as BindingRegistry
  }
  state.bindings = createBindingRegistry({
    tombstoneStorage: storage,
    now: () => Date.now(),
    onClosed: e => fanOutClose(e),
    transportInfo: id => {
      const t = state.transports.get(id)
      return t === undefined ? undefined : { attestation: t.attestation, bindingMode: t.bindingMode }
    },
    allowLocalhostHttp: () =>
      typeof __DEV__ !== 'undefined' && __DEV__ === true && getBrowserBridgeConfig().allowLocalhostHttp === true
  })
  return state
}

let rt = createState(AsyncStorage as unknown as KeyValue)
let unregisterTeardown: (() => void) | undefined

/* --------------------------------- snapshot -------------------------------- */

function setSnapshot(patch: Partial<BridgeSnapshot>): void {
  const next = { ...rt.snapshot, ...patch }
  const changed = (Object.keys(next) as Array<keyof BridgeSnapshot>).some(k => next[k] !== rt.snapshot[k])
  if (!changed) return
  rt.snapshot = next
  for (const fn of [...rt.snapshotListeners]) {
    try {
      fn(next)
    } catch (e) {
      console.warn('[bridge] snapshot listener failed', e)
    }
  }
}

export function getBridgeSnapshot(): BridgeSnapshot {
  return rt.snapshot
}

/** Returns the unsubscribe function. */
export function onSnapshotChange(fn: (s: BridgeSnapshot) => void): () => void {
  rt.snapshotListeners.add(fn)
  return () => {
    rt.snapshotListeners.delete(fn)
  }
}

/* ---------------------------------- closes --------------------------------- */

function fanOutClose(e: CloseEvent): void {
  // Synchronous: a replacement binding is never admitted ahead of this.
  setSnapshot({ closeSeq: Math.max(rt.snapshot.closeSeq, e.closeSeq) })
  try {
    rt.transports.get(e.transportId)?.onClosed?.(e)
  } catch (err) {
    console.warn('[bridge] transport onClosed failed', err)
  }
  for (const fn of [...rt.closeListeners]) {
    try {
      fn(e)
    } catch (err) {
      console.warn('[bridge] close listener failed', err)
    }
  }
}

/** The dispatcher settles in-flight calls from here. Returns the unsubscribe function. */
export function onBindingClosed(fn: (e: CloseEvent) => void): () => void {
  rt.closeListeners.add(fn)
  return () => {
    rt.closeListeners.delete(fn)
  }
}

/* ---------------------------------- loading -------------------------------- */

/**
 * Reads the persisted wallet revision and the tombstone ring. Idempotent; the provider calls it
 * before publishing anything. A storage failure rejects and leaves the runtime unloaded, so it
 * fails closed (requests keep answering `CONFIGURATION_ERROR`).
 */
export function initBridgeRuntime(): Promise<void> {
  const state = rt
  if (!state.loaded) {
    state.loaded = (async () => {
      const raw = await state.storage.getItem(REVISION_KEY)
      const n = raw === null ? 0 : Number(raw)
      await state.bindings.load()
      // The close counter comes back from the persisted ring too, so the mirrored value never
      // goes backwards across a restart.
      setSnapshotOf(state, {
        walletRevision: String(Number.isSafeInteger(n) && n >= 0 ? n : 0),
        closeSeq: state.bindings.closeSeq()
      })
      state.isLoaded = true
    })()
    state.loaded.catch(() => {
      state.loaded = undefined
    })
  }
  return state.loaded
}

function setSnapshotOf(state: RuntimeState, patch: Partial<BridgeSnapshot>) {
  if (state === rt) setSnapshot(patch)
}

/* -------------------------------- transports ------------------------------- */

export function registerTransport(t: TransportRegistration): TransportHandle {
  if (t.attestation === 'unattested' && t.bindingMode === 'implicit') {
    throw connectionError('CONFIGURATION_ERROR', 'An unattested transport must bind explicitly', 'not-sent')
  }
  if (t.attestation === 'unattested' && typeof t.deliverReconnectToken !== 'function') {
    throw connectionError('CONFIGURATION_ERROR', 'An unattested transport must deliver reconnect tokens', 'not-sent')
  }
  if (t.attestation !== 'unattested' && t.deliverReconnectToken !== undefined) {
    throw connectionError('CONFIGURATION_ERROR', 'Only an unattested transport delivers reconnect tokens', 'not-sent')
  }
  if (typeof t.requestAttention !== 'function') {
    throw connectionError('CONFIGURATION_ERROR', 'A transport must provide requestAttention', 'not-sent')
  }
  if (rt.transports.has(t.id)) {
    throw connectionError('CONFIGURATION_ERROR', 'Transport already registered', 'not-sent')
  }
  const state = rt
  const registration = { ...t }
  state.transports.set(t.id, registration)
  refreshUnattestedFlag()
  return {
    id: t.id,
    attestation: t.attestation,
    bindingMode: t.bindingMode,
    unregister() {
      if (state.transports.get(t.id) !== registration) return
      state.transports.delete(t.id)
      if (state === rt) refreshUnattestedFlag()
    }
  }
}

function refreshUnattestedFlag(): void {
  let any = false
  for (const t of rt.transports.values()) if (t.attestation === 'unattested') any = true
  setUnattestedTransportPresent(any)
}

export function getTransport(id: string): TransportRegistration | undefined {
  return rt.transports.get(id)
}

/* ----------------------------- host (provider) side ------------------------ */

/**
 * Called by the provider when it mounts. Registers the session teardown that closes every binding
 * when the wallet session ends. Returns the detach function (provider unmount).
 */
export function attachBridgeHost(hooks: BridgeHostHooks): () => void {
  rt.hooks = hooks
  unregisterTeardown?.()
  const state = rt
  unregisterTeardown = registerSessionTeardown(['logout', 'profile', 'network', 'rebuild'], reason => {
    // Pending consent and bindings belong to the departing wallet. The prompts themselves are
    // withdrawn by WalletContext at the same sites, and again at the next rising edge.
    if (rt.isLoaded) rt.bindings.closeAll('account-changed')
    withdrawConsent()
    // The managers are being retired and the wallet torn down behind an await. Drop them from the
    // published set now, so nothing dispatches to a retired manager over a wallet that is being
    // destroyed, and park (or fail) new requests until the provider publishes the next build.
    rt.attested = undefined
    rt.unverified = undefined
    setSnapshot({ readiness: reason === 'logout' ? 'none' : 'building' })
    if (reason === 'logout') {
      void deleteInstallSecret()
      // Logout and Delete Wallet end the session: remembered sites go with it, every profile's
      // key, so restoring the same seed does not reconnect a site silently (spec 6.4).
      sweepConsentStorage(state.storage).catch(e => console.warn('[bridge] could not clear connected sites', e))
    }
  })
  return () => {
    if (state !== rt || rt.hooks !== hooks) return
    unregisterTeardown?.()
    unregisterTeardown = undefined
    rt.hooks = undefined
    rt.attested = undefined
    rt.unverified = undefined
    if (rt.isLoaded) rt.bindings.closeAll('lost')
    setSnapshot({ readiness: 'none' })
  }
}

export function isBridgeHostAttached(): boolean {
  return rt.hooks !== undefined && rt.isLoaded
}

/** Sets the static `getVersion` string (the host's choice; 7-30 bytes per BRC-205). */
export function setBridgeBaseVersion(v: string): void {
  setSnapshot({ baseVersion: v })
}

/**
 * Registers what drops pending `connection` requests (`ConsentStore.withdrawAll`), run on every
 * wallet replacement and session teardown. Returns the unregister function.
 */
export function registerConsentWithdrawal(fn: () => void): () => void {
  rt.consentWithdrawals.add(fn)
  return () => {
    rt.consentWithdrawals.delete(fn)
  }
}

/** Registers the live consent store for the site and policy APIs. Returns the unregister function. */
export function setActiveConsent(c: ActiveConsent | undefined): () => void {
  const state = rt
  state.consent = c
  return () => {
    if (state.consent === c) state.consent = undefined
  }
}

/** The sites the user has connected on this profile (spec 6.4). Empty when no wallet is mounted. */
export async function listConnectedSites(): Promise<ConnectedSite[]> {
  return (await rt.consent?.store.listConnectedSites()) ?? []
}

/**
 * Forgets a connected site and closes its live bindings of that attestation with `revoked`
 * (spec 6.4). Bindings of the same origin under the other attestation are untouched. The record is
 * deleted first, so a binding that reconnects in between is asked again.
 */
export async function revokeSite(origin: string, attestation: Attestation): Promise<void> {
  const state = rt
  if (state.consent === undefined) {
    throw connectionError('CONFIGURATION_ERROR', 'The wallet bridge is not available', 'not-sent')
  }
  await state.consent.store.revokeSite(origin, attestation)
  if (state !== rt || !state.isLoaded) return
  for (const b of state.bindings.live()) {
    if (b.applicationOrigin !== origin || b.attestation !== attestation) continue
    state.consent.store.dropRequestsFor(b.epoch)
    state.bindings.close(b.epoch, 'revoked')
  }
}

/** The effective permission policy: defaults, the host's statement, then the user's stored policy. */
export async function getPermissionPolicy(): Promise<PermissionPolicy> {
  const c = rt.consent
  if (c === undefined) return resolvePermissionPolicy()
  return resolvePermissionPolicy(await loadStoredPolicy(c.profileKey(), c.adminWallet, c.adminOriginator))
}

/** Stores the user's policy for this profile. It applies from the next wallet build (spec 6.5). */
export async function setPermissionPolicy(policy: PermissionPolicy): Promise<void> {
  const c = rt.consent
  if (c === undefined) {
    throw connectionError('CONFIGURATION_ERROR', 'The wallet bridge is not available', 'not-sent')
  }
  await saveStoredPolicy(c.profileKey(), policy, c.adminWallet, c.adminOriginator)
}

function withdrawConsent(): void {
  for (const fn of [...rt.consentWithdrawals]) {
    try {
      fn()
    } catch (e) {
      console.warn('[bridge] consent withdrawal failed', e)
    }
  }
}

function sameSet<T>(a: T[], b: T[]): boolean {
  return a.length === b.length && a.every(x => b.includes(x))
}

/**
 * The provider's report of the wallet it currently has. A manager identity that differs from the
 * previous build's (after the first build in this process) is a wallet replacement: bump the
 * revision, close the bindings, withdraw the old prompts. Detected here rather than from
 * teardown hooks because `rebuildWallet` and the mid-build rebuild have none.
 */
export function publish(input: PublishInput): void {
  if (!rt.isLoaded) throw new Error('Bridge runtime published to before initBridgeRuntime() resolved')
  const signing: SigningPolicyPermissionsManager[] = []
  if (input.attestedManager) signing.push(input.attestedManager.signing)
  if (input.unverifiedManager) signing.push(input.unverifiedManager.signing)

  if (signing.length > 0) {
    const previous = rt.lastSigning
    if (previous !== undefined && !sameSet(previous, signing)) {
      const old = previous.filter(m => !signing.includes(m))
      replaceWallet(old)
    }
    rt.lastSigning = signing
  }
  rt.attested = input.attestedManager
  rt.unverified = input.unverifiedManager
  // The revision bump, if any, is already in the snapshot; this carries the rest of the report.
  setSnapshot({
    network: input.network,
    accountContext: input.accountContext,
    readiness: input.readiness
  })
}

function replaceWallet(oldManagers: SigningPolicyPermissionsManager[]): void {
  const next = String(Number(rt.snapshot.walletRevision) + 1)
  // Close first and synchronously, so nothing is admitted on the old wallet's bindings.
  rt.bindings.closeAll('account-changed')
  try {
    rt.hooks?.withdrawPrompts(oldManagers)
  } catch (e) {
    console.warn('[bridge] withdrawPrompts failed', e)
  }
  withdrawConsent()
  setSnapshot({ walletRevision: next })
  const state = rt
  // A failed write leaves the in-memory revision ahead; the next launch starts from the old one,
  // but its bindings are in memory only and its tombstones persist, so nothing revives.
  state.storage.setItem(REVISION_KEY, next).catch(e => console.warn('[bridge] could not persist wallet revision', e))
}

/* ------------------------------ internals for dispatch --------------------- */

export function getBindingRegistry(): BindingRegistry {
  return rt.bindings
}

export function getPublishedManagers(): { attested?: BridgeManager; unverified?: BridgeManager } {
  return { attested: rt.attested, unverified: rt.unverified }
}

/**
 * A request with no provider mounted, or before the runtime finished loading, cannot be served.
 * Throws the `CONFIGURATION_ERROR` the dispatcher returns.
 */
export function assertBridgeHost(): void {
  if (!isBridgeHostAttached()) {
    throw connectionError('CONFIGURATION_ERROR', 'The wallet bridge is not available', 'not-sent')
  }
}

/* ------------------------------ account context ---------------------------- */

function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = rt.secretQueue.then(fn, fn)
  rt.secretQueue = run.catch(() => undefined)
  return run
}

function randomHex32(): string {
  const bytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(bytes)
  return Utils.toHex(Array.from(bytes))
}

function getInstallSecret(): Promise<string> {
  return serialized(async () => {
    const existing = await SecureStore.getItemAsync(SECRET_KEY, secureOptions)
    if (existing && /^[0-9a-f]{64}$/.test(existing)) return existing
    const fresh = randomHex32()
    await SecureStore.setItemAsync(SECRET_KEY, fresh, secureOptions)
    return fresh
  })
}

/** Rotates the account context: run at logout and Delete Wallet. */
export function deleteInstallSecret(): Promise<void> {
  return serialized(() => SecureStore.deleteItemAsync(SECRET_KEY, secureOptions)).catch(e => {
    console.warn('[bridge] could not delete the install secret', e)
  })
}

/**
 * `HMAC-SHA256(installSecret, "bsv-bridge-account-context-v1" || identityKeyHex || network)`,
 * hex. Opaque and local to the app process (6.7).
 */
export async function computeAccountContext(identityKeyHex: string, network: string): Promise<string> {
  const secret = await getInstallSecret()
  const message = Utils.toArray(CONTEXT_DOMAIN + identityKeyHex + network, 'utf8')
  return Utils.toHex(Hash.sha256hmac(Utils.toArray(secret, 'hex'), message))
}

/* ----------------------------------- tests --------------------------------- */

/** Drops all runtime state and the registered teardown; optionally swaps the storage. Tests only. */
export function resetBridgeRuntimeForTests(storage?: KeyValue): void {
  unregisterTeardown?.()
  unregisterTeardown = undefined
  setUnattestedTransportPresent(false)
  rt = createState(storage ?? (AsyncStorage as unknown as KeyValue))
}
