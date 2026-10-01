import AsyncStorage from '@react-native-async-storage/async-storage'
import type { PushAdapter } from './types'

/**
 * What this device has registered, per identity: a JSON map from identity key to
 * `<host>|<token>`. One entry per profile, because every profile of the wallet
 * registers this install's token under its own identity. Holds the token and
 * identity keys in clear AsyncStorage, so Delete Wallet removes it.
 */
export const PUSH_REGISTRATION_KEY = 'push_registration_v1'

/**
 * The identity whose registration was written last. A server that keeps one
 * identity per token (every server before the multi-identity change) hands the
 * token to whoever registered most recently, so that identity is the one the
 * device is actually reachable as. Kept next to the map rather than inside it so
 * the map stays a plain identity -> `host|token` record.
 */
export const PUSH_REGISTRATION_OWNER_KEY = 'push_registration_owner_v1'

/**
 * How long one unregister request may run. It is awaited by Delete Wallet and by
 * profile removal, neither of which may stall on a server that does not answer.
 */
export const PUSH_UNREGISTER_TIMEOUT_MS = 8_000

export interface RegisterDeviceClient {
  registerDevice(
    params: { fcmToken: string; platform?: 'ios' | 'android'; deviceId?: string },
    overrideHost?: string
  ): Promise<unknown>
}

export interface PushMarkerStorage {
  getItem(k: string): Promise<string | null>
  setItem(k: string, v: string): Promise<void>
  removeItem(k: string): Promise<void>
}

export type SyncResult = 'registered' | 'unchanged' | 'skipped' | 'failed'

export interface PushTarget {
  index: number
  identityKey: string
  /** This profile's MessageBox host, or undefined when the user turned MessageBox off for it. */
  host: string | undefined
  /** The open profile. It is registered last (see syncPushRegistrations). */
  active?: boolean
  makeClient: (host: string) => RegisterDeviceClient
  /**
   * Asked again right before this target's network call, and once more when the
   * answer comes back, inside the same step that would record it. False drops the
   * target: the profile was removed, or the build that owns this run was
   * replaced, while the run was under way. A registration that lands after that
   * is not remembered (see syncOne).
   */
  isCurrent?: () => boolean
  /**
   * The profile is gone for good, as opposed to its build merely being replaced
   * by another's. A registration that lands for a removed profile is withdrawn
   * again: the removal's own unregister ran before there was anything to
   * withdraw, and nothing would ever ask again.
   */
  isRemoved?: () => boolean
  /** Signs in as this identity to withdraw a registration that landed late (see `isRemoved`). */
  post?: PushPost
}

export interface TargetResult {
  index: number
  result: SyncResult
}

type Markers = Record<string, string>

/** An unreadable, legacy or foreign value reads as "nothing registered": the next sync registers again. */
function parseMarkers(raw: string | null): Markers {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const markers: Markers = {}
    for (const [identity, value] of Object.entries(parsed)) {
      if (typeof value === 'string') markers[identity] = value
    }
    return markers
  } catch {
    return {}
  }
}

/** `<host>|<token>`. An FCM token never contains a '|', so the last one splits them. */
function splitMarker(marker: string): { host: string; token: string } | undefined {
  const at = marker.lastIndexOf('|')
  if (at <= 0 || at === marker.length - 1) return undefined
  return { host: marker.slice(0, at), token: marker.slice(at + 1) }
}

/**
 * Marker updates are read-modify-write on two keys, and a sync run, a removal and
 * Delete Wallet can all write at once. Run them one at a time so no update is
 * lost to another's stale read. `change` returns what to write, or null to leave
 * storage alone.
 */
