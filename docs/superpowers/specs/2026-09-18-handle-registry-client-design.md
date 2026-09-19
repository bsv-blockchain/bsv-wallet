# Handle registry client — Profile registration and Pay lookup

Status: design approved by Deggen 2026-09-18. Supersedes the "Handle
registration" section (and the display-name privacy ruling) of
`2026-09-18-contacts-handles-pay-design.md`.

## Why

`core/identity/handleCertificate.ts` registers a handle by asking a certifier
that was never deployed and checks availability with an advisory overlay search
that matches on display name. The earlier spec called this a flagged gap and
left the Profile UI states wired "for a real check to drop in later".

That backend now exists: **go-message-box-server's paymail profile lookup**
(merged as bsv-blockchain/go-message-box-server#15; server spec in that repo at
`docs/specs/2026-09-18-paymail-profile-lookup-design.md`). This spec replaces
the placeholder with a client for it, and adds the registry to Pay's recipient
search.

## The registry in one page

A handle is `handle@domain`. The document behind it is a **self-signed BRC-52
certificate**: `subject == certifier ==` the owner's identity key, plaintext
fields, certificate type `SbatVXXssDW3AO0J9bxIljkHGbPBGCVAXg94gXFf0cE=`
(base64 SHA-256 of `public profile lookup`), `revocationOutpoint` =
`0000000000000000000000000000000000000000000000000000000000000000.0`.

Fields: `paymail` (exact lowercase `handle@domain`, required), `issuedAt`
(RFC 3339, required, the replay guard — each new certificate must be strictly
newer and carry a new `serialNumber`; the server refuses one dated more than 5
minutes ahead of its clock), `displayName` (optional, **public**),
`released: "true"` (owner tombstone). Limits: ≤ 32 fields, ≤ 1024 bytes per
value, ≤ 50 bytes per field name, ≤ 16 KB body.

Routes on the registry host (all unauthenticated; the certificate is the
authorisation):

| Route | Result |
|---|---|
| `PUT /api/handle` body = certificate JSON | `201` registered/reclaimed · `200` updated, released, or replay no-op · `400 ERR_INVALID_CERTIFICATE / ERR_INVALID_HANDLE / ERR_WRONG_DOMAIN` · `409 ERR_HANDLE_TAKEN / ERR_HANDLE_TOO_SIMILAR / ERR_HANDLE_RESERVED / ERR_KEY_HAS_HANDLE / ERR_HANDLE_COOLDOWN / ERR_STALE_CERTIFICATE` · `404 ERR_HANDLE_NOT_FOUND` (tombstone for a handle the key does not hold) · `413` · `429 ERR_RATE_LIMITED` |
| `GET /api/handle/{query}` | `200` array of certificates, max 10, possibly empty. Query = what the user typed, optional `@domain` (a domain still being typed is accepted). |
| `GET /api/identityKey/{pubkey}` | `200` one certificate · `404 ERR_HANDLE_NOT_FOUND` |
| `GET /api/handle/available/{handle}` | `200 {"available":bool,"reason":"taken"\|"too_similar"\|"reserved"\|"invalid"\|"cooldown"\|"stale"}` |
| `GET /.well-known/bsvalias` | `{"bsvalias":"1.0","capabilities":{"0ace65da5987":"https://host/api/handle/{query}","43dcf83ddc5f":"https://host/api/identityKey/{pubkey}"}}` |

Handle rule: `^[a-z0-9][a-z0-9._-]{1,30}[a-z0-9]$` (3–32 chars). One handle per
key, one key per handle. Look-alikes collide server-side (`paypa1` vs `paypal`).
Changing handle = tombstone the old one, then claim the new one; a released
handle is in cooldown for other keys but its previous owner may reclaim it.

Error bodies are `{"status":"error","code":"ERR_…","description":"…"}`.

**Wire compatibility is proven**: a certificate signed with this repo's
`@bsv/sdk` 2.4.1 (`Certificate.sign(ProtoWallet)`) was accepted by the Go
server (`201`), and the certificate it served back verified with
`Certificate.verify()`, including a non-ASCII display name.

## Rulings (Deggen, 2026-09-18)

1. **Display name is public when present.** It is a plaintext field of the
   profile certificate. It is the *default* name when someone adds you as a
   contact; they can rename you locally and that local name is what they see
   from then on. Pay results always show **both** name and handle. This
   supersedes "display name goes privately to the registry".
2. **Host resolution**: our own configured domain is pinned to a configured
   URL. Any other domain resolves Paymail-style: DNS-over-HTTPS SRV
   `_bsvalias._tcp.<domain>`, DNSSEC required, then `/.well-known/bsvalias`.
