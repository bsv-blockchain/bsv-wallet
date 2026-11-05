import {
  Beef,
  LockingScript,
  P2PKH,
  PrivateKey,
  Spend,
  Transaction,
  UnlockingScript,
  type CreateActionArgs,
  type SignActionArgs
} from '@bsv/sdk'
import { wocConfigFor, WocRateLimited } from '../../core/pay/rails/address'
import {
  addressForKey,
  changeChainFor,
  decideMnemonicImport,
  DEFAULT_SWEEP_PATHS,
  isWif,
  parseWif,
  planSweep,
  planWifSweep,
  scanMnemonic,
  sweepMnemonic,
  sweepWif,
  type SweepInput,
  type SweepWallet
} from '../../core/pay/rails/sweep'

/*
 * Vectors. Every address below comes from an independent stdlib-only Python
 * BIP-39/BIP-32/base58 implementation, not from @bsv/sdk, so these tests do
 * not check the SDK against itself. Two are also well-known public vectors:
 * m/44'/0'/0'/0/0 of the "abandon … about" phrase, and private key 1.
 */
const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const V = {
  bip44Receive0: '1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA', // m/44'/0'/0'/0/0
  bip44Change0: '1J3J6EvPrv8q6AC3VCjWV45Uf3nssNMRtH', // m/44'/0'/0'/1/0
  electrumReceive0: '1K6LZdwpKT5XkEZo2T2kW197aMXYbYMc4f', // m/44'/236'/0'/0/0
  electrumChange0: '125GFsvYsDtyzGkExfsX8DoHuXu2UsMUEZ', // m/44'/236'/0'/1/0
  centbeeReceive0: '18kkyvNXf7kxBTEx18tpvp1dTfQXxBef5S', // m/44'/0/0/0
  centbeeChange0: '1GBgeWnJqeAYobmsrfSKCANp9yKUUCRfKH', // m/44'/0/1/0
  rockReceive0: '17871ErDqdevLTLWBH6WzjUc1EKGDQzCMA', // m/0'/0/0
  rockReceive1: '1B4ynFJzDPqvuttzgF16jccWGxvdJwHSWr', // m/0'/0/1
  rockChange0: '1MseVFBWLkbPeGMpkAsahBujinBq3QjGo4', // m/0'/1/0
  trezorPassphrase: '1PEha8dk5Me5J1rZWpgqSt5F4BroTBLS5y', // m/44'/0'/0'/0/0, passphrase TREZOR
  testnetBip44Receive0: 'n1M8ZVQtL7QoFvGMg24D6b2ojWvFXCGpoS'
}
const KEY1 = {
  mainComp: {
    wif: 'KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn',
    address: '1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH'
  },
  mainUnc: {
    wif: '5HpHagT65TZzG1PH3CSu63k8DbpvD8s5ip4nEB3kEsreAnchuDf',
    address: '1EHNa6Q4Jz2uvNExL497mE43ikXhwF6kZm'
  },
  testComp: {
    wif: 'cMahea7zqjxrtgAbB7LSGbcQUr1uX1ojuat9jZodMN87JcbXMTcA',
    address: 'mrCDrCybB6J1vRfbwM5hemdJz73FwDBC8r'
  },
  testUnc: { wif: '91avARGdfge8E4tZfYLoxeJ5sGBdNJQH4kvjJoQFacbgwmaKkrx', address: 'mtoKs9V381UAhUia3d7Vb9GNak8Qvmcsme' }
}
const C0FFEE_UNC = {
  wif: '5HpHagT65TZzG1PH3CSu63k8DbpvD8s5ip4nEB3kF1Aqsafvmsg',
  address: '13tvYqdQQkBCxjgxV1gmzLiWK4bCXo52iB'
}

const main = wocConfigFor('main')!
const test = wocConfigFor('test')!

// ─── A fake WhatsOnChain ─────────────────────────────────────────────────────

interface Chain {
  history: Set<string>
  unspent: Map<string, { tx_hash: string; tx_pos: number; value: number }[]>
  beef: Map<string, string>
}

function fakeChain(): Chain {
  return { history: new Set(), unspent: new Map(), beef: new Map() }
}