let markerQueue: Promise<unknown> = Promise.resolve()
function updateMarkers(
  storage: PushMarkerStorage,
  change: (markers: Markers, owner: string | null) => { markers: Markers; owner: string | null } | null
): Promise<void> {
  const run = markerQueue.then(async () => {
    const markers = parseMarkers(await storage.getItem(PUSH_REGISTRATION_KEY))
    const owner = await storage.getItem(PUSH_REGISTRATION_OWNER_KEY)
    const next = change(markers, owner)
    if (!next) return
    await storage.setItem(PUSH_REGISTRATION_KEY, JSON.stringify(next.markers))
    if (next.owner === null) await storage.removeItem(PUSH_REGISTRATION_OWNER_KEY)
    else if (next.owner !== owner) await storage.setItem(PUSH_REGISTRATION_OWNER_KEY, next.owner)
  })
  markerQueue = run.catch(() => {})
  return run
}

/** The markers, read in line with the updates above so a read never sees half of one. */
function readMarkers(storage: PushMarkerStorage): Promise<Markers> {
  const run = markerQueue.then(async () => parseMarkers(await storage.getItem(PUSH_REGISTRATION_KEY)))
  markerQueue = run.catch(() => {})
  return run
}

/** Every identity this device holds a registration marker for. Never throws: an unreadable store reads as none. */
export async function readPushMarkerIdentities(storage: PushMarkerStorage = AsyncStorage): Promise<string[]> {
  try {
    return Object.keys(await readMarkers(storage))
  } catch {
    return []
  }
}

/** Only the error's message is logged, with the token, identity key and host cut out of it. */
function redactedMessage(e: unknown, secrets: ReadonlyArray<string | null | undefined>): string {
  const raw = e instanceof Error ? e.message : String(e)
  return secrets.reduce<string>((text, secret) => (secret ? text.split(secret).join('[redacted]') : text), raw)
}

/**
 * Make sure the MessageBox host knows this device's FCM token for every profile.
 * Idempotent: the last successful `host|token` is remembered per identity, so the
 * common case is no network call at all. Never throws — push is an enhancement
 * and must not take any caller down with it.
 *
 * Order matters. Inactive profiles go first and the active one last, so that on a
 * server that still keeps one identity per token the active profile ends up the
 * owner, as it was when only the active profile registered. For the same reason
 * the active profile registers again whenever it is not the identity registered
 * last: after a switch its own marker is intact, but the server may have handed
 * the token to the profile just left, and an unchanged marker would never say so.
 * Against a server that keeps one row per (identity, token) that re-registration
 * is an idempotent upsert.
 *
 * A target that fails does not stop the others: its marker is left as it was, so
 * the next trigger retries it.
 */
export async function syncPushRegistrations(args: {
  adapter: PushAdapter | undefined
  targets: readonly PushTarget[]
  storage?: PushMarkerStorage
}): Promise<TargetResult[]> {
  const { adapter, targets } = args
  const storage = args.storage ?? AsyncStorage
  if (!adapter || targets.length === 0) return targets.map(t => ({ index: t.index, result: 'skipped' }))

  let token: string | null | undefined
  try {
    if ((await adapter.getPermission()) !== 'granted') return targets.map(t => ({ index: t.index, result: 'skipped' }))
    token = await adapter.getToken()
  } catch (e) {
    console.warn('[push] registerDevice failed: ' + redactedMessage(e, [token]))
    return targets.map(t => ({ index: t.index, result: 'failed' }))
  }
  if (!token) return targets.map(t => ({ index: t.index, result: 'skipped' }))

  const ordered = [...targets].sort((a, b) => Number(!!a.active) - Number(!!b.active) || a.index - b.index)
  const results: TargetResult[] = []
  for (const target of ordered) {
    results.push({ index: target.index, result: await syncOne(target, token, adapter, storage) })
  }
  return results
}

