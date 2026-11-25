import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import ImportedOutboxApproval from '../../ui/components/pay/ImportedOutboxApproval'
import { P2PKH, PrivateKey, Transaction } from '@bsv/sdk'
import { resources } from '../../core/i18n/translations'
import {
  OUTBOX_KEY,
  getOutboxEntries,
  quarantineImportedOutbox,
  saveOutboxEntry,
  savePaymailOutboxEntry
} from '../../core/peerpay/outbox'
import { ADMIN, sender, signedPayment, asPeerPayRows } from '../__helpers__/signedPeerPay'
import { TaskDrainOutbox } from '../../core/monitor/TaskDrainOutbox'

jest.mock('../../ui/components/ui/PressableScale', () => ({ __esModule: true, default: 'Pressable' }))
// Keep the real scheduler; its toolbox base class has no role in these UI tests.
jest.mock('@bsv/wallet-toolbox-mobile', () => ({ WalletMonitorTask: class {} }))

const colors = { textPrimary: '#000', textSecondary: '#333', accent: '#00f', separator: '#888' }
const t = (key: string, values?: Record<string, string | number>) => (values ? `${key}:${JSON.stringify(values)}` : key)
const trees: ReactTestRenderer[] = []
beforeEach(() => TaskDrainOutbox.resetForTests())
afterEach(() => {
  act(() => trees.splice(0).forEach(tree => tree.unmount()))
})

async function fixture(overrides: Partial<React.ComponentProps<typeof ImportedOutboxApproval>> = {}) {
  const values = new Map<string, string>()
  const storage = {
    getKeyValue: async (key: string) => values.get(key),
    setKeyValue: async (key: string, value: string) => {
      values.set(key, value)
    }
  }
  await saveOutboxEntry(storage, await signedPayment())
  await quarantineImportedOutbox(storage)
  const [entry] = asPeerPayRows(await getOutboxEntries(storage))
  const props = {
    entry,
    storage,
    wallet: { getPublicKey: jest.fn(sender.getPublicKey.bind(sender)) },
    adminOriginator: ADMIN,
    colors,
    t,
    disabled: false,
    onApproved: jest.fn(),
    onCancel: jest.fn(),
    onError: jest.fn(),
    ...overrides
  }
  let tree!: ReactTestRenderer
  act(() => {
    tree = create(<ImportedOutboxApproval {...props} />)
  })
  trees.push(tree)
  const buttons = () => tree.root.findAllByType('Pressable' as never)
  const review = async () => {
    await act(async () => {
      buttons()[1].props.onPress()
    })
  }
  const cancel = async () => {
    await act(async () => {
      buttons()[0].props.onPress()
    })
  }
  return { entry, props, tree, buttons, review, cancel, storage, values }
}

test('validates before displaying exact signed terms and releases only after the separate Send press', async () => {
  const f = await fixture()
  expect(JSON.stringify(f.tree.toJSON())).not.toContain(f.entry.recipient)
  await f.review()
  expect(JSON.stringify(f.tree.toJSON())).toContain(`\\"amount\\":17`)
  expect(JSON.stringify(f.tree.toJSON())).toContain(f.entry.recipient)
  expect(f.props.wallet!.getPublicKey).toHaveBeenCalledTimes(1)
  expect(f.props.wallet!.getPublicKey).toHaveBeenLastCalledWith(
    { protocolID: [2, '3241645161d8'], keyID: 'cHJlZml4 c3VmZml4', counterparty: f.entry.recipient },
    ADMIN
  )
  expect(asPeerPayRows(await getOutboxEntries(f.storage))[0].status).toBe('import_hold')
  expect(f.props.onApproved).not.toHaveBeenCalled()
  expect(f.tree.root.findAllByType('Modal' as never)).toEqual([])
  await f.review()
  expect(f.props.wallet!.getPublicKey).toHaveBeenCalledTimes(2)
  expect(f.props.onApproved).toHaveBeenCalledWith(expect.objectContaining({ status: 'unsent', token: f.entry.token }))
  expect(asPeerPayRows(await getOutboxEntries(f.storage))[0].status).toBe('unsent')
})

test('canceling review leaves the signed payment held, while Cancel before review delegates cancellation', async () => {
  const f = await fixture()
  await f.cancel()
  expect(f.props.onCancel).toHaveBeenCalledTimes(1)
  await f.review()
  await f.cancel()
  expect(f.props.onCancel).toHaveBeenCalledTimes(1)
  expect(asPeerPayRows(await getOutboxEntries(f.storage))[0].status).toBe('import_hold')
  expect(JSON.stringify(f.tree.toJSON())).not.toContain(f.entry.recipient)
})

