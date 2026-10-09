# Now-mode native app: designer and implementation handover

Date: 9 October 2026. Status: agreed boundaries and implementation brief; demo inventory pending.

## Outcome and baseline

Build the designer's functioning React/Next.js demo experience as a **new React Native/Expo application in this repository**, alongside the existing BSV Browser app. The first delivery covers **only the demo's Now mode**. Later mode is deferred. Obtain the actual Now screens and journeys before defining the feature list: neither all demo source files nor this repository's existing features establish that scope. A Now/Later selector in a prototype does not authorize a production mode switch.

Application repository: `/Users/personal/git/bsv-wallet`. Source baseline inspected for this handover: `e85bf7d39be2e4a755689f040174cd2528efa284`, branch `master`, clean working tree before this document. The document workspace at `/Users/personal/Documents/ChatGPT/bsv-wallet` is not the application repository. This handover changes documentation only; it does not implement a second app or certify a release.

The demo source, URL, screenshots and exact feature inventory have not been supplied. App name, identifiers and release ownership are TBD. These inputs remain outstanding, but do not prevent recording the agreed architecture and acceptance criteria now.

## Architecture and compatibility contract

Use one authoritative shared wallet implementation, rooted in `packages/expo-wallet-toolbox` and its existing wallet dependencies and patches. Both app shells consume that implementation. Do not copy wallet services into the new app, create a second derivation/recovery/transaction engine, or maintain a competing core fork. Shared core fixes must apply to both apps when each is rebuilt and released; separately installed binaries do not update merely because source changed. The apps may expose different features.

Add a separate shell, entry point and build target with its own Expo/native configuration. Select its final directory during implementation after checking Metro, routing, dependency resolution and native build requirements; this document does not prescribe a speculative monorepo migration. Preserve the existing shell and its current design, navigation, shared UI defaults, and BSV Browser appearance and behavior. New components, app-local themes, or explicit opt-in shared variants may implement the demo's visual language. Existing consumers must retain their defaults. Avoid global restyling of the shared theme or browser.

**Installed apps must have completely isolated storage.** They must share no database, secure storage, credentials, caches, persisted settings or other persisted state. Reuse code, not storage instances. Each installation independently preserves the existing schema, formats, encoding, encryption, database contracts and storage behavior. Do not add schema changes or change serialization to distinguish the apps. Use distinct OS application identities and private containers, with no shared app groups, keychain access groups, file providers, credential stores or cross-app persisted-state bridge. Audit the secure-store service/access-group configuration rather than assuming a different bundle ID proves isolation. No cross-app migration, import, transfer or automatic restoration of the other app's state is authorized by this work. Existing backup/recovery operations remain subject to their current contracts; an inter-app transfer journey would require a separate decision.

The new app needs independent bundle/application IDs, Expo project/update identity, release channels, deep-link schemes and universal/app-link routing, signing and platform service configuration as applicable. Values are TBD. Preserve existing identities. A link, update or notification intended for one installation must not be delivered to the other. Shared dependency or native-module changes must continue to build the existing app/browser.

## Source map for implementation agents

Paths below are relative to the repository root and describe existing code to inspect, not a complete API specification. Read actual exports, callers and tests at the implementation baseline before choosing integration points.