async function syncOne(
  target: PushTarget,
  token: string,
  adapter: PushAdapter,
  storage: PushMarkerStorage
): Promise<SyncResult> {
  const { host, identityKey } = target
  if (!host) return 'skipped'
  try {
    const marker = `${host}|${token}`
    const [markers, owner] = await Promise.all([
      storage.getItem(PUSH_REGISTRATION_KEY).then(parseMarkers),
      storage.getItem(PUSH_REGISTRATION_OWNER_KEY)
    ])
    if (markers[identityKey] === marker && !(target.active && owner !== identityKey)) return 'unchanged'
    if (target.isCurrent && !target.isCurrent()) return 'skipped'
    await target.makeClient(host).registerDevice({ fcmToken: token, platform: adapter.platform }, host)
    // The answer took time, and the profile may have been removed or the wallet
    // deleted meanwhile. Asked again INSIDE the marker update, which a removal's
    // unregister also reads through: either this write lands first and the
    // unregister then sees it, or the unregister ran first and this finds the
    // profile gone. Writing regardless would bring back a marker (and, after
    // Delete Wallet, the token and identity in clear text) that nothing withdraws.
    let late = false
    await updateMarkers(storage, markers => {
      if (target.isCurrent && !target.isCurrent()) {
        late = true
        return null
      }
      return { markers: { ...markers, [identityKey]: marker }, owner: identityKey }
    })
    if (late) {
      await settleLateRegistration(target, host, token, storage)
      return 'skipped'
    }
    return 'registered'
  } catch (e) {
    // Only the error's message is logged, so a failure is diagnosable without
    // the log ever carrying the token or the identity key. A message that
    // happens to quote the token, the identity key or the host has them cut out.
    console.warn('[push] registerDevice failed: ' + redactedMessage(e, [token, identityKey, host]))
    return 'failed'
  }
}

/** One HTTP answer. `post` resolves for any status the server sent and rejects only when no answer came. */
export type PushPost = (url: string, body: { fcmToken: string }) => Promise<{ status: number }>

export type UnregisterResult =
  /** The server removed (or never had) this identity's registration. */
  | 'unregistered'
  /** A server that has no such endpoint yet. Nothing to withdraw there. */
  | 'unsupported'
  /** This device never registered the identity, so there was nothing to ask. */
  | 'skipped'
  | 'failed'

/** A server from before the endpoint existed answers with one of these. */
const UNSUPPORTED_STATUSES: readonly number[] = [404, 405, 501]

/** Loopback hosts may use plain HTTP, like the MessageBox client allows; everything else needs TLS. */
function isLoopback(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h)
}

