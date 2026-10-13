# Backend integration

Each service the BitcoinSV wallet talks to, as of 2026-10-10. For each one:

- where the app is configured;
- what it sends and expects;
- what BSVA still has to supply before it works in production.

The setting names, with development defaults, are in [`../.env.example`](../.env.example). Per-profile values are in [`../eas.json`](../eas.json).

## At a glance

| Service | Status | Waiting on BSVA for |
| --- | --- | --- |
| Broadcast and headers (ARC / Chaintracks) | live, mainnet and testnet | production API keys, if any |
| MessageBox: payments, requests | live | that the server pushes for `payment_requests` too (see Push) |
| Identity overlay (Mandala) | testnet live | mainnet overlay URL and identity key |
| Handles (`@name`) | development registry (`deggen.com`) | the production registry URL for `bitcoinsv.com` |
| Backup log (Sync) | live | nothing |
| Push | built; simulated in dev | Firebase registration files; server-side push for both boxes |
| Website links | built; off | the domain hosting two files; Apple team ID; Android signing fingerprints |
| Website sign-in (pairing) | live | nothing; the website runs its own relay |
| Feedback | built; notes wait on the phone | the feedback service (to build, below) |
| EAS project / store apps | the app builds locally | this app's own EAS project ID, App Store and Play listings |

## Broadcast and headers

- **Config:** `EXPO_PUBLIC_[TEST_|TERATEST_]ARC_URL`, `…ARC_API_KEY`, `…CHAINTRACKS_URL`, `…WOC_API_KEY`, `EXPO_PUBLIC_TEST_TAAL_API_KEY`.
- These are passed through `configureToolbox({ services })` in [`app/_layout.tsx`](../app/_layout.tsx).
- The keys are client keys inlined into the bundle, so don't treat them as server secrets.
- New wallets start on mainnet. The chain is a constant in the core (`DEFAULT_CHAIN`). `EXPO_PUBLIC_DEFAULT_CHAIN` in eas.json's production profile is not read by anything.

## MessageBox

- **Config:** `EXPO_PUBLIC_DEFAULT_MESSAGEBOX_URL`. The Mandala MessageBox settings override it per network.
- **Boxes:**
  - `payment_inbox`: incoming payments, BRC-29 via the core.
  - `payment_requests`: requests between wallets, as below.
- Only the wallet currently open on a phone checks its boxes. A request sent to a handle reaches that wallet once it's open on the receiving phone.

### Request messages (`payment_requests`)

Defined in [`src/requests/requests.ts`](../src/requests/requests.ts) (`RequestMessage`). Each message is a JSON body with these `type`s:

| `type` | Fields | Meaning |
| --- | --- | --- |
| `payment-request` | `id`, `units`, `asset?`, `note?`, `link`, `fromName?`, `createdAt` | "Please pay me." `link` is a pay link (below) that pays the sender exactly `units`. The receiver checks this before showing it. |
| `request-cancelled` | `id` | The sender withdrew it. |
| `request-declined` | `id` | The receiver turned it down. |
| `request-paid` | `id` | The receiver says they've paid. The sender's wallet shows it as claimed paid. |
| `pay-link` | `id`, `link`, `note?`, `fromName?` | A pay link sent to someone directly (no amount owed). |

Each update counts only from the side entitled to send it: a cancellation from the requester, a decline or a "paid" from the payer. The server does not need to understand any of this. It just stores and forwards.

### Pay links

These are BRC-125 `peerpay:` links, parsed in the core (`parsePeerPayURI.ts`). We add one extension, `note=`:

- single line;
- capped at 120 characters (`PEERPAY_NOTE_MAX`);
- other wallets can ignore it.

## Identity overlay (Mandala)

- **Config:** `EXPO_PUBLIC_[TEST_]MANDALA_OVERLAY_URL`, `…OVERLAY_IDENTITY_KEY`, `…MESSAGEBOX_URL`.
- Testnet points at `mandala-test-overlay.bsvblockchain.tech`. The mainnet values are empty until BSVA supplies them.

## Handles

- **Config:** `EXPO_PUBLIC_[TEST_]HANDLE_REGISTRY_DOMAIN` and `…_URL`.
- Development and preview builds use `deggen.com` on the MessageBox host.
- Production uses the domain `bitcoinsv.com`, but its URL is unset. Until it's set, Profile shows handles as not available.
- **To switch on:** set `EXPO_PUBLIC_HANDLE_REGISTRY_URL` (and the `TEST_` one) in eas.json's production profile.
- Bought handles, and moving or letting one go, are deferred: Settings → Handles says so.

## Backup log (Sync)

- **Config:** `EXPO_PUBLIC_BACKUP_URL`, currently `backup.bsvblockchain.tech`.
- This is the core's backup log. The app never marks a wallet as backed up on Sync's behalf.

## Push

What's built:

- **Registration.** The core's `PushAdapter` registers the phone's FCM token with MessageBox:
  - `registerDevice({ fcmToken, platform })` when push is turned on;
  - `/unregisterDevice` when it's turned off.
- **Handling.** Every push means "check the inbox now". Tapping a push opens Activity.
- **Payload.** The server should send `data` with:
  - `messageBox`: `payment_inbox` or `payment_requests`;
  - `recipient`;
  - `originator`;
  - `messageId`.
