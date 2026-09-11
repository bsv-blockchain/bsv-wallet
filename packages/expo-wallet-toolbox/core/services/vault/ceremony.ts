/**
 * Ceremony controller — UI-free state machine for the insert → PIN → tap flow
 * that turns one enrolled YubiKey into a VaultSigner. Consumed by a React
 * context that renders the ceremony sheet; kept free of React and native
 * imports so it is fully unit-testable against the mock driver.
 *
 * What a ceremony PRODUCES: a VaultSigner — the CHOSEN key's serial and
 * compressed P-256 public key, plus `sign(digest)`, which runs the card's
 * GENERAL AUTHENTICATE (driver.signEcdsa) for one 32-byte digest and returns
 * the DER signature. There is no seed, no seal, no ECDH and no key material in
 * JS memory at any point (spec D2): the card signs each vault input itself.
 * What lives in this module while a signer is armed is the PIN string and the
 * transport session — nothing else.
 *
 * The caller (transfers.ts) names the key BEFORE the tap (spec D14): the
 * ceremony reads `chosenSerial` against the store's key list, refuses a serial
 * that is not enrolled (`not-enrolled`) before any hardware prompt, and refuses
 * a tapped card whose serial is not the chosen one (`serial-mismatch`) on EVERY
 * session, including the reopened ones described below.
 *
 * Concurrency: one ceremony ARMING at a time — `requestSigner()` calls that
 * overlap a single in-flight arm attempt (two callers racing while `running`
 * is true) share that one attempt and all resolve to the SAME VaultSigner,
 * provided they name the same serial; a joiner naming a different serial is
 * rejected with `serial-mismatch` at once, without disturbing the in-flight
 * attempt. release() on the shared signer is idempotent by construction, so
 * whichever caller releases last simply no-ops. That guarantee does NOT extend
 * across separate ceremonies: once an attempt finishes arming, `running` goes
 * back to false, and the NEXT requestSigner() call starts an entirely new
 * ceremony with its own signer — even if the previous one has not been
 * released yet. Two live, independently-armed signers can therefore coexist
 * for a stretch (see ceremony.test.ts's "late release() from a stale signer"
 * case); what is guaranteed is that a signer released late can only affect its
 * OWN subscription, never a successor's — see makeHandle's `release()` doc for
 * the one exception (the shared native transport).
 *
 * Session lifetime: arming means "the chosen card answered with the right
 * serial and accepted the PIN", not "the operation is done." A session-based
 * transport's driver.stop() (which dismisses the iOS NFC sheet) is therefore
 * NOT called when the ceremony completes; it moves to VaultSigner.release(),
 * so the session's lifetime still brackets the caller's whole signing loop.
 * The one exception is the error path: if arming itself fails, no signer
 * exists to own the session, so run()'s finally closes it there.
 *
 * Signing is RESUMABLE (spec §4.2 step 6). `sign()` retries a dropped tap in
 * place — touch-timeout, nfc-lost, key-removed-mid-op REJECTED BY signEcdsa —
 * by parking on the Retry prompt and, on a session-based transport, closing the
 * dead session and opening a fresh one (serial and PIN re-checked) before
 * signing the SAME digest again; the caller's reservation and the signatures
 * already gathered are untouched. On a session-based transport it also closes
 * and reopens the session every `inputsPerTap` successful signatures (the
 * card's touch cache and CoreNFC's 60 s session both bound a batch), showing
 * 'waiting-for-key' with the caller's progress so the sheet can say "batch b of
 * n". A driver-EMITTED 'detached' while a signer is live is NOT a retry: it is
 * the hardware leaving, and notifyKeyDetached relocks exactly as before.
 *
 * The NFC alert text handed to driver.start() is the caller's `reason` — this
 * module has no i18n, and YubiKit fixes the text for the life of one session
 * anyway; per-batch progress is shown by the in-app sheet from
 * CeremonyState.progress.
 *
 * The retention window bounds how long a signer stays usable. A progress note
 * (noteProgress) or a `sign()` call carrying progress restarts it, so a long
 * batch is not cut off mid-flight; ARM_MAX_MULTIPLE caps a session's total
 * life at 3× the window measured from `armedAt`, after which the relock fires
 * however fresh the progress is.
 *
 * SECURITY: the PIN lives in the arm flow's closure until release(). Never log
 * the PIN, and never put it in CeremonyState, which is React-visible. Serials
 * and public keys are public data and travel on the signer, not in state.
 */
import { Utils } from '@bsv/sdk'
import { VaultDriver } from './driver'
import { VaultError, VaultErrorCode } from './types'

export type CeremonyPhase =
  | 'idle'
  | 'waiting-for-key'
  | 'connecting'
  | 'pin-entry'
  | 'awaiting-touch'
  | 'preparing'
  | 'broadcasting'
  | 'armed'
  | 'error'

/**
 * Work happening AFTER the signer is armed, reported by the spend path so the
 * sheet can show activity instead of a frozen screen.
 *
 * 'preparing' carries the signing loop's position when it has one: `signed`
 * inputs done out of `total`. The sheet renders it between batches and after
 * the NFC sheet dismisses (it cannot draw under the iOS system sheet).
 */
export type VaultProgress = { phase: 'preparing'; signed?: number; total?: number } | { phase: 'broadcasting' }

/**
 * Everything the ceremony publishes to React (see context/VaultContext.tsx).
 *
 * Kept to exactly these five fields on purpose: a phase, a deadline, the
 * caller's own reason string, an error code, and the signing position. No PIN,
 * no serial, no pubkey, no signature — see this module's SECURITY note, and the
 * "nothing key-shaped reaches the React-visible ceremony state" case in
 * __tests__/vault/ceremony.test.ts, which pins the key set so a new field
 * cannot be added here without a deliberate decision.
 */
