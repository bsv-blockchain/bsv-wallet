// @ts-nocheck
import { Utils } from '@bsv/sdk'
import { conformanceWallet, keyID, message, protocolID } from './support'

export async function conformanceVerifySignature(runner) {
  const wallet = conformanceWallet()
  const data = Utils.toArray(message, 'utf8')
  const signed = await wallet.createSignature({ data, protocolID, keyID, counterparty: 'self' })
  const signatureCheck = await wallet.verifySignature({
    data,
    signature: signed.signature,
    protocolID,
    keyID,
    counterparty: 'self',
    forSelf: true
  })
  if (signatureCheck.valid !== true) {
    throw new Error('verifySignature rejected a freshly created signature')
  }
  runner.log({ valid: true })
}
