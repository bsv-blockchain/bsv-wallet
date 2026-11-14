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
import { APP_CHAINS, isAppChain, type AppChain } from '../../networks'

const META_KEY_PREFIX = 'vault_meta_v6'
const ENROLLMENT_DRAFT_KEY_PREFIX = 'vault_enrollment_draft_v1'
/** XR-002: the wallet-root-authenticated integrity tag for this scope's
 * VaultMeta, kept BESIDE the record rather than inside its JSON — the tag
 * covers a canonical encoding computed by metaAuthority.ts, and mixing it
 * into VaultMeta's own strict, allowlisted schema (isVaultMeta) would be a
 * needless coupling between storage-format and authentication concerns. */
const META_TAG_KEY_PREFIX = 'vault_meta_authority_tag_v1'
/** XR-001: one wallet-root-authenticated tag per `ready` enrollment-draft
 * record, keyed by serial. Only `ready` drafts are ever tagged — see
 * metaAuthority.ts's header for why lower assurance levels need none. */
const DRAFT_TAG_KEY_PREFIX = 'vault_enrollment_draft_tag_v1'
const SECURE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY
}
const MIN_KEYS = 2
const MAX_KEYS = 5
/** VaultKeyService.VAULT_MAX_ACTIVE_KEYS: one key beyond the lock's ceiling,
 * held only while a replacement waits for the removal of the key it replaces.
 * Keep in step with VaultKeyService.ts (which imports this module). */
const MAX_ACTIVE_KEYS = MAX_KEYS + 1
const VAULT_SLOT = 0x82

export type VaultScopeChain = AppChain

/** Every chain a vault can be namespaced under. One YubiKey is one physical
 * object, so a destructive maintenance operation has to look at all of them —
 * see `enrolledSerialsAcrossChains`. */
const SCOPE_CHAINS: readonly VaultScopeChain[] = APP_CHAINS

export interface VaultStoreScope {
  /** Compressed secp256k1 wallet identity key, lowercase hex. */
  identityKey: string
  chain: VaultScopeChain
  /** The wallet profile this identity belongs to (default 0). The vault is only
   * ever available on profile 0; transfers check the captured value. */
  profileIndex?: number
}

/** Opaque capability binding an async operation to one configured scope. */
export interface VaultScopeToken {
  readonly generation: number
  readonly storageKey: string
  readonly chain: VaultScopeChain
  readonly profileIndex?: number
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
  /** A key enrolled on a card but not yet part of the committed list. It is
   * never in `keys`; a re-lock signed by an existing proven key commits it. */
  staged?: VaultKeyRecord
  keys: VaultKeyRecord[]
}

export interface VaultRecoveryState {
  required: true
  /** Kept for older readers; derived from `adopted`. */
  adoptedSerials: string[]
  /** Pairs that passed a live tap. Proof is bound to serial AND pubkey.
   * Absent in metas written before this field existed: those read as unproven. */
  adopted?: { serial: string; pubkey: string }[]
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
  'pin-change-uncertain' | 'pin-changed' | 'puk-change-uncertain' | 'puk-changed' | 'generation-uncertain'

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
/** In-memory live-tap proofs, keyed by scope storageKey. Never persisted, so
 * the stored meta and its tag stay valid. Dropped by clearScope. */
const sessionProofs = new Map<string, Set<string>>()

function pairId(p: { serial: string; pubkey: string }): string {
  return `${p.serial}:${p.pubkey}`
}

/** INT-08: subscribers notified whenever configureScope/clearScope actually
 * runs, so a reader started before the wallet-build chain reaches
 * configureScope (VaultContext's boot-time hasVaultMeta check, structurally
 * guaranteed to settle to `false` first — see INT-08) can react to the scope
 * becoming available instead of latching a stale answer for the rest of the
 * session. Mirrors ceremony.subscribe's plain listener-set shape. */
const scopeListeners = new Set<() => void>()
function notifyScopeChange(): void {
  for (const listener of scopeListeners) listener()
}

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
  if (!isAppChain(scope.chain)) {
    throw new VaultError('template-invalid', 'Vault scope requires a supported chain')
  }
  const profileIndex = scope.profileIndex ?? 0
  if (!Number.isInteger(profileIndex) || profileIndex < 0) {
    throw new VaultError('template-invalid', 'Vault scope requires a valid profile index')
  }
  return { identityKey: scope.identityKey, chain: scope.chain, profileIndex }
}

function scopedKey(scope = activeScope): string | null {
  // SecureStore keys accept alphanumerics plus '.', '-' and '_'.
  return scope ? `${META_KEY_PREFIX}_${scope.chain}_${scope.identityKey}` : null
}

/** The shape of a captured meta storage key: `<prefix>_<chain>_<identityKey>`. */
const SCOPE_KEY_PATTERN = /^vault_meta_v6_(main|test|teratest|scaletest)_(0[23][0-9a-f]{64})$/

function enrollmentDraftKey(token: VaultScopeToken): string {
  const match = SCOPE_KEY_PATTERN.exec(token.storageKey)
  if (!match) throw new VaultError('template-invalid', 'Invalid captured vault scope')
  return `${ENROLLMENT_DRAFT_KEY_PREFIX}_${match[1]}_${match[2]}`
}

