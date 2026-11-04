import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import ImportedOutboxApproval from '../../ui/components/pay/ImportedOutboxApproval'
import {
  OUTBOX_KEY,
  getOutboxEntries,
  quarantineImportedOutbox,
  saveOutboxEntry,
  type OutboxEntry
} from '../../core/peerpay/outbox'
import { ADMIN, sender, signedPayment } from '../__helpers__/signedPeerPay'

jest.mock('../../ui/components/ui/PressableScale', () => ({ __esModule: true, default: 'Pressable' }))

const colors = { textPrimary: '#000', textSecondary: '#333', accent: '#00f', separator: '#888' }
const t = (key: string, values?: Record<string, string | number>) => (values ? `${key}:${JSON.stringify(values)}` : key)
const trees: ReactTestRenderer[] = []
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
  const [entry] = await getOutboxEntries(storage)
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
  return { props, tree, buttons, review, cancel, storage, values }
}

test('validates before displaying exact signed terms and releases only after the separate Send press', async () => {
  const f = await fixture()
  expect(JSON.stringify(f.tree.toJSON())).not.toContain(f.props.entry.recipient)
  await f.review()
  expect(JSON.stringify(f.tree.toJSON())).toContain(`\\"amount\\":17`)
  expect(JSON.stringify(f.tree.toJSON())).toContain(f.props.entry.recipient)
  expect(f.props.wallet!.getPublicKey).toHaveBeenCalledTimes(1)
  expect(f.props.wallet!.getPublicKey).toHaveBeenLastCalledWith(
    { protocolID: [2, '3241645161d8'], keyID: 'cHJlZml4 c3VmZml4', counterparty: f.props.entry.recipient },
    ADMIN
  )
  expect((await getOutboxEntries(f.storage))[0].status).toBe('import_hold')
  expect(f.props.onApproved).not.toHaveBeenCalled()
  expect(f.tree.root.findAllByType('Modal' as never)).toEqual([])
  await f.review()
  expect(f.props.wallet!.getPublicKey).toHaveBeenCalledTimes(2)
  expect(f.props.onApproved).toHaveBeenCalledWith(
    expect.objectContaining({ status: 'unsent', token: f.props.entry.token })
  )
  expect((await getOutboxEntries(f.storage))[0].status).toBe('unsent')
})

test('canceling review leaves the signed payment held, while Cancel before review delegates cancellation', async () => {
  const f = await fixture()
  await f.cancel()
  expect(f.props.onCancel).toHaveBeenCalledTimes(1)
  await f.review()
  await f.cancel()
  expect(f.props.onCancel).toHaveBeenCalledTimes(1)
  expect((await getOutboxEntries(f.storage))[0].status).toBe('import_hold')
  expect(JSON.stringify(f.tree.toJSON())).not.toContain(f.props.entry.recipient)
})

test('inconsistent imported amount is neither displayed nor approved', async () => {
  const f = await fixture()
  act(() => {
    f.tree.update(
      <ImportedOutboxApproval
        {...f.props}
        entry={{ ...f.props.entry, token: { ...f.props.entry.token, amount: 999 } }}
      />
    )
  })
  await f.review()
  expect(f.props.onError).toHaveBeenCalledTimes(1)
  expect(f.props.onApproved).not.toHaveBeenCalled()
  expect(JSON.stringify(f.tree.toJSON())).not.toContain(f.props.entry.recipient)
  expect((await getOutboxEntries(f.storage))[0].status).toBe('import_hold')
})

test('a changed stored snapshot is refused when Send is pressed', async () => {
  const f = await fixture()
  await f.review()
  await f.storage.setKeyValue(
    OUTBOX_KEY,
    JSON.stringify([{ ...f.props.entry, recipientHost: 'https://changed.example' }])
  )
  await f.review()
  expect(f.props.onError).toHaveBeenCalledTimes(1)
  expect(f.props.onApproved).not.toHaveBeenCalled()
  expect((await getOutboxEntries(f.storage))[0].status).toBe('import_hold')
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
    counterparty: f.props.entry.recipient
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
  expect(JSON.stringify(f.tree.toJSON())).not.toContain(f.props.entry.recipient)
  await act(async () => {
    release(actual)
  })
  expect(JSON.stringify(f.tree.toJSON())).toContain(f.props.entry.recipient)
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
    counterparty: f.props.entry.recipient
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
  expect(JSON.stringify(f.tree.toJSON())).not.toContain(f.props.entry.recipient)
  expect(f.props.onApproved).not.toHaveBeenCalled()
})

test('retiring authority while confirmed release is being revalidated prevents delivery callbacks', async () => {
  const f = await fixture()
  await f.review()
  let release!: (value: { publicKey: string }) => void
  const actual = await sender.getPublicKey({
    protocolID: [2, '3241645161d8'],
    keyID: 'cHJlZml4 c3VmZml4',
    counterparty: f.props.entry.recipient
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
})
