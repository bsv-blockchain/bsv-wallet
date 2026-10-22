/**
 * What the wallet's ONE production drain tick is required to drive, and what
 * must stop happening the moment a wallet is torn down.
 *
 * `MandalaRuntime.tick()` has its own suite (`__tests__/mandala/createRuntime
 * .test.ts`: redeliver, then the module settle, then the held-receipt
 * reconcile) — but the tick the phone actually runs is the `TaskSendOffline`
 * lambda in `WalletContext`, and nothing else calls it. Three failures there
 * are invisible to every other test in the package:
 *
 *  · a settle that runs AFTER the release pass. `processOfflineActions` posts
 *    a held 1Color tx only once its `color_transfers` row reads `settled`, so
 *    the color tick must run first or every release waits a whole pass.
 *  · a tick that outlives its wallet. The task is registered once, on a monitor
 *    whose lifetime spans rebuilds, so it MUST read the runtime out of
 *    `mandalaRef` on every pass. A captured runtime would keep draining the
 *    departed wallet's tables — after `storage.destroy()` has closed them.
 *  · a foreground or reconnect that never asks the module to settle, leaving
 *    an offline credit pending until the next periodic pass.
 *
 * All are structural, so they are checked structurally. Reading the source is
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
  it('ticks the color runtime before the offline queue and reads the ref every pass', () => {
    expect(code(tick)).toMatch(/mandalaRef\.current\?\.tick\(\)[\s\S]*processOfflineActions\(/)
    expect(code(tick)).not.toMatch(
      /settlePendingSends|ensureAdmissionsForHoldings|reconcileJournals|recoverStaleAdmissions|repairAdmittedAborted|pruneBlindingReservations|tokenDeps/
    )
  })

  it('releases through the plain queue and then drains the token inbox, off the ref', () => {
    expect(tick).toMatch(/processOfflineActions\(\{\s*storage: phoneStorage!,\s*refetchBeef:/)
    expect(tick).not.toMatch(/token:/)
    expect(tick).toMatch(/processOfflineActions\([\s\S]*drainMandalaInbox\(mandalaRef\.current\)/)
    // A captured runtime would survive the teardown that clears the ref.
    const uses = tick.split('.tick()').length - 1
    expect(tick.split('mandalaRef.current?.tick()').length - 1).toBe(uses)
  })
})

describe('foreground and reconnect settle through the module', () => {
  it('settles on foreground and reconnect', () => {
    expect(code(source)).toMatch(/AppState[\s\S]{0,400}mandalaRef\.current\?\.settleAll\(\)/)
    // The app's NetInfo feed is `subscribeOnline` (core/net/online.ts).
    expect(code(source)).toMatch(/subscribeOnline\([\s\S]{0,400}mandalaRef\.current\?\.settleAll\(\)/)
  })
})

describe('the runtime is built with the registered color module', () => {
  it('passes the module and its provider, read off colorRef', () => {
    const start = source.indexOf('const runtime = createMandalaRuntime({')
    expect(start).toBeGreaterThan(0)
    const call = code(source.slice(start, source.indexOf('mandalaRef.current = runtime', start)))
    expect(call).toContain('color: colorRef.current?.module')
    expect(call).toContain('provider: colorRef.current?.provider')
    expect(call).not.toContain('decodeSealedFrame')
  })
})

/**
 * Guard #2 on the monitor's own retry path: an unsettled 1Color req is held
 * for the drain by `holdTokenReqsForDrain` (keyed on `colorHeldTxids`, Task 7)
 * and dropped from the pass, never posted by `TaskSendWaiting`.
 */
describe('the processUnsent patch holds unsettled 1Color reqs', () => {
  it('filters through holdTokenReqsForDrain before the original posts', () => {
    const start = source.indexOf('sendWaiting.processUnsent = async')
    expect(start).toBeGreaterThan(0)
    const patch = code(source.slice(start, source.indexOf('return orig(ready, indent)', start)))
    expect(patch).toContain('await phoneStorage.holdTokenReqsForDrain(allReqApis')
    expect(patch).toMatch(/allReqApis\.filter\(r => !heldTokenTxids\.has\(r\.txid\)\)/)
  })
})

describe('tearing a wallet down stops its tick', () => {
  const clears = [...source.matchAll(/mandalaRef\.current = undefined/g)].map(m => m.index ?? 0)
  /**
   * The three real teardowns (rebuild, network switch, logout), told apart from
   * the build's own failure path by the vault-scope reset that follows them.
   */
  const teardowns = clears.filter(at => source.slice(at, at + 300).includes('vaultStore.clearScope()'))

  it('every teardown path clears the runtime — rebuild, network/profile switch and logout', () => {
    // Rebuild, network switch and profile switch share teardownBuiltWallet;
    // logout has its own. A further teardown that forgot this line would leave
    // a runtime holding a destroyed database's settlement store.
    expect(teardowns.length).toBeGreaterThanOrEqual(2)
    for (const name of ['rebuildWallet', 'switchNetwork', 'switchProfileImpl']) {
      const start = source.indexOf(`const ${name} = useCallback(`)
      expect(start).toBeGreaterThan(0)
      expect(source.slice(start, source.indexOf('\n  )\n', start))).toContain('await teardownBuiltWallet()')
    }
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
      expect(before).toContain('stopMonitorAndDrain(monitor, monitorSupervisorRef.current)')
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

  it('sits INSIDE guardVaultAccess, around the result-conforming manager', () => {
    expect(wiring.indexOf('guardVaultAccess(')).toBeLessThan(wiring.indexOf('wrapAbortActionForSettlements('))
    expect(wiring.indexOf('wrapAbortActionForSettlements(')).toBeLessThan(wiring.indexOf('conformWalletResults('))
  })

  it('reads the transfer journal off the ref, never a captured runtime', () => {
    // The runtime is built AFTER this line and replaced on every rebuild; a
    // captured journal would guard the departed wallet's table.
    expect(wiring).toContain('mandalaRef.current?.journal')
  })
})

describe('the receiver’s queue reports nearby receipts to the runtime', () => {
  it('passes nearby.onReceived, read off the ref, and no pre-internalize hook', () => {
    const start = source.indexOf('const results = await processPending(')
    expect(start).toBeGreaterThan(0)
    const call = source.slice(start, source.indexOf(')', source.indexOf('nearby.onReceived', start)))
    expect(call).toContain('mandalaRef.current?.nearby.onReceived')
    // A missing color_transfers row already holds the tx (W1), so nothing has
    // to be written before the internalize any more.
    expect(call).not.toMatch(/onToken(Held|Credited)/)
  })
})
