# BRC-185 profile and recorded deviations

Spec sections 6.6, 7.5, 7.6 and 12. **No conformance claim is made.** BRC-185 asks for interoperating implementations, a
published report and an independent security review; none exists. This file states what the transport chooses where the
BRC is open, what it adds, and where it differs. Pinned-by names are jest files under `packages/expo-wallet-toolbox/__tests__/bridge/loopback/`
or `packages/expo-android-wallet-bridge/__tests__/` unless stated. E2E rows were driven on the Pixel_9 AVD (Chrome 155);
evidence in `docs/superpowers/evidence/android-kit/`.

## Profile choices

- Transport id `android-loopback`; `attestation: 'unattested'` (every site is Unverified, stricter policy), `bindingMode: 'explicit'`.
- Endpoints: the JSON HTTP profile only (`http-json`; endpoint ids `json-ipv4`, `json-ipv6`, `json-localhost`). No binary
  profile, no HTTPS profile, no legacy routes, no 3301, no 2121. Ports 3321 up to 3384; both loopback families bound or the
  wallet moves up; `localhost` advertised only when both are ours.
- Paths: `GET /.well-known/brc-wallet`, `POST /.well-known/brc-wallet/connect`, `DELETE /.well-known/brc-wallet/connect/<epoch>`,
  `POST /brc185/v1/rpc/<method>`, `OPTIONS` on each.
- One request per connection, `Connection: close`. The server speaks only what the pure router returns; Kotlin is a pipe.
- CORS: the exact request origin, never `*` or `null`, never `Access-Control-Allow-Credentials`, no `Access-Control-Max-Age`;
  `Vary: Origin`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, no `Server` or `Date` on every response.
- Status table (spec 6.6.2): success 200, wallet error 400, protocol error 400, `PROVIDER_CHANGED` 412, `CONNECTION_CLOSED` 410,
  `USER_CANCELLED` and launch-proof refusal 403, limits 429, wallet not built 503, oversize request 413, oversize response 502.
  Pages discriminate by body (`isError` is a wallet answer, `domain: "brc185"` a connection error).
- Continuity key: HKDF-SHA256 from a SecureStore seed, one identity per `android:<origin>` context; `sign` accepts only the two
  core preimage prefixes.

## Extensions (spec 12, verbatim)

- **BRC-185 extensions:** the optional `hello` query parameter on describe, the connect body's `android` member, the
  `BRC-185-Android-Ack` response header (on describe and on connect), the `BRC-185-Android-Binding` request header, the
  `BRC-185-Reconnect-Token` response header, the launch `intent:` link, and the wallet-error `400`. A third-party page that
  implements only BRC-185 text cannot connect to this wallet. No conformance claim is made.

## Deviations from BRC-185 / BRC-219 text

1. **Wallet error is HTTP 400 (and `PROVIDER_CHANGED` is 412).** BRC-185 4.1 says success and error use HTTP 200 with the
   original representation. The core decision (P1 6.11) stands; a page must read non-2xx bodies. Pinned by `router` and
   `status` tests; E2E case 3 and 4 observe the codes.
2. **A launch on every connect**, and the connect must carry a proof of the launch secret (`BRC-185-Android-Ack`, MAC under `k`).
   The proof design is this transport's, not the BRC's.
3. **Origin is unattested** (cannot be proven on Android loopback; the browser's `Origin` header is the only signal).
4. **No deadline on an admitted request** (BRC-219): a held request survives backgrounding, Doze and a locked screen
   (S5, 30 minutes). A request parked behind the unlocked wallet waits at most 10 minutes (the connect, not an RPC).
5. **Describe timing.** A cold wallet answers describe in about 3.6 to 4.7 s after the click on the Pixel_9; the page's
   per-attempt timeout after a launch click is 3 s, not the BRC default 1 s (S7).
6. **Idle reaper:** bindings idle 30 minutes with nothing parked or in flight are closed.
7. **No failure throttle, no describe rate limit** (they would hand any local app a lock-out switch; guessing a 256-bit MAC is
   worthless). Bounded by structure instead (spec 12).
8. **Response over 5 MiB** is `502` `unknown`; request over 5 MiB is `413`.

## Findings that are the wallet's or the harness's, not the transport's (E2E case 6)

The fast.brc.dev set ran to completion (41 cards: 20 pass, 10 fail, 11 not in Run all). Failures are the wallet's own
answers forwarded intact: `getVersion` answers `bsv-wallet-bridge-1` (P1's static base) which the card rejects; privileged
branches (code 6); insufficient funds on an unfunded test wallet; one `discoverByAttributes` timeout. Details in `SPIKES.md`.

## What is NOT claimed

- BRC-185 conformance, interoperability with any other page client than the stand-in client in this repo, or a security
  review (independent review is a release gate).
- Behaviour on a real phone, any OEM, Android 17 work profile / private space (S8 not run), Incognito on a device, or the
  https path in a release build with R8 (device gates).
- The legacy binary profile, encrypted association (spec 8.4: decision no for v1), iframe origin attestation (8.5).
- Protection against a second wallet implementing this kit: two apps allocate different ports and the page sees two
  wallets; only the launched package acknowledges.

## Overlay (milestone 2)

Nothing claimed above changes. The overlay sheet is a presentation surface of this wallet, not a BRC-185 surface: BRC-185 says
nothing about how a wallet asks its user, and the overlay adds no endpoint, header or deviation. It is experimental until the owner
device gates pass (`SPIKES.md`).
