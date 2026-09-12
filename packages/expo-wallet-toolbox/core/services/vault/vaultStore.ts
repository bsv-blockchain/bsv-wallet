/**
 * Vault enrollment metadata.
 *
 * The SecureStore record is a this-device-only local authority, namespaced by
 * wallet identity and chain. Untrusted AsyncStorage data can therefore never
 * redirect a deposit. The durable recovery copy is carried by every future
 * R1C output's customInstructions and restored only after that metadata has
 * been checked against the output's real lock.
 */
import * as SecureStore from 'expo-secure-store'
import { p256 } from '@noble/curves/nist.js'
import { VaultError } from './types'

const META_KEY_PREFIX = 'vault_meta_v6'
const ENROLLMENT_DRAFT_KEY_PREFIX = 'vault_enrollment_draft_v1'
const SECURE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY
}
const MIN_KEYS = 2
const MAX_KEYS = 5
const VAULT_SLOT = 0x82

export type VaultScopeChain = 'main' | 'test' | 'teratest'

export interface VaultStoreScope {
  /** Compressed secp256k1 wallet identity key, lowercase hex. */
  identityKey: string
  chain: VaultScopeChain
}

/** Opaque capability binding an async operation to one configured scope. */
export interface VaultScopeToken {
  readonly generation: number
  readonly storageKey: string
  readonly chain: VaultScopeChain
}

export interface VaultKeyRecord {
  serial: string
  slot: number
  /** 33-byte compressed P-256 public key, lowercase hex. */
  pubkey: string
  nickname: string
  enrolledAt: number
}

export interface VaultMetaV6 {
  v: 6
  /** Random identifier for this enrollment, distinct after disable/re-enroll. */
  vaultId: string
  /** Monotonic recovery-record version. Key and nickname changes increment it. */
  revision: number
  createdAt: number
  lastUsedAt?: number
  lastUsedSerial?: string
  /** Durable two-phase revocation state. The key is no longer active for new
   * outputs, but remains recoverable until its relock transaction is proven. */
  pendingRemoval?: VaultPendingRemoval
  /** Fresh-device recovery remains locked until a restored key proves
   * possession with a live random-signature challenge. */
  recovery?: VaultRecoveryState
  keys: VaultKeyRecord[]
}

export interface VaultRecoveryState {
  required: true
  adoptedSerials: string[]
}

export interface VaultPendingRemoval {
  key: VaultKeyRecord
  keyIndex: number
  startedAt: number
  /** The active key-set revision baked into the replacement output. */
  revision: number
  /** `broadcast` means authenticated wallet history has shown at least one
   * matching relock transaction. Transaction history itself stays in the
   * wallet; this security tombstone therefore has constant size. */
  state: 'prepared' | 'broadcast'
}

/** A public-key recovery handle for a token personalized before the wizard
 * atomically commits a VaultMeta. Drafts are stored under a separate scoped
 * SecureStore key and are never consulted by deposit/withdrawal authority. */
export type VaultEnrollmentDraftAssurance = 'management-uncertain' | 'challenge-required' | 'ready'

export interface VaultEnrollmentDraftEntry {
  record: VaultKeyRecord
  assurance: VaultEnrollmentDraftAssurance
}

export type VaultEnrollmentQuarantineStage =
  | 'pin-change-uncertain'
  | 'pin-changed'
  | 'puk-change-uncertain'
  | 'puk-changed'
  | 'generation-uncertain'

/** An irreversible/ambiguous global PIV credential change occurred before a
 * public slot key existed. No credential is stored. Generic enrollment must
 * not retry this serial until the user has administratively reset/recovered
 * its dedicated PIV application. */
export interface VaultEnrollmentQuarantine {
  serial: string
  stage: VaultEnrollmentQuarantineStage
  recordedAt: number
}

interface VaultEnrollmentDraftV1 {
  v: 1
  updatedAt: number
  entries: VaultEnrollmentDraftEntry[]
  quarantines: VaultEnrollmentQuarantine[]
}

export type VaultMeta = VaultMetaV6

let activeScope: VaultStoreScope | null = null
let scopeGeneration = 0
let mutationTail: Promise<void> = Promise.resolve()

/** Serialize every scoped write so two callers cannot both read revision N and
 * then last-write competing N+1 states. A rejected mutation never poisons the
 * queue. Each operation captures its scope before joining and rechecks it when
 * it runs. */
function enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutationTail.then(operation, operation)
  mutationTail = result.then(
    () => undefined,
    () => undefined
  )
  return result
}

function validIdentityKey(identityKey: unknown): identityKey is string {
  return typeof identityKey === 'string' && /^0[23][0-9a-f]{64}$/.test(identityKey)
}

function normalizeScope(scope: VaultStoreScope): VaultStoreScope {
  if (!validIdentityKey(scope.identityKey)) {
    throw new VaultError('template-invalid', 'Vault scope requires a canonical wallet identity key')
  }
  if (scope.chain !== 'main' && scope.chain !== 'test' && scope.chain !== 'teratest') {
    throw new VaultError('template-invalid', 'Vault scope requires a supported chain')
  }
  return { identityKey: scope.identityKey, chain: scope.chain }
}

