/**
 * The broadcast hold's predicate (plan 07, W1; IC §8.2 "host broadcast guard";
 * the decoy-output finding).
 *
 * A transaction that carries a BRC-162 1Color output AND this wallet's token
 * custody must not reach the network until the wallet's own journal
 * (`color_transfers`) says it is `settled`. A missing row is not "plain BSV"
 * when custody says otherwise: it is a receipt the host ledger recorded before
 * the lib internalized it, and the toolbox's forced broadcast inside
 * `internalizeAction` would otherwise post it the moment ARC is reachable
 * (Review Focus 1). A 1Color output with no custody of ours is a decoy and is
 * not held. Every unanswerable question — bytes that will not parse, no bytes
 * at all, a journal or custody read fault — holds or throws, never releases.
 * (Without `custodyOf`, every 1Color tx counts as custodial: the rows below
 * that pass only `statesOf` pin that fail-closed default.)
 */
import { LockingScript, P2PKH, PrivateKey, Transaction, UnlockingScript } from '@bsv/sdk'
import { OneColor } from '@bsv/templates'
import { colorHeldTxids, txHasColorOutput } from '../../core/mandala/colorGuard'
import type { ColorTransferState } from '../../core/mandala/types'

const ASSET = `${'ab'.repeat(32)}_0`
const PKH = PrivateKey.fromRandom().toPublicKey().toHash() as number[]

function txWith(lockingScript: LockingScript, salt: string): Transaction {
  const tx = new Transaction()
  tx.addInput({ sourceTXID: salt.repeat(32), sourceOutputIndex: 0, unlockingScript: UnlockingScript.fromHex('') })
  tx.addOutput({ satoshis: 1, lockingScript })
  return tx
}

const tokenTx = txWith(new OneColor().lock(ASSET, 1500n, PKH), '11')
const tokenTx2 = txWith(new OneColor().lock(ASSET, 18446744073709551615n, PKH), '22')
const p2pkhTx = txWith(new P2PKH().lock(PKH), '33')
const T = tokenTx.id('hex')
const U = tokenTx2.id('hex')
const P = p2pkhTx.id('hex')

function journalWith(states: Record<string, ColorTransferState>) {
  const calls: string[][] = []
  return {
    calls,
    statesOf: async (txids: readonly string[]) => {
      calls.push([...txids])
      return new Map(txids.filter(t => states[t] !== undefined).map(t => [t, states[t]] as const))
    }
  }
}

describe('txHasColorOutput', () => {
  it('sees a 1Color output, at any vout, in bytes or a Uint8Array', () => {
    const mixed = txWith(new P2PKH().lock(PKH), '44')
    mixed.addOutput({ satoshis: 1, lockingScript: new OneColor().lock(ASSET, 7n, PKH) })
    expect(txHasColorOutput(tokenTx.toBinary())).toBe(true)
    expect(txHasColorOutput(Uint8Array.from(mixed.toBinary()))).toBe(true)
  })

  it('sees a deploy output too', () => {
    expect(txHasColorOutput(txWith(new OneColor().lock(null, 1n, PKH), '55').toBinary())).toBe(true)
  })

  it('never flags a plain P2PKH tx', () => {
    expect(txHasColorOutput(p2pkhTx.toBinary())).toBe(false)
  })

  it('fails closed on bytes that will not parse', () => {
    expect(txHasColorOutput([1, 2, 3])).toBe(true)
    expect(txHasColorOutput([])).toBe(true)
  })
})

