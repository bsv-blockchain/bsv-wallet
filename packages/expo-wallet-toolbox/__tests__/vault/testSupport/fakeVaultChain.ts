/**
 * Shared test infrastructure for the v7 chain-recovery proof: a minimal
 * in-memory "blockchain" (FakeChain) and a VaultWallet-shaped fake backed by
 * it (FakeVaultWallet), used by chainRecovery.test.ts and
 * proofBar.cleanDeviceRecovery.test.ts.
 *
 * FakeVaultWallet's getPublicKey/encrypt/decrypt/createHmac delegate to a
 * REAL @bsv/sdk CompletedProtoWallet built from a caller-supplied primary
 * key — not stubs — so two FakeVaultWallet instances built from the SAME
 * primary key but with otherwise independent local state (their own basket
 * store, action history and source-transaction cache) faithfully model "the
 * same wallet, on two different devices, sharing only what is actually
 * on-chain." That is exactly the I1 scenario: device B, rebuilt from the
 * mnemonic alone with empty local storage, must recover through
 * chainRecovery.ts and the unchanged withdraw path using nothing but the
 * shared FakeChain.
 *
 * createAction/signAction implement just enough of the real two-phase
 * noSend -> sendWith protocol for transfers.ts's deposit/withdraw/relock
 * code to run unmodified against a REAL @bsv/sdk Transaction, so every
 * unlocking script it builds is checked by the real R1C interpreter (via
 * transfers.ts's own verifyVaultInput call) exactly as it would be against
 * the genuine wallet-toolbox.
 */
import { Beef, CompletedProtoWallet, LockingScript, P2PKH, PrivateKey, Transaction, UnlockingScript, Utils } from '@bsv/sdk'
import type { VaultActionRow, VaultWallet } from '../../../core/services/vault/transfers'
import type { VaultChainLookup } from '../../../core/services/vault/chainRecovery'

/** A small fixed fee, generous relative to transfers.ts's own safety
 * ceilings (which scale with the ~45 KB R1C witness) — never the thing under
 * test. */
const FEE = 500

interface StoredOutput {
  satoshis: number
  lockingScript: string
  customInstructions?: string
  basket: string
  tags: string[]
  spendable: boolean
}

/** The shared, append-only "chain": every transaction any FakeVaultWallet
 * has published, indexed by exact locking-script hex (chainRecovery.ts's
 * VaultChainLookup takes a script, not an address — the address translation
 * is specific to the production WhatsOnChain implementation, not part of the
 * interface contract). */
export class FakeChain {
  private txs = new Map<string, Transaction>()
  private confirmed = new Set<string>()
  private spentOutpoints = new Set<string>()
  private scriptIndex = new Map<string, Set<string>>()

  publish(tx: Transaction, opts: { confirmed?: boolean } = {}): string {
    const txid = tx.id('hex')
    this.txs.set(txid, tx)
    if (opts.confirmed ?? true) this.confirmed.add(txid)
    for (const output of tx.outputs) {
      const hex = output.lockingScript.toHex()
      const set = this.scriptIndex.get(hex) ?? new Set()
      set.add(txid)
      this.scriptIndex.set(hex, set)
    }
    for (const input of tx.inputs) {
      const sourceTxid = (input.sourceTXID ?? input.sourceTransaction?.id('hex'))?.toLowerCase()
      if (sourceTxid && this.txs.has(sourceTxid)) {
        this.spentOutpoints.add(`${sourceTxid}.${input.sourceOutputIndex}`)
      }
    }
    return txid
  }

  setConfirmed(txid: string, confirmed: boolean): void {
    if (confirmed) this.confirmed.add(txid)
    else this.confirmed.delete(txid)
  }

  tx(txid: string): Transaction | undefined {
    return this.txs.get(txid)
  }

  isConfirmed(txid: string): boolean {
    return this.confirmed.has(txid)
  }

  txidsForScript(scriptHex: string): string[] {
    return [...(this.scriptIndex.get(scriptHex) ?? [])]
  }

