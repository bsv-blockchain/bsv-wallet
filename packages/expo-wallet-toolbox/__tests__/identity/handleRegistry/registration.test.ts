import { PrivateKey, ProtoWallet } from '@bsv/sdk'
import type { ProfileCertJson, ProfileSigner, RegistryProfile } from '../../../core/identity/handleRegistry/profileCert'
import type { HandleRegistryClient, PutResult } from '../../../core/identity/handleRegistry/client'
import {
  ISSUED_AT_KV_KEY,
  MAX_ISSUED_AT_LEAD_MS,
  PENDING_JOURNAL_KEY,
  changeHandle,
  registerHandle,
  resetRegistrationState,
  resumePending,
  updateProfile,
  type PendingJournal,
  type RegistrationStorage
} from '../../../core/identity/handleRegistry/registration'

const DOMAIN = 'deggen.com'
const KEY = PrivateKey.fromRandom()
const SIGNER = new ProtoWallet(KEY) as unknown as ProfileSigner

function memoryStorage(seed: Record<string, string> = {}): RegistrationStorage & { map: Map<string, string> } {
  const map = new Map(Object.entries(seed))
  return {
    map,
    async getKeyValue(key) {
      return map.get(key)
    },
    async setKeyValue(key, value) {
      map.set(key, value)
    }
  }
}

/** A verified profile the registry could be serving for our key. */
const profileFor = (handle: string, displayName?: string): RegistryProfile => ({
  identityKey: KEY.toPublicKey().toString(),
  paymail: `${handle}@${DOMAIN}`,
  handle,
  domain: DOMAIN,
  ...(displayName ? { displayName } : {}),
  issuedAt: new Date('2026-09-18T09:00:00.000Z'),
  certificate: {} as ProfileCertJson
})

/** A client whose answers are a script, so the resume matrix is exact. */
function scriptedClient(script: {
  put?: (cert: ProfileCertJson, call: number) => PutResult
  reverse?: () => RegistryProfile | null
  /** The reverse lookup having no answer at all, which is not `reverse: null`. */
  reverseFailed?: boolean
  /** A function for a clock that moves — a skew correction landing mid-run. */
  serverNow?: Date | (() => Date)
}) {
  const puts: ProfileCertJson[] = []
  let reverseCalls = 0
  const client: HandleRegistryClient = {
    domain: DOMAIN,
    async checkAvailability() {
      return { kind: 'available' }
    },
    async putCertificate(cert) {
      puts.push(cert)
      return script.put ? script.put(cert, puts.length) : { kind: 'created' }
    },
    async search() {
      return []
    },
    async lookupProfile() {
      reverseCalls += 1
      if (script.reverseFailed === true) return { kind: 'failed' }
      const profile = script.reverse ? script.reverse() : null
      return profile ? { kind: 'found', profile } : { kind: 'none' }
    },
    async lookupIdentityKey() {
      reverseCalls += 1
      return script.reverse ? script.reverse() : null
    },
    serverNow() {
      const at = script.serverNow ?? new Date('2026-09-18T10:00:00.000Z')
      return typeof at === 'function' ? at() : at
    }
  }
  return { client, puts, reverseCalls: () => reverseCalls }
}

const journalOf = (storage: RegistrationStorage & { map: Map<string, string> }): PendingJournal | null => {
  const raw = storage.map.get(PENDING_JOURNAL_KEY)
  return raw ? (JSON.parse(raw) as PendingJournal) : null
}

beforeEach(() => {
  resetRegistrationState()
  jest.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  jest.restoreAllMocks()
})

