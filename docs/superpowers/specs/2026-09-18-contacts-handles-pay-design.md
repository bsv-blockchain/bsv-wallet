# Contacts, handle registration, profile, and 3-step Pay

Status: approved via canvas review (29-artboard Design artifact, v19, all comments
resolved 2026-09-18). Implementation starts this branch:
`feat/contacts-handles-profile-pay-redesign`.

## Why

Payments are keyed off raw identity keys with no durable local naming, no way
to register a memorable handle, and no profile surface. Pay is a single dense
form mixing recipient/amount/review into one screen. This spec adds Contacts
(local naming), handle registration (a certificate, not a new pay rail), a
Profile screen, and restructures Pay into three steps: who → amount → review.

## Contacts

**Data model** — new `contacts` table (userId-scoped, local only; @bsv/sdk's
`ContactsManager` and `@bsv/mandala`'s `contactsStore` are rejected for v1
because every write there is a signed on-chain action):

```
contacts(contactId PK, created_at, updated_at, userId FK, identityKey,
         name, cachedHandle, cachedAvatarUrl, cachedCertifier, source)
UNIQUE(userId, identityKey)
```

`name` is the user's own label — never overwritten by a background refresh.
`cachedHandle`/`cachedAvatarUrl`/`cachedCertifier` are best-effort mirrors of
what `resolveIdentity` last saw, refreshed silently, read-only in the UI.
`source` records how the contact was created (`manual`, `qr`, `pay`).

**Store** — `core/contacts/contactsStore.ts`, same shape as
`core/mandala/settlementStore.ts`: a `ContactsDb` interface
(`runAsync`/`getAllAsync`/`getFirstAsync`) over `storage.sqliteDb`, logic-free
SQL. Operations: `listContacts`, `searchContacts` (substring match on `name`
and `cachedHandle`, case-insensitive — "fuzzy" in the design sense of
forgiving substring matching, not a scored fuzzy algorithm), `getContact`,
`getContactByIdentityKey`, `createContact`, `renameContact` (name only),
`refreshContactCache` (cached fields only, never touches `name`),
`deleteContact`.

**Activity pane** — every interaction with the counterparty, every asset,
both directions (Deggen ruling, 2026-09-17 canvas comment). Implemented in
`core/contacts/contactActivity.ts`:

- Outbound BSV/peer sends: `listActions({ labels: [identityKey], labelQueryMode: 'any', includeLabels: true })` — exact, since the handle and nearby rails both label a sent action with the recipient's key.
- Inbound + anything the label filter can't reach: the most recent 200 actions (`listActions({ limit: 200, includeLabels: true })`), filtered client-side with `counterpartyOf()`. This is a bounded recent window, not full history — an old inbound payment outside that window will not appear. Documented limitation, acceptable for v1; a future pass can add a `senderIdentityKey` index the same way `token_settlements.counterpartyKey` gets one here.
- Token transfers: `SELECT * FROM token_settlements WHERE counterpartyKey = ?`, via a new `idx_token_settlements_counterpartyKey` index and a `listSettlementsByCounterparty` addition to `settlementStore.ts`.
- Address-rail activity is never attributable to a contact (no key in the label) and is excluded, same as everywhere else in the app.

Merged and sorted by timestamp, descending.

**Screens** (`ui/screens/ContactsScreen.tsx`, `ContactScreen.tsx`,
`NewContactScreen.tsx`, routed at `app/contacts.tsx`, `app/contact.tsx`
(`?identityKey=`), `app/contact/add.tsx`):

- Contacts: search field (name/handle), grouped list, header QR button →
  scanner → prefills New Contact with the scanned `identityKey`. Back
  returns to Pay (it is reached from Pay step 1, not Home — see below).
- Contact: hero (sigil or avatar — never initials), name with pencil→confirm
  edit, read-only `@handle` caption ("registered" — never a certifier name),
  activity list, destructive Delete.
  - Skipped: manual handle-availability display refresh — see handle-registration section below.
- New Contact: same edit affordance for name, identity key shown read-only,
  Save writes `source: 'qr'` when opened via scan/deep-link or `source: 'manual'` otherwise.

## Handle registration

No backend uniqueness service exists in this repo or anywhere this session
could reach. What ships:

- `core/identity/handleCertificate.ts`: `registerHandle(wallet, handle)` calls
  the wallet's own `acquireCertificate` for a new certificate type (constant
  `HANDLE_CERT_TYPE`, a fresh base64 type id — never the string `'handle'` in
  code, since that name is the existing pay rail id), then
  `IdentityClient.publiclyRevealAttributes(['handle'])` to `tm_identity` so it
  becomes discoverable the same way name/avatar already are.
