jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${Object.values(params).join(',')}` : key)
  })
}))

import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { DoneScreen } from '../src/ui/DoneScreen'
import { Toast, TOAST_MS } from '../src/ui/Toast'
import { SafariSetupGuide } from '../src/ui/SafariSetupGuide'
import type { Receipt } from '../src/receipts'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const rcpt = (over: Partial<Receipt> = {}): Receipt => ({
  origin: 'https://shop.example',
  method: 'createAction',
  summary: { kind: 'payment', amount: '5 sats' },
  ok: true,
  neededApproval: true,
  epoch: 'e',
  ...over
})
const texts = (r: ReactTestRenderer) =>
  r.root
    .findAll(n => (n.type as unknown) === 'Text' || (n.type as any)?.displayName === 'Text')
    .flatMap(n => n.props.children)
    .flat(Infinity)
    .filter(c => typeof c === 'string')
const hasDone = (r: ReactTestRenderer) => r.root.findAllByProps({ testID: 'bridge-done-screen' }).length > 0

function render(el: React.ReactElement) {
  let r!: ReactTestRenderer
  act(() => {
    r = create(el)
  })
  return r
}

describe('DoneScreen', () => {
  const props = { receipts: [rcpt()], active: true, busy: false, onDismiss: jest.fn() }

  it('shows the check, the site, the summary line and the back hint', () => {
    const r = render(<DoneScreen {...props} />)
    expect(hasDone(r)).toBe(true)
    const all = texts(r)
    expect(all).toEqual(
      expect.arrayContaining([
        'bridge_done_sent_to:shop.example',
        'bridge_done_payment:5 sats',
        'bridge_done_back_hint'
      ])
    )
  })

  it('has no button and no timer', () => {
    jest.useFakeTimers()
    try {
      const r = render(<DoneScreen {...props} />)
      act(() => void jest.advanceTimersByTime(10 * 60_000))
      expect(hasDone(r)).toBe(true)
      expect(jest.getTimerCount()).toBe(0)
    } finally {
      jest.useRealTimers()
    }
  })

  it('done screen hidden while a sheet is open or queued and replaced by a later sheet', () => {
    const r = render(<DoneScreen {...props} />)
    expect(hasDone(r)).toBe(true)
    act(() => r.update(<DoneScreen {...props} busy />))
    expect(hasDone(r)).toBe(false)
    const r2 = render(<DoneScreen {...props} busy />)
    expect(hasDone(r2)).toBe(false)
  })

  it('is hidden when the app is not active, when not ok, and when no approval was needed', () => {
    expect(hasDone(render(<DoneScreen {...props} active={false} />))).toBe(false)
    expect(hasDone(render(<DoneScreen {...props} receipts={[rcpt({ ok: false })]} />))).toBe(false)
    expect(hasDone(render(<DoneScreen {...props} receipts={[rcpt({ neededApproval: false })]} />))).toBe(false)
  })

  it('dismiss by tap', () => {
    const onDismiss = jest.fn()
    const r = render(<DoneScreen {...props} onDismiss={onDismiss} />)
    act(() => r.root.findByProps({ testID: 'bridge-done-screen' }).props.onPress())
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('several receipts of one site and of several sites', () => {
    const one = render(<DoneScreen {...props} receipts={[rcpt(), rcpt(), rcpt()]} />)
    expect(texts(one)).toEqual(expect.arrayContaining(['bridge_done_sent_to:shop.example', 'bridge_done_n_requests:3']))
    const two = render(<DoneScreen {...props} receipts={[rcpt(), rcpt({ origin: 'https://b.example' })]} />)
    expect(texts(two)).toContain('bridge_done_n_sites:2')
  })
})

describe('Toast', () => {
  it('shows done copy, hides after 2.5 s', () => {
    jest.useFakeTimers()
    try {
      const onHide = jest.fn()
      const r = render(<Toast toast={{ ok: true, id: 1 }} onHide={onHide} />)
      expect(texts(r)).toContain('bridge_toast_done')
      act(() => void jest.advanceTimersByTime(TOAST_MS - 1))
      expect(onHide).not.toHaveBeenCalled()
      act(() => void jest.advanceTimersByTime(1))
      expect(onHide).toHaveBeenCalledTimes(1)
      expect(TOAST_MS).toBe(2500)
    } finally {
      jest.useRealTimers()
    }
  })

  it('toast shows failed copy when ok false', () => {
    const r = render(<Toast toast={{ ok: false, id: 1 }} onHide={() => undefined} />)
    expect(texts(r)).toContain('bridge_toast_failed')
  })

  it('renders nothing without a toast', () => {
    expect(render(<Toast toast={null} onHide={() => undefined} />).toJSON()).toBeNull()
  })
})

describe('SafariSetupGuide', () => {
  it('renders both Always Allow routes and has no button', () => {
    const r = render(<SafariSetupGuide />)
    expect(texts(r)).toEqual(
      expect.arrayContaining([
        'bridge_setup_title',
        '1. bridge_setup_step_extension',
        '2. bridge_setup_step_allow',
        'bridge_setup_why'
      ])
    )
    expect(r.root.findAll(n => ['Pressable', 'TouchableOpacity', 'Button'].includes(String(n.type)))).toHaveLength(0)
  })
})