describe('registerHandle', () => {
  it('signs and journals before the request, then clears the journal on 201', async () => {
    const seen: (PendingJournal | null)[] = []
    const { client, puts } = scriptedClient({
      put: () => {
        seen.push(journalOf(storage))
        return { kind: 'created' }
      }
    })
    const storage = memoryStorage()
    const result = await registerHandle({ client, signer: SIGNER, storage }, { handle: 'dee', displayName: 'Dee K' })
    expect(result).toEqual({ kind: 'registered', paymail: `dee@${DOMAIN}` })
    expect(seen[0]?.steps).toHaveLength(1)
    expect(seen[0]?.steps[0]).toMatchObject({ kind: 'claim', paymail: `dee@${DOMAIN}` })
    expect(puts[0].fields).toMatchObject({ paymail: `dee@${DOMAIN}`, displayName: 'Dee K' })
    expect(journalOf(storage)).toBeNull()
  })

  it('reports unavailable with no journal when this chain has no registry', async () => {
    const storage = memoryStorage()
    expect(await registerHandle({ client: null, signer: SIGNER, storage }, { handle: 'dee' })).toEqual({
      kind: 'unavailable'
    })
    expect(storage.map.size).toBe(0)
  })

  it('reports failed for a handle that is not a valid one', async () => {
    const { client, puts } = scriptedClient({})
    const result = await registerHandle({ client, signer: SIGNER, storage: memoryStorage() }, { handle: 'x' })
    expect(result.kind).toBe('failed')
    expect(puts).toHaveLength(0)
  })

  it('keeps the journal and reports pending when the request never lands', async () => {
    const { client } = scriptedClient({ put: () => ({ kind: 'failed', message: 'offline' }) })
    const storage = memoryStorage()
    expect(await registerHandle({ client, signer: SIGNER, storage }, { handle: 'dee' })).toEqual({ kind: 'pending' })
    expect(journalOf(storage)?.steps[0].paymail).toBe(`dee@${DOMAIN}`)
  })

  it('clears the journal and reports the code the registry gave', async () => {
    const { client } = scriptedClient({
      put: () => ({ kind: 'rejected', code: 'ERR_HANDLE_TAKEN', description: 'taken' })
    })
    const storage = memoryStorage()
    expect(await registerHandle({ client, signer: SIGNER, storage }, { handle: 'dee' })).toEqual({
      kind: 'rejected',
      code: 'ERR_HANDLE_TAKEN',
      description: 'taken'
    })
    expect(journalOf(storage)).toBeNull()
  })
})