function scopedKey(scope = activeScope): string | null {
  // SecureStore keys accept alphanumerics plus '.', '-' and '_'.
  return scope ? `${META_KEY_PREFIX}_${scope.chain}_${scope.identityKey}` : null
}

function enrollmentDraftKey(token: VaultScopeToken): string {
  const match = /^vault_meta_v6_(main|test|teratest)_(0[23][0-9a-f]{64})$/.exec(token.storageKey)
  if (!match) throw new VaultError('template-invalid', 'Invalid captured vault scope')
  return `${ENROLLMENT_DRAFT_KEY_PREFIX}_${match[1]}_${match[2]}`
}

function captureScope(required: true): VaultScopeToken
function captureScope(required: false): VaultScopeToken | null
function captureScope(required: boolean): VaultScopeToken | null {
  const storageKey = scopedKey()
  if (!storageKey) {
    if (required) throw new VaultError('not-enrolled', 'Wallet vault scope is not configured')
    return null
  }
  return { generation: scopeGeneration, storageKey, chain: activeScope!.chain }
}

function assertScope(token: VaultScopeToken): void {
  if (
    token.generation !== scopeGeneration ||
    token.storageKey !== scopedKey() ||
    token.chain !== activeScope?.chain
  ) {
    throw new VaultError('scope-changed', 'Wallet or network changed during the vault operation')
  }
}

function isSafeTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isCanonicalP256(pubkey: unknown): pubkey is string {
  if (typeof pubkey !== 'string' || !/^0[23][0-9a-f]{64}$/.test(pubkey)) return false
  try {
    const point = p256.Point.fromHex(pubkey)
    point.assertValidity()
    return point.toHex(true) === pubkey
  } catch {
    return false
  }
}

function isEnrollmentDraft(value: unknown): value is VaultEnrollmentDraftV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const draft = value as Record<string, unknown>
  if (Object.keys(draft).some(name => !['v', 'updatedAt', 'entries', 'quarantines'].includes(name))) return false
  if (
    draft.v !== 1 ||
    !isSafeTime(draft.updatedAt) ||
    !Array.isArray(draft.entries) ||
    !Array.isArray(draft.quarantines)
  ) {
    return false
  }
  if (draft.entries.length > MAX_KEYS || draft.quarantines.length > MAX_KEYS) return false
  if (draft.entries.length + draft.quarantines.length < 1) return false
  const entries = draft.entries as unknown[]
  if (
    !entries.every(value => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
      const entry = value as Record<string, unknown>
      return (
        !Object.keys(entry).some(name => !['record', 'assurance'].includes(name)) &&
        isVaultKeyRecord(entry.record) &&
        (entry.assurance === 'management-uncertain' ||
          entry.assurance === 'challenge-required' ||
          entry.assurance === 'ready')
      )
    })
  ) {
    return false
  }
  const records = (entries as VaultEnrollmentDraftEntry[]).map(entry => entry.record)
  if (new Set(records.map(record => record.serial)).size !== records.length) return false
  if (new Set(records.map(record => record.pubkey)).size !== records.length) return false
  const quarantines = draft.quarantines as unknown[]
  if (
    !quarantines.every(value => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
      const quarantine = value as Record<string, unknown>
      return (
        !Object.keys(quarantine).some(name => !['serial', 'stage', 'recordedAt'].includes(name)) &&
        isVaultSerial(quarantine.serial) &&
        (quarantine.stage === 'pin-change-uncertain' ||
          quarantine.stage === 'pin-changed' ||
          quarantine.stage === 'puk-change-uncertain' ||
          quarantine.stage === 'puk-changed' ||
          quarantine.stage === 'generation-uncertain') &&
        isSafeTime(quarantine.recordedAt)
      )
    })
  ) {
    return false
  }
  const quarantineSerials = (quarantines as VaultEnrollmentQuarantine[]).map(item => item.serial)
  if (new Set(quarantineSerials).size !== quarantineSerials.length) return false
  if (quarantineSerials.some(serial => records.some(record => record.serial === serial))) return false
  return true
}

export function isVaultSerial(serial: unknown): serial is string {
  return typeof serial === 'string' && /^[A-Za-z0-9._:-]{1,64}$/.test(serial)
}

export function isVaultKeyRecord(value: unknown): value is VaultKeyRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const k = value as Record<string, unknown>
  if (Object.keys(k).some(name => !['serial', 'slot', 'pubkey', 'nickname', 'enrolledAt'].includes(name))) return false
  return (
    isVaultSerial(k.serial) &&
    k.slot === VAULT_SLOT &&
    isCanonicalP256(k.pubkey) &&
    typeof k.nickname === 'string' &&
    k.nickname.length >= 1 &&
    k.nickname.length <= 64 &&
    k.nickname.trim() === k.nickname &&
    !/[\u0000-\u001f\u007f]/.test(k.nickname) &&
    isSafeTime(k.enrolledAt)
  )
}

