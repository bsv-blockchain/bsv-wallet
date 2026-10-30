// @ts-nocheck
import { Script, Transaction, type CreateActionResult, type WalletInterface } from '@bsv/sdk'
import type { SnippetRunner } from '../../lib/snippet-runner'
import { check, reliabilityWallet } from '../reliability/support'
import { branchBasket, branchInstructions, branchLabel, branchTags } from './lists'
import { booleans, runCases, type BranchCase } from './support'

// One satoshi per output, intentionally anyone-can-spend test fixtures.
const lockingScript = Script.fromASM('OP_TRUE').toHex()
const output = () => ({ satoshis: 1, lockingScript, outputDescription: 'fast branch fixture output', basket: branchBasket, tags: branchTags, customInstructions: branchInstructions })

function reference(created: CreateActionResult) {
  const ref = created.signableTransaction?.reference ?? created.txid
  check(typeof ref === 'string' && ref.length > 0, 'Action returned no reference to clean up')
  return ref
}

async function abortAll(wallet: WalletInterface, refs: string[]) {
  const failures: string[] = []
  for (const ref of [...refs].reverse()) {
    try { check((await wallet.abortAction({ reference: ref })).aborted === true, 'Wallet refused to abort an unsent fixture') }
    catch (error) { failures.push(error instanceof Error ? error.message : String(error)) }
  }
  check(failures.length === 0, `Unsent-action cleanup failed: ${failures.join('; ')}`)
}

export async function branchNoSendActions(runner: SnippetRunner, wallet: WalletInterface = reliabilityWallet()) {
  const cases: BranchCase[] = []
  for (const signAndProcess of booleans) for (const returnTXIDOnly of booleans) {
    for (const randomizeOutputs of booleans) for (const acceptDelayedBroadcast of booleans) {
      cases.push({ id: `createSignAbort/noSend/sign-${signAndProcess}/txidOnly-${returnTXIDOnly}/randomize-${randomizeOutputs}/delayed-${acceptDelayedBroadcast}`, run: async () => {
        const refs: string[] = []
        try {
          const created = await wallet.createAction({ description: 'fast branch unsent action', labels: [branchLabel], version: 2, lockTime: 0, outputs: [output()], options: { noSend: true, signAndProcess, returnTXIDOnly, randomizeOutputs, acceptDelayedBroadcast } })
          refs.push(reference(created))
          if (!signAndProcess) {
            check(created.signableTransaction != null, 'Expected a signable transaction')
            const template = Transaction.fromAtomicBEEF(Array.from(created.signableTransaction.tx))
            check(template.outputs.some(item => item.lockingScript.toHex() === lockingScript && item.satoshis === 1), 'Signable fixture output missing')
          }
          const completed = signAndProcess ? created : await wallet.signAction({ reference: refs[0], spends: {}, options: { noSend: true, returnTXIDOnly, acceptDelayedBroadcast } })
          check(typeof completed.txid === 'string', 'Completed noSend action missing TXID')
          if (returnTXIDOnly) check(completed.tx == null, 'returnTXIDOnly returned transaction bytes')
          else check(completed.tx != null && Transaction.fromAtomicBEEF(Array.from(completed.tx)).id('hex') === completed.txid, 'Returned transaction does not match TXID')
        } finally { await abortAll(wallet, refs) }
      } })
    }
  }
  await runCases(runner, cases)
}

export async function branchBroadcastActions(runner: SnippetRunner, wallet: WalletInterface = reliabilityWallet()) {
  const cases: BranchCase[] = []
  for (const signAndProcess of booleans) for (const returnTXIDOnly of booleans) {
    for (const randomizeOutputs of booleans) for (const acceptDelayedBroadcast of booleans) {
      cases.push({ id: `broadcast/sign-${signAndProcess}/txidOnly-${returnTXIDOnly}/randomize-${randomizeOutputs}/delayed-${acceptDelayedBroadcast}`, run: async () => {
        let pending: string | undefined
        let broadcastAttempted = signAndProcess
        try {
          const created = await wallet.createAction({ description: 'fast branch broadcast fixture', labels: [branchLabel], version: 1, lockTime: 0, outputs: [output()], options: { signAndProcess, returnTXIDOnly, randomizeOutputs, acceptDelayedBroadcast } })
          if (!signAndProcess) pending = reference(created)
          broadcastAttempted = true
          const completed = signAndProcess ? created : await wallet.signAction({ reference: pending, spends: {}, options: { returnTXIDOnly, acceptDelayedBroadcast } })
          check(typeof completed.txid === 'string', 'Broadcast result missing TXID')
          if (returnTXIDOnly) check(completed.tx == null, 'TXID-only result includes bytes')
          else check(completed.tx != null && Transaction.fromAtomicBEEF(Array.from(completed.tx)).id('hex') === completed.txid, 'Broadcast result transaction mismatch')
          runner.log({ txid: completed.txid, delayed: acceptDelayedBroadcast, fixtureSatoshis: 1 })
        } finally {
          // A rejected network response can still have broadcast. Never release
          // inputs of an action once a broadcast attempt has been made.
          if (pending && !broadcastAttempted) await abortAll(wallet, [pending])
        }
      } })
    }
  }
  await runCases(runner, cases)
}

