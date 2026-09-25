/**
 * The app-owned recovery-critical rows that ride alongside a pushed sync chunk, as the
 * additive `appData` envelope field (see codec.ts's encodeChunk/decodeEntry).
 *
 * XR-011: `codec.ts`'s twelve CHUNK_ENTITIES are all toolbox-owned tables — nothing here ever
 * touches key_value_store, so a receiver's acknowledged-but-not-yet-internalized Nearby/QR
 * PaymentFrame (localpay_pending) and an outbound PeerPay token's delivery checkpoint
 * (peerpay_outbox) were never backed up at all: a device loss before internalize/delivery
 * completed stranded them permanently, even with a perfect seed+backup restore of everything
 * else. XR-055 adds a third row, the durable issued-conventional-receive-date history
 * (pay/receiveHistory.ts), for the same reason: it also lives only in key_value_store.
 *
 * This module is the ONLY place these rows cross from local storage into the backup log and
 * back. It deliberately knows nothing about how to internalize a payment, retry a delivery,
 * or sweep an address — `applyAppData` does exactly one thing, write rows back to
 * key_value_store, so a replayed row is picked up by the SAME existing consumers (the
 * background pending-queue effect, the outbox's own retry UI, the recovery sweep) through
 * their own existing guards, exactly as if this device had written the row itself while
 * briefly offline. Nothing here ever calls internalizeAction, broadcasts, or releases an
 * input.
 *
 * Deferred out of this pass (see XR-011's ledger row): `offline_actions` and
 * `token_linkage_payloads` are real SQL tables, not key_value_store blobs — replaying them
 * needs a userId remap (their FK is device-local) and, for offline_actions, a decision on
 * how a restored row's local `seq` should interleave with whatever this fresh device's own
 * autoincrement has already assigned. Both are tractable but are a separate, larger change
 * from the three KV rows here, which is why they are not included yet.
 *
 * KNOWN, STILL-OPEN GAP (see XR-011's reviewer follow-up): a row written here is only ever
 * actually PERSISTED to the backup log on a push whose CHUNK already carries a real toolbox-
 * entity change — see push.ts's own comment at its `captureAppDataSnapshot` call and
 * codec.ts's encodeChunk docs for why (an appData-only entry, with every entity array empty,
 * would trip the toolbox's own processSyncChunk completion sentinel for a downstream reader
 * that doesn't yet understand this field). That means the row's own headline scenario — an
 * acknowledged Nearby/QR payment, a PeerPay delivery checkpoint, or an issued receive date,
 * with NOTHING ELSE touching an entity table in that same window — is NOT covered: the row
 * stays local-only until some unrelated entity-bearing push happens to close a later window,
 * which may never occur before the device is lost. This is pinned end-to-end (not merely at
 * the pushOnce-unit level) by
 * __tests__/backup/appDataIsolatedActivity.test.ts. Closing it for real needs either a
 * dedicated appData-only log-entry shape — safe only once every device in the fleet is known
 * to run a build that understands it — or a separate backup-server channel outside the
 * per-device chunk log; both are wire/server changes shared with other devices, not a
 * same-device code fix, so they are recorded here as an open design delta rather than
 * attempted.
 */
import { OUTBOX_KEY } from '../peerpay/outbox'
import { PENDING_KEY } from '../localpay/pending'
import { getIssuedDates, setIssuedDates } from '../pay/receiveHistory'
import type { AppDataSnapshot } from './codec'

export interface KVStorage {
  getKeyValue (k: string): Promise<string | undefined>
  setKeyValue (k: string, v: string): Promise<void>
}

/** True for `undefined` or a snapshot carrying nothing at all — the common "nothing queued,
 * nothing to add" case, which must produce no `appData` field at all (see codec.ts's
 * encodeChunk docs on why an unsealed/appData-less chunk must serialise byte-for-byte as the
 * old-format envelope). */
export function isEmptyAppData (appData: AppDataSnapshot | undefined): boolean {
  return (
    appData == null ||
    (appData.localpayPending === undefined &&
      appData.peerpayOutbox === undefined &&
      (appData.receiveIssuedDates?.length ?? 0) === 0)
  )
}

/**
 * Read the current value of every app-owned recovery-critical row, straight off local
 * storage, for pushOnce to fold into the same envelope as whatever chunk it is about to
 * send. Never called on its own cadence — see codec.ts's encodeChunk docs on why appData
 * only ever rides an already-non-empty chunk.
 */