/** Strict runtime validation. Invalid/corrupt records never become authority. */
export function isVaultMeta(value: unknown): value is VaultMeta {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const m = value as Record<string, unknown>
  const allowed = [
    'v',
    'vaultId',
    'revision',
    'createdAt',
    'lastUsedAt',
    'lastUsedSerial',
    'pendingRemoval',
    'recovery',
    'keys'
  ]
  if (Object.keys(m).some(name => !allowed.includes(name))) return false
  if (m.v !== 6 || typeof m.vaultId !== 'string' || !/^[0-9a-f]{64}$/.test(m.vaultId)) return false
  if (typeof m.revision !== 'number' || !Number.isSafeInteger(m.revision) || m.revision < 1) return false
  if (!isSafeTime(m.createdAt)) return false
  if (!Array.isArray(m.keys) || m.keys.length < MIN_KEYS || m.keys.length > MAX_KEYS) return false
  if (!m.keys.every(isVaultKeyRecord)) return false
  const keys = m.keys as VaultKeyRecord[]
  if (new Set(keys.map(k => k.serial)).size !== keys.length) return false
  if (new Set(keys.map(k => k.pubkey)).size !== keys.length) return false
  if (m.lastUsedAt !== undefined && !isSafeTime(m.lastUsedAt)) return false
  if (m.lastUsedSerial !== undefined) {
    if (typeof m.lastUsedSerial !== 'string' || !keys.some(k => k.serial === m.lastUsedSerial)) return false
    if (m.lastUsedAt === undefined) return false
  }
  if (m.pendingRemoval !== undefined) {
    const p = m.pendingRemoval
    if (p === null || typeof p !== 'object' || Array.isArray(p)) return false
    const pending = p as Record<string, unknown>
    if (Object.keys(pending).some(name => !['key', 'keyIndex', 'startedAt', 'revision', 'state'].includes(name))) {
      return false
    }
    if (!isVaultKeyRecord(pending.key)) return false
    const removed = pending.key as VaultKeyRecord
    if (keys.some(k => k.serial === removed.serial || k.pubkey === removed.pubkey)) return false
    if (typeof pending.keyIndex !== 'number' || !Number.isSafeInteger(pending.keyIndex)) return false
    if (pending.keyIndex < 0 || pending.keyIndex > keys.length) return false
    if (!isSafeTime(pending.startedAt) || pending.revision !== m.revision) return false
    if (pending.state !== 'prepared' && pending.state !== 'broadcast') return false
  }
  if (m.recovery !== undefined) {
    const r = m.recovery
    if (r === null || typeof r !== 'object' || Array.isArray(r)) return false
    const recovery = r as Record<string, unknown>
    if (Object.keys(recovery).some(name => !['required', 'adoptedSerials'].includes(name))) return false
    if (recovery.required !== true || !Array.isArray(recovery.adoptedSerials)) return false
    if (!recovery.adoptedSerials.every(isVaultSerial)) return false
    if (new Set(recovery.adoptedSerials as string[]).size !== recovery.adoptedSerials.length) return false
    const known = new Set(keys.map(k => k.serial))
    if (m.pendingRemoval) known.add((m.pendingRemoval as VaultPendingRemoval).key.serial)
    if (!(recovery.adoptedSerials as string[]).every(serial => known.has(serial))) return false
  }
  return true
}

async function readMeta(token: VaultScopeToken): Promise<VaultMeta | null> {
  assertScope(token)
  const raw = await SecureStore.getItemAsync(token.storageKey, SECURE_OPTIONS)
  assertScope(token)
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new VaultError('template-invalid', 'Stored vault enrollment metadata is corrupt')
  }
  if (!isVaultMeta(parsed)) throw new VaultError('template-invalid', 'Stored vault enrollment metadata is corrupt')
  return parsed
}

async function writeMeta(token: VaultScopeToken, meta: unknown): Promise<void> {
  const checked = checkedMeta(meta)
  assertScope(token)
  await SecureStore.setItemAsync(token.storageKey, JSON.stringify(checked), SECURE_OPTIONS)
  // The write still targeted the captured namespace if the scope changed while
  // storage was pending, but its caller must not continue as though it updated
  // the newly active wallet.
  assertScope(token)
}

async function readEnrollmentDraft(
  token: VaultScopeToken,
  requireActiveScope: boolean
): Promise<VaultEnrollmentDraftV1 | null> {
  if (requireActiveScope) assertScope(token)
  const raw = await SecureStore.getItemAsync(enrollmentDraftKey(token), SECURE_OPTIONS)
  if (requireActiveScope) assertScope(token)
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new VaultError('template-invalid', 'Stored vault enrollment draft is corrupt')
  }
  if (!isEnrollmentDraft(parsed)) throw new VaultError('template-invalid', 'Stored vault enrollment draft is corrupt')
  return parsed
}

/** Write only the non-authoritative enrollment-draft namespace captured at
 * ceremony start. This deliberately remains possible after a scope switch so
 * an already-generated A key gets a durable A recovery handle; the derived key
 * can never target active wallet B's metadata. */
async function writeCapturedEnrollmentDraft(
  token: VaultScopeToken,
  draft: VaultEnrollmentDraftV1 | null
): Promise<void> {
  const key = enrollmentDraftKey(token)
  if (draft !== null && !isEnrollmentDraft(draft)) {
    throw new VaultError('template-invalid', 'Invalid vault enrollment draft')
  }
  if (draft) await SecureStore.setItemAsync(key, JSON.stringify(draft), SECURE_OPTIONS)
  else await SecureStore.deleteItemAsync(key, SECURE_OPTIONS)
}

