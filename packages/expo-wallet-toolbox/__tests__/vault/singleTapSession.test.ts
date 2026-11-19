// A Vault spend that also creates a Vault output (a withdrawal that leaves change in the Vault, a
// re-lock) asked for the PIN and a tap twice: once to prove the key for the new output, once to
// sign the inputs. Both now run in one key session (the toolbox patch): one PIN entry, one tap.
import { p256 } from '@noble/curves/nist.js'

jest.mock('../../core/services/vault/vaultStore', () => ({
  vaultStore: { assertScopeToken: jest.fn(), getMeta: async () => null }
}))
jest.mock('../../core/services/vault/driver', () => ({ getVaultDriver: () => null }))

// eslint-disable-next-line import/first
import { openVaultSignerSession } from '../../core/services/vault/ceremonyHost'
// eslint-disable-next-line import/first
import { requireVaultOutputKeyPossession } from '../../core/services/vault/outputAuthority'
// eslint-disable-next-line import/first
import { CeremonyController } from '../../core/services/vault/ceremony'

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')
const secret = p256.utils.randomSecretKey()
const pubkey = hex(p256.getPublicKey(secret, true))

/** A card: signs a digest as the YubiKey does (DER), and counts what was asked of it. */
function card(serial = '10001') {
  const signer = {
    serial,
    pubkey,
    sign: jest.fn(async (digestHex: string) => [
      ...p256.sign(Uint8Array.from(Buffer.from(digestHex, 'hex')), secret, {
        prehash: false,
        lowS: false,
        format: 'der'
      })
    ]),
    release: jest.fn()
  }
  return signer
}

/** The ceremony, as the session sees it: each request is one PIN entry and one tap. */
function ceremony() {
  const state = { live: new Set<object>(), cancelled: false }
  const cards: ReturnType<typeof card>[] = []
  const request = jest.fn(async (_reason: string, serial: string) => {
    const c = card(serial)
    c.release.mockImplementation(() => void state.live.delete(c))
    state.live.add(c)
    cards.push(c)
    return c
  })
  const session = openVaultSignerSession({ request, holds: s => state.live.has(s), cancelled: () => state.cancelled })
  return { session, request, cards, state }
}

const key = { serial: '10001', slot: 0x9a, pubkey, nickname: 'Key 1', enrolledAt: 0 }
const meta = { vaultId: 'v', revision: 1, createdAt: 1, keys: [key, { ...key, serial: '10002' }] }
const scope = { storageKey: 'wallet', chain: 'main' } as never
const output = { satoshis: 150_000, saltKeyId: '3', lockingScript: 'ac' }

describe('one key session for a spend that creates a Vault output', () => {
  test('the proof and the inputs use one PIN entry and one tap', async () => {
    const { session, request, cards } = ceremony()

    await requireVaultOutputKeyPossession(meta as never, scope, output, '10001', {
      session,
      reason: 'Withdraw 0.001 BSV'
    })
    // the proof is signed, and the key stays armed for the inputs
    expect(cards[0].sign).toHaveBeenCalledTimes(1)
    expect(cards[0].release).not.toHaveBeenCalled()

    const signer = await session.acquire('Withdraw 0.001 BSV', '10001')
    expect(signer).toBe(cards[0])
    expect(request).toHaveBeenCalledTimes(1)
    // the NFC alert reads as the transfer, not as a separate check
    expect(request).toHaveBeenCalledWith('Withdraw 0.001 BSV', '10001')

    session.close()
    expect(cards[0].release).toHaveBeenCalledTimes(1)
  })

  test('without a session the proof asks for a ceremony of its own (a deposit)', async () => {
    // this test has no key driver, so the stand-alone ceremony refuses: the proof did ask for one
    await expect(requireVaultOutputKeyPossession(meta as never, scope, output, '10001')).rejects.toMatchObject({
      code: 'driver-unavailable'
    })
  })

  test('a failed proof leaves the session to its owner, who closes it', async () => {
    const { session, cards } = ceremony()
    const wrong = {
      ...meta,
      keys: [{ ...key, pubkey: hex(p256.getPublicKey(p256.utils.randomSecretKey(), true)) }, meta.keys[1]]
    }
    await expect(
      requireVaultOutputKeyPossession(wrong as never, scope, output, '10001', { session, reason: 'r' })
    ).rejects.toMatchObject({ code: 'wrong-key' })
    session.close()
    expect(cards[0].release).toHaveBeenCalledTimes(1)
  })

  test('a key that left between the proof and the inputs is asked for again, as before', async () => {
    const { session, request, cards, state } = ceremony()
    await session.acquire('r', '10001')
    state.live.delete(cards[0]) // a detach, or the retention window

    const signer = await session.acquire('r', '10001')
    expect(request).toHaveBeenCalledTimes(2)
    expect(signer).toBe(cards[1])
    session.close()
    expect(cards[1].release).toHaveBeenCalledTimes(1)
  })

  test('a cancelled session stays cancelled: no second PIN prompt', async () => {
    const { session, request, cards, state } = ceremony()
    await session.acquire('r', '10001')
    state.live.delete(cards[0])
    state.cancelled = true

    await expect(session.acquire('r', '10001')).rejects.toMatchObject({ code: 'user-cancelled' })
    expect(request).toHaveBeenCalledTimes(1)
  })

  test('close is safe to repeat, and after the spend released the signer itself', async () => {
    const { session, cards } = ceremony()
    const signer = await session.acquire('r', '10001')
    signer.release()
    session.close()
    session.close()
    expect(cards[0].release).toHaveBeenCalledTimes(2) // the spend's, then one close: release() is idempotent
  })
})

