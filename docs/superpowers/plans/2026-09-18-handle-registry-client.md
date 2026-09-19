# Handle Registry Client — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the placeholder handle-certificate flow (`core/identity/handleCertificate.ts`, a certifier that was never deployed plus an advisory overlay name search) with a real client for go-message-box-server's paymail profile registry, and add that registry as a third tier of Pay's recipient search.

**Architecture:** A new leaf directory `packages/expo-wallet-toolbox/core/identity/handleRegistry/` holds five pure, React-Native-safe modules — `rules` (constants + string checks), `profileCert` (build/verify a self-signed BRC-52 certificate with real `@bsv/sdk` crypto), `resolver` (pinned domain short-circuit, else DoH SRV + `/.well-known/bsvalias`), `client` (the four HTTP routes, verified on the way in), and `registration` (every write, journaled in `key_value_store` so a crash or a double tap replays identical bytes the server treats as a no-op). The host states the registry per chain through `configureToolbox`; `ProfileScreen` and `UniversalSend` are the only two UI consumers.

**Tech stack:** TypeScript strict, React Native (Expo), `@bsv/sdk` 2.4.1 (`Certificate`, `ProtoWallet`, `Utils`, `Random`), global `fetch` with an injectable `fetchImpl`, Jest (`jest-expo` preset, config inline in the ROOT `package.json`), i18next across 12 locales.

**Spec:** `docs/superpowers/specs/2026-09-18-handle-registry-client-design.md` (normative — read it in full before starting any task).
**Server spec:** `/Users/personal/git/go/go-message-box-server/docs/specs/2026-09-18-paymail-profile-lookup-design.md`; server source of truth for exact behaviour: `pkg/handlers/lookup.go`, `pkg/profilecert/profilecert.go`, `pkg/handles/handles.go`.

## Global Constraints

- **Branch:** `feat/handle-registry-client` is checked out. Never switch branches, never push, never commit unless asked.
- **Jest runs from the repo ROOT only:** `cd /Users/personal/git/bsv-wallet && npx jest <path>`. Running inside `packages/expo-wallet-toolbox` fails at Babel — there is no jest config inside the package.
- **The package reads no `process.env`.** No `EXPO_PUBLIC_*` anywhere under `packages/`. Expo's Babel preset refuses to inline those for any path containing `node_modules`, so a package-internal read is `undefined` in every production bundle (`core/toolboxConfig.ts` module doc, lines 46-66). Hosts pass values through `configureToolbox`; `app/_layout.tsx` is where env is read.
- **React-Native safe only:** no Node built-ins, no `Buffer`, no `node:crypto`. Use `@bsv/sdk`'s `Utils` and `Random`. `URL` is fine (`normalizeBackupUrl` already uses it).
- **HTTP convention:** global `fetch` behind an injectable `fetchImpl`, one attempt, no retry/backoff, an `AbortController` + `setTimeout` bounded to 8 s, `clearTimeout` in `finally`. Model: `core/backup/client.ts` and `core/services/usdFxRates.ts`. There is no shared fetch helper in this codebase; this feature adds exactly one (`fetchWithTimeout`, in `resolver.ts`) and both networking modules use it.
- **Signing goes through `bindOriginator(wallet, adminOriginator)`** (`core/mandala/createRuntime.ts:285`) so no permission prompt appears. `adminOriginator` from `useWallet()` is typed `string` and is always defined.
- **`handle` already names the identity-key pay rail** (`RailId 'handle'`, `core/pay/rails/handle.ts`). Nothing in this feature renames or collides with it: here a handle is the local part of a `handle@domain` paymail.
- **i18n:** 12 locale blocks — `en, zh, hi, es, fr, ar, pt, bn, ru, id, ja, pl` at `core/i18n/translations.tsx` lines 101, 1065, 1947, 2889, 3842, 4807, 5708, 6658, 7594, 8541, 9489, 10441. Every new or changed key must exist in **all 12** with a real translation, the same `{{placeholder}}` set, and a value not byte-identical to English (`__tests__/i18n/translationParity.test.ts` enforces all three). Key order differs between blocks — locate insertion points by anchor key name, never by line offset.
- **Prettier:** `semi: false`, `singleQuote: true`, `trailingComma: "none"`, `arrowParens: "avoid"`, `printWidth: 120`, `tabWidth: 2`. Run `npx prettier --check` and `npx eslint` on the files you touched and fix what they report. Do not reformat files you did not otherwise change.
- **Comment density and idiom:** match the surrounding file. This codebase writes module docs that say _why_, not _what_, and keeps inline comments for the non-obvious decision. Do not add narration.
- **Test idiom:** hand-rolled minimal mocks cast `as unknown as X`; `global.fetch` swapped per test or an injected `fetchImpl`; real `@bsv/sdk` crypto for anything involving a signature — never a mocked signature.
- **Scratch files go to** `/private/tmp/claude-502/-Users-personal-git-demos-mandala/e8a0f214-0dee-466f-82e8-d60b8139addd/scratchpad`, never into the repo.

## File Structure

| File                                                                                | Responsibility                                                                                                                                                              |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/expo-wallet-toolbox/core/identity/handleRegistry/rules.ts`                | **New.** Constants mirroring the server's rules, and the pure string checks (`isValidHandleFormat`, `parsePaymail`, `looksLikeDomain`, `utf8ByteLength`). No I/O, no state. |
| `packages/expo-wallet-toolbox/core/identity/handleRegistry/profileCert.ts`          | **New.** Build a signed profile certificate; decide whether one received from any host is worth believing (the trust model). Real `@bsv/sdk` crypto, no network.            |
| `packages/expo-wallet-toolbox/core/identity/handleRegistry/resolver.ts`             | **New.** `domain → RegistryEndpoints`: pinned short-circuit, else DoH SRV + well-known discovery, with a per-domain TTL cache. Owns `fetchWithTimeout`.                     |
| `packages/expo-wallet-toolbox/core/identity/handleRegistry/client.ts`               | **New.** The four HTTP routes, each verified on the way in; clock-skew correction from the `Date` header.                                                                   |
| `packages/expo-wallet-toolbox/core/identity/handleRegistry/registration.ts`         | **New.** Every write, journaled. One entry point per intent, plus `resumePending`, plus a shared in-flight promise.                                                         |
| `packages/expo-wallet-toolbox/core/toolboxConfig.ts`                                | Gains `handleRegistry` + `getHandleRegistryConfig`; loses `handleCertifier` / `HandleCertifierConfig` / `getHandleCertifierConfig` (Task 8).                                |
| `packages/expo-wallet-toolbox/core/index.ts`                                        | Re-exports `getHandleRegistryConfig` and `HandleRegistryConfig`.                                                                                                            |
| `packages/expo-wallet-toolbox/core/identity/handleCertificate.ts`                   | **Deleted** in Task 8.                                                                                                                                                      |
| `packages/expo-wallet-toolbox/core/contacts/contactCache.ts`                        | **New.** One pure function that decides the full cache row to write, so `refreshContactCache`'s wholesale UPDATE never blanks a column it was not told about.               |
| `packages/expo-wallet-toolbox/core/i18n/translations.tsx`                           | 7 new + 4 changed keys × 12 locales.                                                                                                                                        |
| `packages/expo-wallet-toolbox/ui/screens/ProfileScreen.tsx`                         | Gated on the registry instead of the certifier; local-part input with a fixed `@domain` suffix; registry is the source of truth for the registered handle.                  |
| `packages/expo-wallet-toolbox/ui/components/pay/RecipientField.tsx`                 | Spinner becomes a footer instead of replacing the list; rows gain a caller-supplied second line.                                                                            |
| `packages/expo-wallet-toolbox/ui/components/pay/UniversalSend.tsx`                  | A registry tier joins `mergedSearchResults`; its own 400 ms timer, notice and cleanup; carries the selected handle into "Save as contact".                                  |
| `packages/expo-wallet-toolbox/ui/screens/NewContactScreen.tsx`                      | Accepts a `handle` route param, validates it as a paymail, and stores it as `cachedHandle`.                                                                                 |
| `packages/expo-wallet-toolbox/ui/screens/ContactScreen.tsx`                         | Background refresh also refreshes `cachedHandle`, in one write with the avatar; hero drops the `@` sigil.                                                                   |
| `packages/expo-wallet-toolbox/ui/screens/ContactsScreen.tsx`                        | One line: the row's second line drops the `@` sigil now that `cachedHandle` carries its own domain.                                                                         |
| `packages/expo-wallet-toolbox/ui/screens/IdentifierScreen.tsx`                      | One line: the hero handle drops the `@` sigil for the same reason.                                                                                                          |
| `packages/expo-wallet-toolbox/app`→`/Users/personal/git/bsv-wallet/app/_layout.tsx` | Reads `EXPO_PUBLIC_[TEST_]HANDLE_REGISTRY_DOMAIN`/`_URL` and passes them in.                                                                                                |
| `/Users/personal/git/bsv-wallet/eas.json`                                           | `development` and `dev-physical` get `deggen.com` + `https://messagebox.bsvblockchain.tech`; production stays unset.                                                        |
| `packages/expo-wallet-toolbox/CHANGELOG.md`, `package.json`, `README.md`            | 0.6.0 section, version bump, Configuration section entry.                                                                                                                   |

Test files, all new unless marked:

| File                                                                                  | Covers                                                                               |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `packages/expo-wallet-toolbox/__tests__/identity/handleRegistry/rules.test.ts`        | Task 1                                                                               |
| `packages/expo-wallet-toolbox/__tests__/identity/handleRegistry/profileCert.test.ts`  | Task 2                                                                               |
| `packages/expo-wallet-toolbox/__tests__/toolboxConfig.test.ts`                        | _existing_, extended in Tasks 3 and 8                                                |
| `packages/expo-wallet-toolbox/__tests__/identity/handleRegistry/resolver.test.ts`     | Task 4                                                                               |
| `packages/expo-wallet-toolbox/__tests__/identity/handleRegistry/client.test.ts`       | Task 5                                                                               |
| `packages/expo-wallet-toolbox/__tests__/identity/handleRegistry/registration.test.ts` | Task 6                                                                               |
| `packages/expo-wallet-toolbox/__tests__/i18n/translationParity.test.ts`               | _existing_, unchanged, must stay green (Task 7)                                      |
| `packages/expo-wallet-toolbox/__tests__/ui/profileScreen.test.tsx`                    | Task 8                                                                               |
| `packages/expo-wallet-toolbox/__tests__/identity/handleCertificate.test.ts`           | **deleted** in Task 8                                                                |
| `packages/expo-wallet-toolbox/__tests__/ui/recipientField.test.tsx`                   | Task 9                                                                               |
| `packages/expo-wallet-toolbox/__tests__/ui/universalSend.test.tsx`                    | _existing_, extended in Task 9                                                       |
| `packages/expo-wallet-toolbox/__tests__/contacts/contactCache.test.ts`                | Task 10                                                                              |
| `packages/expo-wallet-toolbox/__tests__/ui/newContactHandle.test.tsx`                 | Task 10                                                                              |
| `packages/expo-wallet-toolbox/__tests__/ui/contactScreen.test.tsx`                    | Task 10 — the rewritten background refresh, and the two screens that render a handle |
| `packages/expo-wallet-toolbox/__tests__/identity/handleRegistry.live.test.ts`         | Task 11 (env-gated)                                                                  |

---

## Task 1: `rules.ts` — the constants and the pure checks

Everything later in this feature leans on these, and nothing here does I/O, so it goes first. Every value mirrors a rule the registry server enforces; the citations in the comments are what keeps them honest.

**Files:**

- Create: `packages/expo-wallet-toolbox/core/identity/handleRegistry/rules.ts`
- Create (test): `packages/expo-wallet-toolbox/__tests__/identity/handleRegistry/rules.test.ts`

**Interfaces — produced by this task, relied on verbatim by Tasks 2, 4, 5, 6, 8, 9:**

```ts
export const PROFILE_CERT_TYPE: string // 'SbatVXXssDW3AO0J9bxIljkHGbPBGCVAXg94gXFf0cE='
export const BRFC_LOOKUP: string // '0ace65da5987'
export const BRFC_REVERSE_LOOKUP: string // '43dcf83ddc5f'
export const ZERO_OUTPOINT: string // 64 zeros + '.0'
export const MAX_FIELDS: number // 32
export const MAX_FIELD_NAME_BYTES: number // 50, exclusive
export const MAX_FIELD_VALUE_BYTES: number // 1024
export const MAX_CERT_BODY_BYTES: number // 16384
export const SEARCH_MIN_QUERY_LENGTH: number // 2
export const MAX_SEARCH_QUERY_LENGTH: number // 32
export function isValidHandleFormat(handle: string): boolean
export function looksLikeDomain(text: string): boolean
export function isRoutableSearchQuery(query: string): boolean
export function parsePaymail(text: string): { handle: string; domain: string } | null
export function utf8ByteLength(text: string): number
```

Consumes: `Utils` from `@bsv/sdk` only.

- [ ] **Step 1: Write the failing test**

Create `packages/expo-wallet-toolbox/__tests__/identity/handleRegistry/rules.test.ts`:

```ts
import {
  MAX_CERT_BODY_BYTES,
  MAX_FIELDS,
  MAX_FIELD_NAME_BYTES,
  MAX_FIELD_VALUE_BYTES,
  MAX_SEARCH_QUERY_LENGTH,
  PROFILE_CERT_TYPE,
  BRFC_LOOKUP,
  BRFC_REVERSE_LOOKUP,
  SEARCH_MIN_QUERY_LENGTH,
  ZERO_OUTPOINT,
  isRoutableSearchQuery,
  isValidHandleFormat,
  looksLikeDomain,
  parsePaymail,
  utf8ByteLength
} from '../../../core/identity/handleRegistry/rules'

describe('constants', () => {
  it('states the registry values the server enforces', () => {
    expect(PROFILE_CERT_TYPE).toBe('SbatVXXssDW3AO0J9bxIljkHGbPBGCVAXg94gXFf0cE=')
    expect(BRFC_LOOKUP).toBe('0ace65da5987')
    expect(BRFC_REVERSE_LOOKUP).toBe('43dcf83ddc5f')
    expect(ZERO_OUTPOINT).toBe('0000000000000000000000000000000000000000000000000000000000000000.0')
    expect([MAX_FIELDS, MAX_FIELD_NAME_BYTES, MAX_FIELD_VALUE_BYTES, MAX_CERT_BODY_BYTES]).toEqual([
      32, 50, 1024, 16384
    ])
    expect(SEARCH_MIN_QUERY_LENGTH).toBe(2)
    expect(MAX_SEARCH_QUERY_LENGTH).toBe(32)
  })
})

// The server's own table (pkg/handles): ^[a-z0-9][a-z0-9._-]{1,30}[a-z0-9]$.
describe('isValidHandleFormat', () => {
  it.each(['dee', 'de.ggen', 'de_gen-1', 'a1b', '0x0', 'a'.repeat(32)])('accepts %s', h =>
    expect(isValidHandleFormat(h)).toBe(true)
  )
  it.each(['de', 'a'.repeat(33), 'Dee', '.dee', 'dee.', '-dee', 'dee-', '_dee', 'de gen', 'dee!', 'dée', ''])(
    'rejects %s',
    h => expect(isValidHandleFormat(h)).toBe(false)
  )
})

describe('looksLikeDomain', () => {
  it.each(['deggen.com', 'example.co.uk', 'a.io', 'my-host.example.com'])('accepts %s', d =>
    expect(looksLikeDomain(d)).toBe(true)
  )
  it.each(['example', 'exa mple.com', '-bad.com', 'bad-.com', '.com', 'example..com', ''])('rejects %s', d =>
    expect(looksLikeDomain(d)).toBe(false)
  )
  it('lowercases before judging, the way a typed domain arrives', () => {
    expect(looksLikeDomain('  Deggen.COM ')).toBe(true)
  })
})

// The server's own gate on a search path segment (pkg/handlers/lookup.go
// `normaliseQuery`, `queryRE`, `maxQueryLength`), plus the one word its route
// table swallows before the search route ever sees it.
describe('isRoutableSearchQuery', () => {
  it.each(['de', 'dee', 'de.ggen', 'de_gen-1', 'a'.repeat(32)])('accepts %s', q =>
    expect(isRoutableSearchQuery(q)).toBe(true)
  )
  it.each(['d', '', 'a'.repeat(33), 'Dee', 'de gen', 'dee!', 'dée', 'de/gen', 'dee@x'])('rejects %s', q =>
    expect(isRoutableSearchQuery(q)).toBe(false)
  )
  it('rejects the one word the registry answers with a 400 instead of a search', () => {
    // GET /api/handle/available is mounted ahead of GET /api/handle/{query} and
    // answers ERR_INVALID_LOOKUP, which `search` would raise as an outage.
    expect(isRoutableSearchQuery('available')).toBe(false)
    expect(isRoutableSearchQuery('availables')).toBe(true)
  })
})

describe('parsePaymail', () => {
  it('splits, trims and lowercases', () => {
    expect(parsePaymail('  Dee@Deggen.COM ')).toEqual({ handle: 'dee', domain: 'deggen.com' })
  })
  it.each(['dee', 'dee@', '@deggen.com', 'dee@deggen', 'a@b@c', 'd@deggen.com', ''])('rejects %s', text =>
    expect(parsePaymail(text)).toBeNull()
  )
})

describe('utf8ByteLength', () => {
  it('counts bytes, not code units', () => {
    expect(utf8ByteLength('abc')).toBe(3)
    expect(utf8ByteLength('Üser')).toBe(5)
    expect(utf8ByteLength('日本')).toBe(6)
  })
})
```

- [ ] **Step 2: Run it, expect the named failure**

```bash
cd /Users/personal/git/bsv-wallet && npx jest packages/expo-wallet-toolbox/__tests__/identity/handleRegistry/rules.test.ts
```

Expected: FAIL — `Cannot find module '../../../core/identity/handleRegistry/rules'`.

- [ ] **Step 3: Implement**

Create `packages/expo-wallet-toolbox/core/identity/handleRegistry/rules.ts`:

```ts
/**
 * Handle-registry rules — the constants, and the string checks that are pure.
 *
 * Every value here mirrors a rule the registry enforces on write
 * (go-message-box-server `pkg/handles`, `pkg/profilecert`). Restating them on
 * this side is not distrust of the server: a client that cannot tell a valid
 * handle from an invalid one has to ask the network what the user just typed,
 * once per keystroke.
 *
 * "Handle" already names the identity-key pay rail in this codebase
 * (`RailId 'handle'`, core/pay/rails/handle.ts). Nothing here reuses that word
 * as a rail — a handle is the local part of a `handle@domain` paymail.
 */
import { Utils } from '@bsv/sdk'

/** base64(SHA-256("public profile lookup")) — the profile certificate's type. */
export const PROFILE_CERT_TYPE = 'SbatVXXssDW3AO0J9bxIljkHGbPBGCVAXg94gXFf0cE='
/** BRFC id of the `public profile lookup` capability — search. */
export const BRFC_LOOKUP = '0ace65da5987'
/** BRFC id of the `public profile reverse lookup` capability — key → profile. */
export const BRFC_REVERSE_LOOKUP = '43dcf83ddc5f'
/** There is no on-chain revocation: a profile is replaced or tombstoned. */
export const ZERO_OUTPOINT = `${'0'.repeat(64)}.0`

export const MAX_FIELDS = 32
/** Exclusive — go-sdk's own `CertificateFieldNameUnder50Bytes`. */
export const MAX_FIELD_NAME_BYTES = 50
export const MAX_FIELD_VALUE_BYTES = 1024
export const MAX_CERT_BODY_BYTES = 16384

/** Shorter than this and the search route answers nothing at all. */
export const SEARCH_MIN_QUERY_LENGTH = 2
/** Longer than this and the search route answers nothing at all. */
export const MAX_SEARCH_QUERY_LENGTH = 32

const HANDLE_FORMAT = /^[a-z0-9][a-z0-9._-]{1,30}[a-z0-9]$/
const DOMAIN_FORMAT = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/
const SEARCH_QUERY_FORMAT = /^[a-z0-9._-]+$/

/**
 * Path segments the registry's route table claims before the search route sees
 * them. `GET /api/handle/available` is mounted ahead of
 * `GET /api/handle/{query}` and answers `400 ERR_INVALID_LOOKUP`, which `search`
 * would surface as "the registry is down" — for an ordinary English word.
 */
const RESERVED_QUERY_PATHS = new Set(['available'])

/** 3-32 characters of a-z 0-9 . _ - beginning and ending with a letter or digit. */
export function isValidHandleFormat(handle: string): boolean {
  return HANDLE_FORMAT.test(handle)
}

/** A dotted, all-lowercase domain. Says nothing about whether it resolves. */
export function looksLikeDomain(text: string): boolean {
  return DOMAIN_FORMAT.test(text.trim().toLowerCase())
}

/**
 * Whether the registry would actually search for this, rather than answer an
 * empty array or a 400. Restating the server's own gate here is what keeps a
 * routine word — a too-long paste, an accent, a slash — from costing a request
 * and, for the reserved paths, from raising an outage banner.
 */
export function isRoutableSearchQuery(query: string): boolean {
  if (query.length < SEARCH_MIN_QUERY_LENGTH || query.length > MAX_SEARCH_QUERY_LENGTH) return false
  if (!SEARCH_QUERY_FORMAT.test(query)) return false
  return !RESERVED_QUERY_PATHS.has(query)
}

/**
 * `handle@domain`, trimmed and lowercased, or null when it is not one.
 *
 * Lowercasing here is what makes a typed `Dee@Example.com` comparable with the
 * exact-lowercase `paymail` field the registry stores — the comparison the
 * trust model turns on.
 */
export function parsePaymail(text: string): { handle: string; domain: string } | null {
  const parts = text.trim().toLowerCase().split('@')
  if (parts.length !== 2) return null
  const [handle, domain] = parts
  if (!isValidHandleFormat(handle) || !looksLikeDomain(domain)) return null
  return { handle, domain }
}

/** UTF-8 length, the unit every server-side size limit counts in. `Buffer` does
 * not exist in React Native, so this goes through the SDK's own encoder. */
export function utf8ByteLength(text: string): number {
  return Utils.toArray(text, 'utf8').length
}
```

- [ ] **Step 4: Run it, expect pass**

```bash
cd /Users/personal/git/bsv-wallet && npx jest packages/expo-wallet-toolbox/__tests__/identity/handleRegistry/rules.test.ts
```

Expected: PASS — 5 suites of assertions, 0 failures.

- [ ] **Step 5: Lint and format the two new files**

```bash
cd /Users/personal/git/bsv-wallet && npx prettier --check packages/expo-wallet-toolbox/core/identity/handleRegistry/rules.ts packages/expo-wallet-toolbox/__tests__/identity/handleRegistry/rules.test.ts && npx eslint packages/expo-wallet-toolbox/core/identity/handleRegistry/rules.ts packages/expo-wallet-toolbox/__tests__/identity/handleRegistry/rules.test.ts
```

Expected: both clean. Fix anything reported.

---

## Task 2: `profileCert.ts` — build one, and decide whether to believe one

The trust model is the whole security boundary of this feature: the registry is a directory, not an authority on profile content, so a certificate is believed because it verifies, not because a host served it. Real `@bsv/sdk` crypto throughout — a mocked signature would test nothing.

**Files:**

- Create: `packages/expo-wallet-toolbox/core/identity/handleRegistry/profileCert.ts`
- Create (test): `packages/expo-wallet-toolbox/__tests__/identity/handleRegistry/profileCert.test.ts`

**Interfaces — produced here, relied on verbatim by Tasks 5, 6, 8, 9:**

```ts
export interface ProfileCertJson {
  type: string
  serialNumber: string
  subject: string
  certifier: string
  revocationOutpoint: string
  fields: Record<string, string>
  signature: string
}

export interface ProfileSigner {
  getPublicKey(args: { identityKey: true }, originator?: string): Promise<{ publicKey: string }>
  createSignature(
    args: { data: number[]; protocolID: [number, string]; keyID: string; counterparty?: string },
    originator?: string
  ): Promise<{ signature: number[] }>
}

export interface RegistryProfile {
  identityKey: string
  paymail: string
  handle: string
  domain: string
  displayName?: string
  issuedAt: Date
  certificate: ProfileCertJson
}

export function buildProfileCertificate(args: {
  signer: ProfileSigner
  paymail: string
  issuedAt: Date
  displayName?: string
  released?: boolean
}): Promise<ProfileCertJson>

export function verifyProfileCertificate(
  cert: unknown,
  expect: { domain: string; paymail?: string; identityKey?: string }
): Promise<RegistryProfile | null>

export function resetDroppedLog(): void // test-only: forget which reasons have been logged
```

