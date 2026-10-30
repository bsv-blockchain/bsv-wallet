/** @jest-environment node */
import { PrivateKey, ProtoWallet, Script, Transaction, type WalletInterface } from '@bsv/sdk'
import { createController } from '../demo/conformance/controller'
import { CARDS, SAFE_CARDS, SPENDING_CARDS } from '../demo/conformance/registry'
import type { Connection, PageClient } from '../src/testing/pageClient'

/**
 * An in-memory wallet behind a fake page client: SDK ProtoWallet for the key, crypto and linkage methods, fixed
 * metadata, empty lists. Methods that would need a real wallet (actions, certificates) reject like an unsupported
 * method, which also proves the runner keeps going after a failure.
 */
function memoryWallet(): WalletInterface {
  const proto = new ProtoWallet(new PrivateKey(42))
  const unsupported = (m: string) => async () => {
    throw Object.assign(new Error(`${m} is not supported by the in-memory wallet`), { code: 2 })
  }
  const w: Record<string, unknown> = {
    getVersion: async () => ({ version: 'memory-1.0.0' }),
    getNetwork: async () => ({ network: 'mainnet' }),
    getHeight: async () => ({ height: 800000 }),
    getHeaderForHeight: async () => ({ header: '00'.repeat(80) }),
    isAuthenticated: async () => ({ authenticated: true }),
    waitForAuthentication: async () => ({ authenticated: true }),
    listActions: async () => ({ totalActions: 0, actions: [] }),
    listOutputs: async () => ({ totalOutputs: 0, outputs: [] }),
    listCertificates: async () => ({ totalCertificates: 0, certificates: [] }),
    discoverByIdentityKey: async () => ({ totalCertificates: 0, certificates: [] }),
    discoverByAttributes: async () => ({ totalCertificates: 0, certificates: [] })
  }
  for (const m of [
    'getPublicKey',
    'revealCounterpartyKeyLinkage',
    'revealSpecificKeyLinkage',
    'encrypt',
    'decrypt',
    'createHmac',
    'verifyHmac',
    'createSignature',
    'verifySignature'
  ])
    w[m] = (proto as any)[m].bind(proto)
  for (const m of [
    'createAction',
    'signAction',
    'abortAction',
    'internalizeAction',
    'relinquishOutput',
    'acquireCertificate',
    'proveCertificate',
    'relinquishCertificate'
  ])
    w[m] = unsupported(m)
  return w as unknown as WalletInterface
}

function connect(wallet: WalletInterface) {
  const invoked: string[] = []
  const connection = {
    epoch: 'e',
    wallet,
    provider: { descriptor: { name: 'Memory wallet' } }
  } as unknown as Connection
  const client = {
    invoke: async (c: Connection, m: string, a: unknown) => {
      invoked.push(m)
      return (c.wallet as any)[m](a)
    }
  } as unknown as PageClient
  return { client, connection, invoked }
}

describe('registry', () => {
  it('has the 28 conformance cards and the 13 branch cases', () => {
    expect(CARDS.filter(c => c.group === 'conformance')).toHaveLength(28)
    expect(CARDS.filter(c => c.group !== 'conformance')).toHaveLength(13)
    expect(new Set(CARDS.map(c => c.id)).size).toBe(41)
  })

  it('keeps every spending, funded and certificate-workflow card out of Run all safe', () => {
    const spending = SPENDING_CARDS.map(c => c.id)
    expect(spending).toEqual(
      expect.arrayContaining([
        'conformanceInternalizeAction',
        'conformanceRelinquishOutput',
        'conformanceAcquireCertificate',
        'conformanceRelinquishCertificate',
        'branchBroadcastActions',
        'branchSendWithBatches',
        'branchInternalizeProtocols',
        'branchNoSendActions',
        'branchExplicitInputs',
        'branchDirectCertificates',
        'branchIssuedCertificates'
      ])
    )
    expect(SAFE_CARDS.every(c => !c.spending && c.group !== 'funded' && c.group !== 'certificate')).toBe(true)
    expect(SAFE_CARDS.length + SPENDING_CARDS.length).toBe(41)
    for (const c of SPENDING_CARDS) expect(c.spending!.length).toBeGreaterThan(20)
  })
})

