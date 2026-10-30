/**
 * Every manager prompt queue reports an enqueue to the bridge (6.15 item 5), so a transport hears of a
 * raised prompt. The queues are driven the way WalletContext builds them, and the source test pins that
 * WalletContext hands the same `onEnqueue` to all of them.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { act, renderHook } from '@testing-library/react-native'
import { usePermissionQueue } from '../../core/hooks/usePermissionQueue'

const mockNotify = jest.fn()
jest.mock('../../core/bridge/runtime', () => ({ notifyPromptRaised: (o: string) => mockNotify(o) }))
// eslint-disable-next-line import/first
import { notifyPromptRaised } from '../../core/bridge/runtime'

function useQueues() {
  const note = (item: unknown) => {
    const originator = (item as { originator?: unknown } | null)?.originator
    if (typeof originator === 'string') notifyPromptRaised(originator)
  }
  const focus = {
    isFocused: async () => true,
    onFocusRequested: jest.fn(),
    onFocusRelinquished: jest.fn(),
    onEnqueue: note
  }
  return {
    basket: usePermissionQueue<{ originator: string }>(focus),
    certificate: usePermissionQueue<{ originator: string }>(focus),
    protocol: usePermissionQueue<{ originator: string }>(focus),
    spending: usePermissionQueue<{ originator: string }>(focus)
  }
}

describe('prompt enqueue notifies the bridge', () => {
  beforeEach(() => mockNotify.mockClear())

  it('basket, certificate, protocol and spending queues each call notifyPromptRaised on enqueue', async () => {
    const { result } = renderHook(useQueues)
    for (const name of ['basket', 'certificate', 'protocol', 'spending'] as const) {
      await act(async () => {
        result.current[name].enqueue({ originator: `${name}.example` })
      })
      expect(mockNotify).toHaveBeenLastCalledWith(`${name}.example`)
    }
    expect(mockNotify).toHaveBeenCalledTimes(4)
  })

  it('WalletContext passes the notifying onEnqueue to every manager queue', () => {
    const src = readFileSync(join(__dirname, '../../core/context/WalletContext.tsx'), 'utf8')
    expect(src).toContain('onEnqueue: notePromptRaised')
    for (const t of ['BasketAccessRequest', 'CertificateAccessRequest', 'ProtocolAccessRequest', 'SpendingRequest']) {
      expect(src).toMatch(new RegExp(`usePermissionQueue<${t}>\\(\\{\\s*\\.\\.\\.focusOpts`))
    }
    expect(src).toMatch(/usePermissionQueue<GroupPermissionRequest>\(focusOpts\)/)
  })
})