describe('issuedAt', () => {
  it('never repeats or goes backwards, whatever the device clock says', async () => {
    const { client, puts } = scriptedClient({ serverNow: new Date('2026-09-18T10:00:00.000Z') })
    const storage = memoryStorage({ [ISSUED_AT_KV_KEY]: '2026-09-18T10:02:00.000Z' })
    await registerHandle({ client, signer: SIGNER, storage }, { handle: 'dee' })
    resetRegistrationState()
    await registerHandle({ client, signer: SIGNER, storage }, { handle: 'dee' })
    expect(puts[0].fields.issuedAt).toBe('2026-09-18T10:02:00.001Z')
    expect(puts[1].fields.issuedAt).toBe('2026-09-18T10:02:00.002Z')
    expect(storage.map.get(ISSUED_AT_KV_KEY)).toBe('2026-09-18T10:02:00.002Z')
  })

  it('takes the corrected server time when it is ahead of the stored value', async () => {
    const { client, puts } = scriptedClient({ serverNow: new Date('2026-09-18T15:00:00.000Z') })
    const storage = memoryStorage({ [ISSUED_AT_KV_KEY]: '2026-09-18T12:00:00.000Z' })
    await registerHandle({ client, signer: SIGNER, storage }, { handle: 'dee' })
    expect(puts[0].fields.issuedAt).toBe('2026-09-18T15:00:00.000Z')
  })

  it('discards a stored mark the server could never have accepted', async () => {
    const { client, puts } = scriptedClient({ serverNow: new Date('2026-09-18T10:00:00.000Z') })
    // A mark left by a clock that was hours fast. Honouring it would mint
    // another certificate the server refuses, for ever.
    const storage = memoryStorage({ [ISSUED_AT_KV_KEY]: '2026-09-18T11:00:00.000Z' })
    await registerHandle({ client, signer: SIGNER, storage }, { handle: 'dee' })
    expect(puts[0].fields.issuedAt).toBe('2026-09-18T10:00:00.000Z')
    expect(Date.parse(puts[0].fields.issuedAt) - Date.parse('2026-09-18T10:00:00.000Z')).toBeLessThanOrEqual(
      MAX_ISSUED_AT_LEAD_MS
    )
    // The mark the server could never have accepted is gone, not merely capped.
    expect(storage.map.get(ISSUED_AT_KV_KEY)).toBe('2026-09-18T10:00:00.000Z')
  })

  /**
   * The ceiling only ever BINDS for a mark one millisecond below it, and only a
   * change asks for two dates in a row — so this is the one seed that reaches
   * the clamp, and what it produces is a claim that cannot beat its own
   * release. Refusing the change is the answer: the user keeps the handle they
   * have, and the ceiling moves with the clock.
   */
  it('refuses a change it cannot date the claim after the release', async () => {
    const serverNow = new Date('2026-09-18T10:00:00.000Z')
    const { client, puts } = scriptedClient({ serverNow })
    const storage = memoryStorage({
      [ISSUED_AT_KV_KEY]: new Date(serverNow.getTime() + MAX_ISSUED_AT_LEAD_MS - 1).toISOString()
    })
    const result = await changeHandle(
      { client, signer: SIGNER, storage },
      { previousPaymail: `dee@${DOMAIN}`, handle: 'deggen' }
    )
    expect(result.kind).toBe('failed')
    // Nothing was released, so the handle the user holds is still theirs.
    expect(puts).toHaveLength(0)
    expect(journalOf(storage)).toBeNull()
  })

  it('dates a reclaim after the release it is undoing, even from the ceiling', async () => {
    const serverNow = new Date('2026-09-18T10:00:00.000Z')
    const { client, puts } = scriptedClient({
      serverNow,
      put: (_cert, call) =>
        call === 1
          ? { kind: 'ok' }
          : call === 2
            ? { kind: 'rejected', code: 'ERR_HANDLE_TAKEN', description: 'taken' }
            : { kind: 'created' }
    })
    // Two milliseconds below the ceiling: the claim lands exactly on it, so the
    // mark it stores is one the next mint discards — the reclaim has nothing
    // but the journal to tell it which tombstone it must beat.
    const storage = memoryStorage({
      [ISSUED_AT_KV_KEY]: new Date(serverNow.getTime() + MAX_ISSUED_AT_LEAD_MS - 2).toISOString()
    })
    const result = await changeHandle(
      { client, signer: SIGNER, storage },
      { previousPaymail: `dee@${DOMAIN}`, handle: 'deggen' }
    )
    expect(result).toEqual({ kind: 'rolled_back', paymail: `dee@${DOMAIN}` })
    expect(Date.parse(puts[1].fields.issuedAt) - serverNow.getTime()).toBe(MAX_ISSUED_AT_LEAD_MS)
    expect(Date.parse(puts[2].fields.issuedAt)).toBeGreaterThan(Date.parse(puts[0].fields.issuedAt))
  })

  /**
   * The ceiling can also arrive DURING a change, and then it binds on an
   * ordinary device: a phone four minutes fast knows nothing of its skew until
   * the registry answers, so the release is dated on the fast clock and
   * accepted, and the correction that answer carries puts the reclaim's ceiling
   * exactly on the tombstone the release left behind. A reclaim that does not
   * beat its own tombstone is one the registry refuses, so it is not sent: the
   * change's journal is left whole and the next attempt mints from a ceiling
   * that has moved on.
   */
  it('will not send a reclaim it cannot date after the tombstone', async () => {
    const trueNow = new Date('2026-09-18T10:00:00.000Z')
    let serverNow = new Date(trueNow.getTime() + MAX_ISSUED_AT_LEAD_MS)
    const { client, puts } = scriptedClient({
      serverNow: () => serverNow,
      put: (_cert, call) => {
        // Every response carries a `Date` header, so from the first one on the
        // client's skew is corrected.
        serverNow = trueNow
        if (call === 1) return { kind: 'ok' }
        if (call === 2) return { kind: 'rejected', code: 'ERR_HANDLE_TAKEN', description: 'taken' }
        return { kind: 'created' }
      }
    })
    const storage = memoryStorage()
    const result = await changeHandle(
      { client, signer: SIGNER, storage },
      { previousPaymail: `dee@${DOMAIN}`, handle: 'deggen' }
    )
    expect(result).toEqual({ kind: 'pending' })
    // The reclaim the registry would refuse is never sent, and saying
    // `rolled_back` for it would be worse still.
    expect(puts).toHaveLength(2)
    expect(journalOf(storage)?.steps.map(step => step.paymail)).toEqual([`dee@${DOMAIN}`, `deggen@${DOMAIN}`])
  })

  /**
   * The whole hazard, end to end: a phone an hour fast has no idea it is fast
   * until the registry answers, so its first write is refused — and its second
   * must not be.
   */
  it('recovers on the next attempt when the device clock was hours ahead', async () => {
    const storage = memoryStorage()
    // Attempt one: no skew known yet, so serverNow() is the fast device clock.
    const fast = scriptedClient({
      serverNow: new Date('2026-09-18T11:00:00.000Z'),
      put: () => ({
        kind: 'rejected',
        code: 'ERR_INVALID_CERTIFICATE',
        description: 'issuedAt is more than 5m0s ahead'
      })
    })
    const first = await registerHandle({ client: fast.client, signer: SIGNER, storage }, { handle: 'dee' })
    expect(first).toEqual({
      kind: 'rejected',
      code: 'ERR_INVALID_CERTIFICATE',
      description: 'issuedAt is more than 5m0s ahead'
    })
    expect(fast.puts[0].fields.issuedAt).toBe('2026-09-18T11:00:00.000Z')
    resetRegistrationState()

    // Attempt two: that refused response carried a Date header, so serverNow()
    // is corrected. The stored mark is past the ceiling and is discarded.
    const corrected = scriptedClient({ serverNow: new Date('2026-09-18T10:00:00.000Z') })
    const second = await registerHandle({ client: corrected.client, signer: SIGNER, storage }, { handle: 'dee' })
    expect(second).toEqual({ kind: 'registered', paymail: `dee@${DOMAIN}` })
    expect(corrected.puts[0].fields.issuedAt).toBe('2026-09-18T10:00:00.000Z')
  })
})

