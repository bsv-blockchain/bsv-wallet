# BSV Point of Sale — first technical version

A separate Expo app for merchant administrators and cashiers. Customers continue to use Bitcoin SV Wallet's Scan & pay screen. Merchant setup is not added to the consumer wallet.

## Run the app

From the repository root, install the existing locked dependencies with `npm ci`, then:

```sh
cd apps/pos
npm run ios
# or npm run android
```

Native development builds are required: nearby radio transport, native crypto and SQLite do not run in Expo Go. The app uses its own bundle identifier, Android package and URL scheme, so its keys and storage are isolated from the consumer wallet. It reuses the wallet toolbox providers, recovery primitives, QR scanner and encrypted nearby transports.

The checkout amount is entered as **whole satoshis** in this technical version. A local-currency quote service, EPOS order handoff, refunds, and store/till management are subsequent work. Do not use a local-currency total as a satoshi amount.

## Primary server: Go Wallet Toolbox

The server implementation lives in Go Wallet Toolbox under `pkg/pos`, with a runnable gateway at `cmd/pos`. It uses a merchant signing wallet connected to the existing authenticated cloud storage adapter. The storage server alone does not have the merchant's key derivation capability.

Configure the Go gateway using its `pkg/pos/README.md`. Deploy one process behind HTTPS with a persistent state file. Merchant credentials belong in a deployment secret store. Cashiers never receive the merchant key or storage credentials.

The TypeScript code under `service/` is a protocol/reference implementation, with the same signed RPC and receipt model. To run it for development, export `POS_WALLET_MODULE` pointing at a CommonJS adapter that exports `createMerchantWallet()` returning `{ wallet, chainTracker, chain }`, plus `POS_PUBLIC_URL` and `POS_MERCHANT_NAME`. Run `npm run service`. It requires the root TypeScript development dependency. Use the Go gateway as the primary deployment target.

## Setup and payment flow

1. Merchant administrator imports the identity registered with the merchant gateway, chooses the matching network, and connects the preconfigured prototype service at `https://merchant-pos-us-1.bsvblockchain.tech`. No URL entry is required. This administrator identity is privileged; only the merchant uses it.
2. The merchant creates a signed enrollment QR, valid for ten minutes.
3. A cashier creates or imports their own wallet, selects the matching network, scans the enrollment code and requests approval. The merchant checks the name and identity and approves that cashier. Enrollment can be resumed after app restart.
4. The cashier enters an amount. The online service checks cashier access and signs an invoice containing the exact merchant destination, amount-bearing nearby session, cashier, network and expiry.
5. The customer scans the signed request. The consumer wallet verifies the merchant signature locally, displays the merchant and derives the BRC-29 output directly for that merchant. No customer internet connection is required. Older wallet builds do not recognize these signed POS codes; update the consumer app with this change.
6. The cashier receives the encrypted payment through the existing AWDL/Nearby/BLE radios or scans the customer’s encrypted animated QR fallback. Radio encryption uses the paired session key; the receiving identity for BRC-29 is the merchant.
7. The cashier persists the exact received payment before forwarding it. The service validates authorization and invoice binding, persists the same bytes, validates the exact output destination and amount, and internalizes into the merchant wallet with BEEF/SPV validation.
8. A signed receipt is issued only when the merchant wallet accepted the transaction and its action status is `unproven` or `completed`, rather than `sending` or failed. This is acceptance under the wallet's broadcast policy, not a promise of mined finality. Only a matching signed receipt produces **Paid**.

## Interrupted confirmation

Service failure or timeout leaves the sale awaiting confirmation. Retry the same saved transaction against the same invoice; never ask the customer to pay again. Service receipts are idempotent and a different transaction cannot reuse a submitted invoice. The cashier's pending payment survives app restart. The existing customer nearby flow retains its uncertain-delivery protections and QR fallback.

A radio acknowledgment is sent only after merchant confirmation. If the radio connection times out before confirmation, the cashier can still resolve the saved sale, but that does not guarantee that an offline customer's original connection receives the eventual receipt. A dedicated receipt QR/reconnection flow is future work. QR fallback retains the existing customer's manual handoff confirmation semantics; the cashier's Paid state remains gated by the merchant receipt.

The service must be available to create or confirm sales. There is no offline merchant acceptance or cashier derivation of merchant payment keys. Revocation blocks new cashier requests, including receipt retries; the merchant can inspect outstanding sales in its dashboard.

## Validation

- POS protocol and settlement tests cover signed requests, expiry, tampering, approval, revocation, invoice binding and uncertain-response retries.
- Existing nearby session, receiver and uncertain-send regression tests are included in the selected verification run.
- Go tests cover the same service boundaries, persistent restart recovery, simultaneous delivery, exact destination/amount and the broadcast-status gate.
- A TypeScript-generated fixture is verified by Go; deterministic signature bytes match in both implementations.
- Expo iOS bundle export and TypeScript checks verify the app source. Physical-device pairing with a deployed merchant gateway remains necessary before a merchant pilot.

See [EPOS integration roadmap](docs/epos-roadmap.md) for the US-first, EU-second small-business strategy and platform research.

## TestFlight

The iOS app is registered as **BSV Merchant**, bundle ID `org.bsvblockchain.merchant`, under BSV Association. Its EAS project is `@bsvb/bsv-merchant`. The production profile in this app's `eas.json` targets the dedicated merchant App Store Connect record and increments iOS build numbers remotely.

```sh
cd apps/pos
EXPO_NO_CAPABILITY_SYNC=1 eas build --platform ios --profile production --auto-submit
```

The capability-sync environment flag preserves the registered Apple capabilities while avoiding the capability-update error observed with the installed EAS CLI. Signing uses the existing BSV Association distribution certificate and a merchant-specific App Store provisioning profile. TestFlight uploads do not submit an App Store release for review.

Select testnet using the setup screen’s network selector for initial enrollment and payment tests. The shared wallet currently defaults to mainnet; the build-profile environment variable does not override that shared default. A deployed merchant gateway is still required for end-to-end payment acceptance.

The merchant app excludes the optional YubiKey module from native autolinking because vault functionality is disabled. Nearby transport and native crypto remain linked. Its app icon reuses the existing opaque wallet icon for this first test build.

## Counter and merchant views

The counter uses a large satoshi keypad with No tip, 10%, 20%, and custom whole-satoshi tips. Percentage tips round to the nearest satoshi; the grand total is guarded against integer overflow. The charge action stays visible below the scrollable checkout. Cashiers confirm the tip with the customer before requesting payment. Tips go to the merchant wallet with the sale; staff distribution is not automated.

The merchant overview shows accepted sales, recorded tips, average sale and totals per cashier identity. Sales support status and cashier filters, invoice/transaction search, and receipt details. Pending, expired and unpaid invoices do not count as revenue. All totals use verified signed invoices and matching merchant receipts.

The new tip breakdown requires the matching Go service image. Older invoices without a breakdown still display correctly; a gateway that drops the requested tip metadata cannot create a tipped sale in the new app. The default service URL is a prototype convenience, not a replacement for merchant identity and network checks.

Design references were inspected in Chrome at Scrip’s counter, sales detail and merchant/team views. Stablecoin, card, cash, treasury and tax tooling are not included. No source or sample sales data from Scrip is used in the app.
