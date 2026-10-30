// @ts-nocheck
import { Hash, Script, Utils, type WalletProtocol } from '@bsv/sdk'
import { createWalletClient } from '../wallet'

export const protocolID = [1, 'conformance'] as WalletProtocol
export const keyID = 'conformance probe'
export const message = 'conformance probe'
export const certifier = '03c644fe2fd97673a5d86555a58587e7936390be6582ece262bc387014bcff6fe4'
export const certifierUrl = 'https://certify.bsvb.tech'
export const verifier = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
export const basket = 'conformance'
// Distinct from the internet-plumbing certificate so this suite does not delete that credential.
export const certificateType = Utils.toBase64(Hash.sha256('conformance probe', 'utf8'))
export const probeLockingScript = Script.fromASM('OP_NOP').toHex()

export function conformanceWallet(originator?: string) {
  return createWalletClient(originator)
}

export function actionReference(created: {
  signableTransaction?: { reference?: string }
  txid?: string
}): string {
  const reference = created.signableTransaction?.reference ?? created.txid
  if (!reference) {
    throw new Error('createAction returned neither a reference nor a txid to abort')
  }
  return reference
}
