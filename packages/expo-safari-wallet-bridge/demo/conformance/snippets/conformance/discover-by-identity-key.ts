// @ts-nocheck
import { conformanceWallet } from './support'

export async function conformanceDiscoverByIdentityKey(runner) {
  const wallet = conformanceWallet()
  const { publicKey } = await wallet.getPublicKey({ identityKey: true })
  const discovered = await wallet.discoverByIdentityKey({
    identityKey: publicKey,
    limit: 5
  })
  if (!Number.isInteger(discovered.totalCertificates) || !Array.isArray(discovered.certificates)) {
    throw new Error('discoverByIdentityKey did not return a certificate list')
  }
  runner.log({ identityKey: publicKey, totalCertificates: discovered.totalCertificates })
}
