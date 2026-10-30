jest.mock('expo-secure-store', () => require('../../__mocks__/secureStoreFake').fake)
jest.mock('expo-local-authentication', () => require('../../__mocks__/localAuthFake').fake)
jest.mock('@bsv/expo-wallet-toolbox', () => require('./mockToolboxPackage').toolboxPackageStandIn())
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }))

import React from 'react'
import { Text } from 'react-native'
import { act, render } from '@testing-library/react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import i18n from '../../../core/i18n/translations'
import { darkColors, lightColors } from '../../../core/theme/tokens'
import { setConsentSheetSource } from '../../../core/bridge/consentSheetSource'
import PermissionSheet from '../../../ui/components/ui/PermissionSheet'
import {
  ContextRelayPublisher,
  ContextRelaySubscriber,
  publishRelayedContextForTest,
  resetContextRelay
} from '../../../ui/bridgeSheet/ContextRelay'
import { RELAYED_CONTEXTS } from '../../../ui/bridgeSheet/relayedContexts'

/**
 * `Sheet` reads the safe-area insets. That provider is not a relayed context: it measures the native window of ITS
 * root, so the second root mounts its own (Task 9's BridgeSheetRoot).
 */
const Safe = ({ children }: { children: React.ReactNode }) => (
  <SafeAreaProvider
    initialMetrics={{
      frame: { x: 0, y: 0, width: 360, height: 800 },
      insets: { top: 0, left: 0, right: 0, bottom: 0 }
    }}
  >
    {children}
  </SafeAreaProvider>
)

/** React keeps a context's default in these two fields (primary and secondary renderer). */
const internals = (c: React.Context<any>) => c as unknown as { _currentValue: unknown; _currentValue2: unknown }

const entry = (name: string) => RELAYED_CONTEXTS.find(e => e.name === name)!.context

/** Replaces each relayed context's default with a value that throws on any property read. */
function poisonDefaults(): () => void {
  const saved = RELAYED_CONTEXTS.map(
    ({ context }) => [internals(context)._currentValue, internals(context)._currentValue2] as const
  )
  const poison = (name: string) =>
    new Proxy(
      {},
      {
        get: (_t, prop) => {
          throw new Error(`default ${name} read (${String(prop)})`)
        }
      }
    )
  RELAYED_CONTEXTS.forEach(({ name, context }) => {
    const p = poison(name)
    internals(context)._currentValue = p
    internals(context)._currentValue2 = p
  })
  return () =>
    RELAYED_CONTEXTS.forEach(({ context }, i) => {
      internals(context)._currentValue = saved[i][0]
      internals(context)._currentValue2 = saved[i][1]
    })
}

const manager = { id: 'm' }
type Over = Record<string, unknown>

function values(isDark: boolean, wallet: Over = {}, user: Over = {}) {
  const colors = { ...(isDark ? darkColors : lightColors), background: isDark ? '#0d0d0d' : '#f1f1f1' }
  return {
    ThemeContext: { mode: 'system', setThemeMode: () => {}, colors, isDark },
    WalletContext: {
      managers: { sentinel: true },
      settings: { currency: 'USD' },
      protocolRequests: [],
      basketRequests: [],
      certificateRequests: [],
      spendingRequests: [],
      groupRequests: [],
      btmsRequests: [],
      mandalaRequests: [],
      advanceProtocolQueue: jest.fn(),
      advanceBasketQueue: jest.fn(),
      advanceCertificateQueue: jest.fn(),
      advanceSpendingQueue: jest.fn(),
      advanceGroupQueue: jest.fn(),
      advanceBtmsQueue: jest.fn(),
      advanceMandalaQueue: jest.fn(),
      ...wallet
    },
    ExchangeRateContext: { satoshisPerUSD: 2000, usdToFiat: { USD: 1 } },
    UserContext: {
      protocolAccessModalOpen: false,
      basketAccessModalOpen: false,
      certificateAccessModalOpen: false,
      spendingAuthorizationModalOpen: false,
      setProtocolAccessModalOpen: () => {},
      setBasketAccessModalOpen: () => {},
      setCertificateAccessModalOpen: () => {},
      setSpendingAuthorizationModalOpen: () => {},
      ...user
    }
  } as Record<string, any>
}

/** The first root: every relayed provider with the publisher inside. */
function FirstRoot({ v, skip }: { v: Record<string, any>; skip?: string }) {
  return RELAYED_CONTEXTS.reduceRight<React.ReactNode>(
    (inner, { name, context }) => {
      if (name === skip) return inner
      return <context.Provider value={v[name]}>{inner}</context.Provider>
    },
    <ContextRelayPublisher />
  ) as React.ReactElement
}

let restore: (() => void) | undefined
beforeEach(() => resetContextRelay())
afterEach(() => {
  restore?.()
  restore = undefined
  setConsentSheetSource(undefined)
  resetContextRelay()
})

const kinds: Array<{
  kind: string
  wallet?: Over
  user?: Over
  consent?: boolean
  approve: boolean
}> = [
  {
    kind: 'spending',
    wallet: {
      spendingRequests: [
        {
          requestID: 's1',
          manager,
          originator: 'shop.example',
          authorizationAmount: 5000,
          lineItems: [],
          description: 'x'
        }
      ]
    },
    user: { spendingAuthorizationModalOpen: true },
    approve: true
  },
  {
    kind: 'certificate',
    wallet: {
      certificateRequests: [
        {
          requestID: 'c1',
          manager,
          originator: 'shop.example',
          certificate: { certType: 'abc', verifier: 'def', fields: { name: 'x' } }
        }
      ]
    },
    user: { certificateAccessModalOpen: true },
    approve: true
  },
  {
    kind: 'group',
    wallet: {
      groupRequests: [
        {
          requestID: 'g1',
          manager,
          originator: 'shop.example',
          permissions: {
            spendingAuthorization: { amount: 4000, description: 'limit' },
            basketAccess: [{ basket: 'tokens', description: 'tokens' }]
          }
        }
      ]
    },
    approve: true
  },
  {
    kind: 'connection',
    consent: true,
    approve: true
  }
]

