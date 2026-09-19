/**
 * The one test that talks to a real registry. Skipped unless the developer
 * points it at one:
 *
 *   cd /Users/personal/git/go/go-message-box-server
 *   docker compose --profile mongo up -d mongo
 *   PAYMAIL_DOMAIN=deggen.com PAYMAIL_HOST=http://localhost:8080 \
 *     STORAGE_BACKEND=mongo go run ./cmd/server
 *
 *   cd /Users/personal/git/bsv-wallet
 *   HANDLE_REGISTRY_LIVE_URL=http://localhost:8080 \
 *   HANDLE_REGISTRY_LIVE_DOMAIN=deggen.com \
 *     npx jest packages/expo-wallet-toolbox/__tests__/identity/handleRegistry.live.test.ts
 *
 * Reading process.env here is fine and is not the rule this repo enforces:
 * that rule is about the PACKAGE, which ships to hosts through npm. A test
 * file is never bundled.
 */
import * as http from 'node:http'
import * as https from 'node:https'
import { PrivateKey, ProtoWallet } from '@bsv/sdk'
import type { ProfileSigner } from '../../core/identity/handleRegistry/profileCert'
import { createHandleRegistryClient } from '../../core/identity/handleRegistry/client'
import {
  changeHandle,
  registerHandle,
  resetRegistrationState,
  updateProfile,
  type RegistrationStorage
} from '../../core/identity/handleRegistry/registration'

const url = process.env.HANDLE_REGISTRY_LIVE_URL
const domain = process.env.HANDLE_REGISTRY_LIVE_DOMAIN
const live = url && domain ? describe : describe.skip

/**
 * Deviation from the plan: `global.fetch` under this repo's `jest-expo`
 * preset is `expo/src/winter/fetch`, the polyfill the app ships with, wired
 * to a native module. `jest-expo/src/preset/setup.js` stubs that native
 * module with a no-op so every response comes back `status: undefined,
 * ok: false` — harmless for every OTHER suite, which mocks `fetchImpl`
 * per test and never lets a real request reach it, but fatal for the one
 * test that needs to. Node's own `http`/`https` — never the package's
 * concern, only this test file's — stand in as the real transport.
 */
function nodeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    // `typeof fetch` (the `fetchImpl` parameter type in client.ts) admits a
    // `Request` too; the client here only ever calls it with a plain string
    // URL, so that branch exists solely to keep this assignable to the type.
    const target = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const transport = target.protocol === 'https:' ? https : http
    const headers: Record<string, string> = {}
    // `RequestInit` admits a `Headers` and an array of pairs as well as the
    // plain object the client always passes; going through `Headers` costs a
    // line and drops a header nobody would notice was dropped.
    new Headers(init?.headers).forEach((value, name) => {
      headers[name] = value
    })
    const body = typeof init?.body === 'string' ? init.body : undefined
    if (body !== undefined) headers['content-length'] = String(Buffer.byteLength(body))
    const req = transport.request(target, { method: init?.method ?? 'GET', headers }, res => {
      const chunks: Buffer[] = []
      // A stream that fails after the headers arrived: without this the promise
      // waits on an `end` that never comes, until the caller's timeout fires.
      res.on('error', reject)
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        const status = res.statusCode ?? 0
        resolve({
          ok: status >= 200 && status < 300,
          status,
          headers: { get: (name: string) => (res.headers[name.toLowerCase()] as string | undefined) ?? null },
          json: async () => JSON.parse(text || 'null'),
          text: async () => text
        } as unknown as Response)
      })
    })
    req.on('error', reject)
    const signal = init?.signal
    if (signal) {
      if (signal.aborted) {
        req.destroy(new Error('aborted'))
        return
      }
      const onAbort = () => req.destroy(new Error('aborted'))
      signal.addEventListener('abort', onAbort, { once: true })
      // `close` fires however the request ends, so the listener never outlives
      // it and a later abort cannot reach a request that has already settled.
      req.on('close', () => signal.removeEventListener('abort', onAbort))
    }
    if (body !== undefined) req.write(body)
    req.end()
  })
}

function memoryStorage(): RegistrationStorage {
  const map = new Map<string, string>()
  return {
    async getKeyValue(key) {
      return map.get(key)
    },
    async setKeyValue(key, value) {
      map.set(key, value)
    }
  }
}

const unique = () => `live${Math.floor(Math.random() * 1e9)}`

