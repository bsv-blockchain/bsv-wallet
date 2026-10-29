// @ts-nocheck
import { PrivateKey } from '@bsv/sdk'
import { conformanceWallet } from './support'

export async function conformanceRevealCounterpartyKeyLinkage(runner) {
  const wallet = conformanceWallet()
  const verifier = PrivateKey.fromHex('11'.repeat(32)).toPublicKey().toDER('hex') as string
  const counterparty = PrivateKey.fromHex('22'.repeat(32)).toPublicKey().toDER('hex') as string

  const linkage = await wallet.revealCounterpartyKeyLinkage({ counterparty, verifier })
  if (linkage.verifier.toLowerCase() !== verifier.toLowerCase()) {
    throw new Error('revealCounterpartyKeyLinkage returned a different verifier')
  }
  if (linkage.counterparty.toLowerCase() !== counterparty.toLowerCase()) {
    throw new Error('revealCounterpartyKeyLinkage returned a different counterparty')
  }

  runner.log({
    prover: linkage.prover,
    verifier: linkage.verifier,
    counterparty: linkage.counterparty,
    revelationTime: linkage.revelationTime
  })
}