describe('updateProfile', () => {
  it('re-mints the same paymail with a newer issuedAt and a fresh serial', async () => {
    const { client, puts } = scriptedClient({ put: () => ({ kind: 'ok' }) })
    const storage = memoryStorage()
    const deps = { client, signer: SIGNER, storage }
    const result = await updateProfile(deps, { paymail: `dee@${DOMAIN}`, displayName: 'Dee Kay' })
    expect(result).toEqual({ kind: 'updated', paymail: `dee@${DOMAIN}` })
    expect(puts[0].fields.displayName).toBe('Dee Kay')
    expect(journalOf(storage)).toBeNull()
  })

  it('refuses a paymail that is not on this registry', async () => {
    const { client, puts } = scriptedClient({})
    const result = await updateProfile(
      { client, signer: SIGNER, storage: memoryStorage() },
      { paymail: 'dee@other.example' }
    )
    expect(result.kind).toBe('failed')
    expect(puts).toHaveLength(0)
  })
})

describe('changeHandle', () => {
  it('releases the old handle, then claims the new one, then clears the journal', async () => {
    const { client, puts } = scriptedClient({
      put: (_cert, call) => (call === 1 ? { kind: 'ok' } : { kind: 'created' })
    })
    const storage = memoryStorage()
    const result = await changeHandle(
      { client, signer: SIGNER, storage },
      { previousPaymail: `dee@${DOMAIN}`, handle: 'deggen', displayName: 'Dee K' }
    )
    expect(result).toEqual({ kind: 'changed', paymail: `deggen@${DOMAIN}` })
    expect(puts[0].fields).toMatchObject({ paymail: `dee@${DOMAIN}`, released: 'true' })
    expect(puts[1].fields).toMatchObject({ paymail: `deggen@${DOMAIN}`, displayName: 'Dee K' })
    expect(Date.parse(puts[1].fields.issuedAt)).toBeGreaterThan(Date.parse(puts[0].fields.issuedAt))
    expect(journalOf(storage)).toBeNull()
  })

  it('reclaims the previous handle when the new one was taken in between', async () => {
    const { client, puts } = scriptedClient({
      put: (_cert, call) =>
        call === 1
          ? { kind: 'ok' }
          : call === 2
            ? { kind: 'rejected', code: 'ERR_HANDLE_TAKEN', description: 'taken' }
            : { kind: 'created' }
    })
    const storage = memoryStorage()
    const result = await changeHandle(
      { client, signer: SIGNER, storage },
      { previousPaymail: `dee@${DOMAIN}`, handle: 'deggen' }
    )
    expect(result).toEqual({ kind: 'rolled_back', paymail: `dee@${DOMAIN}` })
    expect(puts).toHaveLength(3)
    expect(puts[2].fields).toMatchObject({ paymail: `dee@${DOMAIN}` })
    expect(puts[2].fields.released).toBeUndefined()
    expect(journalOf(storage)).toBeNull()
  })

  /**
   * Releasing a live handle to claim it straight back buys nothing and costs a
   * window in which the user holds neither — with every way a change can go
   * wrong inherited for a no-op.
   */
  it('refuses a change to the handle already registered rather than releasing it', async () => {
    const { client, puts } = scriptedClient({})
    const storage = memoryStorage()
    const result = await changeHandle(
      { client, signer: SIGNER, storage },
      { previousPaymail: `dee@${DOMAIN}`, handle: 'dee', displayName: 'Dee K' }
    )
    expect(result.kind).toBe('failed')
    expect(puts).toHaveLength(0)
    expect(journalOf(storage)).toBeNull()
  })

  it('keeps a journal for the reclaim when that request fails too', async () => {
    const { client } = scriptedClient({
      put: (_cert, call) =>
        call === 1
          ? { kind: 'ok' }
          : call === 2
            ? { kind: 'rejected', code: 'ERR_HANDLE_TAKEN', description: 'taken' }
            : { kind: 'failed', message: 'offline' }
    })
    const storage = memoryStorage()
    const result = await changeHandle(
      { client, signer: SIGNER, storage },
      { previousPaymail: `dee@${DOMAIN}`, handle: 'deggen' }
    )
    expect(result).toEqual({ kind: 'pending' })
    expect(journalOf(storage)?.steps).toEqual([expect.objectContaining({ kind: 'claim', paymail: `dee@${DOMAIN}` })])
  })
})

