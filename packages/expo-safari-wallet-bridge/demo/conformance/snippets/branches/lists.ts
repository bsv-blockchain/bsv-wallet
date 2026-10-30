// @ts-nocheck
import { Beef, type ListActionsArgs, type ListOutputsArgs, type WalletInterface } from '@bsv/sdk'
import { ProbeSkipped, type SnippetRunner } from '../../lib/snippet-runner'
import { check, reliabilityWallet } from '../reliability/support'
import { booleans, freshID, runCases, type BranchCase } from './support'

export const branchBasket = 'fast branch fixtures'
export const branchLabel = 'fast branches'
export const branchTags = ['fast branch fixture', 'fast branch tagged']
export const branchInstructions = 'fast branch fixture instructions'

export function actionQueries(): ListActionsArgs[] {
  const queries: ListActionsArgs[] = []
  for (const labelQueryMode of ['any', 'all'] as const) for (const includeLabels of booleans) {
    for (const includeInputs of booleans) for (const source of includeInputs ? booleans : [false]) {
      for (const unlocking of includeInputs ? booleans : [false]) for (const includeOutputs of booleans) {
        for (const locking of includeOutputs ? booleans : [false]) {
          queries.push({ labels: [branchLabel], labelQueryMode, includeLabels, includeInputs, includeInputSourceLockingScripts: source, includeInputUnlockingScripts: unlocking, includeOutputs, includeOutputLockingScripts: locking, limit: 2, offset: 0 })
        }
      }
    }
  }
  queries.push({ labels: [], limit: 1, offset: 0 }, { labels: [branchLabel], limit: 10000, offset: 0 }, { labels: [branchLabel], limit: 1, offset: 1 })
  for (const seekPermission of booleans) queries.push({ labels: [branchLabel], limit: 1, seekPermission })
  const missingLabel = `fast absent ${freshID()}`
  for (const labelQueryMode of ['any', 'all'] as const) queries.push({ labels: [branchLabel, missingLabel], labelQueryMode, includeLabels: true, limit: 2 })
  return queries
}

export function outputQueries(basket = branchBasket): ListOutputsArgs[] {
  const queries: ListOutputsArgs[] = []
  for (const include of [undefined, 'locking scripts', 'entire transactions'] as const) {
    for (const includeCustomInstructions of booleans) {
      for (const includeTags of booleans) for (const includeLabels of booleans) for (const tagQueryMode of ['any', 'all'] as const) {
        queries.push({ basket, include, includeCustomInstructions, includeTags, includeLabels, tags: branchTags, tagQueryMode, limit: 2, offset: 0 })
      }
    }
  }
  queries.push({ basket, limit: 1, offset: -1 }, { basket, limit: 10000, offset: 0 }, { basket, tags: [], limit: 1, offset: 1 })
  for (const seekPermission of booleans) queries.push({ basket, tags: branchTags, limit: 1, seekPermission })
  const missingTag = `fast absent ${freshID()}`
  for (const tagQueryMode of ['any', 'all'] as const) queries.push({ basket, tags: [branchTags[0], missingTag], tagQueryMode, includeTags: true, limit: 2 })
  return queries
}

export async function branchActionLists(runner: SnippetRunner, wallet: WalletInterface = reliabilityWallet()) {
  const cases = actionQueries().map((args, index): BranchCase => ({ id: `listActions/options-${index}`, run: async () => {
    const result = await wallet.listActions(args)
    check(result.actions.length <= args.limit && result.totalActions >= result.actions.length, 'Action page exceeds limit or total')
    if (args.labels.length === 2 && args.labelQueryMode === 'all') {
      check(result.totalActions === 0 && result.actions.length === 0, 'All-label query returned an action without the absent label')
      return
    }
    if (result.actions.length === 0) throw new ProbeSkipped('No matching actions. Run a funded workflow first.')
    for (const action of result.actions) {
      if (args.includeLabels) check(Array.isArray(action.labels) && (args.labelQueryMode === 'any' ? args.labels.some(label => action.labels.includes(label)) : args.labels.every(label => action.labels.includes(label))), 'Requested action labels missing')
      if (args.includeInputs) {
        check(Array.isArray(action.inputs), 'Requested action inputs missing')
        for (const input of action.inputs) {
          if (args.includeInputSourceLockingScripts) check(typeof input.sourceLockingScript === 'string', 'Source locking script missing')
          if (args.includeInputUnlockingScripts) check(typeof input.unlockingScript === 'string', 'Input unlocking script missing')
        }
      }
      if (args.includeOutputs) {
        check(Array.isArray(action.outputs), 'Requested action outputs missing')
        for (const output of action.outputs) if (args.includeOutputLockingScripts) check(typeof output.lockingScript === 'string', 'Output locking script missing')
      }
    }
  } }))
  await runCases(runner, cases)
}

export async function branchOutputLists(runner: SnippetRunner, wallet: WalletInterface = reliabilityWallet()) {
  const cases = outputQueries().map((args, index): BranchCase => ({ id: `listOutputs/options-${index}`, run: async () => {
    const result = await wallet.listOutputs(args)
    check(result.outputs.length <= args.limit && result.totalOutputs >= result.outputs.length, 'Output page exceeds limit or total')
    if (args.tags?.some(tag => tag.startsWith('fast absent ')) && args.tagQueryMode === 'all') {
      check(result.totalOutputs === 0 && result.outputs.length === 0, 'All-tag query returned an output without the absent tag')
      return
    }
    if (result.outputs.length === 0) throw new ProbeSkipped('No matching outputs. Run the broadcast option matrix first.')
    const withTransactions = args.include === 'entire transactions'
    const beef = withTransactions && result.BEEF ? Beef.fromBinary(result.BEEF) : undefined
    if (withTransactions) check(beef != null, 'Requested aggregate BEEF missing')
    for (const output of result.outputs) {
      if (args.include === 'locking scripts') check(typeof output.lockingScript === 'string', 'Requested locking script missing')
      if (args.includeTags) check(Array.isArray(output.tags) && (args.tags.length === 0 || (args.tagQueryMode === 'all' ? args.tags.every(tag => output.tags.includes(tag)) : args.tags.some(tag => output.tags.includes(tag)))), 'Tag query evidence missing')
      if (args.includeLabels) check(Array.isArray(output.labels) && output.labels.includes(branchLabel), 'Requested output labels missing')
      if (args.includeCustomInstructions) check(output.customInstructions === branchInstructions, 'Fixture custom instructions changed or omitted')
      if (beef) {
        const [txid, index] = output.outpoint.split('.')
        const tx = beef.findTxid(txid)?.tx
        check(tx != null && tx.outputs[Number(index)]?.satoshis === output.satoshis, 'BEEF does not contain the listed output')
      }
    }
  } }))
  await runCases(runner, cases)
}