`verifyProfileCertificate` is **async** (`Certificate.verify()` is) and **never throws** — every failure returns `null`, and logs **at most one line per distinct reason** for the life of the process (the spec's "dropped silently (logged once)"). A registry serving ten junk rows on every debounced keystroke must not be able to fill the log.

`ProfileSigner.createSignature` takes `counterparty` as **optional**, and `Certificate.sign()` in the installed SDK omits it entirely (`node_modules/@bsv/sdk/dist/cjs/src/auth/certificates/Certificate.js:195` passes only `data`, `protocolID`, `keyID`). The wallet must therefore default it to `'anyone'`, which is exactly what `ProtoWallet.createSignature` does and what `Certificate.verify()` — an `'anyone'` `ProtoWallet` verifying against `this.certifier` — depends on. That default is load-bearing for anyone-verifiability, so the test below pins it.

Consumes: `rules.ts` (Task 1), `@bsv/sdk`'s `Certificate`, `Random`, `Utils`, and the `ProtoWallet` **type**.

- [ ] **Step 1: Write the failing test**

Create `packages/expo-wallet-toolbox/__tests__/identity/handleRegistry/profileCert.test.ts`:

```ts
/**
 * Real crypto only: a ProtoWallet over a random key signs, and the SDK's own
 * Certificate.verify decides. A mocked signature would make every case below
 * pass for the wrong reason.
 */
import { Certificate, PrivateKey, ProtoWallet } from '@bsv/sdk'
import { PROFILE_CERT_TYPE, ZERO_OUTPOINT } from '../../../core/identity/handleRegistry/rules'
import {
  buildProfileCertificate,
  resetDroppedLog,
  verifyProfileCertificate,
  type ProfileCertJson,
  type ProfileSigner
} from '../../../core/identity/handleRegistry/profileCert'

const DOMAIN = 'deggen.com'

function signerFor(key: PrivateKey): ProfileSigner {
  return new ProtoWallet(key) as unknown as ProfileSigner
}

/** A certificate minted by hand, so a test can break exactly one rule. */
async function mint(
  key: PrivateKey,
  fields: Record<string, string>,
  overrides: { subject?: string; type?: string; revocationOutpoint?: string } = {}
): Promise<ProfileCertJson> {
  const pub = key.toPublicKey().toString()
  const certificate = new Certificate(
    overrides.type ?? PROFILE_CERT_TYPE,
    'c2VyaWFsc2VyaWFsc2VyaWFsc2VyaWFsc2VyaWFscw==',
    overrides.subject ?? pub,
    pub,
    overrides.revocationOutpoint ?? ZERO_OUTPOINT,
    fields
  )
  await certificate.sign(new ProtoWallet(key))
  return {
    type: certificate.type,
    serialNumber: certificate.serialNumber,
    subject: certificate.subject,
    certifier: certificate.certifier,
    revocationOutpoint: certificate.revocationOutpoint,
    fields: certificate.fields,
    signature: certificate.signature ?? ''
  }
}

beforeEach(() => {
  resetDroppedLog()
  jest.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  jest.restoreAllMocks()
})

describe('buildProfileCertificate', () => {
  it('builds a self-signed certificate that verifies back into a profile', async () => {
    const key = PrivateKey.fromRandom()
    const issuedAt = new Date('2026-09-18T10:00:00.000Z')
    const cert = await buildProfileCertificate({
      signer: signerFor(key),
      paymail: `dee@${DOMAIN}`,
      issuedAt,
      displayName: 'Dee K'
    })
    expect(cert.type).toBe(PROFILE_CERT_TYPE)
    expect(cert.subject).toBe(cert.certifier)
    expect(cert.subject).toBe(key.toPublicKey().toString())
    expect(cert.revocationOutpoint).toBe(ZERO_OUTPOINT)
    expect(cert.fields).toEqual({
      paymail: `dee@${DOMAIN}`,
      issuedAt: '2026-09-18T10:00:00.000Z',
      displayName: 'Dee K'
    })
    expect(cert.signature).not.toBe('')

    const profile = await verifyProfileCertificate(cert, { domain: DOMAIN })
    expect(profile).toEqual({
      identityKey: key.toPublicKey().toString(),
      paymail: `dee@${DOMAIN}`,
      handle: 'dee',
      domain: DOMAIN,
      displayName: 'Dee K',
      issuedAt,
      certificate: cert
    })
  })

  it('gives every certificate a fresh 32-byte serial', async () => {
    const signer = signerFor(PrivateKey.fromRandom())
    const args = { signer, paymail: `dee@${DOMAIN}`, issuedAt: new Date() }
    const a = await buildProfileCertificate(args)
    const b = await buildProfileCertificate(args)
    expect(a.serialNumber).not.toBe(b.serialNumber)
    expect(Buffer.from(a.serialNumber, 'base64')).toHaveLength(32)
  })

  it('sends no display-name field at all for a blank one', async () => {
    const cert = await buildProfileCertificate({
      signer: signerFor(PrivateKey.fromRandom()),
      paymail: `dee@${DOMAIN}`,
      issuedAt: new Date(),
      displayName: '   '
    })
    expect(Object.keys(cert.fields).sort()).toEqual(['issuedAt', 'paymail'])
  })

  it('marks a tombstone with released=true', async () => {
    const cert = await buildProfileCertificate({
      signer: signerFor(PrivateKey.fromRandom()),
      paymail: `dee@${DOMAIN}`,
      issuedAt: new Date(),
      released: true
    })
    expect(cert.fields.released).toBe('true')
  })

  it('refuses a paymail that is not handle@domain', async () => {
    await expect(
      buildProfileCertificate({ signer: signerFor(PrivateKey.fromRandom()), paymail: 'dee', issuedAt: new Date() })
    ).rejects.toThrow(/not a valid paymail/)
  })

  it('refuses a display name past the 1 KB field limit rather than letting the server refuse it', async () => {
    await expect(
      buildProfileCertificate({
        signer: signerFor(PrivateKey.fromRandom()),
        paymail: `dee@${DOMAIN}`,
        issuedAt: new Date(),
        displayName: 'a'.repeat(1025)
      })
    ).rejects.toThrow(/field value too long/)
  })

  /**
   * The SDK asks for no counterparty, and anyone-verifiability depends on the
   * wallet defaulting the omission to 'anyone' — `Certificate.verify()` is an
   * 'anyone' ProtoWallet checking against `certifier`. The app's own signer is
   * the originator-bound PermissionsManager, not a ProtoWallet, so pin both
   * halves of that contract here rather than discovering it on a device.
   */
  it('asks for no counterparty, and the wallet default is what makes it verify', async () => {
    const key = PrivateKey.fromRandom()
    const inner = new ProtoWallet(key)
    const asked: (string | undefined)[] = []
    const signer: ProfileSigner = {
      getPublicKey: async () => ({ publicKey: key.toPublicKey().toString() }),
      createSignature: async args => {
        asked.push(args.counterparty)
        return await inner.createSignature({ ...args, counterparty: args.counterparty ?? 'anyone' })
      }
    }
    const cert = await buildProfileCertificate({ signer, paymail: `dee@${DOMAIN}`, issuedAt: new Date() })
    expect(asked).toEqual([undefined])
    expect(await verifyProfileCertificate(cert, { domain: DOMAIN })).not.toBeNull()
  })
})

describe('verifyProfileCertificate', () => {
  const key = PrivateKey.fromRandom()
  const good = () => ({ paymail: `dee@${DOMAIN}`, issuedAt: '2026-09-18T10:00:00.000Z' })

  it('drops a certificate of the wrong type', async () => {
    const cert = await mint(key, good(), { type: 'd2hhdGV2ZXJ3aGF0ZXZlcndoYXRldmVyd2hhdGV2ZXI=' })
    expect(await verifyProfileCertificate(cert, { domain: DOMAIN })).toBeNull()
  })

  it('drops a certificate whose subject is not its certifier, however well it is signed', async () => {
    const other = PrivateKey.fromRandom().toPublicKey().toString()
    const cert = await mint(key, good(), { subject: other })
    expect(
      await new Certificate(
        cert.type,
        cert.serialNumber,
        cert.subject,
        cert.certifier,
        cert.revocationOutpoint,
        cert.fields,
        cert.signature
      ).verify()
    ).toBe(true)
    expect(await verifyProfileCertificate(cert, { domain: DOMAIN })).toBeNull()
  })

  it('drops a certificate whose fields were edited after signing', async () => {
    const cert = await mint(key, { ...good(), displayName: 'Dee K' })
    cert.fields.displayName = 'Someone Else'
    expect(await verifyProfileCertificate(cert, { domain: DOMAIN })).toBeNull()
  })

  it('drops a certificate for another domain', async () => {
    const cert = await mint(key, good())
    expect(await verifyProfileCertificate(cert, { domain: 'other.example' })).toBeNull()
  })

  it('drops a paymail that is not exactly lowercase', async () => {
    const cert = await mint(key, { paymail: `Dee@${DOMAIN}`, issuedAt: '2026-09-18T10:00:00.000Z' })
    expect(await verifyProfileCertificate(cert, { domain: DOMAIN })).toBeNull()
  })

  it('drops a tombstone — released is not a profile', async () => {
    const cert = await mint(key, { ...good(), released: 'true' })
    expect(await verifyProfileCertificate(cert, { domain: DOMAIN })).toBeNull()
  })

  it('drops a non-zero revocation outpoint', async () => {
    const cert = await mint(key, good(), { revocationOutpoint: `${'a'.repeat(64)}.0` })
    expect(await verifyProfileCertificate(cert, { domain: DOMAIN })).toBeNull()
  })

  it('drops an oversize field value', async () => {
    const cert = await mint(key, { ...good(), bio: 'a'.repeat(1025) })
    expect(await verifyProfileCertificate(cert, { domain: DOMAIN })).toBeNull()
  })

  it('drops a missing or unparseable issuedAt', async () => {
    expect(await verifyProfileCertificate(await mint(key, { paymail: `dee@${DOMAIN}` }), { domain: DOMAIN })).toBeNull()
    expect(
      await verifyProfileCertificate(await mint(key, { paymail: `dee@${DOMAIN}`, issuedAt: 'soon' }), {
        domain: DOMAIN
      })
    ).toBeNull()
  })

  it('drops a reverse-lookup answer about a different key', async () => {
    const cert = await mint(key, good())
    const other = PrivateKey.fromRandom().toPublicKey().toString()
    expect(await verifyProfileCertificate(cert, { domain: DOMAIN, identityKey: other })).toBeNull()
    expect(await verifyProfileCertificate(cert, { domain: DOMAIN, identityKey: cert.subject })).not.toBeNull()
  })

  it('drops a row that is not the exact paymail the user typed', async () => {
    const cert = await mint(key, good())
    expect(await verifyProfileCertificate(cert, { domain: DOMAIN, paymail: `dee2@${DOMAIN}` })).toBeNull()
    expect(await verifyProfileCertificate(cert, { domain: DOMAIN, paymail: `DEE@${DOMAIN}` })).not.toBeNull()
  })

  it('never throws on junk', async () => {
    for (const junk of [null, undefined, 42, 'cert', {}, { fields: null }, { fields: { paymail: 7 } }]) {
      expect(await verifyProfileCertificate(junk, { domain: DOMAIN })).toBeNull()
    }
  })

  // A hostile or broken registry answers up to ten rows per debounced
  // keystroke. One line per reason, then silence — the spec's "logged once".
  it('logs a reason once, however many rows arrive carrying it', async () => {
    const junk = await mint(key, good(), { type: 'd2hhdGV2ZXJ3aGF0ZXZlcndoYXRldmVyd2hhdGV2ZXI=' })
    for (let i = 0; i < 10; i++) expect(await verifyProfileCertificate(junk, { domain: DOMAIN })).toBeNull()
    expect(console.log).toHaveBeenCalledTimes(1)
    // A different reason is a different fact and gets its own line.
    expect(
      await verifyProfileCertificate(await mint(key, { ...good(), released: 'true' }), { domain: DOMAIN })
    ).toBeNull()
    expect(console.log).toHaveBeenCalledTimes(2)
  })
})
```

- [ ] **Step 2: Run it, expect the named failure**

```bash
cd /Users/personal/git/bsv-wallet && npx jest packages/expo-wallet-toolbox/__tests__/identity/handleRegistry/profileCert.test.ts
```

Expected: FAIL — `Cannot find module '../../../core/identity/handleRegistry/profileCert'`.

- [ ] **Step 3: Implement**

Create `packages/expo-wallet-toolbox/core/identity/handleRegistry/profileCert.ts`:

```ts
/**
 * The profile certificate: mint one, and decide whether one handed to us is
 * worth believing.
 *
 * The registry is a directory, not an authority on what a profile says, so
 * every certificate read from any host passes `verifyProfileCertificate`
 * before a single field of it is shown or used. `Certificate.verify()` alone
 * is not that decision: it proves the certificate was signed by the key it
 * NAMES as certifier, which for a self-signed profile is only meaningful once
 * `subject === certifier` has been checked separately — otherwise a third
 * party's well-formed signature over someone else's subject verifies happily.
 *
 * Nothing here touches a network; `client.ts` does that and calls in here.
 */
import { Certificate, Random, Utils, type ProtoWallet } from '@bsv/sdk'
import {
  MAX_CERT_BODY_BYTES,
  MAX_FIELDS,
  MAX_FIELD_NAME_BYTES,
  MAX_FIELD_VALUE_BYTES,
  PROFILE_CERT_TYPE,
  ZERO_OUTPOINT,
  parsePaymail,
  utf8ByteLength
} from './rules'

/** The seven-member BRC-52 wire shape, exactly as the registry serves it. */
export interface ProfileCertJson {
  type: string
  serialNumber: string
  subject: string
  certifier: string
  revocationOutpoint: string
  fields: Record<string, string>
  signature: string
}

/**
 * The two `WalletInterface` methods `Certificate.sign` reaches for.
 *
 * Callers pass the wallet wrapped with `bindOriginator(wallet, adminOriginator)`
 * (core/mandala/createRuntime.ts) so signing the user's own profile never
 * raises a permission prompt.
 *
 * `counterparty` is optional because the SDK never sends one: `Certificate.sign`
 * passes `data`, `protocolID` and `keyID` alone. The wallet's own default of
 * `'anyone'` is what the certificate then verifies against, since
 * `Certificate.verify()` is an `'anyone'` ProtoWallet checking the signature
 * against `certifier`. Declaring it required would describe a contract the SDK
 * does not honour.
 */
export interface ProfileSigner {
  getPublicKey(args: { identityKey: true }, originator?: string): Promise<{ publicKey: string }>
  createSignature(
    args: { data: number[]; protocolID: [number, string]; keyID: string; counterparty?: string },
    originator?: string
  ): Promise<{ signature: number[] }>
}

/** A certificate that passed every rule in the trust model. */
export interface RegistryProfile {
  identityKey: string
  paymail: string
  handle: string
  domain: string
  displayName?: string
  issuedAt: Date
  certificate: ProfileCertJson
}

export async function buildProfileCertificate(args: {
  signer: ProfileSigner
  paymail: string
  issuedAt: Date
  displayName?: string
  released?: boolean
}): Promise<ProfileCertJson> {
  const parsed = parsePaymail(args.paymail)
  if (!parsed) throw new Error(`handleRegistry: not a valid paymail: ${args.paymail}`)
  if (!Number.isFinite(args.issuedAt.getTime())) throw new Error('handleRegistry: issuedAt is not a date')

  const fields: Record<string, string> = {
    paymail: `${parsed.handle}@${parsed.domain}`,
    issuedAt: args.issuedAt.toISOString()
  }
  const displayName = args.displayName?.trim() ?? ''
  if (displayName !== '') fields.displayName = displayName
  if (args.released === true) fields.released = 'true'
  assertWithinLimits(fields)

  const { publicKey } = await args.signer.getPublicKey({ identityKey: true })
  const certificate = new Certificate(
    PROFILE_CERT_TYPE,
    Utils.toBase64(Random(32)),
    publicKey,
    publicKey,
    ZERO_OUTPOINT,
    fields
  )
  // `sign` is typed against ProtoWallet; structurally it needs only the two
  // methods ProfileSigner names, and the wallet this app passes is the
  // originator-bound PermissionsManager, not a ProtoWallet.
  await certificate.sign(args.signer as unknown as ProtoWallet)

  const json: ProfileCertJson = {
    type: certificate.type,
    serialNumber: certificate.serialNumber,
    subject: certificate.subject,
    certifier: certificate.certifier,
    revocationOutpoint: certificate.revocationOutpoint,
    fields: certificate.fields,
    signature: certificate.signature ?? ''
  }
  if (json.signature === '') throw new Error('handleRegistry: signing produced no signature')
  if (utf8ByteLength(JSON.stringify(json)) > MAX_CERT_BODY_BYTES) {
    throw new Error('handleRegistry: certificate exceeds the 16 KB body limit')
  }
  return json
}

/** Refused here rather than at the server, so a too-long name is an immediate
 * message about the field the user is typing, not a 400 two seconds later. */
function assertWithinLimits(fields: Record<string, string>): void {
  const names = Object.keys(fields)
  if (names.length > MAX_FIELDS) throw new Error(`handleRegistry: more than ${MAX_FIELDS} certificate fields`)
  for (const name of names) {
    if (utf8ByteLength(name) >= MAX_FIELD_NAME_BYTES) throw new Error(`handleRegistry: field name too long: ${name}`)
    if (utf8ByteLength(fields[name]) > MAX_FIELD_VALUE_BYTES) {
      throw new Error(`handleRegistry: field value too long: ${name}`)
    }
  }
}

/**
 * The trust model, in order. Answers a profile or null; never throws, because
 * every caller is rendering a list and a bad row is a row to leave out.
 */
export async function verifyProfileCertificate(
  cert: unknown,
  expect: { domain: string; paymail?: string; identityKey?: string }
): Promise<RegistryProfile | null> {
  try {
    const json = asProfileCertJson(cert)
    if (!json) return drop('not a certificate object')
    if (json.type !== PROFILE_CERT_TYPE) return drop('wrong certificate type')
    if (json.subject.toLowerCase() !== json.certifier.toLowerCase()) return drop('subject is not the certifier')
    if (json.revocationOutpoint !== ZERO_OUTPOINT) return drop('revocation outpoint is not the zero outpoint')
    if (utf8ByteLength(JSON.stringify(json)) > MAX_CERT_BODY_BYTES) return drop('over the body limit')

    const names = Object.keys(json.fields)
    if (names.length > MAX_FIELDS) return drop('too many fields')
    for (const name of names) {
      if (utf8ByteLength(name) >= MAX_FIELD_NAME_BYTES) return drop('field name over the limit')
      if (utf8ByteLength(json.fields[name]) > MAX_FIELD_VALUE_BYTES) return drop('field value over the limit')
    }
    if (json.fields.released === 'true') return drop('released')

    const paymail = json.fields.paymail
    if (typeof paymail !== 'string' || paymail !== paymail.trim().toLowerCase()) {
      return drop('paymail is not exact lowercase')
    }
    const parsed = parsePaymail(paymail)
    if (!parsed) return drop('paymail is not handle@domain')
    if (parsed.domain !== expect.domain.trim().toLowerCase()) return drop('paymail is for another domain')
    if (expect.paymail !== undefined && paymail !== expect.paymail.trim().toLowerCase()) {
      return drop('not the paymail that was asked for')
    }
    if (expect.identityKey !== undefined && json.subject.toLowerCase() !== expect.identityKey.trim().toLowerCase()) {
      return drop('not the key that was asked for')
    }

    const issuedAtMs = Date.parse(json.fields.issuedAt ?? '')
    if (!Number.isFinite(issuedAtMs)) return drop('issuedAt is missing or unparseable')

    const verified = await new Certificate(
      json.type,
      json.serialNumber,
      json.subject,
      json.certifier,
      json.revocationOutpoint,
      json.fields,
      json.signature
    ).verify()
    if (!verified) return drop('signature does not verify')

    const displayName = json.fields.displayName?.trim()
    return {
      identityKey: json.subject,
      paymail,
      handle: parsed.handle,
      domain: parsed.domain,
      ...(displayName ? { displayName } : {}),
      issuedAt: new Date(issuedAtMs),
      certificate: json
    }
  } catch (e) {
    return drop(e instanceof Error ? e.message : String(e))
  }
}

/**
 * One line per reason, then silence.
 *
 * A failed certificate is never shown, and a registry serving ten junk rows on
 * every debounced keystroke must not be able to fill the log either — so a
 * reason already reported is not reported again. The set is bounded because the
 * catch branch can feed it arbitrary exception text.
 */
const droppedReasons = new Set<string>()
function drop(why: string): null {
  if (!droppedReasons.has(why) && droppedReasons.size < 32) {
    droppedReasons.add(why)
    console.log('handleRegistry: dropped a profile certificate —', why, '(further reports suppressed)')
  }
  return null
}

/** Test-only: forget which reasons have been reported. */
export function resetDroppedLog(): void {
  droppedReasons.clear()
}

function asProfileCertJson(value: unknown): ProfileCertJson | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Record<string, unknown>
  for (const key of ['type', 'serialNumber', 'subject', 'certifier', 'revocationOutpoint', 'signature'] as const) {
    if (typeof candidate[key] !== 'string') return null
  }
  if (!candidate.fields || typeof candidate.fields !== 'object' || Array.isArray(candidate.fields)) return null
  const fields: Record<string, string> = {}
  for (const [name, fieldValue] of Object.entries(candidate.fields as Record<string, unknown>)) {
    if (typeof fieldValue !== 'string') return null
    fields[name] = fieldValue
  }
  return {
    type: candidate.type as string,
    serialNumber: candidate.serialNumber as string,
    subject: candidate.subject as string,
    certifier: candidate.certifier as string,
    revocationOutpoint: candidate.revocationOutpoint as string,
    fields,
    signature: candidate.signature as string
  }
}
```

- [ ] **Step 4: Run it, expect pass**

```bash
cd /Users/personal/git/bsv-wallet && npx jest packages/expo-wallet-toolbox/__tests__/identity/handleRegistry/profileCert.test.ts
```

Expected: PASS. If `Buffer` is unavailable in the serial-length assertion under `jest-expo`, replace that one line with `expect(Utils.toArray(a.serialNumber, 'base64')).toHaveLength(32)` and import `Utils` in the test — the production module must still not use `Buffer`.

- [ ] **Step 5: Lint and format**

```bash
cd /Users/personal/git/bsv-wallet && npx prettier --check packages/expo-wallet-toolbox/core/identity/handleRegistry/profileCert.ts packages/expo-wallet-toolbox/__tests__/identity/handleRegistry/profileCert.test.ts && npx eslint packages/expo-wallet-toolbox/core/identity/handleRegistry/profileCert.ts packages/expo-wallet-toolbox/__tests__/identity/handleRegistry/profileCert.test.ts
```

Expected: both clean.

---

## Task 3: Host configuration — `handleRegistry`

The package must never read env. The host states the registry per chain, and the getter is fail-closed: a half-stated or malformed entry reads as "no registry on this chain", which the UI already knows how to draw.

Note on scope: `handleCertifier` is **left in place** by this task. Removing it here would break `core/identity/handleCertificate.ts` (which imports `HandleCertifierConfig`) and `ProfileScreen.tsx` (which calls `getHandleCertifierConfig`), neither of which is rewired until Task 8. Task 8 owns the removal.

**Files:**

- Modify: `packages/expo-wallet-toolbox/core/toolboxConfig.ts`
- Modify: `packages/expo-wallet-toolbox/core/index.ts`
- Modify: `/Users/personal/git/bsv-wallet/app/_layout.tsx`
- Modify: `/Users/personal/git/bsv-wallet/eas.json`
- Modify (test): `packages/expo-wallet-toolbox/__tests__/toolboxConfig.test.ts`

**Interfaces — produced here, relied on verbatim by Tasks 5, 6, 8, 9, 11:**

```ts
export interface HandleRegistryConfig {
  domain: string
  url: string
}
export function getHandleRegistryConfig(chain: AppChain): HandleRegistryConfig | undefined
// ToolboxConfig gains:  handleRegistry?: Partial<Record<AppChain, HandleRegistryConfig>>
```

Both are re-exported from `@bsv/expo-wallet-toolbox` (the `core` barrel). `HandleRegistryConfig` is structurally the `RegistryPin` that Tasks 4 and 5 take.

- [ ] **Step 1: Write the failing test**

Append to `packages/expo-wallet-toolbox/__tests__/toolboxConfig.test.ts`, after the `getHandleCertifierConfig` block, and add `getHandleRegistryConfig` to the import list at the top of the file:

```ts
// The registry is a deployment fact this package cannot guess, so an
// unconfigured chain must read as "not available yet" to the Profile screen and
// as "no registry tier" to Pay — never as a crash, and never as a half-usable
// entry pointing at a host that is not the domain's registry.
describe('getHandleRegistryConfig', () => {
  it('is undefined before configureToolbox runs, without throwing', () => {
    expect(getHandleRegistryConfig('main')).toBeUndefined()
  })

  it('is undefined for a chain the host said nothing about', () => {
    configureToolbox({ backupUrl: null })
    expect(getHandleRegistryConfig('main')).toBeUndefined()
  })

  it('lowercases the domain and strips trailing slashes from the url', () => {
    configureToolbox({
      backupUrl: null,
      handleRegistry: { test: { domain: '  Deggen.COM ', url: 'https://messagebox.bsvblockchain.tech///' } }
    })
    expect(getHandleRegistryConfig('test')).toEqual({
      domain: 'deggen.com',
      url: 'https://messagebox.bsvblockchain.tech'
    })
  })

  it.each([
    ['an empty domain', { domain: '', url: 'https://registry.example' }],
    ['a domain with no dot', { domain: 'deggen', url: 'https://registry.example' }],
    ['a domain with a scheme', { domain: 'https://deggen.com', url: 'https://registry.example' }],
    ['an empty url', { domain: 'deggen.com', url: '' }],
    ['a url that is not a url', { domain: 'deggen.com', url: 'registry.example' }],
    ['plain http to a public host', { domain: 'deggen.com', url: 'http://registry.example' }]
  ])('treats %s as no registry at all', (_label, entry) => {
    configureToolbox({ backupUrl: null, handleRegistry: { test: entry } })
    expect(getHandleRegistryConfig('test')).toBeUndefined()
  })

  // Development only: a registry on the machine running the simulator, or on
  // the Android emulator's host alias. Anything public must be https, because
  // which key owns a handle is exactly what TLS is protecting here.
  it.each([
    'http://localhost:8080',
    'http://127.0.0.1:8080',
    'http://10.0.2.2:8080',
    'http://192.168.1.50:8080',
    'http://172.16.4.4:8080'
  ])('allows %s for development', url => {
    configureToolbox({ backupUrl: null, handleRegistry: { test: { domain: 'deggen.com', url } } })
    expect(getHandleRegistryConfig('test')).toEqual({ domain: 'deggen.com', url })
  })

  it('is replaced wholesale with the rest of the configuration', () => {
    configureToolbox({
      backupUrl: null,
      handleRegistry: { test: { domain: 'deggen.com', url: 'https://registry.example' } }
    })
    configureToolbox({ backupUrl: null })
    expect(getHandleRegistryConfig('test')).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run it, expect the named failure**

```bash
cd /Users/personal/git/bsv-wallet && npx jest packages/expo-wallet-toolbox/__tests__/toolboxConfig.test.ts
```

Expected: FAIL — TypeScript/Babel resolves the import but `getHandleRegistryConfig is not a function`, and `handleRegistry` is not a known property of `ToolboxConfig`.

- [ ] **Step 3: Implement the config**

In `core/toolboxConfig.ts`:

**(a)** After the `HandleCertifierConfig` interface (which ends at line 35), insert:

```ts
/** The paymail handle registry this build talks to, for one chain. */
export interface HandleRegistryConfig {
  /** The domain handles live under here, e.g. `deggen.com`. Bare and lowercase. */
  domain: string
  /** Origin of the registry that serves that domain — no trailing slash. */
  url: string
}
```

**(b)** In `interface ToolboxConfig`, after the `handleCertifier` member (line 100), insert:

```ts
  /**
   * The paymail handle registry, per chain: the domain this build's handles
   * live under, and the host that serves it. Both together or neither — a
   * domain with no URL is a registry nothing can reach, and a URL with no
   * domain is a host whose certificates nothing can be checked against.
   *
   * There is deliberately no default. A chain with no complete entry shows
   * the existing "not available yet" copy in Profile and adds no registry tier
   * to Pay's recipient search.
   */
  handleRegistry?: Partial<Record<AppChain, HandleRegistryConfig>>
```

**(c)** In `interface ResolvedConfig`, after `handleCertifier` (line 115), add:

```ts
handleRegistry: Partial<Record<AppChain, HandleRegistryConfig>>
```

**(d)** In `configureToolbox`, after the `handleCertifier: config.handleCertifier ?? {},` line (161), add:

```ts
    handleRegistry: config.handleRegistry ?? {},
```

**(e)** After `getHandleCertifierConfig` (which ends at line 225), insert:

```ts
const REGISTRY_DOMAIN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/
/**
 * Hosts a development build may reach over plain http: the simulator's own
 * machine, the Android emulator's alias for it, and RFC 1918 space. Everything
 * else must be https — which key owns a handle is precisely what a reader on
 * the path would want to change.
 */
const PRIVATE_HOST =
  /^(localhost|127\.0\.0\.1|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/

/**
 * The handle registry for a chain, or undefined when this build has none.
 *
 * Same fail-closed posture as `getMandalaEndpoints`: never throws, and a
 * partial or malformed entry answers undefined rather than a half-usable
 * object. `10.0.2.2` — the Android emulator's route to its host — falls out of
 * the RFC 1918 branch and needs no case of its own.
 */
export function getHandleRegistryConfig(chain: AppChain): HandleRegistryConfig | undefined {
  const entry = current?.handleRegistry[chain]
  if (!entry) return undefined
  const domain = entry.domain?.trim().toLowerCase() ?? ''
  const url = entry.url?.trim().replace(/\/+$/, '') ?? ''
  if (!REGISTRY_DOMAIN.test(domain) || url === '') return undefined
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (parsed.protocol === 'https:') return { domain, url }
  if (parsed.protocol === 'http:' && PRIVATE_HOST.test(parsed.hostname)) return { domain, url }
  return undefined
}
```

- [ ] **Step 4: Export from the barrel**

In `core/index.ts`, in the `export { ... } from './toolboxConfig'` block (lines 30-40), add `getHandleRegistryConfig` after `getMandalaEndpoints`, and extend the type export on line 41 to:

```ts
export type { ToolboxConfig, ToolboxServiceConfig, MandalaEndpointConfig, HandleRegistryConfig } from './toolboxConfig'
```

- [ ] **Step 5: Run it, expect pass**

```bash
cd /Users/personal/git/bsv-wallet && npx jest packages/expo-wallet-toolbox/__tests__/toolboxConfig.test.ts packages/expo-wallet-toolbox/__tests__/packageResolution.test.ts
```

Expected: PASS, including the existing `getHandleCertifierConfig` block, which this task does not touch.

- [ ] **Step 6: Wire the host**

In `/Users/personal/git/bsv-wallet/app/_layout.tsx`, inside the `configureToolbox({ ... })` call, immediately after the closing `},` of the `mandala:` block and before `services:`, insert:

```ts
  // The paymail handle registry, per chain: the domain this build's handles
  // live under and the host that serves it. A chain with no complete entry
  // shows "not available yet" in Profile and adds no registry tier to Pay.
  // The EAS development and dev-physical profiles point both chains at
  // deggen.com served by messagebox.bsvblockchain.tech; production carries
  // neither until a production domain is decided.
  handleRegistry: {
    main: {
      domain: process.env.EXPO_PUBLIC_HANDLE_REGISTRY_DOMAIN ?? '',
      url: process.env.EXPO_PUBLIC_HANDLE_REGISTRY_URL ?? ''
    },
    test: {
      domain: process.env.EXPO_PUBLIC_TEST_HANDLE_REGISTRY_DOMAIN ?? '',
      url: process.env.EXPO_PUBLIC_TEST_HANDLE_REGISTRY_URL ?? ''
    }
  },
```

- [ ] **Step 7: Wire the dev build profiles**

In `/Users/personal/git/bsv-wallet/eas.json`, add these four entries to the `env` block of **both** `build.development` and `build.dev-physical` (profiles do not inherit env from one another). Leave `production` and `preview-apk` untouched.

```json
        "EXPO_PUBLIC_HANDLE_REGISTRY_DOMAIN": "deggen.com",
        "EXPO_PUBLIC_HANDLE_REGISTRY_URL": "https://messagebox.bsvblockchain.tech",
        "EXPO_PUBLIC_TEST_HANDLE_REGISTRY_DOMAIN": "deggen.com",
        "EXPO_PUBLIC_TEST_HANDLE_REGISTRY_URL": "https://messagebox.bsvblockchain.tech"
```

- [ ] **Step 8: Lint and format**

```bash
cd /Users/personal/git/bsv-wallet && npx prettier --check packages/expo-wallet-toolbox/core/toolboxConfig.ts packages/expo-wallet-toolbox/core/index.ts packages/expo-wallet-toolbox/__tests__/toolboxConfig.test.ts app/_layout.tsx eas.json && npx eslint packages/expo-wallet-toolbox/core/toolboxConfig.ts packages/expo-wallet-toolbox/core/index.ts packages/expo-wallet-toolbox/__tests__/toolboxConfig.test.ts app/_layout.tsx
```

Expected: clean.

---

## Task 4: `resolver.ts` — which host answers for a domain

Our own domain is pinned to a configured URL and never touches DNS. Any other domain resolves Paymail-style, which is the only part of this feature that is allowed to reach a third-party host at all — so the DNSSEC rule and the https-only capability rule are load-bearing, not decoration.

**Files:**

- Create: `packages/expo-wallet-toolbox/core/identity/handleRegistry/resolver.ts`
- Create (test): `packages/expo-wallet-toolbox/__tests__/identity/handleRegistry/resolver.test.ts`

**Interfaces — produced here, relied on verbatim by Task 5:**

```ts
export interface RegistryPin {
  readonly domain: string
  readonly url: string
}

export interface RegistryEndpoints {
  readonly domain: string
  search(query: string): string
  reverse(pubkey: string): string
  readonly pinned: boolean
}

export interface RegistryResolver {
  resolve(domain: string): Promise<RegistryEndpoints | null>
  clearCache(): void
}

export const REGISTRY_TIMEOUT_MS: number // 8000
export const RESOLVER_SUCCESS_TTL_MS: number // 600_000
export const RESOLVER_FAILURE_TTL_MS: number // 60_000
export const DOH_ENDPOINTS: readonly string[]

export function fetchWithTimeout(fetchImpl: typeof fetch, url: string, init?: RequestInit): Promise<Response>

export function createRegistryResolver(args: {
  pinned?: RegistryPin
  fetchImpl?: typeof fetch
  now?: () => number
  dohEndpoints?: readonly string[]
}): RegistryResolver
```

Consumes: `rules.ts` (`BRFC_LOOKUP`, `BRFC_REVERSE_LOOKUP`, `looksLikeDomain`).

- [ ] **Step 1: Write the failing test**

Create `packages/expo-wallet-toolbox/__tests__/identity/handleRegistry/resolver.test.ts`:

```ts
import {
  DOH_ENDPOINTS,
  RESOLVER_FAILURE_TTL_MS,
  RESOLVER_SUCCESS_TTL_MS,
  createRegistryResolver
} from '../../../core/identity/handleRegistry/resolver'

const PIN = { domain: 'deggen.com', url: 'https://messagebox.bsvblockchain.tech' }
const OTHER = 'other.example'

const wellKnown = (over: Record<string, unknown> = {}) => ({
  bsvalias: '1.0',
  capabilities: {
    '0ace65da5987': 'https://mb.other.example/api/handle/{query}',
    '43dcf83ddc5f': 'https://mb.other.example/api/identityKey/{pubkey}',
    ...over
  }
})

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response
const notOk = (status: number) => ({ ok: false, status, json: async () => ({}) }) as unknown as Response

const srv = (data: string, over: Record<string, unknown> = {}) => ({
  Status: 0,
  AD: true,
  Answer: [{ name: `_bsvalias._tcp.${OTHER}`, type: 33, data }],
  ...over
})

/** One scripted transport: a list of [urlSubstring, response] rules. */
function transport(rules: [string, () => Promise<Response>][]) {
  const calls: string[] = []
  const fetchImpl = (async (input: string) => {
    calls.push(String(input))
    for (const [needle, make] of rules) if (String(input).includes(needle)) return await make()
    throw new Error(`unexpected request: ${String(input)}`)
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

describe('the pinned domain', () => {
  it('short-circuits: no DNS, no well-known, both routes built from the configured url', async () => {
    const { fetchImpl, calls } = transport([])
    const endpoints = await createRegistryResolver({ pinned: PIN, fetchImpl }).resolve('DEGGEN.com')
    expect(calls).toEqual([])
    expect(endpoints?.pinned).toBe(true)
    expect(endpoints?.domain).toBe('deggen.com')
    expect(endpoints?.search('dee @x')).toBe('https://messagebox.bsvblockchain.tech/api/handle/dee%20%40x')
    expect(endpoints?.reverse('02ab')).toBe('https://messagebox.bsvblockchain.tech/api/identityKey/02ab')
  })
})

describe('a foreign domain', () => {
  it('takes the SRV target when the answer is DNSSEC-authenticated', async () => {
    const { fetchImpl, calls } = transport([
      ['cloudflare-dns.com', async () => ok(srv('10 5 8443 mb.other.example.'))],
      ['/.well-known/bsvalias', async () => ok(wellKnown())]
    ])
    const endpoints = await createRegistryResolver({ pinned: PIN, fetchImpl }).resolve(OTHER)
    expect(calls[0]).toContain(`name=_bsvalias._tcp.${OTHER}`)
    expect(calls[0]).toContain('type=SRV')
    expect(calls[0]).toContain('do=1')
    expect(calls[1]).toBe('https://mb.other.example:8443/.well-known/bsvalias')
    expect(endpoints?.pinned).toBe(false)
    expect(endpoints?.search('dee')).toBe('https://mb.other.example/api/handle/dee')
    expect(endpoints?.reverse('02ab')).toBe('https://mb.other.example/api/identityKey/02ab')
  })

  it('omits the port from the well-known request when it is 443', async () => {
    const { fetchImpl, calls } = transport([
      ['cloudflare-dns.com', async () => ok(srv('10 5 443 mb.other.example.'))],
      ['/.well-known/bsvalias', async () => ok(wellKnown())]
    ])
    await createRegistryResolver({ pinned: PIN, fetchImpl }).resolve(OTHER)
    expect(calls[1]).toBe('https://mb.other.example/.well-known/bsvalias')
  })

  it('prefers the lowest priority, then the highest weight', async () => {
    const { fetchImpl, calls } = transport([
      [
        'cloudflare-dns.com',
        async () =>
          ok({
            Status: 0,
            AD: true,
            Answer: [
              { type: 33, data: '20 100 443 low.other.example.' },
              { type: 33, data: '10 1 443 weak.other.example.' },
              { type: 33, data: '10 9 443 strong.other.example.' }
            ]
          })
      ],
      ['/.well-known/bsvalias', async () => ok(wellKnown())]
    ])
    await createRegistryResolver({ pinned: PIN, fetchImpl }).resolve(OTHER)
    expect(calls[1]).toBe('https://strong.other.example/.well-known/bsvalias')
  })

  it('refuses an unauthenticated SRV that points somewhere else', async () => {
    const { fetchImpl } = transport([
      ['cloudflare-dns.com', async () => ok(srv('10 5 443 mb.other.example.', { AD: false }))]
    ])
    expect(await createRegistryResolver({ pinned: PIN, fetchImpl }).resolve(OTHER)).toBeNull()
  })

  it('accepts an unauthenticated SRV that points at the domain itself — it names no new host', async () => {
    const { fetchImpl } = transport([
      ['cloudflare-dns.com', async () => ok(srv(`10 5 443 ${OTHER}.`, { AD: false }))],
      ['/.well-known/bsvalias', async () => ok(wellKnown())]
    ])
    expect(await createRegistryResolver({ pinned: PIN, fetchImpl }).resolve(OTHER)).not.toBeNull()
  })

  it('falls back to the domain on port 443 for NXDOMAIN', async () => {
    const { fetchImpl, calls } = transport([
      ['cloudflare-dns.com', async () => ok({ Status: 3 })],
      ['/.well-known/bsvalias', async () => ok(wellKnown())]
    ])
    await createRegistryResolver({ pinned: PIN, fetchImpl }).resolve(OTHER)
    expect(calls[1]).toBe(`https://${OTHER}/.well-known/bsvalias`)
  })

  it('falls back the same way when the answer carries no SRV record', async () => {
    const { fetchImpl, calls } = transport([
      ['cloudflare-dns.com', async () => ok({ Status: 0, AD: true, Answer: [{ type: 5, data: 'cname.example.' }] })],
      ['/.well-known/bsvalias', async () => ok(wellKnown())]
    ])
    await createRegistryResolver({ pinned: PIN, fetchImpl }).resolve(OTHER)
    expect(calls[1]).toBe(`https://${OTHER}/.well-known/bsvalias`)
  })

  it('tries Google when Cloudflare is down', async () => {
    const { fetchImpl, calls } = transport([
      [
        'cloudflare-dns.com',
        async () => {
          throw new Error('network down')
        }
      ],
      ['dns.google', async () => ok(srv('10 5 443 mb.other.example.'))],
      ['/.well-known/bsvalias', async () => ok(wellKnown())]
    ])
    expect(await createRegistryResolver({ pinned: PIN, fetchImpl }).resolve(OTHER)).not.toBeNull()
    expect(calls[0]).toContain(DOH_ENDPOINTS[0])
    expect(calls[1]).toContain(DOH_ENDPOINTS[1])
  })

  it('answers null when both resolvers are down', async () => {
    const { fetchImpl } = transport([
      [
        'cloudflare-dns.com',
        async () => {
          throw new Error('down')
        }
      ],
      ['dns.google', async () => notOk(502)]
    ])
    expect(await createRegistryResolver({ pinned: PIN, fetchImpl }).resolve(OTHER)).toBeNull()
  })

  it.each([
    ['a missing lookup capability', { '0ace65da5987': undefined }],
    ['a missing reverse capability', { '43dcf83ddc5f': undefined }],
    ['an http template', { '0ace65da5987': 'http://mb.other.example/api/handle/{query}' }],
    ['a template with no placeholder', { '0ace65da5987': 'https://mb.other.example/api/handle' }]
  ])('answers null for a well-known with %s', async (_label, over) => {
    const { fetchImpl } = transport([
      ['cloudflare-dns.com', async () => ok(srv('10 5 443 mb.other.example.'))],
      ['/.well-known/bsvalias', async () => ok(wellKnown(over))]
    ])
    expect(await createRegistryResolver({ pinned: PIN, fetchImpl }).resolve(OTHER)).toBeNull()
  })

  it('answers null for something that is not a domain, without asking anyone', async () => {
    const { fetchImpl, calls } = transport([])
    expect(await createRegistryResolver({ pinned: PIN, fetchImpl }).resolve('not a domain')).toBeNull()
    expect(calls).toEqual([])
  })
})

describe('caching', () => {
  it('serves a success from cache for ten minutes, then asks again', async () => {
    let clock = 1_000_000
    const { fetchImpl, calls } = transport([
      ['cloudflare-dns.com', async () => ok(srv('10 5 443 mb.other.example.'))],
      ['/.well-known/bsvalias', async () => ok(wellKnown())]
    ])
    const resolver = createRegistryResolver({ pinned: PIN, fetchImpl, now: () => clock })
    await resolver.resolve(OTHER)
    await resolver.resolve(OTHER)
    expect(calls).toHaveLength(2)
    clock += RESOLVER_SUCCESS_TTL_MS
    await resolver.resolve(OTHER)
    expect(calls).toHaveLength(4)
  })

  it('remembers a failure for only a minute', async () => {
    let clock = 1_000_000
    const { fetchImpl, calls } = transport([
      ['cloudflare-dns.com', async () => notOk(500)],
      ['dns.google', async () => notOk(500)]
    ])
    const resolver = createRegistryResolver({ pinned: PIN, fetchImpl, now: () => clock })
    await resolver.resolve(OTHER)
    await resolver.resolve(OTHER)
    expect(calls).toHaveLength(2)
    clock += RESOLVER_FAILURE_TTL_MS
    await resolver.resolve(OTHER)
    expect(calls).toHaveLength(4)
  })

  it('drops everything on clearCache', async () => {
    const { fetchImpl, calls } = transport([
      ['cloudflare-dns.com', async () => ok(srv('10 5 443 mb.other.example.'))],
      ['/.well-known/bsvalias', async () => ok(wellKnown())]
    ])
    const resolver = createRegistryResolver({ pinned: PIN, fetchImpl })
    await resolver.resolve(OTHER)
    resolver.clearCache()
    await resolver.resolve(OTHER)
    expect(calls).toHaveLength(4)
  })
})
```

- [ ] **Step 2: Run it, expect the named failure**

```bash
cd /Users/personal/git/bsv-wallet && npx jest packages/expo-wallet-toolbox/__tests__/identity/handleRegistry/resolver.test.ts
```

Expected: FAIL — `Cannot find module '../../../core/identity/handleRegistry/resolver'`.

- [ ] **Step 3: Implement**

Create `packages/expo-wallet-toolbox/core/identity/handleRegistry/resolver.ts`:

```ts
/**
 * Which host answers for a domain.
 *
 * Our own domain is pinned by configuration: the host was stated by the build,
 * so asking DNS about it would only add a way to be told something else. Every
 * other domain resolves the way Paymail does — DNSSEC-authenticated SRV, then
 * the well-known capability document — because a foreign domain is the one
 * place this feature trusts an answer it did not bring with it.
 *
 * The AD requirement has one exception, and it is not a loophole: an SRV whose
 * target IS the domain names no new host, so an unauthenticated answer moves
 * nothing that `https://<domain>` would not already have reached.
 */
import { BRFC_LOOKUP, BRFC_REVERSE_LOOKUP, looksLikeDomain } from './rules'

/** The domain this build's own handles live under, and the host serving it. */
export interface RegistryPin {
  readonly domain: string
  readonly url: string
}

/** The two routes, already substituted and encoded. */
export interface RegistryEndpoints {
  readonly domain: string
  search(query: string): string
  reverse(pubkey: string): string
  /** True for the configured domain, which skipped discovery entirely. */
  readonly pinned: boolean
}

export interface RegistryResolver {
  resolve(domain: string): Promise<RegistryEndpoints | null>
  /** Test seam, and the way a "try again" control forgets a failed lookup. */
  clearCache(): void
}

export const REGISTRY_TIMEOUT_MS = 8000
export const RESOLVER_SUCCESS_TTL_MS = 10 * 60 * 1000
export const RESOLVER_FAILURE_TTL_MS = 60 * 1000
export const DOH_ENDPOINTS: readonly string[] = ['https://cloudflare-dns.com/dns-query', 'https://dns.google/resolve']

const SRV_TYPE = 33
const NXDOMAIN = 3

/**
 * One attempt, bounded. There is no shared fetch helper in this codebase —
 * every call site hand-rolls this — so this feature's two networking modules
 * share exactly one copy of it rather than two.
 */
export async function fetchWithTimeout(fetchImpl: typeof fetch, url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REGISTRY_TIMEOUT_MS)
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

interface SrvRecord {
  priority: number
  weight: number
  port: number
  target: string
}

interface DohAnswer {
  type?: number
  data?: string
}

interface DohResponse {
  Status?: number
  AD?: boolean
  Answer?: DohAnswer[]
}

function parseSrv(data: string): SrvRecord | null {
  const parts = data.trim().split(/\s+/)
  if (parts.length < 4) return null
  const priority = Number(parts[0])
  const weight = Number(parts[1])
  const port = Number(parts[2])
  const target = parts[3].replace(/\.$/, '').toLowerCase()
  if (!Number.isFinite(priority) || !Number.isFinite(weight) || !Number.isFinite(port) || target === '') return null
  return { priority, weight, port, target }
}

function templateOf(value: unknown, placeholder: string): string | null {
  if (typeof value !== 'string' || !value.startsWith('https://')) return null
  return value.includes(placeholder) ? value : null
}

export function createRegistryResolver(args: {
  pinned?: RegistryPin
  fetchImpl?: typeof fetch
  now?: () => number
  dohEndpoints?: readonly string[]
}): RegistryResolver {
  const fetchImpl = args.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init))
  const now = args.now ?? (() => Date.now())
  const dohEndpoints = args.dohEndpoints ?? DOH_ENDPOINTS
  const pinnedDomain = args.pinned?.domain.trim().toLowerCase() ?? ''
  const pinnedOrigin = args.pinned?.url.trim().replace(/\/+$/, '') ?? ''
  const cache = new Map<string, { at: number; value: RegistryEndpoints | null }>()

  const pinnedEndpoints: RegistryEndpoints | null =
    pinnedDomain !== '' && pinnedOrigin !== ''
      ? {
          domain: pinnedDomain,
          search: query => `${pinnedOrigin}/api/handle/${encodeURIComponent(query)}`,
          reverse: pubkey => `${pinnedOrigin}/api/identityKey/${encodeURIComponent(pubkey)}`,
          pinned: true
        }
      : null

  /** The SRV answer, or the Paymail fallback, or null when DNS said nothing usable. */
  async function lookupSrv(domain: string): Promise<{ target: string; port: number } | null> {
    const fallback = { target: domain, port: 443 }
    for (const endpoint of dohEndpoints) {
      let body: DohResponse
      try {
        const url = `${endpoint}?name=${encodeURIComponent(`_bsvalias._tcp.${domain}`)}&type=SRV&do=1`
        const res = await fetchWithTimeout(fetchImpl, url, { headers: { accept: 'application/dns-json' } })
        if (!res.ok) continue
        body = (await res.json()) as DohResponse
      } catch {
        continue
      }
      const records = (body.Answer ?? [])
        .filter(answer => answer.type === SRV_TYPE && typeof answer.data === 'string')
        .map(answer => parseSrv(answer.data as string))
        .filter((record): record is SrvRecord => record !== null)
      if (body.Status === NXDOMAIN || records.length === 0) return fallback
      records.sort((a, b) => a.priority - b.priority || b.weight - a.weight)
      const best = records[0]
      if (body.AD !== true && best.target !== domain) return null
      return { target: best.target, port: best.port }
    }
    return null
  }

  async function discover(domain: string): Promise<RegistryEndpoints | null> {
    if (!looksLikeDomain(domain)) return null
    const host = await lookupSrv(domain)
    if (!host) return null
    const origin = `https://${host.target}${host.port === 443 ? '' : `:${host.port}`}`
    let capabilities: Record<string, unknown>
    try {
      const res = await fetchWithTimeout(fetchImpl, `${origin}/.well-known/bsvalias`, {
        headers: { accept: 'application/json' }
      })
      if (!res.ok) return null
      const body = (await res.json()) as { capabilities?: Record<string, unknown> }
      capabilities = body?.capabilities ?? {}
    } catch {
      return null
    }
    const searchTemplate = templateOf(capabilities[BRFC_LOOKUP], '{query}')
    const reverseTemplate = templateOf(capabilities[BRFC_REVERSE_LOOKUP], '{pubkey}')
    if (!searchTemplate || !reverseTemplate) return null
    return {
      domain,
      search: query => searchTemplate.replace('{query}', encodeURIComponent(query)),
      reverse: pubkey => reverseTemplate.replace('{pubkey}', encodeURIComponent(pubkey)),
      pinned: false
    }
  }

  return {
    async resolve(rawDomain) {
      const domain = rawDomain.trim().toLowerCase()
      if (pinnedEndpoints && domain === pinnedDomain) return pinnedEndpoints
      const hit = cache.get(domain)
      if (hit && now() - hit.at < (hit.value ? RESOLVER_SUCCESS_TTL_MS : RESOLVER_FAILURE_TTL_MS)) return hit.value
      const value = await discover(domain)
      cache.set(domain, { at: now(), value })
      return value
    },
    clearCache() {
      cache.clear()
    }
  }
}
```

- [ ] **Step 4: Run it, expect pass**

```bash
cd /Users/personal/git/bsv-wallet && npx jest packages/expo-wallet-toolbox/__tests__/identity/handleRegistry/resolver.test.ts
```

Expected: PASS, all describe blocks.

- [ ] **Step 5: Lint and format**

```bash
cd /Users/personal/git/bsv-wallet && npx prettier --check packages/expo-wallet-toolbox/core/identity/handleRegistry/resolver.ts packages/expo-wallet-toolbox/__tests__/identity/handleRegistry/resolver.test.ts && npx eslint packages/expo-wallet-toolbox/core/identity/handleRegistry/resolver.ts packages/expo-wallet-toolbox/__tests__/identity/handleRegistry/resolver.test.ts
```

Expected: clean.

---

## Task 5: `client.ts` — the four routes

Two of these four have contracts inherited from the code they replace and must not be "improved": `search` **throws** (that is how Pay's existing error banner fires), `lookupIdentityKey` **never throws** (that is `resolveIdentity`'s contract). Writes only ever go to the pinned registry.

**Files:**

- Create: `packages/expo-wallet-toolbox/core/identity/handleRegistry/client.ts`
- Create (test): `packages/expo-wallet-toolbox/__tests__/identity/handleRegistry/client.test.ts`

**Interfaces — produced here, relied on verbatim by Tasks 6, 8, 9, 11:**

```ts
export type AvailabilityReason = 'taken' | 'too_similar' | 'reserved' | 'invalid' | 'cooldown'

export type AvailabilityResult =
  | { kind: 'available' }
  | { kind: 'unavailable'; reason: AvailabilityReason }
  | { kind: 'failed' }

export type PutResult =
  | { kind: 'created' }
  | { kind: 'ok' }
  | { kind: 'rejected'; code: string; description: string }
  | { kind: 'failed'; message: string }

/** `none` = the registry answered and holds nothing believable for that key.
 *  `failed` = there was no answer at all. Callers that cache must tell these
 *  apart; callers that only render need `lookupIdentityKey`. */
export type ProfileLookup = { kind: 'found'; profile: RegistryProfile } | { kind: 'none' } | { kind: 'failed' }

export interface HandleRegistryClient {
  readonly domain: string
  checkAvailability(handle: string): Promise<AvailabilityResult>
  putCertificate(cert: ProfileCertJson): Promise<PutResult>
  search(query: string): Promise<RegistryProfile[]> // THROWS on transport failure
  lookupProfile(identityKey: string, domain?: string): Promise<ProfileLookup> // NEVER throws
  lookupIdentityKey(identityKey: string, domain?: string): Promise<RegistryProfile | null> // NEVER throws
  serverNow(): Date
}

export function createHandleRegistryClient(args: {
  pinned: RegistryPin
  fetchImpl?: typeof fetch
  now?: () => number
  resolver?: RegistryResolver
}): HandleRegistryClient
```

Consumes: `rules.ts` (`SEARCH_MIN_QUERY_LENGTH`, `isRoutableSearchQuery`, `isValidHandleFormat`, `looksLikeDomain`), `profileCert.ts` (`ProfileCertJson`, `RegistryProfile`, `verifyProfileCertificate`), `resolver.ts` (`RegistryPin`, `RegistryResolver`, `createRegistryResolver`, `fetchWithTimeout`).

Two normative behaviours land here, both from the trust model:

- **The exact-match rule** (spec "Trust model" §3, server spec "Client verification" §3): when the user typed a complete `handle@domain`, only a row whose `paymail` equals it exactly may be offered. `routeFor` reports that case and `search` then passes `expect.paymail`, so near-misses the server volunteers (its search is a prefix/skeleton/substring search, not an exact one) cannot be shown as "the" match. This is the only production caller of `verifyProfileCertificate`'s `expect.paymail` branch.
- **The server's own query gate**: `routeFor` refuses anything `isRoutableSearchQuery` refuses, so a too-long paste, an accented word or the literal `available` costs no request and — crucially — cannot raise the `identity_search_unavailable` banner off a `400 ERR_INVALID_LOOKUP`.

- [ ] **Step 1: Write the failing test**

Create `packages/expo-wallet-toolbox/__tests__/identity/handleRegistry/client.test.ts`:

```ts
import { PrivateKey, ProtoWallet } from '@bsv/sdk'
import {
  buildProfileCertificate,
  type ProfileCertJson,
  type ProfileSigner
} from '../../../core/identity/handleRegistry/profileCert'
import { createHandleRegistryClient } from '../../../core/identity/handleRegistry/client'
import type { RegistryEndpoints, RegistryResolver } from '../../../core/identity/handleRegistry/resolver'

const PIN = { domain: 'deggen.com', url: 'https://registry.example' }
const KEY = PrivateKey.fromRandom()
const SIGNER = new ProtoWallet(KEY) as unknown as ProfileSigner

let cert: ProfileCertJson
/** Somebody else the server's prefix search will volunteer alongside `cert`. */
let neighbour: ProfileCertJson
beforeAll(async () => {
  cert = await buildProfileCertificate({
    signer: SIGNER,
    paymail: `dee@${PIN.domain}`,
    issuedAt: new Date('2026-09-18T10:00:00.000Z'),
    displayName: 'Dee K'
  })
  neighbour = await buildProfileCertificate({
    signer: new ProtoWallet(PrivateKey.fromRandom()) as unknown as ProfileSigner,
    paymail: `dee2@${PIN.domain}`,
    issuedAt: new Date('2026-09-18T10:00:00.000Z')
  })
})
beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  jest.restoreAllMocks()
})