describe('the stale-certificate branch', () => {
  it('treats a claim the registry already reflects as done', async () => {
    const { client } = scriptedClient({
      put: () => ({ kind: 'rejected', code: 'ERR_STALE_CERTIFICATE', description: 'stale' }),
      reverse: () => profileFor('dee')
    })
    const storage = memoryStorage()
    expect(await registerHandle({ client, signer: SIGNER, storage }, { handle: 'dee' })).toEqual({
      kind: 'registered',
      paymail: `dee@${DOMAIN}`
    })
    expect(journalOf(storage)).toBeNull()
  })

  /**
   * The paymail alone cannot tell an update apart: it is by definition one this
   * key already holds. A newer certificate from somewhere else — a second
   * device, or one this device got accepted while its clock was minutes fast —
   * makes every update stale for as long as it is ahead, and calling that
   * `updated` would show the user a name the registry is not serving.
   */
  it('does not call a display name the registry refused an update', async () => {
    const { client } = scriptedClient({
      put: () => ({ kind: 'rejected', code: 'ERR_STALE_CERTIFICATE', description: 'stale' }),
      reverse: () => profileFor('dee', 'Dee K')
    })
    const storage = memoryStorage()
    const result = await updateProfile(
      { client, signer: SIGNER, storage },
      { paymail: `dee@${DOMAIN}`, displayName: 'Dee Kay' }
    )
    expect(result).toEqual({ kind: 'failed', message: 'stale' })
    expect(journalOf(storage)).toBeNull()
  })

  it('treats an update the registry is already serving as done', async () => {
    const { client } = scriptedClient({
      put: () => ({ kind: 'rejected', code: 'ERR_STALE_CERTIFICATE', description: 'stale' }),
      reverse: () => profileFor('dee', 'Dee Kay')
    })
    const storage = memoryStorage()
    const result = await updateProfile(
      { client, signer: SIGNER, storage },
      { paymail: `dee@${DOMAIN}`, displayName: 'Dee Kay' }
    )
    expect(result).toEqual({ kind: 'updated', paymail: `dee@${DOMAIN}` })
    expect(journalOf(storage)).toBeNull()
  })

  it('treats a release the registry already reflects as done', async () => {
    const { client, puts } = scriptedClient({
      put: (_cert, call) =>
        call === 1 ? { kind: 'rejected', code: 'ERR_STALE_CERTIFICATE', description: 'stale' } : { kind: 'created' },
      reverse: () => null
    })
    const storage = memoryStorage()
    const result = await changeHandle(
      { client, signer: SIGNER, storage },
      { previousPaymail: `dee@${DOMAIN}`, handle: 'deggen' }
    )
    expect(result).toEqual({ kind: 'changed', paymail: `deggen@${DOMAIN}` })
    expect(puts).toHaveLength(2)
  })

  /**
   * The opposite answer to the one above: the registry calls our release stale
   * AND still shows the handle as ours, so the tombstone did not land. Claiming
   * the new handle now would leave the key holding two, which is the one thing
   * the registry will not have.
   */
  it('does not go on to the claim when the release was refused and the old handle is still ours', async () => {
    const { client, puts } = scriptedClient({
      put: () => ({ kind: 'rejected', code: 'ERR_STALE_CERTIFICATE', description: 'stale' }),
      reverse: () => profileFor('dee')
    })
    const storage = memoryStorage()
    const result = await changeHandle(
      { client, signer: SIGNER, storage },
      { previousPaymail: `dee@${DOMAIN}`, handle: 'deggen' }
    )
    expect(result).toEqual({ kind: 'failed', message: 'stale' })
    expect(puts).toHaveLength(1)
    expect(journalOf(storage)).toBeNull()
  })

  /**
   * Stale on the claim of a change that has already tombstoned the old handle
   * is the same hazard as the handle being taken: whoever released this handle
   * dated their tombstone ahead of our claim — which any device a few minutes
   * fast legitimately does — and the user is left holding nothing. Replaying
   * cannot win, but the reclaim still can.
   */
  it('reclaims the previous handle when the claim after a release is refused as stale', async () => {
    const { client, puts } = scriptedClient({
      put: (_cert, call) =>
        call === 1
          ? { kind: 'ok' }
          : call === 2
            ? { kind: 'rejected', code: 'ERR_STALE_CERTIFICATE', description: 'stale' }
            : { kind: 'created' },
      // Truthful: they released `dee` and never got `deggen`.
      reverse: () => null
    })
    const storage = memoryStorage()
    const result = await changeHandle(
      { client, signer: SIGNER, storage },
      { previousPaymail: `dee@${DOMAIN}`, handle: 'deggen' }
    )
    expect(result).toEqual({ kind: 'rolled_back', paymail: `dee@${DOMAIN}` })
    expect(puts).toHaveLength(3)
    expect(puts[2].fields).toMatchObject({ paymail: `dee@${DOMAIN}` })
    expect(journalOf(storage)).toBeNull()
  })

  /**
   * A change is done when the handle is the user's. The display name rides
   * along on the same certificate, so a registry serving the new handle under
   * an older name has still moved the user where they asked to go — unlike an
   * update, whose paymail is by definition one this key already holds and where
   * the name is therefore the only thing the reverse lookup can test.
   */
  it('calls a change done when the registry serves the new handle under an older name', async () => {
    const { client } = scriptedClient({
      put: (_cert, call) =>
        call === 1 ? { kind: 'ok' } : { kind: 'rejected', code: 'ERR_STALE_CERTIFICATE', description: 'stale' },
      reverse: () => profileFor('deggen', 'Old')
    })
    const storage = memoryStorage()
    const result = await changeHandle(
      { client, signer: SIGNER, storage },
      { previousPaymail: `dee@${DOMAIN}`, handle: 'deggen', displayName: 'New' }
    )
    expect(result).toEqual({ kind: 'changed', paymail: `deggen@${DOMAIN}` })
    expect(journalOf(storage)).toBeNull()
  })

  /** "I could not ask" is not "the old handle is free": answering it as a
   * tombstone would send the claim on a premise nobody confirmed. */
  it('keeps the journal when the registry will not say whether the release landed', async () => {
    const { client, puts } = scriptedClient({
      put: (_cert, call) =>
        call === 1 ? { kind: 'rejected', code: 'ERR_STALE_CERTIFICATE', description: 'stale' } : { kind: 'created' },
      reverseFailed: true
    })
    const storage = memoryStorage()
    const result = await changeHandle(
      { client, signer: SIGNER, storage },
      { previousPaymail: `dee@${DOMAIN}`, handle: 'deggen' }
    )
    expect(result).toEqual({ kind: 'pending' })
    expect(puts).toHaveLength(1)
    expect(journalOf(storage)?.steps).toHaveLength(2)
  })

  it('gives up and clears when the registry reflects neither — replaying it can never win', async () => {
    const { client } = scriptedClient({
      put: () => ({ kind: 'rejected', code: 'ERR_STALE_CERTIFICATE', description: 'stale' }),
      reverse: () => null
    })
    const storage = memoryStorage()
    const result = await registerHandle({ client, signer: SIGNER, storage }, { handle: 'dee' })
    expect(result).toEqual({ kind: 'failed', message: 'stale' })
    expect(journalOf(storage)).toBeNull()
  })
})