export interface CeremonyState {
  phase: CeremonyPhase
  reason?: string
  error?: { code: VaultErrorCode; retriesLeft?: number }
  armedUntil?: number
  /** Signing position while a batch runs (spec §4.2 step 8). Cleared on release. */
  progress?: { signed: number; total: number }
}

/**
 * An armed YubiKey: the chosen key's public identity plus the one operation
 * the card performs for the vault.
 *
 * Callers MUST call release() in a finally: on session-based transports that
 * is what dismisses the system NFC sheet, and on every transport it is what
 * ends the ceremony (phase back to 'idle') and drops the PIN.
 *
 * `sign()` after release (or after a timeout/detach relock) throws
 * `key-removed-mid-op` rather than talking to a card the ceremony has declared
 * dead. NEVER stash a signer in module state, React state, a closure that
 * outlives the operation, or any cache — obtain it from ceremonyHost for one
 * transfer and release it when that transfer ends.
 */
export interface VaultSigner {
  readonly serial: string
  /** 33-byte compressed P-256 public key, lowercase hex (as enrolled). */
  readonly pubkey: string
  /**
   * Sign one 32-byte digest (64 hex chars) on the card; returns DER bytes.
   * Retries in place on touch-timeout / nfc-lost / key-removed-mid-op REJECTED
   * BY the driver (re-opens the session on session-based transports,
   * re-checking serial + PIN); on session-based transports re-opens a fresh
   * session every `inputsPerTap` calls. `progress` publishes the loop position
   * to the sheet and refreshes the retention window. Throws
   * 'key-removed-mid-op' after release(), whatever released it (a cancel(),
   * a detach, the retention ceiling, or the caller).
   */
  sign(digestHex: string, progress?: { index: number; total: number }): Promise<number[]>
  /** Idempotent: safe to call more than once, and safe for concurrent callers
   * that were all handed the same signer to release independently. */
  release(): void
}

/** One enrolled key as the ceremony sees it — the public part of a
 * vaultStore VaultKeyRecord. */
interface CeremonyKey {
  serial: string
  slot: number
  pubkey: string
}

/** The store's key list, narrowed to what a tap needs. ceremonyHost maps
 * vaultStore's meta v5 onto it; tests hand in a literal. */
export interface CeremonyStoreView {
  getMeta(): Promise<{ keys: CeremonyKey[] } | null>
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
}

function defer<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/**
 * A single arm attempt's driver-event subscription, boxed so each attempt
 * owns its OWN unsubscribe token instead of sharing one controller-wide
 * field. This is load-bearing, not tidiness: with a single shared field, a
 * handle released late (after a successor ceremony has already resubscribed
 * for its own arm) would unsubscribe the SUCCESSOR's listener and stop the
 * SUCCESSOR's session — the successor's own openTapSession would then await
 * an attachWaiter nothing can ever resolve. A per-attempt box makes a stale
 * release() structurally unable to touch a later attempt's subscription.
 */
interface KeyEventSession {
  off?: () => void
}

export class CeremonyController {
  state: CeremonyState = { phase: 'idle' }

  onRelock?: (why: 'timeout' | 'detached' | 'manual') => void
  onArmed?: (signer: VaultSigner) => void

  private subscribers = new Set<(s: CeremonyState) => void>()
  private waiters: ((s: VaultSigner) => void)[] = []
  private rejecters: ((e: unknown) => void)[] = []
  private running = false
  private reason = ''
  /** The serial the in-flight (or most recent) ceremony was asked for. Read
   * by run() to pick the key out of the store, and by requestSigner() to
   * refuse a joiner naming a different key. */
  private chosenSerial = ''

  /** Monotonic id of the newest arm attempt. `running` alone cannot tell an
   * attempt that it has been replaced: cancel() sets running=false while the
   * cancelled attempt is still parked inside an await (a tap can still land
   * seconds later), and the requestSigner() that follows starts a fresh
   * attempt AND resets `cancelled`. Every run() captures its own generation
   * and re-checks it before touching any shared state, so a late-returning
   * attempt can only ever clean itself up. */
  private generation = 0

  /** The signer for the currently-armed session, if any. Set once arming
   * succeeds. Cleared by VaultSigner.release() itself (identity-checked
   * against this field — see makeHandle) rather than by whoever calls
   * release(), so this is accurate whether release() was invoked by the caller
   * finishing normally, or by cancel()/notifyKeyDetached()/the retention timer
   * relocking it. Its presence — not `state.phase` — is what the relock paths
   * key off of, because a signer can be "active" while the visible phase is
   * 'awaiting-touch', 'preparing' or 'broadcasting', not just 'armed'. (The
   * field keeps its historical name; every relock path reads it.) */
  private activeHandle?: VaultSigner

  private pinWaiter?: Deferred<string>
  private queuedPin?: string
  private retryWaiter?: Deferred<void>
  private attachWaiter?: Deferred<void>
  private cancelled = false
  private armTimer?: ReturnType<typeof setTimeout>
  /** When the current session armed. The anchor for the absolute ceiling — see
   * ARM_MAX_MULTIPLE — so a stream of progress notes cannot renew the retention
   * window forever. */
  private armedAt = 0

  /** Grace period given to an operation that is still reporting progress when
   * the retention window elapses, before the timeout is enforced regardless of
   * phase. See checkArmTimeout. */
  private static readonly ARM_GRACE_MS = 5_000

