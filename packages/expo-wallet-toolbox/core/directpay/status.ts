/**
 * What the direct-pay manager's state means for the user: the Receive tab's card about taking
 * live payments. Returns i18n keys, never English, so the screen words it in the user's
 * language; the state itself comes from the manager (a later change), as plain data.
 */
import type { DirectPayState, DirectPayStatusInput, LiveStatus } from './types'

/** The manager's state, reduced to what the user is told. */
export function directPayState(
  s: Pick<DirectPayStatusInput, 'status' | 'via' | 'notice' | 'relayUnreachable'>
): DirectPayState {
  switch (s.status) {
    case 'starting':
      return 'starting'
    case 'online':
      return s.via === 'relay' ? 'online_relay' : s.relayUnreachable ? 'online_fallback' : 'online_messagebox'
    case 'error':
      return 'failed'
    default:
      return s.notice ? 'not_set_up' : 'off'
  }
}

/** The Receive card for `s`, naming the way it receives. */
export function liveStatus(s: DirectPayStatusInput): LiveStatus {
  switch (directPayState(s)) {
    case 'online_relay':
      return { tone: 'on', titleKey: 'direct_pay_status_on_title', bodyKey: 'direct_pay_status_on_relay' }
    case 'online_messagebox':
      return { tone: 'on', titleKey: 'direct_pay_status_on_title', bodyKey: 'direct_pay_status_on_messagebox' }
    case 'online_fallback':
      return { tone: 'on', titleKey: 'direct_pay_status_on_title', bodyKey: 'direct_pay_status_on_fallback' }
    case 'starting':
      return {
        tone: 'connecting',
        titleKey: 'direct_pay_status_connecting_title',
        bodyKey: 'direct_pay_status_connecting_body'
      }
    // No message box to signal through: off, and the body says why.
    case 'not_set_up':
      return { tone: 'off', titleKey: 'direct_pay_status_off_title', bodyKey: 'direct_pay_status_not_set_up_body' }
    case 'failed':
      return {
        tone: 'error',
        titleKey: 'direct_pay_status_error_title',
        bodyKey: 'direct_pay_status_error_body',
        ...(s.error && { detail: s.error })
      }
    default:
      return { tone: 'off', titleKey: 'direct_pay_status_off_title', bodyKey: 'direct_pay_status_off_body' }
  }
}