/** Fund `address` with outputs of the given values in one new source transaction. */
function fund(chain: Chain, address: string, values: number[], lockingScriptHex?: string): string {
  const tx = new Transaction()
  for (const satoshis of values) {
    const lockingScript = lockingScriptHex ? LockingScript.fromHex(lockingScriptHex) : new P2PKH().lock(address)
    tx.addOutput({ lockingScript, satoshis })
  }
  const txid = tx.id('hex')
  const beef = new Beef()
  beef.mergeRawTx(tx.toBinary())
  chain.beef.set(txid, Buffer.from(beef.toBinary()).toString('hex'))
  chain.history.add(address)
  const rows = chain.unspent.get(address) ?? []
  values.forEach((value, vout) => rows.push({ tx_hash: txid, tx_pos: vout, value }))
  chain.unspent.set(address, rows)
  return txid
}

let requested: string[] = []

const notFound = (text: string) =>
  ({ ok: false, status: 404, json: async () => ({}), text: async () => text }) as unknown as Response

/**
 * Answers the way WhatsOnChain does (checked live, Nov 2026): history of an
 * address with none is HTTP 404 "Not Found"; an unknown route is 404
 * "404 page not found". `historyGone` serves the second for history.
 */
function serve(
  chain: Chain,
  options: { rateLimitAfter?: number; rateLimitBeef?: boolean; historyGone?: boolean } = {}
) {
  requested = []
  global.fetch = jest.fn(async (input: string) => {
    const url = String(input)
    requested.push(url)
    const limited =
      (options.rateLimitAfter !== undefined && requested.length > options.rateLimitAfter) ||
      (options.rateLimitBeef && url.endsWith('/beef') && requested.filter(u => u.endsWith('/beef')).length > 1)
    if (limited) {
      return { ok: false, status: 429, json: async () => ({}), text: async () => '' } as unknown as Response
    }
    const ok = (body: unknown, text?: string) =>
      ({ ok: true, status: 200, json: async () => body, text: async () => text ?? '' }) as unknown as Response
    let m = /\/address\/([^/]+)\/history$/.exec(url)
    if (m && options.historyGone) return notFound('404 page not found\n')
    if (m) return chain.history.has(m[1]) ? ok([{ tx_hash: 'aa', height: 1 }]) : notFound('Not Found')
    m = /\/address\/([^/]+)\/unspent\/all$/.exec(url)
    if (m) {
      const rows = (chain.unspent.get(m[1]) ?? []).map(r => ({ ...r, isSpentInMempoolTx: false }))
      return ok({ result: rows })
    }
    m = /\/tx\/([0-9a-f]+)\/beef$/.exec(url)
    if (m && chain.beef.has(m[1])) return ok(undefined, chain.beef.get(m[1]))
    return notFound('Not Found')
  }) as unknown as typeof fetch
}

const historyLookups = () =>
  requested.filter(u => u.endsWith('/history')).map(u => /\/address\/([^/]+)\/history$/.exec(u)![1])

// ─── A fake wallet ───────────────────────────────────────────────────────────

const WALLET_ADDRESS = new PrivateKey(42).toPublicKey().toAddress()

/**
 * Builds the transaction the way wallet-toolbox does for external inputs:
 * the given inputs, one change output to itself, a fee. signAction runs every
 * unlocking script through the SDK interpreter, so a bad signature fails here.
 */