type Reply = { status: number; body?: unknown; date?: string }
function transport(reply: (url: string, init?: RequestInit) => Reply | Promise<Reply>) {
  const calls: { url: string; init?: RequestInit }[] = []
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    const r = await reply(String(url), init)
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: (name: string) => (name.toLowerCase() === 'date' ? (r.date ?? null) : null) },
      json: async () => r.body
    } as unknown as Response
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

/** A resolver that answers for one foreign domain and nothing else. */
function resolverFor(domain: string, origin: string | null): RegistryResolver {
  return {
    async resolve(asked) {
      if (asked === PIN.domain) {
        return {
          domain: PIN.domain,
          search: q => `${PIN.url}/api/handle/${encodeURIComponent(q)}`,
          reverse: k => `${PIN.url}/api/identityKey/${encodeURIComponent(k)}`,
          pinned: true
        } as RegistryEndpoints
      }
      if (asked !== domain || origin === null) return null
      return {
        domain,
        search: q => `${origin}/api/handle/${encodeURIComponent(q)}`,
        reverse: k => `${origin}/api/identityKey/${encodeURIComponent(k)}`,
        pinned: false
      } as RegistryEndpoints
    },
    clearCache() {}
  }
}

describe('checkAvailability', () => {
  it('refuses a malformed handle locally, with no request at all', async () => {
    const { fetchImpl, calls } = transport(() => ({ status: 200, body: { available: true } }))
    const client = createHandleRegistryClient({ pinned: PIN, fetchImpl })
    expect(await client.checkAvailability('x')).toEqual({ kind: 'unavailable', reason: 'invalid' })
    expect(calls).toEqual([])
  })

  it('asks the pinned registry and reports available', async () => {
    const { fetchImpl, calls } = transport(() => ({ status: 200, body: { available: true } }))
    const client = createHandleRegistryClient({ pinned: PIN, fetchImpl })
    expect(await client.checkAvailability('Dee')).toEqual({ kind: 'available' })
    expect(calls[0].url).toBe('https://registry.example/api/handle/available/dee')
  })

  it.each([
    ['taken', 'taken'],
    ['too_similar', 'too_similar'],
    ['reserved', 'reserved'],
    ['invalid', 'invalid'],
    ['cooldown', 'cooldown'],
    // A released row whose issuedAt has not passed yet is, to the person
    // typing, the same fact as a cooldown: not claimable right now.
    ['stale', 'cooldown']
  ])('maps the server reason %s to %s', async (server, mapped) => {
    const { fetchImpl } = transport(() => ({ status: 200, body: { available: false, reason: server } }))
    const client = createHandleRegistryClient({ pinned: PIN, fetchImpl })
    expect(await client.checkAvailability('dee')).toEqual({ kind: 'unavailable', reason: mapped })
  })

  it('reports failed for an unknown reason, an error status or a dead transport', async () => {
    const unknown = transport(() => ({ status: 200, body: { available: false, reason: 'martian' } }))
    expect(
      await createHandleRegistryClient({ pinned: PIN, fetchImpl: unknown.fetchImpl }).checkAvailability('dee')
    ).toEqual({ kind: 'failed' })
    const server = transport(() => ({ status: 503 }))
    expect(
      await createHandleRegistryClient({ pinned: PIN, fetchImpl: server.fetchImpl }).checkAvailability('dee')
    ).toEqual({ kind: 'failed' })
    const dead = (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    expect(await createHandleRegistryClient({ pinned: PIN, fetchImpl: dead }).checkAvailability('dee')).toEqual({
      kind: 'failed'
    })
  })
})

describe('putCertificate', () => {
  it('PUTs the certificate JSON to the pinned registry', async () => {
    const { fetchImpl, calls } = transport(() => ({ status: 201 }))
    expect(await createHandleRegistryClient({ pinned: PIN, fetchImpl }).putCertificate(cert)).toEqual({
      kind: 'created'
    })
    expect(calls[0].url).toBe('https://registry.example/api/handle')
    expect(calls[0].init?.method).toBe('PUT')
    expect(JSON.parse(String(calls[0].init?.body))).toEqual(cert)
  })

  it('reads 200 as an applied write — an update, a release, or a replay', async () => {
    const { fetchImpl } = transport(() => ({ status: 200 }))
    expect(await createHandleRegistryClient({ pinned: PIN, fetchImpl }).putCertificate(cert)).toEqual({ kind: 'ok' })
  })

  it.each([400, 404, 409, 413])('reads %d as the server answering "no"', async status => {
    const { fetchImpl } = transport(() => ({
      status,
      body: { status: 'error', code: 'ERR_HANDLE_TAKEN', description: 'That handle belongs to another identity key.' }
    }))
    expect(await createHandleRegistryClient({ pinned: PIN, fetchImpl }).putCertificate(cert)).toEqual({
      kind: 'rejected',
      code: 'ERR_HANDLE_TAKEN',
      description: 'That handle belongs to another identity key.'
    })
  })

  it('names the status when the error body is missing or unreadable', async () => {
    const { fetchImpl } = transport(() => ({ status: 400, body: undefined }))
    expect(await createHandleRegistryClient({ pinned: PIN, fetchImpl }).putCertificate(cert)).toEqual({
      kind: 'rejected',
      code: 'ERR_HTTP_400',
      description: 'registry HTTP 400'
    })
  })

  it.each([429, 500, 502])('reads %d as a transport failure, not a refusal', async status => {
    const { fetchImpl } = transport(() => ({ status }))
    const result = await createHandleRegistryClient({ pinned: PIN, fetchImpl }).putCertificate(cert)
    expect(result.kind).toBe('failed')
  })

  it('reads a thrown request as a failure carrying its message', async () => {
    const dead = (async () => {
      throw new Error('socket hang up')
    }) as unknown as typeof fetch
    expect(await createHandleRegistryClient({ pinned: PIN, fetchImpl: dead }).putCertificate(cert)).toEqual({
      kind: 'failed',
      message: 'socket hang up'
    })
  })
})

describe('search', () => {
  it('asks the pinned registry for a bare query and returns only verified rows', async () => {
    const { fetchImpl, calls } = transport(() => ({ status: 200, body: [cert, { junk: true }] }))
    const rows = await createHandleRegistryClient({ pinned: PIN, fetchImpl }).search('dee')
    expect(calls[0].url).toBe('https://registry.example/api/handle/dee')
    expect(rows).toHaveLength(1)
    expect(rows[0].paymail).toBe(`dee@${PIN.domain}`)
    expect(rows[0].displayName).toBe('Dee K')
  })

  it('sends the local part when a domain is being typed and it is a prefix of ours', async () => {
    const { fetchImpl, calls } = transport(() => ({ status: 200, body: [] }))
    const client = createHandleRegistryClient({ pinned: PIN, fetchImpl })
    await client.search('dee@deg')
    await client.search('dee@')
    expect(calls.map(c => c.url)).toEqual([
      'https://registry.example/api/handle/dee',
      'https://registry.example/api/handle/dee'
    ])
  })

  it('resolves a complete foreign domain and asks that registry instead', async () => {
    const { fetchImpl, calls } = transport(() => ({ status: 200, body: [] }))
    const client = createHandleRegistryClient({
      pinned: PIN,
      fetchImpl,
      resolver: resolverFor('other.example', 'https://mb.other.example')
    })
    expect(await client.search('dee@other.example')).toEqual([])
    expect(calls[0].url).toBe('https://mb.other.example/api/handle/dee')
  })

  it('drops a foreign row whose paymail is for a different domain than the one asked', async () => {
    const { fetchImpl } = transport(() => ({ status: 200, body: [cert] }))
    const client = createHandleRegistryClient({
      pinned: PIN,
      fetchImpl,
      resolver: resolverFor('other.example', 'https://mb.other.example')
    })
    expect(await client.search('dee@other.example')).toEqual([])
  })

  it('makes no request at all for a query it cannot route', async () => {
    const { fetchImpl, calls } = transport(() => ({ status: 200, body: [] }))
    const client = createHandleRegistryClient({ pinned: PIN, fetchImpl })
    expect(await client.search('d')).toEqual([])
    expect(await client.search('')).toEqual([])
    expect(await client.search('dee@not a domain')).toEqual([])
    // The server's own gate, restated: over 32 characters, outside
    // [a-z0-9._-], or a path its route table claims for something else.
    expect(await client.search('a'.repeat(33))).toEqual([])
    expect(await client.search('dée')).toEqual([])
    expect(await client.search('available')).toEqual([])
    expect(calls).toEqual([])
  })

  /**
   * Trust model §3: a complete `handle@domain` is a statement about one person,
   * so only that exact row may come back. The server's search is a prefix,
   * skeleton and substring search, so it happily volunteers neighbours.
   */
  it('returns only the exact row when the user typed a complete paymail', async () => {
    const { fetchImpl, calls } = transport(() => ({ status: 200, body: [neighbour, cert] }))
    const rows = await createHandleRegistryClient({ pinned: PIN, fetchImpl }).search(`dee@${PIN.domain}`)
    expect(calls[0].url).toBe('https://registry.example/api/handle/dee')
    expect(rows.map(r => r.paymail)).toEqual([`dee@${PIN.domain}`])
  })

  it('answers nothing at all when the complete paymail the user typed is not among the rows', async () => {
    const { fetchImpl } = transport(() => ({ status: 200, body: [cert, neighbour] }))
    expect(await createHandleRegistryClient({ pinned: PIN, fetchImpl }).search(`deeb@${PIN.domain}`)).toEqual([])
  })

  it('keeps every neighbour while the domain is still being typed', async () => {
    const { fetchImpl } = transport(() => ({ status: 200, body: [cert, neighbour] }))
    const rows = await createHandleRegistryClient({ pinned: PIN, fetchImpl }).search('dee@deg')
    expect(rows.map(r => r.paymail)).toEqual([`dee@${PIN.domain}`, `dee2@${PIN.domain}`])
  })

  it('applies the exact rule to a complete foreign paymail too', async () => {
    const { fetchImpl } = transport(() => ({ status: 200, body: [cert] }))
    const client = createHandleRegistryClient({
      pinned: PIN,
      fetchImpl,
      resolver: resolverFor('other.example', 'https://mb.other.example')
    })
    expect(await client.search('dee@other.example')).toEqual([])
  })

  it('throws on a transport failure, so Pay raises its existing banner', async () => {
    const dead = (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    await expect(createHandleRegistryClient({ pinned: PIN, fetchImpl: dead }).search('dee')).rejects.toThrow('offline')
    const { fetchImpl } = transport(() => ({ status: 500 }))
    await expect(createHandleRegistryClient({ pinned: PIN, fetchImpl }).search('dee')).rejects.toThrow(/HTTP 500/)
  })

  it('throws when a foreign domain has no reachable registry', async () => {
    const { fetchImpl } = transport(() => ({ status: 200, body: [] }))
    const client = createHandleRegistryClient({ pinned: PIN, fetchImpl, resolver: resolverFor('other.example', null) })
    await expect(client.search('dee@other.example')).rejects.toThrow(/no registry for other.example/)
  })
})

describe('lookupIdentityKey', () => {
  it('verifies the answer against the key that was asked for', async () => {
    const { fetchImpl, calls } = transport(() => ({ status: 200, body: cert }))
    const profile = await createHandleRegistryClient({ pinned: PIN, fetchImpl }).lookupIdentityKey(cert.subject)
    expect(calls[0].url).toBe(`https://registry.example/api/identityKey/${cert.subject}`)
    expect(profile?.paymail).toBe(`dee@${PIN.domain}`)
  })

  it('answers null for a 404, a bad answer or a dead transport — never throwing', async () => {
    const missing = transport(() => ({ status: 404, body: { code: 'ERR_HANDLE_NOT_FOUND' } }))
    expect(
      await createHandleRegistryClient({ pinned: PIN, fetchImpl: missing.fetchImpl }).lookupIdentityKey(cert.subject)
    ).toBeNull()
    const wrongKey = transport(() => ({ status: 200, body: cert }))
    const other = PrivateKey.fromRandom().toPublicKey().toString()
    expect(
      await createHandleRegistryClient({ pinned: PIN, fetchImpl: wrongKey.fetchImpl }).lookupIdentityKey(other)
    ).toBeNull()
    const dead = (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    expect(
      await createHandleRegistryClient({ pinned: PIN, fetchImpl: dead }).lookupIdentityKey(cert.subject)
    ).toBeNull()
  })

  it('takes a domain, for a contact whose cached handle is somewhere else', async () => {
    const { fetchImpl, calls } = transport(() => ({ status: 404 }))
    const client = createHandleRegistryClient({
      pinned: PIN,
      fetchImpl,
      resolver: resolverFor('other.example', 'https://mb.other.example')
    })
    await client.lookupIdentityKey(cert.subject, 'other.example')
    expect(calls[0].url).toBe(`https://mb.other.example/api/identityKey/${cert.subject}`)
  })
})

/**
 * `lookupIdentityKey` flattens "there is none" and "there was no answer" into
 * one null, which is right for rendering and wrong for caching: a caller that
 * writes the answer into `contacts.cachedHandle` would blank a contact's handle
 * every time the device is offline. `lookupProfile` is the same request with
 * that distinction kept.
 */
describe('lookupProfile', () => {
  it('reports found with the verified profile', async () => {
    const { fetchImpl } = transport(() => ({ status: 200, body: cert }))
    const result = await createHandleRegistryClient({ pinned: PIN, fetchImpl }).lookupProfile(cert.subject)
    expect(result.kind).toBe('found')
    expect(result.kind === 'found' && result.profile.paymail).toBe(`dee@${PIN.domain}`)
  })

  it('reports none for a 404, and for an answer it cannot believe', async () => {
    const missing = transport(() => ({ status: 404, body: { code: 'ERR_HANDLE_NOT_FOUND' } }))
    expect(
      await createHandleRegistryClient({ pinned: PIN, fetchImpl: missing.fetchImpl }).lookupProfile(cert.subject)
    ).toEqual({ kind: 'none' })
    const wrongKey = transport(() => ({ status: 200, body: cert }))
    const other = PrivateKey.fromRandom().toPublicKey().toString()
    expect(
      await createHandleRegistryClient({ pinned: PIN, fetchImpl: wrongKey.fetchImpl }).lookupProfile(other)
    ).toEqual({ kind: 'none' })
  })

  it('reports failed for a dead transport, a server fault, or a domain with no registry', async () => {
    const dead = (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    expect(await createHandleRegistryClient({ pinned: PIN, fetchImpl: dead }).lookupProfile(cert.subject)).toEqual({
      kind: 'failed'
    })
    const broken = transport(() => ({ status: 503 }))
    expect(
      await createHandleRegistryClient({ pinned: PIN, fetchImpl: broken.fetchImpl }).lookupProfile(cert.subject)
    ).toEqual({ kind: 'failed' })
    const unresolvable = transport(() => ({ status: 200, body: cert }))
    const client = createHandleRegistryClient({
      pinned: PIN,
      fetchImpl: unresolvable.fetchImpl,
      resolver: resolverFor('other.example', null)
    })
    expect(await client.lookupProfile(cert.subject, 'other.example')).toEqual({ kind: 'failed' })
  })
})

describe('serverNow', () => {
  it('is the device clock until a pinned response has been seen', () => {
    const { fetchImpl } = transport(() => ({ status: 200 }))
    const client = createHandleRegistryClient({ pinned: PIN, fetchImpl, now: () => 1_000_000 })
    expect(client.serverNow().getTime()).toBe(1_000_000)
  })

  it('corrects by the skew the pinned registry reported', async () => {
    const device = Date.parse('2026-09-18T10:00:00.000Z')
    const server = 'Fri, 18 Sep 2026 10:01:00 GMT'
    const { fetchImpl } = transport(() => ({ status: 200, body: { available: true }, date: server }))
    const client = createHandleRegistryClient({ pinned: PIN, fetchImpl, now: () => device })
    await client.checkAvailability('dee')
    expect(client.serverNow().toISOString()).toBe('2026-09-18T10:01:00.000Z')
  })

  it('takes no skew from a foreign registry', async () => {
    const device = Date.parse('2026-09-18T10:00:00.000Z')
    const { fetchImpl } = transport(() => ({ status: 200, body: [], date: 'Fri, 18 Sep 2026 23:00:00 GMT' }))
    const client = createHandleRegistryClient({
      pinned: PIN,
      fetchImpl,
      now: () => device,
      resolver: resolverFor('other.example', 'https://mb.other.example')
    })
    await client.search('dee@other.example')
    expect(client.serverNow().getTime()).toBe(device)
  })
})
```

- [ ] **Step 2: Run it, expect the named failure**

```bash
cd /Users/personal/git/bsv-wallet && npx jest packages/expo-wallet-toolbox/__tests__/identity/handleRegistry/client.test.ts
```

Expected: FAIL — `Cannot find module '../../../core/identity/handleRegistry/client'`.

- [ ] **Step 3: Implement**

Create `packages/expo-wallet-toolbox/core/identity/handleRegistry/client.ts`:

```ts
/**
 * The registry's four routes.
 *
 * Two of the four have contracts inherited from the identity code they stand
 * in for, and they are opposites on purpose: `search` THROWS on a transport
 * failure, because Pay's error banner is raised from a catch and an empty
 * array would read as "nobody by that name"; `lookupIdentityKey` NEVER throws,
 * because an unknown peer and an unreachable registry get the same UI and a
 * profile lookup may never be the reason a screen fails to render.
 *
 * Writes only ever go to the pinned registry — a foreign domain is somewhere
 * to read from, never somewhere to publish to — and the clock skew that
 * `serverNow` corrects by is only ever taken from a pinned response, for the
 * same reason.
 */
import { SEARCH_MIN_QUERY_LENGTH, isRoutableSearchQuery, isValidHandleFormat, looksLikeDomain } from './rules'
import { verifyProfileCertificate, type ProfileCertJson, type RegistryProfile } from './profileCert'
import { createRegistryResolver, fetchWithTimeout, type RegistryPin, type RegistryResolver } from './resolver'

/** Why a handle is not free. The server's `stale` arrives as `cooldown`. */
export type AvailabilityReason = 'taken' | 'too_similar' | 'reserved' | 'invalid' | 'cooldown'

export type AvailabilityResult =
  | { kind: 'available' }
  | { kind: 'unavailable'; reason: AvailabilityReason }
  | { kind: 'failed' }

/** `rejected` is the server answering no; `failed` is not having an answer. */
export type PutResult =
  | { kind: 'created' }
  | { kind: 'ok' }
  | { kind: 'rejected'; code: string; description: string }
  | { kind: 'failed'; message: string }

/**
 * `none` means the registry answered and holds nothing believable for that key;
 * `failed` means there was no answer at all. A caller that only renders can
 * flatten both to "no handle" — `lookupIdentityKey` does. A caller that WRITES
 * the answer into a cache cannot: blanking a contact's handle because the
 * device happened to be offline is the opposite of a cache.
 */
export type ProfileLookup = { kind: 'found'; profile: RegistryProfile } | { kind: 'none' } | { kind: 'failed' }

export interface HandleRegistryClient {
  /** The pinned domain: what a bare handle is registered under. */
  readonly domain: string
  checkAvailability(handle: string): Promise<AvailabilityResult>
  putCertificate(cert: ProfileCertJson): Promise<PutResult>
  /** Throws on transport failure — the contract `searchIdentities` already has. */
  search(query: string): Promise<RegistryProfile[]>
  /** Never throws. The full verdict, for callers that cache the answer. */
  lookupProfile(identityKey: string, domain?: string): Promise<ProfileLookup>
  /** Never throws — the contract `resolveIdentity` already has. */
  lookupIdentityKey(identityKey: string, domain?: string): Promise<RegistryProfile | null>
  /** The device clock, corrected by the skew the pinned registry last reported. */
  serverNow(): Date
}

function reasonOf(raw: unknown): AvailabilityReason | null {
  switch (raw) {
    case 'taken':
    case 'too_similar':
    case 'reserved':
    case 'invalid':
    case 'cooldown':
      return raw
    // A released row whose stored issuedAt has not passed yet: a certificate
    // dated now cannot beat it, so to the person typing this is a cooldown.
    case 'stale':
      return 'cooldown'
    default:
      return null
  }
}

export function createHandleRegistryClient(args: {
  pinned: RegistryPin
  fetchImpl?: typeof fetch
  now?: () => number
  resolver?: RegistryResolver
}): HandleRegistryClient {
  const fetchImpl = args.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init))
  const now = args.now ?? (() => Date.now())
  const domain = args.pinned.domain.trim().toLowerCase()
  const origin = args.pinned.url.trim().replace(/\/+$/, '')
  const resolver = args.resolver ?? createRegistryResolver({ pinned: args.pinned, fetchImpl, now })
  let skewMs = 0

  /** Only ever from the registry we write to: a foreign host's clock is not
   * the one our `issuedAt` has to beat. */
  function notePinnedSkew(res: Response): void {
    const header = res.headers?.get?.('date')
    const at = header ? Date.parse(header) : NaN
    if (Number.isFinite(at)) skewMs = at - now()
  }

  async function errorBody(res: Response): Promise<{ code: string; description: string }> {
    try {
      const body = (await res.json()) as { code?: unknown; description?: unknown }
      return {
        code: typeof body?.code === 'string' ? body.code : `ERR_HTTP_${res.status}`,
        description: typeof body?.description === 'string' ? body.description : `registry HTTP ${res.status}`
      }
    } catch {
      return { code: `ERR_HTTP_${res.status}`, description: `registry HTTP ${res.status}` }
    }
  }

  /**
   * Which registry answers this query, what to send it, and whether the user
   * typed a complete address rather than a fragment.
   *
   * `paymail` is set only for a complete `handle@domain`. The trust model then
   * requires that only a row with exactly that paymail be offered — the
   * server's search is a prefix, skeleton and substring search, so without this
   * a typed `dee@deggen.com` would be answered with `dee2`, `deeanna` and a
   * look-alike, any of which the user might take for the person they named.
   *
   * `isRoutableSearchQuery` is the server's own gate restated: over 32
   * characters, outside `[a-z0-9._-]`, or a path its route table claims (the
   * literal `available`, which answers `400 ERR_INVALID_LOOKUP` and would
   * otherwise surface as an outage) costs no request at all.
   */
  function routeFor(raw: string): { domain: string; query: string; paymail?: string } | null {
    const text = raw.trim().toLowerCase()
    const at = text.indexOf('@')
    if (at < 0) return isRoutableSearchQuery(text) ? { domain, query: text } : null
    const local = text.slice(0, at)
    const typed = text.slice(at + 1)
    if (local.length < SEARCH_MIN_QUERY_LENGTH || !isRoutableSearchQuery(local)) return null
    // A domain still being typed is a prefix of ours: still our registry, and
    // still a fragment — the user has not finished naming anybody yet.
    if (domain.startsWith(typed)) {
      const complete = typed === domain && isValidHandleFormat(local)
      return { domain, query: local, ...(complete ? { paymail: `${local}@${domain}` } : {}) }
    }
    if (!looksLikeDomain(typed)) return null
    const complete = isValidHandleFormat(local)
    return { domain: typed, query: local, ...(complete ? { paymail: `${local}@${typed}` } : {}) }
  }

  /** A free function rather than a method: `lookupIdentityKey` delegates to it,
   * and a destructured `const { lookupIdentityKey } = client` must still work. */
  async function lookupProfile(identityKey: string, forDomain?: string): Promise<ProfileLookup> {
    const key = identityKey.trim().toLowerCase()
    const target = (forDomain ?? domain).trim().toLowerCase()
    try {
      const endpoints = await resolver.resolve(target)
      if (!endpoints) return { kind: 'failed' }
      const res = await fetchWithTimeout(fetchImpl, endpoints.reverse(key), {
        headers: { accept: 'application/json' }
      })
      if (endpoints.pinned) notePinnedSkew(res)
      // Only a 404 is the registry saying "this key holds nothing". Every other
      // refusal is the registry not having answered the question at all, and a
      // caller that caches the answer has to be able to tell those apart.
      if (res.status === 404) return { kind: 'none' }
      if (!res.ok) return { kind: 'failed' }
      const profile = await verifyProfileCertificate(await res.json(), { domain: target, identityKey: key })
      return profile ? { kind: 'found', profile } : { kind: 'none' }
    } catch {
      return { kind: 'failed' }
    }
  }

  return {
    domain,

    async checkAvailability(handle) {
      const wanted = handle.trim().toLowerCase()
      // Checked here first so a half-typed handle costs no request and gets an
      // answer on the keystroke rather than after the round trip.
      if (!isValidHandleFormat(wanted)) return { kind: 'unavailable', reason: 'invalid' }
      try {
        const res = await fetchWithTimeout(fetchImpl, `${origin}/api/handle/available/${encodeURIComponent(wanted)}`, {
          headers: { accept: 'application/json' }
        })
        notePinnedSkew(res)
        if (!res.ok) return { kind: 'failed' }
        const body = (await res.json()) as { available?: unknown; reason?: unknown }
        if (body?.available === true) return { kind: 'available' }
        const reason = reasonOf(body?.reason)
        return reason ? { kind: 'unavailable', reason } : { kind: 'failed' }
      } catch {
        return { kind: 'failed' }
      }
    },

    async putCertificate(cert) {
      let res: Response
      try {
        res = await fetchWithTimeout(fetchImpl, `${origin}/api/handle`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(cert)
        })
      } catch (e) {
        return { kind: 'failed', message: e instanceof Error ? e.message : String(e) }
      }
      notePinnedSkew(res)
      if (res.status === 201) return { kind: 'created' }
      if (res.status === 200) return { kind: 'ok' }
      // Rate limiting and a server fault are both "ask again later"; every
      // other status is the registry having read the certificate and refused.
      if (res.status === 429 || res.status >= 500) return { kind: 'failed', message: `registry HTTP ${res.status}` }
      const { code, description } = await errorBody(res)
      return { kind: 'rejected', code, description }
    },

    async search(query) {
      const route = routeFor(query)
      if (!route) return []
      const endpoints = await resolver.resolve(route.domain)
      if (!endpoints) throw new Error(`handleRegistry: no registry for ${route.domain}`)
      const res = await fetchWithTimeout(fetchImpl, endpoints.search(route.query), {
        headers: { accept: 'application/json' }
      })
      if (endpoints.pinned) notePinnedSkew(res)
      if (!res.ok) throw new Error(`handleRegistry: search failed with HTTP ${res.status}`)
      const body = (await res.json()) as unknown
      if (!Array.isArray(body)) return []
      const verified = await Promise.all(
        // `expect.paymail` is what enforces "a complete address names one
        // person": set, every other row the server volunteered is dropped.
        body.map(row =>
          verifyProfileCertificate(row, { domain: route.domain, ...(route.paymail ? { paymail: route.paymail } : {}) })
        )
      )
      return verified.filter((profile): profile is RegistryProfile => profile !== null)
    },

    lookupProfile,

    async lookupIdentityKey(identityKey, forDomain) {
      const result = await lookupProfile(identityKey, forDomain)
      return result.kind === 'found' ? result.profile : null
    },

    serverNow() {
      return new Date(now() + skewMs)
    }
  }
}
```

- [ ] **Step 4: Run it, expect pass**

```bash
cd /Users/personal/git/bsv-wallet && npx jest packages/expo-wallet-toolbox/__tests__/identity/handleRegistry/client.test.ts
```

Expected: PASS.

- [ ] **Step 5: Lint and format**

```bash
cd /Users/personal/git/bsv-wallet && npx prettier --check packages/expo-wallet-toolbox/core/identity/handleRegistry/client.ts packages/expo-wallet-toolbox/__tests__/identity/handleRegistry/client.test.ts && npx eslint packages/expo-wallet-toolbox/core/identity/handleRegistry/client.ts packages/expo-wallet-toolbox/__tests__/identity/handleRegistry/client.test.ts
```

Expected: clean.

---

## Task 6: `registration.ts` — every write, journaled

The whole stability checklist lives here. Certificates are signed and written to the journal **before** the first request, so a retry re-sends identical bytes the server treats as a no-op (`200`) — which is what makes a crash, a double tap and a timeout-after-success all the same event.

One deliberate divergence from the spec's journal shape: it also carries `intent`, because `resumePending` has to report `registered` / `updated` / `changed` for a run it did not start and cannot otherwise tell apart. Nothing has shipped, so `v` stays `1`.

Two hazards in the stability table need more than the spec's one line each, and both are settled here:

- **A device clock that is _ahead_.** `serverNow()` is the raw device clock until a pinned response has been seen, so the very first write from a phone an hour fast mints `issuedAt = now + 1h`, which the server refuses outright (`pkg/profilecert/profilecert.go:132` — more than `MaxClockSkew` = 5 minutes ahead is `400 ERR_INVALID_CERTIFICATE`). Flooring alone then makes that permanent: the rejected value is already the stored high-water mark, so every later attempt re-floors at `stored + 1 ms` and is refused again, for good. `nextIssuedAt` therefore has a **ceiling** as well as a floor, and discards a stored mark that is itself beyond the ceiling — such a mark can only have come from a clock the server would never have accepted, so no certificate dated that far ahead can exist to be stale against. The rejected PUT's own response corrects the skew, so the second attempt lands.
- **Two _different_ intents at once.** The shared in-flight promise is keyed. An identical repeat (a double tap, a second mounted Profile screen) joins the run that is already going; a different intent — the mount's `resumePending` still in flight when the user taps Claim — **queues behind it** instead of silently receiving the other run's answer and minting nothing.

**Files:**

- Create: `packages/expo-wallet-toolbox/core/identity/handleRegistry/registration.ts`
- Create (test): `packages/expo-wallet-toolbox/__tests__/identity/handleRegistry/registration.test.ts`

**Interfaces — produced here, relied on verbatim by Task 8:**

```ts
export const PENDING_JOURNAL_KEY: string // 'profile_handle_pending'
export const ISSUED_AT_KV_KEY: string // 'profile_handle_issued_at'
export const MAX_ISSUED_AT_LEAD_MS: number // 240_000 — inside the server's 5-minute MaxClockSkew

export interface RegistrationStorage {
  getKeyValue(key: string): Promise<string | undefined>
  setKeyValue(key: string, value: string): Promise<void>
}

export type RegistrationIntent = 'register' | 'update' | 'change'
export interface PendingStep {
  kind: 'release' | 'claim'
  paymail: string
  cert: ProfileCertJson
}
export interface PendingJournal {
  v: 1
  intent: RegistrationIntent
  steps: PendingStep[]
  previousPaymail?: string
  startedAt: string
}

export type RegistrationResult =
  | { kind: 'registered'; paymail: string }
  | { kind: 'updated'; paymail: string }
  | { kind: 'changed'; paymail: string }
  | { kind: 'rolled_back'; paymail: string }
  | { kind: 'pending' }
  | { kind: 'rejected'; code: string; description: string }
  | { kind: 'failed'; message: string }
  | { kind: 'unavailable' }
  | { kind: 'idle' }

export interface RegistrationDeps {
  client: HandleRegistryClient | null
  signer: ProfileSigner
  storage: RegistrationStorage
}

export function registerHandle(
  deps: RegistrationDeps,
  args: { handle: string; displayName?: string }
): Promise<RegistrationResult>
export function updateProfile(
  deps: RegistrationDeps,
  args: { paymail: string; displayName?: string }
): Promise<RegistrationResult>
export function changeHandle(
  deps: RegistrationDeps,
  args: { previousPaymail: string; handle: string; displayName?: string }
): Promise<RegistrationResult>
export function resumePending(deps: RegistrationDeps): Promise<RegistrationResult>
export function resetRegistrationState(): void // test-only: forget the shared run
```

`RegistrationStorage` is satisfied structurally by `StorageExpoSQLite` (`getKeyValue`/`setKeyValue`, `core/storage/StorageExpoSQLite.ts:234,242`).

Consumes: `rules.ts`, `profileCert.ts`, `client.ts`.

- [ ] **Step 1: Write the failing test**

Create `packages/expo-wallet-toolbox/__tests__/identity/handleRegistry/registration.test.ts`:

```ts
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

/** A client whose answers are a script, so the resume matrix is exact. */
function scriptedClient(script: {
  put?: (cert: ProfileCertJson, call: number) => PutResult
  reverse?: () => RegistryProfile | null
  serverNow?: Date
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
      const profile = script.reverse ? script.reverse() : null
      return profile ? { kind: 'found', profile } : { kind: 'none' }
    },
    async lookupIdentityKey() {
      reverseCalls += 1
      return script.reverse ? script.reverse() : null
    },
    serverNow() {
      return script.serverNow ?? new Date('2026-09-18T10:00:00.000Z')
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
    const storage = memoryStorage({ [ISSUED_AT_KV_KEY]: '2026-09-18T12:00:00.000Z' })
    await registerHandle({ client, signer: SIGNER, storage }, { handle: 'dee' })
    resetRegistrationState()
    await registerHandle({ client, signer: SIGNER, storage }, { handle: 'dee' })
    expect(puts[0].fields.issuedAt).toBe('2026-09-18T12:00:00.001Z')
    expect(puts[1].fields.issuedAt).toBe('2026-09-18T12:00:00.002Z')
    expect(storage.map.get(ISSUED_AT_KV_KEY)).toBe('2026-09-18T12:00:00.002Z')
  })

  it('takes the corrected server time when it is ahead of the stored value', async () => {
    const { client, puts } = scriptedClient({ serverNow: new Date('2026-09-18T15:00:00.000Z') })
    const storage = memoryStorage({ [ISSUED_AT_KV_KEY]: '2026-09-18T12:00:00.000Z' })
    await registerHandle({ client, signer: SIGNER, storage }, { handle: 'dee' })
    expect(puts[0].fields.issuedAt).toBe('2026-09-18T15:00:00.000Z')
  })

  it('never dates a certificate further ahead than the server will accept', async () => {
    const { client, puts } = scriptedClient({ serverNow: new Date('2026-09-18T10:00:00.000Z') })
    // A mark left by a clock that was hours fast. Honouring it would mint
    // another certificate the server refuses, for ever.
    const storage = memoryStorage({ [ISSUED_AT_KV_KEY]: '2026-09-18T11:00:00.000Z' })
    await registerHandle({ client, signer: SIGNER, storage }, { handle: 'dee' })
    expect(puts[0].fields.issuedAt).toBe('2026-09-18T10:04:00.000Z')
    expect(Date.parse(puts[0].fields.issuedAt) - Date.parse('2026-09-18T10:00:00.000Z')).toBe(MAX_ISSUED_AT_LEAD_MS)
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
    expect(corrected.puts[0].fields.issuedAt).toBe('2026-09-18T10:04:00.000Z')
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
    const applied: RegistryProfile = {
      identityKey: KEY.toPublicKey().toString(),
      paymail: `dee@${DOMAIN}`,
      handle: 'dee',
      domain: DOMAIN,
      issuedAt: new Date('2026-09-18T09:00:00.000Z'),
      certificate: {} as ProfileCertJson
    }
    const { client } = scriptedClient({
      put: () => ({ kind: 'rejected', code: 'ERR_STALE_CERTIFICATE', description: 'stale' }),
      reverse: () => applied
    })
    const storage = memoryStorage()
    expect(await registerHandle({ client, signer: SIGNER, storage }, { handle: 'dee' })).toEqual({
      kind: 'registered',
      paymail: `dee@${DOMAIN}`
    })
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

  it('ignores a journal it cannot read', async () => {
    const { client, puts } = scriptedClient({})
    const storage = memoryStorage({ [PENDING_JOURNAL_KEY]: '{not json' })
    expect(await resumePending({ client, signer: SIGNER, storage })).toEqual({ kind: 'idle' })
    expect(puts).toHaveLength(0)
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
})
```

- [ ] **Step 2: Run it, expect the named failure**

```bash
cd /Users/personal/git/bsv-wallet && npx jest packages/expo-wallet-toolbox/__tests__/identity/handleRegistry/registration.test.ts
```

Expected: FAIL — `Cannot find module '../../../core/identity/handleRegistry/registration'`.

- [ ] **Step 3: Implement**

Create `packages/expo-wallet-toolbox/core/identity/handleRegistry/registration.ts`:

```ts
/**
 * Every write to the registry, and the journal that makes each one idempotent.
 *
 * The order is the whole design: a certificate is signed and written to
 * `key_value_store` BEFORE the first request, so a retry after a crash, a
 * double tap or a timeout re-sends the identical bytes — which the registry
 * treats as a no-op `200` rather than a second claim. That is why "the write
 * landed but the response was lost" and "the write never landed" do not have
 * to be told apart here: replaying settles both.
 *
 * `issuedAt` is the registry's replay guard, so it has to beat every value this
 * device has already minted (a clock that jumped backwards would otherwise
 * mint a certificate the server calls stale) while never running away from the
 * server's own clock (more than five minutes ahead is refused outright). The
 * corrected `serverNow` handles the second; the stored high-water mark, the
 * first.
 */
import { parsePaymail } from './rules'
import { buildProfileCertificate, type ProfileCertJson, type ProfileSigner } from './profileCert'
import type { HandleRegistryClient } from './client'

/** The in-flight journal. One at a time; a second intent replaces it. */
export const PENDING_JOURNAL_KEY = 'profile_handle_pending'
/** The highest `issuedAt` this device has ever minted. */
export const ISSUED_AT_KV_KEY = 'profile_handle_issued_at'
/**
 * How far ahead of the registry's own clock an `issuedAt` may be dated. The
 * server refuses anything past five minutes (`profilecert.MaxClockSkew`); four
 * leaves room for the request to arrive.
 */
export const MAX_ISSUED_AT_LEAD_MS = 240_000

/** Structurally satisfied by `StorageExpoSQLite`. */
export interface RegistrationStorage {
  getKeyValue(key: string): Promise<string | undefined>
  setKeyValue(key: string, value: string): Promise<void>
}

export type RegistrationIntent = 'register' | 'update' | 'change'

export interface PendingStep {
  kind: 'release' | 'claim'
  paymail: string
  cert: ProfileCertJson
}

/**
 * `intent` is not in the design's journal shape. `resumePending` runs a journal
 * it did not start and still has to say which of registered/updated/changed
 * happened, and no combination of the other fields tells those apart. Nothing
 * has shipped, so the version stays 1.
 */
export interface PendingJournal {
  v: 1
  intent: RegistrationIntent
  steps: PendingStep[]
  previousPaymail?: string
  startedAt: string
}

export type RegistrationResult =
  | { kind: 'registered'; paymail: string }
  | { kind: 'updated'; paymail: string }
  | { kind: 'changed'; paymail: string }
  | { kind: 'rolled_back'; paymail: string }
  | { kind: 'pending' }
  | { kind: 'rejected'; code: string; description: string }
  | { kind: 'failed'; message: string }
  | { kind: 'unavailable' }
  | { kind: 'idle' }

export interface RegistrationDeps {
  /** null when this chain has no registry configured. */
  client: HandleRegistryClient | null
  signer: ProfileSigner
  storage: RegistrationStorage
}

/**
 * One run at a time, and the key is what makes that safe.
 *
 * Two mounted Profile screens or a double tap ask for the SAME thing, and the
 * second caller should get the first caller's answer rather than mint a second
 * certificate. Two DIFFERENT intents are not interchangeable: the mount's
 * `resumePending` is routinely still in flight when the user taps Claim, and
 * handing the claim the resume's `{kind:'idle'}` would spin the button, send
 * nothing, and leave the user with no handle and no explanation. A different
 * key therefore queues behind the run in progress instead of joining it.
 */
let inFlight: { key: string; promise: Promise<RegistrationResult> } | null = null

function share(key: string, run: () => Promise<RegistrationResult>): Promise<RegistrationResult> {
  if (inFlight?.key === key) return inFlight.promise
  const previous = inFlight?.promise
  const promise = (async () => {
    // Never reject on the predecessor's behalf: every entry point already
    // answers a result rather than throwing, and a rejection here would be
    // this caller's request never having been attempted.
    if (previous) await previous.catch(() => undefined)
    return await run()
  })()
  const entry = { key, promise }
  inFlight = entry
  // `then(clear, clear)` rather than `finally`: an ignored `finally` chain
  // would re-raise a rejection nobody is listening to.
  const clear = () => {
    if (inFlight === entry) inFlight = null
  }
  void promise.then(clear, clear)
  return promise
}

/** Test-only: forget the shared run between cases. */
export function resetRegistrationState(): void {
  inFlight = null
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

async function readJournal(storage: RegistrationStorage): Promise<PendingJournal | null> {
  const raw = await storage.getKeyValue(PENDING_JOURNAL_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as PendingJournal
    if (parsed?.v !== 1 || !Array.isArray(parsed.steps) || parsed.steps.length === 0) return null
    return parsed
  } catch {
    return null
  }
}

/** `setKeyValue('')` rather than a delete: the store has no delete, and an
 * empty string reads back as "no journal" everywhere it is checked. */
async function clearJournal(storage: RegistrationStorage): Promise<void> {
  await storage.setKeyValue(PENDING_JOURNAL_KEY, '')
}

async function writeJournal(storage: RegistrationStorage, journal: PendingJournal): Promise<void> {
  await storage.setKeyValue(PENDING_JOURNAL_KEY, JSON.stringify(journal))
}

/**
 * Strictly after everything this device has minted, at least the server's own
 * idea of now, and never so far ahead that the server refuses it.
 *
 * Stored before it is used, so a crash between minting and sending cannot let
 * the next attempt repeat the value — the registry compares `issuedAt` AND
 * `serialNumber`, and an equal `issuedAt` under a fresh serial is stale.
 *
 * The ceiling is what keeps a fast clock from being permanent. A phone an hour
 * ahead mints `now + 1h` on its first write, the server refuses it, and that
 * refused value is already the stored high-water mark; flooring alone would
 * re-mint `+1h` for ever. A mark beyond the ceiling cannot correspond to any
 * certificate the server accepted, so it is discarded rather than honoured —
 * and by then the refused response has corrected `serverNow`'s skew, so the
 * next attempt is inside the window.
 */
async function nextIssuedAt(deps: RegistrationDeps, client: HandleRegistryClient, after?: Date): Promise<Date> {
  const serverMs = client.serverNow().getTime()
  const ceiling = serverMs + MAX_ISSUED_AT_LEAD_MS
  const stored = Date.parse((await deps.storage.getKeyValue(ISSUED_AT_KV_KEY)) ?? '')
  const mark = Number.isFinite(stored) && stored < ceiling ? stored + 1 : 0
  const at = new Date(Math.min(Math.max(serverMs, mark, after ? after.getTime() + 1 : 0), ceiling))
  await deps.storage.setKeyValue(ISSUED_AT_KV_KEY, at.toISOString())
  return at
}

/** Whether the registry already shows the world this step was trying to make. */
async function alreadyApplied(client: HandleRegistryClient, step: PendingStep): Promise<boolean> {
  const mine = await client.lookupIdentityKey(step.cert.subject)
  if (step.kind === 'claim') return mine?.paymail === step.paymail
  return mine === null || mine.paymail !== step.paymail
}

async function runJournal(
  deps: RegistrationDeps,
  client: HandleRegistryClient,
  journal: PendingJournal
): Promise<RegistrationResult> {
  for (let i = 0; i < journal.steps.length; i++) {
    const step = journal.steps[i]
    const outcome = await client.putCertificate(step.cert)
    if (outcome.kind === 'created' || outcome.kind === 'ok') continue
    // No answer: the journal stays, and the next mount or an explicit retry
    // re-sends the same bytes.
    if (outcome.kind === 'failed') return { kind: 'pending' }
    if (outcome.code === 'ERR_STALE_CERTIFICATE') {
      if (await alreadyApplied(client, step)) continue
      // Replaying a certificate the registry calls stale can never win, so
      // keeping the journal would only retry it on every mount, forever.
      await clearJournal(deps.storage)
      return { kind: 'failed', message: outcome.description }
    }
    // The new handle went to somebody else between our release and our claim.
    if (step.kind === 'claim' && i > 0 && journal.previousPaymail) {
      return await rollBack(deps, client, journal.previousPaymail)
    }
    await clearJournal(deps.storage)
    return { kind: 'rejected', code: outcome.code, description: outcome.description }
  }
  await clearJournal(deps.storage)
  const paymail = journal.steps[journal.steps.length - 1].paymail
  if (journal.intent === 'update') return { kind: 'updated', paymail }
  if (journal.intent === 'change') return { kind: 'changed', paymail }
  return { kind: 'registered', paymail }
}

/**
 * Put the user back where they were. The previous owner is exempt from the
 * cooldown on a handle they released themselves, so this claim is one the
 * registry will accept.
 */
async function rollBack(
  deps: RegistrationDeps,
  client: HandleRegistryClient,
  previousPaymail: string
): Promise<RegistrationResult> {
  try {
    const issuedAt = await nextIssuedAt(deps, client)
    const cert = await buildProfileCertificate({ signer: deps.signer, paymail: previousPaymail, issuedAt })
    await writeJournal(deps.storage, {
      v: 1,
      intent: 'change',
      steps: [{ kind: 'claim', paymail: previousPaymail, cert }],
      previousPaymail,
      startedAt: issuedAt.toISOString()
    })
    const outcome = await client.putCertificate(cert)
    if (outcome.kind === 'failed') return { kind: 'pending' }
    await clearJournal(deps.storage)
    if (outcome.kind === 'rejected') return { kind: 'rejected', code: outcome.code, description: outcome.description }
    return { kind: 'rolled_back', paymail: previousPaymail }
  } catch (e) {
    await clearJournal(deps.storage)
    return { kind: 'failed', message: messageOf(e) }
  }
}

export function registerHandle(
  deps: RegistrationDeps,
  args: { handle: string; displayName?: string }
): Promise<RegistrationResult> {
  return share(`register:${args.handle.trim().toLowerCase()}:${args.displayName?.trim() ?? ''}`, async () => {
    const client = deps.client
    if (!client) return { kind: 'unavailable' }
    try {
      const paymail = `${args.handle.trim().toLowerCase()}@${client.domain}`
      if (!parsePaymail(paymail))
        return { kind: 'failed', message: `handleRegistry: not a valid handle: ${args.handle}` }
      const issuedAt = await nextIssuedAt(deps, client)
      const cert = await buildProfileCertificate({
        signer: deps.signer,
        paymail,
        issuedAt,
        displayName: args.displayName
      })
      const journal: PendingJournal = {
        v: 1,
        intent: 'register',
        steps: [{ kind: 'claim', paymail, cert }],
        startedAt: issuedAt.toISOString()
      }
      await writeJournal(deps.storage, journal)
      return await runJournal(deps, client, journal)
    } catch (e) {
      return { kind: 'failed', message: messageOf(e) }
    }
  })
}

export function updateProfile(
  deps: RegistrationDeps,
  args: { paymail: string; displayName?: string }
): Promise<RegistrationResult> {
  return share(`update:${args.paymail.trim().toLowerCase()}:${args.displayName?.trim() ?? ''}`, async () => {
    const client = deps.client
    if (!client) return { kind: 'unavailable' }
    try {
      const parsed = parsePaymail(args.paymail)
      if (!parsed || parsed.domain !== client.domain) {
        return { kind: 'failed', message: `handleRegistry: not this registry's paymail: ${args.paymail}` }
      }
      const paymail = `${parsed.handle}@${parsed.domain}`
      const issuedAt = await nextIssuedAt(deps, client)
      const cert = await buildProfileCertificate({
        signer: deps.signer,
        paymail,
        issuedAt,
        displayName: args.displayName
      })
      const journal: PendingJournal = {
        v: 1,
        intent: 'update',
        steps: [{ kind: 'claim', paymail, cert }],
        startedAt: issuedAt.toISOString()
      }
      await writeJournal(deps.storage, journal)
      return await runJournal(deps, client, journal)
    } catch (e) {
      return { kind: 'failed', message: messageOf(e) }
    }
  })
}

export function changeHandle(
  deps: RegistrationDeps,
  args: { previousPaymail: string; handle: string; displayName?: string }
): Promise<RegistrationResult> {
  const key = `change:${args.previousPaymail.trim().toLowerCase()}:${args.handle.trim().toLowerCase()}:${args.displayName?.trim() ?? ''}`
  return share(key, async () => {
    const client = deps.client
    if (!client) return { kind: 'unavailable' }
    try {
      const previous = parsePaymail(args.previousPaymail)
      const paymail = `${args.handle.trim().toLowerCase()}@${client.domain}`
      if (!previous || previous.domain !== client.domain || !parsePaymail(paymail)) {
        return { kind: 'failed', message: `handleRegistry: cannot change ${args.previousPaymail} to ${paymail}` }
      }
      const previousPaymail = `${previous.handle}@${previous.domain}`
      // One key may hold one handle, so the old one is tombstoned first and
      // the claim must be dated strictly after that tombstone.
      const releaseAt = await nextIssuedAt(deps, client)
      const claimAt = await nextIssuedAt(deps, client, releaseAt)
      const release = await buildProfileCertificate({
        signer: deps.signer,
        paymail: previousPaymail,
        issuedAt: releaseAt,
        released: true
      })
      const claim = await buildProfileCertificate({
        signer: deps.signer,
        paymail,
        issuedAt: claimAt,
        displayName: args.displayName
      })
      const journal: PendingJournal = {
        v: 1,
        intent: 'change',
        steps: [
          { kind: 'release', paymail: previousPaymail, cert: release },
          { kind: 'claim', paymail, cert: claim }
        ],
        previousPaymail,
        startedAt: releaseAt.toISOString()
      }
      await writeJournal(deps.storage, journal)
      return await runJournal(deps, client, journal)
    } catch (e) {
      return { kind: 'failed', message: messageOf(e) }
    }
  })
}

/** Called on every Profile mount. Nothing journalled is the common case. */
export function resumePending(deps: RegistrationDeps): Promise<RegistrationResult> {
  return share('resume', async () => {
    const client = deps.client
    if (!client) return { kind: 'unavailable' }
    try {
      const journal = await readJournal(deps.storage)
      if (!journal) return { kind: 'idle' }
      return await runJournal(deps, client, journal)
    } catch (e) {
      return { kind: 'failed', message: messageOf(e) }
    }
  })
}
```

- [ ] **Step 4: Run it, expect pass**

```bash
cd /Users/personal/git/bsv-wallet && npx jest packages/expo-wallet-toolbox/__tests__/identity/handleRegistry/registration.test.ts
```

Expected: PASS, all seven describe blocks.

- [ ] **Step 5: Run the whole registry suite and lint**

```bash
cd /Users/personal/git/bsv-wallet && npx jest packages/expo-wallet-toolbox/__tests__/identity/handleRegistry && npx prettier --check packages/expo-wallet-toolbox/core/identity/handleRegistry/registration.ts packages/expo-wallet-toolbox/__tests__/identity/handleRegistry/registration.test.ts && npx eslint packages/expo-wallet-toolbox/core/identity/handleRegistry
```

Expected: five suites pass; prettier and eslint clean.

---

## Task 7: i18n — 7 new keys and 4 changed ones, in all 12 locales

Purely mechanical, and it comes before the three UI tasks because all three read these keys. `__tests__/i18n/translationParity.test.ts` enforces three things at once: every language has exactly the English key set, the `{{placeholder}}` sets match, and no value is byte-identical to English unless it is on the `allowedUntranslated` list. None of the keys below go on that list.

Four existing values change, all 12 locales with them:

- `profile_handle_invalid` — the format rule is now the registry's 3-32 rule, which allows dots. State the whole regex in words, including the first/last character: `^[a-z0-9][a-z0-9._-]{1,30}[a-z0-9]$` (`pkg/handles/handles.go:37`) rejects `.dee` and `dee-`, and a hint that lists only the character set and the length sends that user back to the same hint with nothing new to read.
- `profile_display_name_hint` — the display name is **public** now (the 2026-09-18 ruling supersedes "shared privately with the handle registry").
- `profile_handle_claim` and `profile_handle_replace_warning` — **both hard-code an `@` in front of the interpolated handle**, and after Task 8 both are handed a full `handle@domain`. Left alone they read "Claim @dee@deggen.com" and "Claiming replaces @dee@deggen.com." in all 12 languages. The ProfileScreen test cannot catch this, because its mocked `t` returns `key:values` rather than the rendered sentence — the only guard is doing it here. Every other locale's sentence is left exactly as it was apart from the removed sigil.

**Files:**

- Modify: `packages/expo-wallet-toolbox/core/i18n/translations.tsx`
- Test: `packages/expo-wallet-toolbox/__tests__/i18n/translationParity.test.ts` (existing; Step 1b adds a glossary guard to it)

**Interfaces — produced here, consumed by Tasks 8, 9 and 10 as `t('<key>')`:**

| Key                                                       | Placeholders         | Used by |
| --------------------------------------------------------- | -------------------- | ------- |
| `profile_handle_invalid` _(changed)_                      | —                    | Task 8  |
| `profile_display_name_hint` _(changed)_                   | —                    | Task 8  |
| `profile_handle_claim` _(changed: `@` dropped)_           | `handle`             | Task 8  |
| `profile_handle_replace_warning` _(changed: `@` dropped)_ | `handle`             | Task 8  |
| `profile_handle_too_similar`                              | `handle`             | Task 8  |
| `profile_handle_reserved`                                 | `handle`             | Task 8  |
| `profile_handle_cooldown`                                 | `handle`             | Task 8  |
| `profile_handle_pending`                                  | —                    | Task 8  |
| `profile_handle_rolled_back`                              | `handle`, `previous` | Task 8  |
| `profile_handle_changed`                                  | —                    | Task 8  |
| `profile_handle_rejected`                                 | —                    | Task 8  |

No new key is needed for Pay or Contacts: the registry tier reuses `identity_search_unavailable` (line 847), `pay_trust_handle_attested` (1037) and `contacts_recent` (995), and Contacts reuses `contact_handle_caption` (1002).

- [ ] **Step 1: Confirm the baseline is green before touching anything**

```bash
cd /Users/personal/git/bsv-wallet && npx jest packages/expo-wallet-toolbox/__tests__/i18n/translationParity.test.ts
```

Expected: PASS. If it is already red, stop and fix that first — otherwise you cannot tell your own breakage apart from it.

- [ ] **Step 1b: Extend the parity test with a glossary guard, because the three checks above are blind to the one mistake this task can make**

A value that names the wrong thing is present, placeholder-correct and not English, so all three existing checks pass it. Add two more, over all 12 languages including `en`: every language's handle copy must contain that language's own word for a handle — its `profile_handle` label, lowercased — and the handle's status lines must not contain that language's word for the Identifier, its `contact_identifier` label. Derive both words from the block itself rather than hard-coding a table, so the guard follows a relabelled locale. `profile_handle_registered_hint` stays out of the second list: it really does say the handle is registered to your Identifier.

```ts
const handleNounKeys = [
  'profile_handle_unavailable',
  'profile_handle_registered',
  'profile_handle_changed',
  'profile_handle_rejected',
  'profile_handle_replace_warning',
  'profile_display_name_hint',
  'contact_handle_caption'
]
const identifierFreeKeys = [
  'profile_handle_available',
  'profile_handle_taken',
  'profile_handle_invalid',
  'profile_handle_failed',
  'profile_handle_too_similar',
  'profile_handle_reserved',
  'profile_handle_cooldown',
  'profile_handle_pending',
  'profile_handle_rolled_back',
  'profile_handle_changed',
  'profile_handle_rejected',
  'profile_display_name_hint'
]
const languages = Object.keys(resources)

it.each(languages)('%s names the handle with its own word for it', language => {
  const translation = resources[language as keyof typeof resources].translation as Translation
  const handleNoun = translation.profile_handle.toLowerCase()
  expect(handleNounKeys.filter(key => !translation[key].toLowerCase().includes(handleNoun))).toEqual([])
})

it.each(languages)('%s keeps the Identifier out of the handle status lines', language => {
  const translation = resources[language as keyof typeof resources].translation as Translation
  const identifierNoun = translation.contact_identifier.toLowerCase()
  expect(identifierFreeKeys.filter(key => translation[key].toLowerCase().includes(identifierNoun))).toEqual([])
})
```

Expected right now: red for both new checks — `profile_handle_changed` and `profile_handle_rejected` do not exist yet, and the stale `profile_display_name_hint` values name no handle at all. Step 4 is what turns it green.

- [ ] **Step 2: Add the seven new keys to the `en` block only, and run the test to see it fail**

In the `en` block, insert after the `profile_handle_register_action` line (around line 1026):

```ts
      profile_handle_too_similar: '{{handle}} is too close to one already in use',
      profile_handle_reserved: '{{handle}} is reserved',
      profile_handle_cooldown: '{{handle}} was released recently and is not free yet',
      profile_handle_pending: 'Finishing registration…',
      profile_handle_rolled_back: '{{handle}} was taken. You kept {{previous}}.',
      profile_handle_changed: 'Handle changed',
      profile_handle_rejected: 'The registry refused that handle.',
```

```bash
cd /Users/personal/git/bsv-wallet && npx jest packages/expo-wallet-toolbox/__tests__/i18n/translationParity.test.ts
```

Expected: FAIL — `Tests: 22 failed`, each of the 11 non-English languages reporting the seven missing keys.

- [ ] **Step 3: Change the four existing English values**

Replace, in the `en` block:

```ts
      profile_display_name_hint:
        'Kept on this device and shared privately with the handle registry when you register a handle. Not published.',
```

with:

```ts
      profile_display_name_hint: 'Shown publicly next to your handle. Anyone who looks you up can see it.',
```

replace:

```ts
      profile_handle_invalid: '3-20 lowercase letters, digits, _ or -',
```

with:

```ts
      profile_handle_invalid:
        '3-32 characters: a-z, 0-9, dot, underscore or hyphen, starting and ending with a letter or digit',
```

and drop the literal `@` from both handle sentences — `{{handle}}` now arrives as a full `handle@domain`:

```ts
      profile_handle_claim: 'Claim @{{handle}}',
      profile_handle_replace_warning:
        'Claiming replaces @{{handle}}. People who saved you keep their contact; the old handle stops resolving to you.',
```

becomes:

```ts
      profile_handle_claim: 'Claim {{handle}}',
      profile_handle_replace_warning:
        'Claiming replaces {{handle}}. People who saved you keep their contact; the old handle stops resolving to you.',
```

- [ ] **Step 4: Add all eleven keys to the remaining 11 locale blocks**

Locate each block by its anchor key `profile_handle_register_action` (for the seven new ones) and by the existing `profile_display_name_hint` / `profile_handle_invalid` / `profile_handle_claim` / `profile_handle_replace_warning` keys (for the four replacements) — **never by line offset**, because key order differs between blocks. Values, verbatim:

Two things the values below are careful about, because the parity test cannot see either. **Each language says "handle" in its own word** — the one on its `profile_handle` label: Alias (es), Pseudo (fr), Apelido (pt), اسم المستخدم (ar), Юзернейм (ru), Pseudonim (pl), 用户名 (zh), ハンドル (ja), हैंडल (hi), হ্যান্ডেল (bn), Handle (id). Never that language's word for the _Identifier_ — identificador / identifiant / معرّف / идентификатор label the identity key two sections down the same screen, and `contact_copy_identifier` and `pay_trust_unverified` with it. **And the three new availability lines share a slot with `profile_handle_available` / `_taken`**, so in ru and pl they take the gender of that language's handle noun (masculine in both: юзернейм, pseudonim), not of имя / nazwa — which would also make the display-name hint say the display name is shown next to your name.

**zh**

```ts
      profile_display_name_hint: '会公开显示在你的用户名旁边。任何查找你的人都能看到。',
      profile_handle_invalid: '3-32 个字符：a-z、0-9、点、下划线或连字符，且以字母或数字开头和结尾',
      profile_handle_claim: '认领 {{handle}}',
      profile_handle_replace_warning: '认领将替换 {{handle}}。已保存你的人仍保留联系人；旧用户名将不再指向你。',
      profile_handle_too_similar: '{{handle}} 与已有的名称过于相似',
      profile_handle_reserved: '{{handle}} 是保留名称',
      profile_handle_cooldown: '{{handle}} 最近被释放，暂时还不能使用',
      profile_handle_pending: '正在完成注册…',
      profile_handle_rolled_back: '{{handle}} 已被占用，已为你保留 {{previous}}。',
      profile_handle_changed: '用户名已更改',
      profile_handle_rejected: '注册服务拒绝了该用户名。',
```

**hi**

```ts
      profile_display_name_hint: 'आपके हैंडल के बगल में सार्वजनिक रूप से दिखता है। आपको खोजने वाला कोई भी इसे देख सकता है।',
      profile_handle_invalid: '3-32 अक्षर: a-z, 0-9, बिंदु, अंडरस्कोर या हाइफ़न; शुरू और अंत अक्षर या अंक से',
      profile_handle_claim: '{{handle}} लें',
      profile_handle_replace_warning:
        'लेने से {{handle}} बदल जाएगा। जिन्होंने आपको सहेजा है उनका संपर्क बना रहेगा; पुराना हैंडल अब आप तक नहीं पहुँचेगा।',
      profile_handle_too_similar: '{{handle}} पहले से मौजूद किसी नाम से बहुत मिलता-जुलता है',
      profile_handle_reserved: '{{handle}} आरक्षित है',
      profile_handle_cooldown: '{{handle}} हाल ही में छोड़ा गया था और अभी उपलब्ध नहीं है',
      profile_handle_pending: 'पंजीकरण पूरा किया जा रहा है…',
      profile_handle_rolled_back: '{{handle}} ले लिया गया था। आपके पास {{previous}} बना रहा।',
      profile_handle_changed: 'हैंडल बदल गया',
      profile_handle_rejected: 'रजिस्ट्री ने उस हैंडल को अस्वीकार कर दिया।',
```

**es**

```ts
      profile_display_name_hint: 'Se muestra públicamente junto a tu alias. Cualquiera que te busque puede verlo.',
      profile_handle_invalid:
        '3-32 caracteres: a-z, 0-9, punto, guion bajo o guion; empieza y acaba con letra o dígito',
      profile_handle_claim: 'Reclamar {{handle}}',
      profile_handle_replace_warning:
        'Reclamar sustituye a {{handle}}. Quienes te guardaron conservan el contacto; el alias antiguo deja de apuntar a ti.',
      profile_handle_too_similar: '{{handle}} se parece demasiado a uno ya en uso',
      profile_handle_reserved: '{{handle}} está reservado',
      profile_handle_cooldown: '{{handle}} se liberó hace poco y aún no está libre',
      profile_handle_pending: 'Terminando el registro…',
      profile_handle_rolled_back: '{{handle}} ya estaba ocupado. Conservas {{previous}}.',
      profile_handle_changed: 'Alias cambiado',
      profile_handle_rejected: 'El registro rechazó ese alias.',
```

**fr**

```ts
      profile_display_name_hint:
        'Affiché publiquement à côté de votre pseudo. Toute personne qui vous recherche peut le voir.',
      profile_handle_invalid:
        '3-32 caractères : a-z, 0-9, point, tiret bas ou tiret ; commence et finit par une lettre ou un chiffre',
      profile_handle_claim: 'Prendre {{handle}}',
      profile_handle_replace_warning:
        'Prendre ce pseudo remplace {{handle}}. Ceux qui vous ont enregistré gardent leur contact ; l’ancien pseudo ne mène plus à vous.',
      profile_handle_too_similar: '{{handle}} ressemble trop à un pseudo déjà utilisé',
      profile_handle_reserved: '{{handle}} est réservé',
      profile_handle_cooldown: '{{handle}} a été libéré récemment et n’est pas encore disponible',
      profile_handle_pending: 'Finalisation de l’enregistrement…',
      profile_handle_rolled_back: '{{handle}} était déjà pris. Vous gardez {{previous}}.',
      profile_handle_changed: 'Pseudo modifié',
      profile_handle_rejected: 'Le registre a refusé ce pseudo.',
```

**ar**

```ts
      profile_display_name_hint: 'يظهر علنًا بجوار اسم المستخدم الخاص بك. يمكن لأي شخص يبحث عنك رؤيته.',
      profile_handle_invalid: '3-32 حرفًا: a-z و0-9 والنقطة والشرطة السفلية والشرطة، ويبدأ وينتهي بحرف أو رقم',
      profile_handle_claim: 'حجز {{handle}}',
      profile_handle_replace_warning:
        'الحجز يستبدل {{handle}}. من حفظوك يحتفظون بجهة الاتصال؛ ولن يقود اسم المستخدم القديم إليك بعد الآن.',
      profile_handle_too_similar: '{{handle}} يشبه كثيرًا اسمًا مستخدمًا بالفعل',
      profile_handle_reserved: '{{handle}} محجوز',
      profile_handle_cooldown: '{{handle}} تم تحريره مؤخرًا وغير متاح بعد',
      profile_handle_pending: 'جارٍ إنهاء التسجيل…',
      profile_handle_rolled_back: '{{handle}} أصبح محجوزًا. احتفظت بـ {{previous}}.',
      profile_handle_changed: 'تم تغيير اسم المستخدم',
      profile_handle_rejected: 'رفضت خدمة التسجيل اسم المستخدم هذا.',
```

**pt**

```ts
      profile_display_name_hint:
        'Mostrado publicamente ao lado do seu apelido. Qualquer pessoa que procurar por você pode ver.',
      profile_handle_invalid:
        '3-32 caracteres: a-z, 0-9, ponto, sublinhado ou hífen; começa e termina com letra ou número',
      profile_handle_claim: 'Reivindicar {{handle}}',
      profile_handle_replace_warning:
        'Reivindicar substitui {{handle}}. Quem salvou você mantém o contato; o apelido antigo deixa de levar a você.',
      profile_handle_too_similar: '{{handle}} é parecido demais com um já em uso',
      profile_handle_reserved: '{{handle}} está reservado',
      profile_handle_cooldown: '{{handle}} foi liberado há pouco e ainda não está livre',
      profile_handle_pending: 'Concluindo o registro…',
      profile_handle_rolled_back: '{{handle}} já estava ocupado. Você manteve {{previous}}.',
      profile_handle_changed: 'Apelido alterado',
      profile_handle_rejected: 'O registro recusou esse apelido.',
```

**bn**

```ts
      profile_display_name_hint: 'আপনার হ্যান্ডেলের পাশে প্রকাশ্যে দেখানো হয়। যে কেউ আপনাকে খুঁজলে এটি দেখতে পাবে।',
      profile_handle_invalid: '৩-৩২ অক্ষর: a-z, 0-9, ডট, আন্ডারস্কোর বা হাইফেন; শুরু ও শেষ অক্ষর বা সংখ্যা দিয়ে',
      profile_handle_claim: '{{handle}} নিন',
      profile_handle_replace_warning:
        'নিলে {{handle}} প্রতিস্থাপিত হবে। যারা আপনাকে সংরক্ষণ করেছেন তাদের পরিচিতি থাকবে; পুরোনো হ্যান্ডেল আর আপনার কাছে পৌঁছাবে না।',
      profile_handle_too_similar: '{{handle}} ইতিমধ্যে ব্যবহৃত একটির সঙ্গে খুব মিল',
      profile_handle_reserved: '{{handle}} সংরক্ষিত',
      profile_handle_cooldown: '{{handle}} সম্প্রতি ছেড়ে দেওয়া হয়েছে, এখনো খালি নয়',
      profile_handle_pending: 'নিবন্ধন শেষ করা হচ্ছে…',
      profile_handle_rolled_back: '{{handle}} নেওয়া হয়ে গেছে। আপনি {{previous}} রেখেছেন।',
      profile_handle_changed: 'হ্যান্ডেল পরিবর্তিত হয়েছে',
      profile_handle_rejected: 'রেজিস্ট্রি সেই হ্যান্ডেলটি প্রত্যাখ্যান করেছে।',
```

**ru**

```ts
      profile_display_name_hint: 'Показывается публично рядом с вашим юзернеймом. Его увидит любой, кто вас найдёт.',
      profile_handle_invalid:
        '3-32 символа: a-z, 0-9, точка, подчёркивание или дефис; начинается и заканчивается буквой или цифрой',
      profile_handle_claim: 'Занять {{handle}}',
      profile_handle_replace_warning:
        'Это заменит {{handle}}. У тех, кто вас сохранил, контакт останется; старый юзернейм больше не будет вести к вам.',
      profile_handle_too_similar: '{{handle}} слишком похож на уже занятый',
      profile_handle_reserved: '{{handle}} зарезервирован',
      profile_handle_cooldown: '{{handle}} недавно освобождён и пока недоступен',
      profile_handle_pending: 'Завершаем регистрацию…',
      profile_handle_rolled_back: '{{handle}} уже заняли. За вами осталось {{previous}}.',
      profile_handle_changed: 'Юзернейм изменён',
      profile_handle_rejected: 'Реестр отклонил этот юзернейм.',
```

**id**

```ts
      profile_display_name_hint: 'Ditampilkan secara publik di samping handle Anda. Siapa pun yang mencari Anda bisa melihatnya.',
      profile_handle_invalid:
        '3-32 karakter: a-z, 0-9, titik, garis bawah, atau tanda hubung; diawali dan diakhiri huruf atau angka',
      profile_handle_claim: 'Klaim {{handle}}',
      profile_handle_replace_warning:
        'Mengklaim akan mengganti {{handle}}. Orang yang menyimpan Anda tetap punya kontaknya; handle lama tidak lagi mengarah ke Anda.',
      profile_handle_too_similar: '{{handle}} terlalu mirip dengan yang sudah dipakai',
      profile_handle_reserved: '{{handle}} sudah dicadangkan',
      profile_handle_cooldown: '{{handle}} baru saja dilepas dan belum bisa dipakai',
      profile_handle_pending: 'Menyelesaikan pendaftaran…',
      profile_handle_rolled_back: '{{handle}} sudah diambil. Anda tetap memakai {{previous}}.',
      profile_handle_changed: 'Handle diubah',
      profile_handle_rejected: 'Registri menolak handle itu.',
```

**ja**

```ts
      profile_display_name_hint: 'ハンドルの横に公開表示されます。あなたを検索した人は誰でも見られます。',
      profile_handle_invalid: '3〜32文字：a-z、0-9、ドット、アンダースコア、ハイフン。先頭と末尾は英字か数字',
      profile_handle_claim: '{{handle}} を取得',
      profile_handle_replace_warning:
        '取得すると {{handle}} は置き換わります。あなたを保存した人の連絡先は残りますが、古いハンドルはあなたに繋がらなくなります。',
      profile_handle_too_similar: '{{handle}} は既存のものと似すぎています',
      profile_handle_reserved: '{{handle}} は予約済みです',
      profile_handle_cooldown: '{{handle}} は最近解放されたため、まだ利用できません',
      profile_handle_pending: '登録を完了しています…',
      profile_handle_rolled_back: '{{handle}} は取得済みでした。{{previous}} をそのまま使います。',
      profile_handle_changed: 'ハンドルを変更しました',
      profile_handle_rejected: 'レジストリがそのハンドルを拒否しました。',
```

**pl**

```ts
      profile_display_name_hint: 'Widoczna publicznie obok Twojego pseudonimu. Zobaczy ją każdy, kto Cię wyszuka.',
      profile_handle_invalid:
        '3-32 znaki: a-z, 0-9, kropka, podkreślenie lub myślnik; zaczyna się i kończy literą lub cyfrą',
      profile_handle_claim: 'Zajmij {{handle}}',
      profile_handle_replace_warning:
        'Zajęcie zastąpi {{handle}}. Osoby, które Cię zapisały, zachowają kontakt; stary pseudonim przestanie prowadzić do Ciebie.',
      profile_handle_too_similar: '{{handle}} jest zbyt podobny do już używanego',
      profile_handle_reserved: '{{handle}} jest zarezerwowany',
      profile_handle_cooldown: '{{handle}} został niedawno zwolniony i nie jest jeszcze wolny',
      profile_handle_pending: 'Kończenie rejestracji…',
      profile_handle_rolled_back: '{{handle}} został zajęty. Zachowujesz {{previous}}.',
      profile_handle_changed: 'Pseudonim zmieniony',
      profile_handle_rejected: 'Rejestr odrzucił ten pseudonim.',
```

The French and Portuguese values use the typographic apostrophe `’` so the single-quoted strings need no escaping. Keep each entry at 6 spaces of indent, a continuation line at 8, and a trailing comma except on a block's last entry — prettier at `printWidth: 120` decides which values wrap.

`profile_handle_claim` and `profile_handle_replace_warning` already exist in every block, near `profile_handle_change` rather than near `profile_handle_invalid` — **replace them where they are** rather than adding a second copy. The only change to each is the removed `@`; every other character of those sentences stays as it was, so a reviewer reading `git diff` sees one deleted sigil per locale and nothing else.

- [ ] **Step 4b: Prove no locale kept the sigil**

```bash
cd /Users/personal/git/bsv-wallet && grep -n "@{{handle}}" packages/expo-wallet-toolbox/core/i18n/translations.tsx
```

Expected: no output. (Before this task it prints 24 lines — two keys × 12 locales.)

- [ ] **Step 5: Run it, expect pass**

```bash
cd /Users/personal/git/bsv-wallet && npx jest packages/expo-wallet-toolbox/__tests__/i18n/translationParity.test.ts
```

Expected: PASS — 57 tests, 0 failures (33 from the three original checks, 24 from the two added in Step 1b).

- [ ] **Step 6: Lint and format**

```bash
cd /Users/personal/git/bsv-wallet && npx prettier --check packages/expo-wallet-toolbox/core/i18n/translations.tsx && npx eslint packages/expo-wallet-toolbox/core/i18n/translations.tsx
```

Expected: clean.

---

## Task 8: ProfileScreen on the registry — and the certifier deleted

The state machine and the layout stay. What changes is what answers: the registry, not a certifier that was never deployed. This task also removes the certifier config, because `getHandleCertifierConfig` has exactly one caller and it is this screen — deleting it earlier would have broken the build.

**Files:**

- Modify: `packages/expo-wallet-toolbox/ui/screens/ProfileScreen.tsx`
- Modify: `packages/expo-wallet-toolbox/core/toolboxConfig.ts` (remove the certifier)
- Modify: `packages/expo-wallet-toolbox/__tests__/toolboxConfig.test.ts` (remove its describe block)
- Delete: `packages/expo-wallet-toolbox/core/identity/handleCertificate.ts`
- Delete: `packages/expo-wallet-toolbox/__tests__/identity/handleCertificate.test.ts`
- Create (test): `packages/expo-wallet-toolbox/__tests__/ui/profileScreen.test.tsx`

**Interfaces:**

- Consumes, verbatim: `getHandleRegistryConfig` / `HandleRegistryConfig` (Task 3); `createHandleRegistryClient`, `AvailabilityReason` (Task 5); `registerHandle`, `updateProfile`, `changeHandle`, `resumePending`, `RegistrationResult` (Task 6); `ProfileSigner` (Task 2); `parsePaymail`, `isValidHandleFormat` (Task 1); `bindOriginator` from `../../core/mandala/createRuntime`; the nine i18n keys from Task 7.
- Produces: nothing importable. `HANDLE_KV_KEY = 'profile_registered_handle'` keeps its name but now holds the full `handle@domain`.
- Removes from the package's surface: `HANDLE_CERT_TYPE`, `HandleCertWallet`, `isValidHandleFormat` (the old 3-20 one), `HandleAvailability`, `checkHandleAvailability`, `registerHandle` (the certifier one), `RegisterHandleResult`, `HandleCertifierConfig`, `getHandleCertifierConfig`, `ToolboxConfig.handleCertifier`.

- [ ] **Step 1: Write the failing test**

Create `packages/expo-wallet-toolbox/__tests__/ui/profileScreen.test.tsx`:

```tsx
/**
 * The Profile screen's handle machine, driven against a scripted registry
 * client and a scripted registration module — the certificate work itself is
 * covered by the handleRegistry suite, and what is under test here is which
 * question the screen asks and what it does with the answer.
 */
jest.mock('expo-haptics', () => ({
  selectionAsync: jest.fn(() => Promise.resolve()),
  impactAsync: jest.fn(() => Promise.resolve()),
  notificationAsync: jest.fn(() => Promise.resolve()),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' }
}))
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }))
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children
}))
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) => (values ? `${key}:${Object.values(values).join(',')}` : key),
    i18n: { language: 'en' }
  }),
  initReactI18next: { type: '3rdParty', init: () => {} }
}))
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
  useLocalSearchParams: () => ({})
}))
jest.mock('../../ui/components/ui/Toast', () => ({ showToast: jest.fn() }))
jest.mock('../../ui/resolveIdentity', () => ({
  makeIdentityClient: () => null,
  resolveIdentity: jest.fn()
}))

