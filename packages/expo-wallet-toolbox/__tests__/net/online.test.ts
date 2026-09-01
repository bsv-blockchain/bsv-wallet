import { isOnlineState } from '../../core/net/online'

describe('isOnlineState', () => {
  it('is online when connected and reachability is unknown', () => {
    expect(isOnlineState({ isConnected: true, isInternetReachable: null })).toBe(true)
  })

  it('is online when connected and reachable', () => {
    expect(isOnlineState({ isConnected: true, isInternetReachable: true })).toBe(true)
  })

  it('is offline when connected but explicitly unreachable', () => {
    expect(isOnlineState({ isConnected: true, isInternetReachable: false })).toBe(false)
  })

  it('is offline when not connected', () => {
    expect(isOnlineState({ isConnected: false, isInternetReachable: true })).toBe(false)
  })

  // Cold start: NetInfo has not answered yet. Announcing "offline" here is
  // what put the offline banner in front of users who had signal all along.
  it('is not offline merely because connectivity is not known yet', () => {
    expect(isOnlineState({ isConnected: null, isInternetReachable: null })).toBe(true)
    expect(isOnlineState({ isConnected: null, isInternetReachable: true })).toBe(true)
  })

  it('is offline when connectivity is unknown but reachability is explicitly false', () => {
    expect(isOnlineState({ isConnected: null, isInternetReachable: false })).toBe(false)
  })
})
