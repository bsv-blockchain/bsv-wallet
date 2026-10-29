// @ts-nocheck
import { certificateType, certifier, conformanceWallet } from './support'

export async function conformanceListCertificates(runner) {
  const wallet = conformanceWallet('deggen')
  const listed = await wallet.listCertificates({
    certifiers: [certifier],
    types: [certificateType],
    limit: 5
  })
  if (!Number.isInteger(listed.totalCertificates) || !Array.isArray(listed.certificates)) {
    throw new Error('listCertificates did not return a certificate list')
  }
  runner.log({ totalCertificates: listed.totalCertificates, returned: listed.certificates.length })
}