const checkAvailability = jest.fn()
const lookupIdentityKey = jest.fn()
jest.mock('../../core/identity/handleRegistry/client', () => ({
  createHandleRegistryClient: () => ({ domain: 'deggen.com', checkAvailability, lookupIdentityKey })
}))

const registerHandle = jest.fn()
const changeHandle = jest.fn()
const updateProfile = jest.fn()
const resumePending = jest.fn()
jest.mock('../../core/identity/handleRegistry/registration', () => ({
  registerHandle: (...a: unknown[]) => registerHandle(...a),
  changeHandle: (...a: unknown[]) => changeHandle(...a),
  updateProfile: (...a: unknown[]) => updateProfile(...a),
  resumePending: (...a: unknown[]) => resumePending(...a)
}))

let mockNetwork: 'main' | 'test' = 'test'
const kv = new Map<string, string>()
const mockStorage = {
  getKeyValue: async (k: string) => kv.get(k),
  setKeyValue: async (k: string, v: string) => {
    kv.set(k, v)
  }
}
const permissionsManager = {
  getPublicKey: async () => ({ publicKey: '02' + 'ab'.repeat(32) }),
  createSignature: async () => ({ signature: [1] })
}
jest.mock('@bsv/expo-wallet-toolbox', () => ({
  ...jest.requireActual('@bsv/expo-wallet-toolbox'),
  useWallet: () => ({
    managers: { permissionsManager },
    adminOriginator: 'admin.com',
    storage: mockStorage,
    selectedNetwork: mockNetwork
  })
}))