function metaTagKey(token: VaultScopeToken): string {
  const match = SCOPE_KEY_PATTERN.exec(token.storageKey)
  if (!match) throw new VaultError('template-invalid', 'Invalid captured vault scope')
  return `${META_TAG_KEY_PREFIX}_${match[1]}_${match[2]}`
}

function draftTagStoreKey(token: VaultScopeToken): string {
  const match = SCOPE_KEY_PATTERN.exec(token.storageKey)
  if (!match) throw new VaultError('template-invalid', 'Invalid captured vault scope')
  return `${DRAFT_TAG_KEY_PREFIX}_${match[1]}_${match[2]}`
}

/**
 * XR-002: computes and returns the integrity tag for the meta a write is
 * about to persist, given the EXACT object about to be written (never a
 * separately re-read copy — that would open a TOCTOU window between what was
 * authenticated and what lands in storage). Every caller must derive this
 * from `wallet.createHmac` under the admin-reserved 'vault meta' protocol
 * (metaAuthority.ts / guard.ts's VAULT_PROTOCOL_NAMES); vaultStore itself
 * has no wallet access and trusts the returned string as-is. A tagger that
 * throws aborts the whole write: writeMeta only runs after the tag is in
 * hand, so a wallet-side failure never leaves an updated-but-untagged
 * record on disk.
 *
 * Deliberately OPTIONAL: a write made without one (every plain storage-level
 * test, and any future maintenance path that has no wallet handy) simply
 * leaves the on-file tag exactly as it was — which the next
 * output-creating operation's verification (transfers.ts's
 * requireAuthenticatedMeta) will then correctly treat as stale/absent and
 * refuse to trust, never as though nothing had happened.
 */
export type VaultMetaTagger = (
  next: Pick<VaultMeta, 'vaultId' | 'revision' | 'createdAt' | 'keys' | 'pendingRemoval' | 'staged' | 'recovery'>
) => Promise<string>

/** Match the record actually read inside the mutation queue to the snapshot
 * authenticated by its caller. Never re-tag a separately loaded key list. */
function requireAuthenticatedSnapshot(meta: VaultMeta, expected?: VaultMeta, tagger?: VaultMetaTagger): void {
  if (tagger && !expected) {
    throw new VaultError('template-invalid', 'A tagged mutation requires an authenticated metadata snapshot')
  }
  if (expected && JSON.stringify(meta) !== JSON.stringify(expected)) {
    throw new VaultError('template-invalid', 'Vault metadata changed after authentication; reload and retry')
  }
}

/** True only when the tag on file is exactly the tag `tagger` computes over
 * `meta` (tags are deterministic HMACs). Without a tagger, a stored tag or on
 * any failure: false (fail closed). Used so a fresh tag is never written over
 * adoption or staging fields that no authentic tag ever covered. */
async function storedTagMatches(token: VaultScopeToken, meta: VaultMeta, tagger?: VaultMetaTagger): Promise<boolean> {
  if (!tagger) return false
  try {
    const stored = await readMetaTag(token)
    return !!stored && (await tagger(meta)) === stored
  } catch {
    return false
  }
}

/** XR-001: same contract as VaultMetaTagger, for one `ready` draft record. */
export type VaultDraftTagger = (record: VaultKeyRecord) => Promise<string>

async function readMetaTag(token: VaultScopeToken): Promise<string | null> {
  return (await SecureStore.getItemAsync(metaTagKey(token), SECURE_OPTIONS)) || null
}

async function writeMetaTag(token: VaultScopeToken, tag: string): Promise<void> {
  if (typeof tag !== 'string' || tag.length === 0) {
    throw new VaultError('template-invalid', 'Invalid vault meta authority tag')
  }
  await SecureStore.setItemAsync(metaTagKey(token), tag, SECURE_OPTIONS)
}

async function clearMetaTag(token: VaultScopeToken): Promise<void> {
  await SecureStore.deleteItemAsync(metaTagKey(token), SECURE_OPTIONS)
}

/** Write `meta` and, when a tagger is supplied, its fresh authority tag —
 * atomically within the caller's enqueueMutation critical section. The tag
 * is computed BEFORE writeMeta so a tagger failure (a rejected wallet call)
 * leaves storage completely untouched rather than updated-but-untagged. */
async function writeMetaAndTag(token: VaultScopeToken, meta: VaultMeta, tagger?: VaultMetaTagger): Promise<void> {
  const tag = tagger ? await tagger(meta) : undefined
  await writeMeta(token, meta)
  if (tag !== undefined) await writeMetaTag(token, tag)
}

async function readDraftTags(token: VaultScopeToken): Promise<Record<string, string>> {
  const raw = await SecureStore.getItemAsync(draftTagStoreKey(token), SECURE_OPTIONS)
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, string> = {}
    for (const [serial, tag] of Object.entries(parsed as Record<string, unknown>)) {
      if (isVaultSerial(serial) && typeof tag === 'string' && tag.length > 0) out[serial] = tag
    }
    return out
  } catch {
    // Corrupt draft-tag bookkeeping is never fatal: it only ever narrows what
    // gets trusted as 'ready' (see VaultKeyService's verifyVaultDraftAuthorityTag
    // use), never widens it.
    return {}
  }
}