// The same, against the toolbox's real ceremony and a key that works as the phone's NFC does: a
// session per tap, the PIN checked when it opens. What counts is what the person does: how many
// times the NFC session starts (a tap) and how many times the PIN is checked.
describe('the real ceremony, one session', () => {
  function nfcKey() {
    let listener: ((e: { type: string }) => void) | undefined
    const driver = {
      sessionBased: true,
      isSupported: () => true,
      start: jest.fn(() => void setTimeout(() => listener?.({ type: 'attached' }), 0)),
      stop: jest.fn(),
      onKeyEvent: (cb: (e: { type: string }) => void) => {
        listener = cb
        return () => {
          if (listener === cb) listener = undefined
        }
      },
      getKeyInfo: async () => ({ serial: '10001', firmwareVersion: '5.7.1', pinRetries: 3 }),
      verifyPin: jest.fn(async () => ({ ok: true, retriesLeft: 3 })),
      signEcdsa: jest.fn(async (_serial: string, _pin: string, digestHex: string) => ({
        signature: hex(
          p256.sign(Uint8Array.from(Buffer.from(digestHex, 'hex')), secret, {
            prehash: false,
            lowS: false,
            format: 'der'
          })
        )
      }))
    }
    const controller = new CeremonyController({
      getDriver: () => driver as never,
      store: { getMeta: async () => ({ keys: [{ serial: '10001', slot: 0x9a, pubkey }] }) },
      retentionMs: 120_000
    })
    const session = openVaultSignerSession({
      request: (reason, serial) => {
        const signer = controller.requestSigner(reason, serial)
        controller.submitPin('123456')
        return signer
      },
      holds: signer => controller.holds(signer),
      cancelled: () => controller.wasCancelled
    })
    return { driver, controller, session, unplug: () => listener?.({ type: 'detached' }) }
  }
  const digest = 'ab'.repeat(32)
  const prove = (session: ReturnType<typeof nfcKey>['session']) =>
    requireVaultOutputKeyPossession(meta as never, scope, output, '10001', { session, reason: 'Withdraw 0.001 BSV' })

  test('proof, transaction build, then inputs: one tap and one PIN check', async () => {
    const { driver, controller, session } = nfcKey()
    await prove(session)
    controller.noteProgress({ phase: 'preparing' }) // the transaction is built here
    const signer = await session.acquire('Withdraw 0.001 BSV', '10001')
    await signer.sign(digest, { index: 0, total: 2 })
    await signer.sign(digest, { index: 1, total: 2 })
    signer.release()
    session.close()

    expect(driver.start).toHaveBeenCalledTimes(1)
    expect(driver.verifyPin).toHaveBeenCalledTimes(1)
    expect(driver.signEcdsa).toHaveBeenCalledTimes(3) // the proof and two inputs
    expect(driver.stop).toHaveBeenCalledTimes(1)
    expect(controller.holds(signer)).toBe(false)
  })

  test('the key leaves during the build: a second tap, and the transfer goes on', async () => {
    const { driver, session, unplug } = nfcKey()
    await prove(session)
    unplug()
    const signer = await session.acquire('Withdraw 0.001 BSV', '10001')
    await signer.sign(digest)
    session.close()

    expect(driver.start).toHaveBeenCalledTimes(2)
    expect(driver.verifyPin).toHaveBeenCalledTimes(2)
  })

  test('the person cancels during the build: the transfer stops, with no new prompt', async () => {
    const { driver, controller, session } = nfcKey()
    await prove(session)
    controller.cancel()
    await expect(session.acquire('Withdraw 0.001 BSV', '10001')).rejects.toMatchObject({ code: 'user-cancelled' })
    session.close()

    expect(driver.start).toHaveBeenCalledTimes(1)
  })
})