export async function branchSendWithBatches(runner: SnippetRunner, wallet: WalletInterface = reliabilityWallet()) {
  const cases: BranchCase[] = []
  for (const signFlush of booleans) for (const acceptDelayedBroadcast of booleans) {
    cases.push({ id: `sendWith/${signFlush ? 'signAction' : 'createAction'}/delayed-${acceptDelayedBroadcast}`, run: async () => {
      const refs: string[] = []
      let flushAttempted = false
      try {
        const first = await wallet.createAction({ description: 'fast branch batch parent', labels: [branchLabel], outputs: [output()], options: { noSend: true, randomizeOutputs: false } })
        refs.push(reference(first))
        check(typeof first.txid === 'string', 'Batch parent missing TXID')
        check(Array.isArray(first.noSendChange) && first.noSendChange.length > 0, 'Batch parent missing noSendChange')
        const second = await wallet.createAction({ description: 'fast branch batch child', labels: [branchLabel], outputs: [output()], options: { noSend: true, noSendChange: first.noSendChange, knownTxids: [first.txid], trustSelf: 'known', randomizeOutputs: false } })
        refs.push(reference(second))
        check(typeof second.txid === 'string', 'Batch child missing TXID')
        const sendWith = [first.txid, second.txid]
        let result: CreateActionResult
        if (signFlush) {
          const final = await wallet.createAction({ description: 'fast branch sign batch flush', labels: [branchLabel], outputs: [output()], options: { noSend: true, signAndProcess: false, noSendChange: second.noSendChange } })
          refs.push(reference(final))
          flushAttempted = true
          result = await wallet.signAction({ reference: refs[2], spends: {}, options: { sendWith, acceptDelayedBroadcast } })
        } else {
          flushAttempted = true
          result = await wallet.createAction({ description: 'fast branch send batch only', options: { sendWith, acceptDelayedBroadcast } })
        }
        check(Array.isArray(result.sendWithResults), 'Batch flush missing sendWithResults')
        for (const txid of sendWith) {
          const sent = result.sendWithResults.find(item => item.txid === txid)
          check(sent != null && sent.status !== 'failed', 'Batch member failed or was omitted')
        }
        runner.log({ batchedTransactions: signFlush ? 3 : 2, delayed: acceptDelayedBroadcast })
      } finally { if (!flushAttempted) await abortAll(wallet, refs) }
    } })
  }
  await runCases(runner, cases)
}

export async function branchExplicitInputs(runner: SnippetRunner, wallet: WalletInterface = reliabilityWallet()) {
  const cases: BranchCase[] = []
  for (const deferred of booleans) for (const sequence of [0, 0xffffffff]) {
    for (const version of [1, 2]) for (const lockTime of [0, 1]) {
      cases.push({ id: `explicitInput/deferred-${deferred}/sequence-${sequence}/version-${version}/lockTime-${lockTime}`, run: async () => {
        const refs: string[] = []
        try {
          const parent = await wallet.createAction({ description: 'fast branch input parent', labels: [branchLabel], outputs: [output()], options: { noSend: true, randomizeOutputs: false } })
          refs.push(reference(parent))
          check(parent.tx != null, 'Input parent missing transaction bytes')
          const source = Transaction.fromAtomicBEEF(Array.from(parent.tx))
          const vout = source.outputs.findIndex(item => item.lockingScript.toHex() === lockingScript && item.satoshis === 1)
          check(vout >= 0, 'Input fixture output not found')
          const child = await wallet.createAction({
            description: 'fast branch explicit input', labels: [branchLabel], version, lockTime,
            inputBEEF: source.toBEEF(),
            inputs: [{ outpoint: `${source.id('hex')}.${vout}`, inputDescription: 'fast branch source fixture', sequenceNumber: sequence, ...(deferred ? { unlockingScriptLength: 1 } : { unlockingScript: '00' }) }],
            outputs: [output()],
            options: { noSend: true, signAndProcess: !deferred, noSendChange: parent.noSendChange, knownTxids: [source.id('hex')], trustSelf: 'known', randomizeOutputs: false },
          })
          refs.push(reference(child))
          let completed = child
          if (deferred) {
            check(child.signableTransaction != null, 'Deferred input missing signable transaction')
            const template = Transaction.fromAtomicBEEF(Array.from(child.signableTransaction.tx))
            const index = template.inputs.findIndex(input => input.sourceTXID === source.id('hex') && input.sourceOutputIndex === vout)
            check(index >= 0, 'Deferred input missing from template')
            completed = await wallet.signAction({ reference: refs[1], spends: { [index]: { unlockingScript: '00', sequenceNumber: sequence } }, options: { noSend: true } })
          }
          check(completed.tx != null, 'Completed explicit-input action missing bytes')
          const final = Transaction.fromAtomicBEEF(Array.from(completed.tx))
          const input = final.inputs.find(item => item.sourceTXID === source.id('hex') && item.sourceOutputIndex === vout)
          check(final.version === version && final.lockTime === lockTime, 'Version or lock time changed')
          check(input != null && input.sequence === sequence && input.unlockingScript?.toHex() === '00', 'Input sequence or unlocking script changed')
        } finally { await abortAll(wallet, refs) }
      } })
    }
  }
  await runCases(runner, cases)
}