async function writeDraftTags(token: VaultScopeToken, tags: Record<string, string>): Promise<void> {
  const entries = Object.entries(tags)
  if (entries.length === 0) await SecureStore.deleteItemAsync(draftTagStoreKey(token), SECURE_OPTIONS)
  else await SecureStore.setItemAsync(draftTagStoreKey(token), JSON.stringify(tags), SECURE_OPTIONS)
}

/** The wallet identity a captured scope belongs to, without its chain half. */
function identityKeyFromToken(token: VaultScopeToken): string {
  const match = SCOPE_KEY_PATTERN.exec(token.storageKey)
  if (!match) throw new VaultError('template-invalid', 'Invalid captured vault scope')
  return match[2]
}

function captureScope(required: true): VaultScopeToken
function captureScope(required: false): VaultScopeToken | null
function captureScope(required: boolean): VaultScopeToken | null {
  const storageKey = scopedKey()
  if (!storageKey) {
    if (required) throw new VaultError('not-enrolled', 'Wallet vault scope is not configured')
    return null
  }
  return {
    generation: scopeGeneration,
    storageKey,
    chain: activeScope!.chain,
    profileIndex: activeScope!.profileIndex ?? 0
  }
}

function assertScope(token: VaultScopeToken): void {
  if (
    token.generation !== scopeGeneration ||
    token.storageKey !== scopedKey() ||
    token.chain !== activeScope?.chain ||
    (token.profileIndex ?? 0) !== (activeScope?.profileIndex ?? 0)
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
    'staged',
    'keys'
  ]
  if (Object.keys(m).some(name => !allowed.includes(name))) return false
  if (m.v !== 6 || typeof m.vaultId !== 'string' || !/^[0-9a-f]{64}$/.test(m.vaultId)) return false
  if (typeof m.revision !== 'number' || !Number.isSafeInteger(m.revision) || m.revision < 1) return false
  if (!isSafeTime(m.createdAt)) return false
  if (!Array.isArray(m.keys) || m.keys.length < MIN_KEYS || m.keys.length > MAX_ACTIVE_KEYS) return false
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
  if (m.staged !== undefined) {
    if (!isVaultKeyRecord(m.staged)) return false
    const staged = m.staged as VaultKeyRecord
    const removedKey = (m.pendingRemoval as VaultPendingRemoval | undefined)?.key
    if (keys.some(k => k.serial === staged.serial || k.pubkey === staged.pubkey)) return false
    if (removedKey && (removedKey.serial === staged.serial || removedKey.pubkey === staged.pubkey)) return false
    if (keys.length + 1 > MAX_ACTIVE_KEYS) return false
  }
  if (m.recovery !== undefined) {
    const r = m.recovery
    if (r === null || typeof r !== 'object' || Array.isArray(r)) return false
    const recovery = r as Record<string, unknown>
    if (Object.keys(recovery).some(name => !['required', 'adoptedSerials', 'adopted'].includes(name))) return false
    if (recovery.required !== true || !Array.isArray(recovery.adoptedSerials)) return false
    if (!recovery.adoptedSerials.every(isVaultSerial)) return false
    if (new Set(recovery.adoptedSerials as string[]).size !== recovery.adoptedSerials.length) return false
    const known = new Set(keys.map(k => k.serial))
    if (m.pendingRemoval) known.add((m.pendingRemoval as VaultPendingRemoval).key.serial)
    if (m.staged) known.add((m.staged as VaultKeyRecord).serial)
    if (!(recovery.adoptedSerials as string[]).every(serial => known.has(serial))) return false
    if (recovery.adopted !== undefined) {
      if (!Array.isArray(recovery.adopted)) return false
      const knownPairs = new Set(
        [
          ...keys,
          ...(m.pendingRemoval ? [(m.pendingRemoval as VaultPendingRemoval).key] : []),
          ...(m.staged ? [m.staged as VaultKeyRecord] : [])
        ].map(pairId)
      )
      const seen = new Set<string>()
      for (const entry of recovery.adopted as unknown[]) {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return false
        const e = entry as Record<string, unknown>
        if (Object.keys(e).some(name => name !== 'serial' && name !== 'pubkey')) return false
        if (typeof e.serial !== 'string' || typeof e.pubkey !== 'string') return false
        const id = pairId(e as { serial: string; pubkey: string })
        if (!knownPairs.has(id) || seen.has(id)) return false
        seen.add(id)
      }
    }
  }
  return true
}

/** Parse one stored namespace. Corrupt is never "absent": a caller that acts on
 * an empty answer must fail instead of reading a smaller key list than the
 * truth. */
function parseStoredMeta(raw: string | null, corruptMessage: string): VaultMeta | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new VaultError('template-invalid', corruptMessage)
  }
  if (!isVaultMeta(parsed)) throw new VaultError('template-invalid', corruptMessage)
  return parsed
}