import React from 'react'
import { fireEvent, render, waitFor } from '@testing-library/react-native'
import { ThemeProvider, configureToolbox, resetToolboxConfig } from '@bsv/expo-wallet-toolbox'
import { showToast } from '../../ui/components/ui/Toast'
import { ProfileScreen } from '../../ui/screens/ProfileScreen'

const OWN_KEY = '02' + 'ab'.repeat(32)
const draw = () =>
  render(
    <ThemeProvider>
      <ProfileScreen />
    </ThemeProvider>
  )

const withRegistry = () =>
  configureToolbox({
    backupUrl: null,
    handleRegistry: { test: { domain: 'deggen.com', url: 'https://registry.example' } }
  })

beforeEach(() => {
  jest.clearAllMocks()
  kv.clear()
  resetToolboxConfig()
  mockNetwork = 'test'
  resumePending.mockResolvedValue({ kind: 'idle' })
  lookupIdentityKey.mockResolvedValue(null)
  checkAvailability.mockResolvedValue({ kind: 'available' })
})
afterEach(() => resetToolboxConfig())

describe('with no registry on this chain', () => {
  it('says so and offers no input, asking the registry nothing', async () => {
    configureToolbox({ backupUrl: null })
    const s = draw()
    await waitFor(() => expect(s.getByText('profile_handle_unavailable')).toBeTruthy())
    expect(s.queryByPlaceholderText('profile_handle_placeholder')).toBeNull()
    expect(resumePending).not.toHaveBeenCalled()
    expect(lookupIdentityKey).not.toHaveBeenCalled()
  })
})

