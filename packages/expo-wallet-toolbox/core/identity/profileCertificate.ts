/**
 * Publishing your own display name.
 *
 * Unlike a handle (`handleCertificate.ts`), a display name needs no
 * third-party uniqueness check — anyone may call themselves anything, the
 * same way a chat app lets you set a display name with no verification.
 * So this is a SELF-certified certificate: this wallet issues and signs it as
 * certifier (its own identity key, no certifier URL), then stores it with
 * `acquisitionProtocol: 'direct'`. 'direct' is NOT "issue it for me": the SDK
 * validator requires serialNumber, signature, revocationOutpoint and the
 * subject keyring up front — the first version passed none and every save
 * failed with "The serialNumber parameter must be valid when
 * acquisitionProtocol is \"direct\"". This is a
 * genuinely new publishing path for this app — nothing here reused an
 * existing certificate flow, because grep found no prior `acquireCertificate`
 * call anywhere in the codebase. Whether the deployed `tm_identity` overlay
 * actually indexes a self-certified attribute for search is a fact about that
 * overlay's admission rules this package cannot verify; if it does not, the
 * publish still succeeds (the certificate exists and is revealed) but a peer
 * searching by name may not find it until the overlay side is confirmed.
 */
import { MasterCertificate } from '@bsv/sdk'
import type { AcquisitionProtocol, Base64String, HexString, WalletCertificate, WalletInterface } from '@bsv/sdk'
import type { IdentityClient } from '@bsv/sdk'

/** This app's certificate type id for a self-asserted `displayName` field. */
export const DISPLAY_NAME_CERT_TYPE = 'Rk3vQZzXk8yqjO1nEwq2m1dO5o2r9z1p3s5t7u9w0x0='

/**
 * "Never revoked". The SDK's own default for `issueCertificateForSubject` is
 * `'00'.repeat(32)` with no output index, which `validateOutpointString`
 * rejects; the direct-acquire validator needs `txid.vout`.
 */
export const NO_REVOCATION_OUTPOINT = `${'00'.repeat(32)}.0`

/**
 * What self-issuance needs from the wallet. `acquisitionProtocol: 'direct'`
 * means "here is a certificate somebody already issued and signed, store it":
 * the SDK validator refuses it without `serialNumber`, `signature`,
 * `revocationOutpoint`, `keyringRevealer` and `keyringForSubject`. Since this
 * wallet IS the certifier, it has to produce all of those itself first —
 * encrypt the field, wrap the field key for the subject (also itself), and
 * sign the certificate — which is what `getPublicKey`/`encrypt`/`createSignature`
 * are for.
 */
export interface ProfileCertWallet {
  getPublicKey(args: { identityKey: true }, originator?: string): Promise<{ publicKey: string }>
  encrypt(args: Parameters<WalletInterface['encrypt']>[0], originator?: string): Promise<{ ciphertext: number[] }>
  createSignature(
    args: Parameters<WalletInterface['createSignature']>[0],
    originator?: string
  ): Promise<{ signature: number[] }>
  acquireCertificate(
    args: {
      type: string
      certifier: string
      acquisitionProtocol: AcquisitionProtocol
      fields: Record<string, string>
      serialNumber?: Base64String
      revocationOutpoint?: string
      signature?: HexString
      keyringRevealer?: 'certifier' | string
      keyringForSubject?: Record<string, Base64String>
    },
    originator?: string
  ): Promise<WalletCertificate>
}

export type PublishDisplayNameResult = { kind: 'published' } | { kind: 'failed'; message: string }

/**
 * The SDK's certificate helpers call wallet methods with no originator.
 * Through WalletPermissionsManager that would be a call from nowhere; bind the
 * admin originator so the encrypt/sign steps run as this app, not as a prompt.
 */
function asCertifierWallet(wallet: ProfileCertWallet, originator?: string): WalletInterface {
  return {
    getPublicKey: (args: Parameters<WalletInterface['getPublicKey']>[0]) =>
      wallet.getPublicKey(args as { identityKey: true }, originator),
    encrypt: (args: Parameters<WalletInterface['encrypt']>[0]) => wallet.encrypt(args, originator),
    createSignature: (args: Parameters<WalletInterface['createSignature']>[0]) =>
      wallet.createSignature(args, originator)
  } as unknown as WalletInterface
}

export async function publishDisplayName(args: {
  wallet: ProfileCertWallet
  idClient: IdentityClient
  adminOriginator?: string
  displayName: string
}): Promise<PublishDisplayNameResult> {
  const { wallet, idClient, adminOriginator, displayName } = args
  const trimmed = displayName.trim()
  if (trimmed === '') return { kind: 'failed', message: 'Display name cannot be empty' }
  try {
    // Issue to 'self': the field key is wrapped for our own identity key, which
    // is exactly the counterparty proveCertificate later unwraps it with (the
    // certifier — also us). Then hand the finished, signed certificate to the
    // wallet to keep.
    const master = await MasterCertificate.issueCertificateForSubject(
      asCertifierWallet(wallet, adminOriginator),
      'self',
      { displayName: trimmed },
      DISPLAY_NAME_CERT_TYPE,
      async () => NO_REVOCATION_OUTPOINT
    )
    const cert = await wallet.acquireCertificate(
      {
        type: master.type,
        certifier: master.certifier,
        acquisitionProtocol: 'direct',
        fields: master.fields,
        serialNumber: master.serialNumber,
        revocationOutpoint: master.revocationOutpoint,
        signature: master.signature,
        keyringRevealer: 'certifier',
        keyringForSubject: master.masterKeyring
      },
      adminOriginator
    )
    await idClient.publiclyRevealAttributes(cert, ['displayName'])
    return { kind: 'published' }
  } catch (e) {
    return { kind: 'failed', message: e instanceof Error ? e.message : String(e) }
  }
}
