// @ts-nocheck
import { conformanceWallet } from './support'

export async function conformanceListOutputs(runner) {
  const wallet = conformanceWallet()
  const listed = await wallet.listOutputs({
    basket: 'random',
    limit: 5,
    include: 'locking scripts'
  })
  if (!Number.isInteger(listed.totalOutputs) || listed.totalOutputs < 0) {
    throw new Error('listOutputs did not return a total')
  }
  if (!Array.isArray(listed.outputs)) {
    throw new Error('listOutputs did not return an outputs array')
  }
  runner.log({ totalOutputs: listed.totalOutputs, returned: listed.outputs.length })
}
