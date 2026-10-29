// @ts-nocheck
import { conformanceWallet, probeLockingScript } from './support'

export async function conformanceSignAction(runner) {
  const wallet = conformanceWallet()
  // signAndProcess false asks for a signable reference. noSend avoids a broadcast.
  const created = await wallet.createAction({
    description: 'conformance sign action',
    labels: ['conformance'],
    outputs: [{
      satoshis: 1,
      lockingScript: probeLockingScript,
      outputDescription: 'conformance probe output'
    }],
    options: {
      signAndProcess: false,
      noSend: true,
      acceptDelayedBroadcast: false
    }
  })
  const reference = created.signableTransaction?.reference
  if (!reference) {
    throw new Error('createAction did not return a signableTransaction reference')
  }

  const signed = await wallet.signAction({
    reference,
    spends: {},
    options: {
      noSend: true,
      acceptDelayedBroadcast: false
    }
  })
  if (signed.txid == null && signed.tx == null) {
    throw new Error('signAction returned neither a txid nor a transaction')
  }

  const aborted = await wallet.abortAction({ reference })
  if (aborted.aborted !== true) {
    throw new Error('abortAction did not release the signed no-send action')
  }
  runner.log({ txid: signed.txid, aborted: true })
}
