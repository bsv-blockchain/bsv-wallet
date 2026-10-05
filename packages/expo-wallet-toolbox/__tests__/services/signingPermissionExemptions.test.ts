import { WalletPermissionsManager } from '@bsv/wallet-toolbox-mobile'
import { AuthSigningPermissionsManager } from '../../core/services/signingPermissionExemptions'

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
  const pm = new AuthSigningPermissionsManager(underlying as any, ADMIN, {
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
  ['BRC-29 signing', { protocolID: [2, '3241645161d8'], keyID: 'x', counterparty: 'anyone' }],
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