  /** Hard ceiling on a session's life, as a multiple of the retention window.
   * A progress note refreshes the window (see noteProgress), which on its own
   * would make the retention period a lease the caller can renew indefinitely.
   * Past `armedAt + this × retentionMs` the relock fires no matter how fresh
   * the progress is, and the grace window is clamped to it too, so the
   * signer's maximum lifetime is bounded by construction rather than by caller
   * good behaviour. */
  private static readonly ARM_MAX_MULTIPLE = 3

  /** Deadline for a session-based transport's waiting-for-key. CoreNFC caps a
   * tag-reader session at 60 s; if nothing (attach OR failure) has arrived in
   * 65 s the session is dead and its ending was swallowed somewhere below us —
   * YubiKit drops several such paths internally (readingAvailable false at
   * start, a session invalidated before it ever became active), so no delegate
   * fix can make this watchdog redundant. Persistent readers (Android USB)
   * are exempt: waiting for an insert legitimately has no deadline. */
  private static readonly DEFAULT_ATTACH_TIMEOUT_MS = 65_000

  /** Signatures one session-based tap covers before the ceremony closes the
   * session and asks for a fresh tap (spec §4.2 step 6). ceremonyHost passes
   * VAULT_INPUTS_PER_TAP; this is the fallback for a bare controller. */
  private static readonly DEFAULT_INPUTS_PER_TAP = 16

  constructor(
    private deps: {
      getDriver: () => VaultDriver | null
      store: CeremonyStoreView
      retentionMs: number
      /** Test seam for the waiting-for-key watchdog (session-based only). */
      attachTimeoutMs?: number
      /** Session-based transports only: how many sign() calls one tap covers. */
      inputsPerTap?: number
    }
  ) {}

  subscribe(cb: (s: CeremonyState) => void): () => void {
    this.subscribers.add(cb)
    cb(this.state)
    return () => this.subscribers.delete(cb)
  }

  /** Ask for the chosen key as a signer. Concurrent calls naming the same
   * serial share one ceremony and all receive the SAME signer, so release() is
   * idempotent by construction; a concurrent call naming a DIFFERENT serial is
   * refused at once with serial-mismatch (one sheet can only run one tap). */
  requestSigner(reason: string, chosenSerial: string): Promise<VaultSigner> {
    return new Promise<VaultSigner>((resolve, reject) => {
      if (this.running && chosenSerial !== this.chosenSerial) {
        reject(
          new VaultError(
            'serial-mismatch',
            `A ceremony for key ${this.chosenSerial} is already in progress; asked for key ${chosenSerial}`
          )
        )
        return
      }
      this.waiters.push(resolve)
      this.rejecters.push(reject)
      if (this.running) return // join the in-flight ceremony
      this.reason = reason
      this.chosenSerial = chosenSerial
      this.cancelled = false
      this.running = true
      void this.run()
    })
  }

  /**
   * Report post-arm progress from the spend path.
   *
   * Guarded on an armed session: a note with no signer armed (a deposit, which
   * is hardware-free, or a caller that has already released) must not raise a
   * sheet, and anything arriving mid-arm is ignored because the arming phases
   * own the display.
   *
   * A progress note also REFRESHES the retention window, bounded twice over
   * (see startArmTimer / ARM_MAX_MULTIPLE): progress must keep arriving, AND no
   * refresh may push the relock past `armedAt + ARM_MAX_MULTIPLE × retentionMs`.
   *
   * 'preparing' with both counters publishes them as `state.progress`; any
   * other note clears it, so a stale "3 of 10" never outlives its batch.
   */
  noteProgress(p: VaultProgress): void {
    if (!this.activeHandle || this.running) return
    const progress =
      p.phase === 'preparing' && p.signed != null && p.total != null ? { signed: p.signed, total: p.total } : undefined
    this.set({ phase: p.phase, progress, armedUntil: this.startArmTimer(), error: undefined })
  }

  submitPin(pin: string): void {
    if (this.pinWaiter) {
      const w = this.pinWaiter
      this.pinWaiter = undefined
      w.resolve(pin)
    } else {
      this.queuedPin = pin
    }
  }

  retry(): void {
    this.retryWaiter?.resolve()
    this.retryWaiter = undefined
  }

  /** Give up. Aborts an in-flight arm attempt (rejecting every waiter with
   * user-cancelled), and — separately — releases an already-armed session,
   * since cancelling out of a mid-withdrawal prompt must not leave a key live
   * in memory behind a session the UI just dismissed. release() itself does the
   * activeHandle/timer/phase cleanup (identity checked), so this only needs to
   * trigger it. */
  cancel(): void {
    this.cancelled = true
    // A PIN submitted before anything was waiting for it belongs to the
    // ceremony being cancelled; the next one must show pin-entry, not
    // silently consume it.
    this.queuedPin = undefined
    const err = new VaultError('user-cancelled')
    this.pinWaiter?.reject(err)
    this.retryWaiter?.reject(err)
    this.attachWaiter?.reject(err)
    if (this.running) {
      this.failAll(err)
      this.running = false
      this.set({ phase: 'idle' })
    }
    if (this.activeHandle) {
      this.activeHandle.release()
      this.onRelock?.('manual')
    } else if (!this.running && this.state.phase !== 'idle') {
      // Dismissing a finished attempt's error phase (e.g. serial-mismatch):
      // running is already false (run()'s finally cleared it) and there is
      // no armed handle for release() to relock, so nothing above touches
      // phase. Left uncleared, the sheet's `visible` (phase !== 'idle')
      // never flips, so a swipe-to-dismiss slides the sheet view away while
      // its full-screen backdrop stays mounted and eats every touch.
      this.set({ phase: 'idle' })
    }
  }