async function readMeta(token: VaultScopeToken): Promise<VaultMeta | null> {
  assertScope(token)
  const raw = await SecureStore.getItemAsync(token.storageKey, SECURE_OPTIONS)
  assertScope(token)
  return parseStoredMeta(raw, 'Stored vault enrollment metadata is corrupt')
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

/** Every key pair of `meta` a tap can prove: the list, the key being removed
 * and the staged key. */
function metaPairs(meta: VaultMeta): VaultKeyRecord[] {
  return [...meta.keys, ...(meta.pendingRemoval ? [meta.pendingRemoval.key] : []), ...(meta.staged ? [meta.staged] : [])]
}

/** Pairs of `meta` proven by a durable record or a session proof of this scope.
 * A meta enrolled on this phone (no recovery state) proves all its pairs: each
 * passed the enrollment challenge. A legacy recovery meta (serials only) proves
 * none. */
function provenPairRecords(meta: VaultMeta, token: VaultScopeToken | null): VaultKeyRecord[] {
  if (!meta.recovery?.required) return metaPairs(meta)
  const durable = new Set((meta.recovery.adopted ?? []).map(pairId))
  const session = token ? sessionProofs.get(token.storageKey) : undefined
  return metaPairs(meta).filter(k => durable.has(pairId(k)) || session?.has(pairId(k)) === true)
}

export const vaultStore = {
  /** Select the only wallet+chain namespace subsequent calls may access. */
  configureScope(scope: VaultStoreScope): void {
    activeScope = normalizeScope(scope)
    scopeGeneration++
    notifyScopeChange()
  },

  /** Drop the in-memory authority during logout, wallet rebuild or teardown. */
  clearScope(): void {
    activeScope = null
    sessionProofs.clear()
    scopeGeneration++
    notifyScopeChange()
  },

  /** INT-08: notified after every configureScope/clearScope. Returns an
   * unsubscribe function, matching ceremony.subscribe's shape. */
  onScopeChange(cb: () => void): () => void {
    scopeListeners.add(cb)
    return () => {
      scopeListeners.delete(cb)
    }
  },

  getScope(): VaultStoreScope | null {
    return activeScope ? { ...activeScope } : null
  },

  /**
   * The keys of `meta` that a live tap proved: the one definition every new
   * lock is built from. Synchronous. A chain record alone never proves a key,
   * and proof is bound to serial AND pubkey, so a planted record that reuses a
   * real serial inherits nothing.
   */
  provenKeyRecords(meta: VaultMeta, scopeToken?: VaultScopeToken): VaultKeyRecord[] {
    const proven = new Set(provenPairRecords(meta, scopeToken ?? captureScope(false)).map(pairId))
    return meta.keys.filter(k => proven.has(pairId(k)))
  },

  /** Remember a live-tap proof in memory only (nothing is written, so the
   * stored meta and its tag stay valid). Dropped by clearScope. */
  noteSessionProof(record: Pick<VaultKeyRecord, 'serial' | 'pubkey'>, scopeToken?: VaultScopeToken): void {
    const token = scopeToken ?? captureScope(true)
    assertScope(token)
    let set = sessionProofs.get(token.storageKey)
    if (!set) {
      set = new Set()
      sessionProofs.set(token.storageKey, set)
    }
    set.add(pairId(record))
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
   * Assurance is monotonic and same-serial/pubkey conflicts fail closed.
   *
   * XR-001: when the SAVED entry (after the monotonic-rank comparison below)
   * ends up `ready` and a `tagger` is supplied, this also computes and stores
   * that record's wallet-root authority tag — atomically, before the draft
   * write, for the same TOCTOU reason writeMetaAndTag documents. A `ready`
   * write with no tagger (a caller that has no wallet handy, or every
   * pre-existing storage-level test) simply leaves the record untagged; the
   * only place that ever matters is requireReadyEnrollmentDrafts /
   * resumeEnrollmentDraft's fast path, which then correctly refuses to trust
   * it as sufficient authority on its own. */
  async preserveEnrollmentDraft(
    entry: VaultEnrollmentDraftEntry,
    scopeToken: VaultScopeToken,
    tagger?: VaultDraftTagger
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
      const saved: VaultEnrollmentDraftEntry =
        existingIndex < 0
          ? { assurance: entry.assurance, record: { ...entry.record } }
          : draftAssuranceRank(entries[existingIndex].assurance) >= draftAssuranceRank(entry.assurance)
            ? entries[existingIndex]
            : { assurance: entry.assurance, record: { ...entry.record } }
      if (existingIndex < 0) entries.push(saved)
      else entries[existingIndex] = saved
      const retainedQuarantines = quarantines.filter(item => item.serial !== entry.record.serial)
      const updatedAt = Date.now()
      if (!isSafeTime(updatedAt)) throw new VaultError('template-invalid', 'Invalid enrollment draft time')
      const tag = tagger && saved.assurance === 'ready' ? await tagger(saved.record) : undefined
      await writeCapturedEnrollmentDraft(scopeToken, {
        v: 1,
        updatedAt,
        entries,
        quarantines: retainedQuarantines
      })
      if (tag !== undefined) {
        const tags = await readDraftTags(scopeToken)
        tags[saved.record.serial] = tag
        await writeDraftTags(scopeToken, tags)
      }
      return { ...saved, record: { ...saved.record } }
    })
  },

  /** XR-001: the wallet-root authority tag for a `ready` draft's serial, or
   * null if none is on file (never tagged, or tagged under an assurance the
   * caller's write path did not supply a tagger for). */
  async getEnrollmentDraftTag(serial: string, scopeToken?: VaultScopeToken): Promise<string | null> {
    const token = scopeToken ?? captureScope(true)
    if (!isVaultSerial(serial)) throw new VaultError('template-invalid', 'Invalid enrollment draft serial')
    const tags = await readDraftTags(token)
    return tags[serial] ?? null
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
      // XR-001: a consumed/discarded serial's tag must not linger — a later,
      // unrelated draft that happens to reuse the same serial (a different
      // physical card whose ratcheted serial format collides, or the same
      // card re-enrolled) must never inherit a stale authority tag it never
      // earned.
      const tags = await readDraftTags(token)
      let tagsChanged = false
      for (const serial of consumed) {
        if (serial in tags) {
          delete tags[serial]
          tagsChanged = true
        }
      }
      if (tagsChanged) await writeDraftTags(token, tags)
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
      await writeDraftTags(token, {})
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

  /**
   * Every YubiKey serial this wallet identity has enrolled under ANY chain,
   * including one mid-removal. Deliberately crosses the chain half of the
   * namespace — and only that half.
   *
   * Metadata is namespaced per wallet+chain because a deposit must never be
   * redirected across wallets. A YubiKey is not: it is one physical object that
   * can be a live signer for the mainnet vault while the app is showing
   * testnet. `getMeta` sees one namespace, so it answers "empty" for a card
   * that is holding real money — which is safe for a read and catastrophic for
   * an erase. Destructive maintenance (services/vault/pivReset.ts) must ask
   * this instead.
   *
   * Returns serials only: no other namespace's metadata leaves this function.
   * Fails closed — unreadable or corrupt metadata in ANY chain throws rather
   * than reporting a shorter list, because the caller destroys a key when the
   * answer comes back without it. Does NOT cross wallet identities; that
   * residual needs a device-wide serial index (SecureStore cannot be
   * enumerated) and is tracked outside this module.
   */
  async enrolledSerialsAcrossChains(scopeToken?: VaultScopeToken): Promise<string[]> {
    const token = scopeToken ?? captureScope(true)
    const identityKey = identityKeyFromToken(token)
    assertScope(token)
    const serials = new Set<string>()
    for (const chain of SCOPE_CHAINS) {
      const storageKey = `${META_KEY_PREFIX}_${chain}_${identityKey}`
      const raw = await SecureStore.getItemAsync(storageKey, SECURE_OPTIONS)
      const meta = parseStoredMeta(raw, `Stored vault enrollment metadata is corrupt (${chain})`)
      for (const key of meta?.keys ?? []) serials.add(key.serial)
      if (meta?.pendingRemoval) serials.add(meta.pendingRemoval.key.serial)
    }
    // The read spanned chains, never wallets: the operation still must not
    // outlive the wallet it was captured for.
    assertScope(token)
    return [...serials]
  },

  /** Raw meta write with no `current`-vs-`next` relationship at all (no
   * production code path uses this — it exists for test fixtures). Since
   * there is no `current` to launder, a tagger here is always safe to trust
   * for whatever `meta` the caller supplies. */
  async setMeta(meta: VaultMeta, scopeToken?: VaultScopeToken, tagger?: VaultMetaTagger): Promise<void> {
    const token = scopeToken ?? captureScope(true)
    return enqueueMutation(() => writeMetaAndTag(token, meta, tagger))
  },

  /** Create one enrollment without a read/write scope-switch window.
   *
   * XR-002: a fresh enrollment has no prior authority to launder — this
   * refuses outright whenever one already exists — so `tagger` is always
   * safe to trust for whatever `meta` the caller (finalizeEnrollment) built. */
  async createEnrollment(meta: VaultMeta, scopeToken?: VaultScopeToken, tagger?: VaultMetaTagger): Promise<void> {
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
      await writeMetaAndTag(token, meta, tagger)
    })
  },

  /**
   * Restore the scoped cache from metadata already authenticated against a
   * spendable output's real R1C lock. The caller performs that lock check;
   * this boundary performs strict schema validation and refuses to replace a
   * different live enrollment.
   *
   * XR-002: this is the "safer route" requireAuthenticatedMeta
   * (transfers.ts) falls back to for meta whose wallet-root tag is missing
   * or invalid — never a silent trust-on-first-use. It is safe to tag
   * whatever `restored` ends up being here without first re-verifying
   * `current`'s own tag: in the same-revision branch, `restored`'s
   * authority fields (vaultId/createdAt/revision/keys) come from `current`
   * ONLY after the equality check just above already proved them identical
   * to `checked` — itself independently authenticated against a real,
   * chain-verified R1C lock by the caller; in the higher-revision branch
   * they are taken from `checked` directly, never from `current`.
   *
   * The tag-covered recovery.adopted and staged fields are NOT proven by the
   * chain, so they are kept from `current` only when `current`'s own tag
   * verifies (storedTagMatches); otherwise adopted becomes [] and staged is
   * dropped. A forged adoption therefore never launders into the fresh tag. */
  async restoreVerifiedMeta(
    meta: VaultMeta,
    scopeToken?: VaultScopeToken,
    tagger?: VaultMetaTagger
  ): Promise<VaultMeta> {
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
        // adopted and staged decide which keys a new lock commits. Keep them
        // only when current's own tag verifies; otherwise a store-only edit
        // would be blessed by the fresh tag below. With no tagger no tag is
        // written, so nothing is blessed and current stays as it is.
        if (tagger && !(await storedTagMatches(token, current, tagger))) {
          restored.recovery = { required: true, adoptedSerials: [], adopted: [] }
          delete restored.staged
        }
        if (pendingRemoval) restored.pendingRemoval = pendingRemoval
        else delete restored.pendingRemoval
        await writeMetaAndTag(token, restored, tagger)
        return restored
      }

      const activeSerials = new Set(checked.keys.map(key => key.serial))
      // Adoption carries over by serial AND pubkey. A device with no recovery
      // state proved all its keys at enrollment; a legacy recovery meta proved
      // none. The staged key passed its own live challenge as a ready draft.
      const checkedPairs = new Set(
        [...checked.keys, ...(checked.pendingRemoval ? [checked.pendingRemoval.key] : [])].map(pairId)
      )
      // current's adoption state counts only when its own tag verifies: a
      // store-only attacker may have edited adopted or stripped recovery.
      const currentTrusted = current ? await storedTagMatches(token, current, tagger) : false
      const currentProven = current && currentTrusted
        ? current.recovery?.required
          ? metaPairs(current).filter(k =>
              (current.recovery!.adopted ?? []).some(p => p.serial === k.serial && p.pubkey === k.pubkey)
            )
          : metaPairs(current)
        : []
      const stagedPair = current?.staged && currentTrusted ? [current.staged] : []
      const carried: { serial: string; pubkey: string }[] = []
      for (const k of [...currentProven, ...stagedPair]) {
        const pair = { serial: k.serial, pubkey: k.pubkey }
        if (checkedPairs.has(pairId(pair)) && !carried.some(c => pairId(c) === pairId(pair))) carried.push(pair)
      }
      const restored: VaultMeta = {
        ...checked,
        // last-use and adoption status are device-local facts, never output
        // instructions supplied by a recovery caller.
        recovery: {
          required: true,
          adoptedSerials: carried.map(p => p.serial),
          adopted: carried
        }
      }
      delete restored.lastUsedAt
      delete restored.lastUsedSerial
      if (current?.lastUsedSerial && activeSerials.has(current.lastUsedSerial)) {
        restored.lastUsedAt = current.lastUsedAt
        restored.lastUsedSerial = current.lastUsedSerial
      }
      await writeMetaAndTag(token, restored, tagger)
      return restored
    })
  },

  /**
   * Record that a live tap proved `record`. The pair must match a key of the
   * list, the key being removed or the staged key. With a `tagger` the pair is
   * written (meta and tag together). Without one it is a session proof only:
   * nothing is written, so the stored tag stays valid. A meta enrolled on this
   * phone (no recovery state) needs neither: it is a no-op.
   *
   * Caller contract (laundering): with a `tagger`, the caller must have
   * established that the stored meta is authentic (adoptVaultKey verifies its
   * tag first and passes that snapshot as `expectedMeta`), because the fresh
   * tag covers the whole stored meta.
   */
  async markKeyAdopted(
    record: Pick<VaultKeyRecord, 'serial' | 'pubkey'>,
    scopeToken?: VaultScopeToken,
    tagger?: VaultMetaTagger,
    expectedMeta?: VaultMeta
  ): Promise<void> {
    const token = scopeToken ?? captureScope(true)
    return enqueueMutation(async () => {
      const meta = await readMeta(token)
      if (!meta) throw new VaultError('not-enrolled', 'Vault is not set up')
      if (tagger || expectedMeta) requireAuthenticatedSnapshot(meta, expectedMeta, tagger)
      if (!metaPairs(meta).some(k => k.serial === record.serial && k.pubkey === record.pubkey)) {
        throw new VaultError('wrong-key', 'Challenged key does not match restored vault metadata')
      }
      if (!meta.recovery) return
      if (!tagger) {
        this.noteSessionProof(record, token)
        return
      }
      const adopted = meta.recovery.adopted ?? []
      if (adopted.some(p => p.serial === record.serial && p.pubkey === record.pubkey)) return
      const pair = { serial: record.serial, pubkey: record.pubkey }
      const adoptedSerials = meta.recovery.adoptedSerials.includes(record.serial)
        ? meta.recovery.adoptedSerials
        : [...meta.recovery.adoptedSerials, record.serial]
      await writeMetaAndTag(
        token,
        { ...meta, recovery: { required: true, adoptedSerials, adopted: [...adopted, pair] } },
        tagger
      )
    })
  },

  /** Withdrawals need the tapped key proven: a durable pair or a session proof
   * that matches the stored serial AND pubkey (the key being removed counts, so
   * a half-finished removal never strands its funds). */
  async requireKeyAdopted(serial: string, scopeToken?: VaultScopeToken): Promise<void> {
    const token = scopeToken ?? captureScope(true)
    const meta = await requireMeta(token)
    if (meta.recovery?.required && !provenPairRecords(meta, token).some(k => k.serial === serial)) {
      throw new VaultError('key-not-adopted', 'Prove possession of this restored YubiKey before withdrawing')
    }
  },

  /**
   * XR-002: `next` here is built by APPENDING to `meta.keys` — never
   * replacing it — so a forged `meta` (a substituted key set the caller
   * never authenticated) would otherwise "launder" straight through into a
   * freshly, validly tagged `next` merely because the user added one more,
   * genuinely their own, key. Callers MUST verify `meta`'s own existing tag
   * (or run it through the chain-authenticated recovery path) BEFORE calling
   * this with a `tagger` — see VaultKeyService.addVaultKey's
   * requireTaggedMeta call, which does exactly that.
   */
  async addKey(
    k: VaultKeyRecord,
    scopeToken?: VaultScopeToken,
    tagger?: VaultMetaTagger,
    expectedMeta?: VaultMeta
  ): Promise<VaultMeta> {
    const token = scopeToken ?? captureScope(true)
    if (!isVaultKeyRecord(k)) throw new VaultError('template-invalid', 'Invalid vault key record')
    return enqueueMutation(async () => {
      const meta = await requireMeta(token)
      requireAuthenticatedSnapshot(meta, expectedMeta, tagger)
      if (meta.pendingRemoval) throw new VaultError('relock-required', 'Finish the pending key removal first')
      if (meta.keys.length >= MAX_ACTIVE_KEYS) {
        throw new VaultError('too-many-keys', `The vault already has ${MAX_ACTIVE_KEYS} keys`)
      }
      if (meta.keys.some(x => x.serial === k.serial || x.pubkey === k.pubkey)) {
        throw new VaultError('key-already-enrolled', k.serial, undefined, { serial: k.serial })
      }
      const next: VaultMeta = { ...meta, revision: meta.revision + 1, keys: [...meta.keys, k] }
      await writeMetaAndTag(token, next, tagger)
      return next
    })
  },

  /** Same laundering caveat as addKey: `meta` must already be established as
   * trustworthy by the caller (transfers.ts's beginVaultKeyRemoval gates its
   * whole flow on requireAuthenticatedMeta before reaching here) before a
   * `tagger` is supplied. */
  async beginKeyRemoval(
    serial: string,
    scopeToken?: VaultScopeToken,
    tagger?: VaultMetaTagger,
    expectedMeta?: VaultMeta
  ): Promise<VaultMeta> {
    const token = scopeToken ?? captureScope(true)
    return enqueueMutation(async () => {
      const meta = await requireMeta(token)
      requireAuthenticatedSnapshot(meta, expectedMeta, tagger)
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
      await writeMetaAndTag(token, next, tagger)
      return next
    })
  },

  async markKeyRemovalBroadcast(
    scopeToken?: VaultScopeToken,
    tagger?: VaultMetaTagger,
    expectedMeta?: VaultMeta
  ): Promise<VaultMeta> {
    const token = scopeToken ?? captureScope(true)
    return enqueueMutation(async () => {
      const meta = await requireMeta(token)
      requireAuthenticatedSnapshot(meta, expectedMeta, tagger)
      const pending = meta.pendingRemoval
      if (!pending) throw new VaultError('not-enrolled', 'No key removal is pending')
      if (pending.state === 'broadcast') return meta
      const next: VaultMeta = {
        ...meta,
        pendingRemoval: { ...pending, state: 'broadcast' }
      }
      await writeMetaAndTag(token, next, tagger)
      return next
    })
  },

  /**
   * After a spend created a lock with a different key set than the list (a
   * re-lock or remainder that dropped unproven keys, or activated the staged
   * key): write `keys`, `revision`, and the pruned adoption state in ONE tagged
   * write. The staged key leaves `staged` only when `clearStaged` is set. The
   * adoption pairs of keys that stay (list, key being removed, staged key that
   * stays staged) are kept; pairs of dropped keys go. The caller passes the
   * authenticated snapshot as `expectedMeta` (same contract as addKey).
   */
  async commitLockKeySet(
    args: { keys: VaultKeyRecord[]; revision: number; clearStaged: boolean },
    scopeToken?: VaultScopeToken,
    tagger?: VaultMetaTagger,
    expectedMeta?: VaultMeta
  ): Promise<VaultMeta> {
    const token = scopeToken ?? captureScope(true)
    return enqueueMutation(async () => {
      const meta = await requireMeta(token)
      requireAuthenticatedSnapshot(meta, expectedMeta, tagger)
      if (!Number.isSafeInteger(args.revision) || args.revision <= meta.revision) {
        throw new VaultError('template-invalid', 'The new key set must carry a higher revision')
      }
      if (!args.keys.every(isVaultKeyRecord) || args.keys.length < MIN_KEYS || args.keys.length > MAX_KEYS) {
        throw new VaultError('template-invalid', 'Invalid vault lock key set')
      }
      const next: VaultMeta = { ...meta, revision: args.revision, keys: args.keys.map(k => ({ ...k })) }
      if (args.clearStaged) delete next.staged
      // The removal's replacement output carries the new revision. keyIndex is
      // where the removed key sat in the list; keep it within the shorter list.
      if (next.pendingRemoval) {
        next.pendingRemoval = {
          ...next.pendingRemoval,
          revision: args.revision,
          keyIndex: Math.min(next.pendingRemoval.keyIndex, next.keys.length)
        }
      }
      if (next.lastUsedSerial !== undefined && !next.keys.some(k => k.serial === next.lastUsedSerial)) {
        delete next.lastUsedSerial
        delete next.lastUsedAt
      }
      if (next.recovery) {
        const kept = new Set(metaPairs(next).map(pairId))
        const adopted = (next.recovery.adopted ?? []).filter(p => kept.has(pairId(p)))
        const serials = new Set(metaPairs(next).map(k => k.serial))
        next.recovery = {
          required: true,
          adoptedSerials:
            next.recovery.adopted === undefined
              ? next.recovery.adoptedSerials.filter(s => serials.has(s))
              : [...new Set(adopted.map(p => p.serial))],
          ...(next.recovery.adopted === undefined ? {} : { adopted })
        }
      }
      await writeMetaAndTag(token, next, tagger)
      return next
    })
  },

  /** Caller must establish from authenticated action history and two complete
   * output scans that no spendable lock still authorizes the removed key and
   * that no relevant action is pending before invoking. */
  async finalizeProvenKeyRemoval(
    scopeToken?: VaultScopeToken,
    tagger?: VaultMetaTagger,
    expectedMeta?: VaultMeta
  ): Promise<VaultMeta> {
    const token = scopeToken ?? captureScope(true)
    return enqueueMutation(async () => {
      const meta = await requireMeta(token)
      requireAuthenticatedSnapshot(meta, expectedMeta, tagger)
      const pending = meta.pendingRemoval
      if (!pending || pending.state !== 'broadcast') {
        throw new VaultError('template-invalid', 'No broadcast key removal is ready for proven finalization')
      }
      const next: VaultMeta = { ...meta }
      delete next.pendingRemoval
      await writeMetaAndTag(token, next, tagger)
      return next
    })
  },

  /**
   * Complete a removal when the authoritative preflight and postflight scans
   * both prove no vault output commits the key, so there is nothing to
   * relock (an empty vault, or a key never locked to). The transfer layer owns
   * those scans and serializes them with deposits; this method only permits
   * the corresponding untouched, unbroadcast state transition.
   */
  async finalizeEmptyKeyRemoval(
    scopeToken?: VaultScopeToken,
    tagger?: VaultMetaTagger,
    expectedMeta?: VaultMeta
  ): Promise<VaultMeta> {
    const token = scopeToken ?? captureScope(true)
    return enqueueMutation(async () => {
      const meta = await requireMeta(token)
      requireAuthenticatedSnapshot(meta, expectedMeta, tagger)
      const pending = meta.pendingRemoval
      if (!pending || pending.state !== 'prepared') {
        throw new VaultError('template-invalid', 'Empty-vault removal does not match the pending state')
      }
      const next: VaultMeta = { ...meta }
      delete next.pendingRemoval
      await writeMetaAndTag(token, next, tagger)
      return next
    })
  },

  /**
   * Restore a prepared key only after the caller has proved no transaction was
   * broadcast (for example, its reserved action was successfully aborted).
   */
  async cancelUnbroadcastKeyRemoval(
    scopeToken?: VaultScopeToken,
    tagger?: VaultMetaTagger,
    expectedMeta?: VaultMeta
  ): Promise<VaultMeta> {
    const token = scopeToken ?? captureScope(true)
    return enqueueMutation(async () => {
      const meta = await requireMeta(token)
      requireAuthenticatedSnapshot(meta, expectedMeta, tagger)
      const pending = meta.pendingRemoval
      if (!pending || pending.state !== 'prepared') {
        throw new VaultError('relock-required', 'A broadcast or unknown removal cannot be cancelled')
      }
      const keys = [...meta.keys]
      keys.splice(pending.keyIndex, 0, pending.key)
      const next: VaultMeta = { ...meta, revision: meta.revision + 1, keys }
      delete next.pendingRemoval
      await writeMetaAndTag(token, next, tagger)
      return next
    })
  },

  /** Same laundering caveat as addKey: the caller (VaultScreen's rename
   * action) must establish `meta` is trustworthy via requireAuthenticatedMeta
   * before supplying a `tagger`. */
  async renameKey(
    serial: string,
    nickname: string,
    scopeToken?: VaultScopeToken,
    tagger?: VaultMetaTagger,
    expectedMeta?: VaultMeta
  ): Promise<VaultMeta> {
    const token = scopeToken ?? captureScope(true)
    return enqueueMutation(async () => {
      const meta = await requireMeta(token)
      requireAuthenticatedSnapshot(meta, expectedMeta, tagger)
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
      await writeMetaAndTag(token, next, tagger)
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
      await clearMetaTag(token)
      assertScope(token)
      await writeCapturedEnrollmentDraft(token, null)
      await writeDraftTags(token, {})
      assertScope(token)
    })
  },

  /**
   * Forget the local setup of the active scope: the meta item, its authority
   * tag and the in-memory session proofs. Unlike `clear` it works with no meta,
   * with a corrupt one and with a pendingRemoval, and it keeps enrollment
   * drafts. It does not touch the chain; the caller relinquishes local outputs.
   */
  async forgetSetup(scopeToken?: VaultScopeToken): Promise<void> {
    const token = scopeToken ?? captureScope(true)
    return enqueueMutation(async () => {
      assertScope(token)
      await SecureStore.deleteItemAsync(token.storageKey, SECURE_OPTIONS)
      await clearMetaTag(token)
      sessionProofs.delete(token.storageKey)
      assertScope(token)
    })
  },

  /** XR-002: the wallet-root authority tag on file for this scope's VaultMeta,
   * or null if none exists (never tagged — every enrollment created before
   * this fix shipped — or explicitly cleared). Read by
   * transfers.ts's requireAuthenticatedMeta and by every meta-mutating
   * caller that must verify `current` before trusting it as the basis for a
   * freshly tagged `next` (see addKey/beginKeyRemoval/renameKey's laundering
   * caveat above). */
  async getMetaTag(scopeToken?: VaultScopeToken): Promise<string | null> {
    const token = scopeToken ?? captureScope(true)
    return readMetaTag(token)
  }
}
