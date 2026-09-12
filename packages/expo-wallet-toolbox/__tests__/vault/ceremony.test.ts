/**
 * Ceremony controller — the UI-free state machine that turns "sign these
 * digests with key X" into an insert → PIN → tap flow and back into a
 * VaultSigner: the chosen card's serial + compressed pubkey plus
 * sign(digest) → DER, held for the retention window and dropped on release.
 * Driven entirely by the multi-serial mock driver plus a fake store view that
 * vends a two-key meta, so every signature really is produced by the mock
 * card the caller chose — and is verified here against that card's public
 * key with @noble/curves, exactly the way the R1C lock will check it.
 *
 * Plan 1's r1comb.ts must exist: compressPubkey is the canonical form the
 * store records and the signer reports.
 */
import { Utils } from '@bsv/sdk'
import { p256 } from '@noble/curves/nist.js'
import { CeremonyController, CeremonyState, VaultSigner } from '../../core/services/vault/ceremony'
import { MockYubiKey } from '../../core/services/vault/mockYubiKey'
import { compressPubkey } from '../../core/services/vault/r1comb'
import { VaultError } from '../../core/services/vault/types'

const VAULT_SLOT = 0x82
const RETENTION = 120_000
const SERIAL_A = 'MOCK-A'
const SERIAL_B = 'MOCK-B'
const PIN = '123456'
/** A fixed 32-byte digest. WHAT gets signed is transfers.ts's business
 * (preimage → signerDigest); this file owns the tap. */
const DIGEST = 'ab'.repeat(32)
/** Distinct digests for a batch, one byte repeated. */
const digestAt = (i: number): string => i.toString(16).padStart(2, '0').repeat(32)

interface CeremonyHarness {
  ceremony: CeremonyController
  mock: MockYubiKey
  /** The two-key list the store view vends — vaultStore's public shape. */
  meta: { keys: { serial: string; slot: number; pubkey: string }[] }
  pubA: string
  pubB: string
}

/**
 * Wire a CeremonyController to a fresh MockYubiKey holding TWO enrolled keys
 * (serials MOCK-A and MOCK-B, each with its own generated slot key) and a
 * store view vending the matching two-key meta. Both cards are "removed"
 * afterwards so every test starts from "no key seen yet" unless it calls
 * mock.insertKey() itself.
 */
async function makeCeremony(
  opts: { retentionMs?: number; sessionBased?: boolean; attachTimeoutMs?: number; inputsPerTap?: number } = {}
): Promise<CeremonyHarness> {
  const mock = new MockYubiKey()
  if (opts.sessionBased) (mock as unknown as { sessionBased: boolean }).sessionBased = true
  mock.insertKey(SERIAL_A)
  const { publicKey: rawA } = await mock.generateVaultKey(SERIAL_A)
  mock.insertKey(SERIAL_B)
  const { publicKey: rawB } = await mock.generateVaultKey(SERIAL_B)
  mock.removeKey()
  const pubA = compressPubkey(rawA)
  const pubB = compressPubkey(rawB)
  const meta = {
    keys: [
      { serial: SERIAL_A, slot: VAULT_SLOT, pubkey: pubA },
      { serial: SERIAL_B, slot: VAULT_SLOT, pubkey: pubB }
    ]
  }
  const ceremony = new CeremonyController({
    getDriver: () => mock,
    store: { getMeta: async () => meta },
    retentionMs: opts.retentionMs ?? RETENTION,
    attachTimeoutMs: opts.attachTimeoutMs,
    inputsPerTap: opts.inputsPerTap
  })
  return { ceremony, mock, meta, pubA, pubB }
}

/** True when `der` is a valid P-256 signature over `digestHex` by `pubkeyHex33`
 * (raw digest, no prehash; high-S accepted — the mock does not normalise). */
const verifies = (der: number[], digestHex: string, pubkeyHex33: string): boolean => {
  const sig = p256.Signature.fromBytes(Uint8Array.from(der), 'der')
  return p256.verify(
    sig.toBytes(),
    Uint8Array.from(Utils.toArray(digestHex, 'hex')),
    Uint8Array.from(Utils.toArray(pubkeyHex33, 'hex')),
    { prehash: false, lowS: false }
  )
}

// microtask flush helper — drains microtasks by hopping the macrotask queue
const flush = () => new Promise<void>(r => setTimeout(r, 0))

/** Arm MOCK-A on a harness: request, present the card, PIN, await. Works for
 * both transports (on NFC the queued PIN is applied when pin-entry is
 * reached, then start() finds the "held" card). */
async function armA(h: CeremonyHarness, reason = 'x'): Promise<VaultSigner> {
  const p = h.ceremony.requestSigner(reason, SERIAL_A)
  h.mock.insertKey(SERIAL_A)
  h.ceremony.submitPin(PIN)
  return p
}

