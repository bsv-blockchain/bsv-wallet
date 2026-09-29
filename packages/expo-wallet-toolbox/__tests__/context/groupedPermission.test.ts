/**
 * A site whose manifest declares `metanet.groupPermissions` (fast.brc.dev) is
 * asked for them in one prompt during waitForAuthentication. That request
 * holds the origin's permission lock until it is answered, so an unanswered
 * one hung the site: waitForAuthentication never resolved and its
 * createAction spending prompt queued behind it (0.11.7 turned seeking off;
 * 0.11.8 answers it with the permission sheet).
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { WalletPermissionsManager } from '@bsv/wallet-toolbox-mobile'

const ADMIN_ORIGINATOR = 'admin.example.com'
const SITE = 'fast.brc.dev'

const GROUP = {
  spendingAuthorization: { amount: 100, description: 'Test allowance' },
  protocolPermissions: [{ protocolID: [1, 'fast grouped alpha'], description: 'Test protocol' }]
}

function manager() {
  const underlying = {
    waitForAuthentication: jest.fn().mockResolvedValue({ authenticated: true } as never),
    // No permission tokens yet, so the whole set is asked for.
    listOutputs: jest.fn().mockResolvedValue({ totalOutputs: 0, outputs: [] } as never)
  }
  const wpm = new WalletPermissionsManager(underlying as never, ADMIN_ORIGINATOR, {
    seekGroupedPermission: true
  } as never)
  // The site's manifest, without the network.
  jest.spyOn(wpm as never, 'fetchManifestGroupPermissions' as never).mockResolvedValue(GROUP as never)
  const requests: Array<{ requestID: string; permissions: unknown }> = []
  wpm.bindCallback('onGroupedPermissionRequested', ((request: { requestID: string; permissions: unknown }) => {
    requests.push(request)
  }) as never)
  return { wpm, requests }
}

const settle = (promise: Promise<unknown>, ms: number) =>
  Promise.race([promise.then(() => 'resolved'), new Promise(resolve => setTimeout(() => resolve('pending'), ms))])

async function requested(requests: unknown[]) {
  for (let i = 0; i < 50 && requests.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 5))
}

describe('grouped permission requests', () => {
  it('hold waitForAuthentication until answered', async () => {
    const { wpm, requests } = manager()
    const waiting = wpm.waitForAuthentication({}, SITE)
    await requested(requests)
    expect(requests).toHaveLength(1)
    expect(requests[0].permissions).toMatchObject(GROUP)
    await expect(settle(waiting, 100)).resolves.toBe('pending')
  })

  it('let the site carry on when rejected, without granting anything', async () => {
    const { wpm, requests } = manager()
    const createToken = jest.spyOn(wpm as never, 'persistPermissionGrant' as never)
    const waiting = wpm.waitForAuthentication({}, SITE)
    await requested(requests)
    await wpm.dismissGroupedPermission(requests[0].requestID)
    await expect(waiting).resolves.toEqual({ authenticated: true })
    expect(createToken).not.toHaveBeenCalled()
  })

  it('grant exactly the requested set when allowed', async () => {
    const { wpm, requests } = manager()
    const persist = jest.spyOn(wpm as never, 'persistPermissionGrant' as never).mockResolvedValue(undefined as never)
    const waiting = wpm.waitForAuthentication({}, SITE)
    await requested(requests)
    await wpm.grantGroupedPermission({ requestID: requests[0].requestID, granted: requests[0].permissions as never })
    await expect(waiting).resolves.toEqual({ authenticated: true })
    expect(persist).toHaveBeenCalledTimes(1)
  })
})

test('the wallet builder seeks grouped permission only if it also handles the request', () => {
  const source = readFileSync(join(__dirname, '../../core/context/WalletContext.tsx'), 'utf8')
  const handled = source.includes("bindCallback('onGroupedPermissionRequested'")
  expect(handled).toBe(true)
  expect(source).toMatch(/seekGroupedPermission: true/)
})
