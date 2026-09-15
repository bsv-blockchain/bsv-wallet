/**
 * What the wallet's ONE production drain tick is required to drive, and what
 * must stop happening the moment a wallet is torn down.
 *
 * `MandalaRuntime.drainNow()` has its own suite (it is the same pass, in one
 * function) — but the tick the phone actually runs is the `TaskSendOffline`
 * lambda in `WalletContext`, and nothing else calls it. Two failures there are
 * invisible to every other test in the package:
 *
 *  · a recovery pass that is simply never wired in. The lib's journals
 *    (`reconcileWallet`, `reconcileNotifications`) are the only durable record
 *    of an overlay-accepted transfer whose broadcast never went out and of a
 *    recipient notification a crash swallowed. Nothing else in this wallet
 *    reads them: the settlement drain knows only `token_settlements` rows.
 *  · a tick that outlives its wallet. The task is registered once, on a monitor
 *    whose lifetime spans rebuilds, so it MUST read the runtime out of
 *    `mandalaRef` on every pass. A captured runtime would keep draining the
 *    departed wallet's tables — after `storage.destroy()` has closed them.
 *
 * Both are structural, so they are checked structurally. Reading the source is
 * deliberate: the alternative is rendering the whole provider, and a test that
 * heavy would be deleted the first time it flaked.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = readFileSync(join(__dirname, '../../core/context/WalletContext.tsx'), 'utf8')

/** Line comments, stripped — they name these calls too, and a comment wires nothing. */
const code = (text: string): string =>
  text
    .split('\n')
    .filter(line => !line.trim().startsWith('//'))
    .join('\n')

/** The body of the one `TaskSendOffline` the wallet registers. */
const tick = (() => {
  const start = source.indexOf('new TaskSendOffline(monitor')
  const end = source.indexOf('TaskSendOffline.noteEnqueued()', start)
  if (start < 0 || end < 0) throw new Error('the TaskSendOffline registration has moved or been renamed')
  return code(source.slice(start, end))
})()

describe('the production drain tick', () => {
  it('drives the lib’s own journals — both of them — on every pass', () => {
    expect(tick).toContain('mandalaRef.current?.reconcileJournals()')
  })

  it('still drives the settlement pass and the two sweeps beside them', () => {
    expect(tick).toContain('mandalaRef.current?.recoverStaleAdmissions()')
    expect(tick).toContain('mandalaRef.current?.pruneBlindingReservations()')
    expect(tick).toContain('token: mandalaRef.current?.tokenDeps')
  })

  /**
   * The 2026-09-15 repair rides this tick, and rides it BEFORE the release
   * pass. A transaction it restores has its inputs re-marked spent, and the
   * whole point is that `processOfflineActions` below must not plan a send from
   * a coin that is already gone.
   */
  it('runs the admitted-but-aborted repair, ahead of the release pass', () => {
    expect(tick).toContain('mandalaRef.current?.repairAdmittedAborted()')
    expect(tick.indexOf('repairAdmittedAborted')).toBeLessThan(tick.indexOf('processOfflineActions'))
  })

  it('reads every one of them off the ref, so a torn-down wallet drains nothing', () => {
    // A captured `runtime` (or a `mandala` from the closure) would survive the
    // teardown that clears the ref and keep working the old database.
    for (const call of [
      'reconcileJournals',
      'recoverStaleAdmissions',
      'repairAdmittedAborted',
      'pruneBlindingReservations',
      'tokenDeps'
    ]) {
      const uses = tick.split(call).length - 1
      const guarded = tick.split(`mandalaRef.current?.${call}`).length - 1
      expect(`${call}:${guarded}/${uses}`).toBe(`${call}:${uses}/${uses}`)
    }
  })
})

describe('tearing a wallet down stops its tick', () => {
  const clears = [...source.matchAll(/mandalaRef\.current = undefined/g)].map(m => m.index ?? 0)
  /**
   * The three real teardowns (rebuild, network switch, logout), told apart from
   * the build's own failure path by the session sweep that follows them.
   */
  const teardowns = clears.filter(at => source.slice(at, at + 300).includes('forgetSessionPsks()'))

  it('every teardown path clears the runtime — rebuild, network switch and logout', () => {
    // A fourth teardown that forgot this line would leave a runtime holding a
    // destroyed database's settlement store.
    expect(teardowns.length).toBeGreaterThanOrEqual(3)
  })

  it('drops the published runtime with the ref, so no screen keeps a stale one', () => {
    // Including the build-failure path: a half-built runtime is not published either.
    for (const at of clears) {
      expect(source.slice(at, at + 300)).toContain('setMandala(undefined)')
    }
  })

  it('stops and drains the monitor BEFORE it does — an in-flight pass must finish first', () => {
    for (const at of teardowns) {
      // The monitor owns the tick; stopping it first is what guarantees no pass
      // is midway through `processOfflineActions` when the storage is closed.
      const before = source.slice(Math.max(0, at - 6000), at)
      expect(before).toContain('stopMonitorAndDrain(monitor)')
    }
  })
})

/**
 * Guard #4's wiring, checked where it is actually made.
 *
 * The guard is only a guard if the PUBLISHED manager carries it — the object
 * every screen, every paired app and the Mandala runtime itself calls through.
 * And it has to sit inside `guardVaultAccess`, like
 * `wrapCreateActionForTokenInputs`, or the vault guard's re-wrap dedup stops
 * recognising the published object and silently double-guards the wallet.
 */
describe('the published manager carries the abort guard', () => {
  const wiring = (() => {
    const start = source.indexOf('newManagers.permissionsManager = guardVaultAccess(')
    if (start < 0) throw new Error('the permissions manager wiring has moved or been renamed')
    return source.slice(start, source.indexOf('// THE MANDALA RUNTIME', start))
  })()

  it('wraps abortAction, on the published manager', () => {
    expect(wiring).toContain('wrapAbortActionForSettlements(')
  })

  it('sits INSIDE guardVaultAccess, beside the createAction wrapper', () => {
    expect(wiring.indexOf('guardVaultAccess(')).toBeLessThan(wiring.indexOf('wrapAbortActionForSettlements('))
    expect(wiring.indexOf('wrapAbortActionForSettlements(')).toBeLessThan(
      wiring.indexOf('wrapCreateActionForTokenInputs(')
    )
  })

  it('reads the settlement store off the ref, never a captured runtime', () => {
    // The runtime is built AFTER this line and replaced on every rebuild; a
    // captured store would guard the departed wallet's tables.
    expect(wiring).toContain('mandalaRef.current?.store')
  })
})

describe('the receiver’s queue gets both settlement hooks', () => {
  it('passes the pre-internalize hook as well as the post-credit one', () => {
    const start = source.indexOf('const results = await processPending(')
    expect(start).toBeGreaterThan(0)
    const call = source.slice(start, source.indexOf(')', source.indexOf('onTokenHeld', start)))
    expect(call).toContain('mandalaRef.current?.onTokenCredited')
    // The one that runs BEFORE the credit: without it the unadmitted-broadcast
    // guard has no row to read on the first internalize (§4.3 guard #2).
    expect(call).toContain('mandalaRef.current?.onTokenHeld')
  })
})