3. **Domain is configuration.** Testing uses `deggen.com` served by
   `https://messagebox.bsvblockchain.tech`; nothing is hard-coded.

## Trust model (normative)

The registry is a directory, not an authority on profile content. Every
certificate read from any registry passes `verifyProfileCertificate` before any
part of it is shown or used:

1. `type` is the profile type; `subject === certifier`; `revocationOutpoint` is
   the zero outpoint; limits respected.
2. `Certificate.verify()` succeeds (signature by `certifier`, anyone-verifiable).
3. `fields.paymail` is lowercase `handle@domain`, the handle passes the format
   rule, and `domain` equals the domain that was queried.
4. `fields.released` is not `"true"`.
5. Reverse lookups additionally require `subject ===` the key asked for.

A certificate that fails is dropped silently (logged once), never shown.

Search results are **suggestions**: the UI never auto-selects one. When the user
typed a complete `handle@domain`, only a row whose `paymail` equals it exactly
may be offered as "the" match. What the domain operator is still trusted for:
which key owns a handle, and freshness. TLS (https required) protects that.

## Architecture

New directory `core/identity/handleRegistry/`. Pure TypeScript, React-Native
safe (no Node APIs), no React, no direct env reads, injectable `fetch` and clock
for tests. Each HTTP call is a single attempt with an `AbortController` timeout
(8 s), the convention of `core/backup/client.ts`.

### `rules.ts`
Constants (`PROFILE_CERT_TYPE`, `BRFC_LOOKUP`, `BRFC_REVERSE_LOOKUP`,
`ZERO_OUTPOINT`, field/size limits) and pure helpers:
`isValidHandleFormat(handle)`, `parsePaymail(text) → {handle, domain} | null`
(lowercases, trims), `looksLikeDomain(text)`.

### `profileCert.ts`
- `ProfileCertJson` — the seven-member wire shape.
- `ProfileSigner` — the two `WalletInterface` methods `Certificate.sign` needs
  (`getPublicKey({identityKey:true})`, `createSignature`). Callers pass the
  wallet wrapped with `bindOriginator(wallet, adminOriginator)`
  (`core/mandala/createRuntime.ts`) so signing never raises a permission prompt.
- `buildProfileCertificate({signer, paymail, issuedAt, displayName?, released?})`
  → signed `ProfileCertJson`. Random 32-byte base64 serial. An empty/whitespace
  display name sends no field. Refuses (throws) input that would break a limit.
- `verifyProfileCertificate(cert: unknown, expect: {domain, paymail?, identityKey?})`
  → `RegistryProfile | null` implementing the trust model above. Never throws.
- `RegistryProfile = {identityKey, paymail, handle, domain, displayName?, issuedAt: Date, certificate}`.

### `resolver.ts`
`createRegistryResolver({pinned?, fetchImpl?, now?, dohEndpoints?})` →
`resolve(domain) → Promise<RegistryEndpoints | null>` where
`RegistryEndpoints = {domain, search(query) → url, reverse(pubkey) → url, pinned: boolean}`.

- `domain === pinned.domain` → built from `pinned.url` directly, no DNS, no
  well-known fetch.
- Otherwise DoH JSON (`https://cloudflare-dns.com/dns-query`, fallback
  `https://dns.google/resolve`; `name=_bsvalias._tcp.<domain>&type=SRV&do=1`,
  `accept: application/dns-json`). SRV present → require `AD === true` unless
  the target equals the domain itself; pick lowest priority then highest weight;
  strip the trailing dot. NXDOMAIN / no SRV → Paymail fallback `https://<domain>:443`.
  Any DoH failure on both endpoints → `null`.
- `GET https://<target>:<port>/.well-known/bsvalias`; require both BRFC ids and
  `https://` templates containing `{query}` / `{pubkey}`; substitute with
  `encodeURIComponent`.
- In-memory cache per domain: 10 minutes for success, 60 seconds for failure.

### `client.ts`
`createHandleRegistryClient({pinned, fetchImpl?, now?})` →

- `checkAvailability(handle)` → `{kind:'available'} | {kind:'unavailable', reason} | {kind:'failed'}`.
  Format is checked locally first (`reason:'invalid'`, no request).
- `putCertificate(cert)` → `{kind:'created'|'ok'} | {kind:'rejected', code, description} | {kind:'failed', message}`
  (`rejected` = the server answered and said no; `failed` = transport/timeout/5xx/429).