describe('the claim field', () => {
  it('takes the local part and shows the configured domain beside it', async () => {
    withRegistry()
    const s = draw()
    await waitFor(() => expect(s.getByPlaceholderText('profile_handle_placeholder')).toBeTruthy())
    expect(s.getByText('@deggen.com')).toBeTruthy()
  })

  it('checks availability once, after the debounce, and names the full paymail', async () => {
    withRegistry()
    const s = draw()
    const input = await waitFor(() => s.getByPlaceholderText('profile_handle_placeholder'))
    fireEvent.changeText(input, 'd')
    fireEvent.changeText(input, 'de')
    fireEvent.changeText(input, 'dee')
    await waitFor(() => expect(s.getByText('profile_handle_available:dee@deggen.com')).toBeTruthy())
    expect(checkAvailability).toHaveBeenCalledTimes(1)
    expect(checkAvailability).toHaveBeenCalledWith('dee')
  })

  it.each([
    ['taken', 'profile_handle_taken:dee@deggen.com'],
    ['too_similar', 'profile_handle_too_similar:dee@deggen.com'],
    ['reserved', 'profile_handle_reserved:dee@deggen.com'],
    ['cooldown', 'profile_handle_cooldown:dee@deggen.com'],
    ['invalid', 'profile_handle_invalid']
  ])('draws its own line for %s', async (reason, expected) => {
    withRegistry()
    checkAvailability.mockResolvedValue({ kind: 'unavailable', reason })
    const s = draw()
    fireEvent.changeText(await waitFor(() => s.getByPlaceholderText('profile_handle_placeholder')), 'dee')
    await waitFor(() => expect(s.getByText(expected)).toBeTruthy())
  })

  it('offers a retry when the check could not be made', async () => {
    withRegistry()
    checkAvailability.mockResolvedValue({ kind: 'failed' })
    const s = draw()
    fireEvent.changeText(await waitFor(() => s.getByPlaceholderText('profile_handle_placeholder')), 'dee')
    await waitFor(() => expect(s.getByText('profile_handle_failed')).toBeTruthy())
    fireEvent.press(s.getByText('retry'))
    await waitFor(() => expect(checkAvailability).toHaveBeenCalledTimes(2))
  })

  it('discards an answer for text the user has already replaced', async () => {
    withRegistry()
    let release: (value: { kind: string }) => void = () => {}
    checkAvailability
      .mockImplementationOnce(() => new Promise(resolve => (release = resolve)))
      .mockResolvedValue({ kind: 'unavailable', reason: 'taken' })
    const s = draw()
    const input = await waitFor(() => s.getByPlaceholderText('profile_handle_placeholder'))
    fireEvent.changeText(input, 'dee')
    await waitFor(() => expect(checkAvailability).toHaveBeenCalledTimes(1))
    fireEvent.changeText(input, 'deggen')
    await waitFor(() => expect(checkAvailability).toHaveBeenCalledTimes(2))
    release({ kind: 'available' })
    await waitFor(() => expect(s.getByText('profile_handle_taken:deggen@deggen.com')).toBeTruthy())
  })
})

describe('on mount', () => {
  it('finishes anything journalled before asking the registry who we are', async () => {
    withRegistry()
    const order: string[] = []
    resumePending.mockImplementation(async () => (order.push('resume'), { kind: 'idle' }))
    lookupIdentityKey.mockImplementation(async () => (order.push('lookup'), null))
    draw()
    await waitFor(() => expect(order).toEqual(['resume', 'lookup']))
    expect(lookupIdentityKey).toHaveBeenCalledWith(OWN_KEY)
  })

  /**
   * `getHandleRegistryConfig` returns a fresh object every call, so a client
   * memoised on it would be a new client every render and this effect would
   * resume a journal and hit the network once per keystroke. Typing is the
   * cheapest way to prove the memo is keyed on the two strings instead.
   */
  it('asks once per mount, not once per render', async () => {
    withRegistry()
    const s = draw()
    await waitFor(() => expect(lookupIdentityKey).toHaveBeenCalledTimes(1))
    const input = s.getByPlaceholderText('profile_handle_placeholder')
    fireEvent.changeText(input, 'd')
    fireEvent.changeText(input, 'de')
    fireEvent.changeText(input, 'dee')
    await waitFor(() => expect(s.getByText('profile_handle_available:dee@deggen.com')).toBeTruthy())
    expect(resumePending).toHaveBeenCalledTimes(1)
    expect(lookupIdentityKey).toHaveBeenCalledTimes(1)
  })

  it('shows the cached handle at once and corrects it when the registry answers', async () => {
    withRegistry()
    kv.set('profile_registered_handle', 'old@deggen.com')
    // The lookup is held open deliberately. Both the cached read and a
    // `mockResolvedValue` lookup settle within a microtask or two of each
    // other, so without a gate this test would be asserting an intermediate
    // frame it does not control — and would usually find the corrected value
    // already on screen.
    let answer: (profile: { paymail: string; handle: string; domain: string }) => void = () => {}
    lookupIdentityKey.mockImplementation(() => new Promise(resolve => (answer = resolve)))
    const s = draw()
    await waitFor(() => expect(s.getByText('old@deggen.com')).toBeTruthy())
    expect(s.queryByText('dee@deggen.com')).toBeNull()

    answer({ paymail: 'dee@deggen.com', handle: 'dee', domain: 'deggen.com' })
    await waitFor(() => expect(s.getByText('dee@deggen.com')).toBeTruthy())
    expect(kv.get('profile_registered_handle')).toBe('dee@deggen.com')
  })

  it('throws away a cached value from before handles carried a domain', async () => {
    withRegistry()
    kv.set('profile_registered_handle', 'dee')
    const s = draw()
    await waitFor(() => expect(s.getByPlaceholderText('profile_handle_placeholder')).toBeTruthy())
    expect(s.queryByText('dee')).toBeNull()
  })

  it('clears the cache when the registry says we hold nothing', async () => {
    withRegistry()
    kv.set('profile_registered_handle', 'dee@deggen.com')
    const s = draw()
    await waitFor(() => expect(kv.get('profile_registered_handle')).toBe(''))
    expect(s.getByPlaceholderText('profile_handle_placeholder')).toBeTruthy()
  })

  it('shows a non-blocking finishing state with a retry for a pending journal', async () => {
    withRegistry()
    resumePending.mockResolvedValue({ kind: 'pending' })
    const s = draw()
    await waitFor(() => expect(s.getByText('profile_handle_pending')).toBeTruthy())
    fireEvent.press(s.getByText('retry'))
    await waitFor(() => expect(resumePending).toHaveBeenCalledTimes(2))
  })
})

describe('claiming', () => {
  it('registers a first handle and keeps the full paymail', async () => {
    withRegistry()
    registerHandle.mockResolvedValue({ kind: 'registered', paymail: 'dee@deggen.com' })
    const s = draw()
    fireEvent.changeText(await waitFor(() => s.getByPlaceholderText('profile_handle_placeholder')), 'dee')
    await waitFor(() => expect(s.getByText('profile_handle_available:dee@deggen.com')).toBeTruthy())
    fireEvent.press(s.getByText('profile_handle_claim:dee@deggen.com'))
    await waitFor(() => expect(s.getByText('dee@deggen.com')).toBeTruthy())
    expect(registerHandle).toHaveBeenCalledWith(expect.anything(), { handle: 'dee', displayName: '' })
    expect(kv.get('profile_registered_handle')).toBe('dee@deggen.com')
    expect(showToast).toHaveBeenCalledWith('profile_handle_registered', { type: 'success' })
  })

  it('changes an existing handle rather than claiming a second one', async () => {
    withRegistry()
    lookupIdentityKey.mockResolvedValue({ paymail: 'dee@deggen.com', handle: 'dee', domain: 'deggen.com' })
    changeHandle.mockResolvedValue({ kind: 'changed', paymail: 'deggen@deggen.com' })
    const s = draw()
    fireEvent.press(await waitFor(() => s.getByText('profile_handle_change')))
    fireEvent.changeText(s.getByPlaceholderText('profile_handle_placeholder'), 'deggen')
    await waitFor(() => expect(s.getByText('profile_handle_available:deggen@deggen.com')).toBeTruthy())
    fireEvent.press(s.getByText('profile_handle_claim:deggen@deggen.com'))
    await waitFor(() =>
      expect(changeHandle).toHaveBeenCalledWith(expect.anything(), {
        previousPaymail: 'dee@deggen.com',
        handle: 'deggen',
        displayName: ''
      })
    )
    expect(kv.get('profile_registered_handle')).toBe('deggen@deggen.com')
  })

  it('tells the user which handle they kept after a rollback', async () => {
    withRegistry()
    lookupIdentityKey.mockResolvedValue({ paymail: 'dee@deggen.com', handle: 'dee', domain: 'deggen.com' })
    changeHandle.mockResolvedValue({ kind: 'rolled_back', paymail: 'dee@deggen.com' })
    const s = draw()
    fireEvent.press(await waitFor(() => s.getByText('profile_handle_change')))
    fireEvent.changeText(s.getByPlaceholderText('profile_handle_placeholder'), 'deggen')
    await waitFor(() => expect(s.getByText('profile_handle_available:deggen@deggen.com')).toBeTruthy())
    fireEvent.press(s.getByText('profile_handle_claim:deggen@deggen.com'))
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith('profile_handle_rolled_back:deggen@deggen.com,dee@deggen.com', {
        type: 'error'
      })
    )
    expect(kv.get('profile_registered_handle')).toBe('dee@deggen.com')
  })

  it('reports a refusal without pretending the claim worked', async () => {
    withRegistry()
    registerHandle.mockResolvedValue({ kind: 'rejected', code: 'ERR_HANDLE_TAKEN', description: 'taken' })
    const s = draw()
    fireEvent.changeText(await waitFor(() => s.getByPlaceholderText('profile_handle_placeholder')), 'dee')
    await waitFor(() => expect(s.getByText('profile_handle_available:dee@deggen.com')).toBeTruthy())
    fireEvent.press(s.getByText('profile_handle_claim:dee@deggen.com'))
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('profile_handle_rejected', { type: 'error' }))
    expect(kv.get('profile_registered_handle')).toBeUndefined()
  })
})

describe('the display name', () => {
  it('is saved locally and, when a handle is registered, published to the registry', async () => {
    withRegistry()
    lookupIdentityKey.mockResolvedValue({ paymail: 'dee@deggen.com', handle: 'dee', domain: 'deggen.com' })
    updateProfile.mockResolvedValue({ kind: 'updated', paymail: 'dee@deggen.com' })
    const s = draw()
    fireEvent.press(await waitFor(() => s.getByLabelText('contact_edit_name')))
    fireEvent.changeText(s.getByPlaceholderText('profile_display_name'), '  Dee K  ')
    fireEvent.press(s.getByLabelText('contact_save_name'))
    await waitFor(() => expect(kv.get('profile_display_name')).toBe('Dee K'))
    await waitFor(() =>
      expect(updateProfile).toHaveBeenCalledWith(expect.anything(), {
        paymail: 'dee@deggen.com',
        displayName: 'Dee K'
      })
    )
  })

  it('stays purely local while no handle is registered', async () => {
    withRegistry()
    const s = draw()
    fireEvent.press(await waitFor(() => s.getByLabelText('contact_edit_name')))
    fireEvent.changeText(s.getByPlaceholderText('profile_display_name'), 'Dee K')
    fireEvent.press(s.getByLabelText('contact_save_name'))
    await waitFor(() => expect(kv.get('profile_display_name')).toBe('Dee K'))
    expect(updateProfile).not.toHaveBeenCalled()
  })

  it('says the name is public', async () => {
    withRegistry()
    const s = draw()
    await waitFor(() => expect(s.getByText('profile_display_name_hint')).toBeTruthy())
  })
})
```

- [ ] **Step 2: Run it, expect the named failure**

```bash
cd /Users/personal/git/bsv-wallet && npx jest packages/expo-wallet-toolbox/__tests__/ui/profileScreen.test.tsx
```

Expected: FAIL — `Cannot find module '../../core/identity/handleRegistry/client'` is satisfied by the mock, so the first real failure is `profile_handle_unavailable` never rendering, because the screen still gates on `getHandleCertifierConfig`.

- [ ] **Step 3: Rewire `ProfileScreen.tsx`**

**(a)** Replace the module doc (lines 1-14) with:

```tsx
/**
 * Profile — your display name (pencil → confirm), your handle (registered
 * state, or the claim flow), and your Identifier with a way to show it as a
 * QR (its own screen) or copy it.
 *
 * The registry, not this device, is the source of truth for which handle this
 * key holds: `profile_registered_handle` is only an offline cache, shown at
 * once and corrected the moment the reverse lookup answers, so a restored
 * wallet on a new device shows the right handle without having claimed
 * anything. A build with no registry configured for the selected chain says so
 * (`profile_handle_unavailable`) rather than pretending a check can succeed.
 *
 * No avatar uploader in this pass (spec: avatar is display-only), so the hero
 * is the plain profile disc rather than a dead "Add photo" control.
 */
```

**(b)** Replace imports (lines 26-28):

```tsx
import { makeIdentityClient, resolveIdentity } from '../resolveIdentity'
import { getHandleCertifierConfig } from '../../core/toolboxConfig'
import { checkHandleAvailability, registerHandle, type HandleAvailability } from '../../core/identity/handleCertificate'
```

with:

```tsx
import { makeIdentityClient, resolveIdentity } from '../resolveIdentity'
import { getHandleRegistryConfig } from '../../core/toolboxConfig'
import { bindOriginator } from '../../core/mandala/createRuntime'
import { isValidHandleFormat, parsePaymail } from '../../core/identity/handleRegistry/rules'
import type { ProfileSigner } from '../../core/identity/handleRegistry/profileCert'
import { createHandleRegistryClient, type AvailabilityReason } from '../../core/identity/handleRegistry/client'
import {
  changeHandle,
  registerHandle,
  resumePending,
  updateProfile,
  type RegistrationResult
} from '../../core/identity/handleRegistry/registration'

/** What the claim field can be saying. `checking` and `failed` are this
 * screen's own; the rest are the registry's own reasons. */
type HandleAvailability = 'checking' | 'available' | 'failed' | AvailabilityReason
```

**(c)** Replace the `HANDLE_KV_KEY` / `DISPLAY_NAME_KV_KEY` comments (lines 50-57) with:

```tsx
/** The full `handle@domain`, cached for a cold start. The registry decides. */
const HANDLE_KV_KEY = 'profile_registered_handle'
/**
 * The display name lives here on this device, and — once a handle is
 * registered — as a PUBLIC plaintext field of the profile certificate
 * (2026-09-18 ruling). The identity overlay's `name` is only a fallback for a
 * wallet that has never set one.
 */
const DISPLAY_NAME_KV_KEY = 'profile_display_name'
```

**(d)** Replace the state block and `certifier` line (lines 69-78) with:

```tsx
const [identityKey, setIdentityKey] = useState('')
const [displayName, setDisplayName] = useState('')
const [displayNameLoaded, setDisplayNameLoaded] = useState(false)
const [registeredPaymail, setRegisteredPaymail] = useState<string | null>(null)
const [changingHandle, setChangingHandle] = useState(false)
const [handleInput, setHandleInput] = useState('')
const [availability, setAvailability] = useState<HandleAvailability | 'idle'>('idle')
const [registering, setRegistering] = useState(false)
/** A journalled write that has not landed yet. Non-blocking, with a retry. */
const [finishing, setFinishing] = useState(false)

/**
 * Two strings, not the config object: `getHandleRegistryConfig` builds a
 * fresh `{ domain, url }` on every call, so memoising on the object would
 * hand `useMemo` a new identity every render — a new client every render, and
 * the mount effect below (which resumes a journal and asks the registry who
 * we are) re-running on every keystroke in either field.
 */
const registryDomain = getHandleRegistryConfig(selectedNetwork)?.domain
const registryUrl = getHandleRegistryConfig(selectedNetwork)?.url
const client = useMemo(
  () =>
    registryDomain && registryUrl
      ? createHandleRegistryClient({ pinned: { domain: registryDomain, url: registryUrl } })
      : null,
  [registryDomain, registryUrl]
)
/** Bound to the admin originator so signing our own profile never raises a
 * permission prompt (core/mandala/createRuntime.ts). */
const signer = useMemo(
  () => (wallet ? (bindOriginator(wallet, adminOriginator) as unknown as ProfileSigner) : null),
  [wallet, adminOriginator]
)
```

Add `useMemo` to the React import on line 15. Everywhere the rest of this task says `registry` as a truthiness test, read `registryDomain`; everywhere it interpolates `registry?.domain`, read `registryDomain ?? ''`.

**(e)** Replace the mount effect's handle read (lines 85-87):

```tsx
void storage?.getKeyValue(HANDLE_KV_KEY).then(v => {
  if (v) setRegisteredHandle(v)
})
```

with:

```tsx
// A cached value from before handles carried a domain names a handle on a
// registry we cannot identify, so it is worth nothing.
void storage?.getKeyValue(HANDLE_KV_KEY).then(v => {
  if (v && parsePaymail(v)) setRegisteredPaymail(v)
})
```

**(f)** After the overlay display-name fallback effect (which ends at line 114), insert:

```tsx
/**
 * Finish anything a previous run left journalled, then ask the registry what
 * it actually holds for this key. In that order: a resumed claim is the very
 * thing the lookup would otherwise report as absent.
 */
const [resumeNonce, setResumeNonce] = useState(0)
useEffect(() => {
  if (!client || !signer || !storage || !identityKey) return
  let cancelled = false
  void (async () => {
    const resumed = await resumePending({ client, signer, storage })
    if (cancelled) return
    setFinishing(resumed.kind === 'pending')
    const profile = await client.lookupIdentityKey(identityKey)
    if (cancelled) return
    const paymail = profile?.paymail ?? ''
    setRegisteredPaymail(paymail === '' ? null : paymail)
    void storage.setKeyValue(HANDLE_KV_KEY, paymail)
  })()
  return () => {
    cancelled = true
  }
}, [client, signer, storage, identityKey, resumeNonce])
```

**(g)** Replace `runCheck` (lines 116-135) with:

```tsx
const checkTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
/** Bumped per request; a reply for a superseded input is dropped. */
const checkNonce = useRef(0)
const runCheck = useCallback(
  (text: string) => {
    if (checkTimer.current) clearTimeout(checkTimer.current)
    checkNonce.current += 1
    const handle = text.trim().toLowerCase()
    if (!client || handle === '') {
      setAvailability('idle')
      return
    }
    setAvailability('checking')
    const nonce = checkNonce.current
    checkTimer.current = setTimeout(async () => {
      const result = await client.checkAvailability(handle)
      if (nonce !== checkNonce.current) return
      setAvailability(result.kind === 'unavailable' ? result.reason : result.kind)
    }, HANDLE_CHECK_DEBOUNCE_MS)
  },
  [client]
)
```

**(h)** Replace `onRegister` (lines 144-174) with:

```tsx
const onRegister = useCallback(async () => {
  if (!client || !signer || !storage || availability !== 'available') return
  const handle = handleInput.trim().toLowerCase()
  if (!isValidHandleFormat(handle)) return
  setRegistering(true)
  try {
    const deps = { client, signer, storage }
    const result: RegistrationResult = registeredPaymail
      ? await changeHandle(deps, { previousPaymail: registeredPaymail, handle, displayName })
      : await registerHandle(deps, { handle, displayName })
    await applyResult(result)
  } finally {
    setRegistering(false)
  }
  async function applyResult(result: RegistrationResult) {
    if (result.kind === 'registered' || result.kind === 'changed') {
      setRegisteredPaymail(result.paymail)
      void storage?.setKeyValue(HANDLE_KV_KEY, result.paymail)
      setChangingHandle(false)
      setHandleInput('')
      setAvailability('idle')
      setFinishing(false)
      showToast(t(result.kind === 'changed' ? 'profile_handle_changed' : 'profile_handle_registered'), {
        type: 'success'
      })
    } else if (result.kind === 'rolled_back') {
      // The new handle went to somebody else between the release and the
      // claim; the old one was taken back, so say which one is still yours.
      setRegisteredPaymail(result.paymail)
      void storage?.setKeyValue(HANDLE_KV_KEY, result.paymail)
      setChangingHandle(false)
      setHandleInput('')
      setAvailability('idle')
      setFinishing(false)
      showToast(
        t('profile_handle_rolled_back', { handle: `${handle}@${registryDomain ?? ''}`, previous: result.paymail }),
        { type: 'error' }
      )
    } else if (result.kind === 'pending') {
      setFinishing(true)
    } else if (result.kind === 'unavailable') {
      showToast(t('profile_handle_unavailable'), { type: 'error' })
    } else if (result.kind === 'rejected') {
      showToast(t('profile_handle_rejected'), { type: 'error' })
    } else if (result.kind === 'failed') {
      showToast(result.message, { type: 'error' })
    } else {
      // `updated` and `idle` cannot reach a Claim press today, but a result
      // kind with no branch is a button that spins and then silently does
      // nothing — the one outcome this screen must never have.
      showToast(t('profile_handle_rejected'), { type: 'error' })
    }
  }
}, [client, signer, storage, availability, handleInput, displayName, registeredPaymail, registryDomain, t])
```

**(i)** Replace `onSaveDisplayName` (lines 176-188) with:

```tsx
/**
 * Local first, always: the name is this device's to show even with no
 * network. When a handle is registered it is also a public field of the
 * profile certificate, so the registry gets a fresh one — best effort, and
 * never something the user has to wait on.
 */
