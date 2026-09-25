/**
 * XR-001 / XR-002 — wallet-root-authenticated integrity tags for Vault
 * metadata and enrollment drafts.
 *
 * Threat (SEC2-087 / SEC2-088): an attacker who can WRITE the app's
 * SecureStore (vault meta and enrollment drafts) but does not hold the
 * wallet root (the mnemonic-derived key, behind the biometric-protected KEK
 * in release builds) can forge (a) a higher-revision vault meta with a
 * substituted key set, so the next deposit/re-vault/re-lock commits only
 * attacker keys, or (b) a `ready` enrollment draft that injects an attacker
 * key. Both were previously accepted on bare structural validation alone
 * (isVaultMeta / isVaultKeyRecord), which proves SHAPE, never AUTHORITY.
 *
 * Fix: every legitimate code path that writes vault meta or a `ready` draft
 * computes an HMAC over a canonical encoding of exactly the fields that
 * confer spend authority, using `wallet.createHmac` under the
 * ADMIN-reserved `vault meta` protocol namespace (guard.ts's
 * VAULT_PROTOCOL_NAMES) — a namespace a connected/paired caller is refused,
 * exactly mirroring connectionAuthority.ts's `connection authority` tag.
 * A SecureStore-only attacker never runs the wallet's own code at all, so
 * they cannot compute a valid tag no matter what content they write.
 *
 * The tag is stored BESIDE the record (vaultStore.ts keeps it in a separate
 * SecureStore item, never inside the VaultMeta/EnrollmentDraft JSON itself)
 * and re-verified before that record is ever trusted as authority: before
 * any output-creating operation uses `meta.keys`/`meta.revision`
 * (transfers.ts's `requireAuthenticatedMeta`), and before
 * `requireReadyEnrollmentDrafts`/`resumeEnrollmentDraft` trust a `ready`
 * draft (VaultKeyService.ts).
 *
 * WHY THESE FIELDS AND NOT OTHERS. The tagged meta payload is exactly
 * `vaultId`, `revision`, `createdAt`, the ordered key list (serial/slot/
 * pubkey) and `pendingRemoval` — the fields `newVaultOutput` bakes into a
 * new R1C lock, or that gate a two-phase key removal. Cosmetic/local-only
 * fields (`nickname`, `enrolledAt`, `lastUsedAt`/`lastUsedSerial`,
 * `recovery.adoptedSerials`) are deliberately EXCLUDED: they never feed a
 * new output's lock, and including them would force a fresh tag on every
 * rename/last-use/adoption write in addition to every revision-bumping one,
 * without closing any additional attack surface (see vaultStore.ts's
 * markKeyAdopted/noteLastUsed/renameKey for where this matters).
 */
import type { WalletInterface } from '@bsv/sdk'
import type { VaultKeyRecord, VaultMeta, VaultPendingRemoval, VaultStoreScope } from './vaultStore'

/** Reserved in core/services/vault/guard.ts's VAULT_PROTOCOL_NAMES so a
 * connected/paired caller can never mint or verify this tag itself. */
export const VAULT_META_PROTOCOL_ID = [2, 'vault meta'] as const

/** The narrow wallet surface this module needs — matches
 * connectionAuthority.ts's HmacCapableWallet. Real callers pass the
 * ADMIN-scoped wallet (guardVaultAccess(..., adminOriginator)), and must call
 * with `adminOriginator` so guard.ts's reservation recognizes the call as
 * trusted rather than refusing it. */
export type HmacCapableWallet = Pick<WalletInterface, 'createHmac' | 'verifyHmac'>

type TaggedMetaFields = Pick<VaultMeta, 'vaultId' | 'revision' | 'createdAt' | 'keys' | 'pendingRemoval'>

function canonicalKeyFields(k: Pick<VaultKeyRecord, 'serial' | 'slot' | 'pubkey'>) {
  return { serial: k.serial, slot: k.slot, pubkey: k.pubkey }
}

function canonicalPendingRemoval(p: VaultPendingRemoval | undefined) {
  if (!p) return null
  return { key: canonicalKeyFields(p.key), keyIndex: p.keyIndex, revision: p.revision, state: p.state }
}

function bytesOf(payload: unknown): number[] {
  return Array.from(new TextEncoder().encode(JSON.stringify(payload)))
}

/** Canonical, versioned message for a VaultMeta's authority fields. */
function vaultMetaAuthorityMessage(meta: TaggedMetaFields, scope: VaultStoreScope): number[] {
  return bytesOf({
    v: 1,
    kind: 'vault-meta',
    identityKey: scope.identityKey,
    chain: scope.chain,
    vaultId: meta.vaultId,
    revision: meta.revision,
    createdAt: meta.createdAt,
    keys: meta.keys.map(canonicalKeyFields),
    pendingRemoval: canonicalPendingRemoval(meta.pendingRemoval)
  })
}