| Concern                         | Existing entry points                                                                                                                                                                                                                                                   | Required use                                                                                                                                                                           |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing host and configuration | `app/_layout.tsx`, `index.js`, `eas.json`, `metro.config.js`; `packages/expo-wallet-toolbox/core/toolboxConfig.ts`                                                                                                                                                      | Follow provider/configuration contracts in a separate host. The existing host configures the toolbox before wallet construction; public environment configuration belongs in the host. |
| Wallet lifecycle and scoping    | `packages/expo-wallet-toolbox/core/context/WalletContext.tsx`, `core/context/buildGeneration.ts`, `core/walletDbRegistry.ts`, `core/profiles/profileStore.ts`                                                                                                           | Reuse lifecycle and wallet/network/profile ownership checks; retain stale-result protection.                                                                                           |
| Identity and recovery           | `packages/expo-wallet-toolbox/core/mnemonicWallet.ts`, `core/recovery/`, `ui/backupShares.ts`, `ui/printRecoveryShares.ts`                                                                                                                                              | Reuse entropy, derivation, share generation, reconstruction and recovery operations.                                                                                                   |
| Persistence and secrets         | `packages/expo-wallet-toolbox/core/storage/StorageExpoSQLite.ts`, `core/storage/schema/createTables.ts`, `core/context/LocalStorageProvider.tsx`, `core/services/secrets/`, `core/backup/`                                                                              | Preserve contracts in each app's private storage. Inspect code alongside the storage README, which includes forward-looking notes.                                                     |
| External authority and consent  | `packages/expo-wallet-toolbox/core/context/WalletConnectionContext.tsx`, `core/services/externalOrigin.ts`, `core/services/connectionAuthority.ts`, `core/services/signingPermissionPolicy.ts`, `core/hooks/usePermissionQueue.ts`; `ui/index.ts` exports permission UI | Preserve authenticated origins, permission scope and consent; do not make the new UI a privileged bypass.                                                                              |
| Vault                           | `packages/expo-wallet-toolbox/core/services/vault/`, especially `transfers.ts`, `guard.ts`, `r1comb.ts`, `metaAuthority.ts`, `VaultKeyService.ts`, `ceremonyHost.ts`, `chainRecovery.ts`; `core/context/VaultContext.tsx`                                               | Use current shared operations and guards, including hardware/session and recovery boundaries.                                                                                          |
| Held/offline work               | `packages/expo-wallet-toolbox/core/offline/`, `core/monitor/`, `core/localpay/`                                                                                                                                                                                         | Inspect the actual operation chosen by each Now journey; retain reservations, pending-state and reconciliation semantics.                                                              |
| Presentation                    | `packages/expo-wallet-toolbox/ui/`, `core/theme/`; existing routes under `app/`                                                                                                                                                                                         | Reuse appropriate interfaces without changing existing default styling or behavior.                                                                                                    |
| Native and vendor integration   | `packages/react-native-yubikey/`, `packages/react-native-secp-native/`, `packages/react-native-engine-native/`, `packages/react-native-localpay-transport/`, `patches/@bsv+wallet-toolbox-mobile+2.14.3.patch`, `patches/@bsv+sdk+2.8.11.patch`                         | Keep native linking and patched dependency behavior consistent across consumers.                                                                                                       |

In the table, `core/` and `ui/` continuations in a row refer to `packages/expo-wallet-toolbox/`.

## Protect behavior, including UI sequencing

A visual redesign may change layout, typography, colors, icons, motion and navigation, adapting the demo to native accessibility and platform conventions. It must preserve these wallet invariants:

- Entropy and private-key generation/derivation, parameters and resulting identity.
- Backup share generation, thresholds, encoding, encryption, validation, reconstruction and recovery semantics.
- Vault lock/unlock scripts, salt derivation, authenticated metadata, hardware authorization and key lifecycle.
- Permission scope, authenticated origins, meaningful consent and restrictions on external callers.
- Transaction construction and fees; binding between the approved intent, signed bytes and released/broadcast action; held actions, reservations and crash reconciliation.
- Wallet/profile/network isolation, rejection of stale asynchronous results and existing production/feature gates.

Unchanged core files alone do not prove these properties. A UI that submits before consent, retries a possibly broadcast action, mislabels a pending payment as final, hides a denied state, changes wallet while a prompt is open, or skips hardware authorization can violate the same contract. Route transitions and unmounts must not accidentally authorize, release reservations or discard unresolved actions.

Design and implement denied, canceled, loading, offline, error, pending, recovery and hardware-interruption states for every applicable journey. Define what back, dismissal, backgrounding, process death and retry do at each consequential step. Never invent success or restore certainty from animation timing. Keep mnemonics, shares, private keys, PINs and other secrets out of logs, analytics, notifications, navigation URLs and unintended screenshots/clipboard persistence; preserve existing secret-handling policy.

The shared library is **open to compatible additions**. An unsupported Now feature may require a new shared capability while keeping old interfaces, defaults, persistence and security behavior. It may be exposed only in the new app; no matching second UI is required. A conflict with protected invariants or schema requires a separate scope decision, not an unreviewed workaround or a fork.

## Designer delivery and feature mapping

Supply the demo source/revision or accessible URL plus a reviewed **Now-only** inventory. For each journey include screen states, entry/exit routes, interactions, intended data, validation/copy, accessibility requirements and a visible distinction between real behavior and mocks. Identify deferred Later journeys explicitly, including shared-looking screens whose actions belong to Later.

Designer and agents should complete this matrix before implementing the remaining scope:

| Now journey/screen and demo evidence | Data and existing wallet operation                           | Mapping category                                                                                                                   | Native/server/hardware dependencies                | Consent, failure and interruption states                                                     | Verification evidence                                   |
| ------------------------------------ | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| TBD after demo delivery              | Actual exported operation and callers, or missing capability | Existing operation with new presentation / compatible shared extension / protected invariant or schema conflict requiring decision | Platform modules, assets, API and secret ownership | Loading, denied, canceled, offline, error, pending, recovery and interruptions as applicable | Relevant regression, iOS/Android flow and design checks |

