// @ts-nocheck
import { basket, conformanceWallet, probeLockingScript } from './support'

export async function conformanceRelinquishOutput(runner) {
  const wallet = conformanceWallet()
  // Broadcasts 1 satoshi into the conformance basket, then stops tracking it.
  const created = await wallet.createAction({
    description: 'conformance basket output',
    labels: ['conformance'],
    outputs: [{
      satoshis: 1,
      lockingScript: probeLockingScript,
      outputDescription: 'conformance basket output',
      basket
    }],
    options: {
      acceptDelayedBroadcast: false,
      randomizeOutputs: false
    }
  })
  if (!created.txid) throw new Error('createAction did not return a txid')

  const listed = await wallet.listOutputs({ basket, limit: 10 })
  const output = listed.outputs.find(item => item.outpoint.startsWith(`${created.txid}.`))
  if (!output) throw new Error('The probe output was not in the conformance basket')

  const relinquished = await wallet.relinquishOutput({ basket, output: output.outpoint })
  if (relinquished.relinquished !== true) {
    throw new Error('relinquishOutput did not relinquish the probe output')
  }
  runner.log({ outpoint: output.outpoint, relinquished: true })
}