- **Routing.** This is in [`src/notify/pushRouting.ts`](../src/notify/pushRouting.ts):
  - a push for `payment_requests` also checks requests at once;
  - tapping it opens Activity on the Requested tab;
  - anything else opens Activity → All.

What BSVA supplies:

1. `GoogleService-Info.plist` and `google-services.json` for `com.bitcoinsv.wallet`, placed in `firebase/`. They are not committed; in CI they come from EAS file secrets. Without them the app builds and runs with push off.
2. MessageBox sending pushes for **both** `payment_inbox` and `payment_requests`, using the payload above.

Before Firebase is set up:

- Set `EXPO_PUBLIC_PUSH_SIMULATE=true` in a development build. Settings → Advanced → Push simulator then sends either kind of push, in the foreground or as a tap.
- Nothing is registered with the server in this mode.
- [`e2e/push-routing.yaml`](../e2e/push-routing.yaml) covers it.

## Website links

When the setting is on:

- `https://<domain>/pay/<identity key>?…` opens Send with that pay link;
- `https://<domain>/@name` opens Send with the handle filled in;
- Receive shares the website form of the link, which still works for anyone without the app.

The code is [`src/links/webLinks.ts`](../src/links/webLinks.ts) and [`app/+native-intent.ts`](../app/+native-intent.ts).

To switch on:

1. Fill in the placeholders in [`web/.well-known/`](../web/.well-known):
   - Apple team ID;
   - Android release and Play app-signing SHA-256 fingerprints.
2. Host both files on the domain, as described in [`web/README.md`](../web/README.md).
3. Set `EXPO_PUBLIC_LINK_DOMAIN` (e.g. `bitcoinsv.com`) and rebuild. [`app.config.js`](../app.config.js) then adds the iOS associated domains and the Android verified intent filters.

Leave it unset until the files are live. Otherwise Android shows the links as unverified, and iOS opens them in the browser.

## Website sign-in (pairing)

- The QR code is `bsv-wallet://pair?topic&backendIdentityKey&protocolID&origin&expiry&sig`. The core validates it and checks the signature before trusting anything in it.
- The wallet then asks the website for its relay at `GET <origin>/api/session/<topic>` over HTTPS, and connects to `<relay>/ws?topic=…&role=mobile`.
- Nothing is needed from BSVA. Each website that offers wallet sign-in runs this side itself.

## Feedback

"Enjoying Bitcoin SV Wallet?" asks at calm moments:

- after a payment, once 2 have gone out;
- on Home, once the app has been opened 5 times;
- at most every 30 days; 120 days after a rating, 60 after a note.

The rules are in [`src/feedback/rules.ts`](../src/feedback/rules.ts). "I love it" opens the store's own rating (below). "I don't like it", and Help → Send feedback, write a note to the team.

Notes are kept on the phone in an outbox ([`src/feedback/outbox.ts`](../src/feedback/outbox.ts)) and sent once `EXPO_PUBLIC_FEEDBACK_URL` is set: on the next note, or the next launch. A server error or no connection keeps them for next time; a 4xx drops that one.

The service to build is one endpoint:

```
POST <EXPO_PUBLIC_FEEDBACK_URL>/v1/feedback
Content-Type: application/json

{
  "id": "mfx3k2-8d0c1a2b",          // made on the phone: drop a repeat
  "createdAt": "2026-10-12T12:00:00.000Z",
  "topic": "Speed",                 // or null: Payments, Speed, Design, Something's missing, Other
  "message": "…",                   // may be empty when a topic was picked; up to 2000 characters
  "source": "prompt",               // "prompt" (the Enjoying? card) or "help"
  "app": { "version": "1.0.0", "build": "12", "platform": "ios", "os": "26.5" },
  "locale": "en-GB"
}
```

- Answer `2xx` once it's stored.
- There's no sign-in and nothing that identifies the person or their wallet, so it needs its own abuse protection (rate limits, size limits).
- There's no reply channel: the prototype's Help & support conversations are Later.

## Builds and stores

- `BITCOINSV_EAS_PROJECT_ID` is this app's own EAS project. It isn't set until BSVA creates the project.
- The App Store and Play listings, and the `production` profile's remote credentials, come with it.
- Vault is on in development and preview builds only, never in production (`EXPO_PUBLIC_VAULT_ENABLED`).
- Ratings use the store's own sheet (StoreKit on iOS, Play In-App Review on Android), with the store page as a fallback ([`src/feedback/review.ts`](../src/feedback/review.ts)). Neither works before the app is listed. Once it is, set `EXPO_PUBLIC_APP_STORE_ID` and `EXPO_PUBLIC_PLAY_STORE_LISTED=true`. Until then "I love it" says ratings come later; development builds show iOS's test sheet.
- Google Play's In-App Review policy doesn't allow asking how someone feels before (or while) showing the rating. So on Android there's no "Enjoying Bitcoin SV Wallet?": the rating sheet comes on its own at the same moments, the tour video's prompt reads "Rate Bitcoin SV Wallet", and notes to the team come from Help → Send feedback. iOS keeps the question. Both are set by `REVIEW_FUNNEL` in [`src/feedback/config.ts`](../src/feedback/config.ts).