function fakeWallet(options: { fee?: number; extraInput?: boolean } = {}) {
  const pending = new Map<string, Transaction>()
  const calls = { create: [] as CreateActionArgs[], sign: [] as SignActionArgs[], abort: [] as string[] }
  let n = 0
  const wallet: SweepWallet = {
    async createAction(args) {
      calls.create.push(args)
      const beef = Beef.fromBinary(args.inputBEEF as number[])
      const tx = new Transaction()
      let total = 0
      for (const input of args.inputs ?? []) {
        const [txid, vout] = input.outpoint.split('.')
        const source = beef.findTransactionForSigning(txid)!
        total += source.outputs[Number(vout)].satoshis!
        tx.addInput({ sourceTransaction: source, sourceOutputIndex: Number(vout), sequence: 0xffffffff })
      }
      if (options.extraInput) {
        const own = new Transaction()
        own.addOutput({ lockingScript: new P2PKH().lock(WALLET_ADDRESS), satoshis: 5000 })
        tx.addInput({ sourceTransaction: own, sourceOutputIndex: 0, sequence: 0xffffffff })
      }
      tx.addOutput({ lockingScript: new P2PKH().lock(WALLET_ADDRESS), satoshis: total - (options.fee ?? 50) })
      // The wallet hands back the inputs with empty unlocking scripts.
      for (const input of tx.inputs) input.unlockingScript = new UnlockingScript()
      const reference = `ref${++n}`
      pending.set(reference, tx)
      return { signableTransaction: { tx: tx.toAtomicBEEF(), reference } }
    },
    async signAction(args) {
      calls.sign.push(args)
      const tx = pending.get(args.reference)!
      for (const [i, spend] of Object.entries(args.spends)) {
        tx.inputs[Number(i)].unlockingScript = UnlockingScript.fromHex(spend.unlockingScript)
      }
      tx.inputs.forEach((input, inputIndex) => {
        const source = input.sourceTransaction!.outputs[input.sourceOutputIndex]
        const spend = new Spend({
          sourceTXID: input.sourceTransaction!.id('hex'),
          sourceOutputIndex: input.sourceOutputIndex,
          sourceSatoshis: source.satoshis!,
          lockingScript: source.lockingScript,
          transactionVersion: tx.version,
          otherInputs: tx.inputs.filter((_, j) => j !== inputIndex),
          outputs: tx.outputs,
          inputIndex,
          unlockingScript: input.unlockingScript!,
          inputSequence: input.sequence!,
          lockTime: tx.lockTime
        })
        if (!spend.validate()) throw new Error(`invalid signature on input ${inputIndex}`)
      })
      return { txid: tx.id('hex') }
    },
    async abortAction(args) {
      calls.abort.push(args.reference)
      return { aborted: true }
    }
  }
  return { wallet, calls }
}

const FAST = { minRequestIntervalMs: 0 }

afterEach(() => {
  ;(global as any).fetch = undefined
})

// ─── Keys ────────────────────────────────────────────────────────────────────

describe('parseWif / addressForKey', () => {
  it.each([
    ['mainnet compressed', KEY1.mainComp, 'mainnet', true],
    ['mainnet uncompressed', KEY1.mainUnc, 'mainnet', false],
    ['testnet compressed', KEY1.testComp, 'testnet', true],
    ['testnet uncompressed', KEY1.testUnc, 'testnet', false],
    ['mainnet uncompressed, key 0xc0ffee', C0FFEE_UNC, 'mainnet', false]
  ] as const)('%s', (_label, vector, network, compressed) => {
    const parsed = parseWif(vector.wif)
    expect(parsed.network).toBe(network)
    expect(parsed.compressed).toBe(compressed)
    expect(addressForKey(parsed.key, parsed.compressed, parsed.network)).toBe(vector.address)
    expect(isWif(vector.wif)).toBe(true)
  })

  it('refuses what is not a BSV WIF', () => {
    expect(isWif(ABANDON)).toBe(false)
    expect(isWif(KEY1.mainComp.address)).toBe(false) // valid base58check, wrong prefix and length
    expect(isWif(KEY1.mainComp.wif.slice(0, -1) + 'o')).toBe(false) // bad checksum
    expect(() =>
      parseWif(
        'xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi'
      )
    ).toThrow()
  })
})

describe('changeChainFor', () => {
  it('turns a trailing /0 into /1', () => {
    expect(changeChainFor("m/44'/236'/0'/0")).toBe("m/44'/236'/0'/1")
    expect(changeChainFor("m/44'/0/0")).toBe("m/44'/0/1")
    expect(changeChainFor("m/0'/0")).toBe("m/0'/1")
  })
  it('has no change chain for a hardened or non-zero end', () => {
    expect(changeChainFor("m/44'/236'/0'")).toBeUndefined()
    expect(changeChainFor('m/0/5')).toBeUndefined()
  })
  it('gives every default path a change chain', () => {
    for (const p of DEFAULT_SWEEP_PATHS) expect(changeChainFor(p.receive)).toBeDefined()
  })
})

// ─── Plan ────────────────────────────────────────────────────────────────────

