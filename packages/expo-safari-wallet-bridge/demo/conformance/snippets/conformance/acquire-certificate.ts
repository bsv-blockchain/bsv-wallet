// @ts-nocheck
import { certificateType, certifier, certifierUrl, conformanceWallet } from './support'

export async function conformanceAcquireCertificate(runner) {
  const wallet = conformanceWallet('deggen')
  const certificate = await wallet.acquireCertificate({
    type: certificateType,
    acquisitionProtocol: 'issuance',
    certifier,
    certifierUrl,
    fields: { probe: 'conformance' }
  })
  if (certificate.type !== certificateType || !certificate.serialNumber) {
    throw new Error('acquireCertificate did not return the conformance certificate')
  }
  runner.log({
    type: certificate.type,
    serialNumber: certificate.serialNumber,
    certifier: certificate.certifier
  })
}