Do not populate this with guessed balances, payments or Vault features merely because the existing app supports them. Record mock balances, instant transaction assumptions and recovery promises from the demo; replace them with states justified by actual wallet/network/hardware behavior and current release gates.

## Native porting checklist

- Replace DOM, CSS, browser-only widgets and web animations with React Native equivalents. Selectively reuse assets, tokens and compatible React logic after checking licensing, accessibility and performance.
- Next.js server components, server functions/actions and routes do not automatically become on-device logic. Identify required services and deployment ownership. Server secrets remain server-side; public Expo configuration cannot hold them.
- Design native back/gestures, modal dismissal and deep links, including wallet-scoped prompts and interrupted flows. Handle backgrounding, process termination, network loss and hardware removal without weakening authority or transaction binding.
- Verify safe areas, keyboard avoidance, font scaling, screen readers, focus order, touch targets and reduced-motion behavior on both platforms.
- Measure real-device lists/history and animation responsiveness with realistic data volumes. Do not truncate authoritative history scans to make the UI feel faster.
- Establish native-module, secure-storage and hardware support early. Use development builds when needed; do not assume Expo Go covers custom native dependencies or hardware ceremonies.
- Keep dependencies, configuration and release/update identities separate where required while preserving builds and behavior of the existing app/browser.

## Delivery sequence and acceptance

1. Obtain and approve the Now inventory and complete the operation/dependency matrix. Resolve protected conflicts separately; keep Later deferred.
2. Establish the new shell/build target, private storage and independent identities. Demonstrate side-by-side installation with the existing app before integrating broad scope.
3. Implement one representative **real** Now journey selected from the inventory, through the authoritative shared wallet. Exercise success, consent denial/cancel, failure and interruption on iOS and Android. Use it to validate architecture, native modules and visual translation.
4. Implement the remaining approved Now journeys using the same boundaries. Add compatible core capabilities only where the matrix justifies them.
5. Run relevant existing core regressions and both applications' builds, then record platform/device evidence and unresolved limitations for release review.

Acceptance requires the approved Now screens and journeys, truthful states and copy, retained permission/security/recovery behavior, independent installed state, preserved formats/schema/contracts, and retained gates. Demonstrate isolation using different wallets/settings in side-by-side installs, app-scoped reset/logout and secure-storage access checks; prove that one app cannot read or mutate the other's persisted state. Compare the existing app/browser against the baseline visually and behaviorally, including shared component defaults. Verify deep links and updates target only the intended app.

Choose regression suites according to touched shared operations: existing `packages/expo-wallet-toolbox/__tests__/backup/`, `__tests__/vault/`, `__tests__/profiles/scopedState.test.ts`, `__tests__/walletDbRegistry.test.ts` and relevant permission, recovery, storage and transaction tests are starting points. Add meaningful coverage for new capabilities and cross-consumer default compatibility. Record exact commands, revisions, results, devices and build profiles; do not claim passes from historical documents. Both build targets must resolve the authoritative shared library and required vendor patches. Security and physical hardware claims require their own evidence.

## Historical evidence and current limits

The external document `/Users/personal/Documents/ChatGPT/bsv-wallet/R1C-VAULT-SECURITY-REVIEW.md` is dated **11 September 2026** and reviewed `fe03adfaa7cb35a6f7c8205349fdf64068cbb760`. It reported exact-lock clean-device recovery and durable backup-receipt gaps, missing physical-hardware and target-node/miner-policy evidence, and associated release gates. Its test counts and verdict apply to that historical review, not this baseline.

Current source has moved on: `core/services/vault/chainRecovery.ts` describes v7 on-chain marker/encrypted-descriptor discovery and confirmed-deposit recovery, with pending-confirmation handling. Its presence does not establish complete recovery, physical hardware or node-policy validation. Do not revert to historical v6 assumptions or declare those old gaps resolved without inspecting current implementation and evidence. `core/toolboxConfig.ts` still exposes the default-false `vaultEnabled` release gate, configured by the host. Preserve applicable gates and verify the chosen build profile; a demo is not authority to enable Vault or any other gated capability.

Validation of this handover consists of repository/baseline inspection, source-path checks and documentation diff review. No application tests, builds, physical hardware tests, network-policy tests or security certification were performed for this documentation-only change.

## Outstanding inputs

Demo access and pinned revision; approved Now inventory and deferred Later list; visual assets/tokens and motion/accessibility expectations; new app name and Expo/native/release/deep-link identities; backend dependencies and service ownership; supported devices/hardware and release evidence. Assign these during kickoff. They are explicit implementation inputs, not grounds to postpone this handover document.
