/**
 * The generated conformance report (spec 8, 9): what the bridge core carries, what it refuses and
 * where it knowingly differs from BRC-185 / BRC-219. Pure data built from the same tables the
 * dispatcher uses, so the list of methods and the limits cannot drift from the code. The wording of
 * refusals and deviations is spec 6.11 and 9; the snapshot test makes any change to it deliberate.
 */
import { BRIDGE_METHODS, type WalletMethodName } from './protocol/methods'
import {
  DECLINE_BACKOFF_MS,
  INBOX_MAX_VALIDITY_MS,
  MAX_BINDINGS_PER_ORIGIN,
  MAX_BINDINGS_TOTAL,
  MAX_BRIDGE_REQUEST_BYTES,
  MAX_IN_FLIGHT_BYTES,
  MAX_IN_FLIGHT_PER_BINDING,
  MAX_IN_FLIGHT_TOTAL
} from './protocol/limits'

/** Bumped when the report's shape changes. */
export const CONFORMANCE_REPORT_VERSION = 1

export interface MethodConformance {
  name: WalletMethodName
  /** `probe`: answered by the bridge with no consent, wallet call or wait. `wallet`: forwarded to the permissions manager. */
  handling: 'probe' | 'wallet'
  mutating: boolean
  /** Ids from `deviations` that touch this method. */
  deviations: string[]
}

export interface Refusal {
  id: string
  when: string
  outcome: string
  delivery: 'not-sent' | 'unknown'
}

export interface Deviation {
  id: string
  summary: string
}

export interface ConformanceReport {
  reportVersion: number
  protocol: 'BRC-185'
  spec: { document: string; revision: number }
  methods: MethodConformance[]
  limits: Record<string, number>
  refusals: Refusal[]
  deviations: Deviation[]
}

export const BRIDGE_REFUSALS: readonly Refusal[] = [
  {
    id: 'no-provider-or-wallet',
    when: 'No provider mounted; no wallet exists; unattested connect without launch proof',
    outcome: 'ConnectionError CONFIGURATION_ERROR',
    delivery: 'not-sent'
  },
  {
    id: 'protocol-violation',
    when: 'Origin refused; attestation mismatch; originator frame mismatch; unknown method on an epoch transport; asserted (non-web) context',
    outcome: 'ConnectionError PROTOCOL_ERROR',
    delivery: 'not-sent'
  },
  {
    id: 'provider-changed',
    when: 'Unknown, retired or mismatched binding; account or wallet changed before the call',
    outcome: 'ConnectionError PROVIDER_CHANGED (cause account-changed when known)',
    delivery: 'not-sent'
  },
  {
    id: 'user-declined',
    when: 'User declined site consent',
    outcome: 'ConnectionError USER_CANCELLED',
    delivery: 'not-sent'
  },
  {
    id: 'resource-limit',
    when: 'Request over size or concurrency; the transport sheet slot is held; inside the decline backoff',
    outcome: 'ConnectionError RESOURCE_LIMIT',
    delivery: 'not-sent'
  },
  {
    id: 'response-too-large',
    when: 'Response over the limit',
    outcome: 'ConnectionError RESOURCE_LIMIT',
    delivery: 'unknown'
  },
  {
    id: 'inbox-expired',
    when: 'Inbox record expired before acceptance; implicit epoch outside the admission horizon',
    outcome: 'ConnectionError CONNECTION_CLOSED',
    delivery: 'not-sent'
  },
  {
    id: 'not-connected-no-seek',
    when: 'seekPermission false from a site that is not connected',
    outcome: 'Wallet error 1, permission denied',
    delivery: 'not-sent'
  },
  {
    id: 'unverified-token-module',
    when: 'A token-module name (any case variant) from an unverified origin',
    outcome: 'Wallet error 1, permission denied',
    delivery: 'not-sent'
  },
  {
    id: 'typed-arrays',
    when: 'Typed arrays or ArrayBuffers in arguments; byte fields must be number arrays',
    outcome: 'ConnectionError RESOURCE_LIMIT',
    delivery: 'not-sent'
  },
  {
    id: 'invalid-arguments',
    when: 'Arguments fail BRC-100 validation or the wallet argument caps',
    outcome: 'Wallet error 6',
    delivery: 'not-sent'
  },
  {
    id: 'closed-in-flight',
    when: 'Claimed, then crash; in flight, then binding closed or teardown',
    outcome: 'ConnectionError CONNECTION_CLOSED',
    delivery: 'unknown'
  },
  {
    id: 'invalid-result',
    when: 'Mutating call whose result failed validation',
    outcome: 'ConnectionError PROTOCOL_ERROR (cause invalid-result)',
    delivery: 'unknown'
  }
]

