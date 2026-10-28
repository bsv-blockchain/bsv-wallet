/**
 * Prompts that belong to a wallet that has gone (profile switch, network
 * switch, logout) are withdrawn: the old managers are retired, what they
 * still hold is denied, and every queue is emptied. Runs the real manager and
 * the real queue hook, wired the way WalletContext wires them (the source test
 * at the end pins that WalletContext does).
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { act, renderHook } from '@testing-library/react-native'
import { usePermissionQueue } from '../../core/hooks/usePermissionQueue'
import { SigningPolicyPermissionsManager } from '../../core/services/signingPermissionPolicy'
import { guardTokenPromptHandlers, handleSpendingPrompt, withdrawPrompts } from '../../core/services/permissionPrompts'

const ADMIN = 'admin.wallet'
const denied = { code: 'ERR_PERMISSION_DENIED' }
const tick = async () => await act(async () => await new Promise(resolve => setTimeout(resolve, 10)))
/** Starts calls inside act and lets them reach their prompts. Each promise has a
 * handler attached, so its eventual denial is never "unhandled". */
async function launch(...calls: Array<() => Promise<any>>): Promise<Array<Promise<any>>> {
  const promises: Array<Promise<any>> = []
  await act(async () => {
    for (const call of calls) {
      const promise = call()
      promise.catch(() => {})
      promises.push(promise)
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  })
  return promises
}

type Item = { requestID: string; originator?: string; manager?: SigningPolicyPermissionsManager }
type TokenItem = { originator: string; message: string; resolve: (approved: boolean) => void }

function useQueues() {
  const focus = { isFocused: async () => true, onFocusRequested: jest.fn(), onFocusRelinquished: jest.fn() }
  const protocol = usePermissionQueue<Item>(focus)
  const spending = usePermissionQueue<Item>(focus)
  const group = usePermissionQueue<Item>(focus)
  const btms = usePermissionQueue<TokenItem>(focus)
  const mandala = usePermissionQueue<TokenItem>(focus)
  return { protocol, spending, group, btms, mandala }
}

/** One wallet build: a real manager whose prompts land in the queues, bound
 * per manager as the context does. */
function build(queues: ReturnType<typeof useQueues>, extra: { loadThreshold?: () => Promise<void> } = {}) {
  const underlying = {
    createSignature: async () => ({ signature: [1] }),
    waitForAuthentication: async () => ({ authenticated: true }),
    listOutputs: async () => ({ totalOutputs: 0, outputs: [] })
  }
  const manager = new SigningPolicyPermissionsManager(underlying as any, ADMIN, {
    seekProtocolPermissionsForSigning: true,
    seekSpendingPermissions: true,
    seekGroupedPermission: true
  } as any)
  ;(manager as any).findSpendingToken = async () => undefined
  const recorded: string[] = []
  const prompts = guardTokenPromptHandlers({
    btms: (originator, message) =>
      new Promise<boolean>(resolve => queues.btms.enqueue({ originator, message, resolve })),
    mandala: (originator, message) =>
      new Promise<boolean>(resolve => queues.mandala.enqueue({ originator, message, resolve }))
  })
  manager.onRetire(prompts.retire)
  manager.bindCallback('onProtocolPermissionRequested', (r: any) =>
    queues.protocol.enqueue({ requestID: r.requestID, originator: r.originator, manager })
  )
  manager.bindCallback('onGroupedPermissionRequested', (r: any) =>
    queues.group.enqueue({ requestID: r.requestID, originator: r.originator, manager })
  )
  manager.bindCallback('onSpendingAuthorizationRequested', (r: any) =>
    handleSpendingPrompt<Item>(r, manager, {
      loadThreshold: extra.loadThreshold ?? (async () => {}),
      decide: () => ({ approve: false, reason: 'over-threshold' }),
      recordAutoApproved: (o, s) => void recorded.push(`${o}:${s}`),
      enqueue: queues.spending.enqueue,
      currentManager: () => manager
    })
  )
  return { manager, prompts, recorded }
}

function setup() {
  const hook = renderHook(() => useQueues())
  const queues = () => hook.result.current
  const withdraw = (managers: SigningPolicyPermissionsManager[], others: Array<() => void> = []) =>
    act(() => {
      withdrawPrompts(managers, {
        managerQueues: [queues().protocol, queues().spending, queues().group],
        tokenQueues: [queues().btms, queues().mandala],
        others
      })
    })
  return { hook, queues, withdraw }
}

const sign = (m: SigningPolicyPermissionsManager) =>
  m.createSignature(
    { protocolID: [2, 'some app protocol'], keyID: 'k', counterparty: 'self', data: [1] },
    'app.example'
  )
const spend = (m: SigningPolicyPermissionsManager) =>
  m.ensureSpendingAuthorization({ originator: 'app.example', satoshis: 5, lineItems: [] } as any)

describe('withdrawPrompts', () => {
  it('profile switch withdraws prompts and retires old manager', async () => {
    const { queues, withdraw } = setup()
    const old = build(queues())
    ;(old.manager as any).fetchManifestGroupPermissions = async () => ({
      protocolPermissions: [{ protocolID: [1, 'alpha beta'] }]
    })
    const [signing, spending, grouping, btms] = await launch(
      () => sign(old.manager),
      () => spend(old.manager),
      () => old.manager.waitForAuthentication({}, 'fast.brc.dev'),
      () => old.prompts.btms('app.example', '{}')
    )
    expect(queues().protocol.requests).toHaveLength(1)
    expect(queues().spending.requests).toHaveLength(1)
    expect(queues().btms.requests).toHaveLength(1)

    await withdraw([old.manager])

    expect(old.manager.isRetired()).toBe(true)
    for (const call of [signing, spending]) await expect(call).rejects.toMatchObject(denied)
    await expect(btms).resolves.toBe(false)
    await grouping.catch(() => {})
    for (const q of [queues().protocol, queues().spending, queues().group, queues().btms, queues().mandala]) {
      expect(q.requests).toEqual([])
    }
    expect((old.manager as any).activeRequests.size).toBe(0)
  })

  it('a token prompt raised by a retired build resolves false and enqueues nothing', async () => {
    const { queues, withdraw } = setup()
    const old = build(queues())
    await withdraw([old.manager])
    await expect(old.prompts.btms('app.example', '{}')).resolves.toBe(false)
    await expect(old.prompts.mandala('app.example', '{}')).resolves.toBe(false)
    expect(queues().btms.requests).toEqual([])
    expect(queues().mandala.requests).toEqual([])
  })

  it('a pending Mandala prompt is resolved false by the withdrawal', async () => {
    const { queues, withdraw } = setup()
    const old = build(queues())
    const [prompt] = await launch(() => old.prompts.mandala('app.example', '{}'))
    expect(queues().mandala.requests).toHaveLength(1)
    await withdraw([old.manager])
    await expect(prompt).resolves.toBe(false)
    expect(queues().mandala.requests).toEqual([])
  })

  it('spending callback released after switch enqueues nothing and records nothing', async () => {
    const { queues, withdraw } = setup()
    let release: (() => void) | undefined
    const old = build(queues(), { loadThreshold: () => new Promise<void>(resolve => (release = resolve)) })
    const next = build(queues())
    const grant = jest.spyOn(next.manager, 'grantPermission')
    const [spending] = await launch(() => spend(old.manager)) // parked on its AsyncStorage read
    for (let i = 0; i < 100 && !release; i++) await tick()
    expect(release).toBeDefined()

    // The manager is still waiting on the parked callback, so nothing yet listens
    // for the denial; release the read in the same turn, as the real one would.
    const withdrawn = withdraw([old.manager])
    release!()
    await withdrawn
    await expect(spending).rejects.toMatchObject(denied)
    await tick()

    expect(queues().spending.requests).toEqual([])
    expect(old.recorded).toEqual([])
    expect(grant).not.toHaveBeenCalled()
  })

  it('stale answer goes to retired manager', async () => {
    const { queues, withdraw } = setup()
    const old = build(queues())
    const next = build(queues())
    const [call] = await launch(() => sign(old.manager))
    const stale = queues().protocol.requests[0]
    expect(stale.manager).toBe(old.manager)

    await withdraw([old.manager])
    await expect(call).rejects.toMatchObject(denied)
    // The new wallet raises a request that happens to carry the same ID.
    const nextGrant = jest.spyOn(next.manager, 'grantPermission')
    const nextDeny = jest.spyOn(next.manager, 'denyPermission')
    const [nextCall] = await launch(() => sign(next.manager))
    expect(queues().protocol.requests).toHaveLength(1)
    expect(queues().protocol.requests[0].requestID).toBe(stale.requestID)

    // The answer to the stale request goes to the manager that raised it, and fails there.
    await expect(stale.manager!.grantPermission({ requestID: stale.requestID })).rejects.toThrow('Request ID not found')
    await expect(stale.manager!.denyPermission(stale.requestID)).rejects.toThrow('Request ID not found')
    expect(nextGrant).not.toHaveBeenCalled()
    expect(nextDeny).not.toHaveBeenCalled()
    expect(queues().protocol.requests).toHaveLength(1)
    // ...and the new request is still answerable.
    await act(async () => {
      await next.manager.denyPermission(queues().protocol.requests[0].requestID)
    })
    await expect(nextCall).rejects.toMatchObject(denied)
  })

  it('runs the other withdrawals, and one that throws does not stop the rest', async () => {
    const { queues, withdraw } = setup()
    const old = build(queues())
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const later = jest.fn()
    await withdraw(
      [old.manager],
      [
        () => {
          throw new Error('boom')
        },
        later
      ]
    )
    expect(later).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('withdrawing nothing still empties the queues', async () => {
    const { queues, withdraw } = setup()
    const old = build(queues())
    await launch(() => sign(old.manager))
    expect(queues().protocol.requests).toHaveLength(1)
    await withdraw([])
    expect(queues().protocol.requests).toEqual([])
  })
})

describe('WalletContext wiring', () => {
  const source = readFileSync(join(__dirname, '../../core/context/WalletContext.tsx'), 'utf8')

  it('withdraws the published managers before any teardown yields, and on logout', () => {
    const teardown = source.slice(source.indexOf('const teardownBuiltWallet = useCallback'))
    expect(teardown.indexOf('withdrawCurrentPrompts()')).toBeGreaterThan(-1)
    expect(teardown.indexOf('withdrawCurrentPrompts()')).toBeLessThan(teardown.indexOf('await '))
    const logout = source.slice(source.indexOf('const logout = useCallback'))
    expect(logout.indexOf("runSessionTeardown('logout')")).toBeGreaterThan(-1)
    expect(logout.indexOf('withdrawCurrentPrompts()')).toBeLessThan(logout.indexOf('await '))
  })

  it('binds every prompt callback to its manager and retires the build-scoped token handlers with it', () => {
    for (const cb of [
      'protocolPermissionCallback',
      'basketAccessCallback',
      'spendingAuthorizationCallback',
      'certificateAccessCallback',
      'groupedPermissionCallback'
    ]) {
      expect(source).toMatch(new RegExp(`${cb}\\(\\s*args(?: as any)?,\\s*(?:permissionsManager|mgr)\\s*\\)`))
    }
    expect(source).toContain('permissionsManager.onRetire(buildPrompts.retire)')
    expect(source).toContain('requestTokenAccess: buildPrompts.mandala')
    expect(source).toContain('promptHandler: buildPrompts.btms')
  })
})