describe('conformance controller against an in-memory wallet', () => {
  it('Run all safe passes the crypto, metadata and linkage cards, continues after failures and never touches spending cards', async () => {
    const { client, connection, invoked } = connect(memoryWallet())
    const ctl = createController({ now: () => new Date('2026-10-28T00:00:00Z') })
    ctl.setConnection(client, connection)
    await ctl.runAllSafe()

    const status = (id: string) => ctl.results.get(id)?.status
    for (const id of [
      'conformanceIsAuthenticated',
      'conformanceWaitForAuthentication',
      'conformanceGetVersion',
      'conformanceGetNetwork',
      'conformanceGetHeight',
      'conformanceGetHeaderForHeight',
      'conformanceGetPublicKey',
      'conformanceRevealCounterpartyKeyLinkage',
      'conformanceRevealSpecificKeyLinkage',
      'conformanceEncrypt',
      'conformanceDecrypt',
      'conformanceCreateHmac',
      'conformanceVerifyHmac',
      'conformanceCreateSignature',
      'conformanceVerifySignature',
      'conformanceListActions',
      'conformanceListOutputs',
      'conformanceListCertificates',
      'conformanceDiscoverByIdentityKey',
      'conformanceDiscoverByAttributes',
      'branchMetadataSequence',
      'branchCryptoMatrix',
      'branchLinkageMatrix'
    ])
      expect([id, status(id)]).toEqual([id, 'pass'])

    // unsupported wallet methods fail but the run went on to the cards after them
    expect(status('conformanceCreateAction')).toBe('fail')
    expect(ctl.results.get('conformanceCreateAction')!.errorCode).toBe(2)
    expect(ctl.results.has('branchCertificateDiscovery')).toBe(true)

    // matrices keep their per-case rows
    expect(ctl.results.get('branchCryptoMatrix')!.cases).toHaveLength(24)
    expect(ctl.results.get('branchLinkageMatrix')!.cases).toHaveLength(20)

    // every safe card ran, no spending card did, and none of their wallet methods was called
    expect([...ctl.results.keys()].sort()).toEqual(SAFE_CARDS.map(c => c.id).sort())
    for (const m of ['internalizeAction', 'relinquishOutput', 'acquireCertificate', 'relinquishCertificate'])
      expect(invoked).not.toContain(m)
  })

  it('runs one spending card only by its own run, and records a failure', async () => {
    const { client, connection, invoked } = connect(memoryWallet())
    const ctl = createController()
    ctl.setConnection(client, connection)
    await ctl.runCard('conformanceRelinquishOutput')
    expect(ctl.results.get('conformanceRelinquishOutput')?.status).toBe('fail')
    expect(invoked).toContain('createAction')
  })

  it('does nothing and says so when not connected', async () => {
    const logs: string[] = []
    const ctl = createController({ onLog: (_k, t) => logs.push(t) })
    await ctl.runAllSafe()
    await ctl.runCard('conformanceGetVersion')
    expect(ctl.results.size).toBe(0)
    expect(logs).toEqual(['not connected: press connect first', 'not connected: press connect first'])
  })

  it('Stop after current lets the running card finish and starts no further card', async () => {
    const { client, connection } = connect(memoryWallet())
    const ctl = createController()
    ctl.setConnection(client, connection)
    const done = ctl.runAllSafe()
    ctl.stop() // the first card is already running
    await done
    expect(ctl.results.size).toBe(1)
    expect([...ctl.results.keys()][0]).toBe(SAFE_CARDS[0].id)
  })

  it('runs one card at a time: a second start while one is running is refused', async () => {
    const { client, connection } = connect(memoryWallet())
    const logs: string[] = []
    const ctl = createController({ onLog: (_k, t) => logs.push(t) })
    ctl.setConnection(client, connection)
    const first = ctl.runAllSafe()
    await ctl.runCard('conformanceGetVersion')
    expect(logs.some(l => l.startsWith('busy:'))).toBe(true)
    await first
  })

  it('the report has ids, status, duration and error codes only, no payloads or messages', async () => {
    const { client, connection } = connect(memoryWallet())
    const ctl = createController({ now: () => new Date('2026-10-28T00:00:00Z') })
    ctl.setConnection(client, connection)
    await ctl.runCard('conformanceGetPublicKey')
    await ctl.runCard('conformanceCreateAction')
    await ctl.runCard('branchMetadataSequence')
    const report = ctl.report({ walletBuild: 'build 123' })
    expect(report).toMatchObject({
      source: 'fast-wallet-client-docs@63bd8c4',
      generatedAt: '2026-10-28T00:00:00.000Z',
      wallet: 'Memory wallet',
      walletBuild: 'build 123',
      summary: { cards: 3, pass: 2, fail: 1, skip: 0 }
    })
    const json = JSON.stringify(report)
    expect(json).not.toMatch(/in-memory wallet|message|02[0-9a-f]{64}/)
    const create = report.results.find(r => r.id === 'conformanceCreateAction')!
    expect(Object.keys(create).sort()).toEqual(['durationMs', 'errorCode', 'id', 'status'])
    expect(report.results.find(r => r.id === 'branchMetadataSequence')).toBeDefined()
  })
})