function draftAssuranceRank(assurance: VaultEnrollmentDraftAssurance): number {
  if (assurance === 'management-uncertain') return 0
  if (assurance === 'challenge-required') return 1
  return 2
}

function isQuarantineStage(value: unknown): value is VaultEnrollmentQuarantineStage {
  return (
    value === 'pin-change-uncertain' ||
    value === 'pin-changed' ||
    value === 'puk-change-uncertain' ||
    value === 'puk-changed' ||
    value === 'generation-uncertain'
  )
}

async function requireMeta(token: VaultScopeToken): Promise<VaultMeta> {
  const meta = await readMeta(token)
  if (!meta) throw new VaultError('not-enrolled', 'Vault is not set up')
  return meta
}

function checkedMeta(meta: unknown): VaultMeta {
  if (!isVaultMeta(meta)) throw new VaultError('template-invalid', 'Invalid vault enrollment metadata')
  return meta
}

function sameRemovalKey(a: VaultPendingRemoval, b: VaultPendingRemoval): boolean {
  return a.revision === b.revision && a.keyIndex === b.keyIndex && JSON.stringify(a.key) === JSON.stringify(b.key)
}

/** Merge two observations of one in-flight removal. Authenticated outputs can
 * prove that a relock was broadcast after a crash left the local state at
 * `prepared`; once observed, `broadcast` never rolls back. Different removed
 * keys at one revision are an irreconcilable authority conflict. */
function mergePendingRemoval(
  local: VaultPendingRemoval | undefined,
  recovered: VaultPendingRemoval | undefined
): VaultPendingRemoval | undefined {
  if (!local) return recovered ? { ...recovered, key: { ...recovered.key } } : undefined
  if (!recovered) return { ...local, key: { ...local.key } }
  if (!sameRemovalKey(local, recovered)) {
    throw new VaultError('template-invalid', 'Conflicting key removals share the same vault revision')
  }
  return {
    ...local,
    startedAt: Math.min(local.startedAt, recovered.startedAt),
    state: local.state === 'broadcast' || recovered.state === 'broadcast' ? 'broadcast' : 'prepared'
  }
}