export async function captureAppDataSnapshot (storage: KVStorage): Promise<AppDataSnapshot> {
  const [localpayPending, peerpayOutbox, receiveIssuedDates] = await Promise.all([
    storage.getKeyValue(PENDING_KEY),
    storage.getKeyValue(OUTBOX_KEY),
    getIssuedDates(storage)
  ])
  const snapshot: AppDataSnapshot = {}
  if (localpayPending !== undefined) snapshot.localpayPending = localpayPending
  if (peerpayOutbox !== undefined) snapshot.peerpayOutbox = peerpayOutbox
  if (receiveIssuedDates.length > 0) snapshot.receiveIssuedDates = receiveIssuedDates
  return snapshot
}

/**
 * Apply a decoded snapshot to local storage. The ONLY effect of a restore replaying appData
 * — three plain key_value_store writes, nothing else. Skips a field the snapshot did not
 * carry (rather than overwriting with nothing), so replaying an OLDER chunk's appData after
 * a newer one already landed (e.g. re-running an interrupted restore) can never regress a
 * row that a later chunk already updated in this same pass.
 */
export async function applyAppData (storage: KVStorage, snapshot: AppDataSnapshot): Promise<void> {
  if (snapshot.localpayPending !== undefined) await storage.setKeyValue(PENDING_KEY, snapshot.localpayPending)
  if (snapshot.peerpayOutbox !== undefined) await storage.setKeyValue(OUTBOX_KEY, snapshot.peerpayOutbox)
  if (snapshot.receiveIssuedDates !== undefined && snapshot.receiveIssuedDates.length > 0) {
    await setIssuedDates(storage, snapshot.receiveIssuedDates)
  }
}

/** Parses a KV row's raw JSON text into an array of plain objects, never throwing — a
 * corrupt or missing blob merges as if it were empty rather than failing the whole restore. */
function parseJsonArray (raw: string | undefined): Array<Record<string, unknown>> { // eslint-disable-line @typescript-eslint/array-type
  if (raw === undefined) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : [] // eslint-disable-line @typescript-eslint/array-type
  } catch {
    return []
  }
}

/**
 * Union two same-shaped `id`-keyed JSON-array KV blobs (localpay_pending / peerpay_outbox),
 * keeping every distinct entry from both sides. Used only when restoring more than one
 * device's own backup log into the same storage (XR-015): each device's own queue is an
 * independent, non-overlapping history exactly like the toolbox's own entity tables are —
 * restoring only the highest-ranked device's snapshot would silently drop whatever a second
 * device alone was still holding (e.g. a Nearby payment received on a phone that was never
 * the "primary" device in the manifest).
 *
 * On an id collision the FIRST side's entry wins, matching restoreOnImport's own device
 * iteration order (primary device folded in first) — irrelevant in practice, since two
 * devices sharing a seed cannot mint the same PaymentPending/OutboxEntry id (both are
 * `${timestamp}_${keyPrefix}`-derived per device), but keeps the merge total rather than
 * throwing on a theoretical collision.
 */
function mergeJsonArrayById (a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  const merged = new Map<string, Record<string, unknown>>()
  for (const item of [...parseJsonArray(a), ...parseJsonArray(b)]) {
    const id = typeof item.id === 'string' ? item.id : JSON.stringify(item)
    if (!merged.has(id)) merged.set(id, item)
  }
  return JSON.stringify([...merged.values()])
}

/**
 * Merge two snapshots — see mergeJsonArrayById for why this is a union rather than a
 * last-write-wins overwrite. `restoreOnImport` folds every device's own final appData
 * together this way before the single `applyAppData` call that actually reaches storage, so
 * no one device's snapshot can clobber another's.
 */
export function mergeAppData (a: AppDataSnapshot | undefined, b: AppDataSnapshot | undefined): AppDataSnapshot {
  return {
    localpayPending: mergeJsonArrayById(a?.localpayPending, b?.localpayPending),
    peerpayOutbox: mergeJsonArrayById(a?.peerpayOutbox, b?.peerpayOutbox),
    receiveIssuedDates:
      a?.receiveIssuedDates === undefined && b?.receiveIssuedDates === undefined
        ? undefined
        : [...new Set([...(a?.receiveIssuedDates ?? []), ...(b?.receiveIssuedDates ?? [])])].sort()
  }
}