describe('CeremonyController: arming', () => {
  test('driver unavailable rejects with driver-unavailable', async () => {
    const c = new CeremonyController({
      getDriver: () => null,
      store: { getMeta: async () => null },
      retentionMs: RETENTION
    })
    await expect(c.requestSigner('x', SERIAL_A)).rejects.toMatchObject({ code: 'driver-unavailable' })
  })

  test('no meta (not enrolled) rejects with not-enrolled', async () => {
    const mock = new MockYubiKey()
    mock.insertKey(SERIAL_A)
    const c = new CeremonyController({
      getDriver: () => mock,
      store: { getMeta: async () => null },
      retentionMs: RETENTION
    })
    await expect(c.requestSigner('x', SERIAL_A)).rejects.toMatchObject({ code: 'not-enrolled' })
  })

  test('a chosen serial that is not in the key list rejects with not-enrolled BEFORE any hardware contact', async () => {
    // A removed key, or a stale chooser: nothing a tap could do, so no prompt
    // and no card round trip (spec §4.2 step 6).
    const { ceremony: c, mock } = await makeCeremony()
    mock.insertKey(SERIAL_A) // a key IS present — it must not even be asked its serial
    const startSpy = jest.spyOn(mock, 'start')
    const infoSpy = jest.spyOn(mock, 'getKeyInfo')
    const err = await c.requestSigner('x', 'MOCK-Z').catch(e => e)
    expect(err).toMatchObject({ code: 'not-enrolled' })
    expect(err.message).toContain('MOCK-Z')
    expect(startSpy).not.toHaveBeenCalled()
    expect(infoSpy).not.toHaveBeenCalled()
    expect(c.state.phase).toBe('error')
  })

  test('a concurrent requestSigner for the same serial is refused so ownership is never shared', async () => {
    const h = await makeCeremony()
    const p1 = h.ceremony.requestSigner('op A', SERIAL_A)
    await expect(h.ceremony.requestSigner('op B', SERIAL_A)).rejects.toMatchObject({ code: 'ceremony-active' })
    h.mock.insertKey(SERIAL_A)
    h.ceremony.submitPin(PIN)
    const s1 = await p1
    s1.release()
  })

  test('a concurrent requestSigner for a DIFFERENT serial is refused at once and leaves the in-flight ceremony alone', async () => {
    const h = await makeCeremony()
    const p1 = h.ceremony.requestSigner('op A', SERIAL_A)
    const err = await h.ceremony.requestSigner('op B', SERIAL_B).catch(e => e)
    expect(err).toMatchObject({ code: 'ceremony-active' })
    // Ceremony A is unaffected.
    h.mock.insertKey(SERIAL_A)
    h.ceremony.submitPin(PIN)
    const s1 = await p1
    expect(s1.serial).toBe(SERIAL_A)
    expect(h.ceremony.state.phase).toBe('armed')
    s1.release()
  })

  test('wrong key serial (persistent reader) → serial-mismatch naming both serials', async () => {
    const { ceremony: c, mock } = await makeCeremony()
    const p = c.requestSigner('x', SERIAL_A)
    mock.insertKey(SERIAL_B) // enrolled, but not the one chosen
    const err = await p.catch(e => e)
    expect(err).toMatchObject({ code: 'serial-mismatch' })
    expect(err.message).toContain(SERIAL_B) // what was tapped
    expect(err.message).toContain(SERIAL_A) // what was chosen
    expect(err.details).toEqual({ tapped: SERIAL_B, chosen: SERIAL_A })
    expect(c.state.phase).toBe('error')
    expect(c.state.error?.code).toBe('serial-mismatch')
  })

  test('wrong key serial (NFC tap) → serial-mismatch, and the finally still stops the session (nothing was armed)', async () => {
    const { ceremony: c, mock: nfc } = await makeCeremony({ sessionBased: true })
    const stopSpy = jest.spyOn(nfc, 'stop')
    const p = c.requestSigner('x', SERIAL_A)
    nfc.insertKey('WRONG-SERIAL')
    c.submitPin(PIN)
    await expect(p).rejects.toMatchObject({ code: 'serial-mismatch' })
    expect(stopSpy).toHaveBeenCalledTimes(1)
  })

  test('a wrong serial is rejected before the PIN is verified and before any signature — a foreign card is never asked anything', async () => {
    const { ceremony: c, mock } = await makeCeremony()
    const signSpy = jest.spyOn(mock, 'signEcdsa')
    const verifyPinSpy = jest.spyOn(mock, 'verifyPin')
    const p = c.requestSigner('x', SERIAL_A)
    mock.insertKey(SERIAL_B)
    await expect(p).rejects.toMatchObject({ code: 'serial-mismatch' })
    expect(verifyPinSpy).not.toHaveBeenCalled()
    expect(signSpy).not.toHaveBeenCalled()
  })

  test('wrong PIN (persistent reader) returns to pin-entry with retriesLeft, then succeeds', async () => {
    const { ceremony: c, mock, pubA } = await makeCeremony()
    const p = c.requestSigner('x', SERIAL_A)
    mock.insertKey(SERIAL_A)
    await flush()
    c.submitPin('000000')
    await flush()
    expect(c.state.phase).toBe('pin-entry')
    expect(c.state.error?.code).toBe('pin-invalid')
    expect(c.state.error?.retriesLeft).toBe(2)
    c.submitPin(PIN)
    const signer = await p
    expect(signer.serial).toBe(SERIAL_A)
    expect(signer.pubkey).toBe(pubA)
    expect(verifies(await signer.sign(DIGEST), DIGEST, pubA)).toBe(true)
    signer.release()
  })

  test('NFC: a wrong PIN aborts the whole ceremony (no in-place retry) with retriesLeft intact, and stops the session', async () => {
    // A wrong PIN cannot be corrected in place on NFC — the PIN is collected
    // before the system scan sheet ever opens, so there is nothing to
    // re-prompt mid-tap. The caller (a fresh withdraw attempt) collects the
    // PIN again.
    const { ceremony: c, mock: nfc } = await makeCeremony({ sessionBased: true })
    const stopSpy = jest.spyOn(nfc, 'stop')
    const p = c.requestSigner('x', SERIAL_A)
    nfc.insertKey(SERIAL_A)
    c.submitPin('000000') // wrong
    await expect(p).rejects.toMatchObject({ code: 'pin-invalid', retriesLeft: 2 })
    expect(c.state.phase).toBe('error')
    expect(c.state.error?.code).toBe('pin-invalid')
    expect(c.state.error?.retriesLeft).toBe(2)
    expect(stopSpy).toHaveBeenCalledTimes(1) // nothing armed → the finally closed it
  })

  test('detach while waiting for the PIN → key-removed-mid-op', async () => {
    const { ceremony: c, mock } = await makeCeremony()
    const p = c.requestSigner('x', SERIAL_A)
    mock.insertKey(SERIAL_A)
    await flush()
    expect(c.state.phase).toBe('pin-entry')
    mock.removeKey() // pulled before the PIN is ever submitted
    await expect(p).rejects.toMatchObject({ code: 'key-removed-mid-op' })
    expect(c.state.phase).toBe('error')
  })

  test('cancel rejects the pending request with user-cancelled', async () => {
    const { ceremony: c, mock } = await makeCeremony()
    const p = c.requestSigner('x', SERIAL_A)
    mock.insertKey(SERIAL_A)
    await flush()
    c.cancel()
    await expect(p).rejects.toMatchObject({ code: 'user-cancelled' })
    expect(c.state.phase).toBe('idle')
  })

  test('a PIN queued before cancel() is dropped: the next ceremony shows pin-entry instead of consuming it', async () => {
    const { ceremony: c, mock } = await makeCeremony()
    c.submitPin(PIN) // nothing is waiting for it — queued
    c.cancel()
    const verifySpy = jest.spyOn(mock, 'verifyPin')
    const p = c.requestSigner('x', SERIAL_A)
    mock.insertKey(SERIAL_A)
    await flush()
    expect(c.state.phase).toBe('pin-entry') // the stale PIN was not consumed
    expect(verifySpy).not.toHaveBeenCalled()
    c.submitPin(PIN)
    ;(await p).release()
  })

  test('a PIN queued with no ceremony in flight is dropped when the next one starts; one submitted after it is asked for is kept', async () => {
    const { ceremony: c, mock } = await makeCeremony()
    c.submitPin(PIN) // leftover: no ceremony asked for it
    const verifySpy = jest.spyOn(mock, 'verifyPin')
    const p = c.requestSigner('x', SERIAL_A)
    mock.insertKey(SERIAL_A)
    await flush()
    expect(c.state.phase).toBe('pin-entry')
    expect(verifySpy).not.toHaveBeenCalled()
    c.submitPin(PIN) // for THIS ceremony — consumed
    const signer = await p
    expect(c.state.phase).toBe('armed')
    expect(verifySpy).toHaveBeenCalledTimes(1)
    signer.release()
  })

  test('armed window expires back to idle, fires onRelock(timeout), and the signer refuses afterwards', async () => {
    const h = await makeCeremony({ retentionMs: 1000 })
    const relocks: string[] = []
    h.ceremony.onRelock = why => relocks.push(why)
    const signer = await armA(h)
    expect(h.ceremony.state.phase).toBe('armed')
    await new Promise<void>(r => setTimeout(r, 1050))
    expect(h.ceremony.state.phase).toBe('idle')
    expect(relocks).toEqual(['timeout'])

    // The card is no longer ours to drive: sign() must refuse, not tap.
    await expect(signer.sign(DIGEST)).rejects.toMatchObject({ code: 'key-removed-mid-op' })
  })

  test('notifyKeyDetached during the armed window relocks immediately and the signer refuses afterwards', async () => {
    const h = await makeCeremony()
    const relocks: string[] = []
    h.ceremony.onRelock = why => relocks.push(why)
    const signer = await armA(h)
    expect(h.ceremony.state.phase).toBe('armed')
    h.ceremony.notifyKeyDetached()
    expect(h.ceremony.state.phase).toBe('idle')
    expect(relocks).toEqual(['detached'])
    await expect(signer.sign(DIGEST)).rejects.toMatchObject({ code: 'key-removed-mid-op' })
  })

  test('arming a session-based driver does NOT stop it — only release() does', async () => {
    const h = await makeCeremony({ sessionBased: true })
    const stopSpy = jest.spyOn(h.mock, 'stop')
    const signer = await armA(h)
    expect(h.ceremony.state.phase).toBe('armed')
    expect(stopSpy).not.toHaveBeenCalled()

    signer.release()
    expect(stopSpy).toHaveBeenCalledTimes(1)
    signer.release() // idempotent
    expect(stopSpy).toHaveBeenCalledTimes(1)
  })

  test('arming a persistent reader never stops it, matching before', async () => {
    const h = await makeCeremony()
    const stopSpy = jest.spyOn(h.mock, 'stop')
    const signer = await armA(h)
    expect(stopSpy).not.toHaveBeenCalled()
    signer.release()
    expect(stopSpy).not.toHaveBeenCalled()
  })

  test('a session-based driver keeps notifying the ceremony after arm — an unprompted detach while armed still relocks', async () => {
    // WalletContext's own persistent-reader listener explicitly skips
    // sessionBased drivers (it exists only for Android USB unplug), so the
    // ceremony's OWN run()-level subscription is the only thing that can ever
    // learn an NFC session detached. If that subscription were torn down the
    // moment run() completes, a real driver-emitted 'detached' event would be
    // silently dropped for the rest of the signer's life, leaving a live
    // signer behind a card that is gone. This drives the event through the
    // MOCK's own emit, not through calling ceremony.notifyKeyDetached()
    // directly, so it exercises the subscription wiring.
    const h = await makeCeremony({ sessionBased: true })
    const relocks: string[] = []
    h.ceremony.onRelock = why => relocks.push(why)
    const signer = await armA(h)
    expect(h.ceremony.state.phase).toBe('armed')

    h.mock.removeKey() // a real driver-emitted detach, not a manual notify call
    expect(h.ceremony.state.phase).toBe('idle')
    expect(relocks).toEqual(['detached'])
    await expect(signer.sign(DIGEST)).rejects.toMatchObject({ code: 'key-removed-mid-op' })
  })
})

