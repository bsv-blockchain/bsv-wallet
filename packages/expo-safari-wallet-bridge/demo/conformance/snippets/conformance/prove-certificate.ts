// @ts-nocheck
import { certificateType, certifier, conformanceWallet, verifier } from './support'

export async function conformanceProveCertificate(runner) {
  const wallet = conformanceWallet('deggen')
  const listed = await wallet.listCertificates({
    certifiers: [certifier],
    types: [certificateType],
    limit: 5
  })
  const certificate = listed.certificates[0]
  if (!certificate) {
    throw new Error('No conformance certificate to prove. Run acquireCertificate first.')
  }
  const fieldName = Object.keys(certificate.fields)[0] ?? 'probe'
  const proof = await wallet.proveCertificate({
    certificate: {
      type: certificate.type,
      serialNumber: certificate.serialNumber,
      certifier: certificate.certifier,
      subject: certificate.subject,
      revocationOutpoint: certificate.revocationOutpoint,
      signature: certificate.signature,
      fields: certificate.fields
    },
    fieldsToReveal: [fieldName],
    verifier
  })
  if (!Object.prototype.hasOwnProperty.call(proof.keyringForVerifier, fieldName)) {
    throw new Error('proveCertificate did not reveal the requested field')
  }
  runner.log({ provedField: fieldName })
}