live('a real registry', () => {
  // `describe` takes no timeout argument — a third parameter there is silently
  // ignored and every case would keep the 5 s default. Register → search →
  // reverse → update → change against a real server and MongoDB exceeds that.
  jest.setTimeout(60_000)

  // `describe.skip` still runs this body to collect the `it`s — only the test
  // bodies are skipped — so this cannot crash when the env vars are unset.
  // Falling back to empty strings keeps `createHandleRegistryClient` (a pure
  // constructor: no fetch happens until a test body runs) from throwing on
  // `undefined.trim()`; the fallback is never reached by a live run, and never
  // exercised at all when `live` is `describe.skip`.
  const pinned = { domain: domain ?? '', url: url ?? '' }
  const key = PrivateKey.fromRandom()
  const signer = new ProtoWallet(key) as unknown as ProfileSigner
  const client = createHandleRegistryClient({ pinned, fetchImpl: nodeFetch })
  const storage = memoryStorage()
  const deps = { client, signer, storage }
  const first = unique()
  const second = unique()

  beforeEach(() => resetRegistrationState())

  it('says a fresh handle is available', async () => {
    expect(await client.checkAvailability(first)).toEqual({ kind: 'available' })
  })

  it('registers it', async () => {
    expect(await registerHandle(deps, { handle: first, displayName: 'Live Üser' })).toEqual({
      kind: 'registered',
      paymail: `${first}@${pinned.domain}`
    })
  })

  it('says it is taken afterwards', async () => {
    expect(await client.checkAvailability(first)).toEqual({ kind: 'unavailable', reason: 'taken' })
  })

  it('finds it by a prefix of what was typed, verified end to end', async () => {
    const rows = await client.search(first.slice(0, 6))
    const mine = rows.find(row => row.identityKey === key.toPublicKey().toString())
    expect(mine?.paymail).toBe(`${first}@${pinned.domain}`)
    expect(mine?.displayName).toBe('Live Üser')
  })

  it('answers the reverse lookup with the same profile', async () => {
    const profile = await client.lookupIdentityKey(key.toPublicKey().toString())
    expect(profile?.paymail).toBe(`${first}@${pinned.domain}`)
  })

  // The trust-model rule, against the server's real prefix search rather than a
  // scripted body: a complete address may only ever answer that address.
  it('answers a complete paymail with that row and nothing else', async () => {
    const exact = await client.search(`${first}@${pinned.domain}`)
    expect(exact.map(row => row.paymail)).toEqual([`${first}@${pinned.domain}`])
    expect(await client.search(`${first}x@${pinned.domain}`)).toEqual([])
  })

  it('publishes a new display name', async () => {
    const result = await updateProfile(deps, { paymail: `${first}@${pinned.domain}`, displayName: 'Renamed' })
    expect(result).toEqual({ kind: 'updated', paymail: `${first}@${pinned.domain}` })
    const profile = await client.lookupIdentityKey(key.toPublicKey().toString())
    expect(profile?.displayName).toBe('Renamed')
  })

  it('changes the handle by releasing the old one and claiming the new one', async () => {
    const result = await changeHandle(deps, {
      previousPaymail: `${first}@${pinned.domain}`,
      handle: second,
      displayName: 'Renamed'
    })
    expect(result).toEqual({ kind: 'changed', paymail: `${second}@${pinned.domain}` })
    const profile = await client.lookupIdentityKey(key.toPublicKey().toString())
    expect(profile?.paymail).toBe(`${second}@${pinned.domain}`)
  })

  it('holds the released handle in cooldown against a different key', async () => {
    // Deviation from the plan: the server compares this claim's `issuedAt`
    // against the release's stored one (go-message-box-server
    // `pkg/storage/handles.go` `DiagnoseClaim`: `!c.IssuedAt.After(rec.IssuedAt)`
    // is `ERR_STALE_CERTIFICATE`, checked BEFORE cooldown), while this client's
    // clock correction (`client.ts` `notePinnedSkew`) only ever has the `Date`
    // response header's whole-second resolution to work with. Minting the very
    // next instant after the previous test's release, as the plan's code does,
    // can therefore land within that ~1s of slop and read as stale rather than
    // cooldown on a real server — never in the mocked unit suite, which hands
    // `serverNow` an exact value. A margin comfortably wider than one second
    // is what a person following the module doc's own manual steps gets for
    // free; this closes the gap for an automated run.
    await new Promise(resolve => setTimeout(resolve, 1500))
    const other = PrivateKey.fromRandom()
    const otherDeps = {
      client,
      signer: new ProtoWallet(other) as unknown as ProfileSigner,
      storage: memoryStorage()
    }
    resetRegistrationState()
    const result = await registerHandle(otherDeps, { handle: first })
    // The code and not just the verdict, because it is the only assertion here
    // that can tell the two refusals apart: the availability answer below reads
    // `cooldown` either way — `unavailableReason` (`lookup.go`) reports the
    // cooldown before it ever reaches the stale branch, and `reasonOf`
    // (`client.ts`) folds a `stale` reason into `cooldown` besides. So this is
    // what fails, loudly, if the margin above ever stops being enough.
    expect(result).toMatchObject({ kind: 'rejected', code: 'ERR_HANDLE_COOLDOWN' })
    expect(await client.checkAvailability(first)).toEqual({ kind: 'unavailable', reason: 'cooldown' })
  })
})