describe('CeremonyController: NFC session failure before a key connects', () => {
  // The production hang: the system NFC sheet was cancelled or timed out
  // BEFORE any key connected, YubiKit reported it via didFailConnectingNFC,
  // and nothing forwarded it — so the ceremony parked in waiting-for-key
  // forever. These drive the failure through the mock's own emit so the
  // subscription wiring is exercised, not just the notify method body.

  test('user cancelling the system NFC sheet rejects with user-cancelled, goes idle, and closes the session', async () => {
    const { ceremony: c, mock: nfc } = await makeCeremony({ sessionBased: true })
    const stopSpy = jest.spyOn(nfc, 'stop')
    const p = c.requestSigner('x', SERIAL_A)
    c.submitPin(PIN) // NFC collects the PIN before the tap
    await flush() // reach waiting-for-key (driver.start() done, no key held)
    expect(c.state.phase).toBe('waiting-for-key')

    nfc.failSession('user-cancelled')
    await expect(p).rejects.toMatchObject({ code: 'user-cancelled' })
    expect(c.state.phase).toBe('idle')
    expect(stopSpy).toHaveBeenCalledTimes(1) // nothing armed → the finally closed it
  })

  test('the session dying without a key (timeout / failed to present) rejects with no-key and surfaces an error', async () => {
    const { ceremony: c, mock: nfc } = await makeCeremony({ sessionBased: true })
    const stopSpy = jest.spyOn(nfc, 'stop')
    const p = c.requestSigner('x', SERIAL_A)
    c.submitPin(PIN)
    await flush()
    expect(c.state.phase).toBe('waiting-for-key')

    nfc.failSession('no-key')
    await expect(p).rejects.toMatchObject({ code: 'no-key' })
    expect(c.state.phase).toBe('error')
    expect(c.state.error?.code).toBe('no-key')
    expect(stopSpy).toHaveBeenCalledTimes(1)
  })

  test('watchdog: no attach within attachTimeoutMs rejects with no-key even when the driver stays silent', async () => {
    // Covers the paths YubiKit swallows internally (readingAvailable false,
    // session invalidated before didBecomeActive) where NO event ever reaches
    // JS — the only layer that can catch those is a deadline of our own.
    const { ceremony: c } = await makeCeremony({ sessionBased: true, attachTimeoutMs: 40 })
    const p = c.requestSigner('x', SERIAL_A)
    c.submitPin(PIN)
    await flush()
    expect(c.state.phase).toBe('waiting-for-key')

    await expect(p).rejects.toMatchObject({ code: 'no-key' })
    expect(c.state.phase).toBe('error')
    expect(c.state.error?.code).toBe('no-key')
  })

  test('watchdog is disarmed by a successful attach — an armed session is not killed when the deadline passes', async () => {
    const h = await makeCeremony({ sessionBased: true, attachTimeoutMs: 40 })
    const signer = await armA(h) // key already held: start() emits attached immediately
    expect(h.ceremony.state.phase).toBe('armed')

    await new Promise<void>(r => setTimeout(r, 80)) // sail past the deadline
    expect(h.ceremony.state.phase).toBe('armed') // no spurious relock or error
    expect(verifies(await signer.sign(DIGEST), DIGEST, h.pubA)).toBe(true)
    signer.release()
  })

  test('watchdog does not apply to a persistent reader — waiting for a USB insert has no deadline', async () => {
    const { ceremony: c, mock, pubA } = await makeCeremony({ attachTimeoutMs: 40 })
    const p = c.requestSigner('x', SERIAL_A)
    await flush()
    expect(c.state.phase).toBe('waiting-for-key')

    await new Promise<void>(r => setTimeout(r, 80)) // well past the (inapplicable) deadline
    expect(c.state.phase).toBe('waiting-for-key')

    mock.insertKey(SERIAL_A) // user finally plugs the key in
    c.submitPin(PIN)
    const signer = await p
    expect(signer.pubkey).toBe(pubA)
    expect(verifies(await signer.sign(DIGEST), DIGEST, pubA)).toBe(true)
    signer.release()
  })

  test("the NFC alert text is the caller's reason, on the first session and on every reopen", async () => {
    // Decision 1 in this task's preamble: the ceremony has no i18n and
    // requestSigner has no message parameter, so `reason` IS the sheet text.
    const h = await makeCeremony({ sessionBased: true, inputsPerTap: 1 })
    const startSpy = jest.spyOn(h.mock, 'start')
    const signer = await armA(h, 'Hold your YubiKey here to sign')
    await signer.sign(digestAt(0))
    await signer.sign(digestAt(1)) // inputsPerTap = 1 → a reopen before this one
    expect(startSpy.mock.calls.map(c => c[0])).toEqual([
      'Hold your YubiKey here to sign',
      'Hold your YubiKey here to sign'
    ])
    signer.release()
  })
})