describe('planSweep', () => {
  const at = (satoshis: number, vout = 0, txid = 'a'.repeat(64)): SweepInput => ({ txid, vout, satoshis, address: 'x' })

  it('skips 1-sat outputs as tokens and outputs below their own input fee as dust', () => {
    const plan = planSweep([at(1, 0), at(14, 1), at(15, 2), at(16, 3), at(10_000, 4)], 'mainnet')
    // 149 bytes at 100 sat/kB = 15 sat: 15 and below is dust.
    expect(plan.skipped.map(s => [s.vout, s.reason])).toEqual([
      [0, 'token'],
      [1, 'dust'],
      [2, 'dust']
    ])
    expect(plan.inputs.map(i => i.vout)).toEqual([3, 4])
    expect(plan.totalSatoshis).toBe(10_016)
    expect(plan.estimatedFeeSatoshis).toBe(Math.ceil(((10 + 34 + 2 * 149) * 100) / 1000))
    expect(plan.estimatedImportSatoshis).toBe(plan.totalSatoshis - plan.estimatedFeeSatoshis)
  })

  it('splits into batches of maxInputsPerTx', () => {
    const many = Array.from({ length: 250 }, (_, i) => at(1000, i))
    expect(planSweep(many, 'mainnet').batchCount).toBe(3)
    expect(planSweep(many, 'mainnet', { maxInputsPerTx: 50 }).batchCount).toBe(5)
  })

  it('lists a duplicate outpoint once', () => {
    expect(planSweep([at(1000), at(1000)], 'mainnet').utxoCount).toBe(1)
  })
})

// ─── WIF ─────────────────────────────────────────────────────────────────────

