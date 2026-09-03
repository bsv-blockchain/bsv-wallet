# Universal Pay Input and Amount-First Request — Design

**Date:** 2026-09-02
**Status:** Approved, not yet implemented
**Amends:** `2026-08-26-wallet-first-payments-only-design.md` (the six-cell Pay grid), `core/pay/rails/index.ts` header comment ("Direction is the primary axis … the user never picks a transport")
**Builds on:** the uncommitted nearby-advisory work in `ui/screens/PayScreen.tsx` (`NearbyAdvisoryModal`, `core/localpay/nearbyAdvisory.ts`), which stays as-is

## Summary

The Pay screen stops asking "who are you paying?" as a menu. Both directions become one screen each:

1. **Pay** opens straight on a send form. One recipient field accepts anything — a base58check address, a compressed identity key, a `peerpay:` link, or free text that goes to identity search (handles, emails, phone numbers). A QR button on the field's right edge opens one scanner that recognises an address, a `peerpay:` link, a bare key, or a nearby-session code, and routes accordingly. The rail is inferred from what was typed or scanned; nothing is chosen.
2. **Get paid** opens on an amount field with three method rows beneath it — Nearby, Share remote link, To an address. The amount (or its absence) is set first and carried into whichever code is shown.

Alongside, four smaller changes the user asked for on the same screens:

- The message-box server bar and its cog leave the pay/receive screens for Settings › Advanced.
- The "Lands when their wallet next checks." callout is gone.
- The spendable-balance line moves under the amount input and reads "1,000 available" in the input's own unit, with no unit word.
- The remote-link QR/share encodes BRC-125 with a `url` extension parameter carrying the payee's message-box host, so the payer skips the overlay lookup.

## Verified facts this design is built on