describe('vault signer', () => {
  test("one tap yields a signer whose DER signature verifies against the chosen key's enrolled pubkey", async () => {
    const h = await makeCeremony()
    const signer = await armA(h, 'test withdrawal')
    expect(signer.serial).toBe(SERIAL_A)
    expect(signer.pubkey).toBe(h.pubA)
    const der = await signer.sign(DIGEST)
    // DER, like both real platforms: 0x30 <len> 0x02 <r> 0x02 <s>.
    expect(der[0]).toBe(0x30)
    expect(verifies(der, DIGEST, h.pubA)).toBe(true)
    expect(verifies(der, DIGEST, h.pubB)).toBe(false)
    signer.release()
  })

  test("choosing MOCK-B signs with B's slot key, not A's", async () => {
    const { ceremony: c, mock, pubA, pubB } = await makeCeremony()
    const p = c.requestSigner('x', SERIAL_B)
    mock.insertKey(SERIAL_B)
    c.submitPin(PIN)
    const signer = await p
    expect(signer.serial).toBe(SERIAL_B)
    expect(signer.pubkey).toBe(pubB)
    const der = await signer.sign(DIGEST)
    expect(verifies(der, DIGEST, pubB)).toBe(true)
    expect(verifies(der, DIGEST, pubA)).toBe(false)
    signer.release()
  })

  test('release drops the signer and relocks; sign() after release throws key-removed-mid-op; progress is cleared', async () => {
    const h = await makeCeremony()
    const signer = await armA(h)
    await signer.sign(DIGEST, { index: 2, total: 5 })
    expect(h.ceremony.state.progress).toEqual({ signed: 2, total: 5 })
    expect(h.ceremony.state.phase).toBe('awaiting-touch')

    signer.release()
    expect(h.ceremony.state.phase).toBe('idle')
    expect(h.ceremony.state.progress).toBeUndefined()
    await expect(signer.sign(DIGEST)).rejects.toMatchObject({ code: 'key-removed-mid-op' })
  })

  test('no card contact until the first sign(): arming verifies the PIN once and signs nothing; each sign() is one signEcdsa call', async () => {
    const h = await makeCeremony()
    const signSpy = jest.spyOn(h.mock, 'signEcdsa')
    const verifyPinSpy = jest.spyOn(h.mock, 'verifyPin')
    const startSpy = jest.spyOn(h.mock, 'start')
    const signer = await armA(h)
    expect(signSpy).not.toHaveBeenCalled()
    expect(verifyPinSpy).toHaveBeenCalledTimes(1)

    for (let i = 0; i < 3; i++) {
      expect(verifies(await signer.sign(digestAt(i)), digestAt(i), h.pubA)).toBe(true)
    }
    expect(signSpy).toHaveBeenCalledTimes(3)
    expect(signSpy).toHaveBeenNthCalledWith(1, SERIAL_A, PIN, digestAt(0))
    expect(signSpy).toHaveBeenNthCalledWith(3, SERIAL_A, PIN, digestAt(2))
    expect(verifyPinSpy).toHaveBeenCalledTimes(1) // 'once' PIN policy: verified at arm only
    expect(startSpy).not.toHaveBeenCalled() // persistent reader with the key present: no session to open
    signer.release()
  })

  test('nothing key-shaped reaches the React-visible ceremony state, and the key set is pinned', async () => {
    const h = await makeCeremony()
    const seen: string[] = []
    const unsubscribe = h.ceremony.subscribe(s => seen.push(JSON.stringify(s)))
    const signer = await armA(h)
    // Pinned: a new field cannot be added to CeremonyState without editing
    // this line — see the SECURITY note in ceremony.ts.
    expect(Object.keys(h.ceremony.state).sort()).toEqual(['armedUntil', 'error', 'phase', 'progress', 'reason'])
    const der = await signer.sign(DIGEST, { index: 0, total: 1 })
    unsubscribe()

    const derHex = Utils.toHex(der)
    for (const snapshot of seen) {
      expect(snapshot).not.toContain(PIN) // the PIN never lands in state
      expect(snapshot).not.toContain(derHex) // nor a signature
      expect(snapshot).not.toContain(h.pubA) // nor the pubkey — that rides on the signer
      expect(snapshot).not.toContain(SERIAL_A) // nor the serial (`reason` is 'x' here)
    }
    signer.release()
  })

  test('persistent reader: a touch timeout on the SECOND signature returns to error; retry() resumes that same digest without re-entering the PIN', async () => {
    const h = await makeCeremony()
    const verifyPinSpy = jest.spyOn(h.mock, 'verifyPin')
    const signSpy = jest.spyOn(h.mock, 'signEcdsa')
    const signer = await armA(h, 'Withdraw from vault')
    expect(verifies(await signer.sign(digestAt(0)), digestAt(0), h.pubA)).toBe(true)

    h.mock.setTouchBehavior('timeout') // the touch is missed on input 1
    const p1 = signer.sign(digestAt(1), { index: 1, total: 3 })
    await flush()
    expect(h.ceremony.state.phase).toBe('error')
    expect(h.ceremony.state.error?.code).toBe('touch-timeout')
    expect(h.ceremony.state.progress).toEqual({ signed: 1, total: 3 }) // the sheet still knows where it is
    expect(verifyPinSpy).toHaveBeenCalledTimes(1)

    h.mock.setTouchBehavior('instant')
    h.ceremony.retry()
    const d1 = await p1
    expect(verifies(d1, digestAt(1), h.pubA)).toBe(true)
    expect(verifyPinSpy).toHaveBeenCalledTimes(1) // no reopen on a persistent reader → no re-verify
    expect(h.ceremony.state.error).toBeUndefined()

    expect(verifies(await signer.sign(digestAt(2)), digestAt(2), h.pubA)).toBe(true)
    // 1 ok + 1 timed out + 1 retry of the SAME digest + 1 ok
    expect(signSpy.mock.calls.map(c => c[2])).toEqual([digestAt(0), digestAt(1), digestAt(1), digestAt(2)])
    signer.release()
  })

  test('NFC: a dropped tap mid-signature closes the dead session and reopens a fresh one — re-checking the serial and re-verifying the PIN — then signs the SAME digest', async () => {
    // Spec §4.2 step 6: the reservation and the signatures gathered so far are
    // the caller's; the ceremony's job is to get the card back and continue.
    const h = await makeCeremony({ sessionBased: true })
    const startSpy = jest.spyOn(h.mock, 'start')
    const stopSpy = jest.spyOn(h.mock, 'stop')
    const verifyPinSpy = jest.spyOn(h.mock, 'verifyPin')
    const getKeyInfoSpy = jest.spyOn(h.mock, 'getKeyInfo')
    const signSpy = jest.spyOn(h.mock, 'signEcdsa')
    const signer = await armA(h, 'Withdraw from vault')
    expect(startSpy).toHaveBeenCalledTimes(1)

    h.mock.setTouchBehavior('timeout') // the tap drops mid-signature
    const p = signer.sign(DIGEST)
    await flush()
    expect(h.ceremony.state.phase).toBe('error')
    expect(h.ceremony.state.error?.code).toBe('touch-timeout')
    expect(startSpy).toHaveBeenCalledTimes(1) // no reopen yet — still waiting on Retry
    // The dead session is NOT torn down just for showing the error — only
    // once the user actually retries, so a touch-timeout that turns out to be
    // a false alarm (session still alive) never had to be closed at all.
    expect(stopSpy).not.toHaveBeenCalled()

    h.mock.setTouchBehavior('instant')
    h.ceremony.retry()
    await flush()
    expect(stopSpy).toHaveBeenCalledTimes(1) // retry closes the dead session before reopening

    const der = await p
    expect(verifies(der, DIGEST, h.pubA)).toBe(true)
    expect(startSpy).toHaveBeenCalledTimes(2) // retry reopened a fresh NFC session
    expect(verifyPinSpy).toHaveBeenCalledTimes(2) // PIN re-verified on the fresh session
    expect(getKeyInfoSpy).toHaveBeenCalledTimes(2) // serial RE-CHECKED on the fresh session
    expect(signSpy.mock.calls.map(c => c[2])).toEqual([DIGEST, DIGEST]) // one dropped, one landed — same digest

    signer.release()
    expect(stopSpy).toHaveBeenCalledTimes(2) // release() closes the reopened session
  })

  test('NFC: a card swap between the dropped tap and the retry is caught by the re-check — the foreign card never signs', async () => {
    const h = await makeCeremony({ sessionBased: true })
    const signSpy = jest.spyOn(h.mock, 'signEcdsa')
    const signer = await armA(h)
    h.mock.setTouchBehavior('timeout')
    const p = signer.sign(DIGEST)
    await flush()
    expect(h.ceremony.state.error?.code).toBe('touch-timeout')
    expect(signSpy).toHaveBeenCalledTimes(1)

    h.mock.setTouchBehavior('instant')
    h.mock.insertKey(SERIAL_B) // the OTHER enrolled card lands on the retry tap
    h.ceremony.retry()
    const err = await p.catch(e => e)
    expect(err).toMatchObject({ code: 'serial-mismatch' })
    expect(err.message).toContain(SERIAL_B)
    expect(err.message).toContain(SERIAL_A)
    expect(signSpy).toHaveBeenCalledTimes(1) // B was never asked to sign A's digest
    signer.release()
    expect(h.ceremony.state.phase).toBe('idle')
  })

  test('NFC: a genuine detach while a retry is pending relocks and fails sign() with key-removed-mid-op', async () => {
    // A driver-emitted detach is the hardware leaving, not a dropped tap:
    // the signer is released, exactly as before this refactor.
    const h = await makeCeremony({ sessionBased: true })
    const relocks: string[] = []
    h.ceremony.onRelock = why => relocks.push(why)
    const signer = await armA(h)
    h.mock.setTouchBehavior('timeout')
    const p = signer.sign(DIGEST)
    await flush()
    expect(h.ceremony.state.error?.code).toBe('touch-timeout')

    h.mock.removeKey() // reaches the ceremony through its own session subscription

    await expect(p).rejects.toMatchObject({ code: 'key-removed-mid-op' })
    expect(relocks).toEqual(['detached'])
    expect(h.ceremony.state.phase).toBe('idle')
    await expect(signer.sign(DIGEST)).rejects.toMatchObject({ code: 'key-removed-mid-op' })
  })

  test("persistent reader: WalletContext's notifyKeyDetached during a retry wait does the same", async () => {
    // After arming, a persistent reader's ceremony drops its own listener and
    // relies on WalletContext's always-on one, which calls notifyKeyDetached.
    const h = await makeCeremony()
    const relocks: string[] = []
    h.ceremony.onRelock = why => relocks.push(why)
    const signer = await armA(h)
    h.mock.setTouchBehavior('timeout')
    const p = signer.sign(DIGEST)
    await flush()
    expect(h.ceremony.state.error?.code).toBe('touch-timeout')

    h.mock.removeKey()
    h.ceremony.notifyKeyDetached()

    await expect(p).rejects.toMatchObject({ code: 'key-removed-mid-op' })
    expect(relocks).toEqual(['detached'])
    expect(h.ceremony.state.phase).toBe('idle')
  })

  test('cancelling during a retry wait rejects sign() with user-cancelled and relocks manually', async () => {
    const h = await makeCeremony()
    const relocks: string[] = []
    h.ceremony.onRelock = why => relocks.push(why)
    const signer = await armA(h)
    h.mock.setTouchBehavior('timeout')
    const p = signer.sign(DIGEST)
    await flush()
    expect(h.ceremony.state.phase).toBe('error')

    h.ceremony.cancel()
    await expect(p).rejects.toMatchObject({ code: 'user-cancelled' })
    expect(h.ceremony.state.phase).toBe('idle')
    expect(relocks).toEqual(['manual'])
    await expect(signer.sign(DIGEST)).rejects.toMatchObject({ code: 'key-removed-mid-op' })
  })

  test('a non-retryable signEcdsa error (pin-locked) propagates out of sign(), paints phase: error, and release() goes idle', async () => {
    const h = await makeCeremony()
    const signer = await armA(h)
    // pin-locked is a real driver failure, not one of the RETRYABLE_TAP_ERRORS
    // (touch-timeout / nfc-lost / key-removed-mid-op) — it must not be
    // retried in place.
    jest.spyOn(h.mock, 'signEcdsa').mockRejectedValueOnce(new VaultError('pin-locked', 'PIN is blocked'))
    await expect(signer.sign(DIGEST)).rejects.toMatchObject({ code: 'pin-locked' })
    expect(h.ceremony.state.phase).toBe('error')
    expect(h.ceremony.state.error?.code).toBe('pin-locked')
    signer.release()
    expect(h.ceremony.state.phase).toBe('idle')
  })

  test('an unrecognized (non-VaultError) signEcdsa failure is treated as a retryable field drop', async () => {
    const h = await makeCeremony()
    const signer = await armA(h)
    jest.spyOn(h.mock, 'signEcdsa').mockRejectedValueOnce(new Error('tag connection lost'))
    const p = signer.sign(DIGEST)
    await flush()
    expect(h.ceremony.state.phase).toBe('error')
    expect(h.ceremony.state.error?.code).toBe('nfc-lost')

    h.ceremony.retry()
    expect(verifies(await p, DIGEST, h.pubA)).toBe(true)
    signer.release()
  })

  test('NFC batches: 20 signatures with inputsPerTap 8 open ceil(20/8) = 3 sessions, re-checking serial and PIN each time, and show waiting-for-key with the progress between batches', async () => {
    const h = await makeCeremony({ sessionBased: true, inputsPerTap: 8 })
    const startSpy = jest.spyOn(h.mock, 'start')
    const stopSpy = jest.spyOn(h.mock, 'stop')
    const verifyPinSpy = jest.spyOn(h.mock, 'verifyPin')
    const getKeyInfoSpy = jest.spyOn(h.mock, 'getKeyInfo')
    const signer = await armA(h)
    expect(startSpy).toHaveBeenCalledTimes(1)
    // Subscribe AFTER arming: the initial waiting-for-key (no progress yet) is
    // the arm's, not a batch boundary's.
    const snapshots: CeremonyState[] = []
    const unsubscribe = h.ceremony.subscribe(s => snapshots.push(s))

    const total = 20
    for (let i = 0; i < total; i++) {
      const der = await signer.sign(digestAt(i), { index: i, total })
      expect(verifies(der, digestAt(i), h.pubA)).toBe(true)
    }
    unsubscribe()

    expect(startSpy).toHaveBeenCalledTimes(3) // arm + reopen before #9 + reopen before #17
    expect(stopSpy).toHaveBeenCalledTimes(2) // each reopen closes the exhausted session first
    expect(verifyPinSpy).toHaveBeenCalledTimes(3)
    expect(getKeyInfoSpy).toHaveBeenCalledTimes(3)
    // Between batches the sheet sees waiting-for-key WITH the position, so it
    // can say "batch 2 of 3" while the iOS system sheet is down.
    const waits = snapshots.filter(s => s.phase === 'waiting-for-key').map(s => s.progress)
    expect(waits).toEqual([
      { signed: 8, total: 20 },
      { signed: 16, total: 20 }
    ])

    signer.release()
    expect(stopSpy).toHaveBeenCalledTimes(3)
  })

  test('a persistent reader never reopens, whatever inputsPerTap says', async () => {
    const h = await makeCeremony({ inputsPerTap: 4 })
    const startSpy = jest.spyOn(h.mock, 'start')
    const stopSpy = jest.spyOn(h.mock, 'stop')
    const verifyPinSpy = jest.spyOn(h.mock, 'verifyPin')
    const signer = await armA(h)
    for (let i = 0; i < 10; i++) await signer.sign(digestAt(i), { index: i, total: 10 })
    expect(startSpy).not.toHaveBeenCalled()
    expect(stopSpy).not.toHaveBeenCalled()
    expect(verifyPinSpy).toHaveBeenCalledTimes(1)
    signer.release()
  })

  test('the progress argument publishes state.progress and refreshes the retention deadline', async () => {
    const h = await makeCeremony()
    const signer = await armA(h)
    const first = h.ceremony.state.armedUntil!
    await new Promise<void>(r => setTimeout(r, 20))
    await signer.sign(DIGEST, { index: 3, total: 10 })
    expect(h.ceremony.state.progress).toEqual({ signed: 3, total: 10 })
    expect(h.ceremony.state.armedUntil!).toBeGreaterThan(first) // the deadline moved
    signer.release()
  })
})