describe('sweepWif', () => {
  it('previews without a wallet', async () => {
    const chain = fakeChain()
    fund(chain, KEY1.mainComp.address, [5000, 1, 7000])
    serve(chain)
    const plan = await planWifSweep({ wif: KEY1.mainComp.wif, woc: main })
    expect(plan.utxoCount).toBe(2)
    expect(plan.totalSatoshis).toBe(12_000)
    expect(plan.skipped).toEqual([expect.objectContaining({ satoshis: 1, reason: 'token' })])
    expect(requested.every(u => !u.includes('/beef'))).toBe(true)
  })

  it.each([
    ['compressed', KEY1.mainComp],
    ['uncompressed', KEY1.mainUnc]
  ])('spends a %s key into the wallet with valid signatures', async (_label, vector) => {
    const chain = fakeChain()
    fund(chain, vector.address, [5000, 1, 7000])
    serve(chain)
    const { wallet, calls } = fakeWallet({ fee: 40 })
    const plan = await planWifSweep({ wif: vector.wif, woc: main })
    const result = await sweepWif({ wallet, adminOriginator: 'admin', woc: main, wif: vector.wif, plan, ...FAST })
    expect(result.batches.map(b => b.error)).toEqual([undefined])
    expect(result.txids).toHaveLength(1)
    expect(result.utxoCount).toBe(2)
    expect(result.importedSatoshis).toBe(12_000 - 40)
    expect(result.feeSatoshis).toBe(40)
    expect(result.skipped.map(s => s.reason)).toEqual(['token'])
    expect(calls.create[0].inputs).toHaveLength(2)
    expect(calls.create[0].outputs).toBeUndefined()
    // Never in a label or description.
    expect(JSON.stringify(calls.create)).not.toContain(vector.wif)
  })

  it('refuses a key for the other network before any request', async () => {
    serve(fakeChain())
    await expect(planWifSweep({ wif: KEY1.testComp.wif, woc: main })).rejects.toThrow(/testnet/)
    expect(requested).toHaveLength(0)
  })

  it('works on testnet', async () => {
    const chain = fakeChain()
    fund(chain, KEY1.testUnc.address, [3000])
    serve(chain)
    const { wallet } = fakeWallet()
    const result = await sweepWif({ wallet, adminOriginator: 'admin', woc: test, wif: KEY1.testUnc.wif, ...FAST })
    expect(result.importedSatoshis).toBe(2950)
  })

  it('batches a large key into several transactions', async () => {
    const chain = fakeChain()
    fund(
      chain,
      KEY1.mainComp.address,
      Array.from({ length: 7 }, () => 1000)
    )
    serve(chain)
    const { wallet, calls } = fakeWallet()
    const result = await sweepWif({
      wallet,
      adminOriginator: 'admin',
      woc: main,
      wif: KEY1.mainComp.wif,
      maxInputsPerTx: 3,
      ...FAST
    })
    expect(calls.create.map(c => c.inputs!.length)).toEqual([3, 3, 1])
    expect(result.txids).toHaveLength(3)
    expect(result.utxoCount).toBe(7)
    // One BEEF fetch per source transaction, not per input.
    expect(requested.filter(u => u.endsWith('/beef'))).toHaveLength(1)
  })

  it('stops at a WhatsOnChain rate limit and keeps the batches already done', async () => {
    const chain = fakeChain()
    fund(chain, KEY1.mainComp.address, [1000, 1001])
    fund(chain, KEY1.mainComp.address, [1002, 1003])
    fund(chain, KEY1.mainComp.address, [1004, 1005])
    serve(chain, { rateLimitBeef: true })
    const { wallet, calls } = fakeWallet()
    const result = await sweepWif({
      wallet,
      adminOriginator: 'admin',
      woc: main,
      wif: KEY1.mainComp.wif,
      maxInputsPerTx: 2,
      ...FAST
    })
    expect(result.stoppedBy).toBe('rate-limit')
    expect(result.txids).toHaveLength(1)
    expect(result.batches).toHaveLength(2)
    expect(result.batches[1].error).toMatch(/rate limit/)
    expect(calls.create).toHaveLength(1)
  })

  it('fails the batch when the wallet reports a failed broadcast', async () => {
    const chain = fakeChain()
    fund(chain, KEY1.mainComp.address, [5000])
    serve(chain)
    const { wallet } = fakeWallet()
    const sign = wallet.signAction.bind(wallet)
    wallet.signAction = async args => ({
      ...(await sign(args)),
      sendWithResults: [{ txid: 'ab'.repeat(32), status: 'failed' }]
    })
    const result = await sweepWif({ wallet, adminOriginator: 'admin', woc: main, wif: KEY1.mainComp.wif, ...FAST })
    expect(result.txids).toHaveLength(0)
    expect(result.batches[0].error).toMatch(/broadcast failed \(failed\)/)
  })

  it('aborts when the wallet adds an input of its own', async () => {
    const chain = fakeChain()
    fund(chain, KEY1.mainComp.address, [5000])
    serve(chain)
    const { wallet, calls } = fakeWallet({ extraInput: true })
    const result = await sweepWif({ wallet, adminOriginator: 'admin', woc: main, wif: KEY1.mainComp.wif, ...FAST })
    expect(result.txids).toHaveLength(0)
    expect(result.batches[0].error).toMatch(/added inputs/)
    expect(calls.sign).toHaveLength(0)
    expect(calls.abort).toEqual(['ref1'])
  })

  it('aborts when the fee rate is too high', async () => {
    const chain = fakeChain()
    fund(chain, KEY1.mainComp.address, [5000])
    serve(chain)
    const { wallet, calls } = fakeWallet({ fee: 4000 })
    const result = await sweepWif({ wallet, adminOriginator: 'admin', woc: main, wif: KEY1.mainComp.wif, ...FAST })
    expect(result.batches[0].error).toMatch(/fee too high/)
    expect(calls.abort).toEqual(['ref1'])
  })

  it('skips an output whose real script is not plain P2PKH', async () => {
    const chain = fakeChain()
    // The listing says 5000 sat to the address, but the real output carries an extra opcode.
    const real = new P2PKH().lock(KEY1.mainComp.address).toHex() + '75'
    fund(chain, KEY1.mainComp.address, [5000], real)
    serve(chain)
    const { wallet, calls } = fakeWallet()
    const result = await sweepWif({ wallet, adminOriginator: 'admin', woc: main, wif: KEY1.mainComp.wif, ...FAST })
    expect(calls.create).toHaveLength(0)
    expect(result.skipped.map(s => s.reason)).toEqual(['nonstandard'])
  })

  it('refuses a plan made for another key', async () => {
    const chain = fakeChain()
    fund(chain, KEY1.mainComp.address, [5000])
    serve(chain)
    const plan = await planWifSweep({ wif: KEY1.mainComp.wif, woc: main })
    const { wallet } = fakeWallet()
    await expect(
      sweepWif({ wallet, adminOriginator: 'admin', woc: main, wif: C0FFEE_UNC.wif, plan, ...FAST })
    ).rejects.toThrow(/does not belong/)
  })
})

// ─── Mnemonic ────────────────────────────────────────────────────────────────