test('inconsistent imported amount is neither displayed nor approved', async () => {
  const f = await fixture()
  act(() => {
    f.tree.update(
      <ImportedOutboxApproval {...f.props} entry={{ ...f.entry, token: { ...f.entry.token, amount: 999 } }} />
    )
  })
  await f.review()
  expect(f.props.onError).toHaveBeenCalledTimes(1)
  expect(f.props.onApproved).not.toHaveBeenCalled()
  expect(JSON.stringify(f.tree.toJSON())).not.toContain(f.entry.recipient)
  expect(asPeerPayRows(await getOutboxEntries(f.storage))[0].status).toBe('import_hold')
  expect(TaskDrainOutbox.hasPending).toBe(false)
})

test('a changed stored snapshot is refused when Send is pressed', async () => {
  const f = await fixture()
  await f.review()
  await f.storage.setKeyValue(OUTBOX_KEY, JSON.stringify([{ ...f.entry, recipientHost: 'https://changed.example' }]))
  await f.review()
  expect(f.props.onError).toHaveBeenCalledTimes(1)
  expect(f.props.onApproved).not.toHaveBeenCalled()
  expect(asPeerPayRows(await getOutboxEntries(f.storage))[0].status).toBe('import_hold')
})

test.each([{ disabled: true }, { wallet: null }, { storage: null }])(
  'cannot review without current enabled authority: %p',
  async override => {
    const f = await fixture(override)
    expect(f.buttons()[1].props.disabled).toBe(true)
    await f.review()
    await f.cancel()
    expect(f.props.onCancel).not.toHaveBeenCalled()
    expect(f.props.onApproved).not.toHaveBeenCalled()
    expect(f.props.onError).not.toHaveBeenCalled()
  }
)

test('suppresses duplicate presses and hides terms while wallet derivation is pending', async () => {
  const f = await fixture()
  let release!: (value: { publicKey: string }) => void
  const actual = await sender.getPublicKey({
    protocolID: [2, '3241645161d8'],
    keyID: 'cHJlZml4 c3VmZml4',
    counterparty: f.entry.recipient
  })
  ;(f.props.wallet!.getPublicKey as jest.Mock).mockImplementationOnce(
    () =>
      new Promise(resolve => {
        release = resolve
      })
  )
  act(() => {
    f.buttons()[1].props.onPress()
    f.buttons()[1].props.onPress()
    f.buttons()[0].props.onPress()
  })
  expect(f.props.wallet!.getPublicKey).toHaveBeenCalledTimes(1)
  expect(f.props.onCancel).not.toHaveBeenCalled()
  expect(f.tree.root.findAllByType('ActivityIndicator' as never)).toHaveLength(1)
  expect(JSON.stringify(f.tree.toJSON())).not.toContain(f.entry.recipient)
  await act(async () => {
    release(actual)
  })
  expect(JSON.stringify(f.tree.toJSON())).toContain(f.entry.recipient)
})

test('unmount while validating prevents stale display, approval and error callbacks', async () => {
  const f = await fixture()
  let reject!: (error: Error) => void
  ;(f.props.wallet!.getPublicKey as jest.Mock).mockImplementationOnce(
    () =>
      new Promise((_resolve, rejectValue) => {
        reject = rejectValue
      })
  )
  act(() => {
    f.buttons()[1].props.onPress()
  })
  act(() => {
    f.tree.unmount()
  })
  trees.splice(trees.indexOf(f.tree), 1)
  await act(async () => {
    reject(new Error('old wallet retired'))
  })
  expect(f.props.onApproved).not.toHaveBeenCalled()
  expect(f.props.onError).not.toHaveBeenCalled()
})

test('changing wallet authority while validating discards the stale continuation', async () => {
  const f = await fixture()
  let release!: (value: { publicKey: string }) => void
  const actual = await sender.getPublicKey({
    protocolID: [2, '3241645161d8'],
    keyID: 'cHJlZml4 c3VmZml4',
    counterparty: f.entry.recipient
  })
  ;(f.props.wallet!.getPublicKey as jest.Mock).mockImplementationOnce(
    () =>
      new Promise(resolve => {
        release = resolve
      })
  )
  act(() => {
    f.buttons()[1].props.onPress()
  })
  act(() => {
    f.tree.update(<ImportedOutboxApproval {...f.props} wallet={null} />)
  })
  await act(async () => {
    release(actual)
  })
  expect(JSON.stringify(f.tree.toJSON())).not.toContain(f.entry.recipient)
  expect(f.props.onApproved).not.toHaveBeenCalled()
})