// The ceremonyHost singleton is ONE CeremonyController for the whole process
// lifetime — every fixture above builds a fresh controller per test, which
// cannot see anything that only becomes reachable on a SECOND ceremony
// against the same controller. These tests deliberately reuse one `c` across
// two (or more) full arm→use→release cycles, the way production actually runs.
describe('CeremonyController: one singleton, sequential ceremonies', () => {
  test("a signer released normally clears activeHandle, so a SECOND ceremony's error path still stops the session", async () => {
    const h = await makeCeremony({ sessionBased: true })
    const c = h.ceremony

    // Ceremony 1: arm normally and release, exactly as a caller finishing a
    // withdrawal would in its own finally.
    const signer1 = await armA(h, 'withdraw 1')
    expect(c.state.phase).toBe('armed')
    signer1.release()
    expect(c.state.phase).toBe('idle')

    // Ceremony 2: force a serial-mismatch by presenting the other enrolled key.
    const stopSpy = jest.spyOn(h.mock, 'stop')
    const p2 = c.requestSigner('withdraw 2', SERIAL_A)
    h.mock.insertKey(SERIAL_B)
    c.submitPin(PIN)
    await expect(p2).rejects.toMatchObject({ code: 'serial-mismatch' })

    // The bug this guards against: if release() never cleared activeHandle,
    // run()'s finally guard `if (!armed)` would be reasoning about a STALE
    // signer from ceremony 1 and skip closing ceremony 2's dead session
    // entirely — leaving the system NFC sheet open on exactly the error path
    // that guard exists to handle.
    expect(stopSpy).toHaveBeenCalledTimes(1)

    // And the controller is left clean enough for a third ceremony to arm.
    const signer3 = await armA(h, 'withdraw 3')
    expect(c.state.phase).toBe('armed')
    signer3.release()
  })

  test('refuses a successor until the active signer releases, protecting the process-wide native session', async () => {
    const h = await makeCeremony({ sessionBased: true })
    const c = h.ceremony

    const signerA = await armA(h, 'withdraw A')
    expect(c.state.phase).toBe('armed')
    const startSpy = jest.spyOn(h.mock, 'start')
    await expect(c.requestSigner('withdraw B', SERIAL_A)).rejects.toMatchObject({ code: 'ceremony-active' })
    expect(startSpy).not.toHaveBeenCalled()
    expect(c.state.phase).toBe('armed')
    expect(verifies(await signerA.sign(DIGEST), DIGEST, h.pubA)).toBe(true)

    signerA.release()
    const signerB = await armA(h, 'withdraw B')
    expect(signerB).not.toBe(signerA) // a genuinely new session, not shared
    expect(c.state.phase).toBe('armed')
    expect(verifies(await signerB.sign(DIGEST), DIGEST, h.pubA)).toBe(true)

    signerB.release()
  })

  test('cancel during native verify keeps exclusivity through old-session teardown before a successor starts', async () => {
    const h = await makeCeremony({ sessionBased: true })
    const c = h.ceremony
    const armedSigners: unknown[] = []
    c.onArmed = s => armedSigners.push(s)
    const signSpy = jest.spyOn(h.mock, 'signEcdsa')
    const stopSpy = jest.spyOn(h.mock, 'stop')

    // Park attempt #1 inside verifyPin until we say so.
    const realVerify = h.mock.verifyPin.bind(h.mock)
    let answerPin: (() => void) | undefined
    const verifySpy = jest.spyOn(h.mock, 'verifyPin').mockImplementationOnce(
      () =>
        new Promise(resolve => {
          answerPin = () => resolve({ ok: true, retriesLeft: 3 })
        })
    )

    const p1 = c.requestSigner('op 1', SERIAL_A)
    h.mock.insertKey(SERIAL_A)
    c.submitPin(PIN)
    await flush()
    expect(answerPin).toBeDefined() // #1 is genuinely parked mid-verifyPin

    // The user gives up. #1 is still holding an open PIN check.
    const rejected = expect(p1).rejects.toMatchObject({ code: 'user-cancelled' })
    c.cancel()
    await rejected

    // A successor cannot start while the cancelled native call still owns the
    // process-wide session; otherwise #1's late finally/stop would kill #2.
    verifySpy.mockImplementation(realVerify)
    await expect(c.requestSigner('op 2', SERIAL_A)).rejects.toMatchObject({ code: 'ceremony-active' })
    expect(stopSpy).not.toHaveBeenCalled()

    // #1 returns and completes its own native teardown.
    answerPin!()
    await flush()
    expect(stopSpy).toHaveBeenCalledTimes(1)
    expect(c.state.phase).toBe('idle')

    const signer2 = await armA(h, 'op 2')
    expect(armedSigners).toEqual([signer2])
    expect(c.state.phase).toBe('armed')
    expect(signSpy).not.toHaveBeenCalled()
    expect(verifies(await signer2.sign(DIGEST), DIGEST, h.pubA)).toBe(true)
    signer2.release()
    expect(c.state.phase).toBe('idle')
    expect(stopSpy).toHaveBeenCalledTimes(2)
    await expect(signer2.sign(DIGEST)).rejects.toMatchObject({ code: 'key-removed-mid-op' })
  })

  test('a cancelled native failure finishes quietly before a successor is allowed', async () => {
    const h = await makeCeremony()
    const c = h.ceremony
    const realVerify = h.mock.verifyPin.bind(h.mock)
    let failPin: (() => void) | undefined
    const verifySpy = jest.spyOn(h.mock, 'verifyPin').mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          failPin = () => reject(new VaultError('pin-locked', 'PIN is blocked'))
        })
    )

    const p1 = c.requestSigner('op 1', SERIAL_A)
    h.mock.insertKey(SERIAL_A)
    c.submitPin(PIN)
    await flush()
    const rejected = expect(p1).rejects.toMatchObject({ code: 'user-cancelled' })
    c.cancel()
    await rejected

    verifySpy.mockImplementation(realVerify)
    await expect(c.requestSigner('op 2', SERIAL_A)).rejects.toMatchObject({ code: 'ceremony-active' })
    failPin!()
    await flush()

    expect(c.state.phase).toBe('idle')
    expect(c.state.error).toBeUndefined()
    const signer2 = await armA(h, 'op 2')
    expect(verifies(await signer2.sign(DIGEST), DIGEST, h.pubA)).toBe(true)
    signer2.release()
  })

  test('a cancelled getKeyInfo retains ownership until it returns and cleans up', async () => {
    const h = await makeCeremony()
    const c = h.ceremony
    const realInfo = h.mock.getKeyInfo.bind(h.mock)
    let answerInfo: (() => void) | undefined
    const infoSpy = jest.spyOn(h.mock, 'getKeyInfo').mockImplementationOnce(
      () =>
        new Promise(resolve => {
          answerInfo = () => resolve({ serial: SERIAL_A, firmwareVersion: '5.7.1', pinRetries: 3 })
        })
    )
    const signSpy = jest.spyOn(h.mock, 'signEcdsa')

    const p1 = c.requestSigner('op 1', SERIAL_A)
    h.mock.insertKey(SERIAL_A)
    await flush()
    expect(answerInfo).toBeDefined() // #1 is parked inside getKeyInfo

    const rejected = expect(p1).rejects.toMatchObject({ code: 'user-cancelled' })
    c.cancel()
    await rejected

    infoSpy.mockImplementation(realInfo)
    await expect(c.requestSigner('op 2', SERIAL_A)).rejects.toMatchObject({ code: 'ceremony-active' })
    answerInfo!()
    await flush()
    expect(c.state.phase).toBe('idle')
    expect(signSpy).not.toHaveBeenCalled()
    const signer2 = await armA(h, 'op 2')
    signer2.release()
  })

  test("a signer released by cancel() while its retry is pending leaves the successor's Retry button inert", async () => {
    // The retry branch lives inside sign() now. A cancel() during a retry wait
    // releases the signer and rejects its sign(); the retryWaiter it parked
    // on is gone with it, so a later retry() against a fresh ceremony must
    // not resume the dead signer's loop and spend a touch on the card.
    const h = await makeCeremony()
    const c = h.ceremony
    const signSpy = jest.spyOn(h.mock, 'signEcdsa')
    const signer1 = await armA(h, 'op 1')
    h.mock.setTouchBehavior('timeout')
    const p = signer1.sign(DIGEST)
    await flush()
    expect(c.state.error?.code).toBe('touch-timeout')
    expect(signSpy).toHaveBeenCalledTimes(1)

    c.cancel()
    await expect(p).rejects.toMatchObject({ code: 'user-cancelled' })
    expect(c.state.phase).toBe('idle')

    h.mock.setTouchBehavior('instant')
    const signer2 = await armA(h, 'op 2')
    expect(c.state.phase).toBe('armed')

    c.retry() // nothing is parked — must be a no-op
    await flush()
    expect(c.state.phase).toBe('armed')
    expect(signSpy).toHaveBeenCalledTimes(1) // no touch spent on signer1's behalf
    expect(verifies(await signer2.sign(DIGEST), DIGEST, h.pubA)).toBe(true)
    signer2.release()
  })

  test('cancel during an in-flight signature holds the global lease until the native call unwinds', async () => {
    const h = await makeCeremony()
    const signer1 = await armA(h, 'op 1')
    let started!: () => void
    const signStarted = new Promise<void>(resolve => {
      started = resolve
    })
    let finish!: () => void
    jest.spyOn(h.mock, 'signEcdsa').mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = () => resolve({ signature: '00' })
          started()
        })
    )
    const pending = signer1.sign(DIGEST)
    await signStarted

    h.ceremony.cancel()
    await expect(h.ceremony.requestSigner('op 2', SERIAL_A)).rejects.toMatchObject({ code: 'ceremony-active' })
    finish()
    await expect(pending).rejects.toMatchObject({ code: 'key-removed-mid-op' })

    const signer2 = await armA(h, 'op 2')
    signer2.release()
  })
})

