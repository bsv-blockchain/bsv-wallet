import { decodeSession } from '../../../packages/expo-wallet-toolbox/core/localpay/session'
import {
  verify,
  sign,
  key,
  randomId,
  serviceUrl,
  type Signed,
  type Rpc,
  type Invite,
  type MerchantRequest,
  type Receipt,
  type Signer
} from '../../../packages/expo-wallet-toolbox/core/pos/protocol'
import type { PaymentFrame } from '../../../packages/expo-wallet-toolbox/core/localpay/codec'
export interface Cashier {
  identity: string
  name: string
  state: 'pending' | 'active' | 'revoked'
  invite: string
}
export interface Sale {
  request: Signed<MerchantRequest>
  frame?: SerializedFrame
  receipt?: Signed<Receipt>
}
export interface State {
  invites: Record<string, Signed<Invite>>
  cashiers: Record<string, Cashier>
  sales: Record<string, Sale>
  nonces: Record<string, number>
}
export type SerializedFrame = Omit<PaymentFrame, 'transaction'> & { transaction: number[] }
export interface Store {
  load(): Promise<State>
  save(state: State): Promise<void>
}
export const emptyState = (): State => ({ invites: {}, cashiers: {}, sales: {}, nonces: {} })
export interface ServiceDeps {
  wallet: Signer
  merchant: string
  name: string
  url: string
  chain: string
  store: Store
  // MUST validate destination, amount, BEEF/SPV and merchant-wallet acceptance.
  accept(frame: PaymentFrame, amount: number): Promise<string>
}
export class PosService {
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private deps: ServiceDeps) {
    key(deps.merchant)
    serviceUrl(deps.url)
  }
  call(request: Signed<Rpc>): Promise<unknown> {
    const job = this.queue.then(() => this.handle(request))
    this.queue = job.catch(() => {})
    return job
  }
  private async handle(request: Signed<Rpc>): Promise<unknown> {
    const p = await verify(request)
    if (
      p.version !== 1 ||
      typeof p.method !== 'string' ||
      !p.body ||
      typeof p.body !== 'object' ||
      !/^[a-f0-9]{32}$/.test(p.nonce) ||
      !Number.isSafeInteger(p.time) ||
      Math.abs(Date.now() - p.time) > 60000
    )
      throw new Error('Invalid or expired request')
    const caller = key(request.identityKey),
      owner = caller === key(this.deps.merchant)
    const state = await this.deps.store.load()
    const nonce = caller + ':' + p.nonce
    if (state.nonces[nonce]) throw new Error('Request already used')
    for (const [n, time] of Object.entries(state.nonces)) if (Date.now() - time > 120000) delete state.nonces[n]
    state.nonces[nonce] = Date.now()
    await this.deps.store.save(state)
    const text = (v: unknown, limit = 80) => {
      if (typeof v !== 'string' || !v.trim() || v.length > limit) throw new Error('Invalid field')
      return v.trim()
    }
    const ownerOnly = () => {
      if (!owner) throw new Error('Merchant authorization required')
    }
    const active = () => {
      if (state.cashiers[caller]?.state !== 'active') throw new Error('Cashier access is not active')
    }
    const save = async (result: unknown) => {
      await this.deps.store.save(state)
      return result
    }
    if (p.method === 'info')
      return {
        merchant: this.deps.merchant,
        name: this.deps.name,
        chain: this.deps.chain,
        cashier: state.cashiers[caller] ?? null
      }
    if (p.method === 'invite') {
      ownerOnly()
      const id = randomId()
      const invite = await sign(this.deps.wallet, {
        kind: 'invite' as const,
        merchant: key(this.deps.merchant),
        name: this.deps.name,
        service: serviceUrl(this.deps.url),
        chain: this.deps.chain,
        id,
        expires: Date.now() + 10 * 60000
      })
      state.invites[id] = invite
      return save(invite)
    }
    if (p.method === 'enroll') {
      const invitation = state.invites[text(p.body.invite)]
      if (!invitation || invitation.payload.expires < Date.now()) throw new Error('Enrollment code expired')
      if (state.cashiers[caller]?.state === 'active') return state.cashiers[caller]
      const cashier: Cashier = {
        identity: caller,
        name: text(p.body.name),
        state: 'pending',
        invite: invitation.payload.id
      }
      state.cashiers[caller] = cashier
      return save(cashier)
    }
    if (p.method === 'cashiers') {
      ownerOnly()
      return Object.values(state.cashiers)
    }
    if (p.method === 'approve' || p.method === 'revoke') {
      ownerOnly()
      const cashier = state.cashiers[key(p.body.cashier)]
      if (!cashier) throw new Error('Cashier not found')
      if (p.method === 'approve') {
        const invitation = state.invites[cashier.invite]
        if (!invitation || invitation.payload.expires < Date.now())
          throw new Error('Enrollment expired; scan a new code')
        delete state.invites[cashier.invite]
      }
      cashier.state = p.method === 'approve' ? 'active' : 'revoked'
      return save(cashier)
    }
    if (p.method === 'sales') {
      if (!owner) active()
      return Object.values(state.sales)
        .filter(s => owner || s.request.payload.cashier === caller)
        .map(s => ({ request: s.request, receipt: s.receipt, pending: !!s.frame && !s.receipt }))
    }
    if (p.method === 'invoice') {
      active()
      const sessionText = text(p.body.session, 4096),
        session = decodeSession(sessionText)
      if (key(session.identityKey) !== key(this.deps.merchant) || !session.amount || session.asset)
        throw new Error('Invalid merchant payment session')
      const id = randomId()
      const request = await sign(this.deps.wallet, {
        kind: 'payment' as const,
        merchant: key(this.deps.merchant),
        name: this.deps.name,
        cashier: caller,
        invoice: id,
        chain: this.deps.chain,
        expires: Date.now() + 5 * 60000,
        session: sessionText
      })
      state.sales[id] = { request }
      return save(request)
    }
    if (p.method === 'status' || p.method === 'settle') {
      active()
      const sale = state.sales[text(p.body.invoice)]
      if (!sale || sale.request.payload.cashier !== caller) throw new Error('Invoice not found')
      if (p.method === 'status') return { receipt: sale.receipt ?? null, pending: !!sale.frame }
      const f = p.body.frame as SerializedFrame
      const session = decodeSession(sale.request.payload.session)
      if (
        !f ||
        f.kind !== 'bsv' ||
        f.token !== undefined ||
        f.version !== 5 ||
        !Array.isArray(f.transaction) ||
        !f.transaction.length ||
        f.transaction.length > 2000000 ||
        !f.transaction.every(b => Number.isInteger(b) && b >= 0 && b <= 255) ||
        !Number.isSafeInteger(f.outputIndex) ||
        f.outputIndex < 0 ||
        f.derivationPrefix !== session.derivationPrefix ||
        f.derivationSuffix !== session.derivationSuffix
      )
        throw new Error('Payment does not match invoice')
      key(f.senderIdentityKey)
      if (sale.frame && JSON.stringify(sale.frame) !== JSON.stringify(f))
        throw new Error('A different payment is already associated with this invoice')
      if (sale.receipt) return sale.receipt
      if (!sale.frame && sale.request.payload.expires <= Date.now()) throw new Error('Invoice expired')
      // Persist before touching the wallet. A timeout remains uncertain and retryable
      // with these exact bytes; never report a safe-to-abort decline after forwarding.
      sale.frame = f
      await this.deps.store.save(state)
      const txid = await this.deps.accept({ ...f, transaction: Uint8Array.from(f.transaction) }, session.amount!)
      if (!/^[0-9a-f]{64}$/i.test(txid)) throw new Error('Wallet returned an invalid transaction identity')
      sale.receipt = await sign(this.deps.wallet, {
        invoice: sale.request.payload.invoice,
        txid,
        amount: session.amount!,
        status: 'accepted' as const
      })
      return save(sale.receipt)
    }
    throw new Error('Unsupported request')
  }
}