/** The MessageBox host's `/unregisterDevice` URL. Throws for a host the client itself would refuse. */
function unregisterUrl(host: string): string {
  const url = new URL(host)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
    throw new TypeError('MessageBox host requires HTTPS except on localhost')
  }
  if (url.username || url.password || url.search || url.hash) throw new TypeError('MessageBox host is not a plain URL')
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}/unregisterDevice`
}

/**
 * One withdrawal request. `refused` is a host this client will not talk to: no
 * later attempt could do any better, unlike `failed`, where the server did not
 * answer or answered with an error.
 */
type Withdrawal = Exclude<UnregisterResult, 'skipped'> | 'refused'

async function withdraw(
  registered: { host: string; token: string },
  identityKey: string,
  post: PushPost
): Promise<Withdrawal> {
  const secrets = [registered.token, identityKey, registered.host]
  let url: string
  try {
    url = unregisterUrl(registered.host)
  } catch (e) {
    console.warn('[push] unregisterDevice failed: ' + redactedMessage(e, secrets))
    return 'refused'
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timed out')), PUSH_UNREGISTER_TIMEOUT_MS)
  })
  try {
    const { status } = await Promise.race([post(url, { fcmToken: registered.token }), timeout])
    if (status >= 200 && status < 300) return 'unregistered'
    if (UNSUPPORTED_STATUSES.includes(status)) return 'unsupported'
    console.warn(`[push] unregisterDevice failed: HTTP ${status}`)
    return 'failed'
  } catch (e) {
    console.warn('[push] unregisterDevice failed: ' + redactedMessage(e, secrets))
    return 'failed'
  } finally {
    clearTimeout(timer)
  }
}

/**
 * A registration answered after its profile was removed (`isRemoved`), so the
 * removal's unregister found nothing to withdraw. Withdraw it now, from the host
 * and token it was just registered under. If that cannot be done, the marker is
 * written after all so the retry has something to work from.
 *
 * A build that was merely replaced, or a wallet being deleted, is not a removal:
 * the profile is still wanted (the next build registers it again, which is
 * idempotent) or nothing may be left behind at all, so nothing is written and
 * nothing is sent.
 */
async function settleLateRegistration(
  target: PushTarget,
  host: string,
  token: string,
  storage: PushMarkerStorage
): Promise<void> {
  if (!target.isRemoved?.()) return
  const { identityKey } = target
  const outcome = target.post ? await withdraw({ host, token }, identityKey, target.post) : 'failed'
  if (outcome !== 'failed') return
  try {
    await updateMarkers(storage, (markers, owner) => ({
      markers: { ...markers, [identityKey]: `${host}|${token}` },
      owner
    }))
  } catch (e) {
    console.warn('[push] could not keep a registration for a retry: ' + redactedMessage(e, [token, identityKey, host]))
  }
}

/**
 * Withdraw one identity's device registration, for a removed profile or a wallet
 * being deleted. Best effort: it never throws, and it works from the marker, so
 * it asks exactly the host and token this device registered under — a host
 * changed since then, or a rotated token, still gets the right request.
 *
 * `POST /unregisterDevice` only exists on a server with the multi-identity
 * change. An older one answers 404 (or 405/501), which is reported as
 * `unsupported` and is not a failure: its single row for the token belongs to
 * whichever identity registered last and is not this identity's to remove.
 *
 * The marker is the record of what is still registered, so it is dropped only
 * once nothing is: on `unregistered` and `unsupported`, and when there was no
 * usable marker to begin with (`skipped`). On `failed` (offline, a timeout, an
 * error answer) it stays, and whoever can sign as the identity again asks once
 * more — the next build for a removed profile (see createProfilePush's
 * `retired`). Delete Wallet sweeps the markers afterwards whatever happened,
 * since after it there is no seed left to retry with. A host this client would
 * refuse is dropped too: no retry could ever use it.
 */
export async function unregisterPushIdentity(args: {
  identityKey: string
  post: PushPost
  storage?: PushMarkerStorage
}): Promise<UnregisterResult> {
  const { identityKey, post } = args
  const storage = args.storage ?? AsyncStorage
  let entry: string | undefined
  try {
    entry = (await readMarkers(storage))[identityKey]
  } catch (e) {
    console.warn('[push] unregisterDevice failed: ' + redactedMessage(e, [identityKey]))
    return 'failed'
  }
  const registered = entry === undefined ? undefined : splitMarker(entry)
  if (!registered) {
    // Never registered from here, or a marker nothing can read: either way nothing to ask.
    await forgetPushMarker(identityKey, storage)
    return 'skipped'
  }
  const outcome = await withdraw(registered, identityKey, post)
  if (outcome !== 'failed') await forgetPushMarker(identityKey, storage)
  return outcome === 'refused' ? 'failed' : outcome
}

/** Drop one identity's marker (and the owner record, if it points at that identity). Never throws. */
export async function forgetPushMarker(identityKey: string, storage: PushMarkerStorage = AsyncStorage): Promise<void> {
  try {
    await updateMarkers(storage, (markers, owner) => {
      if (!(identityKey in markers) && owner !== identityKey) return null
      const { [identityKey]: _gone, ...rest } = markers
      return { markers: rest, owner: owner === identityKey ? null : owner }
    })
  } catch (e) {
    console.warn('[push] could not clear a registration marker: ' + redactedMessage(e, [identityKey]))
  }
}