describe('scanMnemonic', () => {
  it('derives the known address of every default path, and scans change only after a used receive address', async () => {
    const chain = fakeChain()
    chain.history.add(V.electrumReceive0)
    serve(chain)
    const plan = await scanMnemonic({ mnemonic: ABANDON, woc: main, gapLimit: 1, ...FAST })
    const looked = historyLookups()
    // gap 1: index 0 of each receive chain; ElectrumSV used, so index 1 of it and index 0 of its change.
    expect(looked).toEqual([
      V.centbeeReceive0,
      V.rockReceive0,
      V.electrumReceive0,
      expect.any(String),
      V.electrumChange0,
      V.bip44Receive0
    ])
    expect(plan.paths.find(p => p.name === 'ElectrumSV')).toMatchObject({ usedAddresses: 1, changeScanned: true })
    expect(plan.paths.find(p => p.name === 'Centbee')).toMatchObject({ usedAddresses: 0, changeScanned: false })
  })

  it('applies the gap limit as consecutive unused addresses', async () => {
    const chain = fakeChain()
    chain.history.add(V.rockReceive0)
    chain.history.add(V.rockReceive1)
    serve(chain)
    await scanMnemonic({
      mnemonic: ABANDON,
      woc: main,
      paths: [{ name: 'RockWallet', receive: "m/0'/0", change: null }],
      gapLimit: 3,
      ...FAST
    })
    // 0, 1 used; 2, 3, 4 unused ends it.
    expect(historyLookups()).toHaveLength(5)
    expect(historyLookups().slice(0, 2)).toEqual([V.rockReceive0, V.rockReceive1])
  })

  it('finds the funds on the receive and change chains of a path', async () => {
    const chain = fakeChain()
    fund(chain, V.centbeeReceive0, [4000])
    fund(chain, V.centbeeChange0, [6000, 1])
    serve(chain)
    const plan = await scanMnemonic({ mnemonic: ABANDON, woc: main, gapLimit: 2, ...FAST })
    expect(plan.inputs.map(i => i.path).sort()).toEqual(["m/44'/0/0/0", "m/44'/0/1/0"])
    expect(plan.totalSatoshis).toBe(10_000)
    expect(plan.skipped).toEqual([expect.objectContaining({ reason: 'token', path: "m/44'/0/1/0" })])
    expect(plan.paths.find(p => p.name === 'Centbee')).toMatchObject({ satoshis: 10_000, utxoCount: 2 })
  })

  it('uses the passphrase', async () => {
    const chain = fakeChain()
    serve(chain)
    await scanMnemonic({
      mnemonic: ABANDON,
      passphrase: 'TREZOR',
      woc: main,
      paths: [{ name: 'BIP-44', receive: "m/44'/0'/0'/0" }],
      gapLimit: 1,
      ...FAST
    })
    expect(historyLookups()).toEqual([V.trezorPassphrase])
  })

  it('derives testnet addresses on testnet', async () => {
    serve(fakeChain())
    await scanMnemonic({
      mnemonic: ABANDON,
      woc: test,
      paths: [{ name: 'BIP-44', receive: "m/44'/0'/0'/0" }],
      gapLimit: 1,
      ...FAST
    })
    expect(historyLookups()).toEqual([V.testnetBip44Receive0])
  })

  it('stops on a WhatsOnChain rate limit', async () => {
    serve(fakeChain(), { rateLimitAfter: 2 })
    await expect(scanMnemonic({ mnemonic: ABANDON, woc: main, gapLimit: 5, ...FAST })).rejects.toBeInstanceOf(
      WocRateLimited
    )
  })

  it('throws, rather than reporting nothing found, when the history route is gone', async () => {
    serve(fakeChain(), { historyGone: true })
    await expect(scanMnemonic({ mnemonic: ABANDON, woc: main, gapLimit: 1, ...FAST })).rejects.toThrow(/not available/)
    await expect(decideMnemonicImport({ mnemonic: ABANDON, chain: 'main', woc: main, ...FAST })).rejects.toThrow()
  })

  it('refuses an invalid phrase', async () => {
    await expect(scanMnemonic({ mnemonic: 'not a phrase', woc: main, ...FAST })).rejects.toThrow()
  })
})