describe('colorHeldTxids', () => {
  it('holds a 1Color receipt with no journal row even when online', async () => {
    expect(await colorHeldTxids([{ txid: T, rawTx: tokenTx.toBinary() }], journalWith({}))).toEqual(new Set([T]))
  })

  it('releases only a settled 1Color tx', async () => {
    const j = journalWith({ [T]: 'settled', [U]: 'held' })
    expect(
      await colorHeldTxids(
        [
          { txid: T, rawTx: tokenTx.toBinary() },
          { txid: U, rawTx: tokenTx2.toBinary() }
        ],
        j
      )
    ).toEqual(new Set([U]))
  })

  it.each(['built', 'parked', 'handed_over', 'held', 'refused', 'cancelled'] as const)(
    'holds a 1Color tx whose row reads %s',
    async state => {
      const j = journalWith({ [T]: state })
      expect(await colorHeldTxids([{ txid: T, rawTx: tokenTx.toBinary() }], j)).toEqual(new Set([T]))
    }
  )

  it('never holds a plain BSV tx and holds an unparseable one', async () => {
    expect(await colorHeldTxids([{ txid: P, rawTx: p2pkhTx.toBinary() }], journalWith({}))).toEqual(new Set())
    expect(txHasColorOutput([1, 2, 3])).toBe(true)
  })

  it('holds a req that carries no raw transaction at all', async () => {
    expect(await colorHeldTxids([{ txid: T }], journalWith({ [T]: 'settled' }))).toEqual(new Set([T]))
  })

  it('never reads the journal for plain BSV, and reads it once for a batch', async () => {
    const plain = journalWith({})
    await colorHeldTxids([{ txid: P, rawTx: p2pkhTx.toBinary() }], plain)
    expect(plain.calls).toEqual([])

    const j = journalWith({})
    await colorHeldTxids(
      [
        { txid: T, rawTx: tokenTx.toBinary() },
        { txid: P, rawTx: p2pkhTx.toBinary() },
        { txid: U, rawTx: tokenTx2.toBinary() }
      ],
      j
    )
    expect(j.calls).toEqual([[T, U]])
  })

  it('propagates a journal read fault', async () => {
    await expect(
      colorHeldTxids([{ txid: T, rawTx: tokenTx.toBinary() }], {
        statesOf: async () => {
          throw new Error('locked')
        }
      })
    ).rejects.toThrow('locked')
  })

  it('answers an empty batch without a read', async () => {
    const j = journalWith({})
    expect(await colorHeldTxids([], j)).toEqual(new Set())
    expect(j.calls).toEqual([])
  })
})

describe('colorHeldTxids: custody scoping (the decoy-output finding)', () => {
  const custody = (states: Record<string, ColorTransferState>, custodial: string[]) => {
    const asked: string[][] = []
    return {
      asked,
      statesOf: journalWith(states).statesOf,
      custodyOf: async (txids: readonly string[]) => {
        asked.push([...txids])
        return new Set(txids.filter(t => custodial.includes(t)))
      }
    }
  }

  it('does not hold a 1Color tx with no journal row and no custody: a decoy output', async () => {
    expect(await colorHeldTxids([{ txid: T, rawTx: tokenTx.toBinary() }], custody({}, []))).toEqual(new Set())
  })

  it('holds one with custody (host ledger, own p color inputs) until its row is settled', async () => {
    const req = [{ txid: T, rawTx: tokenTx.toBinary() }]
    expect(await colorHeldTxids(req, custody({}, [T]))).toEqual(new Set([T]))
    expect(await colorHeldTxids(req, custody({ [T]: 'held' }, []))).toEqual(new Set([T]))
    expect(await colorHeldTxids(req, custody({ [T]: 'settled' }, [T]))).toEqual(new Set())
  })

  it('asks custodyOf only for 1Color txids without a journal row, once per batch', async () => {
    const c = custody({ [U]: 'handed_over' }, [])
    await colorHeldTxids(
      [
        { txid: T, rawTx: tokenTx.toBinary() },
        { txid: P, rawTx: p2pkhTx.toBinary() },
        { txid: U, rawTx: tokenTx2.toBinary() }
      ],
      c
    )
    expect(c.asked).toEqual([[T]])
  })

  it('still holds unparseable or missing bytes whatever custody says', async () => {
    expect(await colorHeldTxids([{ txid: T, rawTx: [1, 2, 3] }, { txid: U }], custody({}, []))).toEqual(new Set([T, U]))
  })

  it('propagates a custody read fault', async () => {
    await expect(
      colorHeldTxids([{ txid: T, rawTx: tokenTx.toBinary() }], {
        statesOf: journalWith({}).statesOf,
        custodyOf: async () => {
          throw new Error('kv locked')
        }
      })
    ).rejects.toThrow('kv locked')
  })
})
