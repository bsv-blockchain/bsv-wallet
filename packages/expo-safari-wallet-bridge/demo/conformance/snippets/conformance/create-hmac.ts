// @ts-nocheck
import { Utils } from '@bsv/sdk'
import { conformanceWallet, keyID, message, protocolID } from './support'

export async function conformanceCreateHmac(runner) {
  const wallet = conformanceWallet()
  const hmac = await wallet.createHmac({
    data: Utils.toArray(message, 'utf8'),
    protocolID,
    keyID,
    counterparty: 'self'
  })
  if (hmac.hmac.length !== 32) {
    throw new Error('createHmac did not return 32 bytes')
  }
  runner.log({ hmacBytes: hmac.hmac.length })
}