  /** A key detached. Aborts an in-flight arm attempt; releases an armed
   * session, since the hardware that authorized holding this key is gone.
   * release() itself does the activeHandle/timer/phase cleanup. */
  notifyKeyDetached(): void {
    if (this.activeHandle) {
      const err = new VaultError('key-removed-mid-op')
      this.retryWaiter?.reject(err)
      this.attachWaiter?.reject(err)
      this.activeHandle.release()
      this.onRelock?.('detached')
      return
    }
    if (this.running) {
      const err = new VaultError('key-removed-mid-op')
      this.pinWaiter?.reject(err)
      this.retryWaiter?.reject(err)
      this.attachWaiter?.reject(err)
    }
  }

  /** A key attached — resolves a waiting waiting-for-key phase. */
  notifyKeyAttached(): void {
    this.attachWaiter?.resolve()
    this.attachWaiter = undefined
  }

  /** The NFC session died before any key connected (system sheet cancelled,
   * 60 s CoreNFC timeout, or a session that failed to present at all). Only
   * meaningful while something is parked on waiting-for-key: neither attach
   * nor detach fits — a detach here would misreport it as key-removed-mid-op
   * on a key that was never there. */
  notifySessionFailed(code: 'user-cancelled' | 'no-key' = 'no-key'): void {
    this.attachWaiter?.reject(new VaultError(code))
    this.attachWaiter = undefined
  }

  /**
   * Why this outlives `run()` for a session-based transport: WalletContext's
   * own persistent-reader listener explicitly skips `sessionBased` drivers
   * (it exists only to relock Android USB on unplug), so a session's OWN
   * subscription (in its own KeyEventSession box) is the only thing that can
   * ever learn a tap-session detached while a handle is armed. A persistent
   * reader has that separate always-on listener, so its ceremony-owned
   * subscription is dropped right after arming.
   */
  private subscribeKeyEvents(driver: VaultDriver, session: KeyEventSession): void {
    session.off?.()
    session.off = driver.onKeyEvent(e => {
      if (e.type === 'attached') this.notifyKeyAttached()
      else if (e.type === 'session-failed') this.notifySessionFailed(e.code)
      else this.notifyKeyDetached()
    })
  }

  private unsubscribeKeyEvents(session: KeyEventSession): void {
    session.off?.()
    session.off = undefined
  }

  private async run(): Promise<void> {
    // This attempt's identity for the rest of its life — see `generation`.
    const gen = ++this.generation
    // Synchronous with requestSigner(): anything queued BEFORE this ceremony
    // was asked for is stale (a failed or superseded attempt's leftovers) and
    // must not be consumed by this attempt's collectPin. A PIN submitted
    // after this point — including one that lands before pin-entry is
    // painted — is this attempt's and is still queued for it.
    this.queuedPin = undefined
    const driver = this.deps.getDriver()
    if (!driver) {
      this.failAll(new VaultError('driver-unavailable'))
      this.running = false
      return
    }
    // This attempt's own driver-event subscription box: a key connecting (an
    // NFC tap / a USB plug) resolves waiting-for-key; a key dropping mid-flow
    // aborts. Self-contained so it works whether or not WalletContext also
    // watches for persistent relock. Boxed per-attempt — see KeyEventSession.
    const session: KeyEventSession = {}
    this.subscribeKeyEvents(driver, session)
    // Attempt-local: whether THIS run() reached a successful arm. Deliberately
    // NOT this.activeHandle, which is controller-wide — see the finally guard
    // below for why that distinction is load-bearing.
    let armed = false
    // Set when this attempt discovers it has been superseded: it has already
    // torn its own session down, so the finally must not do it twice.
    let superseded = false
    try {
      // The key list, read before any hardware prompt: a serial that is not
      // enrolled (a removed key, a stale chooser) has nothing a tap could do,
      // so it must fail before the sheet ever opens (spec §4.2 step 6).
      const meta = await this.deps.store.getMeta()
      if (!meta) throw new VaultError('not-enrolled')
      const key = meta.keys.find(k => k.serial === this.chosenSerial)
      if (!key) {
        throw new VaultError('not-enrolled', `Key ${this.chosenSerial} is not one of this vault's keys`)
      }

      // NFC (session-based) collects the PIN BEFORE the tap and verifies it in
      // that one tap (the scan sheet covers the app, so no PIN entry mid-tap).
      // A persistent USB reader can interleave PIN entry and the serial/PIN
      // checks.
      const signer = driver.sessionBased
        ? await this.armViaTap(driver, key, session, gen)
        : await this.armViaReader(driver, key, session, gen)
      this.throwIfCancelled()

      // Have we been superseded while parked on the tap? `cancelled` cannot
      // answer this: cancel() sets it, but the very next requestSigner() resets
      // it to false for the NEW attempt, so by the time a cancelled-then-
      // replaced attempt's PIN check lands, the flag reads clean again. Only
      // the generation does. Without this check that attempt would install ITS
      // signer as activeHandle over the successor's, arm a second timer, and
      // hand its own signer to whoever is waiting on the successor — two
      // sessions live, one of them owned by nobody.
      if (gen !== this.generation) {
        superseded = true
        // Drop THIS attempt's listener box first (release() only unsubscribes
        // on a session-based transport, and the post-arm unsubscribe below is
        // never reached from here — without this a cancelled-and-replaced
        // attempt would leave a live listener behind on every persistent-reader
        // ceremony), then drop its session. The identity check inside
        // release() means none of the controller's shared state (the
        // successor's activeHandle, timer or phase) is touched.
        this.unsubscribeKeyEvents(session)
        signer.release()
        return
      }

      this.activeHandle = signer
      armed = true
      this.arm()
      this.resolveAll(signer)
      this.onArmed?.(signer)

      // Persistent readers hand relock-on-unplug to WalletContext's
      // longer-lived listener — drop ours now. Session-based transports keep
      // listening: see subscribeKeyEvents' doc above.
      if (!driver.sessionBased) this.unsubscribeKeyEvents(session)
    } catch (e) {
      // Anything that is not a VaultError gets relabelled 'driver-unavailable',
      // which renders as "YubiKey support is unavailable on this device" — so
      // the original message is carried across as the detail rather than being
      // dropped, otherwise an unrelated failure is indistinguishable from a
      // genuinely absent driver.
      const err = e instanceof VaultError ? e : new VaultError('driver-unavailable', String(e))
      // Same generation guard as the success path, for the same reason: a
      // superseded attempt's failure is not the CURRENT attempt's failure, and
      // must not reject the successor's waiters or paint its phase. Its own
      // waiters were already failed by the cancel() that superseded it, so
      // there is nobody left to tell. The finally still closes its session.
      if (gen !== this.generation) return
      if (err.code === 'user-cancelled') {
        this.set({ phase: 'idle' })
      } else {
        this.set({ phase: 'error', error: { code: err.code, retriesLeft: err.retriesLeft } })
      }
      this.failAll(err)
    } finally {
      // Only the CURRENT attempt owns `running`. A superseded attempt clearing
      // it would declare the successor's still-in-flight ceremony finished, so
      // the next requestSigner() would start a third attempt alongside it
      // instead of joining the second.
      if (gen === this.generation) this.running = false
      // `armed` (this attempt's own outcome), NOT this.activeHandle (whoever
      // the CONTROLLER currently considers active): an unreleased predecessor
      // ceremony leaves this.activeHandle truthy for the whole time this
      // attempt runs, which would otherwise make a FAILED successor's finally
      // wrongly conclude "some signer must already own this session/
      // subscription" and skip closing its own — the predecessor's activeHandle
      // has nothing to do with whether this attempt itself succeeded.
      if (!armed && !superseded) {
        // Arming never completed: no signer exists to own the subscription
        // or the session, so close both now — nothing else ever will.
        // (A superseded attempt DID build a signer and released it above,
        // which already did exactly this teardown — don't repeat it.)
        // Unsubscribe BEFORE any stop so a session-end detach echo cannot
        // relock a session that was already dead.
        this.unsubscribeKeyEvents(session)
        if (driver.sessionBased) {
          try {
            driver.stop()
          } catch {
            /* stop is best-effort */
          }
        }
      }
    }
  }

