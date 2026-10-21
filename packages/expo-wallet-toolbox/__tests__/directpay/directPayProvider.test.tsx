/**
 * DirectPayProvider and useDirectPay (core/directpay/DirectPayProvider.tsx), outside any wallet:
 * off unless the host turned direct payments on and @bsv/webrtpay loads, the host's relay as the
 * default, settings saved to the device store, and no live payment while no wallet is open.
 */
jest.mock('expo-secure-store', () => require('../__mocks__/secureStoreFake').fake)
jest.mock('expo-local-authentication', () => require('../__mocks__/localAuthFake').fake)

import React from 'react'
import { act, render, waitFor } from '@testing-library/react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { DirectPayProvider, useDirectPay, type DirectPayContextValue } from '../../core/directpay/DirectPayProvider'
import { DIRECT_PAY_SETTINGS_KEY } from '../../core/directpay/settings'
import { setWebRTPayForTests, type WebRTPayModule } from '../../core/directpay/webrtpay'
import { NotSentError } from '../../core/directpay/payFlow'
import { configureToolbox, resetToolboxConfig } from '../../core/toolboxConfig'

let seen: DirectPayContextValue | undefined
function Probe() {
  seen = useDirectPay()
  return null
}

const fakeModule = {
  DirectPayClient: jest.fn(),
  MessageBoxSignaler: jest.fn(),
  RelaySignaler: jest.fn()
} as unknown as WebRTPayModule

afterEach(async () => {
  seen = undefined
  resetToolboxConfig()
  setWebRTPayForTests(undefined)
  await AsyncStorage.clear()
})

describe('DirectPayProvider', () => {
  it('is off without a host that turned direct payments on', async () => {
    configureToolbox({ backupUrl: null })
    render(
      <DirectPayProvider>
        <Probe />
      </DirectPayProvider>
    )
    expect(seen?.available).toBe(false)
    expect(seen?.live.tone).toBe('off')
    await expect(seen!.sendDirect({ recipient: 'x', satoshis: 1 })).rejects.toBeInstanceOf(NotSentError)
  })

  it('is off when @bsv/webrtpay is not installed', () => {
    configureToolbox({ backupUrl: null, directPay: { enabled: true } })
    setWebRTPayForTests(null)
    render(
      <DirectPayProvider>
        <Probe />
      </DirectPayProvider>
    )
    expect(seen?.available).toBe(false)
  })

  it("reads the settings with the host's relay as the default, and saves them to the device store", async () => {
    configureToolbox({ backupUrl: null, directPay: { enabled: true, relayUrl: 'wss://relay.host.example' } })
    setWebRTPayForTests(fakeModule)
    render(
      <DirectPayProvider>
        <Probe />
      </DirectPayProvider>
    )
    expect(seen?.available).toBe(true)
    await waitFor(() => expect(seen?.settings?.relayUrl).toBe('wss://relay.host.example'))
    // No wallet is open: no client, so nothing can be paid live yet.
    expect(seen?.snapshot.client).toBeNull()
    expect(seen?.canSendDirect).toBe(false)

    await act(async () => {
      await seen!.saveSettings({ receiveEnabled: false })
    })
    expect(seen?.settings).toMatchObject({ receiveEnabled: false, relayUrl: 'wss://relay.host.example' })
    expect(JSON.parse((await AsyncStorage.getItem(DIRECT_PAY_SETTINGS_KEY))!)).toMatchObject({ receiveEnabled: false })
  })

  it('has a default with nothing available outside the provider', () => {
    render(<Probe />)
    expect(seen?.available).toBe(false)
    expect(seen?.snapshot.status).toBe('off')
  })
})
