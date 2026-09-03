/**
 * Record a merkle proof the wallet fetched itself.
 *
 * The toolbox's own route (`updateProvenTxReqWithNewProvenTx`) needs a
 * proven_tx_req to hang the proof on, and normally every unproven transaction
 * has one. A payment whose first `internalizeAction` failed half-way and was
 * then retried down the toolbox's merge path does not: the merge adds the
 * output but never creates a req (toolbox 2.4.3, `mergedInternalize`). Such a
 * row is invisible to TaskCheckForProofs and used to make Refresh throw. With
 * no req, the proof is written directly: a proven_tx row (the toolbox's own
 * `findOrInsertProvenTx` shape) and the transaction promoted to `completed`.
 */
import type {
  TableProvenTx,
  TableProvenTxReq,
  TableTransaction
} from '@bsv/wallet-toolbox-mobile/out/src/storage/schema/tables'
import type { UpdateProvenTxReqWithNewProvenTxArgs } from '@bsv/wallet-toolbox-mobile/out/src/sdk/WalletStorage.interfaces'

export interface ProofStorage {
  findProvenTxReqs(args: {
    partial: { txid: string }
  }): Promise<Pick<TableProvenTxReq, 'provenTxReqId' | 'status' | 'attempts' | 'history'>[]>
  updateProvenTxReqWithNewProvenTx(args: UpdateProvenTxReqWithNewProvenTxArgs): Promise<unknown>
  findTransactions(args: {
    partial: { txid: string }
    noRawTx?: boolean
  }): Promise<Pick<TableTransaction, 'transactionId' | 'status'>[]>
  findProvenTxs(args: { partial: { txid: string } }): Promise<Pick<TableProvenTx, 'provenTxId'>[]>
  insertProvenTx(tx: TableProvenTx): Promise<number>
  updateTransaction(id: number, update: Partial<TableTransaction>): Promise<number>
}

/** The proven_tx columns a BUMP yields — see `provenTxFromBump`. */
export interface ProofFields {
  index: number
  height: number
  blockHash: string
  merklePath: number[]
  merkleRoot: string
}

export type RecordProofOutcome = 'via-req' | 'direct'

export async function recordProof(
  storage: ProofStorage,
  args: {
    txid: string
    proof: ProofFields
    /** Only called on the direct path: the proven_tx row needs the raw bytes and an internalized row may hold none. */
    fetchRawTx: () => Promise<number[]>
  }
): Promise<RecordProofOutcome> {
  const { txid, proof } = args
  const reqs = await storage.findProvenTxReqs({ partial: { txid } })
  if (reqs.length > 0) {
    const req = reqs[0]
    await storage.updateProvenTxReqWithNewProvenTx({
      provenTxReqId: req.provenTxReqId,
      status: req.status,
      txid,
      attempts: req.attempts,
      history: req.history,
      ...proof
    })
    return 'via-req'
  }

  const txs = await storage.findTransactions({ partial: { txid }, noRawTx: true })
  if (txs.length === 0) throw new Error('No record found for this transaction')

  const pending = txs.filter(t => t.status !== 'completed')
  if (pending.length === 0) return 'direct'

  let provenTxId = (await storage.findProvenTxs({ partial: { txid } }))[0]?.provenTxId
  if (provenTxId === undefined) {
    const now = new Date()
    provenTxId = await storage.insertProvenTx({
      created_at: now,
      updated_at: now,
      provenTxId: 0,
      txid,
      rawTx: await args.fetchRawTx(),
      ...proof
    })
  }
  for (const tx of pending) {
    await storage.updateTransaction(tx.transactionId, { status: 'completed', provenTxId })
  }
  return 'direct'
}