  private async safeKeyInfo(driver: VaultDriver) {
    try {
      return await driver.getKeyInfo()
    } catch {
      return null
    }
  }

  /** Persistent reader (Android USB): key present, PIN entry and token ops
   * interleave, so a wrong PIN is retried in place. */
  private async armViaReader(
    driver: VaultDriver,
    key: CeremonyKey,
    session: KeyEventSession,
    gen: number
  ): Promise<VaultSigner> {
    this.throwIfStale(gen)
    this.set({ phase: 'connecting' })
    // Arm the attach waiter BEFORE probing. A key inserted while getKeyInfo is
    // in flight fires 'attached' into notifyKeyAttached, which can only resolve
    // a waiter that already exists: created after the probe, that event would
    // be lost, the probe would still answer "no key", and waiting-for-key below
    // would park forever behind a key that is already present. The no-op catch
    // keeps a waiter that cancel()/detach rejects before it is awaited from
    // surfacing as an unhandled rejection; the await below still observes it.
    const waiter = (this.attachWaiter = defer<void>())
    waiter.promise.catch(() => {})
    let info = await this.safeKeyInfo(driver)
    if (!info) {
      this.set({ phase: 'waiting-for-key' })
      driver.start(this.reason)
      await waiter.promise
      this.throwIfStale(gen)
      this.set({ phase: 'connecting' })
      info = await this.safeKeyInfo(driver)
    } else if (this.attachWaiter === waiter) {
      this.attachWaiter = undefined
    }
    if (!info) throw new VaultError('no-key')
    this.requireChosenSerial(info.serial, key)
    const pin = await this.collectPin(driver, gen)
    return this.makeHandle(driver, key, pin, session, gen)
  }

  /** The serial check, run on EVERY session (initial arm, and each reopen on
   * a session-based transport): the tapped card must be THE chosen key. The
   * detail names both serials so the sheet can say "That's X — you chose Y"
   * (spec §4.2 step 6). A serial not enrolled at all lands here too: it is
   * not the chosen one either, and the sheet has the key list to say so. */
  private requireChosenSerial(tapped: string, key: CeremonyKey): void {
    if (tapped !== key.serial) {
      throw new VaultError('serial-mismatch', `Tapped key ${tapped}, chose key ${key.serial}`, undefined, {
        tapped,
        chosen: key.serial
      })
    }
  }

  /** Errors from a single tap/touch attempt that are worth retrying without
   * throwing away the whole operation: a missed/short touch, or the field
   * dropping mid-command (phone shifted, key lifted a hair early). On a
   * session-based transport all three leave the dead NFC session behind, so a
   * retry must close it and open a fresh one — see the reopen inside
   * VaultSigner.sign() (makeHandle). Only REJECTIONS of driver.signEcdsa are
   * classified here; a driver-emitted 'detached' event is handled by
   * notifyKeyDetached and relocks. */
  private static readonly RETRYABLE_TAP_ERRORS = new Set(['touch-timeout', 'nfc-lost', 'key-removed-mid-op'])