export const BRIDGE_DEVIATIONS: readonly Deviation[] = [
  {
    id: 'wait-for-authentication-sheet',
    summary:
      'waitForAuthentication can raise the grouped-permission sheet for a connected origin, which conflicts with BRC-219 "probes must not prompt"; only after the user has connected the site.'
  },
  {
    id: 'list-actions-deadline',
    summary:
      'External listActions is subject to the vault guard\'s 30 s deadline and shared 16-slot queue (pre-existing); conflicts with BRC-219 "no deadline" for that method only.'
  },
  {
    id: 'sdk-http-json-clients',
    summary: 'SDK 2.8 HTTP JSON clients keep the message only for codes 5, 6 and 7 and reject isAuthenticated false.'
  },
  {
    id: 'unverified-namespace',
    summary:
      'Unattested originators are rewritten into the .<grantTag>.unverified.invalid namespace: wallet-side BRC-116 policy, loopback only, never a future BRC-185 section 8 mobile profile.'
  },
  { id: 'request-cap', summary: 'Request and response caps are 5 MiB, not 64 MiB.' },
  {
    id: 'unsupported-contexts',
    summary: 'Non-web asserted contexts and legacy epoch-less routes are not supported in project 1.'
  },
  {
    id: 'approved-forging-app',
    summary:
      'A user who approves a forging local app gets a fresh grant set plus everything the effective unverified policy leaves prompt-free; the reconnect token only stops silent reconnects, and the launch proof does not authenticate the website.'
  },
  {
    id: 'sheet-slot',
    summary:
      'An unanswered connection sheet holds its transport single slot until answered or its bindings close; a second new site on that transport gets RESOURCE_LIMIT. There is no deadline.'
  },
  {
    id: 'basket-contents-shared',
    summary:
      'Basket contents are not isolated between a site verified and unverified identities, or between connected sites, once basket access is granted.'
  },
  {
    id: 'manifest-fetch-hermes',
    summary:
      'The SDK private-address DNS check runs only on Node; on Hermes an unverified site claimed hostname resolving to a private address is fetched, bounded by TLS, the fixed URL and port and the special-use host list.'
  },
  {
    id: 'token-module-routing-case',
    summary:
      'Token-module routing is exact-case for attested callers (pre-existing); unverified bindings are covered by the dispatcher pre-scan.'
  },
  {
    id: 'sheet-modal-flag',
    summary:
      'executeGrant and handleDeny close the kind modal flag unconditionally, which can strand a queued request of the same kind (pre-existing).'
  }
]

const METHOD_DEVIATIONS: Partial<Record<WalletMethodName, string[]>> = {
  waitForAuthentication: ['wait-for-authentication-sheet'],
  listActions: ['list-actions-deadline'],
  isAuthenticated: ['sdk-http-json-clients']
}

export function buildConformanceReport(): ConformanceReport {
  const methods = (Object.keys(BRIDGE_METHODS) as WalletMethodName[]).sort().map(name => ({
    name,
    handling: BRIDGE_METHODS[name].probe ? ('probe' as const) : ('wallet' as const),
    mutating: BRIDGE_METHODS[name].mutating,
    deviations: METHOD_DEVIATIONS[name] ?? []
  }))
  return {
    reportVersion: CONFORMANCE_REPORT_VERSION,
    protocol: 'BRC-185',
    spec: { document: '2026-10-27-browser-bridge-core-design', revision: 5 },
    methods,
    limits: {
      maxRequestBytes: MAX_BRIDGE_REQUEST_BYTES,
      maxInFlightPerBinding: MAX_IN_FLIGHT_PER_BINDING,
      maxInFlightTotal: MAX_IN_FLIGHT_TOTAL,
      maxInFlightBytes: MAX_IN_FLIGHT_BYTES,
      maxBindingsPerOrigin: MAX_BINDINGS_PER_ORIGIN,
      maxBindingsTotal: MAX_BINDINGS_TOTAL,
      inboxMaxValidityMs: INBOX_MAX_VALIDITY_MS,
      declineBackoffMs: DECLINE_BACKOFF_MS
    },
    refusals: BRIDGE_REFUSALS.map(r => ({ ...r })),
    deviations: BRIDGE_DEVIATIONS.map(d => ({ ...d }))
  }
}