describe('controller hang and cleanup guards', () => {
  it('fails a card that stops answering with code "timeout" and lets the batch continue', async () => {
    const base = memoryWallet()
    const wallet = { ...(base as any), waitForAuthentication: () => new Promise(() => {}) } as WalletInterface
    const { client, connection } = connect(wallet)
    const ctl = createController({ idleTimeoutMs: 50 })
    ctl.setConnection(client, connection)
    await ctl.runAllSafe()
    expect(ctl.results.get('conformanceWaitForAuthentication')).toMatchObject({ status: 'fail', errorCode: 'timeout' })
    expect(ctl.results.get('conformanceGetVersion')!.status).toBe('pass')
    expect(ctl.running).toBeUndefined()
  })

  const SOURCE = new Transaction(1, [], [{ satoshis: 1000, lockingScript: Script.fromASM('OP_NOP') }], 0)
  const ATOMIC = new Transaction(
    1,
    [
      {
        sourceTransaction: SOURCE,
        sourceOutputIndex: 0,
        unlockingScript: Script.fromASM('OP_TRUE'),
        sequence: 0xffffffff
      }
    ],
    [{ satoshis: 1, lockingScript: Script.fromASM('OP_NOP') }],
    0
  )
  const TXID = ATOMIC.id('hex')
  const actionWallet = (abort: (calls: string[]) => Promise<{ aborted: boolean }>, calls: string[]) =>
    ({
      ...(memoryWallet() as any),
      createAction: async () => ({ txid: ATOMIC.id('hex'), tx: ATOMIC.toAtomicBEEF() }),
      abortAction: async ({ reference }: { reference: string }) => {
        calls.push(reference)
        return abort(calls)
      }
    }) as WalletInterface

  it('aborts a noSend action left behind by a card whose own abort failed', async () => {
    const calls: string[] = []
    const wallet = actionWallet(async c => {
      if (c.length === 1) throw Object.assign(new Error('boom'), { code: 9 })
      return { aborted: true }
    }, calls)
    const { client, connection } = connect(wallet)
    const ctl = createController({})
    ctl.setConnection(client, connection)
    await ctl.runCard('conformanceCreateAction')
    expect(ctl.results.get('conformanceCreateAction')).toMatchObject({ status: 'fail' })
    expect(calls).toEqual([TXID, TXID])
  })

  it('does not abort twice when the card aborted itself', async () => {
    const calls: string[] = []
    const { client, connection } = connect(actionWallet(async () => ({ aborted: true }), calls))
    const ctl = createController({})
    ctl.setConnection(client, connection)
    await ctl.runCard('conformanceCreateAction')
    expect(ctl.results.get('conformanceCreateAction')!.message).toBeUndefined()
    expect(calls).toEqual([TXID])
  })
})
