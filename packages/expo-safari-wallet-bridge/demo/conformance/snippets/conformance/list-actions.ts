// @ts-nocheck
import { conformanceWallet } from './support'

export async function conformanceListActions(runner) {
  const wallet = conformanceWallet()
  const listed = await wallet.listActions({
    labels: ['conformance'],
    labelQueryMode: 'any',
    includeLabels: true,
    limit: 5
  })
  if (!Number.isInteger(listed.totalActions) || !Array.isArray(listed.actions)) {
    throw new Error('listActions did not return an action list')
  }
  runner.log({ totalActions: listed.totalActions, returned: listed.actions.length })
}
