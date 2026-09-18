/**
 * Publishing your own display name.
 *
 * Unlike a handle (`handleCertificate.ts`), a display name needs no
 * third-party uniqueness check — anyone may call themselves anything, the
 * same way a chat app lets you set a display name with no verification.
 * So this is a SELF-certified certificate: `acquisitionProtocol: 'direct'`,
 * `certifier` is this wallet's own identity key, no certifier URL. This is a
 * genuinely new publishing path for this app — nothing here reused an
 * existing certificate flow, because grep found no prior `acquireCertificate`
 * call anywhere in the codebase. Whether the deployed `tm_identity` overlay
 * actually indexes a self-certified attribute for search is a fact about that
 * overlay's admission rules this package cannot verify; if it does not, the
 * publish still succeeds (the certificate exists and is revealed) but a peer
 * searching by name may not find it until the overlay side is confirmed.
 */
import type { AcquisitionProtocol, WalletCertificate } from '@bsv/sdk'
import type { IdentityClient } from '@bsv/sdk'

/** This app's certificate type id for a self-asserted `displayName` field. */
export const DISPLAY_NAME_CERT_TYPE = 'Rk3vQZzXk8yqjO1nEwq2m1dO5o2r9z1p3s5t7u9w0x0='

export interface ProfileCertWallet {
  getPublicKey(args: { identityKey: true }, originator?: string): Promise<{ publicKey: string }>
  acquireCertificate(
    args: {
      type: string
      certifier: string
      acquisitionProtocol: AcquisitionProtocol
      fields: Record<string, string>
    },
    originator?: string
  ): Promise<WalletCertificate>
}

export type PublishDisplayNameResult = { kind: 'published' } | { kind: 'failed'; message: string }

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
    const { publicKey } = await wallet.getPublicKey({ identityKey: true }, adminOriginator)
    const cert = await wallet.acquireCertificate(
      {
        type: DISPLAY_NAME_CERT_TYPE,
        certifier: publicKey,
        acquisitionProtocol: 'direct',
        fields: { displayName: trimmed }
      },
      adminOriginator
    )
    await idClient.publiclyRevealAttributes(cert, ['displayName'])
    return { kind: 'published' }
  } catch (e) {
    return { kind: 'failed', message: e instanceof Error ? e.message : String(e) }
  }
}
