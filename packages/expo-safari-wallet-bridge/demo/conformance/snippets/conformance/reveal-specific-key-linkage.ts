// @ts-nocheck
import { PrivateKey } from '@bsv/sdk'
import { conformanceWallet, keyID, protocolID } from './support'

export async function conformanceRevealSpecificKeyLinkage(runner) {
  const wallet = conformanceWallet()
  const verifier = PrivateKey.fromHex('11'.repeat(32)).toPublicKey().toDER('hex') as string

  const linkage = await wallet.revealSpecificKeyLinkage({
    counterparty: 'self',
    verifier,
    protocolID,
    keyID
  })
  if (linkage.verifier.toLowerCase() !== verifier.toLowerCase()) {
    throw new Error('revealSpecificKeyLinkage returned a different verifier')
  }
  if (linkage.protocolID[0] !== protocolID[0] || linkage.protocolID[1] !== protocolID[1]) {
    throw new Error('revealSpecificKeyLinkage returned a different protocol')
  }
  if (linkage.keyID !== keyID) {
    throw new Error('revealSpecificKeyLinkage returned a different key ID')
  }

  runner.log({
    prover: linkage.prover,
    counterparty: linkage.counterparty,
    protocolID: linkage.protocolID,
    keyID: linkage.keyID,
    proofType: linkage.proofType
  })
}
