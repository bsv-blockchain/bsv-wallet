// @ts-nocheck
import { conformanceWallet } from './support'

export async function conformanceDiscoverByAttributes(runner) {
  const wallet = conformanceWallet()
  const discovered = await wallet.discoverByAttributes({
    attributes: { userName: 'deggen' },
    limit: 5
  })
  if (!Number.isInteger(discovered.totalCertificates) || !Array.isArray(discovered.certificates)) {
    throw new Error('discoverByAttributes did not return a certificate list')
  }
  runner.log({ totalCertificates: discovered.totalCertificates })
}
