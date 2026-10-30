/**
 * Launch registry (spec 7.5). Pulls launch URIs from Kotlin's destructive `takeLaunches()`, parses them, and keeps
 * the live records the router looks up by hello MAC (`matchHello`, consumes nothing) or by epoch (`take`, marks the
 * record used before anything else can fail). Expiry is counted on the monotonic `elapsedRealtime()` from the Kotlin
 * age, so no page or wall clock is involved. Burnt, expired and evicted epochs are tombstoned for 10 minutes so a later
 * `takeLaunches()` that returns the same URI again (a JS reload, a duplicate) cannot re-create the record.
 *
 * `k`, the epoch and the URI are secret-like: nothing here logs, and invalid URIs are dropped silently.
 */
import type {
  HelloQuery,
  LaunchesPort,
  LaunchRecordView
} from '@bsv/expo-wallet-toolbox/core/bridge/loopback/routerTypes'
import {
  helloMac,
  parseLaunchUri,
  timingSafeEqualB64u
} from '@bsv/expo-wallet-toolbox/core/bridge/loopback/launchProof'
import type { BsvAndroidBridgeNative } from '../native'

export const LAUNCH_LIFE_MS = 120_000
export const LAUNCH_CAPACITY = 32
export const TOMBSTONE_MS = 600_000

export interface LaunchRegistry extends LaunchesPort {
  /** Pull `takeLaunches()` and store every new, valid, untombstoned record. */
  ingest(): void
  /** A connect with this epoch is (or is no longer) parked: a parked record is never evicted. */
  markParked(epoch: string, parked: boolean): void
  /** True while an unused, unexpired record exists. */
  hasLive(): boolean
  /** Expiry (on the `elapsedRealtime` clock) of the most recently created record, even if since used. */
  lastExpiresAt(): number | undefined
}

interface Rec {
  epoch: string
  k: Uint8Array
  n: string
  expiresAt: number
  used: boolean
  parked: boolean
}

export function createLaunchRegistry(deps: {
  native: Pick<BsvAndroidBridgeNative, 'takeLaunches' | 'elapsedRealtime'>
  scheme: string
}): LaunchRegistry {
  const { native, scheme } = deps
  const records = new Map<string, Rec>()
  const tombstones = new Map<string, number>()
  let lastExpiry: number | undefined

  const tombstone = (epoch: string, now: number) => void tombstones.set(epoch, now + TOMBSTONE_MS)
  const drop = (rec: Rec) => {
    rec.k.fill(0)
    records.delete(rec.epoch)
  }
  const prune = (now: number) => {
    for (const [epoch, until] of Array.from(tombstones)) if (until <= now) tombstones.delete(epoch)
    for (const rec of Array.from(records.values())) {
      if (rec.parked) continue
      if (rec.used) drop(rec)
      else if (now >= rec.expiresAt) {
        tombstone(rec.epoch, now)
        drop(rec)
      }
    }
  }
  const live = (rec: Rec, now: number) => !rec.used && now < rec.expiresAt
  const view = (rec: Rec): LaunchRecordView => ({ epoch: rec.epoch, k: Uint8Array.from(rec.k), n: rec.n })

  return {
    ingest() {
      const taken = native.takeLaunches()
      const now = native.elapsedRealtime()
      prune(now)
      for (const l of taken) {
        const parsed = parseLaunchUri(l.uri, scheme)
        if (!parsed) continue
        if (records.has(parsed.epoch) || tombstones.has(parsed.epoch)) continue
        const expiresAt = now + LAUNCH_LIFE_MS - l.ageMs
        if (expiresAt <= now) continue
        if (records.size >= LAUNCH_CAPACITY) {
          // Oldest unused, unparked record goes; a store full of parked ones drops the newcomer.
          const victim = Array.from(records.values()).find(r => !r.used && !r.parked)
          if (!victim) continue
          tombstone(victim.epoch, now)
          drop(victim)
        }
        records.set(parsed.epoch, {
          epoch: parsed.epoch,
          k: parsed.k,
          n: parsed.n,
          expiresAt,
          used: false,
          parked: false
        })
        if (lastExpiry === undefined || expiresAt > lastExpiry) lastExpiry = expiresAt
      }
    },

    matchHello(p: HelloQuery) {
      const now = native.elapsedRealtime()
      // Constant time over every live record: no early exit on a match.
      let found: Rec | undefined
      for (const rec of records.values()) {
        if (!live(rec, now)) continue
        const expected = helloMac(rec.k, { origin: p.origin, challenge: p.challenge, host: p.host })
        if (timingSafeEqualB64u(p.hello, expected) && !found) found = rec
      }
      return found ? view(found) : undefined
    },

    take(epoch) {
      const now = native.elapsedRealtime()
      const rec = records.get(epoch)
      if (!rec || !live(rec, now)) return undefined
      // Burnt before anything else can fail; the epoch can never come back.
      rec.used = true
      tombstone(epoch, now)
      const out = view(rec)
      rec.k.fill(0)
      return out
    },

    markParked(epoch, parked) {
      const rec = records.get(epoch)
      if (!rec) return
      rec.parked = parked
      if (!parked && rec.used) drop(rec)
    },

    hasLive() {
      const now = native.elapsedRealtime()
      for (const rec of records.values()) if (live(rec, now)) return true
      return false
    },

    lastExpiresAt: () => lastExpiry
  }
}
