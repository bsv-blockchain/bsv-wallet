import { WalletPermissionsManager } from '@bsv/wallet-toolbox-mobile'
import { SigningPolicyPermissionsManager } from '../../core/services/signingPermissionPolicy'

const ADMIN = 'admin.wallet'

function manager() {
  const calls: { method: string; args: any; originator?: string }[] = []
  const rec = (method: string) => async (args: any, originator?: string) => {
    calls.push({ method, args, originator })
    return method === 'createSignature' ? { signature: [1] } : { valid: true }
  }
  const underlying = {
    createSignature: rec('createSignature'),
    verifySignature: rec('verifySignature')
  }
  const prompts: any[] = []
  const pm = new SigningPolicyPermissionsManager(underlying as any, ADMIN, {
    seekProtocolPermissionsForSigning: true
  } as any)
  pm.bindCallback('onProtocolPermissionRequested', (request: any) => {
    prompts.push(request)
  })
  return { pm, calls, prompts }
}

const SERVER = '02' + 'ab'.repeat(32)

test.each(['auth message signature', ' Auth Message Signature '])(
  'signs under %p (BRC-103/104) without a prompt',
  async name => {
    const { pm, calls, prompts } = manager()
    await expect(
      pm.createSignature(
        { protocolID: [2, name], keyID: 'nonce nonce', counterparty: SERVER, data: [1] },
        'app.example'
      )
    ).resolves.toEqual({ signature: [1] })
    await pm.verifySignature(
      { protocolID: [2, name], keyID: 'nonce nonce', counterparty: SERVER, data: [1], signature: [1] },
      'app.example'
    )
    expect(prompts).toEqual([])
    expect(calls.map(c => c.method)).toEqual(['createSignature', 'verifySignature'])
  }
)

// The full check (token lookup, then the prompt) is the parent's; the
// subclass only decides whether to skip it.
test.each([
  ['another protocol', { protocolID: [2, 'some app protocol'], keyID: 'x', counterparty: 'anyone' }],
  [
    'a privileged auth signature',
    { protocolID: [2, 'auth message signature'], keyID: 'x', counterparty: SERVER, privileged: true }
  ]
] as const)('still runs the full permission check for %s', async (_label, args) => {
  const full = jest
    .spyOn(WalletPermissionsManager.prototype, 'ensureProtocolPermission')
    .mockRejectedValue(new Error('denied'))
  try {
    const { pm, calls } = manager()
    await expect(pm.createSignature({ ...args, data: [1] } as any, 'app.example')).rejects.toThrow('denied')
    expect(full).toHaveBeenCalledWith(expect.objectContaining({ usageType: 'signing', protocolID: args.protocolID }))
    expect(calls).toEqual([])
  } finally {
    full.mockRestore()
  }
})

test.each([undefined, '', 'https://app.example'])('still refuses originator %p', async originator => {
  const { pm, calls } = manager()
  await expect(
    pm.createSignature(
      { protocolID: [2, 'auth message signature'], keyID: 'x', counterparty: SERVER, data: [1] },
      originator as any
    )
  ).rejects.toThrow(/Originator/)
  expect(calls).toEqual([])
})

