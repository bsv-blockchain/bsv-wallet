/**
 * Nearby/offline rejected-receive NACK.
 *
 * Auto-send `{ type: 'resend_request', reason: 'bounced_offline' }` once per
 * txid. Request-again uses `force` so the user can still re-send after that.
 * `offline_nacks` is a KV map of txid → `{ nackSentAt }` so two mounted
 * screens (home + /pay) cannot spam the sender.
 */
import { sendControlMessage } from './control'

export const OFFLINE_NACKS_KEY = 'offline_nacks'

export type OfflineNackMap = Record<string, { nackSentAt: number }>

interface StorageLike {
  getKeyValue: (key: string) => Promise<string | undefined>
  setKeyValue: (key: string, value: string) => Promise<void>
}

type SendClient = { sendMessage(args: { recipient: string; messageBox: string; body: string }): Promise<unknown> }

/** In-process lock so Home and Pay cannot both auto-send the same txid. */
const sending = new Set<string>()

export async function readOfflineNacks(storage: StorageLike): Promise<OfflineNackMap> {
  try {
    const raw = await storage.getKeyValue(OFFLINE_NACKS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: OfflineNackMap = {}
    for (const [txid, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!txid) continue
      if (typeof value === 'number' && Number.isFinite(value)) {
        out[txid] = { nackSentAt: value }
        continue
      }
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const at = (value as { nackSentAt?: unknown }).nackSentAt
        if (typeof at === 'number' && Number.isFinite(at)) out[txid] = { nackSentAt: at }
      }
    }
    return out
  } catch {
    return {}
  }
}

export async function sendBouncedOfflineNack(args: {
  client: SendClient
  storage: StorageLike
  txid: string
  recipient: string
  force?: boolean
}): Promise<boolean> {
  const { client, storage, txid, recipient, force } = args
  if (!txid || !recipient) return false
  if (!force) {
    if (sending.has(txid)) return false
    const existing = await readOfflineNacks(storage)
    if (existing[txid]) return false
  }
  sending.add(txid)
  try {
    await sendControlMessage(client, {
      recipient,
      message: { type: 'resend_request', txid, reason: 'bounced_offline' }
    })
    const map = await readOfflineNacks(storage)
    map[txid] = { nackSentAt: Date.now() }
    await storage.setKeyValue(OFFLINE_NACKS_KEY, JSON.stringify(map))
    return true
  } finally {
    sending.delete(txid)
  }
}

export async function nackRejectedReceived(args: {
  client: SendClient
  storage: StorageLike
  rows: { txid: string; senderIdentityKey: string | null }[]
}): Promise<void> {
  for (const row of args.rows) {
    if (!row.senderIdentityKey) continue
    try {
      await sendBouncedOfflineNack({
        client: args.client,
        storage: args.storage,
        txid: row.txid,
        recipient: row.senderIdentityKey
      })
    } catch {
      // Best-effort auto NACK. Request again is the user's retry.
    }
  }
}