- `checkHandleAvailability(idClient, handle)`: the ONLY real check available
  today is `searchIdentities` (secondary/advisory, per the original design —
  "overlay `resolveByAttributes` only as secondary read"). There is no
  certifier-side uniqueness authority to ask first. This is a flagged gap:
  registering a handle already taken by someone else will succeed at the
  certificate layer and only be caught, if at all, by this overlay search
  racing another user's registration. Shipping anyway because blocking the
  whole feature on a backend that does not exist would leave Contacts/Pay/
  Profile undeliverable too; the UI states are wired for a real check to drop
  in later (`checking` / `available` / `taken` / `invalid` / `failed`).
- Profile screen never names a certifier (Deggen ruling) — copy reads
  "registered", not "attested by X".

## Profile

`ui/screens/ProfileScreen.tsx`, routed at `app/profile.tsx`. Reached from a
34pt chrome-disc button top-left of Home (`ProfileButton`, passed via
`WalletHomeScreen`'s existing unused `topLeft` prop from `app/index.tsx` — no
package API change).

- Avatar (display-only — no uploader in this pass, matches the rest of the
  app; UHRP resolution the same as everywhere else).
- Handle: current registered handle, or the register flow
  (checking/available/taken/invalid/failed) from the section above.
- Display name: pencil→confirm edit, same affordance as Contact/New Contact.
  This is a public `IdentityClient.publiclyRevealAttributes(['displayName'])`
  reveal (the same one this wallet already publishes name/avatar under),
  not a contacts-table write.
- QR: `bsv-wallet://contact/add?identityKey=<hex>` (Deggen ruling,
  2026-09-18) — a deep link straight to this app's add-contact screen, not a
  bare key and not `peerpay:`.

## Deep link

`app/+native-intent.ts` already strips the `bsv-wallet://`/`bsv-browser://`
scheme and returns the remainder as a relative route. `contact/add?identityKey=…`
therefore needs no new mapping — it resolves directly to `app/contact/add.tsx`,
which reads `?identityKey=` and opens New Contact prefilled and read-only on
that field.

## Pay: three steps, one form

Restructuring `UniversalSend.tsx` end-to-end was considered and rejected: it
is ~1200 lines of load-bearing money logic (token pre-flight, the PeerPay
outbox, nearby handoff, peerpay-link adoption, message-box config) that this
spec does not touch. Instead, the existing hooks and handlers stay exactly as
they are; a `step: 'who' | 'amount' | 'review'` piece of UI state controls
which fields render, replacing the single scrolling form:

- **who** — `RecipientField` (unchanged) plus a local-contacts tier searched
  ahead of the existing 400ms `searchIdentities` debounce (instant, and
  labelled "Recent" on an empty query — `contactsStore.listContacts`, most
  recently used first). QR button stays where it is. Below the field: the
  outlined **Contacts** button (full-width) until a recipient is chosen, then
  only **Continue** — both drive `step`, nothing else changes.
- **amount** — `PayAmountField` (unchanged) and nothing else on screen,
  directly under the 4px `StepProgress` bar (lifted from `EnrollWizard`, no
  "Step n of 3" caption). Continue advances to review.
- **review** — one compact card: recipient (avatar/sigil, @handle, name),
  amount (what actually moves — BSV or the token, never the display-currency
  conversion), an editable note (pencil), then Send directly beneath. This is
  the screen's only accent-filled control, replacing `PayCta` at the top
  level; the token pre-flight notes (`ConsequenceNote`, the failure banner)
  still render here since Send is still the same `handleSend` this file
  already has.

`Contacts` is reached from the bottom of step **who** exclusively — not from
Home, not from the coin switcher. Back from Contacts returns to Pay step
**who** with any selection applied via the existing `selectIdentity`/
`setDirectTarget` path.

## Non-goals / explicit assumptions

- No manual "add contact" form beyond QR scan, search-and-save, and the
  post-payment "save as contact" affordance (all from the canvas rulings).
- Home's activity list stays display-currency-first; only money-in-flight
  screens (Review/Send/Sent) show the moved asset. Revisit if asked.
- Contacts are local-only; no multi-device sync in this pass.
- Light-mode caption contrast (`textSecondary`/`textTertiary` at small sizes)
  is a pre-existing token issue, not something this feature fixes.

## Testing

- `contactsStore` and `contactActivity`: unit tests against `node:sqlite`
  in-memory, mirroring `__tests__/mandala/settlementStore.test.ts`.
- `handleCertificate`: unit tests against a mocked `WalletInterface`/
  `IdentityClient`.
- UI: manual verification in the iOS Simulator (this repo is Expo/React
  Native; there is no web preview path for it per existing project guidance).