describe('sweepMnemonic', () => {
  it('spends every path found into the wallet and reports per-path totals', async () => {
    const chain = fakeChain()
    fund(chain, V.bip44Receive0, [4000])
    fund(chain, V.bip44Change0, [3000])
    fund(chain, V.rockReceive0, [2000])
    serve(chain)
    const { wallet, calls } = fakeWallet({ fee: 30 })
    const plan = await scanMnemonic({ mnemonic: ABANDON, woc: main, gapLimit: 2, ...FAST })
    expect(plan.utxoCount).toBe(3)
    const result = await sweepMnemonic({
      wallet,
      adminOriginator: 'admin',
      woc: main,
      mnemonic: ABANDON,
      plan,
      maxInputsPerTx: 2,
      ...FAST
    })
    expect(result.txids).toHaveLength(2)
    expect(result.importedSatoshis).toBe(9000 - 60)
    expect(result.pathTotals).toEqual({ Centbee: 0, RockWallet: 2000, ElectrumSV: 0, 'BIP-44 (coin 0)': 7000 })
    expect(JSON.stringify([calls.create, calls.sign])).not.toContain('abandon')
  })

  it('refuses a plan with an address the phrase does not derive', async () => {
    const chain = fakeChain()
    fund(chain, V.rockReceive0, [2000])
    serve(chain)
    const plan = await scanMnemonic({ mnemonic: ABANDON, woc: main, gapLimit: 1, ...FAST })
    plan.inputs[0] = { ...plan.inputs[0], address: V.bip44Receive0 }
    const { wallet } = fakeWallet()
    await expect(
      sweepMnemonic({ wallet, adminOriginator: 'admin', woc: main, mnemonic: ABANDON, plan, ...FAST })
    ).rejects.toThrow(/does not belong/)
  })
})

describe('decideMnemonicImport', () => {
  it('restores on a backup cache hit, without a scan', async () => {
    serve(fakeChain())
    const probe = jest.fn(async () => true)
    const decision = await decideMnemonicImport({ mnemonic: ABANDON, chain: 'main', probe, woc: main, ...FAST })
    expect(decision).toEqual({ kind: 'restore' })
    expect(probe).toHaveBeenCalledWith(expect.any(Array), 'main')
    expect(requested).toHaveLength(0)
  })

  it('checks the backup of the normalised phrase', async () => {
    serve(fakeChain())
    const keys: number[][] = []
    const probe = async (primaryKey: number[]) => {
      keys.push([...primaryKey])
      return true
    }
    await decideMnemonicImport({ mnemonic: ABANDON, chain: 'main', probe, woc: main })
    await decideMnemonicImport({
      mnemonic: `  ${ABANDON.toUpperCase().split(' ').join('   ')}\n`,
      chain: 'main',
      probe,
      woc: main
    })
    expect(keys[1]).toEqual(keys[0])
  })

  it('sweeps when there is no backup and the scan finds coins', async () => {
    const chain = fakeChain()
    fund(chain, V.electrumReceive0, [8000])
    serve(chain)
    const decision = await decideMnemonicImport({
      mnemonic: ABANDON,
      chain: 'main',
      probe: async () => false,
      woc: main,
      gapLimit: 1,
      ...FAST
    })
    expect(decision.kind).toBe('sweep')
    expect(decision.kind === 'sweep' && decision.plan.totalSatoshis).toBe(8000)
  })

  it('is empty when there is no backup and nothing on chain', async () => {
    serve(fakeChain())
    const decision = await decideMnemonicImport({ mnemonic: ABANDON, chain: 'main', woc: main, gapLimit: 1, ...FAST })
    expect(decision.kind).toBe('empty')
  })

  it('treats only tokens as nothing to sweep', async () => {
    const chain = fakeChain()
    fund(chain, V.bip44Receive0, [1])
    serve(chain)
    const decision = await decideMnemonicImport({ mnemonic: ABANDON, chain: 'main', woc: main, gapLimit: 1, ...FAST })
    expect(decision.kind).toBe('empty')
    expect(decision.kind === 'empty' && decision.plan?.skipped).toHaveLength(1)
  })

  it('throws when the backup cache cannot be reached, rather than scanning', async () => {
    serve(fakeChain())
    await expect(
      decideMnemonicImport({
        mnemonic: ABANDON,
        chain: 'main',
        probe: async () => {
          throw new Error('offline')
        },
        woc: main,
        ...FAST
      })
    ).rejects.toThrow('offline')
    expect(requested).toHaveLength(0)
  })

  it('is empty on a network without WhatsOnChain', async () => {
    expect(await decideMnemonicImport({ mnemonic: ABANDON, chain: 'main', woc: undefined })).toEqual({ kind: 'empty' })
  })
})
