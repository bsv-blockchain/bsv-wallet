/**
 * The package barrel (`core/index.ts`) carries the 1Color host surface (plan 07
 * Task 19). `createMandalaRuntime` needs a registered color module, its
 * provider and a consent policy, so a host that builds its own permissions
 * manager needs the same three builders WalletContext uses. The runtime's
 * internals (settle, handle, nearby payer) stay unexported: the runtime is the
 * only door to them.
 */
jest.mock('expo-secure-store', () => require('../__mocks__/secureStoreFake').fake)
jest.mock('expo-local-authentication', () => require('../__mocks__/localAuthFake').fake)

import * as barrel from '../../core'
import * as colorModule from '../../core/mandala/colorModule'
import * as kvStore from '../../core/mandala/kvStore'
import * as accessPolicy from '../../core/mandala/accessPolicy'

describe('core barrel: 1Color host surface', () => {
  it('exports the color module, store and consent-policy builders by identity', () => {
    expect(barrel.buildColorModule).toBe(colorModule.buildColorModule)
    expect(barrel.createColorModuleStore).toBe(kvStore.createColorModuleStore)
    expect(barrel.createColorAccessPolicy).toBe(accessPolicy.createColorAccessPolicy)
    expect(barrel.colorPromptType).toBe(accessPolicy.colorPromptType)
    expect(barrel.COLOR_PROMPT_TYPES).toBe(accessPolicy.COLOR_PROMPT_TYPES)
  })

  it('keeps the runtime internals and every deleted Mandala 0.4 name out', () => {
    const exported = barrel as Record<string, unknown>
    for (const name of [
      'createSettler',
      'sendToHandle',
      'receiveFromInbox',
      'createNearbyPayer',
      'MandalaTokenModule',
      'MANDALA_BASKET',
      'encodeSettlementAck',
      'readSettlementAck',
      'coverFromFrame'
    ]) {
      expect(exported[name]).toBeUndefined()
    }
  })
})