export const vaultStore = {
  /** Select the only wallet+chain namespace subsequent calls may access. */
  configureScope(scope: VaultStoreScope): void {
    activeScope = normalizeScope(scope)
    scopeGeneration++
  },

  /** Drop the in-memory authority during logout, wallet rebuild or teardown. */
  clearScope(): void {
    activeScope = null
    scopeGeneration++
  },

  getScope(): VaultStoreScope | null {
    return activeScope ? { ...activeScope } : null
  },

  /** Capture the current wallet+chain epoch before starting async work. */
  captureScopeToken(): VaultScopeToken {
    return captureScope(true)
  },

  /** Fail if a captured operation outlived its wallet or chain. */
  assertScopeToken(token: VaultScopeToken): void {
    assertScope(token)
  },

  /** Public recovery handles awaiting an atomic enrollment commit. These are
   * never read by getMeta or any transfer path. */
  async getEnrollmentDrafts(scopeToken?: VaultScopeToken): Promise<VaultEnrollmentDraftEntry[]> {
    const token = scopeToken ?? captureScope(true)
    const draft = await readEnrollmentDraft(token, true)
    return draft?.entries.map(entry => ({ ...entry, record: { ...entry.record } })) ?? []
  },

  async getEnrollmentQuarantines(scopeToken?: VaultScopeToken): Promise<VaultEnrollmentQuarantine[]> {
    const token = scopeToken ?? captureScope(true)
    const draft = await readEnrollmentDraft(token, true)
    return draft?.quarantines.map(item => ({ ...item })) ?? []
  },

  /** Preserve a generated key under the wallet+chain captured before token
   * contact. Unlike authority writes, this may finish after the active scope
   * changes: it can write only the separate draft key encoded in `scopeToken`.
   * Assurance is monotonic and same-serial/pubkey conflicts fail closed. */
  async preserveEnrollmentDraft(
    entry: VaultEnrollmentDraftEntry,
    scopeToken: VaultScopeToken
  ): Promise<VaultEnrollmentDraftEntry> {
    if (
      !isVaultKeyRecord(entry.record) ||
      (entry.assurance !== 'management-uncertain' &&
        entry.assurance !== 'challenge-required' &&
        entry.assurance !== 'ready')
    ) {
      throw new VaultError('template-invalid', 'Invalid vault enrollment recovery handle')
    }
    // Validate the captured namespace before entering the shared mutation
    // queue. No active-scope assertion belongs here; see the method contract.
    enrollmentDraftKey(scopeToken)
    return enqueueMutation(async () => {
      const current = await readEnrollmentDraft(scopeToken, false)
      const entries = current?.entries.map(item => ({ ...item, record: { ...item.record } })) ?? []
      const quarantines = current?.quarantines.map(item => ({ ...item })) ?? []
      const serialMatch = entries.find(item => item.record.serial === entry.record.serial)
      const pubkeyMatch = entries.find(item => item.record.pubkey === entry.record.pubkey)
      if (
        (serialMatch && serialMatch.record.pubkey !== entry.record.pubkey) ||
        (pubkeyMatch && pubkeyMatch.record.serial !== entry.record.serial)
      ) {
        throw new VaultError('template-invalid', 'Conflicting generated keys share an enrollment draft')
      }
      const existingIndex = entries.findIndex(
        item => item.record.serial === entry.record.serial && item.record.pubkey === entry.record.pubkey
      )
      const saved: VaultEnrollmentDraftEntry = existingIndex < 0
        ? { assurance: entry.assurance, record: { ...entry.record } }
        : draftAssuranceRank(entries[existingIndex].assurance) >= draftAssuranceRank(entry.assurance)
          ? entries[existingIndex]
          : { assurance: entry.assurance, record: { ...entry.record } }
      if (existingIndex < 0) entries.push(saved)
      else entries[existingIndex] = saved
      const retainedQuarantines = quarantines.filter(item => item.serial !== entry.record.serial)
      const updatedAt = Date.now()
      if (!isSafeTime(updatedAt)) throw new VaultError('template-invalid', 'Invalid enrollment draft time')
      await writeCapturedEnrollmentDraft(scopeToken, {
        v: 1,
        updatedAt,
        entries,
        quarantines: retainedQuarantines
      })
      return { ...saved, record: { ...saved.record } }
    })
  },

  /** Persist the no-secret intent marker BEFORE the first irreversible PIV
   * command for this serial. A process death while the APDU is in flight then
   * leaves a durable quarantine instead of making the next launch retry it as
   * a fresh token. Later state changes use transitionEnrollmentQuarantine's
   * compare-and-swap contract. */
  async preserveEnrollmentQuarantine(
    serial: string,
    stage: VaultEnrollmentQuarantineStage,
    scopeToken: VaultScopeToken
  ): Promise<VaultEnrollmentQuarantine> {
    if (!isVaultSerial(serial) || !isQuarantineStage(stage)) {
      throw new VaultError('template-invalid', 'Invalid enrollment quarantine marker')
    }
    enrollmentDraftKey(scopeToken)
    return enqueueMutation(async () => {
      const current = await readEnrollmentDraft(scopeToken, false)
      const entries = current?.entries.map(item => ({ ...item, record: { ...item.record } })) ?? []
      if (entries.some(entry => entry.record.serial === serial)) {
        throw new VaultError('template-invalid', 'A generated-key draft cannot be replaced by a credential marker')
      }
      const quarantines = current?.quarantines.map(item => ({ ...item })) ?? []
      const index = quarantines.findIndex(item => item.serial === serial)
      const recordedAt = Date.now()
      if (!isSafeTime(recordedAt)) throw new VaultError('template-invalid', 'Invalid enrollment quarantine time')
      const candidate: VaultEnrollmentQuarantine = { serial, stage, recordedAt }
      let saved = candidate
      if (index < 0) quarantines.push(candidate)
      else if (quarantines[index].stage === stage) saved = quarantines[index]
      else throw new VaultError('template-invalid', 'PIV enrollment mutation state changed unexpectedly')
      await writeCapturedEnrollmentDraft(scopeToken, { v: 1, updatedAt: recordedAt, entries, quarantines })
      return { ...saved }
    })
  },

  /** Advance or resolve one in-memory enrollment attempt only if durable state
   * still matches the stage written before its APDU. The narrow transition set
   * prevents an old callback from clearing or advancing a newer quarantine. */
  async transitionEnrollmentQuarantine(
    serial: string,
    from: VaultEnrollmentQuarantineStage,
    to: VaultEnrollmentQuarantineStage | null,
    scopeToken: VaultScopeToken
  ): Promise<void> {
    if (!isVaultSerial(serial) || !isQuarantineStage(from) || (to !== null && !isQuarantineStage(to))) {
      throw new VaultError('template-invalid', 'Invalid enrollment quarantine transition')
    }
    const allowed =
      (from === 'pin-change-uncertain' && (to === 'pin-changed' || to === null)) ||
      (from === 'pin-changed' && to === 'puk-change-uncertain') ||
      (from === 'puk-change-uncertain' && (to === 'pin-changed' || to === 'puk-changed' || to === null)) ||
      (from === 'puk-changed' && to === 'generation-uncertain')
    if (!allowed) throw new VaultError('template-invalid', 'Disallowed enrollment quarantine transition')
    enrollmentDraftKey(scopeToken)
    return enqueueMutation(async () => {
      const current = await readEnrollmentDraft(scopeToken, false)
      if (!current) throw new VaultError('template-invalid', 'Enrollment quarantine is missing')
      const entries = current.entries.map(item => ({ ...item, record: { ...item.record } }))
      const quarantines = current.quarantines.map(item => ({ ...item }))
      const index = quarantines.findIndex(item => item.serial === serial)
      if (index < 0 || quarantines[index].stage !== from) {
        throw new VaultError('template-invalid', 'Enrollment quarantine no longer matches this operation')
      }
      const updatedAt = Date.now()
      if (!isSafeTime(updatedAt)) throw new VaultError('template-invalid', 'Invalid enrollment quarantine time')
      if (to === null) quarantines.splice(index, 1)
      else quarantines[index] = { serial, stage: to, recordedAt: updatedAt }
      if (entries.length === 0 && quarantines.length === 0) await writeCapturedEnrollmentDraft(scopeToken, null)
      else await writeCapturedEnrollmentDraft(scopeToken, { v: 1, updatedAt, entries, quarantines })
    })
  },

  /** Remove records only after their authoritative meta write succeeds. */
  async consumeEnrollmentDrafts(serials: readonly string[], scopeToken?: VaultScopeToken): Promise<void> {
    const token = scopeToken ?? captureScope(true)
    if (!serials.every(isVaultSerial)) throw new VaultError('template-invalid', 'Invalid enrollment draft serial')
    const consumed = new Set(serials)
    return enqueueMutation(async () => {
      const current = await readEnrollmentDraft(token, true)
      if (!current) return
      const entries = current.entries.filter(entry => !consumed.has(entry.record.serial))
      assertScope(token)
      if (entries.length === 0 && current.quarantines.length === 0) await writeCapturedEnrollmentDraft(token, null)
      else {
        const updatedAt = Date.now()
        if (!isSafeTime(updatedAt)) throw new VaultError('template-invalid', 'Invalid enrollment draft time')
        await writeCapturedEnrollmentDraft(token, {
          v: 1,
          updatedAt,
          entries,
          quarantines: current.quarantines
        })
      }
      assertScope(token)
    })
  },

  /** Explicitly abandon a non-authoritative handle after the user decides to
   * reset that token or use another one. */
  async discardEnrollmentDraft(serial: string, scopeToken?: VaultScopeToken): Promise<void> {
    return vaultStore.consumeEnrollmentDrafts([serial], scopeToken)
  },

  /** Call only after the user has reset/recovered the token's whole PIV
   * application; removing the marker does not itself make any card change. */
  async discardEnrollmentQuarantine(serial: string, scopeToken?: VaultScopeToken): Promise<void> {
    const token = scopeToken ?? captureScope(true)
    if (!isVaultSerial(serial)) throw new VaultError('template-invalid', 'Invalid enrollment quarantine serial')
    return enqueueMutation(async () => {
      const current = await readEnrollmentDraft(token, true)
      if (!current) return
      const quarantines = current.quarantines.filter(item => item.serial !== serial)
      assertScope(token)
      if (current.entries.length === 0 && quarantines.length === 0) await writeCapturedEnrollmentDraft(token, null)
      else {
        const updatedAt = Date.now()
        if (!isSafeTime(updatedAt)) throw new VaultError('template-invalid', 'Invalid enrollment quarantine time')
        await writeCapturedEnrollmentDraft(token, { v: 1, updatedAt, entries: current.entries, quarantines })
      }
      assertScope(token)
    })
  },

  async clearEnrollmentDrafts(scopeToken?: VaultScopeToken): Promise<void> {
    const token = scopeToken ?? captureScope(true)
    return enqueueMutation(async () => {
      assertScope(token)
      await writeCapturedEnrollmentDraft(token, null)
      assertScope(token)
    })
  },

  async isEnrolled(): Promise<boolean> {
    return (await vaultStore.getMeta()) != null
  },

  async getMeta(scopeToken?: VaultScopeToken): Promise<VaultMeta | null> {
    const token = scopeToken ?? captureScope(false)
    return token ? readMeta(token) : null
  },

  async setMeta(meta: VaultMeta, scopeToken?: VaultScopeToken): Promise<void> {
    const token = scopeToken ?? captureScope(true)
    return enqueueMutation(() => writeMeta(token, meta))
  },

  /** Create one enrollment without a read/write scope-switch window. */
  async createEnrollment(meta: VaultMeta, scopeToken?: VaultScopeToken): Promise<void> {
    const token = scopeToken ?? captureScope(true)
    return enqueueMutation(async () => {
      const existing = await readMeta(token)
      if (existing?.keys.length) {
        throw new VaultError(
          'key-already-enrolled',
          'A vault is already enrolled on this device; disable it before enrolling again',
          undefined,
          { serial: existing.keys[0].serial }
        )
      }
      await writeMeta(token, meta)
    })
  },

  /**
   * Restore the scoped cache from metadata already authenticated against a
   * spendable output's real R1C lock. The caller performs that lock check;
   * this boundary performs strict schema validation and refuses to replace a
   * different live enrollment.
   */
  async restoreVerifiedMeta(meta: VaultMeta, scopeToken?: VaultScopeToken): Promise<void> {
    const token = scopeToken ?? captureScope(true)
    const checked = checkedMeta(meta)
    return enqueueMutation(async () => {
      const current = await readMeta(token)
      if (current && current.vaultId !== checked.vaultId) {
        throw new VaultError('template-invalid', 'Refusing to replace a different vault enrollment')
      }
      if (current && current.createdAt !== checked.createdAt) {
        throw new VaultError('template-invalid', 'Conflicting vault creation times share an enrollment id')
      }
      if (current && checked.revision < current.revision) {
        throw new VaultError('template-invalid', 'Refusing to restore stale vault enrollment metadata')
      }
      if (
        current &&
        checked.revision === current.revision &&
        JSON.stringify(checked.keys) !== JSON.stringify(current.keys)
      ) {
        throw new VaultError('template-invalid', 'Conflicting vault key sets share the same revision')
      }

      // A same-revision output is another observation of the authority already
      // stored on this device. Merge a discovered tombstone conservatively and
      // preserve local-only recovery/usage state. In particular, replaying a
      // same-revision output must never clear an adoption gate or an unfinished
      // key removal.
      if (current && checked.revision === current.revision) {
        const pendingRemoval = mergePendingRemoval(current.pendingRemoval, checked.pendingRemoval)
        const restored: VaultMeta = { ...current }
        if (pendingRemoval) restored.pendingRemoval = pendingRemoval
        else delete restored.pendingRemoval
        await writeMeta(token, restored)
        return
      }

      const knownSerials = new Set([
        ...checked.keys.map(key => key.serial),
        ...(checked.pendingRemoval ? [checked.pendingRemoval.key.serial] : [])
      ])
      const activeSerials = new Set(checked.keys.map(key => key.serial))
      const restored: VaultMeta = {
        ...checked,
        // last-use and adoption status are device-local facts, never output
        // instructions supplied by a recovery caller.
        recovery: {
          required: true,
          adoptedSerials: (current?.recovery?.adoptedSerials ?? []).filter(serial => knownSerials.has(serial))
        }
      }
      delete restored.lastUsedAt
      delete restored.lastUsedSerial
      if (current?.lastUsedSerial && activeSerials.has(current.lastUsedSerial)) {
        restored.lastUsedAt = current.lastUsedAt
        restored.lastUsedSerial = current.lastUsedSerial
      }
      await writeMeta(token, restored)
    })
  },

  async markKeyAdopted(record: Pick<VaultKeyRecord, 'serial' | 'pubkey'>, scopeToken?: VaultScopeToken): Promise<void> {
    const token = scopeToken ?? captureScope(true)
    return enqueueMutation(async () => {
      const meta = await readMeta(token)
      if (!meta) throw new VaultError('not-enrolled', 'Vault is not set up')
      const known = [...meta.keys, ...(meta.pendingRemoval ? [meta.pendingRemoval.key] : [])]
      if (!known.some(k => k.serial === record.serial && k.pubkey === record.pubkey)) {
        throw new VaultError('wrong-key', 'Challenged key does not match restored vault metadata')
      }
      if (!meta.recovery || meta.recovery.adoptedSerials.includes(record.serial)) return
      await writeMeta(token, {
        ...meta,
        recovery: { required: true, adoptedSerials: [...meta.recovery.adoptedSerials, record.serial] }
      })
    })
  },

  async requireKeyAdopted(serial: string, scopeToken?: VaultScopeToken): Promise<void> {
    const token = scopeToken ?? captureScope(true)
    const meta = await requireMeta(token)
    if (meta.recovery?.required && !meta.recovery.adoptedSerials.includes(serial)) {
      throw new VaultError('key-not-adopted', 'Prove possession of this restored YubiKey before withdrawing')
    }
  },

  async addKey(k: VaultKeyRecord, scopeToken?: VaultScopeToken): Promise<VaultMeta> {
    const token = scopeToken ?? captureScope(true)
    if (!isVaultKeyRecord(k)) throw new VaultError('template-invalid', 'Invalid vault key record')
    return enqueueMutation(async () => {
      const meta = await requireMeta(token)
      if (meta.pendingRemoval) throw new VaultError('relock-required', 'Finish the pending key removal first')
      if (meta.keys.length >= MAX_KEYS) {
        throw new VaultError('too-many-keys', `The vault already has ${MAX_KEYS} keys`)
      }
      if (meta.keys.some(x => x.serial === k.serial || x.pubkey === k.pubkey)) {
        throw new VaultError('key-already-enrolled', k.serial, undefined, { serial: k.serial })
      }
      const next: VaultMeta = { ...meta, revision: meta.revision + 1, keys: [...meta.keys, k] }
      await writeMeta(token, next)
      return next
    })
  },

  async beginKeyRemoval(serial: string, scopeToken?: VaultScopeToken): Promise<VaultMeta> {
    const token = scopeToken ?? captureScope(true)
    return enqueueMutation(async () => {
      const meta = await requireMeta(token)
      if (meta.pendingRemoval) throw new VaultError('relock-required', 'Another key removal is already pending')
      if (meta.keys.length <= MIN_KEYS) {
        throw new VaultError('last-keys', `A vault needs at least ${MIN_KEYS} keys`)
      }
      if (!meta.keys.some(x => x.serial === serial)) {
        throw new VaultError('not-enrolled', `Key ${serial} is not enrolled`)
      }
      const keyIndex = meta.keys.findIndex(x => x.serial === serial)
      const revision = meta.revision + 1
      const next: VaultMeta = {
        ...meta,
        revision,
        keys: meta.keys.filter(x => x.serial !== serial),
        pendingRemoval: {
          key: meta.keys[keyIndex],
          keyIndex,
          startedAt: Date.now(),
          revision,
          state: 'prepared'
        }
      }
      if (next.lastUsedSerial === serial) {
        delete next.lastUsedSerial
        delete next.lastUsedAt
      }
      await writeMeta(token, next)
      return next
    })
  },

  async markKeyRemovalBroadcast(scopeToken?: VaultScopeToken): Promise<VaultMeta> {
    const token = scopeToken ?? captureScope(true)
    return enqueueMutation(async () => {
      const meta = await requireMeta(token)
      const pending = meta.pendingRemoval
      if (!pending) throw new VaultError('not-enrolled', 'No key removal is pending')
      if (pending.state === 'broadcast') return meta
      const next: VaultMeta = {
        ...meta,
        pendingRemoval: { ...pending, state: 'broadcast' }
      }
      await writeMeta(token, next)
      return next
    })
  },

  /** Caller must establish from authenticated action history and two complete
   * output scans that no spendable lock still authorizes the removed key and
   * that no relevant action is pending before invoking. */
  async finalizeProvenKeyRemoval(scopeToken?: VaultScopeToken): Promise<VaultMeta> {
    const token = scopeToken ?? captureScope(true)
    return enqueueMutation(async () => {
      const meta = await requireMeta(token)
      const pending = meta.pendingRemoval
      if (!pending || pending.state !== 'broadcast') {
        throw new VaultError('template-invalid', 'No broadcast key removal is ready for proven finalization')
      }
      const next: VaultMeta = { ...meta }
      delete next.pendingRemoval
      await writeMeta(token, next)
      return next
    })
  },

  /**
   * Complete a removal when the authoritative preflight and postflight scans
   * both prove there were no vault outputs to relock. The transfer layer owns
   * those scans and serializes them with deposits; this method only permits
   * the corresponding untouched, unbroadcast state transition.
   */
  async finalizeEmptyKeyRemoval(scopeToken?: VaultScopeToken): Promise<VaultMeta> {
    const token = scopeToken ?? captureScope(true)
    return enqueueMutation(async () => {
      const meta = await requireMeta(token)
      const pending = meta.pendingRemoval
      if (!pending || pending.state !== 'prepared') {
        throw new VaultError('template-invalid', 'Empty-vault removal does not match the pending state')
      }
      const next: VaultMeta = { ...meta }
      delete next.pendingRemoval
      await writeMeta(token, next)
      return next
    })
  },

  /**
   * Restore a prepared key only after the caller has proved no transaction was
   * broadcast (for example, its reserved action was successfully aborted).
   */
  async cancelUnbroadcastKeyRemoval(scopeToken?: VaultScopeToken): Promise<VaultMeta> {
    const token = scopeToken ?? captureScope(true)
    return enqueueMutation(async () => {
      const meta = await requireMeta(token)
      const pending = meta.pendingRemoval
      if (!pending || pending.state !== 'prepared') {
        throw new VaultError('relock-required', 'A broadcast or unknown removal cannot be cancelled')
      }
      const keys = [...meta.keys]
      keys.splice(pending.keyIndex, 0, pending.key)
      const next: VaultMeta = { ...meta, revision: meta.revision + 1, keys }
      delete next.pendingRemoval
      await writeMeta(token, next)
      return next
    })
  },

  async renameKey(serial: string, nickname: string, scopeToken?: VaultScopeToken): Promise<VaultMeta> {
    const token = scopeToken ?? captureScope(true)
    return enqueueMutation(async () => {
      const meta = await requireMeta(token)
      if (meta.pendingRemoval) throw new VaultError('relock-required', 'Finish the pending key removal first')
      const clean = nickname.trim()
      if (clean.length < 1 || clean.length > 64) throw new VaultError('template-invalid', 'Invalid vault key nickname')
      if (!meta.keys.some(k => k.serial === serial))
        throw new VaultError('not-enrolled', `Key ${serial} is not enrolled`)
      const next: VaultMeta = {
        ...meta,
        revision: meta.revision + 1,
        keys: meta.keys.map(x => (x.serial === serial ? { ...x, nickname: clean } : x))
      }
      await writeMeta(token, next)
      return next
    })
  },

  async noteLastUsed(serial: string, scopeToken?: VaultScopeToken): Promise<void> {
    const token = scopeToken ?? captureScope(false)
    if (!token) return
    return enqueueMutation(async () => {
      const meta = await readMeta(token)
      if (!meta || !meta.keys.some(k => k.serial === serial)) return
      await writeMeta(token, { ...meta, lastUsedAt: Date.now(), lastUsedSerial: serial })
    })
  },

  /** Forget only the active wallet+chain enrollment. */
  async clear(scopeToken?: VaultScopeToken): Promise<void> {
    const token = scopeToken ?? captureScope(true)
    return enqueueMutation(async () => {
      // Distinguish absent from corrupt: corruption needs recovery, not a setup
      // or disable path that silently destroys the last local copy.
      const meta = await readMeta(token)
      if (meta?.pendingRemoval) throw new VaultError('relock-required', 'Finish the pending key removal first')
      assertScope(token)
      await SecureStore.deleteItemAsync(token.storageKey, SECURE_OPTIONS)
      assertScope(token)
      await writeCapturedEnrollmentDraft(token, null)
      assertScope(token)
    })
  }
}