test('retiring authority while confirmed release is being revalidated prevents delivery callbacks', async () => {
  const f = await fixture()
  await f.review()
  let release!: (value: { publicKey: string }) => void
  const actual = await sender.getPublicKey({
    protocolID: [2, '3241645161d8'],
    keyID: 'cHJlZml4 c3VmZml4',
    counterparty: f.entry.recipient
  })
  ;(f.props.wallet!.getPublicKey as jest.Mock).mockImplementationOnce(
    () =>
      new Promise(resolve => {
        release = resolve
      })
  )
  await act(async () => {
    f.buttons()[1].props.onPress()
    for (let i = 0; i < 20; i++) await Promise.resolve()
  })
  expect(release).toBeDefined()
  act(() => {
    f.tree.update(<ImportedOutboxApproval {...f.props} wallet={null} />)
  })
  await act(async () => {
    release(actual)
  })
  expect(f.props.onApproved).not.toHaveBeenCalled()
  expect(f.props.onError).not.toHaveBeenCalled()
  expect(asPeerPayRows(await getOutboxEntries(f.storage))[0].status).toBe('unsent')
  expect(TaskDrainOutbox.hasPending).toBe(true)
})

async function idleDrain() {
  TaskDrainOutbox.noteConnectivity(true)
  const task = new TaskDrainOutbox({} as never, async () => ({ retried: 0, remaining: 0 }))
  await task.runTask()
  expect(task.trigger(Date.now()).run).toBe(false)
  return task
}

test('re-arms an idle drain after an approved payment has a transient first-attempt failure', async () => {
  const f = await fixture({ onApproved: jest.fn().mockRejectedValue(new Error('temporary delivery failure')) })
  const task = await idleDrain()
  await f.review()
  expect(task.trigger(Date.now()).run).toBe(false)
  expect(asPeerPayRows(await getOutboxEntries(f.storage))[0].status).toBe('import_hold')
  await f.review()
  expect(f.props.onApproved).toHaveBeenCalledTimes(1)
  expect(f.props.onError).toHaveBeenCalledTimes(1)
  expect(asPeerPayRows(await getOutboxEntries(f.storage))[0].status).toBe('unsent')
  expect(task.trigger(Date.now()).run).toBe(true)
})

test('waits for the immediate approved attempt to settle before waking the idle drain', async () => {
  let finish!: () => void
  const onApproved = jest.fn(
    () =>
      new Promise<void>(resolve => {
        finish = resolve
      })
  )
  const f = await fixture({ onApproved })
  const task = await idleDrain()
  await f.review()
  await f.review()
  expect(onApproved).toHaveBeenCalledTimes(1)
  expect(task.trigger(Date.now()).run).toBe(false)
  act(() => {
    f.buttons()[1].props.onPress()
  })
  expect(onApproved).toHaveBeenCalledTimes(1)
  await act(async () => {
    finish()
  })
  expect(task.trigger(Date.now()).run).toBe(true)
})

describe('a paymail row', () => {
  async function paymailFixture() {
    const values = new Map<string, string>()
    const storage = {
      getKeyValue: async (key: string) => values.get(key),
      setKeyValue: async (key: string, value: string) => void values.set(key, value)
    }
    const tx = new Transaction()
    tx.addOutput({ lockingScript: new P2PKH().lock(new PrivateKey(21).toAddress()), satoshis: 500 })
    await savePaymailOutboxEntry(storage, {
      paymail: 'alice@hc.example',
      endpoint: 'https://hc.example/api/receive-beef/alice',
      paymailReference: 'ref-1',
      beefHex: tx.toHexBEEF(),
      satoshis: 500,
      txid: tx.id('hex')
    } as Parameters<typeof savePaymailOutboxEntry>[1])
    await quarantineImportedOutbox(storage)
    const [entry] = await getOutboxEntries(storage)
    let tree!: ReactTestRenderer
    act(() => {
      tree = create(
        <ImportedOutboxApproval
          entry={entry}
          storage={storage}
          wallet={{ getPublicKey: jest.fn() } as never}
          adminOriginator={ADMIN}
          colors={colors}
          t={t}
          disabled={false}
          onApproved={jest.fn()}
          onCancel={jest.fn()}
          onError={jest.fn()}
        />
      )
    })
    trees.push(tree)
    await act(async () => {
      tree.root.findAllByType('Pressable' as never)[1].props.onPress()
    })
    return tree
  }

  test('the review text uses the paymail wording, not the verified-terms wording', async () => {
    const tree = await paymailFixture()
    const json = JSON.stringify(tree.toJSON())
    expect(json).toContain('review_imported_paymail_detail')
    expect(json).not.toContain('review_imported_payment_detail')
    expect(json).toContain('alice@hc.example')
  })

  test.each(Object.keys(resources))('%s wording is its own string with both placeholders', code => {
    const tr = (resources as Record<string, { translation: Record<string, string> }>)[code].translation
    const text = tr.review_imported_paymail_detail
    expect(text).toBeTruthy()
    expect(text).toContain('{{amount}}')
    expect(text).toContain('{{recipient}}')
    expect(text).not.toBe(tr.review_imported_payment_detail)
  })

  test('the English wording says the app cannot check the recipient or amount', () => {
    const text = resources.en.translation.review_imported_paymail_detail
    expect(text).toMatch(/cannot (check|verify)/i)
    expect(text).not.toMatch(/\bverified\b/i)
  })
})