const onSaveDisplayName = useCallback(
  async (next: string) => {
    const trimmed = next.trim()
    setDisplayName(trimmed)
    try {
      await storage?.setKeyValue(DISPLAY_NAME_KV_KEY, trimmed)
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), { type: 'error' })
    }
    if (!client || !signer || !storage || !registeredPaymail) return
    const result = await updateProfile(
      { client, signer, storage },
      { paymail: registeredPaymail, displayName: trimmed }
    )
    if (result.kind === 'pending') setFinishing(true)
  },
  [storage, client, signer, registeredPaymail]
)
```

**(j)** Replace the derived values and status table (lines 190-203) with:

```tsx
const handle = handleInput.trim().toLowerCase()
const paymailPreview = registryDomain ? `${handle}@${registryDomain}` : handle
const editingHandle = !!registryDomain && (!registeredPaymail || changingHandle)
const statusLine: Partial<Record<HandleAvailability, { text: string; color: string; icon: string }>> = {
  checking: { text: t('profile_handle_checking'), color: colors.textSecondary, icon: 'time-outline' },
  available: {
    text: t('profile_handle_available', { handle: paymailPreview }),
    color: colors.success,
    icon: 'checkmark-circle'
  },
  taken: { text: t('profile_handle_taken', { handle: paymailPreview }), color: colors.error, icon: 'close-circle' },
  too_similar: {
    text: t('profile_handle_too_similar', { handle: paymailPreview }),
    color: colors.error,
    icon: 'close-circle'
  },
  reserved: {
    text: t('profile_handle_reserved', { handle: paymailPreview }),
    color: colors.error,
    icon: 'close-circle'
  },
  cooldown: {
    text: t('profile_handle_cooldown', { handle: paymailPreview }),
    color: colors.warning,
    icon: 'time-outline'
  },
  invalid: { text: t('profile_handle_invalid'), color: colors.warning, icon: 'alert-circle' }
}
const status = availability === 'idle' ? undefined : statusLine[availability]
const canClaim = availability === 'available' && !registering
```

**(k)** In the render, replace the `certifier` / `registeredHandle` references in the Handle section:

- line 249: `registeredHandle && !changingHandle` → `registeredPaymail && !changingHandle`
- line 251: `!certifier && !registeredHandle` → `!registryDomain && !registeredPaymail`
- lines 255-257: `@{registeredHandle}` → `{registeredPaymail}`
- line 263: `{!!certifier && (` → `{!!registryDomain && (`
- line 293: `{registeredHandle && (` → `{registeredPaymail && (`
- line 378: `{handle ? t('profile_handle_claim', { handle }) : t('profile_handle_register_action')}` → `{handle ? t('profile_handle_claim', { handle: paymailPreview }) : t('profile_handle_register_action')}`. The button and the status line directly above it now name the same thing; Task 7 has already dropped the `@` this key used to prepend.

**(l)** Replace the `@` prefix (lines 277) with nothing, and add the domain suffix after the `TextInput` (after line 287):

```tsx
;<TextInput
  value={handleInput}
  onChangeText={onChangeHandle}
  placeholder={t('profile_handle_placeholder')}
  placeholderTextColor={colors.textTertiary}
  autoCapitalize="none"
  autoCorrect={false}
  autoFocus={changingHandle}
  style={[styles.handleInput, { color: colors.textPrimary }]}
/>
{
  /* Fixed, not typed: a handle is only ever claimed on the
                    domain this build is configured for. */
}
;<Text style={[styles.atSign, { color: colors.textTertiary }]}>@{registryDomain}</Text>
```

**(m)** Insert the finishing card immediately after the `</GroupedSection>` that closes the Handle section (line 337):

```tsx
{
  finishing && (
    <View style={[styles.callout, { backgroundColor: colors.fillTertiary, borderColor: colors.separator }]}>
      <Ionicons name="time-outline" size={16} color={colors.textSecondary} />
      <Text style={[styles.calloutText, { color: colors.textSecondary }]}>{t('profile_handle_pending')}</Text>
      <PressableScale
        onPress={() => setResumeNonce(n => n + 1)}
        haptic="tap"
        style={styles.retryBtn}
        accessibilityRole="button"
      >
        <Text style={[styles.retryLabel, { color: colors.accent }]}>{t('retry')}</Text>
      </PressableScale>
    </View>
  )
}
```

**(n)** Replace the two remaining `registeredHandle` uses below that: line 339 `{editingHandle && registeredHandle && (` → `{editingHandle && registeredPaymail && (`, line 343 `{ handle: registeredHandle }` → `{ handle: registeredPaymail }`, and line 356 `handle: registeredHandle ?? ''` → `handle: registeredPaymail ?? ''`.

Both of those now carry a full `handle@domain` into a sentence that used to prepend its own `@`. Task 7 has already removed that sigil from `profile_handle_replace_warning` (line 343) in all 12 locales; line 356 is the `/identifier` route param, and Task 10 removes the sigil `IdentifierScreen` prepends to it.

- [ ] **Step 4: Delete the certifier**

```bash
cd /Users/personal/git/bsv-wallet && rm packages/expo-wallet-toolbox/core/identity/handleCertificate.ts packages/expo-wallet-toolbox/__tests__/identity/handleCertificate.test.ts
```

In `core/toolboxConfig.ts`, delete: the `HandleCertifierConfig` interface and its doc comment (lines 29-35), the `handleCertifier` member of `ToolboxConfig` and its doc (lines 92-100), the `handleCertifier` line of `ResolvedConfig` (115), the `handleCertifier:` assignment in `configureToolbox` (161), and the whole `getHandleCertifierConfig` function with its doc (212-225). The stray doc comment at lines 18-28 belongs to `MandalaEndpointConfig` — move it back to sit directly above it.

In `__tests__/toolboxConfig.test.ts`, delete the `getHandleCertifierConfig` import and its whole `describe` block (lines 86-120).

- [ ] **Step 5: Run it, expect pass**

```bash
cd /Users/personal/git/bsv-wallet && npx jest packages/expo-wallet-toolbox/__tests__/ui/profileScreen.test.tsx packages/expo-wallet-toolbox/__tests__/toolboxConfig.test.ts packages/expo-wallet-toolbox/__tests__/packageResolution.test.ts
```

Expected: PASS. Then confirm nothing still references the deleted module:

```bash
cd /Users/personal/git/bsv-wallet && grep -rn "handleCertifier\|handleCertificate\|HANDLE_CERT_TYPE" packages/expo-wallet-toolbox app --include=*.ts --include=*.tsx
```

Expected: no output.

- [ ] **Step 6: Lint and format**

```bash
cd /Users/personal/git/bsv-wallet && npx prettier --check packages/expo-wallet-toolbox/ui/screens/ProfileScreen.tsx packages/expo-wallet-toolbox/core/toolboxConfig.ts packages/expo-wallet-toolbox/__tests__/toolboxConfig.test.ts packages/expo-wallet-toolbox/__tests__/ui/profileScreen.test.tsx && npx eslint packages/expo-wallet-toolbox/ui/screens/ProfileScreen.tsx packages/expo-wallet-toolbox/core/toolboxConfig.ts packages/expo-wallet-toolbox/__tests__/ui/profileScreen.test.tsx
```

Expected: clean.

---

## Task 9: Pay — the registry tier, and a spinner that stops hiding the list

Two changes that have to land together. `RecipientField` today renders **only** a spinner while `isSearching`, so the "instant" contacts tier is already invisible for the whole 400 ms debounce; a registry tier would inherit that. Moving the spinner to a footer is what makes a third tier worth having.

**Files:**

- Modify: `packages/expo-wallet-toolbox/ui/components/pay/RecipientField.tsx`
- Modify: `packages/expo-wallet-toolbox/ui/components/pay/UniversalSend.tsx`
- Create (test): `packages/expo-wallet-toolbox/__tests__/ui/recipientField.test.tsx`
- Modify (test): `packages/expo-wallet-toolbox/__tests__/ui/universalSend.test.tsx`

**Interfaces — produced here, consumed by Task 10:**

```ts
// RecipientField.tsx
export interface RecipientRow extends DisplayableIdentity {
  readonly secondaryLine?: string
}
// RecipientFieldProps.searchResults becomes: readonly RecipientRow[]
// RecipientFieldProps.onSelectIdentity becomes: (i: RecipientRow) => void
```

Consumes, verbatim: `getHandleRegistryConfig` (Task 3), `createHandleRegistryClient` / `HandleRegistryClient` (Task 5), `RegistryProfile` (Task 2), `classifyRecipientInput` (existing, `core/pay/rails`), `identity_search_unavailable` / `pay_trust_handle_attested` / `contacts_recent` (existing i18n).

- [ ] **Step 1: Write the failing RecipientField test**

Create `packages/expo-wallet-toolbox/__tests__/ui/recipientField.test.tsx`:

```tsx
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }))

import React from 'react'
import { render } from '@testing-library/react-native'
import { ThemeProvider, lightColors } from '@bsv/expo-wallet-toolbox'
import RecipientField, { type RecipientRow } from '../../ui/components/pay/RecipientField'

const row = (over: Partial<RecipientRow> = {}): RecipientRow => ({
  identityKey: '02' + 'ab'.repeat(32),
  name: 'Dee K',
  avatarURL: '',
  abbreviatedKey: '02ab…abab',
  badgeIconURL: '',
  badgeLabel: '',
  badgeClickURL: '',
  ...over
})

const draw = (over: Partial<React.ComponentProps<typeof RecipientField>> = {}) =>
  render(
    <ThemeProvider>
      <RecipientField
        selectedIdentity={null}
        inputText="dee"
        target={null}
        inlineError={null}
        isSearching={false}
        searchResults={[]}
        colors={lightColors}
        t={((key: string) => key) as never}
        onChangeText={jest.fn()}
        onSelectIdentity={jest.fn()}
        onClear={jest.fn()}
        onOpenScanner={jest.fn()}
        {...over}
      />
    </ThemeProvider>
  )

describe('the dropdown while a remote tier is loading', () => {
  it('keeps the rows on screen and puts the spinner underneath them', () => {
    const s = draw({ isSearching: true, searchResults: [row()] })
    expect(s.getByText('Dee K')).toBeTruthy()
    expect(s.getByText('searching')).toBeTruthy()
  })

  it('still shows the spinner alone when there is nothing yet', () => {
    const s = draw({ isSearching: true, searchResults: [] })
    expect(s.getByText('searching')).toBeTruthy()
  })

  it('drops the spinner once every tier has settled', () => {
    const s = draw({ isSearching: false, searchResults: [row()] })
    expect(s.queryByText('searching')).toBeNull()
  })
})

describe('the second line of a row', () => {
  it('is the caller-supplied one when there is one', () => {
    const s = draw({ searchResults: [row({ secondaryLine: 'dee@deggen.com' })] })
    expect(s.getByText('dee@deggen.com')).toBeTruthy()
    expect(s.queryByText('02ab…abab')).toBeNull()
  })

  it('falls back to the abbreviated key, as it always did', () => {
    const s = draw({ searchResults: [row()] })
    expect(s.getByText('02ab…abab')).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run it, expect the named failure**

```bash
cd /Users/personal/git/bsv-wallet && npx jest packages/expo-wallet-toolbox/__tests__/ui/recipientField.test.tsx
```

Expected: FAIL — `RecipientRow` is not exported, and "keeps the rows on screen" fails because `Dee K` is not rendered while `isSearching`.

- [ ] **Step 3: Edit `RecipientField.tsx`**

**(a)** Above `interface RecipientFieldProps` (line 34), insert:

```tsx
/**
 * A dropdown row. `DisplayableIdentity` is a fixed seven-string SDK interface
 * with nowhere to put a handle, so the one line this list needs that it does
 * not carry is added here — supplied by the caller, because only the caller
 * knows whether a row came from a contact, the registry or the overlay.
 */
export interface RecipientRow extends DisplayableIdentity {
  /** Drawn under the name: a registry row's full `handle@domain`, a contact's
   * `cachedHandle`. Falls back to the abbreviated identity key. */
  readonly secondaryLine?: string
}
```

**(b)** In `RecipientFieldProps`, change line 40 `readonly searchResults: DisplayableIdentity[]` to `readonly searchResults: RecipientRow[]`, and line 44 `readonly onSelectIdentity: (i: DisplayableIdentity) => void` to `readonly onSelectIdentity: (i: RecipientRow) => void`.

**(c)** Replace the whole dropdown block (lines 184-236) with:

```tsx
{
  showDropdown && (
    <View
      style={[styles.searchResults, { backgroundColor: colors.backgroundSecondary, borderColor: colors.separator }]}
    >
      {!!recentLabel && inputText.trim() === '' && (
        <Text style={[styles.recentLabel, { color: colors.textTertiary }]}>{recentLabel}</Text>
      )}
      {searchResults.map((identity, idx) => (
        <TouchableOpacity
          key={identity.identityKey + idx}
          onPress={() => onSelectIdentity(identity)}
          style={[
            styles.searchResultRow,
            (idx < searchResults.length - 1 || isSearching) && {
              borderBottomWidth: StyleSheet.hairlineWidth,
              borderBottomColor: colors.separator
            }
          ]}
        >
          <View style={styles.searchAvatar}>
            <ContactSigil
              identityKey={identity.identityKey}
              avatarUrl={identity.avatarURL || undefined}
              size={32}
              radius={16}
            />
          </View>
          <View style={styles.searchResultInfo}>
            <Text style={[styles.searchResultName, { color: colors.textPrimary }]} numberOfLines={1}>
              {identity.name || t('unknown')}
            </Text>
            <Text style={[styles.searchResultKey, { color: colors.textSecondary }]} numberOfLines={1}>
              {identity.secondaryLine || identity.abbreviatedKey || `${identity.identityKey.slice(0, 20)}...`}
            </Text>
          </View>
          {identity.badgeLabel ? (
            <View style={[styles.badge, { backgroundColor: colors.fill }]}>
              <Text style={[styles.badgeText, { color: colors.accent }]}>{identity.badgeLabel}</Text>
            </View>
          ) : null}
        </TouchableOpacity>
      ))}
      {/* A footer, not a replacement: the instant tier is already on screen
              and hiding it for the remote tier's whole debounce made "instant"
              a claim the user never saw. */}
      {isSearching && (
        <View style={styles.searchLoading}>
          <ActivityIndicator size="small" color={colors.accent} />
          <Text style={[styles.searchLoadingText, { color: colors.textSecondary }]}>{t('searching')}</Text>
        </View>
      )}
    </View>
  )
}
```

- [ ] **Step 4: Run the RecipientField test, expect pass**

```bash
cd /Users/personal/git/bsv-wallet && npx jest packages/expo-wallet-toolbox/__tests__/ui/recipientField.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Extend the UniversalSend test**

In `__tests__/ui/universalSend.test.tsx`, replace the `@bsv/expo-wallet-toolbox` mock (lines 46-56 — the `MockStorage` type through the closing `}))`) with:

```tsx
// wallet null: no IdentityClient, no PeerPay client, no outbox read. The form's
// composition does not depend on any of them. `storage` starts undefined so the
// outbox stays unread; only the send-gating test that needs a stuck entry sets it.
// `walletUserId` stays null by default so neither the contacts tier nor the
// registry tier fires for the composition tests.
type MockStorage = { getKeyValue: (k: string) => Promise<string | undefined>; setKeyValue: () => Promise<void> }
let mockStorage: MockStorage | undefined
let mockWalletUserId: number | null = null
let mockNetwork: 'main' | 'test' | 'teratest' = 'main'
const registrySearch = jest.fn()
jest.mock('../../core/identity/handleRegistry/client', () => ({
  createHandleRegistryClient: () => ({ domain: 'deggen.com', search: registrySearch })
}))
jest.mock('@bsv/expo-wallet-toolbox', () => ({
  ...jest.requireActual('@bsv/expo-wallet-toolbox'),
  useWallet: () => ({
    managers: null,
    adminOriginator: 'admin.com',
    storage: mockStorage,
    walletUserId: mockWalletUserId,
    selectedNetwork: mockNetwork
  }),
  useWalletManagers: () => ({ managers: null, adminOriginator: 'admin.com', storage: mockStorage })
}))
```

Add `configureToolbox, resetToolboxConfig` to the existing `@bsv/expo-wallet-toolbox` import on **line 61**, then extend the existing `beforeEach` (line 103) and add an `afterEach` beside it:

```tsx
beforeEach(async () => {
  mockStorage = undefined
  mockWalletUserId = null
  mockNetwork = 'main'
  registrySearch.mockReset()
  resetToolboxConfig()
  await AsyncStorage.clear()
})
afterEach(() => resetToolboxConfig())
```

Then **nest** the block below inside the existing `describe('UniversalSend', …)` — insert it immediately before that describe's closing `})`, which is the last line of the file (line 240). It must not go after it: the resets above belong to that describe's `beforeEach`, and a sibling block would run none of them. The root jest config sets neither `clearMocks` nor `resetMocks`, so `registrySearch` would accumulate calls across cases and `expect(registrySearch).toHaveBeenCalledTimes(1)` / `.not.toHaveBeenCalled()` would both become order-dependent.

```tsx
/**
 * The registry tier. Contacts are local and instant, the registry is one
 * debounced request, the overlay is another — and all three land in one list
 * without any of them hiding the others.
 */
describe('registry tier', () => {
  const REGISTRY_KEY = '03' + 'cd'.repeat(32)
  const withRegistry = () => {
    mockWalletUserId = 1
    mockNetwork = 'test'
    configureToolbox({
      backupUrl: null,
      handleRegistry: { test: { domain: 'deggen.com', url: 'https://registry.example' } }
    })
  }
  const profile = (over: Record<string, unknown> = {}) => ({
    identityKey: REGISTRY_KEY,
    paymail: 'dee@deggen.com',
    handle: 'dee',
    domain: 'deggen.com',
    displayName: 'Dee K',
    issuedAt: new Date(),
    certificate: {},
    ...over
  })

  it('offers a registry hit with its name, its full paymail and the registered badge', async () => {
    withRegistry()
    registrySearch.mockResolvedValue([profile()])
    const s = draw()
    fireEvent.changeText(s.getByPlaceholderText('recipient_placeholder'), 'dee')
    await waitFor(() => expect(s.getByText('Dee K')).toBeTruthy())
    expect(s.getByText('dee@deggen.com')).toBeTruthy()
    expect(s.getByText('pay_trust_handle_attested')).toBeTruthy()
    expect(registrySearch).toHaveBeenCalledWith('dee')
  })

  it('falls back to the handle when the profile carries no public name', async () => {
    withRegistry()
    registrySearch.mockResolvedValue([profile({ displayName: undefined })])
    const s = draw()
    fireEvent.changeText(s.getByPlaceholderText('recipient_placeholder'), 'dee')
    await waitFor(() => expect(s.getByText('dee')).toBeTruthy())
  })

  /**
   * Also the guard against the effect re-running on every render: if the
   * client were memoised on the config OBJECT it would have a new identity
   * each render, the effect's cleanup would clear the timer before it could
   * fire, and this case would time out rather than see one call.
   */
  it('debounces: one request for a word typed one letter at a time', async () => {
    withRegistry()
    registrySearch.mockResolvedValue([])
    const s = draw()
    const input = s.getByPlaceholderText('recipient_placeholder')
    fireEvent.changeText(input, 'd')
    fireEvent.changeText(input, 'de')
    fireEvent.changeText(input, 'dee')
    await waitFor(() => expect(registrySearch).toHaveBeenCalledTimes(1))
    expect(registrySearch).toHaveBeenCalledWith('dee')
  })

  it('leaves the rows it already has on screen while the next query is in flight', async () => {
    withRegistry()
    registrySearch.mockResolvedValue([profile()])
    const s = draw()
    const input = s.getByPlaceholderText('recipient_placeholder')
    fireEvent.changeText(input, 'dee')
    await waitFor(() => expect(s.getByText('Dee K')).toBeTruthy())
    // The next keystroke must not blank the list: the footer spinner says a
    // tier is still loading, and the rows already found stay pickable.
    registrySearch.mockReturnValue(new Promise(() => {}))
    fireEvent.changeText(input, 'deeg')
    expect(s.getByText('Dee K')).toBeTruthy()
  })

  it('never fires for a pasted identity key or an address', async () => {
    withRegistry()
    registrySearch.mockResolvedValue([])
    const s = draw()
    fireEvent.changeText(s.getByPlaceholderText('recipient_placeholder'), KEY)
    await waitFor(() => expect(s.getByText('valid_identity_key')).toBeTruthy())
    fireEvent.changeText(s.getByPlaceholderText('recipient_placeholder'), ADDRESS)
    await waitFor(() => expect(s.getByText('valid_bsv_address')).toBeTruthy())
    expect(registrySearch).not.toHaveBeenCalled()
  })

  it('never fires for one character, or with no registry on this chain', async () => {
    withRegistry()
    registrySearch.mockResolvedValue([])
    const short = draw()
    fireEvent.changeText(short.getByPlaceholderText('recipient_placeholder'), 'd')
    await waitFor(() => expect(short.getByPlaceholderText('recipient_placeholder')).toBeTruthy())
    expect(registrySearch).not.toHaveBeenCalled()

    resetToolboxConfig()
    const unconfigured = draw()
    fireEvent.changeText(unconfigured.getByPlaceholderText('recipient_placeholder'), 'dee')
    await waitFor(() => expect(unconfigured.getByPlaceholderText('recipient_placeholder')).toBeTruthy())
    expect(registrySearch).not.toHaveBeenCalled()
  })

  it('raises the existing search notice when the registry cannot be reached, and drops it on the next step', async () => {
    withRegistry()
    jest.spyOn(console, 'error').mockImplementation(() => {})
    registrySearch.mockRejectedValue(new Error('offline'))
    const s = draw()
    fireEvent.changeText(s.getByPlaceholderText('recipient_placeholder'), 'dee')
    await waitFor(() => expect(s.getByText('identity_search_unavailable')).toBeTruthy())
    fireEvent.changeText(s.getByPlaceholderText('recipient_placeholder'), ADDRESS)
    await waitFor(() => expect(s.getByText('valid_bsv_address')).toBeTruthy())
    fireEvent.press(s.getByText('pay_step_continue'))
    await waitFor(() => expect(s.queryByText('identity_search_unavailable')).toBeNull())
  })

  it('selecting a registry row goes down the existing handle path', async () => {
    withRegistry()
    registrySearch.mockResolvedValue([profile()])
    const s = draw()
    fireEvent.changeText(s.getByPlaceholderText('recipient_placeholder'), 'dee')
    await waitFor(() => expect(s.getByText('Dee K')).toBeTruthy())
    fireEvent.press(s.getByText('Dee K'))
    await waitFor(() => expect(s.getByText('pay_step_continue')).toBeTruthy())
  })
})
```

- [ ] **Step 6: Run it, expect the named failure**

```bash
cd /Users/personal/git/bsv-wallet && npx jest packages/expo-wallet-toolbox/__tests__/ui/universalSend.test.tsx
```

Expected: FAIL — the new block fails with `registrySearch` never called; every pre-existing test still passes.

- [ ] **Step 7: Edit `UniversalSend.tsx`**

**(a)** Add to the `'@bsv/expo-wallet-toolbox'` import list (lines 47-72), in alphabetical position: `classifyRecipientInput`, `getHandleRegistryConfig`. After the `import type { ContactRow }` line (46), add:

```tsx
import { createHandleRegistryClient } from '../../../core/identity/handleRegistry/client'
import type { RegistryProfile } from '../../../core/identity/handleRegistry/profileCert'
import type { RecipientRow } from './RecipientField'
```

and change line 35 to `import RecipientField, { type RecipientRow } from './RecipientField'` instead if you prefer one import — either is fine, but do not import the same module twice.

**(b)** Next to `SEARCH_DEBOUNCE_MS`'s two independent twins, add near the top of the component file (after `loadExpoRouter`, line 125):

```tsx
/** The registry's own debounce. Deliberately a third constant rather than a
 * shared one: `useRecipientInput`'s overlay timer and `ProfileScreen`'s
 * availability timer are separate decisions that happen to agree today. */
const REGISTRY_SEARCH_DEBOUNCE_MS = 400
```

**(c)** Change line 294 `const { walletUserId } = useWallet()` to:

```tsx
const { walletUserId, selectedNetwork } = useWallet()
```

**(d)** After `const [contactMatches, setContactMatches] = useState<ContactRow[]>([])` (line 311), add:

```tsx
const [registryMatches, setRegistryMatches] = useState<RegistryProfile[]>([])
const [registrySearching, setRegistrySearching] = useState(false)
const [registryError, setRegistryError] = useState(false)
/**
 * Two strings, not the config object. `getHandleRegistryConfig` builds a
 * fresh `{ domain, url }` on every call, so memoising on the object gives the
 * client a new identity every render, which gives the effect below a changed
 * dependency every render — and its own `setState` then schedules the next
 * render. That is an unbreakable loop ("Maximum update depth exceeded") in
 * which the 400 ms debounce is also cleared before it can ever fire.
 */
const registryDomain = getHandleRegistryConfig(selectedNetwork)?.domain
const registryUrl = getHandleRegistryConfig(selectedNetwork)?.url
const registryClient = useMemo(
  () =>
    registryDomain && registryUrl
      ? createHandleRegistryClient({ pinned: { domain: registryDomain, url: registryUrl } })
      : null,
  [registryDomain, registryUrl]
)
```

**(e)** After the contacts effect (which ends at line 485), insert:

```tsx
/**
 * The registry tier: people who can be paid by name. Its own timer — the
 * contacts effect above has none, which is right for a local SQLite read and
 * would be one request per keystroke here — and its own notice, so a
 * registry outage never takes the contacts already on screen with it.
 *
 * It never fires for text that already resolved to a key or an address
 * (`classifyRecipientInput`), for fewer than two characters (shorter than
 * the registry's own minimum), with no registry configured, or before the
 * wallet user is known.
 */
useEffect(() => {
  const query = recipient.inputText.trim()
  const routable =
    !!registryClient &&
    typeof walletUserId === 'number' &&
    !recipient.selectedIdentity &&
    !target &&
    classifyRecipientInput(query).kind === 'search' &&
    query.length >= 2
  if (!routable) {
    // Only here, and only when there is something to clear: an unconditional
    // `setRegistryMatches([])` hands React a new array reference on every
    // run, which it can never bail out of.
    setRegistryMatches(rows => (rows.length === 0 ? rows : []))
    setRegistrySearching(false)
    return
  }
  let cancelled = false
  setRegistrySearching(true)
  const timer = setTimeout(async () => {
    try {
      const rows = await registryClient.search(query)
      if (cancelled) return
      setRegistryMatches(rows)
      setRegistryError(false)
    } catch (error) {
      console.error('Handle registry search error:', error)
      if (cancelled) return
      setRegistryMatches([])
      setRegistryError(true)
    } finally {
      if (!cancelled) setRegistrySearching(false)
    }
  }, REGISTRY_SEARCH_DEBOUNCE_MS)
  return () => {
    cancelled = true
    clearTimeout(timer)
  }
}, [registryClient, walletUserId, recipient.inputText, recipient.selectedIdentity, target])
```

**(f)** Replace `mergedSearchResults` (lines 486-498) with:

```tsx
const mergedSearchResults = useMemo((): RecipientRow[] => {
  const contactIdentities: RecipientRow[] = contactMatches.map(c => ({
    identityKey: c.identityKey,
    name: c.name,
    avatarURL: c.cachedAvatarUrl ?? '',
    abbreviatedKey: abbreviateKey(c.identityKey),
    badgeIconURL: '',
    badgeLabel: '',
    badgeClickURL: '',
    ...(c.cachedHandle ? { secondaryLine: c.cachedHandle } : {})
  }))
  const seen = new Set(contactIdentities.map(c => c.identityKey))
  // Contacts, then the registry, then the overlay. A person the user has
  // already labelled is shown with that label; a registry row states the
  // name the owner published and the handle it belongs to.
  const registryIdentities: RecipientRow[] = registryMatches
    .filter(p => !seen.has(p.identityKey))
    .map(p => {
      seen.add(p.identityKey)
      return {
        identityKey: p.identityKey,
        name: p.displayName || p.handle,
        avatarURL: '',
        abbreviatedKey: abbreviateKey(p.identityKey),
        badgeIconURL: '',
        badgeLabel: t('pay_trust_handle_attested'),
        badgeClickURL: '',
        secondaryLine: p.paymail
      }
    })
  return [...contactIdentities, ...registryIdentities, ...recipient.searchResults.filter(r => !seen.has(r.identityKey))]
}, [contactMatches, registryMatches, recipient.searchResults, t])

/** The handle of the row the user picked, so the success screen's
 * "Save as contact" can carry it into the new contact. */
const selectedHandleRef = useRef<string | undefined>(undefined)
const onSelectIdentity = (identity: RecipientRow) => {
  selectedHandleRef.current = identity.secondaryLine?.includes('@') ? identity.secondaryLine : undefined
  recipient.selectIdentity(identity)
}
const onClearRecipient = () => {
  selectedHandleRef.current = undefined
  recipient.clearRecipient()
}
```

**(g)** Line 375: change the `offerAddContact` state type to `useState<{ identityKey: string; name?: string; handle?: string } | null>(null)`, and line 527 to:

```tsx
if (!cancelled && !c) setOfferAddContact({ identityKey, name: sent.recipient, handle: selectedHandleRef.current })
```

**(h)** Replace the step-change effect (lines 1074-1076) with:

```tsx
useEffect(() => {
  onStepChange?.(step)
  // Neither search notice belongs on the amount or review screen: both are
  // about a recipient field that is no longer on screen.
  setRegistryError(false)
  recipient.clearSearchError()
}, [step, onStepChange, recipient.clearSearchError])
```

**(i)** After the existing `recipient.searchError` banner (lines 1102-1108), insert:

```tsx
{
  registryError && (
    <ResultBanner
      result={{ type: 'error', message: t('identity_search_unavailable') }}
      onDismiss={() => setRegistryError(false)}
      colors={colors}
    />
  )
}
```

**(j)** In the `<RecipientField ... />` element (lines 1113-1143), change three props:

```tsx
              isSearching={recipient.isSearching || registrySearching}
              onSelectIdentity={onSelectIdentity}
              onClear={onClearRecipient}
```

- [ ] **Step 8: Run it, expect pass**

```bash
cd /Users/personal/git/bsv-wallet && npx jest packages/expo-wallet-toolbox/__tests__/ui/universalSend.test.tsx packages/expo-wallet-toolbox/__tests__/ui/recipientField.test.tsx packages/expo-wallet-toolbox/__tests__/ui/tokenPay.test.tsx packages/expo-wallet-toolbox/__tests__/pay/useRecipientInput.test.ts
```

Expected: PASS, including every pre-existing UniversalSend case unchanged.

- [ ] **Step 9: Lint and format**

```bash
cd /Users/personal/git/bsv-wallet && npx prettier --check packages/expo-wallet-toolbox/ui/components/pay/RecipientField.tsx packages/expo-wallet-toolbox/ui/components/pay/UniversalSend.tsx packages/expo-wallet-toolbox/__tests__/ui/recipientField.test.tsx packages/expo-wallet-toolbox/__tests__/ui/universalSend.test.tsx && npx eslint packages/expo-wallet-toolbox/ui/components/pay/RecipientField.tsx packages/expo-wallet-toolbox/ui/components/pay/UniversalSend.tsx
```

Expected: clean.

---

## Task 10: Contacts — a handle worth saving, and a refresh that stops blanking it

`cachedHandle` has been a fully wired column with no production writer: `createContact` is never passed one, and the one `refreshContactCache` call site passes only `cachedAvatarUrl`. That has been harmless only because nothing wrote the column — the moment something does, the avatar refresh wipes it, because `refreshContactCache` replaces all three cache columns in one UPDATE. So the writer and the fix land together.

**Files:**

- Create: `packages/expo-wallet-toolbox/core/contacts/contactCache.ts`
- Modify: `packages/expo-wallet-toolbox/ui/screens/NewContactScreen.tsx`
- Modify: `packages/expo-wallet-toolbox/ui/screens/ContactScreen.tsx`
- Modify: `packages/expo-wallet-toolbox/ui/components/pay/UniversalSend.tsx` (one line)
- Modify: `packages/expo-wallet-toolbox/ui/screens/ContactsScreen.tsx` (one line)
- Modify: `packages/expo-wallet-toolbox/ui/screens/IdentifierScreen.tsx` (one line)
- Modify: `packages/expo-wallet-toolbox/core/index.ts` (one export)
- Create (test): `packages/expo-wallet-toolbox/__tests__/contacts/contactCache.test.ts`
- Create (test): `packages/expo-wallet-toolbox/__tests__/ui/newContactHandle.test.tsx`
- Create (test): `packages/expo-wallet-toolbox/__tests__/ui/contactScreen.test.tsx`

**Interfaces — produced here:**

```ts
export interface ContactCache {
  cachedHandle?: string
  cachedAvatarUrl?: string
  cachedCertifier?: string
}
/** null when nothing changed; otherwise the COMPLETE row to write. */
export function mergeContactCache(
  current: ContactCache,
  learned: { cachedHandle?: string; cachedAvatarUrl?: string }
): ContactCache | null
```

Consumes, verbatim: `parsePaymail` (Task 1), `getHandleRegistryConfig` (Task 3), `createHandleRegistryClient` and **`lookupProfile` / `ProfileLookup`** (Task 5), the `handle` route param added here, and `RecipientRow.secondaryLine` / `offerAddContact.handle` (Task 9).

Three things to get right, in the order they bite:

1. **`lookupIdentityKey` is the wrong method for a writer.** It answers `null` for a 404 _and_ for every timeout, dead network, unresolvable foreign domain and unbelievable answer — its documented contract. `mergeContactCache` reads `''` as "looked, and there is none" and clears the column, so opening a contact while offline would permanently wipe the handle the wallet had cached. The refresh therefore uses `lookupProfile`, and **omits the `cachedHandle` key entirely unless the registry actually answered**.
2. **`/contact/add` is a deep-linkable route.** Its `handle` param is a string from outside the app, and it lands under a shield icon and `contact_handle_caption` ("Their registered handle · only they can change it"). Anything that is not a valid `handle@domain` is not stored.
3. **`cachedHandle` now carries its own domain**, so every `@` this codebase prepends to it has to go — `ContactScreen.tsx:149`, `ContactsScreen.tsx:230`, and `IdentifierScreen.tsx:139` (which renders the `handle` route param that `ProfileScreen.tsx:356` now fills with a full paymail). Neither `ContactsScreen` nor `IdentifierScreen` has a test file today; Step 7's grep is what holds the line for those two.

- [ ] **Step 1: Write the failing tests**

Create `packages/expo-wallet-toolbox/__tests__/contacts/contactCache.test.ts`:

```ts
import { mergeContactCache } from '../../core/contacts/contactCache'

describe('mergeContactCache', () => {
  it('keeps a column this pass learned nothing about', () => {
    expect(mergeContactCache({ cachedHandle: 'dee@deggen.com' }, { cachedAvatarUrl: 'https://a/x.png' })).toEqual({
      cachedHandle: 'dee@deggen.com',
      cachedAvatarUrl: 'https://a/x.png',
      cachedCertifier: undefined
    })
  })

  it('treats an empty learned value as "there is none", and clears it', () => {
    expect(
      mergeContactCache({ cachedHandle: 'dee@deggen.com', cachedAvatarUrl: 'https://a/x.png' }, { cachedHandle: '' })
    ).toEqual({
      cachedHandle: undefined,
      cachedAvatarUrl: 'https://a/x.png',
      cachedCertifier: undefined
    })
  })

  it('never touches a certifier it was not given', () => {
    const merged = mergeContactCache(
      { cachedCertifier: '02aa', cachedHandle: 'old@deggen.com' },
      { cachedHandle: 'dee@deggen.com' }
    )
    expect(merged?.cachedCertifier).toBe('02aa')
  })

  it('answers null when there is nothing to write', () => {
    const current = { cachedHandle: 'dee@deggen.com', cachedAvatarUrl: 'https://a/x.png' }
    expect(
      mergeContactCache(current, { cachedHandle: 'dee@deggen.com', cachedAvatarUrl: 'https://a/x.png' })
    ).toBeNull()
    expect(mergeContactCache({}, {})).toBeNull()
  })
})
```

Create `packages/expo-wallet-toolbox/__tests__/ui/newContactHandle.test.tsx`:

```tsx
jest.mock('expo-haptics', () => ({
  selectionAsync: jest.fn(() => Promise.resolve()),
  impactAsync: jest.fn(() => Promise.resolve()),
  notificationAsync: jest.fn(() => Promise.resolve()),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' }
}))
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }))
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children
}))
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => {} }
}))