describe('BRC-29 asks every time', () => {
  const BRC29 = { protocolID: [2, '3241645161d8'] as [2, string], keyID: 'eGFuYQ== MQ==', counterparty: 'anyone' }

  /** A manager whose prompt answers itself with `answer`, recording each
   * request. The underlying wallet has no listOutputs/createAction, so any
   * attempt to look up or mint a permission token throws. */
  function answering(answer: 'grant' | 'deny') {
    const { pm, calls, prompts } = manager()
    pm.bindCallback('onProtocolPermissionRequested', (request: any) => {
      // Answer after the current tick, like a user tapping the sheet.
      setTimeout(() => {
        if (answer === 'grant') void pm.grantPermission({ requestID: request.requestID })
        else void pm.denyPermission(request.requestID)
      }, 0)
    })
    return { pm, calls, prompts }
  }

  test('prompts for each signature, even after an approval', async () => {
    const { pm, calls, prompts } = answering('grant')
    await pm.createSignature({ ...BRC29, data: [1] }, 'app.example')
    await pm.createSignature({ ...BRC29, data: [2] }, 'app.example')
    expect(prompts).toHaveLength(2)
    expect(prompts[0].protocolID).toEqual([2, '3241645161d8'])
    expect(calls.map(c => c.args.data)).toEqual([[1], [2]])
  })

  test('concurrent signatures each get their own prompt', async () => {
    const { pm, calls, prompts } = answering('grant')
    await Promise.all([
      pm.createSignature({ ...BRC29, data: [1] }, 'app.example'),
      pm.createSignature({ ...BRC29, data: [2] }, 'app.example'),
      pm.createSignature({ ...BRC29, data: [3] }, 'app.example')
    ])
    expect(prompts).toHaveLength(3)
    expect(calls).toHaveLength(3)
  })

  test('a denial refuses that signature only', async () => {
    const { pm, calls } = answering('deny')
    await expect(pm.createSignature({ ...BRC29, data: [1] }, 'app.example')).rejects.toThrow(/denied/i)
    expect(calls).toEqual([])
  })

  test('never looks up a stored BRC-29 approval', async () => {
    const { pm } = manager()
    const listOutputs = jest.fn(async () => ({ totalOutputs: 0, outputs: [] }))
    ;(pm as any).underlying.listOutputs = listOutputs
    await expect((pm as any).findProtocolToken('app.example', false, BRC29.protocolID, 'anyone', true)).resolves.toBe(
      undefined
    )
    expect(listOutputs).not.toHaveBeenCalled()
    await (pm as any).findProtocolToken('app.example', false, [2, 'some app protocol'], 'anyone', true)
    expect(listOutputs).toHaveBeenCalled()
  })

  test('a manifest that lists BRC-29 raises no grouped sheet, only the signature prompt', async () => {
    const { pm, calls, prompts } = answering('grant')
    ;(pm as any).config.seekGroupedPermission = true
    const grouped: any[] = []
    const pacts: any[] = []
    pm.bindCallback('onGroupedPermissionRequested', (r: any) => {
      grouped.push(r)
    })
    pm.bindCallback('onCounterpartyPermissionRequested', (r: any) => {
      pacts.push(r)
    })
    const ONE_G = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
    ;(pm as any).manifestCache.set('app.example', {
      groupPermissions: {
        protocolPermissions: [
          { protocolID: [2, '3241645161d8'], counterparty: ONE_G, description: 'sign name tokens' },
          { protocolID: [2, '3241645161d8'], description: 'pay to host a picture' }
        ]
      },
      counterpartyPermissions: { description: 'x', protocols: [{ protocolName: '3241645161d8', description: 'x' }] },
      fetchedAt: Date.now()
    })
    await pm.createSignature({ ...BRC29, counterparty: ONE_G, data: [1] }, 'app.example')
    expect(grouped).toEqual([])
    expect(pacts).toEqual([])
    expect(prompts).toHaveLength(1)
    expect(calls).toHaveLength(1)
  })

  test('a grouped grant leaves BRC-29 out', async () => {
    const { pm } = manager()
    const parent = jest
      .spyOn(Object.getPrototypeOf(SigningPolicyPermissionsManager.prototype), 'grantGroupedPermission')
      .mockResolvedValue(undefined)
    try {
      const other = { protocolID: [2, 'some app protocol'] as [2, string], counterparty: 'anyone', description: 'x' }
      await pm.grantGroupedPermission({
        requestID: 'r',
        granted: { protocolPermissions: [other, { ...BRC29, description: 'pay' }] }
      } as any)
      expect(parent).toHaveBeenCalledWith({ requestID: 'r', granted: { protocolPermissions: [other] } })
    } finally {
      parent.mockRestore()
    }
  })
})