function installConnection() {
  const pending = [
    {
      requestId: 'k1',
      origin: 'https://shop.example',
      attestation: 'browser' as const,
      transportId: 'loop',
      connectedBefore: false,
      walletRevision: 1,
      profileKey: '0'
    }
  ]
  setConsentSheetSource({
    store: { listPending: () => pending, answerConsent: async () => undefined, onChange: () => () => {} } as any,
    context: () => ({ walletRevision: 1, profileKey: '0' })
  })
}

describe('ContextRelay: the second root renders PermissionSheet from relayed values only', () => {
  for (const isDark of [false, true]) {
    const mode = isDark ? 'dark' : 'light'
    describe(mode, () => {
      for (const k of kinds) {
        it(`every PermissionSheet kind renders under the subscriber alone with every context relayed (${k.kind}, ${mode})`, () => {
          if (k.consent) installConnection()
          const v = values(isDark, k.wallet, k.user)
          render(<FirstRoot v={v} />)
          restore = poisonDefaults()
          const second = render(
            <Safe>
              <ContextRelaySubscriber>
                <PermissionSheet />
              </ContextRelaySubscriber>
            </Safe>
          )
          expect(second.getByTestId('bridge-approve')).toBeTruthy()
          expect(second.getByTestId('bridge-deny')).toBeTruthy()
        })
      }

      it(`the wallet-not-ready state renders without reading a default (${mode})`, () => {
        const v = values(isDark, { managers: undefined })
        render(<FirstRoot v={v} />)
        restore = poisonDefaults()
        const second = render(
          <Safe>
            <ContextRelaySubscriber>
              <PermissionSheet />
            </ContextRelaySubscriber>
          </Safe>
        )
        expect(second.queryByTestId('bridge-approve')).toBeNull()
      })

      it(`a probe per RELAYED_CONTEXTS entry sees the published value, not the context default (${mode})`, () => {
        const v = values(isDark)
        render(<FirstRoot v={v} />)
        restore = poisonDefaults()
        const seen: Record<string, unknown> = {}
        const Probe = ({ name }: { name: string }) => {
          seen[name] = React.useContext(entry(name))
          return null
        }
        render(
          <ContextRelaySubscriber>
            {RELAYED_CONTEXTS.map(e => (
              <Probe key={e.name} name={e.name} />
            ))}
          </ContextRelaySubscriber>
        )
        for (const { name } of RELAYED_CONTEXTS) expect(seen[name]).toBe(v[name])
      })
    })
  }

  it('fails when an entry is not published: the subscriber renders null', () => {
    const v = values(false)
    const names = RELAYED_CONTEXTS.map(e => e.name)
    // Publish every entry except the last one.
    for (const name of names.slice(0, -1)) publishRelayedContextForTest(name, v[name])
    const second = render(
      <ContextRelaySubscriber>
        <Text testID="child">child</Text>
      </ContextRelaySubscriber>
    )
    expect(second.queryByTestId('child')).toBeNull()
    act(() => publishRelayedContextForTest(names[names.length - 1], v[names[names.length - 1]]))
    expect(second.getByTestId('child')).toBeTruthy()
  })

  it('the poisoned-default harness really throws', () => {
    restore = poisonDefaults()
    const Probe = () => {
      React.useContext(entry('WalletContext')).managers
      return null
    }
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<Probe />)).toThrow(/default WalletContext read/)
    spy.mockRestore()
  })

  it('theme change reaches the subscriber without remount', () => {
    let mounts = 0
    const Probe = () => {
      React.useEffect(() => {
        mounts++
      }, [])
      return <Text testID="bg">{React.useContext(entry('ThemeContext')).colors.background}</Text>
    }
    const first = render(<FirstRoot v={values(false)} />)
    const second = render(
      <ContextRelaySubscriber>
        <Probe />
      </ContextRelaySubscriber>
    )
    expect(second.getByTestId('bg').props.children).toBe('#f1f1f1')
    const node = second.getByTestId('bg')
    act(() => first.rerender(<FirstRoot v={values(true)} />))
    expect(second.getByTestId('bg').props.children).toBe('#0d0d0d')
    expect(second.getByTestId('bg')).toBe(node)
    expect(mounts).toBe(1)
  })

  it('unmount of the publisher keeps the last values until resetContextRelay', () => {
    const v = values(false)
    const first = render(<FirstRoot v={v} />)
    first.unmount()
    const second = render(
      <ContextRelaySubscriber>
        <Text testID="child">child</Text>
      </ContextRelaySubscriber>
    )
    expect(second.getByTestId('child')).toBeTruthy()
    act(() => resetContextRelay())
    expect(second.queryByTestId('child')).toBeNull()
  })

  describe('language', () => {
    afterEach(async () => {
      await act(async () => {
        await i18n.changeLanguage('en')
      })
    })
    it("with i18n set to 'es' the sheet renders Spanish copy under the subscriber alone", async () => {
      await act(async () => {
        await i18n.changeLanguage('es')
      })
      const k = kinds[0]
      render(<FirstRoot v={values(false, k.wallet, k.user)} />)
      restore = poisonDefaults()
      const second = render(
        <Safe>
          <ContextRelaySubscriber>
            <PermissionSheet />
          </ContextRelaySubscriber>
        </Safe>
      )
      expect(second.getByText('Autorizar')).toBeTruthy()
    })
  })
})