describe('CeremonyController: post-arm progress', () => {
  test('progress from the spend path shows through, carries the position, and never leaks the key', async () => {
    const h = await makeCeremony()
    const signer = await armA(h)

    h.ceremony.noteProgress({ phase: 'preparing', signed: 3, total: 10 })
    expect(h.ceremony.state.phase).toBe('preparing')
    expect(h.ceremony.state.progress).toEqual({ signed: 3, total: 10 })
    h.ceremony.noteProgress({ phase: 'preparing' }) // no position → cleared, not stale
    expect(h.ceremony.state.progress).toBeUndefined()
    h.ceremony.noteProgress({ phase: 'broadcasting' })
    expect(h.ceremony.state.phase).toBe('broadcasting')
    expect(h.ceremony.state.progress).toBeUndefined()

    signer.release()
    expect(h.ceremony.state.phase).toBe('idle')
  })

  test('progress with nothing armed is ignored — a hardware-free deposit never raises a sheet', async () => {
    const { ceremony: c } = await makeCeremony()
    c.noteProgress({ phase: 'preparing', signed: 0, total: 1 })
    expect(c.state.phase).toBe('idle')
    expect(c.state.progress).toBeUndefined()
    c.noteProgress({ phase: 'broadcasting' })
    expect(c.state.phase).toBe('idle')
  })

  test('progress arriving mid-arm is ignored — the arming phases own the display', async () => {
    const { ceremony: c, mock } = await makeCeremony()
    const p = c.requestSigner('x', SERIAL_A)
    mock.insertKey(SERIAL_A)
    await flush()
    expect(c.state.phase).toBe('pin-entry')
    c.noteProgress({ phase: 'preparing' })
    expect(c.state.phase).toBe('pin-entry')
    c.submitPin(PIN)
    ;(await p).release()
  })
})

