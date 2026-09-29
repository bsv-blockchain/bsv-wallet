/**
 * fast.brc.dev ships a manifest with `metanet.groupPermissions`. With
 * seekGroupedPermission on, WalletPermissionsManager.waitForAuthentication
 * raises onGroupedPermissionRequested and waits for an answer while holding
 * the origin's permission lock. Nothing in this app handles that event, so the
 * call never resolved and the same site's createAction spending prompt queued
 * behind it forever.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { WalletPermissionsManager } from '@bsv/wallet-toolbox-mobile'

const ADMIN_ORIGINATOR = 'admin.example.com'
const SITE = 'fast.brc.dev'

const MANIFEST = {
  metanet: {
    groupPermissions: {
      spendingAuthorization: { amount: 100, description: 'Test allowance' },
      protocolPermissions: [{ protocolID: [1, 'fast grouped alpha'], description: 'Test protocol' }]
    }
  }
}

function manager(seekGroupedPermission: boolean) {
  const underlying = { waitForAuthentication: jest.fn().mockResolvedValue({ authenticated: true } as never) }
  return new WalletPermissionsManager(underlying as never, ADMIN_ORIGINATOR, { seekGroupedPermission } as never)
}

const settle = (promise: Promise<unknown>, ms: number) =>
  Promise.race([promise.then(() => 'resolved'), new Promise(resolve => setTimeout(() => resolve('pending'), ms))])

describe('grouped permission requests', () => {
  const realFetch = global.fetch
  beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => MANIFEST } as never) as never
  })
  afterEach(() => {
    global.fetch = realFetch
  })

  it('left unanswered, block waitForAuthentication when seeking is on', async () => {
    await expect(settle(manager(true).waitForAuthentication({}, SITE), 200)).resolves.toBe('pending')
  })

  it('do not arise when seeking is off, so waitForAuthentication resolves', async () => {
    await expect(manager(false).waitForAuthentication({}, SITE)).resolves.toEqual({ authenticated: true })
  })
})

test('the wallet builder seeks grouped permission only if it also handles the request', () => {
  const source = readFileSync(join(__dirname, '../../core/context/WalletContext.tsx'), 'utf8')
  const handled = source.includes("'onGroupedPermissionRequested'")
  expect(source).toMatch(handled ? /seekGroupedPermission: true/ : /seekGroupedPermission: false/)
})
