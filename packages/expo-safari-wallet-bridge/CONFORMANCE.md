# BRC-185 profile and recorded deviations

Spec sections 6.8 (a to f) and 12. "Pinned by" names the jest file under `__tests__/ext/` unless
stated. Anything marked E2E was driven on the iPhone 18 Pro Simulator (evidence in
`docs/superpowers/evidence/ios-kit/`).

## Where BRC-185 is open, this transport chooses (spec 6.8)

|     | Choice                                                                                                                                                                                                                                                                  | Pinned by                                                  |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| a   | `connect` on the window handle takes no challenge, so the transport returns no connect proof and never uses `signConnect`. Identity is proven by `describe` (continuity key signature over the descriptor preimage) under the same origin and context before `connect`. | `describeConnect.test.ts` (preimages against P1's vectors) |
| b   | Endpoint record `{ id: 'window', type: 'window', address: 'safari-extension' }`; the address is an opaque adapter-local handle (transport ids start with `safari`).                                                                                                     | `describeConnect.test.ts`, `wire.test.ts`                  |
| c   | The page-world `WalletInterface` is a proxy over an internal `MessagePort` carrying the section 4.3 envelopes (`brc185:invoke`, `result`, `error`, `closed`).                                                                                                           | `wire.test.ts`, `chain.ts`                                 |
| d   | A connection-layer failure rejects with the `ConnectionError` (`domain: 'brc185'`) unchanged; a wallet error rejects with `{ code, message, data }` unchanged.                                                                                                          | `wire.test.ts`, `provider.test.ts`                         |
| e   | Routing fields must match the bound epoch; unknown methods, mismatched fields and an invoke before `connect` are `PROTOCOL_ERROR` / `not-sent` before staging.                                                                                                          | `wire.test.ts`, `background.test.ts`                       |
| f   | `disconnect(epoch)` closes the page's own binding and is not echoed as `brc185:closed`; its pending calls reject `DISCONNECTED` / `unknown`.                                                                                                                            | `wire.test.ts`, `reconcile.test.ts`                        |

Also pinned: events and once-per-`requestId` announcements with no unsolicited announce (`wire.test.ts`),
origin attestation from `sender` only, casing and opaque origins (`attest.test.ts`), the frame rule
(`describeConnect.test.ts`), in-flight caps 4 / 16 / 5 MiB (`limits.test.ts`), the `world: MAIN` and
script-tag injection builds (`bundle.test.ts`).

## Deviations and limits (spec 12) and where they are exercised

1. Identity key answered locally only for connected sites: `localAnswers.test.ts` (each condition
   independently). E2E item 5: `getPublicKey` for a connected site answered with no app wake.
2. Pending records expire after 15 minutes (`CONNECTION_CLOSED` / `not-sent`): `pickup.test.ts`,
   Swift `SweepTests`, `ContractTests`.
3. Results live 15 minutes: Swift `SweepTests`, `pickup.test.ts`.
4. Stale mirror (`isAuthenticated: true` can outlive the app process): `localAnswers.test.ts`.
5. One connection sheet per transport at a time (`RESOURCE_LIMIT` for a second site's connect): toolbox
   merged-sheet tests; E2E item 6 shows the related 30 s backoff after "Don't connect".
6. Cross-site linkability of the continuity key per context: documented, no test.
7. No Browser connections screen yet: nothing to test.
8. Payload limits: spike S2 (Simulator found none up to 5 MiB; the device gate stays), chunking in
   `stage.test.ts`.
9. Cancel on Safari's prompt is invisible: `handoff.test.ts` (a later call re-triggers); E2E item 10 not run.
10. Private Browsing only if the user enables the extension there; separate key context:
    `describeConnect.test.ts`; device gate.
11. Safari profiles are not distinguished: documented.
12. Connect alone never opens the app: E2E item 1 (describe and connect with the app not opened).
13. Connect is refused for a mirror written while building: `reconcile.test.ts`, `describeConnect.test.ts`.

## Findings from the Simulator run

- The first `describe` after the extension background idles can miss the controller's 1000 ms
  deadline (cold appex 1.7 to 1.95 s, spike S2); it then reads as a rejected announcement
  (`describe deadline`) and the next attempt, warm, succeeds. A controller that retries once, or
  announces and describes in the same turn the user wakes Safari, hides this.
- Safari's per-site grant ("Allow for One Day" or "Always Allow") is what lets the extension reach
  the appex. While the menu showed "Permission Required" the demo's `describe` timed out every time
  (rejected announcement, `describe deadline`) and the appex was never launched. The grant was lost
  after the Simulator's Safari was terminated and relaunched, so a tester sees this as an intermittent
  failure. The setup guide's step 2 is the user-facing cure.