- `PayScreen` renders a 3-row grid per direction, then swaps in one of six cell components; `cell` state drives header title and body (`ui/screens/PayScreen.tsx:83-141,377-416`). Back from anywhere is `router.dismissTo('/')` (`:339-341`). The uncommitted tree adds a nearby-advisory gate: `NearbyFlow` mounts only when `nearbyAdvisorySeen === true` (`:207-224,400-412`).
- `classifyScan(raw): PayTarget | null` already exists and is pure: `peerpay:` → handle (+sats), `bitcoin:` → address, `bsvpay1:` → nearby session, bare key → handle, bare base58check → address, else null (`core/pay/rails/index.ts:96-121`). Bare-key check uses `PublicKey.fromString`, which also accepts uncompressed keys. `PayTarget` is `{kind:'nearby',session} | {kind:'handle',identityKey,sats?} | {kind:'address',address,sats?}` (`:17-20`).
- `validatePeerPayURI` accepts only `peerpay:` (lowercased), reads `sats`, rejects non-compressed keys (`core/parsePeerPayURI.ts:16-63`). `peerPayLinkFor(identityKey, sats?)` emits `peerpay:<key>?sats=N` or `peerpay:<key>` (`core/pay/rails/handle.ts:74-77`). `app/+native-intent.ts` forwards any `peerpay:` system path to `/pay?cell=pay-handle&peerpay=<encoded>`.
- BRC-125 (`https://bsv.brc.dev/payments/0125`, author Deggen): `peerpay-URI = "peerpay:" identity-key [ "?" query ]`; `sats-param = "sats=" 1*DIGIT`; `extension-param = token "=" *pchar`; unknown params MUST be ignored; wallets MUST reject an invalid compressed key. The user confirmed: `sats` is the amount param, `url` is an extension.
- `@bsv/message-box-client` 2.2.1: `sendMessage(message, overrideHost?)` uses `overrideHost ?? await this.resolveHostForRecipient(recipient)` — the override skips the overlay lookup entirely (`MessageBoxClient.ts:972-990,482-490`). `PeerPayClient.sendPayment(payment, hostOverride?)` threads the same parameter.
- `sendViaHandle` calls `client.sendMessage({recipient, messageBox: 'payment_inbox', body})` with no host argument (`handle.ts:462-466`), after `saveOutboxEntry(storage, {recipient, token, messageBoxUrl, txid})` (`:449`). `retryDelivery` re-sends the same way from an `OutboxEntry` (`handle.ts:571-575`). `OutboxEntry` has `messageBoxUrl` (the sender's own host at creation) but nothing about the recipient's host (`core/peerpay/outbox.ts`).
- `HandleSend` owns: `useMessageBoxConfig` + `MessageBoxBar` + inline `ConfigPanel` at the top; `RecipientField` driven by `useIdentitySearch`; amount; note; `ConsequenceNote(CONSEQUENCE_KEYS.handle)`; `PayCta`; stuck-outbox section (blocks all sends while non-empty); a `QRScanner` modal that accepts `peerpay:` or a bare key (`ui/components/pay/HandleSend.tsx`, `useIdentitySearch.ts:129-156`). `setShowConfig(true)` is the fallback when no client can be built (`HandleSend.tsx` retry/cancel paths).
- `AddressSend` owns: address input + scan button, `isValidBsvAddress` on change, amount, `ConsequenceNote(CONSEQUENCE_KEYS.address)`, `PayCta`, `sendToAddress` (`ui/components/pay/AddressSend.tsx`).
- `useIdentitySearch.handleSearchChange` already branches: valid `PublicKey.fromString(text)` → direct recipient, else 400 ms debounced `searchIdentities(client, text)` via `IdentityClient.resolveByAttributes({attributes:{any:text}})` (`useIdentitySearch.ts:62-97`, `ui/resolveIdentity.ts:92-103`).
- `NearbyFlow` payer: a once-per-mount effect calls `openScanner('send_scan')`; `onSessionScanned(data)` decodes, sets `scannedSession`, `peerKey`, `role`, and moves to `send_confirm` (`NearbyFlow.tsx:634-643,1151-1171`). Payee: the same effect sets `receive_amount`; `startRequest()` reads `requestAmount` state, maps 0/blank to an open session, and mints (`:1034-1100`). `reset()` returns the payee to `receive_amount` (`:661-690`). The `receive_amount` view shows title `local_pay_request`, subtitle `local_pay_amount_optional_hint`, `PayAmountField showMax={false} showBalance={false}`, Continue, Cancel (`:1859-1881`).
- `HandleReceive` shows `MessageBoxBar` + `ConfigPanel`, a 240 pt QR of the bare identity key, the key text, Copy (key) and Share (`peerPayLinkFor(identityKey)`), the attention inbox (`HandleReceive.tsx:362-364,436-451,680-750`). `AddressReceive` shows a 240 pt QR of the bare address (`AddressReceive.tsx:307`).
- `WalletConfigScreen` has a collapsible Advanced group whose Configuration section holds Network and ARC endpoint rows that expand inline (`ui/screens/WalletConfigScreen.tsx:603-720`). `ConfigPanel` is already a standalone component with Save / Default / Use no server (`ui/components/pay/MessageBoxConfig.tsx:196-262`).
- `PayAmountField` renders `AvailableBalance` then `AmountInput` (`ui/components/pay/PayForm.tsx:55-70`). `AvailableBalance` renders a wallet glyph, `<AmountDisplay>{balance}</AmountDisplay>`, and `t('available')` (`AvailableBalance.tsx:33-51`). `AmountInput` labels its unit `'satoshis'` in BSV mode and `'USD'` in USD mode; the value it emits is always integer satoshis (`ui/components/wallet/AmountInput.tsx:174-177`). `formatAmountParts` splits figure from unit for BSV but returns a `$`-prefixed figure for USD (`core/amountFormatHelpers.ts:185-196`).
- `WalletHomeScreen` pushes `/pay`, `/pay?direction=get`, `/pay?cell=pay-handle`, `/pay?cell=get-handle`, `/pay?sats=N` (`WalletHomeScreen.tsx:913,972,1115,1126,1194,1215`). `legacyRedirectTarget` maps the three retired routes to `pay-handle` / `get-address` / `get-nearby` (`rails/index.ts:129-140`).
- Existing coverage: `__tests__/ui/payScreen.test.tsx` (grid + deep links, cells mocked to host strings), `__tests__/pay/rails.test.ts` (`classifyScan`, address validation, copy keys, legacy redirects), `__tests__/pay/handleRail.test.ts`, `__tests__/ui/payFormComponents.test.tsx` (`AvailableBalance` mocked to a testID).
- `translations.tsx` carries twelve locales (`en zh hi es fr ar pt bn ru id ja pl`); every key exists in all twelve.

## Non-goals

- **Get-paid back button returning to the hub.** Back from any receive method still means "back to the wallet" (`dismissTo('/')`), as it does today. The hub is one tap away and holds no state worth preserving.
- **Toast or error UI for an unrecognised QR.** Both existing scanners ignore junk and keep scanning; the unified scanner does the same.
- **BIP21 amounts on the address QR.** The address QR is the bare address even when an amount was entered. `classifyScan` keeps stripping `bitcoin:` queries without reading them.
- **Detecting "handle / email / phone" as distinct shapes.** Anything that is not an address, a key or a `peerpay:` link is a search query. The identity overlay is the judge of what a handle is.
- **Localising `ConfigPanel`'s hard-coded "Default" and "Use no server" labels.** Pre-existing, unchanged by the move.
- **Documenting `url` in BRC-125 itself.** Outside this repo; the author is the user.
- **Removing the `PayCell` type or `legacyRedirectTarget`.** Cell names survive as deep-link aliases; the redirects still resolve to the right place.

## Design

### 1. Pay screen structure

`PayScreen` keeps its header, offline notice plumbing, re-show-code modal and nearby-advisory gate. What changes is the body:

```
direction === 'pay'
  nearbySession === null → <UniversalSend … onNearbySession={setNearbySession} />
  nearbySession !== null → advisory gate → <NearbyFlow role="payer" initialSession={nearbySession} onExit={goBack} />

direction === 'get'
  cell === null → <RequestHub requestSats onChangeRequestSats onPick={setCell} />
  cell === 'get-nearby'  → advisory gate → <NearbyFlow role="payee" initialRequest={{ sats }} onExit={goBack} />
  cell === 'get-handle'  → <HandleReceive initialSats={sats} />
  cell === 'get-address' → <AddressReceive initialSats={sats} />
```

`CELLS`, `PayCellRow` rows for the pay direction, and the `grid()` for the pay side are deleted. The `OfflineNotice` block that used to sit above the grid renders above `UniversalSend` and above `RequestHub` instead — same component, same props.

Header title: `pay_direction_pay` on the send form; `pay_cell_nearby_pay` once a nearby session is live. `local_pay_request` ("Request Payment") on the hub; the method's label (`pay_method_*`, §5) inside a method.

**Deep links.** `?cell=pay-handle|pay-address` → `UniversalSend` with nothing prefilled (the cell name no longer changes anything). `?cell=pay-nearby` → `UniversalSend` with the scanner opened on mount. `?peerpay=…` → `UniversalSend` with `initialTarget` = the validated handle target (key, sats, messageBoxUrl) and `initialNotice` for a malformed link, exactly as `HandleSend` receives them today. `?identityKey=&sats=` → same, as today. `?direction=get` → hub. `?cell=get-*` → that method directly with `initialSats` undefined (the hub is skipped; the home screen's attention badge relies on this).

### 2. Input classification (pure, `core/pay/rails/index.ts`)

```ts
export type RecipientInput =
  | { kind: 'empty' }
  | { kind: 'address'; address: string }
  | { kind: 'invalid_address' }
  | { kind: 'handle'; identityKey: string; sats?: number; messageBoxUrl?: string }
  | { kind: 'invalid_link'; message: string }
  | { kind: 'search'; query: string }

export function classifyRecipientInput(raw: string): RecipientInput
```

Order, first match wins, on `raw.trim()`:

1. Empty → `empty`.
2. Starts with `peerpay:` (case-insensitive) → `validatePeerPayURI`. A valid key → `handle` with `sats` and `messageBoxUrl`. An invalid key or amount → `invalid_link` with the validator's message (via `peerPayValidationMessage`). A malformed link is neither a search query nor a payable key, so it gets its own shape and its own banner.
3. Starts with `bitcoin:` → `normalizeAddressInput`, then the address rule.
4. **Address candidate:** `/^1[1-9A-HJ-NP-Za-km-z]{24,34}$/`. Checksum via `Utils.fromBase58Check` → `address`; checksum failure → `invalid_address`. This is the only shape that produces an inline error while typing: a candidate that fails its checksum is almost always a mis-paste, and searching the overlay for it would be noise. A US phone number typed as `12125551234` is 11 characters and never reaches this rule.
5. **Compressed key:** `/^0[23][0-9a-fA-F]{64}$/` and `PublicKey.fromString` succeeds → `handle` with the key lowercased (BRC-125 wants lowercase; the wallet's own keys already are).
6. Anything else → `search`.

**`classifyScan` changes.** The bare-key branch uses the same compressed-only test as rule 5. The `peerpay:` branch carries `messageBoxUrl` into the handle target. `PayTarget`'s handle variant gains `messageBoxUrl?: string`.

### 3. BRC-125 with the `url` extension

**Emit** — `peerPayLinkFor(identityKey, sats?, messageBoxUrl?)`:

```
peerpay:<identityKey>[?sats=<n>][&url=<encodeURIComponent(host)>]
```

`sats` is present only for a positive finite integer (as today). `url` is present only when `messageBoxUrl` is a non-empty string other than `NO_MESSAGE_BOX`; it is the payee's configured host with trailing slashes trimmed. Query separator logic: `?` before the first present param, `&` between. The identity key is emitted lowercase.

**Parse** — `validatePeerPayURI(uri)`:

- Scheme: `peerpay:` per spec; `peerpay://` is also accepted and the slashes are dropped before the key is read. Tolerance only — the app never emits `//`.
- `sats`: unchanged.
- `url`: read from the same `URLSearchParams` (which percent-decodes). Accepted only if it matches `/^https:\/\/[^\s/?#]+(?:[/?#]\S*)?$/i`; trailing slashes are trimmed. Anything else — `http:`, a bare host, whitespace, empty — is **ignored**, not an error: BRC-125 says extension params are ignorable, and a bad hint must not block a payment whose key is fine. The overlay lookup is the fallback. Result type gains `messageBoxUrl?: string`.
- Only `https:` because the payer will authenticate (BRC-103) against whatever host this names, and a QR is an untrusted input.

**Send** — `sendViaHandle` gains `recipientHost?: string`. It is passed as the second argument to `client.sendMessage(message, recipientHost)`, and persisted on the outbox entry as `recipientHost`. `OutboxEntry` gains `recipientHost?: string`; `saveOutboxEntry` accepts it. `retryDelivery` passes `entry.recipientHost` to `sendMessage`. The drain task's re-send path (whatever calls `retryDelivery` or `sendMessage` for an outbox entry from `TaskDrainOutbox`) passes the same field — verified at implementation time; the invariant is *every re-send of an entry goes to the host it was minted for*. Entries without the field behave exactly as today.

`Pick<PeerPayClient, 'sendMessage'>` already types the second parameter, so no client-shape changes.

### 4. `UniversalSend` (replaces `HandleSend` and `AddressSend`)

`ui/components/pay/UniversalSend.tsx`, evolved from `HandleSend`. Props:

```ts
export interface UniversalSendProps {
  initialTarget?: { kind: 'handle'; identityKey: string; sats?: number; messageBoxUrl?: string }
  initialNotice?: string | null
  /** Open the scanner on mount (deep link `cell=pay-nearby`). */
  openScannerOnMount?: boolean
  /** A scanned nearby-session code: the Pay screen swaps this form for NearbyFlow. */
  onNearbySession: (session: Session) => void
}
```

**Recipient state** lives in `useRecipientInput` (renamed and evolved from `useIdentitySearch`; the file moves with it, the barrel exports follow). It keeps the search machinery verbatim and adds the address kinds:

- `onChangeText(text)` → `classifyRecipientInput(text)`:
  - `empty` → clear target, clear results.
  - `address` → `target = {kind:'address', address}`; no search.
  - `invalid_address` → `target = null`, `inlineError = 'invalid_bsv_address'`; no search.
  - `handle` → `target = {kind:'handle', …}`; if `sats` is present, `onPeerPayAmount(sats)`; no search.
  - `invalid_link` → `target = null`, `onPeerPayError(message)` (the banner `HandleSend` already shows).
  - `search` → debounced `searchIdentities`, as today; selecting a result sets `target = {kind:'handle', identityKey}` and `selectedIdentity`.
- `onScan(data)` → `classifyScan(data)`:
  - `handle` → set target (+sats via `onPeerPayAmount`), close scanner.
  - `address` → set target, close scanner.
  - `nearby` → close scanner, `onNearbySession(session)`.
  - `null` → nothing; the scanner keeps looking (`multiScan`).
- Exposes `target: PayTarget | null`, `inputText`, `inlineError`, `selectedIdentity`, `searchResults`, `isSearching`, `searchError`, and the handlers.

**`RecipientField`** changes: placeholder key `recipient_placeholder` ("Handle, pubkey, or address..."); the status row under the input shows `valid_identity_key` (green key glyph) for a handle target that came from a key or link, `valid_bsv_address` (green wallet glyph) for an address target, or `invalid_bsv_address` (red) for `invalid_address`; the selected-identity card is unchanged. The QR button's accessibility label becomes `t('scan_qr_code')` (it is a hard-coded English string today).

**Form composition** by `target?.kind`:

| Element | none | `handle` | `address` |
|---|---|---|---|
| Amount field | yes | yes | yes |
| Note field | no | yes | no |
| Consequence note | no | no (dropped) | `CONSEQUENCE_KEYS.address` |
| Message-box-off hint | no | when server is Off | no |
| Stuck-outbox hint + section | if entries | if entries | section only; does not block |
| CTA enabled | no | key ∧ amount>0 ∧ configured ∧ outbox empty ∧ !sending | address ∧ amount>0 ∧ !sending |

**Send** dispatches on kind: `handle` → `sendViaHandle({…, recipient, recipientHost: target.messageBoxUrl, note, recipientName})`; `address` → `sendToAddress({…, address})`. Success overlay shows the resolved name for a handle (as today) and the address string for an address (as today). Errors follow each rail's existing handling (`userFacingPayError`, `promptCheckWallet`, `isMessageBoxNetworkError`).

**Message-box configuration** is read, never edited, here: `useMessageBoxConfig` still supplies `messageBoxUrl` (the hook's `showConfig`/`urlInput`/save handlers are simply unused on this screen). Every `setShowConfig(true)` fallback in the retry/cancel paths becomes `showToast(t('message_box_off_hint'), {type:'error'})`. When `messageBoxUrl === NO_MESSAGE_BOX` and the target is a handle, a footnote under the CTA reads `message_box_off_hint` ("Message box server is off. Turn it on in Settings › Advanced.").

**Scanner** is one `QRScanner` modal with `multiScan`, hint `scan_recipient_hint` ("Point the camera at a payment code"). `scan_identity_key_hint` and `scan_bsv_address_hint` are removed if nothing else uses them.

`HandleSend.tsx` and `AddressSend.tsx` are deleted. `ui/index.ts` exports `UniversalSend` (+ props type) and `useRecipientInput` in their place; `HandleSend`, `HandleSendProps`, `AddressSend`, `useIdentitySearch`, `MessageBoxBar` leave the barrel.

### 5. `RequestHub` (get-paid entry)

`ui/components/pay/RequestHub.tsx`. Props:

```ts
export interface RequestHubProps {
  requestSats: string                  // raw satoshi string, '' = open request
  onChangeRequestSats: (v: string) => void
  onPick: (cell: 'get-nearby' | 'get-handle' | 'get-address') => void
  online: boolean
}
```

Layout, top to bottom, in a `ScrollView` with `keyboardShouldPersistTaps="handled"`:

1. `PayAmountField value={requestSats} onChangeText showMax={false} showBalance={false}`. No subtitle. Blank or zero means "payer decides"; the design says it by not gating anything on the figure.
2. `PayField labelKey="pay_method"` wrapping three `PayCellRow`s:

| Row | title key | subtitle key | icon | offline |
|---|---|---|---|---|
| Nearby | `pay_method_nearby` | `pay_cell_nearby_get_sub` ("Show your payment code") | `qr-code-outline` | enabled |
| Share remote link | `pay_method_remote_link` | `pay_cell_handle_get_sub` ("Share your handle") | `share-outline` | disabled, subtitle `pay_offline_needs_internet` |
| To an address | `pay_method_address` | `pay_cell_address_get_sub` ("Show an address") | `wallet-outline` | disabled, subtitle `pay_offline_needs_internet` |

`PayScreen` owns `requestSats` state so it survives into the method and is passed as `initialSats = satsFrom(requestSats) || undefined`.

### 6. Receive methods carry the amount

**`NearbyFlow`** gains two optional props, one per role:

```ts
/** Payer only: a session already scanned by the Pay screen. Skips the scanner. */
initialSession?: Session
/** Payee only: start minting immediately for this amount (undefined = open). Skips receive_amount. */
initialRequest?: { sats?: number }
```

- `startRequest()` becomes `startRequest(sats: number | undefined)`; the `receive_amount` Continue button passes `satsFrom(requestAmount) || undefined`. `onSessionScanned(data)` is split: `adoptSession(session: Session)` does the state moves, `onSessionScanned` decodes and calls it.
- The once-per-mount effect moves below those definitions and becomes: payee → `initialRequest ? startRequest(initialRequest.sats) : setPhase('receive_amount')`; payer → `initialSession ? adoptSession(initialSession) : openScanner('send_scan')`.
- `reset()` with `initialRequest` (payee) or `initialSession` (payer) calls `onExit()` instead of re-entering a phase this mount can no longer reach; without either prop, unchanged. The phase machine itself is untouched; `receive_amount` and the payer `entry` view stay for the no-prop path.

**`HandleReceive`** gains `initialSats?: number`. `link = peerPayLinkFor(identityKey, initialSats, messageBoxUrl)`; the QR encodes `link` (not the bare key) and Share shares `link`. Copy still copies the bare key. When `initialSats` is set, the requested figure renders above the QR at title scale (same `AmountDisplay` treatment `NearbyFlow` uses on `receive_wait`). `MessageBoxBar` and the inline `ConfigPanel` are removed; the hook stays for `messageBoxUrl` and `isConfigured`. The attention inbox and everything below the QR is unchanged.

**`AddressReceive`** gains `initialSats?: number`, rendered above the QR the same way. The QR value stays the bare address.

### 7. Message-box server in Settings › Advanced

`WalletConfigScreen`'s Advanced › Configuration group gets a row after ARC endpoint:

```
ListRow label={t('message_box_server')}
        value={url === NO_MESSAGE_BOX ? t('message_box_off') : url.replace(/^https:\/\//, '')}
        icon="mail-outline" onPress={toggle} showChevron chevronDown={expanded}
{expanded && <ConfigPanel …useMessageBoxConfig bindings… />}
```

`ConfigPanel` and `useMessageBoxConfig` are reused unchanged; the hook's `showConfig` becomes the row's expanded state (its auto-open on `NO_MESSAGE_BOX` is harmless here — the row simply opens expanded). `MessageBoxBar` is deleted from `MessageBoxConfig.tsx`.

### 8. Amount field and balance line

`PayAmountField` renders `AmountInput`, then `AvailableBalance` (when `showBalance`).

`AvailableBalance` renders one footnote line: `<figure> available`, no glyph. The figure comes from a new pure helper:

```ts
/** The spendable figure in the unit AmountInput is currently asking for — sats in BSV mode, plain 2-dp in USD mode — with no symbol or unit. */
export function formatAmountInInputUnit(satoshis: number, currency: string, satoshisPerUSD: number): string
```

BSV mode → grouped integer satoshis (`formatSatoshisLocale`), never the ≥1 BSV switch, because the input beside it says "satoshis". USD mode → `satoshis / satoshisPerUSD` to two decimals, locale grouping, no `$`; if `satoshisPerUSD <= 0` the line renders nothing (no rate, no figure). Styles: `marginTop: spacing.sm`, no bottom margin (the `PayField` wrapper already spaces the group).

### 9. Copy

New keys, all twelve locales:

| key | en |
|---|---|
| `recipient_placeholder` | Handle, pubkey, or address... |
| `valid_bsv_address` | Valid address entered |
| `scan_recipient_hint` | Point the camera at a payment code |
| `message_box_off_hint` | Message box server is off. Turn it on in Settings › Advanced. |
| `message_box_off` | Off |
| `pay_method` | Method |
| `pay_method_nearby` | Nearby |
| `pay_method_remote_link` | Share remote link |
| `pay_method_address` | To an address |

Removed keys (all locales): `local_pay_amount_optional_hint`, `search_name_or_key`, and `scan_identity_key_hint` / `scan_bsv_address_hint` if no other caller remains. `pay_conseq_handle` stays in the file and in `CONSEQUENCE_KEYS` (the rails test asserts every rail has one) but is no longer rendered. `pay_cell_*_pay` keys stay: `pay_cell_nearby_pay` is still the nearby header title, and the others are cheap to keep as deep-link vocabulary.

## Data flow

**Pay by text.** Keystroke → `classifyRecipientInput` → state (`target`, `inlineError`, or debounced search) → form recomposes by `target.kind` → CTA → `sendViaHandle(recipientHost?)` or `sendToAddress` → success overlay.

**Pay by QR.** Tap QR button → scanner → `classifyScan` → handle/address: target set, scanner closes; nearby: `onNearbySession` → `PayScreen` sets `nearbySession` → advisory gate → `NearbyFlow` mounts with `initialSession` → `adoptSession` → `send_confirm`.

**Pay from a link.** OS opens `peerpay:…` → `+native-intent` → `/pay?cell=pay-handle&peerpay=…` → `validatePeerPayURI` → `initialTarget {key, sats, messageBoxUrl}` → `UniversalSend` prefilled → send goes to `messageBoxUrl` when present.

**Get paid.** Amount typed on hub → tap method → `PayScreen` sets `cell` → method mounts with `initialSats` → Nearby mints a session for it; Remote encodes `peerpay:<key>?sats=N&url=<host>`; Address shows the figure above a bare-address QR.

## Error handling

- Checksum-broken address candidate: inline red `invalid_bsv_address` under the field, no lookup, CTA disabled.
- Malformed `peerpay:` pasted or scanned: existing error banner with the validator's message; scanner stays open for a scan.
- Unrecognised QR: ignored, scanner keeps looking.
- `url` extension malformed or non-https: silently dropped; send falls back to overlay resolution.
- Message box Off with a handle target: CTA disabled, footnote points at Settings › Advanced. Address targets are unaffected.
- Retry/cancel paths that used to open the inline config panel: error toast with the same footnote copy.
- Identity search outage: existing `identity_search_unavailable` banner.
- Everything on the nearby path (advisory, permissions, transport failures) is unchanged.

## Testing

Pure, in `__tests__/pay/`:

- `rails.test.ts`: `classifyRecipientInput` — empty; valid address; checksum-broken candidate → `invalid_address`; `bitcoin:` prefix; compressed key (upper and lower) → lowercase handle; uncompressed key → `search`; `peerpay:` with `sats` and `url` → handle carrying both; malformed `peerpay:` → `invalid_link`; a phone-shaped `12125551234` → `search`; an email → `search`. `classifyScan` — rejects an uncompressed bare key; carries `messageBoxUrl` from a `peerpay:` link.
- `parsePeerPayURI` cases (new file or in `rails.test.ts`): `peerpay://` tolerated; `url` accepted when https and percent-encoded; `url` dropped when `http:`, empty, or garbage; `sats` still parsed alongside.
- `handleRail.test.ts`: `peerPayLinkFor` with `url`, with `sats` only, with neither, with `NO_MESSAGE_BOX` (no `url`); `sendViaHandle` passes `recipientHost` as `sendMessage`'s second argument and persists it on the entry; `retryDelivery` re-sends to `entry.recipientHost`; an entry without the field sends with `undefined`.
- `amountFormatHelpers` test: `formatAmountInInputUnit` in BSV mode (grouping, no unit, ≥1 BSV stays in sats), USD mode (2 dp, no `$`), USD with no rate → empty.

Render, in `__tests__/ui/`:

- `payScreen.test.tsx` rewritten: pay direction mounts `UniversalSend`, no grid rows; `cell=pay-nearby` sets `openScannerOnMount`; `peerpay` param becomes `initialTarget` with key, sats and url; get direction mounts `RequestHub`; `cell=get-handle` mounts `HandleReceive` with `initialSats` undefined; picking a method from the hub mounts it with the typed amount.
- `requestHub.test.tsx` (new): amount field present, three rows present, two disabled offline, `onPick` fires with the right cell.
- `payFormComponents.test.tsx`: balance line renders after the input; `showBalance={false}` still hides it.
- `useRecipientInput` gets the same pure-export coverage `useIdentitySearch` had (`classifyIdentitySearchError`, `peerPayValidationMessage`).

Manual, on device (no unit coverage possible): scanning each of the four code kinds from the unified scanner; a nearby session flowing from the scanner into `NearbyFlow`'s confirm step; the hub → Nearby → pairing QR with and without an amount; Settings › Advanced message-box row saving and switching Off.

## Migration and cleanup

- Delete `HandleSend.tsx`, `AddressSend.tsx`, `MessageBoxBar` (component only). Rename `useIdentitySearch.ts` → `useRecipientInput.ts` and its test.
- Update `ui/index.ts` exports and any importer of the removed names (grep `HandleSend|AddressSend|useIdentitySearch|MessageBoxBar` across `app/` and `packages/`).
- Rewrite the `rails/index.ts` header comment and the `PayScreen.tsx` header comment to describe the new shape.
- The `PayCell` union and `isPayCell` stay; `pay-*` values are deep-link aliases now, and a comment says so.

## Deferred

- Back from a receive method → hub, if the one-tap re-entry proves annoying in use.
- A gentle toast on an unrecognised QR.
- Showing "via <host>" on the send form when a link supplied a message-box URL.
- Localising `ConfigPanel`'s two hard-coded labels.
- Recording the `url` extension in BRC-125.

## Decisions log

| # | Decision | Chosen |
|---|---|---|
| a | Get-paid side | Redesigned as amount-first hub (superseded the "keep chooser" pick) |
| b | Message-box bar on `HandleReceive` | Removed; Settings › Advanced is the one home |
| c | Unrecognised QR | Silent, keep scanning |
| d | Balance line glyph | Dropped |
| e | `HandleSend`/`AddressSend` in package barrel | Removed |
| f | Back from a receive method | Wallet, not hub |
| g | Handle QR payload | Always the `peerpay:` link |
| h | Address receive with an amount | Figure shown above QR; QR stays bare |
| i | BRC-125 params | `sats` for amount, `url` as extension, scheme `peerpay:` (no `//`), `//` tolerated on parse |