  isSpent(txid: string, vout: number): 'spent' | 'unspent' | 'unknown' {
    if (!this.txs.has(txid)) return 'unknown'
    return this.spentOutpoints.has(`${txid}.${vout}`) ? 'spent' : 'unspent'
  }
}

/** VaultChainLookup over a FakeChain — the same interface the production
 * WhatsOnChain implementation (chainRecovery.ts's wocChainLookup) satisfies,
 * so recoverVaultFromChain's logic is exercised exactly as it would be in
 * production, independent of any indexer's HTTP shape. */
export function fakeChainLookup(chain: FakeChain): VaultChainLookup {
  return {
    async transactionsForLockingScript(lockingScriptHex: string): Promise<string[]> {
      return chain.txidsForScript(lockingScriptHex)
    },
    async transactionForTxid(txid: string): Promise<{ beef: number[]; confirmed: boolean } | null> {
      const tx = chain.tx(txid)
      if (!tx) return null
      return { beef: tx.toAtomicBEEF(), confirmed: chain.isConfirmed(txid) }
    },
    async outputStatus(outpoint: { txid: string; vout: number }): Promise<'unspent' | 'spent' | 'unknown'> {
      return chain.isSpent(outpoint.txid, outpoint.vout)
    }
  }
}

interface PendingTx {
  tx: Transaction
  kind: 'deposit' | 'spend'
  /** basket/customInstructions for each EXPLICIT output index, captured from
   * the original createAction args — this is wallet-level metadata that
   * never appears in the on-chain transaction itself. */
  explicitMeta: { basket?: string; customInstructions?: string; tags?: string[] }[]
}

/**
 * A VaultWallet-shaped fake with real BRC-2/HMAC/HD crypto (via
 * CompletedProtoWallet) and an in-memory 'admin vault' basket + action/source
 * cache standing in for local SQLite. Two instances sharing a `primaryKey`
 * and a `FakeChain` are indistinguishable, crypto-wise, from "the same
 * wallet reinstalled" — only their local caches differ.
 */
export class FakeVaultWallet implements VaultWallet {
  readonly crypto: CompletedProtoWallet
  private readonly chain: FakeChain
  /** outpoint ("txid.vout") -> stored output, for the 'admin vault' basket only. */
  private basket = new Map<string, StoredOutput>()
  private sourceTxByTxid = new Map<string, Transaction>()
  private pendingByReference = new Map<string, PendingTx>()
  private pendingByTxid = new Map<string, PendingTx>()
  private refCounter = 0

  constructor(primaryKey: number[], chain: FakeChain) {
    this.crypto = new CompletedProtoWallet(new PrivateKey(primaryKey))
    this.chain = chain
  }

  /** Wipe every trace of local state — "phone loss / reinstall / wiped DB" —
   * while keeping the same crypto identity and the same shared chain. */
  wipeLocalState(): void {
    this.basket.clear()
    this.sourceTxByTxid.clear()
    this.pendingByReference.clear()
    this.pendingByTxid.clear()
  }

  hasLocalVaultOutputs(): boolean {
    return this.basket.size > 0
  }

  // ── crypto passthroughs (real) ─────────────────────────────────────────
  async getPublicKey(args: unknown): Promise<{ publicKey: string }> {
    return await this.crypto.getPublicKey(args as never)
  }

  async encrypt(args: unknown): Promise<{ ciphertext: number[] }> {
    return await this.crypto.encrypt(args as never)
  }

  async decrypt(args: unknown): Promise<{ plaintext: number[] }> {
    return await this.crypto.decrypt(args as never)
  }

  async createHmac(args: unknown): Promise<{ hmac: number[] }> {
    return await this.crypto.createHmac(args as never)
  }

  // ── action history (no held/failed actions in this harness) ───────────
  async listActions(): Promise<{ actions: VaultActionRow[]; totalActions?: number }> {
    return { actions: [], totalActions: 0 }
  }

  async getStatusForTxids(): Promise<{ results?: { txid: string; status: string }[] }> {
    return { results: [] }
  }

  async abortAction(args: any): Promise<unknown> {
    const reference = args?.reference as string | undefined
    if (reference) this.pendingByReference.delete(reference)
    return {}
  }