  /** NFC tap (iOS): PIN first in-app (the scan sheet is modal), then one tap
   * connects, checks the serial and verifies the PIN. A wrong PIN aborts the
   * ceremony — we cannot re-prompt beneath an open system NFC sheet. No
   * touch is spent here: the first signature is the first touch. */
  private async armViaTap(
    driver: VaultDriver,
    key: CeremonyKey,
    session: KeyEventSession,
    gen: number
  ): Promise<VaultSigner> {
    const pin = await this.collectPinValue(gen)
    await this.openTapSession(driver, key, pin, session, gen)
    return this.makeHandle(driver, key, pin, session, gen)
  }

  /** Open (or reopen) an NFC session and get as far as a verified PIN. Used
   * for the initial arm and — on a session-based transport — by
   * VaultSigner.sign() to re-establish a fresh session after a dropped tap
   * and at every batch boundary. The serial check lives here as well as in
   * armViaReader deliberately: EVERY session, including a reopened one,
   * re-checks it, so a different card presented on the next tap is never
   * asked to sign for this key.
   * (Re)subscribes `session` every time: the very first call replaces run()'s
   * top-level subscription on the SAME box (harmless — nothing was pending on
   * it yet), and every reopen needs a fresh one since the caller unsubscribed
   * this same box around its matching driver.stop(). */
  private async openTapSession(
    driver: VaultDriver,
    key: CeremonyKey,
    pin: string,
    session: KeyEventSession,
    gen: number
  ): Promise<void> {
    this.throwIfStale(gen)
    this.subscribeKeyEvents(driver, session)
    this.set({ phase: 'waiting-for-key' })
    const waiter = (this.attachWaiter = defer<void>())
    driver.start(this.reason)
    // Watchdog: a session-based transport that reports NOTHING by the deadline
    // is dead, and its death was swallowed below us (see
    // DEFAULT_ATTACH_TIMEOUT_MS). Identity-checked against attachWaiter so a
    // late firing can never touch a successor ceremony's waiter.
    const attachDeadline = setTimeout(() => {
      if (this.attachWaiter === waiter) {
        this.attachWaiter = undefined
        waiter.reject(new VaultError('no-key', 'No key connected before the NFC session deadline'))
      }
    }, this.deps.attachTimeoutMs ?? CeremonyController.DEFAULT_ATTACH_TIMEOUT_MS)
    ;(attachDeadline as { unref?: () => void }).unref?.()
    try {
      await waiter.promise
    } finally {
      clearTimeout(attachDeadline)
    }
    this.throwIfStale(gen)
    this.set({ phase: 'connecting' })
    const info = await driver.getKeyInfo()
    // getKeyInfo is a native call cancel() cannot interrupt.
    this.throwIfStale(gen)
    this.requireChosenSerial(info.serial, key)
    const res = await driver.verifyPin(pin)
    this.throwIfStale(gen)
    if (!res.ok) throw new VaultError('pin-invalid', 'Wrong PIN', res.retriesLeft)
  }

  /** Collect a PIN value from the UI only (no token verify) — used by the NFC
   * path, which must gather the PIN before the tap. */
  private async collectPinValue(gen: number): Promise<string> {
    this.throwIfStale(gen)
    this.set({ phase: 'pin-entry' })
    if (this.queuedPin !== undefined) {
      const p = this.queuedPin
      this.queuedPin = undefined
      return p
    }
    this.pinWaiter = defer<string>()
    return this.pinWaiter.promise
  }

  private async collectPin(driver: VaultDriver, gen: number): Promise<string> {
    for (;;) {
      this.throwIfStale(gen)
      this.set({ phase: 'pin-entry', error: this.state.error })
      let pin: string
      if (this.queuedPin !== undefined) {
        pin = this.queuedPin
        this.queuedPin = undefined
      } else {
        this.pinWaiter = defer<string>()
        pin = await this.pinWaiter.promise
      }
      const res = await driver.verifyPin(pin)
      // verifyPin is a native call cancel() cannot interrupt: without this, an
      // attempt superseded while parked in it would resume and repaint the
      // SUCCESSOR's phase back to 'pin-entry' over its armed session, then walk
      // on to spend a second, unwanted touch on the card.
      this.throwIfStale(gen)
      if (res.ok) {
        this.set({ phase: 'pin-entry', error: undefined })
        return pin
      }
      this.set({ phase: 'pin-entry', error: { code: 'pin-invalid', retriesLeft: res.retriesLeft } })
    }
  }