function metaKeyId(scope: VaultStoreScope): string {
  return `${scope.chain}:meta`
}

/** Called by every legitimate meta-writing path immediately before its
 * SecureStore write (see vaultStore.ts's `VaultMetaTagger`). */
export async function computeVaultMetaAuthorityTag(
  wallet: HmacCapableWallet,
  adminOriginator: string,
  meta: TaggedMetaFields,
  scope: VaultStoreScope
): Promise<string> {
  const { hmac } = await wallet.createHmac(
    {
      protocolID: [...VAULT_META_PROTOCOL_ID],
      keyID: metaKeyId(scope),
      counterparty: 'self',
      data: vaultMetaAuthorityMessage(meta, scope)
    },
    adminOriginator
  )
  return Buffer.from(hmac).toString('base64url')
}

/**
 * Re-derives the tag over the CURRENT (possibly tampered) meta and compares
 * it to the one on file. Never throws: a missing tag, a malformed tag, a
 * mismatched meta, or any wallet-side failure are all indistinguishable
 * "not authentic" outcomes — the caller must fail closed on every one of
 * them, never distinguish "corrupt tag" from "wrong tag" for the user.
 */
export async function verifyVaultMetaAuthorityTag(
  wallet: HmacCapableWallet,
  adminOriginator: string,
  meta: TaggedMetaFields,
  scope: VaultStoreScope,
  tag: string | null | undefined
): Promise<boolean> {
  if (!tag) return false
  try {
    const hmac = Array.from(Buffer.from(tag, 'base64url'))
    if (hmac.length === 0) return false
    const { valid } = await wallet.verifyHmac(
      {
        protocolID: [...VAULT_META_PROTOCOL_ID],
        keyID: metaKeyId(scope),
        counterparty: 'self',
        data: vaultMetaAuthorityMessage(meta, scope),
        hmac
      },
      adminOriginator
    )
    return valid === true
  } catch {
    return false
  }
}

/** Canonical, versioned message for one enrollment draft record's `ready`
 * authority — the sole assurance level a commit path (finalizeEnrollment /
 * addVaultKey via requireReadyEnrollmentDrafts, or resumeEnrollmentDraft's
 * fast path) ever trusts without repeating a live driver challenge. Lower
 * assurance levels ('management-uncertain', 'challenge-required') are never
 * tagged: every code path that reads them already requires a fresh
 * driver.signEcdsa challenge before doing anything with them, so a forged
 * draft at those levels gains nothing. */
function vaultDraftAuthorityMessage(record: Pick<VaultKeyRecord, 'serial' | 'slot' | 'pubkey'>, scope: VaultStoreScope): number[] {
  return bytesOf({
    v: 1,
    kind: 'vault-enrollment-draft',
    identityKey: scope.identityKey,
    chain: scope.chain,
    assurance: 'ready',
    record: canonicalKeyFields(record)
  })
}

function draftKeyId(scope: VaultStoreScope, serial: string): string {
  return `${scope.chain}:draft:${serial}`
}

export async function computeVaultDraftAuthorityTag(
  wallet: HmacCapableWallet,
  adminOriginator: string,
  record: Pick<VaultKeyRecord, 'serial' | 'slot' | 'pubkey'>,
  scope: VaultStoreScope
): Promise<string> {
  const { hmac } = await wallet.createHmac(
    {
      protocolID: [...VAULT_META_PROTOCOL_ID],
      keyID: draftKeyId(scope, record.serial),
      counterparty: 'self',
      data: vaultDraftAuthorityMessage(record, scope)
    },
    adminOriginator
  )
  return Buffer.from(hmac).toString('base64url')
}

export async function verifyVaultDraftAuthorityTag(
  wallet: HmacCapableWallet,
  adminOriginator: string,
  record: Pick<VaultKeyRecord, 'serial' | 'slot' | 'pubkey'>,
  scope: VaultStoreScope,
  tag: string | null | undefined
): Promise<boolean> {
  if (!tag) return false
  try {
    const hmac = Array.from(Buffer.from(tag, 'base64url'))
    if (hmac.length === 0) return false
    const { valid } = await wallet.verifyHmac(
      {
        protocolID: [...VAULT_META_PROTOCOL_ID],
        keyID: draftKeyId(scope, record.serial),
        counterparty: 'self',
        data: vaultDraftAuthorityMessage(record, scope),
        hmac
      },
      adminOriginator
    )
    return valid === true
  } catch {
    return false
  }
}