- `search(query)` → `RegistryProfile[]`; **throws** on transport failure (the
  contract of `searchIdentities`, so Pay's existing error banner can fire).
  Routes to the pinned registry unless `query` carries a complete foreign
  domain (see Pay below).
- `lookupIdentityKey(identityKey, domain?)` → `RegistryProfile | null`; never
  throws (the contract of `resolveIdentity`).
- `serverNow()` → `Date`: the device clock corrected by the skew observed from
  the `Date` response header of the most recent pinned-registry response
  (`0` until one is seen). Writes only ever go to the pinned registry.

### `registration.ts`
Everything that writes. One entry point per intent, all journaled:

- `registerHandle`, `updateProfile` (display-name change on a registered
  handle), `changeHandle` (release old → claim new), and
  `resumePending` (call on Profile mount).
- `issuedAt = max(client.serverNow(), lastKnownIssuedAt + 1 ms)` — survives a
  device clock that is ahead (server's 5-minute rule) or behind (stale rule).
- **Journal** in `key_value_store`, key `profile_handle_pending`:
  `{v:1, steps:[{kind:'release'|'claim', paymail, cert}], previousPaymail?, startedAt}`.
  Certificates are signed and the journal written **before** the first request;
  a retry re-sends the identical bytes, which the server treats as a no-op
  (`200`), so double-taps, crashes and timeouts are idempotent.
- Step outcomes: `created|ok` → next step. `failed` → keep the journal, report
  `pending` (resumed on next mount or an explicit retry). `rejected` with
  `ERR_STALE_CERTIFICATE` → reverse-lookup our key; if the registry already
  reflects the step treat it as done, else `failed`. `rejected` on a `claim`
  that followed a `release` (the new handle was taken in between) → mint a fresh
  claim for `previousPaymail` (the previous owner is exempt from cooldown) and
  report `rolled_back`. Any other `rejected` → clear the journal, report it.
- Result union: `registered | updated | changed | rolled_back | pending | rejected{code} | failed{message} | unavailable` (`unavailable` = no registry configured for this chain, as today).
- A module-level in-flight promise makes concurrent calls (two mounts, a
  double tap) share one run.

### Removed
`HANDLE_CERT_TYPE`, `HandleCertWallet`, the `acquireCertificate` issuance flow,
`publiclyRevealAttributes(['handle'])`, the overlay-name availability check, and
`handleCertifier` / `HandleCertifierConfig` / `getHandleCertifierConfig`.
`core/identity/handleCertificate.ts` is deleted; its tests are replaced.

## Configuration

`ToolboxConfig.handleRegistry?: Partial<Record<AppChain, {domain: string; url: string}>>`
and `getHandleRegistryConfig(chain)`, following the `getMandalaEndpoints`
pattern: fail-closed (`undefined`, never throws) unless `domain` is a bare
lowercase domain and `url` is `https://…` (plain `http://` allowed only for
`localhost`, `127.0.0.1`, `10.0.2.2` and RFC 1918 hosts, for development);
trailing slashes stripped. Exported from the `core` barrel with its type.

`app/_layout.tsx` reads `EXPO_PUBLIC_HANDLE_REGISTRY_DOMAIN` / `_URL` (main)
and `EXPO_PUBLIC_TEST_HANDLE_REGISTRY_DOMAIN` / `_URL` (test) in app source —
never inside the package. `eas.json`: `development` and `dev-physical` profiles
get `deggen.com` + `https://messagebox.bsvblockchain.tech` for both chains;
production profiles are left unset until the production domain is decided, so a
production build shows the existing "not available yet" copy.

## Profile screen

State machine and layout unchanged. Changes:

- Gate on `getHandleRegistryConfig(selectedNetwork)` instead of the certifier.
- Input is the local part; a fixed `@<domain>` suffix sits in the row. A
  registered handle is displayed as the full `handle@domain`.
- `HandleAvailability` gains `too_similar`, `reserved`, `cooldown` (server
  `stale` maps to `cooldown`), each with its own status line. 400 ms debounce
  kept; a response for a superseded input is discarded.
- On mount: `resumePending()`, then `lookupIdentityKey(ownKey)`. The registry
  is the source of truth for the registered handle (restores it on a new
  device); `profile_registered_handle` (now the full paymail) is the offline
  cache. A cached value is shown immediately and corrected when the lookup
  answers; a `404` clears it. A legacy cached value without `@` is discarded.
- Claim button → `registerHandle` or `changeHandle`. `pending` shows a
  non-blocking "finishing…" state with a retry action; `rolled_back` tells the
  user the new handle was taken and the old one was kept.
- Saving the display name stays local-first; when a handle is registered it
  also calls `updateProfile`. The hint text now says the name is **public**
  (all 12 locales — the non-English hints were already stale).
- New-contact QR/share link unchanged.

## Pay — recipient step

- A registry tier joins `mergedSearchResults` in `UniversalSend.tsx`, ordered
  contacts → registry → overlay, de-duplicated by identity key (contacts win).
  Its own 400 ms timer and cancelled-flag cleanup; it never fires for input
  `classifyRecipientInput` resolves to a key or address, for fewer than 2
  characters, when no registry is configured, or when `walletUserId` is not a
  number.
- Routing: no `@`, or an `@domain` that is a prefix of the pinned domain →
  pinned registry. A complete other domain (`looksLikeDomain`) → resolve that
  domain. Anything else → no registry request.
- Each row shows the name line (public `displayName`, else the handle) and a
  second line with the full `handle@domain`, plus the existing "registered"
  badge (`pay_trust_handle_attested`). A contact row shows the user's own label
  and its `cachedHandle`.
- Rows stay visible while a remote tier is loading: `RecipientField` shows the
  spinner as a footer instead of replacing the list (today the "instant"
  contacts tier is hidden for the whole debounce).
- A registry failure raises the existing `identity_search_unavailable` notice;
  that notice is cleared when the step changes.
- Selecting a registry row goes through the existing `selectIdentity` path
  (handle rail, identity key). No new rail.

## Contacts

- "Save as contact" after a payment, and the New Contact route, accept an
  optional `handle` param; `createContact` stores it as `cachedHandle`
  (`handle@domain`). The prefilled, editable `name` is the public display name
  when there is one.
- `ContactScreen`'s background refresh also refreshes `cachedHandle` via
  `lookupProfile` (the domain of the cached handle when it has one, else the
  pinned registry). `lookupProfile`, not `lookupIdentityKey`: the latter
  flattens a timeout, a dead network and an unbelievable answer to the same
  `null` a 404 gets, and a refresh that read that as "no handle" would blank
  the column every time the screen was opened offline. Only an answer may
  change it — `found` writes the paymail, `none` clears it, `failed` leaves it
  exactly as it was. `name` is never touched by a refresh.

## Stability checklist (every write path)

| Hazard | Behaviour |
|---|---|
| Crash / kill between release and claim | Journal replays identical certs on next Profile mount. |
| Double tap, two mounted Profile screens | Shared in-flight promise; server no-ops on replay. |
| Timeout after the server applied the write | Replay → `200`; treated as success. |
| New handle taken between release and claim | Reclaim previous handle, report `rolled_back`. |
| Device clock ahead / behind | `serverNow()` skew correction + monotonic `issuedAt`. |
| Stale local cache (handle released/changed elsewhere) | Reverse lookup on mount wins. |
| Offline | Availability `failed` with retry; writes report `pending`; Pay shows contacts only. |
| Registry answers garbage / forged certs | `verifyProfileCertificate` drops them. |
| DoH unavailable / DNSSEC missing | Foreign domain → no results + notice; pinned domain unaffected. |

## Testing

Jest from the repo **root**. Real `@bsv/sdk` crypto for certificate tests (a
`ProtoWallet` as the signer) — no mocked signatures. Mock `fetch` for resolver
and client. Coverage required:

- `rules`: format table (server's accept/reject cases), `parsePaymail`.
- `profileCert`: build → verify round trip; every rejection in the trust model
  (wrong type, subject ≠ certifier via a third-party-signed cert, tampered
  field, wrong domain, uppercase paymail, released, non-zero outpoint, oversize
  field, reverse-lookup key mismatch); empty display name omitted.
- `resolver`: pinned short-circuit; SRV + AD; AD false rejected; SRV target ==
  domain without AD accepted; NXDOMAIN fallback; Cloudflare down → Google;
  both down → null; bad well-known (missing id, http template); caching/TTL.
- `client`: every status/code mapping; local `invalid` short-circuit; `search`
  throws on transport failure; `lookupIdentityKey` never throws; skew from
  `Date` header; foreign-domain routing.
- `registration`: happy paths; the full resume matrix from the stability table
  driven by a scripted fake client; monotonic `issuedAt`; in-flight sharing.
- `toolboxConfig`: getter validation table.
- `ProfileScreen`, `universalSend`, `RecipientField`, contacts tests extended
  for the behaviours above; existing tests keep passing unweakened.
- **Live test** `__tests__/identity/handleRegistry.live.test.ts`, skipped
  unless `HANDLE_REGISTRY_LIVE_URL` and `HANDLE_REGISTRY_LIVE_DOMAIN` are set:
  register → availability → search → reverse → update display name → change
  handle → old handle in cooldown for another key. Run against a local
  go-message-box-server on MongoDB.

## Out of scope

Release-handle button; registry tier in ContactsScreen's "Other people";
avatars; a message-box host inside the certificate (foreign-domain recipients
are paid through the default message box); multi-device contact sync.