  /**
   * Wrap the verified card in the armed signer.
   *
   * `sign()` is where every touch is spent, so it carries the retry loop that
   * used to guard the single ECDH: a retryable rejection (RETRYABLE_TAP_ERRORS)
   * parks on the Retry prompt, then — on a session-based transport — closes
   * the dead session and opens a fresh one via openTapSession (serial re-
   * checked, PIN re-verified) before signing the SAME digest again. Nothing
   * about the caller's transaction changes: the digest is the same, so the
   * signatures already gathered stay valid and the loop resumes at input k.
   * A non-retryable rejection (pin-locked, an unexpected native error) paints
   * `error` and rethrows; the caller aborts its reservation and releases.
   *
   * Batches: on a session-based transport, after `inputsPerTap` successful
   * signatures the NEXT sign() first closes the session and reopens it —
   * publishing the caller's progress under 'waiting-for-key' so the sheet can
   * say "batch b of n" — because the card's 15 s touch cache and CoreNFC's
   * 60 s session both bound what one tap can cover. Persistent readers never
   * reopen.
   *
   * `released` is checked on every resumption point: whichever path ends the
   * session (the caller finishing normally, or the controller's own
   * cancel/detach/timeout relock) makes every later sign() throw
   * `key-removed-mid-op` instead of driving a card the ceremony considers
   * gone. A sign() already parked inside driver.signEcdsa when that happens
   * throws the same on return, whatever the card answered.
   *
   * release() is identity-checked against the controller's `activeHandle`:
   * whichever call reaches it first does the real cleanup — the transport
   * session AND, only if this is still the current signer, the shared arm
   * timer, activeHandle, phase and progress. That makes a signer released late
   * (after a successor has already armed) a no-op against the CONTROLLER's own
   * state and against the SUBSCRIPTION (each attempt owns its own
   * KeyEventSession box, so unsubscribing here can never touch a successor's
   * listener — see KeyEventSession).
   *
   * That scoping does NOT extend to the native transport itself:
   * `driver.stop()` (via the real adapter, `driver.ts`'s `adaptNative.stop`)
   * calls `native.stopDiscovery()` + `native.clearKeyListener()`, which are
   * process-wide — there is exactly one NFC/USB discovery session at the
   * native layer, not one per KeyEventSession box. A late release() on a
   * session-based transport therefore CAN silence a successor's still-open
   * native session even though it cannot touch the successor's JS-level
   * subscription or controller state. In practice this window is narrow (the
   * successor's own subsequent driver.start() reopens discovery), but it is
   * a real gap, not a theoretical one — do not read the subscription-safety
   * property above as a transport-safety one too.
   */
  private makeHandle(
    driver: VaultDriver,
    key: CeremonyKey,
    pin: string,
    session: KeyEventSession,
    gen: number
  ): VaultSigner {
    const inputsPerTap = this.deps.inputsPerTap ?? CeremonyController.DEFAULT_INPUTS_PER_TAP
    let released = false
    /** Successful signatures in the CURRENT transport session. Only consulted
     * on session-based transports. */
    let signedThisSession = 0
    const deadSigner = (): VaultError => new VaultError('key-removed-mid-op', 'Vault signer already released')

    /** Close the dead or exhausted session and open a fresh one on the same
     * box, re-checking serial and PIN. */
    const reopen = async (): Promise<void> => {
      // Unsubscribe BEFORE our own stop() so its session-end detach echo
      // cannot be mistaken for a real one and relock the signer we are about
      // to legitimately continue. openTapSession resubscribes this SAME box
      // fresh for the reopened session.
      this.unsubscribeKeyEvents(session)
      try {
        driver.stop()
      } catch {
        /* best-effort */
      }
      await this.openTapSession(driver, key, pin, session, gen)
      signedThisSession = 0
    }

    const signer: VaultSigner = {
      serial: key.serial,
      pubkey: key.pubkey,
      sign: async (digestHex, progress) => {
        if (released) throw deadSigner()
        // Stale-but-unreleased: a successor ceremony has armed since this
        // signer was handed out (see the module doc on coexisting signers).
        // Refuse before painting a phase, restarting the retention timer or
        // installing a retry/attach waiter over the successor's session. No
        // caller can produce this today (transfers releases in a finally);
        // hardening only.
        if (this.activeHandle !== signer) throw deadSigner()
        if (progress) this.noteSigning(progress)
        // Batch boundary (spec §4.2 step 6). The progress published just above
        // is what the sheet shows under 'waiting-for-key' ("batch b of n").
        if (driver.sessionBased && signedThisSession >= inputsPerTap) {
          await reopen()
          if (released) throw deadSigner()
        }
        for (;;) {
          if (released) throw deadSigner()
          this.set({ phase: 'awaiting-touch', error: undefined })
          try {
            const { signature } = await driver.signEcdsa(key.slot, pin, digestHex)
            // signEcdsa is a native call cancel() cannot interrupt: if the
            // signer was released while we were parked, the answer is not ours
            // to hand out.
            if (released) throw deadSigner()
            signedThisSession++
            return Utils.toArray(signature, 'hex')
          } catch (e) {
            if (released) throw deadSigner()
            const err = e instanceof VaultError ? e : new VaultError('nfc-lost')
            if (!CeremonyController.RETRYABLE_TAP_ERRORS.has(err.code)) {
              // A hard failure is not retryable — paint it so the sheet can
              // explain, and rethrow so the caller aborts and releases;
              // release() then takes the phase back to idle.
              this.set({ phase: 'error', error: { code: err.code, retriesLeft: err.retriesLeft } })
              throw err
            }
            // Park on the Retry prompt. retryWaiter resolves on retry(); it
            // rejects on cancel() (user-cancelled), on notifyKeyDetached or the
            // retention ceiling (key-removed-mid-op) — each of which has
            // already released this signer by the time the rejection lands.
            this.set({ phase: 'error', error: { code: err.code } })
            this.retryWaiter = defer<void>()
            await this.retryWaiter.promise
            if (released) throw deadSigner()
            if (driver.sessionBased) await reopen()
            // loop: sign the SAME digest again
          }
        }
      },
      release: () => {
        if (released) return
        released = true
        // Session-based transports (iOS NFC) held the scan session open for the
        // caller's whole signing loop; this is what finally dismisses the sheet.
        // Unsubscribe first so our own stop() cannot echo back as a detach and
        // re-enter this relock path. Scoped to THIS signer's own session box —
        // see KeyEventSession — so a late release() here can never touch a
        // successor ceremony's subscription or session.
        if (driver.sessionBased) {
          this.unsubscribeKeyEvents(session)
          try {
            driver.stop()
          } catch {
            /* stop is best-effort */
          }
        }
        // Only touch controller-wide state if this is still THE active signer:
        // a stale/superseded signer's release() must not clobber a successor
        // ceremony's armed state, timer, phase or progress.
        if (this.activeHandle === signer) {
          this.clearArmTimer()
          this.activeHandle = undefined
          this.set({ phase: 'idle', progress: undefined })
        }
        // Bound the PIN's exposure now that the session is closed for good —
        // strings can't be wiped, but there is no reason to keep pinning the
        // value in the module singleton once release() has run.
        pin = ''
      }
    }
    return signer
  }

