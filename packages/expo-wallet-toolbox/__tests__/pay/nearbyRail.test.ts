// nearby.ts re-exports holdSentPaymentOffline from the package's own root
// (@bsv/expo-wallet-toolbox), which pulls in the full core/index.ts surface —
// including LocalStorageProvider's secrets stack, which touches these two
// native modules at import time. Same mocking requirement as
// packageResolution.test.ts and __tests__/secrets/*.
jest.mock('expo-secure-store', () => require('../__mocks__/secureStoreFake').fake)
jest.mock('expo-local-authentication', () => require('../__mocks__/localAuthFake').fake)

import * as root from '@bsv/expo-wallet-toolbox'
import * as nearby from '../../core/pay/rails/nearby'
import * as session from '../../core/localpay/session'
import * as verify from '../../core/localpay/verify'
import * as codec from '../../core/localpay/codec'
import * as pending from '../../core/localpay/pending'
import * as build from '../../core/localpay/build'
import * as types from '../../core/localpay/types'
import { awdlTransport } from '../../core/localpay/transport/awdl'
import { bleTransport } from '../../core/localpay/transport/ble'
import { describeFloor, localSupportsAwdl, localSupportsBle, selectTransport } from '../../core/localpay/transport/select'
import { requestBlePermissions } from '../../core/localpay/blePermissions'
import { capsFromProbe, prepareBle, probeDeviceCaps, readBluetoothState } from '../../core/localpay/deviceCaps'
import { raceReceivers } from '../../core/localpay/transport/race'

describe('nearby rail adapter', () => {
  it('re-exports the localpay functions by identity, so nothing is reimplemented', () => {
    expect(nearby.mintSession).toBe(session.mintSession)
    expect(nearby.encodeSession).toBe(session.encodeSession)
    expect(nearby.decodeSession).toBe(session.decodeSession)
    expect(nearby.frameToQr).toBe(codec.frameToQr)
    expect(nearby.frameBytesFromQr).toBe(codec.frameBytesFromQr)
    expect(nearby.FRAME_BLOCK_BYTES).toBe(codec.FRAME_BLOCK_BYTES)
    expect(nearby.verifyFramePayment).toBe(verify.verifyFramePayment)
    expect(nearby.FrameVerifyError).toBe(verify.FrameVerifyError)
    expect(nearby.savePending).toBe(pending.savePending)
    expect(nearby.processPending).toBe(pending.processPending)
    expect(nearby.isSessionSpent).toBe(pending.isSessionSpent)
    expect(nearby.markSessionSpent).toBe(pending.markSessionSpent)
    expect(nearby.buildPaymentFrame).toBe(build.buildPaymentFrame)
    expect(nearby.finalizeDelivery).toBe(build.finalizeDelivery)
    expect(nearby.awdlTransport).toBe(awdlTransport)
    expect(nearby.selectTransport).toBe(selectTransport)
    expect(nearby.localSupportsAwdl).toBe(localSupportsAwdl)
  })

  it('re-exports the BLE rung and the device-caps helpers by identity', () => {
    expect(nearby.bleTransport).toBe(bleTransport)
    expect(nearby.localSupportsBle).toBe(localSupportsBle)
    expect(nearby.describeFloor).toBe(describeFloor)
    expect(nearby.requestBlePermissions).toBe(requestBlePermissions)
    expect(nearby.probeDeviceCaps).toBe(probeDeviceCaps)
    expect(nearby.capsFromProbe).toBe(capsFromProbe)
    expect(nearby.readBluetoothState).toBe(readBluetoothState)
    expect(nearby.prepareBle).toBe(prepareBle)
    expect(nearby.raceReceivers).toBe(raceReceivers)
    expect(nearby.CAP_BLE).toBe(session.CAP_BLE)
  })

  // core/index.ts cannot `export *` from nearby.ts (TS2308 collisions), so its
  // hand-written block has to be extended by hand too — pin it.
  it('surfaces the same names, and the transport types, from the package root', () => {
    expect(root.bleTransport).toBe(bleTransport)
    expect(root.localSupportsBle).toBe(localSupportsBle)
    expect(root.describeFloor).toBe(describeFloor)
    expect(root.requestBlePermissions).toBe(requestBlePermissions)
    expect(root.probeDeviceCaps).toBe(probeDeviceCaps)
    expect(root.capsFromProbe).toBe(capsFromProbe)
    expect(root.readBluetoothState).toBe(readBluetoothState)
    expect(root.prepareBle).toBe(prepareBle)
    expect(root.raceReceivers).toBe(raceReceivers)
    expect(root.QrHandoffRequired).toBe(types.QrHandoffRequired)
    expect(root.AckError).toBe(types.AckError)
  })
})
