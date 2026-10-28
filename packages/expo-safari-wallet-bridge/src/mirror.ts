/**
 * The app-side mirror writer (spec 6.5): keeps `meta/mirror.sealed` current so the Safari extension
 * can answer while the app is not running. The extension only reads it.
 *
 * Rules the writer enforces:
 * - Never before `isBridgeHostAttached()`. That also keeps the pre-init snapshot (`none`, revision
 *   '0', closeSeq 0) and a detach-induced `none` (Fast Refresh, provider remount) out of the file;
 *   a real `none` after attach is written.
 * - `identityKey` is null unless `readiness === 'ready'`.
 * - An ordinary write awaits `processor.flushEvents()` before the file write, so a mirror showing
 *   `closeSeq` N is never durable before close event N.
 * - `disable()` is synchronous and final (the logout teardown hook calls it, then `reset()`). The
 *   attachment and disabled flag are re-checked immediately before the file write, so a write that
 *   was already queued writes nothing.
 *
 * A remounted provider re-registers its consent store right after it attaches, which fires the consent
 * listener, so the next attach writes a fresh mirror without a dedicated attach signal.
 *
 * There is no policy-change signal in the core: the policy applies from the next wallet build, which
 * moves the snapshot, and it is re-read on every write and when the app becomes active.
 */
import { Utils } from '@bsv/sdk'
import { AppState } from 'react-native'
import type {
  getPermissionPolicy,
  listConnectedSites,
  onConnectedSitesChange,
  onSnapshotChange
} from '@bsv/expo-wallet-toolbox/core/bridge/runtime'
import type { BridgeSnapshot } from '@bsv/expo-wallet-toolbox/core/bridge/runtime'
import type { InboxProcessor } from '@bsv/expo-wallet-toolbox/core/bridge/inbox'
import { connectedHash, type Mirror } from '../shared/mirror'
import type { BsvBridgeNative } from '../shared/native'

export interface MirrorWriterDeps {
  native: Pick<BsvBridgeNative, 'writeMirror'>
  processor: Pick<InboxProcessor, 'flushEvents'>
  getSnapshot: () => BridgeSnapshot
  onSnapshotChange: typeof onSnapshotChange
  isBridgeHostAttached: () => boolean
  listConnectedSites: typeof listConnectedSites
  onConsentChange: typeof onConnectedSitesChange
  getPermissionPolicy: typeof getPermissionPolicy
  /** The active profile's identity key as hex, the way the host reads it from the wallet. */
  getIdentityKey: () => Promise<string | null>
  bootId: string
  now: () => number
}

export interface MirrorWriter {
  start(): void
  stop(): void
  /** Synchronous and final: drops queued writes and unsubscribes. A new writer is needed afterwards. */
  disable(): void
  /** Writes the current state now (after any write in flight). Failures are swallowed. */
  writeNow(): Promise<void>
}

export function createMirrorWriter(deps: MirrorWriterDeps): MirrorWriter {
  let disabled = false
  let started = false
  let chain: Promise<void> = Promise.resolve()
  let queued = false
  let unsubs: Array<() => void> = []

  const live = () => !disabled && deps.isBridgeHostAttached()

  async function build(): Promise<Mirror | undefined> {
    const s = deps.getSnapshot()
    const snapshot = {
      schema: s.schema,
      baseVersion: s.baseVersion,
      network: s.network,
      accountContext: s.accountContext,
      walletRevision: s.walletRevision,
      readiness: s.readiness,
      closeSeq: s.closeSeq
    }
    const [policy, sites, identityKey] = await Promise.all([
      deps.getPermissionPolicy(),
      deps.listConnectedSites(),
      s.readiness === 'ready' ? deps.getIdentityKey() : Promise.resolve(null)
    ])
    // A ready mirror without a key would tell the extension the wallet has no identity: skip instead.
    if (s.readiness === 'ready' && identityKey === null) return undefined
    const connected = [
      ...new Set(sites.filter(x => x.attestation === 'browser').map(x => connectedHash(x.applicationOrigin)))
    ].sort()
    return {
      v: 1,
      writerBootId: deps.bootId,
      writtenAt: deps.now(),
      snapshot,
      identityKey,
      identityKeyPrompts: policy.verified.seekPermissionsForIdentityKeyRevelation === true,
      connected
    }
  }

  async function writeOnce(): Promise<void> {
    queued = false
    if (!live()) return
    try {
      const mirror = await build()
      if (mirror === undefined) return
      if (!live()) return
      // The close events behind mirror.snapshot.closeSeq must be durable first (spec 6.5).
      await deps.processor.flushEvents()
      // Re-checked immediately before the file write: a logout or detach may have landed meanwhile.
      if (!live()) return
      const bytes = Utils.toBase64(Utils.toArray(JSON.stringify(mirror), 'utf8'))
      await deps.native.writeMirror(bytes)
      if (typeof __DEV__ !== 'undefined' && __DEV__)
        console.log(`[safari-bridge] mirror written, connected=${mirror.connected.length}`)
    } catch (e) {
      // After a reset the module rejects every write; that is the intended end state, not a warning.
      if (!disabled) console.warn('[safari-bridge] mirror write failed', e)
    }
  }

  function enqueue(): Promise<void> {
    const run = chain.then(writeOnce)
    chain = run
    return run
  }

  function trigger(): void {
    if (disabled || !started || queued) return
    queued = true
    void enqueue()
  }

  return {
    start() {
      if (disabled || started) return
      started = true
      unsubs = [deps.onSnapshotChange(() => trigger()), deps.onConsentChange(() => trigger())]
      const sub = AppState.addEventListener('change', state => {
        if (state === 'active') trigger()
      })
      unsubs.push(() => sub?.remove?.())
      trigger()
    },
    stop() {
      started = false
      for (const u of unsubs.splice(0)) u()
    },
    disable() {
      disabled = true
      queued = false
      started = false
      for (const u of unsubs.splice(0)) u()
    },
    writeNow() {
      if (disabled) return Promise.resolve()
      return enqueue()
    }
  }
}