  /** Publish the signing loop's position and refresh the retention window —
   * the sign()-side twin of noteProgress, without a phase change (sign()
   * paints 'awaiting-touch' itself a moment later). */
  private noteSigning(p: { index: number; total: number }): void {
    this.set({ progress: { signed: p.index, total: p.total }, armedUntil: this.startArmTimer() })
  }

  private arm(): void {
    // Anchor the absolute ceiling BEFORE the first startArmTimer, which clamps
    // against it. `progress: undefined` is deliberate: the key is present in
    // every armed state (the pinned key set), empty until the loop reports.
    this.armedAt = now()
    this.set({ phase: 'armed', armedUntil: this.startArmTimer(), error: undefined, progress: undefined })
  }

  /** The instant past which this session may not live, whatever it reports.
   * See ARM_MAX_MULTIPLE. */
  private armCeiling(): number {
    return this.armedAt + CeremonyController.ARM_MAX_MULTIPLE * this.deps.retentionMs
  }

  /** (Re)start the retention countdown and report the new deadline. Shared by
   * the initial arm and every progress note that refreshes it. The deadline is
   * clamped to the absolute ceiling, so a refresh can only ever move it
   * forward WITHIN the session's maximum life, never extend that maximum. */
  private startArmTimer(): number {
    this.clearArmTimer()
    const t = now()
    const deadline = Math.min(t + this.deps.retentionMs, this.armCeiling())
    this.armTimer = setTimeout(() => this.checkArmTimeout(), Math.max(0, deadline - t))
    // Don't let a pending relock timer keep a Node/Jest event loop alive; RN
    // timers have no unref, so guard for it.
    ;(this.armTimer as { unref?: () => void }).unref?.()
    return deadline
  }

  /**
   * Fires when the retention window elapses. If nothing is in flight
   * (phase === 'armed'), relock immediately. If the spend path is mid-operation
   * the phase won't be 'armed' at this exact instant ('preparing' /
   * 'broadcasting') — rather than silently giving up forever (a one-shot timer
   * that fires once and never reschedules would leave the vault key resident in
   * memory indefinitely once the timer happens to land mid-operation), give the
   * in-flight operation one short grace window to finish. A further progress
   * note calls startArmTimer, which cancels this and starts a fresh window; if
   * the operation still hasn't reported by the grace deadline, enforce the
   * timeout regardless of phase.
   *
   * The grace is clamped to the absolute ceiling as well. Without that clamp
   * the ceiling would be trivially escapable: each note past it would schedule
   * a fresh 5 s grace, and the two would trade off forever.
   */
  private checkArmTimeout(): void {
    if (!this.activeHandle) return // already released by some other path
    if (this.state.phase !== 'armed') {
      const t = now()
      const graceEnd = Math.min(t + CeremonyController.ARM_GRACE_MS, this.armCeiling())
      if (graceEnd > t) {
        this.armTimer = setTimeout(() => this.enforceArmTimeout(), graceEnd - t)
        ;(this.armTimer as { unref?: () => void }).unref?.()
        return
      }
      // Ceiling already reached — no more grace to give.
    }
    this.enforceArmTimeout()
  }

  private enforceArmTimeout(): void {
    if (!this.activeHandle) return // already released by some other path
    const err = new VaultError('key-removed-mid-op')
    this.retryWaiter?.reject(err)
    this.attachWaiter?.reject(err)
    this.activeHandle.release()
    this.onRelock?.('timeout')
  }

  private clearArmTimer(): void {
    if (this.armTimer) {
      clearTimeout(this.armTimer)
      this.armTimer = undefined
    }
  }

  private throwIfCancelled(): void {
    if (this.cancelled) throw new VaultError('user-cancelled')
  }

  /**
   * The guard every step of an arm attempt resumes behind.
   *
   * `cancelled` alone is not enough, and this is the whole subtlety of the
   * resurrection class: cancel() sets it, but the requestSigner() that follows
   * resets it to false for the NEW attempt. An attempt parked in a native call
   * that cancel() cannot interrupt — `driver.verifyPin`, `driver.getKeyInfo`
   * — therefore comes back to a flag that reads clean, and
   * would carry on painting phases, installing waiters, and talking to the card
   * on behalf of a ceremony that no longer exists. Only the generation can tell
   * it apart, so every resumption point in the arm flow checks BOTH.
   *
   * Throwing (rather than returning) is deliberate: it unwinds to run()'s catch,
   * which is generation-guarded and so swallows a superseded attempt's failure
   * without touching the successor's waiters or phase, while its finally still
   * closes this attempt's own session.
   */
  private throwIfStale(gen: number): void {
    if (gen !== this.generation) {
      throw new VaultError('user-cancelled', 'Superseded by a newer ceremony')
    }
    this.throwIfCancelled()
  }

  private resolveAll(signer: VaultSigner): void {
    const ws = this.waiters
    this.waiters = []
    this.rejecters = []
    ws.forEach(w => w(signer))
  }

  private failAll(e: unknown): void {
    const rs = this.rejecters
    this.waiters = []
    this.rejecters = []
    rs.forEach(r => r(e))
  }

  private set(patch: Partial<CeremonyState>): void {
    this.state = { ...this.state, ...patch, reason: this.reason }
    this.subscribers.forEach(cb => cb(this.state))
  }
}

// Wall-clock "now" for the arm timer's deadlines and its absolute ceiling.
// Kept as one named helper so the module's use of Date.now stays auditable in
// a single place; here Date.now is fine (RN app + jest).
function now(): number {
  return Date.now()
}