  // ── listOutputs: the 'admin vault' basket only ─────────────────────────
  async listOutputs(args: any): Promise<{
    outputs: { outpoint: string; satoshis: number; customInstructions?: string; lockingScript?: string }[]
    totalOutputs?: number
    BEEF?: number[]
  }> {
    if (args?.basket !== 'admin vault') return { outputs: [], totalOutputs: 0 }
    const entries = [...this.basket.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    const offset = args.offset ?? 0
    const limit = args.limit ?? entries.length
    const page = entries.slice(offset, offset + limit)
    const outputs = page.map(([outpoint, o]) => ({
      outpoint,
      satoshis: o.satoshis,
      ...(args.includeCustomInstructions ? { customInstructions: o.customInstructions } : {}),
      ...(args.include === 'locking scripts' || args.include === 'entire transactions' ? { lockingScript: o.lockingScript } : {})
    }))
    let beef: number[] | undefined
    if (args.include === 'entire transactions') {
      const merged = new Beef()
      const seen = new Set<string>()
      for (const [outpoint] of page) {
        const txid = outpoint.slice(0, 64)
        if (seen.has(txid)) continue
        seen.add(txid)
        const tx = this.sourceTxByTxid.get(txid)
        if (tx) merged.mergeRawTx(tx.toBinary())
      }
      beef = merged.toBinary()
    }
    return { outputs, totalOutputs: entries.length, BEEF: beef }
  }

  // ── createAction / signAction: two-phase noSend -> sendWith ────────────
  async createAction(args: any): Promise<{
    txid?: string
    tx?: number[]
    signableTransaction?: { tx: number[]; reference: string }
    sendWithResults?: { txid?: string; status?: string }[]
  }> {
    if (args?.options?.sendWith) {
      const txid = (args.options.sendWith[0] as string).toLowerCase()
      const pending = this.pendingByTxid.get(txid)
      if (!pending) throw new Error(`FakeVaultWallet: no held transaction for sendWith ${txid}`)
      this.release(pending)
      return { sendWithResults: [{ txid, status: 'sending' }] }
    }

    const reference = `ref-${++this.refCounter}`
    let tx: Transaction
    const explicit = (args.outputs ?? []) as { satoshis: number; lockingScript: string; basket?: string; customInstructions?: string; tags?: string[] }[]
    const explicitMeta = explicit.map(o => ({ basket: o.basket, customInstructions: o.customInstructions, tags: o.tags }))

    if (Array.isArray(args?.inputs)) {
      // withdraw / re-lock: spend named vault outpoints.
      tx = new Transaction(args.version ?? 1)
      let inputTotal = 0
      for (const input of args.inputs as { outpoint: string; unlockingScriptLength: number }[]) {
        const [txid, voutStr] = input.outpoint.split('.')
        const vout = Number(voutStr)
        const sourceTx = this.sourceTxByTxid.get(txid)
        const stored = this.basket.get(input.outpoint)
        if (!sourceTx || !stored) throw new Error(`FakeVaultWallet: unknown vault outpoint ${input.outpoint}`)
        inputTotal += stored.satoshis
        tx.addInput({
          sourceTransaction: sourceTx,
          sourceOutputIndex: vout,
          sequence: 0xffffffff,
          unlockingScript: new UnlockingScript([])
        })
      }
      let explicitTotal = 0
      for (const o of explicit) {
        explicitTotal += o.satoshis
        tx.addOutput({ satoshis: o.satoshis, lockingScript: LockingScript.fromHex(o.lockingScript) })
      }
      const change = inputTotal - explicitTotal - FEE
      if (change > 0) {
        tx.addOutput({ satoshis: change, lockingScript: new P2PKH().lock(Utils.toArray('c1'.repeat(20), 'hex')) })
      }
    } else {
      // deposit: wallet-selected funding, explicit outputs, implicit change.
      const explicitTotal = explicit.reduce((sum, o) => sum + o.satoshis, 0)
      const fund = new Transaction()
      fund.addOutput({
        satoshis: explicitTotal + FEE + 9_500,
        lockingScript: new P2PKH().lock(Utils.toArray('c2'.repeat(20), 'hex'))
      })
      this.sourceTxByTxid.set(fund.id('hex'), fund)
      tx = new Transaction(args.version ?? 1)
      tx.addInput({ sourceTransaction: fund, sourceOutputIndex: 0, sequence: 0xffffffff, unlockingScript: new UnlockingScript([]) })
      for (const o of explicit) tx.addOutput({ satoshis: o.satoshis, lockingScript: LockingScript.fromHex(o.lockingScript) })
      tx.addOutput({ satoshis: 9_500, lockingScript: new P2PKH().lock(Utils.toArray('c3'.repeat(20), 'hex')) })
    }

    this.pendingByReference.set(reference, { tx, kind: Array.isArray(args?.inputs) ? 'spend' : 'deposit', explicitMeta })
    return { signableTransaction: { tx: tx.toAtomicBEEF(), reference } }
  }

  async signAction(args: any): Promise<{ txid?: string; tx?: number[] }> {
    const reference = args?.reference as string
    const pending = this.pendingByReference.get(reference)
    if (!pending) throw new Error(`FakeVaultWallet: no pending transaction for reference ${reference}`)
    for (const [index, spend] of Object.entries(args.spends ?? {}) as [string, { unlockingScript: string }][]) {
      pending.tx.inputs[Number(index)].unlockingScript = UnlockingScript.fromHex(spend.unlockingScript)
    }
    const txid = pending.tx.id('hex')
    if (args?.options?.noSend) {
      this.pendingByReference.delete(reference)
      this.pendingByTxid.set(txid, pending)
      return { txid, tx: pending.tx.toAtomicBEEF() }
    }
    this.pendingByReference.delete(reference)
    this.release(pending)
    return { txid, tx: pending.tx.toAtomicBEEF() }
  }

  /** Publish to the shared chain and apply the transaction's effect on this
   * wallet's OWN local basket store (consuming spent vault inputs, inserting
   * any new vault-basket explicit output — identified by the basket
   * requested at createAction time, exactly as the real toolbox would). */
  private release(pending: PendingTx): void {
    const { tx, explicitMeta } = pending
    const txid = this.chain.publish(tx)
    this.sourceTxByTxid.set(txid, tx)
    for (const input of tx.inputs) {
      const sourceTxid = (input.sourceTXID ?? input.sourceTransaction?.id('hex'))?.toLowerCase()
      if (sourceTxid) this.basket.delete(`${sourceTxid}.${input.sourceOutputIndex}`)
    }
    explicitMeta.forEach((meta, index) => {
      if (meta.basket !== 'admin vault') return
      const output = tx.outputs[index]
      this.basket.set(`${txid}.${index}`, {
        satoshis: output.satoshis,
        lockingScript: output.lockingScript.toHex(),
        customInstructions: meta.customInstructions,
        basket: 'admin vault',
        tags: meta.tags ?? [],
        spendable: true
      })
    })
  }

  // ── internalizeAction: chain recovery's insertion point ────────────────
  async internalizeAction(args: any): Promise<{ accepted: true }> {
    const tx = Transaction.fromAtomicBEEF(args.tx)
    const txid = tx.id('hex')
    if (!this.chain.isConfirmed(txid)) {
      throw new Error('FakeVaultWallet.internalizeAction: transaction is not confirmed (no usable chain-tracker proof)')
    }
    this.sourceTxByTxid.set(txid, tx)
    for (const output of args.outputs as { outputIndex: number; insertionRemittance?: { basket: string; customInstructions?: string; tags?: string[] } }[]) {
      const real = tx.outputs[output.outputIndex]
      this.basket.set(`${txid}.${output.outputIndex}`, {
        satoshis: real.satoshis,
        lockingScript: real.lockingScript.toHex(),
        customInstructions: output.insertionRemittance?.customInstructions,
        basket: output.insertionRemittance?.basket ?? '',
        tags: output.insertionRemittance?.tags ?? [],
        spendable: true
      })
    }
    return { accepted: true }
  }
}
