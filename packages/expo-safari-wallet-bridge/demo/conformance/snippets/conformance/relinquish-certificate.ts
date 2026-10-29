// @ts-nocheck
import { certificateType, certifier, certifierUrl, conformanceWallet } from './support'

export async function conformanceRelinquishCertificate(runner) {
  const wallet = conformanceWallet('deggen')
  const list = () => wallet.listCertificates({
    certifiers: [certifier],
    types: [certificateType],
    limit: 5
  })

  let listed = await list()
  if (!listed.certificates[0]) {
    await wallet.acquireCertificate({
      type: certificateType,
      acquisitionProtocol: 'issuance',
      certifier,
      certifierUrl,
      fields: { probe: 'conformance' }
    })
    listed = await list()
  }
  const certificate = listed.certificates[0]
  if (!certificate) {
    throw new Error('No conformance certificate was available to relinquish')
  }

  const relinquished = await wallet.relinquishCertificate({
    type: certificate.type,
    serialNumber: certificate.serialNumber,
    certifier: certificate.certifier
  })
  if (relinquished.relinquished !== true) {
    throw new Error('relinquishCertificate did not relinquish the conformance certificate')
  }
  runner.log({ serialNumber: certificate.serialNumber, relinquished: true })
}
