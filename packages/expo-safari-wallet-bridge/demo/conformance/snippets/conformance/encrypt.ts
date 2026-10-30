// @ts-nocheck
import { Utils } from '@bsv/sdk'
import { conformanceWallet, keyID, message, protocolID } from './support'

export async function conformanceEncrypt(runner) {
  const wallet = conformanceWallet()
  const encrypted = await wallet.encrypt({
    plaintext: Utils.toArray(message, 'utf8'),
    protocolID,
    keyID,
    counterparty: 'self'
  })
  if (!encrypted.ciphertext || encrypted.ciphertext.length === 0) {
    throw new Error('encrypt did not return ciphertext')
  }
  runner.log({ ciphertextBytes: encrypted.ciphertext.length })
}