let routeParams: Record<string, string> = {}
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
  useLocalSearchParams: () => routeParams
}))
jest.mock('../../ui/components/ui/Toast', () => ({ showToast: jest.fn() }))
jest.mock('../../core/contacts/contactActivity', () => ({ getContactActivity: async () => [] }))

const createContact = jest.fn()
jest.mock('../../ui/hooks/useContactsStore', () => ({ useContactsStore: () => ({ createContact }) }))
jest.mock('@bsv/expo-wallet-toolbox', () => ({
  ...jest.requireActual('@bsv/expo-wallet-toolbox'),
  useWallet: () => ({ walletUserId: 1, managers: null, adminOriginator: 'admin.com', storage: undefined })
}))

import React from 'react'
import { fireEvent, render, waitFor } from '@testing-library/react-native'
import { ThemeProvider } from '@bsv/expo-wallet-toolbox'
import { NewContactScreen } from '../../ui/screens/NewContactScreen'

const KEY = '02' + 'ab'.repeat(32)
const draw = () =>
  render(
    <ThemeProvider>
      <NewContactScreen />
    </ThemeProvider>
  )

beforeEach(() => {
  jest.clearAllMocks()
  createContact.mockResolvedValue({})
  routeParams = {}
})

describe('a contact saved from a registry hit', () => {
  it('stores the handle it arrived with, and prefills the public name as an editable one', async () => {
    routeParams = { identityKey: KEY, name: 'Dee K', handle: 'Dee@Deggen.com', source: 'pay' }
    const s = draw()
    expect(s.getByText('dee@deggen.com')).toBeTruthy()
    fireEvent.changeText(s.getByPlaceholderText('contact_new_title'), 'Dee from the pub')
    fireEvent.press(s.getByText('contact_save'))
    await waitFor(() =>
      expect(createContact).toHaveBeenCalledWith({
        userId: 1,
        identityKey: KEY,
        name: 'Dee from the pub',
        cachedHandle: 'dee@deggen.com',
        source: 'pay'
      })
    )
  })

  it('saves no handle when none arrived, and says so', async () => {
    routeParams = { identityKey: KEY, name: 'Dee K', source: 'qr' }
    const s = draw()
    expect(s.getByText('contact_no_handle_registered')).toBeTruthy()
    fireEvent.press(s.getByText('contact_save'))
    await waitFor(() =>
      expect(createContact).toHaveBeenCalledWith(expect.not.objectContaining({ cachedHandle: expect.anything() }))
    )
  })

  /**
   * `/contact/add` is deep-linkable, so this param is untrusted input, and
   * what it becomes is shown under a shield and the words "only they can
   * change it". A string that is not a paymail is not a handle.
   */
  it.each(['not-a-paymail', 'dee@', '@deggen.com', 'Dee <script>@deggen.com', 'a@b@c'])(
    'refuses %s as a handle rather than displaying it as a verified one',
    async raw => {
      routeParams = { identityKey: KEY, name: 'Dee K', handle: raw, source: 'pay' }
      const s = draw()
      expect(s.getByText('contact_no_handle_registered')).toBeTruthy()
      expect(s.queryByText(raw)).toBeNull()
      fireEvent.press(s.getByText('contact_save'))
      await waitFor(() =>
        expect(createContact).toHaveBeenCalledWith(expect.not.objectContaining({ cachedHandle: expect.anything() }))
      )
    }
  )
})
```

Create `packages/expo-wallet-toolbox/__tests__/ui/contactScreen.test.tsx`:

```tsx
/**
 * ContactScreen's background cache refresh — the riskiest edit in this feature.
 * It does two lookups in parallel, merges them into ONE write (because
 * `refreshContactCache` replaces all three cache columns), routes the reverse
 * lookup by the cached handle's own domain, and is guarded against the loop its
 * own `reload()` would otherwise create.
 *
 * The case that matters most is the offline one: a lookup that could not be
 * made must leave the cached handle exactly where it was.
 */
jest.mock('expo-haptics', () => ({
  selectionAsync: jest.fn(() => Promise.resolve()),
  impactAsync: jest.fn(() => Promise.resolve()),
  notificationAsync: jest.fn(() => Promise.resolve()),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' }
}))
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }))
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children
}))
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => {} }
}))

let routeParams: Record<string, string> = {}
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
  useLocalSearchParams: () => routeParams
}))
jest.mock('../../ui/components/ui/Toast', () => ({ showToast: jest.fn() }))
jest.mock('../../ui/components/ui/AlertCard', () => ({ showAlert: jest.fn() }))
jest.mock('../../core/contacts/contactActivity', () => ({ getContactActivity: async () => [] }))

const resolveIdentity = jest.fn()
jest.mock('../../ui/resolveIdentity', () => ({
  makeIdentityClient: () => ({}),
  resolveIdentity: (...a: unknown[]) => resolveIdentity(...a)
}))

const lookupProfile = jest.fn()
jest.mock('../../core/identity/handleRegistry/client', () => ({
  createHandleRegistryClient: () => ({ domain: 'deggen.com', lookupProfile })
}))

type Contact = { identityKey: string; name: string; cachedHandle?: string; cachedAvatarUrl?: string }
let stored: Contact
const refreshContactCache = jest.fn()
jest.mock('../../ui/hooks/useContactsStore', () => ({
  useContactsStore: () => ({
    getContact: async () => stored,
    refreshContactCache: (...a: unknown[]) => {
      // The real store writes the row and the screen reloads from it.
      const cache = a[2] as Partial<Contact>
      stored = { ...stored, ...cache }
      return refreshContactCache(...a)
    },
    deleteContact: jest.fn(),
    renameContact: jest.fn()
  })
}))
jest.mock('@bsv/expo-wallet-toolbox', () => ({
  ...jest.requireActual('@bsv/expo-wallet-toolbox'),
  useWallet: () => ({
    managers: { permissionsManager: {} },
    adminOriginator: 'admin.com',
    storage: undefined,
    walletUserId: 1,
    selectedNetwork: 'test'
  })
}))

import React from 'react'
import { render, waitFor } from '@testing-library/react-native'
import { ThemeProvider, configureToolbox, resetToolboxConfig } from '@bsv/expo-wallet-toolbox'
import { ContactScreen } from '../../ui/screens/ContactScreen'
import { IdentifierScreen } from '../../ui/screens/IdentifierScreen'

const KEY = '02' + 'ab'.repeat(32)
const draw = () =>
  render(
    <ThemeProvider>
      <ContactScreen />
    </ThemeProvider>
  )

const withRegistry = () =>
  configureToolbox({
    backupUrl: null,
    handleRegistry: { test: { domain: 'deggen.com', url: 'https://registry.example' } }
  })

beforeEach(() => {
  jest.clearAllMocks()
  resetToolboxConfig()
  routeParams = { identityKey: KEY }
  stored = { identityKey: KEY, name: 'Dee from the pub', cachedHandle: 'dee@deggen.com' }
  resolveIdentity.mockResolvedValue([true, { avatarURL: '' }])
  lookupProfile.mockResolvedValue({ kind: 'none' })
})
afterEach(() => resetToolboxConfig())

describe('the hero', () => {
  it('shows the cached handle with no sigil in front of it', async () => {
    withRegistry()
    lookupProfile.mockResolvedValue({ kind: 'found', profile: { paymail: 'dee@deggen.com' } })
    const s = draw()
    await waitFor(() => expect(s.getByText('dee@deggen.com')).toBeTruthy())
    expect(s.queryByText('@dee@deggen.com')).toBeNull()
    expect(s.getByText('contact_handle_caption')).toBeTruthy()
  })
})

describe('the background refresh', () => {
  it('writes the handle and the avatar together, in one call, once per visit', async () => {
    withRegistry()
    resolveIdentity.mockResolvedValue([true, { avatarURL: 'https://a/x.png' }])
    lookupProfile.mockResolvedValue({ kind: 'found', profile: { paymail: 'deggen@deggen.com' } })
    draw()
    await waitFor(() => expect(refreshContactCache).toHaveBeenCalledTimes(1))
    expect(refreshContactCache).toHaveBeenCalledWith(1, KEY, {
      cachedHandle: 'deggen@deggen.com',
      cachedAvatarUrl: 'https://a/x.png',
      cachedCertifier: undefined
    })
    // The write feeds `reload()`, which produces a new `contact` — the effect
    // must not run again on it.
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(refreshContactCache).toHaveBeenCalledTimes(1)
  })

  /**
   * `lookupProfile` answering `failed` is the registry not having answered.
   * Writing `''` for that would blank the handle every time this screen is
   * opened on a train.
   */
  it('leaves the cached handle alone when the registry could not be reached', async () => {
    withRegistry()
    lookupProfile.mockResolvedValue({ kind: 'failed' })
    const s = draw()
    await waitFor(() => expect(s.getByText('dee@deggen.com')).toBeTruthy())
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(refreshContactCache).not.toHaveBeenCalled()
    expect(stored.cachedHandle).toBe('dee@deggen.com')
  })

  it('clears the handle only when the registry says the key holds none', async () => {
    withRegistry()
    lookupProfile.mockResolvedValue({ kind: 'none' })
    draw()
    await waitFor(() =>
      expect(refreshContactCache).toHaveBeenCalledWith(1, KEY, {
        cachedHandle: undefined,
        cachedAvatarUrl: undefined,
        cachedCertifier: undefined
      })
    )
  })

  it('asks the domain the cached handle names, not the one this build is pinned to', async () => {
    withRegistry()
    stored = { identityKey: KEY, name: 'Dee', cachedHandle: 'dee@other.example' }
    draw()
    await waitFor(() => expect(lookupProfile).toHaveBeenCalledWith(KEY, 'other.example'))
  })

  it('asks the pinned registry for a contact with no cached handle at all', async () => {
    withRegistry()
    stored = { identityKey: KEY, name: 'Dee' }
    draw()
    await waitFor(() => expect(lookupProfile).toHaveBeenCalledWith(KEY, undefined))
  })

  it('asks no registry at all when this chain has none, and still refreshes the avatar', async () => {
    resolveIdentity.mockResolvedValue([true, { avatarURL: 'https://a/x.png' }])
    draw()
    await waitFor(() => expect(refreshContactCache).toHaveBeenCalledTimes(1))
    expect(lookupProfile).not.toHaveBeenCalled()
    expect(refreshContactCache).toHaveBeenCalledWith(1, KEY, {
      cachedHandle: 'dee@deggen.com',
      cachedAvatarUrl: 'https://a/x.png',
      cachedCertifier: undefined
    })
  })
})

describe('IdentifierScreen', () => {
  it('shows the registered paymail with no sigil in front of it', () => {
    routeParams = { identityKey: KEY, name: 'Dee K', handle: 'dee@deggen.com' }
    const s = render(
      <ThemeProvider>
        <IdentifierScreen />
      </ThemeProvider>
    )
    expect(s.getByText('dee@deggen.com')).toBeTruthy()
    expect(s.queryByText('@dee@deggen.com')).toBeNull()
  })
})
```

If `IdentifierScreen`'s lazy `require('react-native-qrcode-svg')` fails under `jest-expo`, add `jest.mock('react-native-qrcode-svg', () => 'QRCode')` beside the other mocks at the top — the QR itself is not what this case is about.

- [ ] **Step 2: Run them, expect the named failures**

```bash
cd /Users/personal/git/bsv-wallet && npx jest packages/expo-wallet-toolbox/__tests__/contacts/contactCache.test.ts packages/expo-wallet-toolbox/__tests__/ui/newContactHandle.test.tsx packages/expo-wallet-toolbox/__tests__/ui/contactScreen.test.tsx
```

Expected: FAIL — `Cannot find module '../../core/contacts/contactCache'`; `Unable to find an element with text: dee@deggen.com` in `newContactHandle`; and in `contactScreen`, `lookupProfile` never called plus `@dee@deggen.com` found where it should not be.

- [ ] **Step 3: Implement `contactCache.ts`**

Create `packages/expo-wallet-toolbox/core/contacts/contactCache.ts`:

```ts
/**
 * What a background refresh should write to a contact's cache columns.
 *
 * `refreshContactCache` replaces all three in one UPDATE — that is what keeps
 * it a single statement and keeps `name` untouchable — so a caller that names
 * only the avatar silently blanks the handle stored beside it. This decides
 * the COMPLETE row instead, from what the contact already had and what this
 * pass actually learned.
 *
 * An absent learned value means "not looked up this time" and keeps what is
 * there; an EMPTY one means "looked, and there is none" and clears it. That
 * distinction is the whole reason this is a function and not a spread: a
 * registry 404 has to be able to remove a handle the contact no longer holds.
 */
export interface ContactCache {
  cachedHandle?: string
  cachedAvatarUrl?: string
  cachedCertifier?: string
}

function pick(current: string | undefined, learned: string | undefined): string | undefined {
  if (learned === undefined) return current
  return learned === '' ? undefined : learned
}

/** The row to write, or null when this pass learned nothing new. */
export function mergeContactCache(
  current: ContactCache,
  learned: { cachedHandle?: string; cachedAvatarUrl?: string }
): ContactCache | null {
  const merged: ContactCache = {
    cachedHandle: pick(current.cachedHandle, learned.cachedHandle),
    cachedAvatarUrl: pick(current.cachedAvatarUrl, learned.cachedAvatarUrl),
    cachedCertifier: current.cachedCertifier
  }
  const unchanged =
    merged.cachedHandle === current.cachedHandle &&
    merged.cachedAvatarUrl === current.cachedAvatarUrl &&
    merged.cachedCertifier === current.cachedCertifier
  return unchanged ? null : merged
}
```

In `core/index.ts`, beside the other contacts exports, add:

```ts
export { mergeContactCache, type ContactCache } from './contacts/contactCache'
```

(If no contacts block exists on the barrel, put it immediately above the `// Local SQLite storage layer` comment.)

- [ ] **Step 4: Edit `NewContactScreen.tsx`**

**(a)** Add to the params type (lines 64-68) a fourth member:

```tsx
    handle?: string | string[]
```

**(b)** After `const prefilledIdentityKey = ...` (line 69), add:

```tsx
/**
 * The registry's `handle@domain`, when the caller had one: Pay's "Save as
 * contact" and the Contacts search both know it, and it is the only way this
 * column is ever populated.
 *
 * Validated, not trusted. `/contact/add` is a deep-linkable expo-router
 * route, so this param is a string from outside the app — and what it becomes
 * is rendered on ContactScreen under a shield and the words "only they can
 * change it". Anything that is not a paymail is not a handle.
 */
const parsedHandle = parsePaymail(firstParam(params.handle) ?? '')
const prefilledHandle = parsedHandle ? `${parsedHandle.handle}@${parsedHandle.domain}` : ''
```

and add the import beside the other core imports:

```tsx
import { parsePaymail } from '../../core/identity/handleRegistry/rules'
```

**(c)** In `onSave` (lines 109-114), change the `createContact` call to:

```tsx
await store.createContact({
  userId: walletUserId,
  identityKey,
  name: name.trim(),
  ...(prefilledHandle ? { cachedHandle: prefilledHandle } : {}),
  source: manualEntry ? 'manual' : source
})
```

and add `prefilledHandle` to the `useCallback` dependency array on line 120.

**(d)** Replace the hero caption (line 153):

```tsx
<Text style={[styles.heroCaption, { color: colors.textTertiary }]}>{t('contact_no_handle_registered')}</Text>
```

with:

```tsx
<Text style={[styles.heroCaption, { color: colors.textTertiary }]}>
  {prefilledHandle || t('contact_no_handle_registered')}
</Text>
```

- [ ] **Step 5: Edit `UniversalSend.tsx` — carry the handle into the route**

In `onAddContact` (lines 534-541), change the params object to:

```tsx
      params: {
        identityKey: offerAddContact.identityKey,
        name: offerAddContact.name ?? '',
        handle: offerAddContact.handle ?? '',
        source: 'pay'
      }
```

- [ ] **Step 6: Edit `ContactScreen.tsx`**

**(a)** Add imports after line 23:

```tsx
import { mergeContactCache } from '../../core/contacts/contactCache'
import { parsePaymail } from '../../core/identity/handleRegistry/rules'
import { getHandleRegistryConfig } from '../../core/toolboxConfig'
import { createHandleRegistryClient } from '../../core/identity/handleRegistry/client'
```

and add `useRef` to the React import on line 7.

**(b)** Change line 55 to:

```tsx
const { managers, adminOriginator, storage, walletUserId, selectedNetwork } = useWallet()
```

**(c)** Replace the avatar-only refresh effect (lines 83-97) with:

```tsx
/**
 * Best-effort background cache refresh: the overlay's avatar and the
 * registry's handle, in ONE write. `refreshContactCache` replaces all three
 * cache columns, so two separate calls would each blank what the other just
 * stored. Once per visit — the write feeds `reload`, and re-running on the
 * contact it produced would be a loop.
 *
 * `name` is never touched: it is the user's own label for this person.
 */
const refreshedKeyRef = useRef('')
useEffect(() => {
  if (!identityKey || !store || walletUserId === null || !contact) return
  if (refreshedKeyRef.current === identityKey) return
  refreshedKeyRef.current = identityKey
  const idClient = makeIdentityClient(managers?.permissionsManager as never, adminOriginator)
  const registry = getHandleRegistryConfig(selectedNetwork)
  const client = registry ? createHandleRegistryClient({ pinned: registry }) : null
  if (!idClient && !client) return
  let cancelled = false
  void (async () => {
    const [identity, lookup] = await Promise.all([
      idClient ? resolveIdentity(idClient, identityKey).then(([, found]) => found) : null,
      // A contact whose cached handle names another domain is looked up
      // there; everyone else on the registry this build is configured for.
      client ? client.lookupProfile(identityKey, parsePaymail(contact.cachedHandle ?? '')?.domain) : null
    ])
    if (cancelled) return
    // `lookupProfile`, not `lookupIdentityKey`: a `failed` lookup is the
    // registry not having answered, and writing `''` for it would blank a
    // contact's handle every time this screen is opened offline. Only an
    // answer — `found` or `none` — may change the column.
    const learnedHandle = lookup?.kind === 'found' ? lookup.profile.paymail : lookup?.kind === 'none' ? '' : undefined
    const next = mergeContactCache(contact, {
      ...(identity?.avatarURL ? { cachedAvatarUrl: identity.avatarURL } : {}),
      ...(learnedHandle === undefined ? {} : { cachedHandle: learnedHandle })
    })
    if (!next) return
    await store.refreshContactCache(walletUserId, identityKey, next)
    if (!cancelled) void reload()
  })()
  return () => {
    cancelled = true
  }
}, [identityKey, store, walletUserId, managers, adminOriginator, selectedNetwork, contact, reload])
```

**(d)** Replace the hero handle line (line 149), because `cachedHandle` now carries its own domain and `@dee@deggen.com` is not a thing:

```tsx
<Text style={[styles.handle, { color: colors.textSecondary }]}>@{contact.cachedHandle}</Text>
```

with:

```tsx
<Text style={[styles.handle, { color: colors.textSecondary }]}>{contact.cachedHandle}</Text>
```

- [ ] **Step 6b: The two other screens that prepend an `@`**

`cachedHandle` and the `/identifier` route's `handle` param both carry a full `handle@domain` now, so every remaining hard-coded sigil renders `@dee@deggen.com`. Neither screen has a test file; these are the only two lines each.

In `ui/screens/ContactsScreen.tsx`, line 230:

```tsx
{
  row.cachedHandle ? `@${row.cachedHandle}` : t('contact_no_handle')
}
```

becomes:

```tsx
{
  row.cachedHandle ? row.cachedHandle : t('contact_no_handle')
}
```

In `ui/screens/IdentifierScreen.tsx`, line 139:

```tsx
{
  !!handle && <Text style={[styles.whoHandle, { color: colors.textSecondary }]}>@{handle}</Text>
}
```

becomes:

```tsx
{
  !!handle && <Text style={[styles.whoHandle, { color: colors.textSecondary }]}>{handle}</Text>
}
```

- [ ] **Step 7: Run it, expect pass**

```bash
cd /Users/personal/git/bsv-wallet && npx jest packages/expo-wallet-toolbox/__tests__/contacts packages/expo-wallet-toolbox/__tests__/ui/contactScreen.test.tsx packages/expo-wallet-toolbox/__tests__/ui/newContactHandle.test.tsx packages/expo-wallet-toolbox/__tests__/ui/universalSend.test.tsx
```

Expected: PASS, including the existing `contactsStore.test.ts`.

Then confirm no screen still prepends a sigil to something that carries its own domain:

```bash
cd /Users/personal/git/bsv-wallet && grep -rn '@\${\|>@{' packages/expo-wallet-toolbox/ui --include=*.tsx | grep -i handle
```

Expected: one line only — `ProfileScreen.tsx`'s fixed `@{registryDomain}` suffix beside the claim input, which is the domain, not a handle.

- [ ] **Step 8: Lint and format**

```bash
cd /Users/personal/git/bsv-wallet && npx prettier --check packages/expo-wallet-toolbox/core/contacts/contactCache.ts packages/expo-wallet-toolbox/ui/screens/NewContactScreen.tsx packages/expo-wallet-toolbox/ui/screens/ContactScreen.tsx packages/expo-wallet-toolbox/ui/screens/ContactsScreen.tsx packages/expo-wallet-toolbox/ui/screens/IdentifierScreen.tsx packages/expo-wallet-toolbox/ui/components/pay/UniversalSend.tsx packages/expo-wallet-toolbox/core/index.ts packages/expo-wallet-toolbox/__tests__/contacts/contactCache.test.ts packages/expo-wallet-toolbox/__tests__/ui/newContactHandle.test.tsx packages/expo-wallet-toolbox/__tests__/ui/contactScreen.test.tsx && npx eslint packages/expo-wallet-toolbox/core/contacts/contactCache.ts packages/expo-wallet-toolbox/ui/screens/NewContactScreen.tsx packages/expo-wallet-toolbox/ui/screens/ContactScreen.tsx packages/expo-wallet-toolbox/ui/screens/ContactsScreen.tsx packages/expo-wallet-toolbox/ui/screens/IdentifierScreen.tsx
```

Expected: clean.

---

## Task 11: The live test, and shipping it

The unit suites all mock the wire. Exactly one test talks to a real go-message-box-server, and it is skipped unless the developer points it at one — nothing in CI or a normal `npx jest` may depend on a running Mongo.

**Files:**

- Create (test): `packages/expo-wallet-toolbox/__tests__/identity/handleRegistry.live.test.ts`
- Modify: `packages/expo-wallet-toolbox/CHANGELOG.md`
- Modify: `packages/expo-wallet-toolbox/package.json`
- Modify: `packages/expo-wallet-toolbox/README.md`

**Interfaces:** consumes everything Tasks 1-6 produced; produces nothing importable.

- [ ] **Step 1: Write the live test**

Create `packages/expo-wallet-toolbox/__tests__/identity/handleRegistry.live.test.ts`:

```ts
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

  const pinned = { domain: domain as string, url: url as string }
  const key = PrivateKey.fromRandom()
  const signer = new ProtoWallet(key) as unknown as ProfileSigner
  const client = createHandleRegistryClient({ pinned })
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
    const other = PrivateKey.fromRandom()
    const otherDeps = {
      client,
      signer: new ProtoWallet(other) as unknown as ProfileSigner,
      storage: memoryStorage()
    }
    resetRegistrationState()
    const result = await registerHandle(otherDeps, { handle: first })
    expect(result).toMatchObject({ kind: 'rejected' })
    expect(await client.checkAvailability(first)).toEqual({ kind: 'unavailable', reason: 'cooldown' })
  })
})
```

- [ ] **Step 2: Confirm it skips by default**

```bash
cd /Users/personal/git/bsv-wallet && npx jest packages/expo-wallet-toolbox/__tests__/identity/handleRegistry.live.test.ts
```

Expected: PASS with 9 skipped, no network access, no failure.

- [ ] **Step 3: Run it against a real server at least once**

Follow the module doc's own instructions. Expected: all 9 pass. If the cooldown case reports `taken` rather than `cooldown`, the server is running with `HANDLE_COOLDOWN_DAYS=0`; set it and rerun rather than weakening the assertion.

- [ ] **Step 4: Version, changelog and README**

In `packages/expo-wallet-toolbox/package.json`, change `"version": "0.5.0"` to `"version": "0.6.0"`.

In `packages/expo-wallet-toolbox/CHANGELOG.md`, insert a new section directly under `# Changelog`:

```markdown
## 0.6.0

### Handle registry (breaking)

Handle registration talks to go-message-box-server's paymail profile registry
instead of a certifier that was never deployed. A handle is now
`handle@domain`: a self-signed BRC-52 profile certificate the registry stores
and anybody can verify. Spec:
`docs/superpowers/specs/2026-09-18-handle-registry-client-design.md`.

Removed exports and configuration:

- `core/identity/handleCertificate.ts` in full — `HANDLE_CERT_TYPE`,
  `HandleCertWallet`, `isValidHandleFormat` (the 3-20 rule),
  `HandleAvailability`, `checkHandleAvailability`, `registerHandle`,
  `RegisterHandleResult`.
- `ToolboxConfig.handleCertifier`, `HandleCertifierConfig`,
  `getHandleCertifierConfig`. Neither the type nor the getter was on the
  public barrel; the config key was.

New:

- `ToolboxConfig.handleRegistry?: Partial<Record<AppChain, HandleRegistryConfig>>`
  and `getHandleRegistryConfig(chain)`, both exported from the `core` barrel.
  Fail-closed: a malformed or half-stated entry reads as no registry. `https`
  is required except for localhost and RFC 1918 hosts in development.
- `mergeContactCache` / `ContactCache` (`core/contacts/contactCache.ts`).
- `core/identity/handleRegistry/` — `rules`, `profileCert`, `resolver`,
  `client`, `registration`. Not on the barrel: the UI in this package is the
  only consumer, and the surface is still settling.

Behaviour:

- The display name is **public** when set: a plaintext field of the profile
  certificate, and the default name someone sees when they add you. The
  in-app hint says so, in all 12 languages.
- Profile shows `handle@domain`, and the registry — not
  `profile_registered_handle` — is the source of truth for which handle this
  key holds, so a restored wallet gets its handle back.
- Every write is journaled in `key_value_store` (`profile_handle_pending`) and
  replayed on the next Profile mount, so a crash, a double tap or a lost
  response settles to the same state.
- Pay's recipient search gains a registry tier between contacts and the
  overlay, and `RecipientField` shows its loading spinner as a footer instead
  of replacing the list — the local contacts tier is no longer hidden for the
  whole debounce.
- A query that is a complete `handle@domain` answers that row and nothing
  else. The registry's own search is a prefix, skeleton and substring search,
  so a typed address would otherwise be answered with its neighbours and its
  look-alikes.
- `contacts.cachedHandle` has a production writer for the first time: the
  `handle` route param on `/contact/add` (validated as a paymail — the route
  is deep-linkable), and `ContactScreen`'s background refresh, which
  distinguishes "the registry says there is none" from "the registry did not
  answer" and only clears the column for the first.
- A handle is displayed without a prepended `@` wherever it already carries
  its own domain: Profile, Contacts, a contact, and the Identifier QR screen.
```

In `packages/expo-wallet-toolbox/README.md`, in the **Configuration** section after the paragraph about `services` (the one ending "Chains are `main`, `test` and `teratest`."), add:

````markdown
`handleRegistry` names the paymail domain this build's handles live under and
the host that serves it, per chain:

```tsx
configureToolbox({
  backupUrl: null,
  handleRegistry: {
    test: { domain: 'deggen.com', url: 'https://messagebox.bsvblockchain.tech' }
  }
})
```

Both fields are required together — a domain with no URL is a registry nothing
can reach, and a URL with no domain is a host whose certificates nothing can be
checked against — and the URL must be `https` unless it points at `localhost`,
`127.0.0.1`, `10.0.2.2` or RFC 1918 space, which is a development allowance. A
chain with no complete entry shows "not available yet" on the Profile screen
and adds no registry tier to Pay's recipient search.
````

- [ ] **Step 5: Run the whole package suite**

```bash
cd /Users/personal/git/bsv-wallet && npx jest packages/expo-wallet-toolbox
```

Expected: PASS, with the live suite skipped. Nothing that passed before this plan started may be failing now.

- [ ] **Step 6: Typecheck, lint and format the whole change**

```bash
cd /Users/personal/git/bsv-wallet && npx tsc --noEmit && npx prettier --check packages/expo-wallet-toolbox/CHANGELOG.md packages/expo-wallet-toolbox/README.md packages/expo-wallet-toolbox/package.json packages/expo-wallet-toolbox/__tests__/identity/handleRegistry.live.test.ts && npx eslint packages/expo-wallet-toolbox/__tests__/identity/handleRegistry.live.test.ts
```

Expected: clean. Do not reformat files this plan did not otherwise change.

---

## Done when

- `npx jest packages/expo-wallet-toolbox` is green from the repo root, with the live suite skipped.
- `npx tsc --noEmit` is clean.
- `grep -rn "handleCertifier\|handleCertificate\|HANDLE_CERT_TYPE" packages/expo-wallet-toolbox app --include=*.ts --include=*.tsx` returns nothing.
- `grep -rn "EXPO_PUBLIC" packages/expo-wallet-toolbox --include=*.ts --include=*.tsx` returns nothing outside comments.
- `grep -n "@{{handle}}" packages/expo-wallet-toolbox/core/i18n/translations.tsx` returns nothing.
- The live test has been run against a real go-message-box-server at least once and passed.
- Nothing is committed and nothing is pushed unless the user asks.