describe('CeremonyController: retention timeout robustness', () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  test('the retention window elapsing while the spend path is still working relocks rather than staying armed forever', async () => {
    jest.useFakeTimers()
    const h = await makeCeremony({ retentionMs: 1000 })
    const relocks: string[] = []
    h.ceremony.onRelock = why => relocks.push(why)
    const signer = await armA(h)
    expect(h.ceremony.state.phase).toBe('armed')

    // A withdrawal that stalls in broadcast: phase is 'broadcasting', not
    // 'armed', for the whole rest of this test.
    h.ceremony.noteProgress({ phase: 'broadcasting' })
    expect(h.ceremony.state.phase).toBe('broadcasting')

    // Advance well past the point of no return. The busy-path fallback fires
    // the first check at t=1000, finds the phase is not 'armed', and schedules
    // a grace recheck — clamped to the 3x ceiling at t=3000, since with a 1s
    // window the ceiling lands inside the nominal 5s grace. Either way the
    // relock is due long before this advance ends.
    await jest.advanceTimersByTimeAsync(1000 + 5_000 + 10)

    // The bug this guards against: the ORIGINAL one-shot timer's callback was
    // guarded by `phase === 'armed'`, which is false here; without a
    // reschedule, the callback would return and NOTHING would ever check
    // again — a live signer that never leaves.
    expect(h.ceremony.state.phase).toBe('idle')
    expect(relocks).toEqual(['timeout'])
    await expect(signer.sign(DIGEST)).rejects.toMatchObject({ code: 'key-removed-mid-op' })
  })

  test('reported progress refreshes the retention window instead of letting the original deadline expire underneath an active withdrawal', async () => {
    jest.useFakeTimers()
    // 10s window → the 3x absolute ceiling sits at t=30_000, well clear of
    // everything this test exercises; the ceiling gets its own test below.
    const h = await makeCeremony({ retentionMs: 10_000 })
    const relocks: string[] = []
    h.ceremony.onRelock = why => relocks.push(why)
    const signer = await armA(h)
    const firstDeadline = h.ceremony.state.armedUntil!

    // Report progress well before the window elapses...
    await jest.advanceTimersByTimeAsync(6_000)
    h.ceremony.noteProgress({ phase: 'preparing', signed: 1, total: 4 })
    expect(h.ceremony.state.armedUntil!).toBeGreaterThan(firstDeadline) // the deadline moved

    // ...then advance past the ORIGINAL deadline (t=10_000) AND the grace
    // recheck that would have followed it (t=15_000) — i.e. the exact instant
    // an unrefreshed window would have relocked — without ever going idle.
    await jest.advanceTimersByTimeAsync(12_000) // t = 18_000
    expect(h.ceremony.state.phase).toBe('preparing')
    expect(relocks).toEqual([])
    expect(verifies(await signer.sign(DIGEST), DIGEST, h.pubA)).toBe(true) // still live

    signer.release()
  })

  test('the absolute ceiling relocks a session that keeps renewing itself with progress notes', async () => {
    // The refresh above must not become a lease a caller can renew forever:
    // that would make the retention window no boundary at all. Past armedAt +
    // 3x retention the relock fires regardless.
    jest.useFakeTimers()
    const h = await makeCeremony({ retentionMs: 1000 })
    const relocks: string[] = []
    h.ceremony.onRelock = why => relocks.push(why)
    const signer = await armA(h)
    expect(h.ceremony.state.phase).toBe('armed')

    // A note every 200ms — never letting a full window elapse — for well past
    // the 3x ceiling at t=3000.
    for (let t = 0; t < 6_000; t += 200) {
      await jest.advanceTimersByTimeAsync(200)
      h.ceremony.noteProgress({ phase: 'broadcasting' })
    }

    expect(relocks).toEqual(['timeout'])
    expect(h.ceremony.state.phase).toBe('idle')
    await expect(signer.sign(DIGEST)).rejects.toMatchObject({ code: 'key-removed-mid-op' })
  })

  test('the ceiling is anchored per ceremony, so a fresh arm gets a full new life', async () => {
    jest.useFakeTimers()
    const h = await makeCeremony({ retentionMs: 1000 })
    const s1 = await armA(h)
    await jest.advanceTimersByTimeAsync(4_000) // past ceremony 1's ceiling
    expect(h.ceremony.state.phase).toBe('idle')
    await expect(s1.sign(DIGEST)).rejects.toMatchObject({ code: 'key-removed-mid-op' })

    // Ceremony 2 on the same controller starts its own clock.
    const p2 = h.ceremony.requestSigner('y', SERIAL_A)
    h.ceremony.submitPin(PIN)
    const s2 = await p2
    expect(h.ceremony.state.phase).toBe('armed')
    await jest.advanceTimersByTimeAsync(900)
    expect(h.ceremony.state.phase).toBe('armed') // not inheriting ceremony 1's exhausted ceiling
    s2.release()
  })
})
