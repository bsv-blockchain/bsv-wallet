import { resources } from '../../core/i18n/translations'
import { directPayState, liveStatus } from '../../core/directpay'
import type { DirectPayStatusInput } from '../../core/directpay'

const english = resources.en.translation as Record<string, string>

const input = (over: Partial<DirectPayStatusInput> = {}): DirectPayStatusInput => ({
  status: 'off',
  via: null,
  error: '',
  notice: '',
  ...over
})

describe('directPayState', () => {
  it('follows the manager status', () => {
    expect(directPayState(input({ status: 'starting' }))).toBe('starting')
    expect(directPayState(input({ status: 'error', via: 'relay' }))).toBe('failed')
    expect(directPayState(input({ status: 'off' }))).toBe('off')
  })

  it('online names the way it receives', () => {
    expect(directPayState(input({ status: 'online', via: 'relay' }))).toBe('online_relay')
    expect(directPayState(input({ status: 'online', via: 'messagebox' }))).toBe('online_messagebox')
    expect(directPayState(input({ status: 'online', via: 'messagebox', relayUnreachable: true }))).toBe(
      'online_fallback'
    )
  })

  it('the relay being reachable wins over a stale relayUnreachable', () => {
    expect(directPayState(input({ status: 'online', via: 'relay', relayUnreachable: true }))).toBe('online_relay')
  })

  it('off with a notice is not set up (nothing to signal through), not a failure', () => {
    expect(directPayState(input({ status: 'off', notice: 'no message box' }))).toBe('not_set_up')
  })

  it('a notice does not change a state that is not off', () => {
    expect(directPayState(input({ status: 'starting', notice: 'x' }))).toBe('starting')
  })
})

describe('liveStatus', () => {
  const cases: [string, DirectPayStatusInput, string, string, string][] = [
    [
      'online via relay',
      input({ status: 'online', via: 'relay' }),
      'on',
      'direct_pay_status_on_title',
      'direct_pay_status_on_relay'
    ],
    [
      'online via the message box',
      input({ status: 'online', via: 'messagebox' }),
      'on',
      'direct_pay_status_on_title',
      'direct_pay_status_on_messagebox'
    ],
    [
      'online via the message box because the relay is unreachable',
      input({ status: 'online', via: 'messagebox', relayUnreachable: true }),
      'on',
      'direct_pay_status_on_title',
      'direct_pay_status_on_fallback'
    ],
    [
      'connecting',
      input({ status: 'starting', via: 'relay' }),
      'connecting',
      'direct_pay_status_connecting_title',
      'direct_pay_status_connecting_body'
    ],
    ['turned off', input(), 'off', 'direct_pay_status_off_title', 'direct_pay_status_off_body'],
    [
      'not set up',
      input({ notice: 'no message box' }),
      'off',
      'direct_pay_status_off_title',
      'direct_pay_status_not_set_up_body'
    ],
    [
      'failing',
      input({ status: 'error', via: 'relay', error: 'relay down' }),
      'error',
      'direct_pay_status_error_title',
      'direct_pay_status_error_body'
    ]
  ]

  it.each(cases)('%s', (_name, state, tone, titleKey, bodyKey) => {
    expect(liveStatus(state)).toMatchObject({ tone, titleKey, bodyKey })
  })

  it('every title and body is a string in English', () => {
    for (const [, state] of cases) {
      const { titleKey, bodyKey } = liveStatus(state)
      expect(english[titleKey]).toEqual(expect.any(String))
      expect(english[bodyKey]).toEqual(expect.any(String))
    }
  })

  it('reads as the Receive card in English', () => {
    const on = liveStatus(input({ status: 'online', via: 'relay' }))
    expect(english[on.titleKey]).toBe('Open to live payments')
    expect(english[on.bodyKey]).toBe('People can pay you directly while this screen is open. Connected via relay.')
    expect(english[liveStatus(input()).titleKey]).toBe('Live payments are off')
  })

  it("carries the manager's error text for the log, on an error only", () => {
    expect(liveStatus(input({ status: 'error', via: 'relay', error: 'relay down' }))).toHaveProperty(
      'detail',
      'relay down'
    )
    expect(liveStatus(input({ status: 'error', via: 'relay' }))).not.toHaveProperty('detail')
    expect(liveStatus(input({ status: 'online', via: 'relay', error: 'stale' }))).not.toHaveProperty('detail')
  })
})
