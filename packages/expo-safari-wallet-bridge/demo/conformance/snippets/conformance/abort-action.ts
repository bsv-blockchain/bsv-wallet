// @ts-nocheck
import { actionReference, conformanceWallet, probeLockingScript } from './support'

export async function conformanceAbortAction(runner) {
  const wallet = conformanceWallet()
  const created = await wallet.createAction({
    description: 'conformance abort action',
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
  const aborted = await wallet.abortAction({ reference: actionReference(created) })
  if (aborted.aborted !== true) {
    throw new Error('abortAction did not release the no-send action')
  }
  runner.log({ aborted: true })
}
