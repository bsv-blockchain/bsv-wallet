// @ts-nocheck
import { actionReference, conformanceWallet, probeLockingScript } from './support'

export async function conformanceCreateAction(runner) {
  const wallet = conformanceWallet()
  // noSend keeps the probe off the network. abortAction releases the inputs.
  const created = await wallet.createAction({
    description: 'conformance create action',
    labels: ['conformance'],
    outputs: [{
      satoshis: 1,
      lockingScript: probeLockingScript,
      outputDescription: 'conformance probe output'
    }],
    options: {
      noSend: true,
      acceptDelayedBroadcast: false
    }
  })
  if (created.tx == null && created.signableTransaction == null && created.txid == null) {
    throw new Error('createAction returned no transaction, reference, or txid')
  }

  const reference = actionReference(created)
  const aborted = await wallet.abortAction({ reference })
  if (aborted.aborted !== true) {
    throw new Error('abortAction did not release the no-send action')
  }
  runner.log({ txid: created.txid, reference, aborted: true })
}