describe('resumePending', () => {
  it('is idle with nothing journalled', async () => {
    const { client, puts } = scriptedClient({})
    expect(await resumePending({ client, signer: SIGNER, storage: memoryStorage() })).toEqual({ kind: 'idle' })
    expect(puts).toHaveLength(0)
  })

  it('replays the identical bytes a crash left behind, and the server no-ops them', async () => {
    const { client } = scriptedClient({ put: () => ({ kind: 'failed', message: 'killed' }) })
    const storage = memoryStorage()
    await registerHandle({ client, signer: SIGNER, storage }, { handle: 'dee' })
    const left = journalOf(storage)
    resetRegistrationState()

    const replay = scriptedClient({ put: () => ({ kind: 'ok' }) })
    const result = await resumePending({ client: replay.client, signer: SIGNER, storage })
    expect(result).toEqual({ kind: 'registered', paymail: `dee@${DOMAIN}` })
    expect(replay.puts[0]).toEqual(left?.steps[0].cert)
    expect(journalOf(storage)).toBeNull()
  })

  it('carries on from the second step when the first already landed', async () => {
    const { client } = scriptedClient({
      put: (_cert, call) => (call === 1 ? { kind: 'ok' } : { kind: 'failed', message: 'offline' })
    })
    const storage = memoryStorage()
    await changeHandle({ client, signer: SIGNER, storage }, { previousPaymail: `dee@${DOMAIN}`, handle: 'deggen' })
    resetRegistrationState()

    const replay = scriptedClient({ put: () => ({ kind: 'ok' }) })
    expect(await resumePending({ client: replay.client, signer: SIGNER, storage })).toEqual({
      kind: 'changed',
      paymail: `deggen@${DOMAIN}`
    })
    // Both steps are replayed: the release is a no-op the server already holds.
    expect(replay.puts).toHaveLength(2)
  })

  /**
   * The journal a failed reclaim leaves behind. Finishing it means the user
   * kept the handle they started with, which is `rolled_back` — reporting
   * `changed` would announce a handle they never stopped holding.
   */
  it('reports rolled_back for the reclaim journal it resumes, not changed', async () => {
    const { client } = scriptedClient({
      put: (_cert, call) =>
        call === 1
          ? { kind: 'ok' }
          : call === 2
            ? { kind: 'rejected', code: 'ERR_HANDLE_TAKEN', description: 'taken' }
            : { kind: 'failed', message: 'offline' }
    })
    const storage = memoryStorage()
    expect(
      await changeHandle({ client, signer: SIGNER, storage }, { previousPaymail: `dee@${DOMAIN}`, handle: 'deggen' })
    ).toEqual({ kind: 'pending' })
    const left = journalOf(storage)
    resetRegistrationState()

    const replay = scriptedClient({ put: () => ({ kind: 'ok' }) })
    expect(await resumePending({ client: replay.client, signer: SIGNER, storage })).toEqual({
      kind: 'rolled_back',
      paymail: `dee@${DOMAIN}`
    })
    expect(replay.puts[0]).toEqual(left?.steps[0].cert)
    expect(journalOf(storage)).toBeNull()
  })

  /**
   * A reclaim journal is one step, and that is the whole difference: a claim
   * refused on the way back is a rejection to report, not an invitation to
   * reclaim what we were already reclaiming.
   */
  it('reports the rejection of a reclaim journal rather than reclaiming again', async () => {
    const { client } = scriptedClient({
      put: (_cert, call) =>
        call === 1
          ? { kind: 'ok' }
          : call === 2
            ? { kind: 'rejected', code: 'ERR_HANDLE_TAKEN', description: 'taken' }
            : { kind: 'failed', message: 'offline' }
    })
    const storage = memoryStorage()
    await changeHandle({ client, signer: SIGNER, storage }, { previousPaymail: `dee@${DOMAIN}`, handle: 'deggen' })
    expect(journalOf(storage)?.steps).toHaveLength(1)
    resetRegistrationState()

    const replay = scriptedClient({
      put: () => ({ kind: 'rejected', code: 'ERR_HANDLE_COOLDOWN', description: 'cooldown' })
    })
    expect(await resumePending({ client: replay.client, signer: SIGNER, storage })).toEqual({
      kind: 'rejected',
      code: 'ERR_HANDLE_COOLDOWN',
      description: 'cooldown'
    })
    expect(replay.puts).toHaveLength(1)
    expect(journalOf(storage)).toBeNull()
  })

  /**
   * The step count, not the paymail, is what tells a reclaim journal from a
   * change that ran its course. A two-step journal ending where it started —
   * what an older build wrote for a change to the handle already held — is a
   * change that completed, and calling it `rolled_back` would announce a
   * failure to a user whose handle is exactly what they asked for.
   */
  it('reports changed for a two-step journal that ends where it started', async () => {
    const { client } = scriptedClient({ put: () => ({ kind: 'failed', message: 'offline' }) })
    const storage = memoryStorage()
    await changeHandle({ client, signer: SIGNER, storage }, { previousPaymail: `dee@${DOMAIN}`, handle: 'deggen' })
    const left = journalOf(storage) as PendingJournal
    left.steps[1].paymail = `dee@${DOMAIN}`
    storage.map.set(PENDING_JOURNAL_KEY, JSON.stringify(left))
    resetRegistrationState()

    const replay = scriptedClient({ put: () => ({ kind: 'ok' }) })
    expect(await resumePending({ client: replay.client, signer: SIGNER, storage })).toEqual({
      kind: 'changed',
      paymail: `dee@${DOMAIN}`
    })
    expect(replay.puts).toHaveLength(2)
  })

  it('ignores a journal it cannot read', async () => {
    const { client, puts } = scriptedClient({})
    const storage = memoryStorage({ [PENDING_JOURNAL_KEY]: '{not json' })
    expect(await resumePending({ client, signer: SIGNER, storage })).toEqual({ kind: 'idle' })
    expect(puts).toHaveLength(0)
    // Every reader answers "no journal" for it, so nothing else would ever
    // clear it: it would outlive the install.
    expect(storage.map.get(PENDING_JOURNAL_KEY)).toBe('')
  })

  it('drops a journal from a version it does not know', async () => {
    const { client, puts } = scriptedClient({})
    const storage = memoryStorage({
      [PENDING_JOURNAL_KEY]: '{"v":2,"intent":"register","steps":[{"kind":"claim","paymail":"dee@deggen.com"}]}'
    })
    expect(await resumePending({ client, signer: SIGNER, storage })).toEqual({ kind: 'idle' })
    expect(puts).toHaveLength(0)
    expect(storage.map.get(PENDING_JOURNAL_KEY)).toBe('')
  })

  it('drops a journal with no steps rather than reading past the end of it', async () => {
    const { client, puts } = scriptedClient({})
    const storage = memoryStorage({
      [PENDING_JOURNAL_KEY]: '{"v":1,"intent":"register","steps":[],"startedAt":"x"}'
    })
    expect(await resumePending({ client, signer: SIGNER, storage })).toEqual({ kind: 'idle' })
    expect(puts).toHaveLength(0)
    expect(storage.map.get(PENDING_JOURNAL_KEY)).toBe('')
  })

  it('reports unavailable rather than dropping a journal it cannot act on', async () => {
    const storage = memoryStorage({ [PENDING_JOURNAL_KEY]: '{"v":1,"intent":"register","steps":[],"startedAt":"x"}' })
    expect(await resumePending({ client: null, signer: SIGNER, storage })).toEqual({ kind: 'unavailable' })
    expect(storage.map.get(PENDING_JOURNAL_KEY)).not.toBe('')
  })
})

describe('concurrency', () => {
  /** A client whose first PUT hangs until the test lets it go. */
  function gatedClient() {
    let release: (value: PutResult) => void = () => {}
    const gate = new Promise<PutResult>(resolve => {
      release = resolve
    })
    const { client, puts } = scriptedClient({})
    const slow: HandleRegistryClient = {
      ...client,
      putCertificate: async cert => {
        puts.push(cert)
        return puts.length === 1 ? await gate : { kind: 'created' }
      }
    }
    return { client: slow, puts, release: (v: PutResult) => release(v) }
  }

  it('shares one run between a double tap and a second mount asking for the same thing', async () => {
    const { client, puts, release } = gatedClient()
    const deps = { client, signer: SIGNER, storage: memoryStorage() }

    const first = registerHandle(deps, { handle: 'dee' })
    const second = registerHandle(deps, { handle: 'dee' })
    release({ kind: 'created' })

    const results = await Promise.all([first, second])
    expect(results[0]).toEqual({ kind: 'registered', paymail: `dee@${DOMAIN}` })
    expect(results[1]).toBe(results[0])
    expect(puts).toHaveLength(1)
  })

  /**
   * The mount's resume is routinely still in flight when the user taps Claim.
   * The claim must wait its turn, not receive the resume's answer — a claim
   * that silently becomes `idle` is a button that spins and does nothing.
   */
  it('queues a different intent behind the run in progress instead of swallowing it', async () => {
    const { client, puts, release } = gatedClient()
    const storage = memoryStorage()
    const deps = { client, signer: SIGNER, storage }

    // Claim tapped, then the display name saved before the claim has landed,
    // then a second Profile mount resuming.
    const claim = registerHandle(deps, { handle: 'dee' })
    const rename = updateProfile(deps, { paymail: `dee@${DOMAIN}`, displayName: 'Dee K' })
    const resume = resumePending(deps)
    release({ kind: 'created' })

    const results = await Promise.all([claim, rename, resume])
    expect(results[0]).toEqual({ kind: 'registered', paymail: `dee@${DOMAIN}` })
    expect(results[1]).toEqual({ kind: 'updated', paymail: `dee@${DOMAIN}` })
    // Nothing left journalled by the time the queue drains, so the resume that
    // ran last had nothing to finish.
    expect(results[2]).toEqual({ kind: 'idle' })
    expect(puts).toHaveLength(2)
    expect(puts[1].fields.displayName).toBe('Dee K')
    expect(Date.parse(puts[1].fields.issuedAt)).toBeGreaterThan(Date.parse(puts[0].fields.issuedAt))
    expect(journalOf(storage)).toBeNull()
  })

  /**
   * Joining is about what a run IS, not when it was enqueued: a tap that
   * arrives after the mount's resume has queued asks for the same thing as the
   * tap before it, and running it twice is a second release/claim pair against
   * the registry for one user action.
   */
  it('joins an identical run that is queued behind a different intent', async () => {
    const { client, puts, release } = gatedClient()
    const storage = memoryStorage()
    const deps = { client, signer: SIGNER, storage }
    const args = { previousPaymail: `dee@${DOMAIN}`, handle: 'deggen' }

    const first = changeHandle(deps, args)
    const resume = resumePending(deps)
    const again = changeHandle(deps, args)
    release({ kind: 'ok' })

    const results = await Promise.all([first, resume, again])
    expect(results[0]).toEqual({ kind: 'changed', paymail: `deggen@${DOMAIN}` })
    expect(results[2]).toBe(results[0])
    // The release and the claim, once each: the resume that ran in between
    // found the journal the change had already cleared.
    expect(puts).toHaveLength(2)
    expect(results[1]).toEqual({ kind: 'idle' })
  })
})
