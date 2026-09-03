# Universal Pay Input and Amount-First Request — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pay opens on one recipient field that infers the rail from what is typed or scanned; Get paid opens on an amount with three method rows; message-box config moves to Settings › Advanced; the remote link encodes BRC-125 with a `url` extension.

**Architecture:** Pure classifiers in `core/pay/rails` decide the rail; a new `UniversalSend` component replaces `HandleSend` + `AddressSend`; a new `RequestHub` fronts the three receive methods; `NearbyFlow`, `HandleReceive`, `AddressReceive` accept a pre-set amount/session; `PayScreen` composes them. The handle rail threads a `recipientHost` from link → send → outbox → retry.

**Tech Stack:** React Native 0.83 / Expo Router / TypeScript; `@bsv/sdk` (`PublicKey`, `Utils.fromBase58Check`); `@bsv/message-box-client` 2.2.1 (`sendMessage(msg, overrideHost?)`); Jest via `jest-expo` (`npm test -- <path>`); `@testing-library/react-native` 13.

**Spec:** `docs/superpowers/specs/2026-09-02-universal-pay-input-design.md` — read it first. The plan argues from it.

## Global Constraints

- Branch: `claude/universal-pay-input` (already created; spec committed as `b6ceb51`).
- Run tests with `npm test -- <path>` from the repo root. Typecheck with `npx tsc --noEmit` from the repo root.
- Lazy-require pattern is mandatory in every `ui/` file that touches `expo-router`, `@expo/vector-icons`, `expo-status-bar`, `expo-camera`, `react-native-qrcode-svg`: copy the `loadIonicons()` / `loadExpoRouter()` / `loadStatusBar()` helpers verbatim from `ui/components/pay/AddressSend.tsx` — never a top-level import. Jest cannot parse those packages through the `ui` barrel.
- Imports inside `packages/expo-wallet-toolbox/ui` use the package barrel `@bsv/expo-wallet-toolbox` for core exports (as every existing file does), and relative paths for `ui/` siblings.
- Twelve locales in `packages/expo-wallet-toolbox/core/i18n/translations.tsx`: `en zh hi es fr ar pt bn ru id ja pl` (block starts at lines 101, 783, 1304, 1831, 2359, 2881, 3398, 3919, 4440, 4962, 5484, 6018). Every key added or removed is added or removed in all twelve.
- BRC-125: scheme `peerpay:` (no `//` emitted; `//` tolerated on parse), amount param `sats`, extension param `url` (percent-encoded, `https:` only). Identity key emitted lowercase.
- Prettier style in this repo: no semicolons, single quotes, 2-space indent, `printWidth` 120.
- Commit after every task. Commit message body explains why, not what. End with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Do not commit anything from the pre-existing WIP except in Task 0.

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `core/parsePeerPayURI.ts` | BRC-125 parse; `url` extension; `peerPayValidationMessage` | modify |
| `core/pay/rails/index.ts` | `PayTarget` (+`messageBoxUrl`), `classifyScan`, new `classifyRecipientInput` | modify |
| `core/pay/rails/handle.ts` | `peerPayLinkFor(url)`, `sendViaHandle(recipientHost)`, `retryDelivery` | modify |
| `core/peerpay/outbox.ts` | `OutboxEntry.recipientHost` | modify |
| `core/amountFormatHelpers.ts` + `core/index.ts` | `formatAmountInInputUnit` | modify |
| `core/i18n/translations.tsx` | keys | modify |
| `ui/components/pay/useRecipientInput.ts` | recipient state: classify text, classify scan, search | rename from `useIdentitySearch.ts` + rewrite |
| `ui/components/pay/RecipientField.tsx` | universal input + status row | modify |
| `ui/components/pay/UniversalSend.tsx` | the send form | create (from `HandleSend.tsx`) |
| `ui/components/pay/HandleSend.tsx`, `AddressSend.tsx` | — | delete |
| `ui/components/pay/RequestHub.tsx` | amount + three method rows | create |
| `ui/components/pay/NearbyFlow.tsx` | `initialSession` / `initialRequest` | modify |
| `ui/components/pay/HandleReceive.tsx` | `initialSats`, link QR, no config bar | modify |
| `ui/components/pay/AddressReceive.tsx` | `initialSats` figure | modify |
| `ui/components/pay/AvailableBalance.tsx`, `PayForm.tsx` | balance line under input | modify |
| `ui/components/pay/MessageBoxConfig.tsx` | drop `MessageBoxBar` | modify |
| `ui/screens/PayScreen.tsx` | composition | modify |
| `ui/screens/WalletConfigScreen.tsx` | message-box row in Advanced | modify |
| `ui/index.ts` | exports | modify |
| Tests | `__tests__/pay/peerPayUri.test.ts` (new), `rails.test.ts`, `handleRail.test.ts`, `amountInputUnit.test.ts` (new), `useRecipientInput.test.ts` (renamed), `__tests__/ui/universalSend.test.tsx` (new), `requestHub.test.tsx` (new), `payScreen.test.tsx`, `payFormComponents.test.tsx` | |

All paths below are relative to `packages/expo-wallet-toolbox/` unless they start with `docs/`, `app/` or `package.json`.

---

### Task 0: Isolate the pre-existing WIP

The working tree already holds uncommitted, unrelated work (advisory modals, backup reminder sheet, import prompt, mnemonic screen). It touches `PayScreen.tsx`, `translations.tsx`, `ui/index.ts`, which later tasks edit. Commit it on its own so every later commit is clean. The user was told this would happen and did not object.

**Files:** everything `git status --short` lists.

- [ ] **Step 1: Confirm the WIP is what it claims to be**

Run: `git status --short && git diff --stat`
Expected: 7 modified files + 4 untracked (`nearbyAdvisory.ts`, `NearbyAdvisoryModal.tsx`, `BiometricAdvisoryModal.tsx`, `ImportFromBackupPrompt.tsx`). If anything else appears, stop and ask.

- [ ] **Step 2: Run the existing suite to record the baseline**

Run: `npm test -- packages/expo-wallet-toolbox/__tests__/ui/payScreen.test.tsx packages/expo-wallet-toolbox/__tests__/pay/rails.test.ts`
Expected: PASS. If not, note which fail — they are not yours to fix, but later tasks must not make them worse.

- [ ] **Step 3: Commit the WIP as its own commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
wip(onboarding): advisory modals, backup reminder sheet, import prompt

Pre-existing uncommitted work, committed unchanged so the universal
pay input work that follows lands in its own commits.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 1: BRC-125 parser — `//` tolerance, `url` extension, `peerPayValidationMessage`

**Files:**
- Modify: `core/parsePeerPayURI.ts`
- Test: `__tests__/pay/peerPayUri.test.ts` (create)

**Interfaces:**
- Produces: `PeerPayValidationResult.messageBoxUrl?: string`, `PeerPayParams.messageBoxUrl?: string`, `export function peerPayValidationMessage(result: PeerPayValidationResult | null): string | null` (moved here from `ui/components/pay/useIdentitySearch.ts`; Task 6 re-exports it from the hook for compatibility).

- [ ] **Step 1: Write the failing tests**

Create `__tests__/pay/peerPayUri.test.ts`:

```ts
import { parsePeerPayURI, peerPayValidationMessage, validatePeerPayURI } from '../../core/parsePeerPayURI'

// secp256k1 generator point, lowercase — the only form the key regex accepts.
const KEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'

describe('validatePeerPayURI — scheme', () => {
  it('accepts the spec form peerpay:<key>', () => {
    const r = validatePeerPayURI(`peerpay:${KEY}`)
    expect(r.isPeerPay).toBe(true)
    expect(r.identityKey).toBe(KEY)
    expect(r.errors).toEqual({})
  })

  it('tolerates peerpay://<key> and reads the same key', () => {
    const r = validatePeerPayURI(`peerpay://${KEY}?sats=12`)
    expect(r.identityKey).toBe(KEY)
    expect(r.sats).toBe(12)
    expect(r.errors).toEqual({})
  })

  it('ignores surrounding whitespace', () => {
    expect(validatePeerPayURI(`  peerpay:${KEY}  `).identityKey).toBe(KEY)
  })
})

describe('validatePeerPayURI — url extension', () => {
  it('reads a percent-encoded https url alongside sats', () => {
    const r = validatePeerPayURI(`peerpay:${KEY}?sats=5000&url=${encodeURIComponent('https://mb.example')}`)
    expect(r.sats).toBe(5000)
    expect(r.messageBoxUrl).toBe('https://mb.example')
    expect(r.errors).toEqual({})
  })

  it('trims trailing slashes off the url', () => {
    const r = validatePeerPayURI(`peerpay:${KEY}?url=${encodeURIComponent('https://mb.example/')}`)
    expect(r.messageBoxUrl).toBe('https://mb.example')
  })

  it('keeps a path on the url', () => {
    const r = validatePeerPayURI(`peerpay:${KEY}?url=${encodeURIComponent('https://mb.example/box/v1')}`)
    expect(r.messageBoxUrl).toBe('https://mb.example/box/v1')
  })

  it('drops an http url rather than failing the link', () => {
    const r = validatePeerPayURI(`peerpay:${KEY}?url=${encodeURIComponent('http://mb.example')}`)
    expect(r.messageBoxUrl).toBeUndefined()
    expect(r.identityKey).toBe(KEY)
    expect(r.errors).toEqual({})
  })

  it('drops a bare host, an empty url and garbage', () => {
    expect(validatePeerPayURI(`peerpay:${KEY}?url=mb.example`).messageBoxUrl).toBeUndefined()
    expect(validatePeerPayURI(`peerpay:${KEY}?url=`).messageBoxUrl).toBeUndefined()
    expect(validatePeerPayURI(`peerpay:${KEY}?url=${encodeURIComponent('https://a b')}`).messageBoxUrl).toBeUndefined()
  })

  it('still rejects a malformed key even when the url is fine', () => {
    const r = validatePeerPayURI(`peerpay:not-a-key?url=${encodeURIComponent('https://mb.example')}`)
    expect(r.identityKey).toBeUndefined()
    expect(r.errors.identityKey).toBeTruthy()
  })
})

describe('parsePeerPayURI', () => {
  it('returns key, sats and messageBoxUrl together', () => {
    expect(parsePeerPayURI(`peerpay:${KEY}?sats=7&url=${encodeURIComponent('https://mb.example')}`)).toEqual({
      identityKey: KEY,
      sats: 7,
      messageBoxUrl: 'https://mb.example'
    })
  })

  it('returns null for a bad key', () => {
    expect(parsePeerPayURI('peerpay:zzz')).toBeNull()
  })
})

describe('peerPayValidationMessage', () => {
  it('is null for a non-peerpay result or a clean one', () => {
    expect(peerPayValidationMessage(null)).toBeNull()
    expect(peerPayValidationMessage(validatePeerPayURI('bitcoin:x'))).toBeNull()
    expect(peerPayValidationMessage(validatePeerPayURI(`peerpay:${KEY}`))).toBeNull()
  })

  it('joins the key and sats errors', () => {
    const msg = peerPayValidationMessage(validatePeerPayURI('peerpay:zzz?sats=-1'))
    expect(msg).toContain('identity key')
    expect(msg).toContain('sats')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- packages/expo-wallet-toolbox/__tests__/pay/peerPayUri.test.ts`
Expected: FAIL — `peerPayValidationMessage` is not exported; `//` and `url` cases fail.

- [ ] **Step 3: Implement**

Replace `core/parsePeerPayURI.ts` with:

```ts
import { PublicKey } from '@bsv/sdk'

/**
 * BRC-125 PeerPay URI (https://bsv.brc.dev/payments/0125).
 *
 *   peerpay-URI = "peerpay:" identity-key [ "?" query ]
 *   sats-param  = "sats=" 1*DIGIT
 *
 * Plus one extension parameter this app emits and reads: `url`, the payee's
 * message-box host, so a payer can skip the overlay lookup. The spec says
 * unknown parameters MUST be ignored, so a `url` that is not a clean https
 * URL is dropped — never an error — and the payment falls back to lookup.
 * `peerpay://` is tolerated on input only; the app never emits it.
 */
export interface PeerPayParams {
  identityKey: string
  sats?: number
  messageBoxUrl?: string
}

export interface PeerPayValidationResult {
  isPeerPay: boolean
  identityKey?: string
  sats?: number
  /** Present only when the link carried a usable https `url` extension. */
  messageBoxUrl?: string
  errors: {
    identityKey?: string
    sats?: string
  }
}

const PEERPAY_SCHEME = 'peerpay:'
const COMPRESSED_PUBLIC_KEY_REGEX = /^0[23][0-9a-f]{64}$/
/** https, a host, then an optional path/query/fragment with no whitespace. */
const MESSAGE_BOX_URL_REGEX = /^https:\/\/[^\s/?#]+(?:[/?#]\S*)?$/i

export function parsePeerPayURI(uri: string): PeerPayParams | null {
  const result = validatePeerPayURI(uri)
  if (!result.isPeerPay || !result.identityKey || result.errors.identityKey || result.errors.sats) return null
  return {
    identityKey: result.identityKey,
    sats: result.sats,
    ...(result.messageBoxUrl ? { messageBoxUrl: result.messageBoxUrl } : {})
  }
}

export function validatePeerPayURI(uri: string): PeerPayValidationResult {
  const trimmed = uri.trim()
  if (!trimmed.toLowerCase().startsWith(PEERPAY_SCHEME)) {
    return { isPeerPay: false, errors: { identityKey: 'Not a peerpay link' } }
  }

  let withoutScheme = trimmed.slice(PEERPAY_SCHEME.length)
  if (withoutScheme.startsWith('//')) withoutScheme = withoutScheme.slice(2)
  const queryIndex = withoutScheme.indexOf('?')
  const keyPart = queryIndex === -1 ? withoutScheme : withoutScheme.slice(0, queryIndex)
  const queryPart = queryIndex === -1 ? '' : withoutScheme.slice(queryIndex + 1)
  const errors: PeerPayValidationResult['errors'] = {}

  let identityKey: string | undefined
  if (isValidIdentityKey(keyPart)) {
    identityKey = keyPart
  } else {
    errors.identityKey = 'PeerPay link contains an invalid identity key'
  }

  let sats: number | undefined
  let messageBoxUrl: string | undefined
  if (queryPart) {
    const params = new URLSearchParams(queryPart)
    if (params.has('sats')) {
      const satsStr = params.get('sats') ?? ''
      if (/^(0|[1-9][0-9]*)$/.test(satsStr)) {
        const parsed = Number(satsStr)
        if (Number.isSafeInteger(parsed)) {
          if (parsed > 0) sats = parsed
        } else {
          errors.sats = 'PeerPay link contains an invalid sats amount'
        }
      } else {
        errors.sats = 'PeerPay link contains an invalid sats amount'
      }
    }
    const url = (params.get('url') ?? '').trim().replace(/\/+$/, '')
    if (url && MESSAGE_BOX_URL_REGEX.test(url)) messageBoxUrl = url
  }

  return { isPeerPay: true, identityKey, sats, ...(messageBoxUrl ? { messageBoxUrl } : {}), errors }
}

/** The human-readable problem with a peerpay link, or null when there is none. */
export function peerPayValidationMessage(result: PeerPayValidationResult | null): string | null {
  if (!result || !result.isPeerPay) return null
  const messages = [result.errors.identityKey, result.errors.sats].filter(Boolean)
  return messages.length ? messages.join('. ') : null
}

function isValidIdentityKey(identityKey: string) {
  if (!COMPRESSED_PUBLIC_KEY_REGEX.test(identityKey)) return false
  try {
    PublicKey.fromString(identityKey)
    return true
  } catch {
    return false
  }
}
```

- [ ] **Step 4: Run the new test and the two existing consumers**

Run: `npm test -- packages/expo-wallet-toolbox/__tests__/pay/peerPayUri.test.ts packages/expo-wallet-toolbox/__tests__/pay/handleRail.test.ts packages/expo-wallet-toolbox/__tests__/pay/rails.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/expo-wallet-toolbox/core/parsePeerPayURI.ts packages/expo-wallet-toolbox/__tests__/pay/peerPayUri.test.ts
git commit -m "$(cat <<'EOF'
feat(peerpay): read a url extension and tolerate peerpay:// on parse

A payee can now name their message-box host in the link so the payer
skips the overlay lookup. Per BRC-125 an extension that does not parse
is ignored, not fatal — a typo in the hint must not block a payment
whose key is fine. Only https is accepted because the payer will
authenticate against whatever host this names.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Recipient classification — `classifyRecipientInput`, tighter `classifyScan`

**Files:**
- Modify: `core/pay/rails/index.ts`
- Test: `__tests__/pay/rails.test.ts`

**Interfaces:**
- Consumes: `validatePeerPayURI`, `peerPayValidationMessage` (Task 1).
- Produces:
  ```ts
  export type PayTarget =
    | { kind: 'nearby'; session: Session }
    | { kind: 'handle'; identityKey: string; sats?: number; messageBoxUrl?: string }
    | { kind: 'address'; address: string; sats?: number }
  export type RecipientInput =
    | { kind: 'empty' }
    | { kind: 'address'; address: string }
    | { kind: 'invalid_address' }
    | { kind: 'handle'; identityKey: string; sats?: number; messageBoxUrl?: string }
    | { kind: 'invalid_link'; message: string }
    | { kind: 'search'; query: string }
  export function classifyRecipientInput(raw: string): RecipientInput
  export function isCompressedPublicKey(text: string): boolean
  ```

- [ ] **Step 1: Write the failing tests**

Append to `__tests__/pay/rails.test.ts` (add `classifyRecipientInput` and `isCompressedPublicKey` to the import list at the top):

```ts
describe('classifyRecipientInput', () => {
  // Uppercase form of KEY: valid on the curve, but not the lowercase BRC-125 wants.
  const KEY_UPPER = KEY.toUpperCase()
  // Same length and alphabet as ADDRESS with the last character changed: checksum fails.
  const BROKEN_ADDRESS = ADDRESS.slice(0, -1) + (ADDRESS.endsWith('2') ? '3' : '2')

  it('treats an empty or whitespace string as empty', () => {
    expect(classifyRecipientInput('')).toEqual({ kind: 'empty' })
    expect(classifyRecipientInput('   ')).toEqual({ kind: 'empty' })
  })

  it('reads a base58check address as an address target', () => {
    expect(classifyRecipientInput(ADDRESS)).toEqual({ kind: 'address', address: ADDRESS })
    expect(classifyRecipientInput(`  ${ADDRESS}  `)).toEqual({ kind: 'address', address: ADDRESS })
  })

  it('flags an address-shaped string whose checksum fails, and does not search for it', () => {
    expect(classifyRecipientInput(BROKEN_ADDRESS)).toEqual({ kind: 'invalid_address' })
  })

  it('strips a bitcoin: scheme and query before the address rule', () => {
    expect(classifyRecipientInput(`bitcoin:${ADDRESS}?amount=0.1`)).toEqual({ kind: 'address', address: ADDRESS })
    expect(classifyRecipientInput(`bitcoin:${BROKEN_ADDRESS}`)).toEqual({ kind: 'invalid_address' })
  })

  it('reads a compressed key as a handle, lowercased', () => {
    expect(classifyRecipientInput(KEY)).toEqual({ kind: 'handle', identityKey: KEY })
    expect(classifyRecipientInput(KEY_UPPER)).toEqual({ kind: 'handle', identityKey: KEY })
  })

  it('sends an uncompressed key to search rather than paying it', () => {
    // 04 + 128 hex: the right length for an uncompressed key, not a compressed one.
    const uncompressed = '04' + 'ab'.repeat(64)
    expect(classifyRecipientInput(uncompressed)).toEqual({ kind: 'search', query: uncompressed })
  })

  it('reads a peerpay link as a handle carrying sats and messageBoxUrl', () => {
    const uri = `peerpay:${KEY}?sats=250&url=${encodeURIComponent('https://mb.example')}`
    expect(classifyRecipientInput(uri)).toEqual({
      kind: 'handle',
      identityKey: KEY,
      sats: 250,
      messageBoxUrl: 'https://mb.example'
    })
  })

  it('reports a malformed peerpay link as invalid_link with the validator message', () => {
    const r = classifyRecipientInput('peerpay:nope')
    expect(r.kind).toBe('invalid_link')
    expect((r as { message: string }).message).toContain('identity key')
  })

  it('sends a phone-shaped number to search — it is too short to be an address', () => {
    expect(classifyRecipientInput('12125551234')).toEqual({ kind: 'search', query: '12125551234' })
  })

  it('sends an email or a handle to search', () => {
    expect(classifyRecipientInput('alice@example.com')).toEqual({ kind: 'search', query: 'alice@example.com' })
    expect(classifyRecipientInput('alice')).toEqual({ kind: 'search', query: 'alice' })
  })
})

describe('classifyScan — key strictness and url', () => {
  it('rejects an uncompressed bare key', () => {
    expect(classifyScan('04' + 'ab'.repeat(64))).toBeNull()
  })

  it('lowercases a scanned compressed key', () => {
    expect(classifyScan(KEY.toUpperCase())).toEqual({ kind: 'handle', identityKey: KEY })
  })

  it('carries messageBoxUrl from a peerpay link', () => {
    const target = classifyScan(`peerpay:${KEY}?sats=5&url=${encodeURIComponent('https://mb.example')}`)
    expect(target).toEqual({ kind: 'handle', identityKey: KEY, sats: 5, messageBoxUrl: 'https://mb.example' })
  })
})

describe('isCompressedPublicKey', () => {
  it('accepts 02/03 + 64 hex on the curve, either case', () => {
    expect(isCompressedPublicKey(KEY)).toBe(true)
    expect(isCompressedPublicKey(KEY.toUpperCase())).toBe(true)
  })
  it('rejects the wrong prefix, length or a point off the curve', () => {
    expect(isCompressedPublicKey('04' + 'ab'.repeat(64))).toBe(false)
    expect(isCompressedPublicKey(KEY.slice(0, 64))).toBe(false)
    expect(isCompressedPublicKey('02' + 'ff'.repeat(32))).toBe(false)
  })
})
```

Note on `BROKEN_ADDRESS`: `ADDRESS` is `1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2`; changing the final `2` to `3` keeps the base58 alphabet and length but breaks the checksum.

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- packages/expo-wallet-toolbox/__tests__/pay/rails.test.ts`
Expected: FAIL — `classifyRecipientInput` / `isCompressedPublicKey` not exported.

- [ ] **Step 3: Implement**

In `core/pay/rails/index.ts`:

(a) Replace the file header comment (lines 1-9) with:

```ts
/**
 * Rail identity.
 *
 * A rail is never chosen by the user. It is inferred from what they typed or
 * scanned: a nearby-session code, an identity key or peerpay link, or a
 * base58check address. Free text that is none of those is an identity search.
 * Everything in this file is pure — no wallet, no network — so the
 * classification a payment depends on is testable in isolation.
 */
```

(b) Change the `PayTarget` handle variant to `{ kind: 'handle'; identityKey: string; sats?: number; messageBoxUrl?: string }`.

(c) Above the `PayCell` type, replace its doc comment with: `/** Six cell names. Since the universal input, `pay-*` are deep-link aliases that all open the send form; `get-*` open one receive method directly. */`

(d) Replace the private `isCompressedPublicKey` with an exported, strict one, and add the new classifier. Put these after `isValidBsvAddress`:

```ts
const COMPRESSED_KEY_REGEX = /^0[23][0-9a-fA-F]{64}$/
/**
 * Base58 alphabet (no 0, O, I, l), leading 1, 25–35 chars: the shape of a
 * P2PKH address. Anything this matches is either an address or a mis-paste —
 * never a search query — so a checksum failure is reported, not searched.
 */
const ADDRESS_CANDIDATE_REGEX = /^1[1-9A-HJ-NP-Za-km-z]{24,34}$/

/** A 33-byte compressed secp256k1 key in hex, either case, on the curve. */
export function isCompressedPublicKey(text: string): boolean {
  if (!COMPRESSED_KEY_REGEX.test(text)) return false
  try {
    PublicKey.fromString(text)
    return true
  } catch {
    return false
  }
}

/** What the recipient field has been given, as typed. */
export type RecipientInput =
  | { kind: 'empty' }
  | { kind: 'address'; address: string }
  | { kind: 'invalid_address' }
  | { kind: 'handle'; identityKey: string; sats?: number; messageBoxUrl?: string }
  | { kind: 'invalid_link'; message: string }
  | { kind: 'search'; query: string }

function handleFromPeerPay(result: PeerPayValidationResult): RecipientInput {
  if (!result.identityKey || result.errors.identityKey) {
    return { kind: 'invalid_link', message: peerPayValidationMessage(result) ?? 'Invalid peerpay link' }
  }
  return {
    kind: 'handle',
    identityKey: result.identityKey,
    ...(result.sats !== undefined ? { sats: result.sats } : {}),
    ...(result.messageBoxUrl ? { messageBoxUrl: result.messageBoxUrl } : {})
  }
}

/**
 * The one place typed text becomes a recipient kind. Order matters: schemed
 * forms first, then the address shape (which alone can produce an inline
 * error), then a bare key, then search for everything else.
 */
export function classifyRecipientInput(raw: string): RecipientInput {
  const text = raw.trim()
  if (!text) return { kind: 'empty' }

  if (text.toLowerCase().startsWith('peerpay:')) return handleFromPeerPay(validatePeerPayURI(text))

  const isBitcoinUri = /^bitcoin:/i.test(text)
  const candidate = isBitcoinUri ? normalizeAddressInput(text) : text
  if (isBitcoinUri || ADDRESS_CANDIDATE_REGEX.test(candidate)) {
    return isValidBsvAddress(candidate) ? { kind: 'address', address: candidate } : { kind: 'invalid_address' }
  }

  if (isCompressedPublicKey(text)) return { kind: 'handle', identityKey: text.toLowerCase() }

  return { kind: 'search', query: text }
}
```

Add `type PeerPayValidationResult` and `peerPayValidationMessage` to the existing import from `'../../parsePeerPayURI'`.

(e) In `classifyScan`, change the `peerpay:` branch to:

```ts
  if (text.toLowerCase().startsWith('peerpay:')) {
    const result = validatePeerPayURI(text)
    if (!result.identityKey || result.errors.identityKey) return null
    return {
      kind: 'handle',
      identityKey: result.identityKey,
      sats: result.sats,
      ...(result.messageBoxUrl ? { messageBoxUrl: result.messageBoxUrl } : {})
    }
  }
```

and the bare-key line to `if (isCompressedPublicKey(text)) return { kind: 'handle', identityKey: text.toLowerCase() }`.

- [ ] **Step 4: Run tests**

Run: `npm test -- packages/expo-wallet-toolbox/__tests__/pay/rails.test.ts`
Expected: PASS, including the pre-existing `classifyScan` cases (the peerpay one asserts `{ kind: 'handle', identityKey: KEY, sats: 5000 }` — the spread adds no `messageBoxUrl` key when absent, so `toEqual` holds).

- [ ] **Step 5: Commit**

```bash
git add packages/expo-wallet-toolbox/core/pay/rails/index.ts packages/expo-wallet-toolbox/__tests__/pay/rails.test.ts
git commit -m "$(cat <<'EOF'
feat(pay): classify typed recipient text into a rail

One pure function decides address / key / peerpay / search from what
was typed. An address-shaped string with a bad checksum is reported
inline instead of being sent to identity search, because it is almost
always a mis-paste. Scanned bare keys must now be compressed.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Handle rail — `url` in links, `recipientHost` through send, outbox and retry

**Files:**
- Modify: `core/pay/rails/handle.ts` (`peerPayLinkFor` ~74-77, `sendViaHandle` ~371-470, `retryDelivery` ~558-596)
- Modify: `core/peerpay/outbox.ts` (`OutboxEntry`, `saveOutboxEntry` ~111-133)
- Test: `__tests__/pay/handleRail.test.ts`

**Interfaces:**
- Produces: `peerPayLinkFor(identityKey: string, sats?: number, messageBoxUrl?: string): string`; `sendViaHandle(args & { recipientHost?: string })`; `OutboxEntry.recipientHost?: string`; `saveOutboxEntry(storage, { …, recipientHost?: string })`.
- `retryDelivery` signature unchanged; it reads `entry.recipientHost`. Call sites in `core/context/WalletContext.tsx:1360` and `ui/screens/WalletHomeScreen.tsx:890` need no change.

- [ ] **Step 1: Write the failing tests**

In `__tests__/pay/handleRail.test.ts`, add `NO_MESSAGE_BOX` is already imported. Add inside `describe('peerPayLinkFor')`:

```ts
  it('appends the message-box host as a percent-encoded url extension', () => {
    expect(peerPayLinkFor(KEY, 5000, 'https://mb.example/')).toBe(
      `peerpay:${KEY}?sats=5000&url=${encodeURIComponent('https://mb.example')}`
    )
  })

  it('emits url alone when there is no amount', () => {
    expect(peerPayLinkFor(KEY, undefined, 'https://mb.example')).toBe(
      `peerpay:${KEY}?url=${encodeURIComponent('https://mb.example')}`
    )
  })

  it('omits url for the no-server sentinel and for blank', () => {
    expect(peerPayLinkFor(KEY, 10, NO_MESSAGE_BOX)).toBe(`peerpay:${KEY}?sats=10`)
    expect(peerPayLinkFor(KEY, 10, '   ')).toBe(`peerpay:${KEY}?sats=10`)
  })

  it('round-trips the url through the validator', () => {
    const r = validatePeerPayURI(peerPayLinkFor(KEY, 42, 'https://mb.example/box'))
    expect(r.sats).toBe(42)
    expect(r.messageBoxUrl).toBe('https://mb.example/box')
  })

  it('lowercases the key it emits', () => {
    expect(peerPayLinkFor(KEY.toUpperCase())).toBe(`peerpay:${KEY}`)
  })
```

Add inside `describe('sendViaHandle')`:

```ts
  it('passes recipientHost to sendMessage and persists it on the entry', async () => {
    const s = fakeStorage()
    const w = fakeWallet()
    const client = { sendMessage: jest.fn().mockResolvedValue(undefined) }
    await sendViaHandle({ ...sendArgs(w, client, s), recipientHost: 'https://their.box' })
    expect(client.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ recipient: KEY }), 'https://their.box')
    expect((await getOutboxEntries(s))[0].recipientHost).toBe('https://their.box')
  })

  it('sends with no host override and stores no recipientHost when none was given', async () => {
    const s = fakeStorage()
    const w = fakeWallet()
    const client = { sendMessage: jest.fn().mockResolvedValue(undefined) }
    await sendViaHandle(sendArgs(w, client, s))
    expect(client.sendMessage.mock.calls[0][1]).toBeUndefined()
    expect((await getOutboxEntries(s))[0]).not.toHaveProperty('recipientHost')
  })
```

Add a new describe block after `describe('sendViaHandle')`:

```ts
describe('retryDelivery — recipient host', () => {
  it('re-sends to the host the entry was minted for', async () => {
    const s = fakeStorage()
    const w = fakeWallet()
    const failing = { sendMessage: jest.fn().mockRejectedValue(new Error('down')) }
    await expect(
      sendViaHandle({ ...sendArgs(w, failing, s), recipientHost: 'https://their.box' })
    ).rejects.toThrow('down')
    const entry = (await getOutboxEntries(s))[0]
    expect(entry.status).toBe('unsent')

    const client = { sendMessage: jest.fn().mockResolvedValue(undefined) }
    await retryDelivery({ wallet: w as never, adminOriginator: 'admin.com', client: client as never, storage: s, entry })
    expect(client.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ recipient: KEY }), 'https://their.box')
  })

  it('re-sends with no override for an entry that has no recipientHost', async () => {
    const s = fakeStorage()
    const w = fakeWallet()
    const failing = { sendMessage: jest.fn().mockRejectedValue(new Error('down')) }
    await expect(sendViaHandle(sendArgs(w, failing, s))).rejects.toThrow('down')
    const entry = (await getOutboxEntries(s))[0]
    const client = { sendMessage: jest.fn().mockResolvedValue(undefined) }
    await retryDelivery({ wallet: w as never, adminOriginator: 'admin.com', client: client as never, storage: s, entry })
    expect(client.sendMessage.mock.calls[0][1]).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- packages/expo-wallet-toolbox/__tests__/pay/handleRail.test.ts`
Expected: FAIL on the new cases (extra argument not accepted / not passed).

- [ ] **Step 3: Implement — outbox**

In `core/peerpay/outbox.ts`, add to `OutboxEntry` after `messageBoxUrl: string`:

```ts
  /**
   * The RECIPIENT's message-box host, when a BRC-125 link named one via its
   * `url` extension. Every re-send of this entry goes here, bypassing the
   * overlay lookup. Absent for entries minted from a bare key.
   */
  recipientHost?: string
```

In `saveOutboxEntry`, add `recipientHost?: string` to `params`, destructure it, and spread it into the entry: `...(recipientHost ? { recipientHost } : {})` (next to the `txid` spread).

- [ ] **Step 4: Implement — handle rail**

In `core/pay/rails/handle.ts`:

(a) Replace `peerPayLinkFor` and its doc comment with:

```ts
/**
 * A shareable BRC-125 payment link for a handle.
 *
 * `peerpay:<key>[?sats=<n>][&url=<host>]`. The same form the app parses
 * (parsePeerPayURI.ts) and routes (+native-intent.ts in the host app). A
 * non-positive amount emits no `sats` — `sats=0` would be an invalid link,
 * and an open request is exactly the absence of a figure. `url` is this
 * app's extension: the payee's message-box host, so the payer can skip the
 * overlay lookup. Omitted for the no-server sentinel and for blank.
 */
export function peerPayLinkFor(identityKey: string, sats?: number, messageBoxUrl?: string): string {
  const params: string[] = []
  const amount = sats !== undefined ? Math.round(Number(sats)) : NaN
  if (Number.isFinite(amount) && amount > 0) params.push(`sats=${amount}`)
  const host = (messageBoxUrl ?? '').trim().replace(/\/+$/, '')
  if (host && host !== NO_MESSAGE_BOX) params.push(`url=${encodeURIComponent(host)}`)
  const base = `peerpay:${identityKey.toLowerCase()}`
  return params.length ? `${base}?${params.join('&')}` : base
}
```

(b) In `sendViaHandle`'s args type, after `recipientName?: string`, add:

```ts
  /**
   * The recipient's message-box host from a BRC-125 `url` extension. Passed
   * as sendMessage's override so the overlay lookup is skipped, and stored on
   * the entry so every retry goes to the same place.
   */
  recipientHost?: string
```

Destructure `recipientHost` alongside the others. Change the `saveOutboxEntry` call to `saveOutboxEntry(storage, { recipient, token, messageBoxUrl, txid: car.txid, recipientHost })`. Change the delivery call to:

```ts
    await client.sendMessage(
      {
        recipient,
        messageBox: PAYMENT_INBOX,
        body: JSON.stringify(token)
      },
      recipientHost
    )
```

(c) In `retryDelivery`, change the `sendMessage` call to pass `entry.recipientHost` as the second argument, same shape as above.

- [ ] **Step 5: Run tests and typecheck**

Run: `npm test -- packages/expo-wallet-toolbox/__tests__/pay/handleRail.test.ts packages/expo-wallet-toolbox/__tests__/pay/outbox.test.ts && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 6: Commit**

```bash
git add packages/expo-wallet-toolbox/core/pay/rails/handle.ts packages/expo-wallet-toolbox/core/peerpay/outbox.ts packages/expo-wallet-toolbox/__tests__/pay/handleRail.test.ts
git commit -m "$(cat <<'EOF'
feat(peerpay): carry the recipient's message-box host from link to retry

A BRC-125 link can name where the payee listens. The send passes it as
the client's host override so no overlay round-trip is needed, and the
outbox entry remembers it so a retry — manual or from the drain task —
lands in the same box rather than re-resolving.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Balance line — `formatAmountInInputUnit`, `AvailableBalance`, `PayAmountField` order

**Files:**
- Modify: `core/amountFormatHelpers.ts` (append after `formatAmountParts`), `core/index.ts` (the named export list ending at line 45)
- Modify: `ui/components/pay/AvailableBalance.tsx`, `ui/components/pay/PayForm.tsx:55-70`
- Test: `__tests__/pay/amountInputUnit.test.ts` (create), `__tests__/ui/payFormComponents.test.tsx`

**Interfaces:**
- Produces: `export const formatAmountInInputUnit = (satoshis: number, currency: string, satoshisPerUSD: number): string` — exported from the barrel.

- [ ] **Step 1: Write the failing tests**

Create `__tests__/pay/amountInputUnit.test.ts`:

```ts
import { formatAmountInInputUnit } from '../../core/amountFormatHelpers'

const digits = (s: string) => s.replace(/\D/g, '')

describe('formatAmountInInputUnit', () => {
  it('BSV mode: grouped satoshis, no unit word', () => {
    const s = formatAmountInInputUnit(1000, 'BSV', 0)
    expect(digits(s)).toBe('1000')
    expect(s).not.toMatch(/[A-Za-z$]/)
  })

  it('BSV mode: stays in satoshis past 1 BSV — the input beside it says satoshis', () => {
    const s = formatAmountInInputUnit(150_000_000, 'BSV', 0)
    expect(digits(s)).toBe('150000000')
    expect(s).not.toMatch(/BSV/i)
  })

  it('USD mode: two decimals, no symbol', () => {
    const s = formatAmountInInputUnit(50_000, 'USD', 100_000) // 0.5 USD
    expect(s).toMatch(/^0[.,]50$/)
  })

  it('USD mode with no rate: empty, so the caller renders nothing', () => {
    expect(formatAmountInInputUnit(50_000, 'USD', 0)).toBe('')
  })

  it('non-finite input: empty', () => {
    expect(formatAmountInInputUnit(Number.NaN, 'BSV', 0)).toBe('')
  })
})
```

In `__tests__/ui/payFormComponents.test.tsx`, replace the test titled `'always asks the same question: AMOUNT label, balance line, amount input'` with:

```ts
  it('always asks the same question: AMOUNT label, amount input, then the balance line beneath it', () => {
    const screen = wrap(<PayAmountField value="" onChangeText={() => {}} />)
    expect(screen.getByText('amount')).toBeTruthy()
    const tree = JSON.stringify(screen.toJSON())
    const inputAt = tree.indexOf('"amount-input"')
    const balanceAt = tree.indexOf('"available-balance"')
    expect(inputAt).toBeGreaterThan(-1)
    expect(balanceAt).toBeGreaterThan(inputAt)
  })
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- packages/expo-wallet-toolbox/__tests__/pay/amountInputUnit.test.ts packages/expo-wallet-toolbox/__tests__/ui/payFormComponents.test.tsx`
Expected: FAIL — helper missing; order assertion fails.

- [ ] **Step 3: Implement the helper**

Append to `core/amountFormatHelpers.ts` after `formatAmountParts`:

```ts
/**
 * The spendable figure in the unit AmountInput is asking for RIGHT NOW, with
 * no symbol and no unit word: the input's own suffix already says "satoshis"
 * or "USD", and repeating it beside the balance reads twice. BSV mode never
 * switches to whole BSV for this reason — the field beside it takes satoshis.
 * Empty when there is nothing honest to show (no rate in USD mode, NaN).
 */
export const formatAmountInInputUnit = (satoshis: number, currency: string, satoshisPerUSD: number): string => {
  const n = Number(satoshis)
  if (!Number.isFinite(n)) return ''
  if (currency === 'USD') {
    if (!(satoshisPerUSD > 0)) return ''
    const usd = Math.abs(n) / satoshisPerUSD
    try {
      return new Intl.NumberFormat(localeDefault, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(usd)
    } catch {
      return usd.toFixed(2)
    }
  }
  return formatSatoshisLocale(Math.abs(Math.round(n)))
}
```

In `core/index.ts`, add `formatAmountInInputUnit` to the named export list from `'./amountFormatHelpers'` (the block ending at line 45).

- [ ] **Step 4: Rewrite `AvailableBalance`**

Replace `ui/components/pay/AvailableBalance.tsx` with:

```tsx
/**
 * The "what can I actually send?" line under the amount input.
 *
 * One footnote: the spendable figure, then "available". The figure is in the
 * unit the input above it is taking (satoshis or USD) with no symbol or unit
 * word, because the input's own suffix already names it. Renders nothing until
 * a figure exists rather than flashing "0", and nothing in USD mode until a
 * rate exists rather than inventing one.
 */
import React, { useContext } from 'react'
import { StyleSheet, Text } from 'react-native'
import { useTranslation } from 'react-i18next'
import { useSpendableBalance } from '../../hooks/useSpendableBalance'
import { ExchangeRateContext, formatAmountInInputUnit, spacing, typography, useTheme, useWallet } from '@bsv/expo-wallet-toolbox'

export default function AvailableBalance() {
  const { t } = useTranslation()
  const { colors } = useTheme()
  const { settings } = useWallet()
  const { satoshisPerUSD } = useContext(ExchangeRateContext)
  const balance = useSpendableBalance()

  if (balance == null) return null
  const figure = formatAmountInInputUnit(balance, settings?.currency || 'BSV', satoshisPerUSD)
  if (!figure) return null

  return (
    <Text style={[styles.text, { color: colors.textSecondary }]} accessibilityRole="text">
      <Text style={[styles.figure, { color: colors.textPrimary }]}>{figure}</Text> {t('available')}
    </Text>
  )
}

const styles = StyleSheet.create({
  text: { ...typography.footnote, marginTop: spacing.sm },
  figure: { ...typography.footnote, fontWeight: '600', fontVariant: ['tabular-nums'] }
})
```

- [ ] **Step 5: Swap the order in `PayAmountField`**

In `ui/components/pay/PayForm.tsx`, change the body of `PayAmountField` to:

```tsx
  return (
    <PayField labelKey="amount">
      <AmountInput value={value} onChangeText={onChangeText} showMax={showMax} />
      {showBalance && <AvailableBalance />}
    </PayField>
  )
```

and update its doc comment's "same balance line" phrase to "same balance line beneath it".

- [ ] **Step 6: Run tests and typecheck**

Run: `npm test -- packages/expo-wallet-toolbox/__tests__/pay/amountInputUnit.test.ts packages/expo-wallet-toolbox/__tests__/ui/payFormComponents.test.tsx && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 7: Commit**

```bash
git add packages/expo-wallet-toolbox/core/amountFormatHelpers.ts packages/expo-wallet-toolbox/core/index.ts packages/expo-wallet-toolbox/ui/components/pay/AvailableBalance.tsx packages/expo-wallet-toolbox/ui/components/pay/PayForm.tsx packages/expo-wallet-toolbox/__tests__/pay/amountInputUnit.test.ts packages/expo-wallet-toolbox/__tests__/ui/payFormComponents.test.tsx
git commit -m "$(cat <<'EOF'
feat(pay): balance line under the amount, in the input's own unit

"1,000 available" beneath the field it qualifies, with no unit word:
the input's suffix already says satoshis or USD. BSV mode stays in
satoshis past 1 BSV for the same reason.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Copy — new keys in twelve locales, placeholder rename

**Files:**
- Modify: `core/i18n/translations.tsx`
- Modify: `ui/components/pay/RecipientField.tsx:107` (`t('search_name_or_key')` → `t('recipient_placeholder')`)

No new test file: `t` is mocked to identity in every UI test. The check is `npx tsc --noEmit` plus a grep that no locale still has the old key.

- [ ] **Step 1: Add keys to every locale**

For each of the twelve locale blocks, make these edits. Anchor lines for `en` are given; the same anchor keys exist in every block (grep the key name inside the block).

(a) Replace the line `search_name_or_key: '…',` with `recipient_placeholder: '…',` using this value:

| locale | value |
|---|---|
| en | `Handle, pubkey, or address...` |
| zh | `账号、公钥或地址...` |
| hi | `हैंडल, पब्लिक की या पता...` |
| es | `Alias, clave pública o dirección...` |
| fr | `Identifiant, clé publique ou adresse...` |
| ar | `اسم المستخدم أو المفتاح العام أو العنوان...` |
| pt | `Identificador, chave pública ou endereço...` |
| bn | `হ্যান্ডেল, পাবলিক কী বা ঠিকানা...` |
| ru | `Имя, публичный ключ или адрес...` |
| id | `Handle, kunci publik, atau alamat...` |
| ja | `ハンドル、公開鍵、またはアドレス...` |
| pl | `Nazwa, klucz publiczny lub adres...` |

(b) Directly after the `valid_identity_key:` line, insert `valid_bsv_address:`:

| locale | value |
|---|---|
| en | `Valid address entered` |
| zh | `已输入有效地址` |
| hi | `वैध पता दर्ज किया गया` |
| es | `Dirección válida ingresada` |
| fr | `Adresse valide saisie` |
| ar | `تم إدخال عنوان صالح` |
| pt | `Endereço válido inserido` |
| bn | `বৈধ ঠিকানা প্রবেশ করা হয়েছে` |
| ru | `Введён действительный адрес` |
| id | `Alamat valid dimasukkan` |
| ja | `有効なアドレスが入力されました` |
| pl | `Wprowadzono prawidłowy adres` |

(c) Directly after the `message_box_removed:` line, insert two keys, `message_box_off:` then `message_box_off_hint:`:

| locale | `message_box_off` | `message_box_off_hint` |
|---|---|---|
| en | `Off` | `Message box server is off. Turn it on in Settings › Advanced.` |
| zh | `关闭` | `消息箱服务器已关闭。请在“设置 › 高级”中开启。` |
| hi | `बंद` | `मैसेज बॉक्स सर्वर बंद है। इसे सेटिंग्स › एडवांस्ड में चालू करें।` |
| es | `Desactivado` | `El servidor de buzón está desactivado. Actívalo en Ajustes › Avanzado.` |
| fr | `Désactivé` | `Le serveur de boîte aux lettres est désactivé. Activez-le dans Réglages › Avancé.` |
| ar | `متوقف` | `خادم صندوق الرسائل متوقف. فعّله من الإعدادات › متقدم.` |
| pt | `Desligado` | `O servidor de caixa de mensagens está desligado. Ative-o em Configurações › Avançado.` |
| bn | `বন্ধ` | `মেসেজ বক্স সার্ভার বন্ধ আছে। সেটিংস › অ্যাডভান্সড থেকে চালু করুন।` |
| ru | `Выкл.` | `Сервер почтового ящика выключен. Включите его в Настройки › Дополнительно.` |
| id | `Mati` | `Server kotak pesan mati. Nyalakan di Pengaturan › Lanjutan.` |
| ja | `オフ` | `メッセージボックスサーバーがオフです。設定 › 詳細でオンにしてください。` |
| pl | `Wył.` | `Serwer skrzynki wiadomości jest wyłączony. Włącz go w Ustawienia › Zaawansowane.` |

(d) Directly after the `scan_identity_key_hint:` line, insert `scan_recipient_hint:` (the two old scan hints stay until Task 12 removes them):

| locale | value |
|---|---|
| en | `Point the camera at a payment code` |
| zh | `将相机对准付款码` |
| hi | `कैमरे को भुगतान कोड पर लगाएं` |
| es | `Apunte la cámara hacia un código de pago` |
| fr | `Pointez la caméra vers un code de paiement` |
| ar | `وجّه الكاميرا نحو رمز الدفع` |
| pt | `Aponte a câmera para um código de pagamento` |
| bn | `পেমেন্ট কোডে ক্যামেরা তাক করুন` |
| ru | `Направьте камеру на платёжный код` |
| id | `Arahkan kamera ke kode pembayaran` |
| ja | `支払いコードにカメラを向けてください` |
| pl | `Skieruj kamerę na kod płatności` |

(e) Directly after the `pay_cell_address_get_sub:` line, insert four keys in this order: `pay_method`, `pay_method_nearby`, `pay_method_remote_link`, `pay_method_address`:

| locale | `pay_method` | `pay_method_nearby` | `pay_method_remote_link` | `pay_method_address` |
|---|---|---|---|---|
| en | `Method` | `Nearby` | `Share remote link` | `To an address` |
| zh | `方式` | `附近` | `分享远程链接` | `到某个地址` |
| hi | `तरीका` | `नज़दीक` | `रिमोट लिंक साझा करें` | `एक पते पर` |
| es | `Método` | `Cerca` | `Compartir enlace remoto` | `A una dirección` |
| fr | `Méthode` | `À proximité` | `Partager un lien à distance` | `À une adresse` |
| ar | `الطريقة` | `قريب` | `مشاركة رابط عن بُعد` | `إلى عنوان` |
| pt | `Método` | `Por perto` | `Compartilhar link remoto` | `Para um endereço` |
| bn | `পদ্ধতি` | `কাছাকাছি` | `রিমোট লিংক শেয়ার করুন` | `একটি ঠিকানায়` |
| ru | `Способ` | `Рядом` | `Поделиться ссылкой` | `На адрес` |
| id | `Metode` | `Terdekat` | `Bagikan tautan jarak jauh` | `Ke alamat` |
| ja | `方法` | `近く` | `リモートリンクを共有` | `アドレスへ` |
| pl | `Metoda` | `W pobliżu` | `Udostępnij link zdalny` | `Na adres` |

Quote strings with single quotes; where a value contains a single quote, use double quotes as the file already does (`"Clé d'identité valide saisie"`).

- [ ] **Step 2: Update the placeholder consumer**

In `ui/components/pay/RecipientField.tsx`, change `placeholder={t('search_name_or_key')}` to `placeholder={t('recipient_placeholder')}`.

- [ ] **Step 3: Verify**

Run:
```bash
grep -c "recipient_placeholder:" packages/expo-wallet-toolbox/core/i18n/translations.tsx
grep -c "search_name_or_key" packages/expo-wallet-toolbox/core/i18n/translations.tsx packages/expo-wallet-toolbox/ui/components/pay/RecipientField.tsx
for k in valid_bsv_address message_box_off message_box_off_hint scan_recipient_hint pay_method pay_method_nearby pay_method_remote_link pay_method_address; do printf '%s ' "$k"; grep -c "^      $k:" packages/expo-wallet-toolbox/core/i18n/translations.tsx; done
npx tsc --noEmit
```
Expected: `12`; `0` and `0`; every key `12`; tsc clean.

- [ ] **Step 4: Commit**

```bash
git add packages/expo-wallet-toolbox/core/i18n/translations.tsx packages/expo-wallet-toolbox/ui/components/pay/RecipientField.tsx
git commit -m "$(cat <<'EOF'
i18n(pay): copy for the universal recipient field and the request hub

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `useRecipientInput` hook (from `useIdentitySearch`)

**Files:**
- Rename: `ui/components/pay/useIdentitySearch.ts` → `ui/components/pay/useRecipientInput.ts` (`git mv`), then rewrite
- Rename: `__tests__/pay/useIdentitySearch.test.ts` → `__tests__/pay/useRecipientInput.test.ts` (`git mv`), then rewrite
- Modify: `ui/index.ts:68-72` (export block)

**Interfaces:**
- Consumes: `classifyRecipientInput`, `classifyScan`, `PayTarget` (Task 2); `peerPayValidationMessage` (Task 1); `searchIdentities` (`ui/resolveIdentity.ts`).
- Produces:
  ```ts
  export type RecipientTarget = Extract<PayTarget, { kind: 'handle' | 'address' }>
  export type RecipientInlineError = 'invalid_bsv_address'
  export interface UseRecipientInputOptions {
    wallet: unknown
    adminOriginator: string | undefined
    initialTarget?: RecipientTarget
    onPeerPayAmount?: (sats: number) => void
    onPeerPayError?: (message: string) => void
    onNearbySession?: (session: Session) => void
  }
  export function useRecipientInput(opts: UseRecipientInputOptions): {
    inputText: string
    target: RecipientTarget | null
    inlineError: RecipientInlineError | null
    selectedIdentity: DisplayableIdentity | null
    searchResults: DisplayableIdentity[]
    isSearching: boolean
    searchError: boolean
    clearSearchError: () => void
    onChangeText: (text: string) => void
    selectIdentity: (identity: DisplayableIdentity) => void
    clearRecipient: () => void
    scannerVisible: boolean
    setScannerVisible: (v: boolean) => void
    openScanner: () => void
    onScan: (data: string) => void
  }
  export { peerPayValidationMessage }   // re-export for compatibility
  export function classifyIdentitySearchError(_e: unknown): boolean
  ```
  Barrel exports: `peerPayValidationMessage, classifyIdentitySearchError, useRecipientInput, type RecipientTarget, type RecipientInlineError, type UseRecipientInputOptions` from `./components/pay/useRecipientInput`. `useIdentitySearch` is gone from the barrel.

- [ ] **Step 1: Rename**

```bash
git mv packages/expo-wallet-toolbox/ui/components/pay/useIdentitySearch.ts packages/expo-wallet-toolbox/ui/components/pay/useRecipientInput.ts
git mv packages/expo-wallet-toolbox/__tests__/pay/useIdentitySearch.test.ts packages/expo-wallet-toolbox/__tests__/pay/useRecipientInput.test.ts
```

- [ ] **Step 2: Write the failing tests**

Replace `__tests__/pay/useRecipientInput.test.ts` with:

```ts
// The hook imports from the package root, which pulls LocalStorageProvider's
// secrets stack (expo-secure-store / expo-local-authentication) at module load.
jest.mock('expo-secure-store', () => require('../__mocks__/secureStoreFake').fake)
jest.mock('expo-local-authentication', () => require('../__mocks__/localAuthFake').fake)

import { act, renderHook } from '@testing-library/react-native'
import { classifyIdentitySearchError, useRecipientInput } from '../../ui/components/pay/useRecipientInput'
import { encodeSession, mintSession } from '../../core/localpay/session'

const KEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const ADDRESS = '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2'
const BROKEN_ADDRESS = ADDRESS.slice(0, -1) + '3'

// wallet: null → no IdentityClient is built, so search resolves to nothing
// without touching the network. Everything else here is pure classification.
const draw = (extra: Partial<Parameters<typeof useRecipientInput>[0]> = {}) =>
  renderHook(() => useRecipientInput({ wallet: null, adminOriginator: 'admin.com', ...extra }))

describe('classifyIdentitySearchError', () => {
  it('treats any thrown overlay lookup failure as an outage, not “no such person”', () => {
    expect(classifyIdentitySearchError(new Error('timeout'))).toBe(true)
  })
})

describe('useRecipientInput — typing', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it('starts empty', () => {
    const { result } = draw()
    expect(result.current.target).toBeNull()
    expect(result.current.inputText).toBe('')
    expect(result.current.inlineError).toBeNull()
  })

  it('makes an address target from a valid address, with no search', () => {
    const { result } = draw()
    act(() => result.current.onChangeText(ADDRESS))
    expect(result.current.target).toEqual({ kind: 'address', address: ADDRESS })
    expect(result.current.isSearching).toBe(false)
  })

  it('flags a checksum-broken address inline and keeps the target null', () => {
    const { result } = draw()
    act(() => result.current.onChangeText(BROKEN_ADDRESS))
    expect(result.current.target).toBeNull()
    expect(result.current.inlineError).toBe('invalid_bsv_address')
    expect(result.current.isSearching).toBe(false)
  })

  it('makes a handle target from a compressed key, lowercased', () => {
    const { result } = draw()
    act(() => result.current.onChangeText(KEY.toUpperCase()))
    expect(result.current.target).toEqual({ kind: 'handle', identityKey: KEY })
  })

  it('makes a handle target from a peerpay link and reports its amount and host', () => {
    const onPeerPayAmount = jest.fn()
    const { result } = draw({ onPeerPayAmount })
    act(() => result.current.onChangeText(`peerpay:${KEY}?sats=99&url=${encodeURIComponent('https://mb.example')}`))
    expect(result.current.target).toEqual({ kind: 'handle', identityKey: KEY, messageBoxUrl: 'https://mb.example' })
    expect(onPeerPayAmount).toHaveBeenCalledWith(99)
  })

  it('reports a malformed peerpay link through onPeerPayError', () => {
    const onPeerPayError = jest.fn()
    const { result } = draw({ onPeerPayError })
    act(() => result.current.onChangeText('peerpay:nope'))
    expect(result.current.target).toBeNull()
    expect(onPeerPayError).toHaveBeenCalledWith(expect.stringContaining('identity key'))
  })

  it('searches for free text after the debounce, and stops when there is no client', () => {
    const { result } = draw()
    act(() => result.current.onChangeText('alice'))
    expect(result.current.isSearching).toBe(true)
    expect(result.current.target).toBeNull()
    act(() => {
      jest.advanceTimersByTime(450)
    })
    expect(result.current.isSearching).toBe(false)
    expect(result.current.searchResults).toEqual([])
  })

  it('clears everything on an empty string', () => {
    const { result } = draw()
    act(() => result.current.onChangeText(ADDRESS))
    act(() => result.current.onChangeText(''))
    expect(result.current.target).toBeNull()
    expect(result.current.inlineError).toBeNull()
  })

  it('adopts an initial target and shows its text', () => {
    const { result } = draw({ initialTarget: { kind: 'handle', identityKey: KEY, messageBoxUrl: 'https://mb.example' } })
    expect(result.current.target).toEqual({ kind: 'handle', identityKey: KEY, messageBoxUrl: 'https://mb.example' })
    expect(result.current.inputText).toBe(KEY)
  })

  it('clearRecipient resets to empty', () => {
    const { result } = draw({ initialTarget: { kind: 'address', address: ADDRESS } })
    act(() => result.current.clearRecipient())
    expect(result.current.target).toBeNull()
    expect(result.current.inputText).toBe('')
  })
})

describe('useRecipientInput — scanning', () => {
  it('sets an address target from an address QR and closes the scanner', () => {
    const { result } = draw()
    act(() => result.current.openScanner())
    expect(result.current.scannerVisible).toBe(true)
    act(() => result.current.onScan(`bitcoin:${ADDRESS}`))
    expect(result.current.target).toEqual({ kind: 'address', address: ADDRESS })
    expect(result.current.scannerVisible).toBe(false)
  })

  it('sets a handle target from a peerpay QR and reports the amount', () => {
    const onPeerPayAmount = jest.fn()
    const { result } = draw({ onPeerPayAmount })
    act(() => result.current.openScanner())
    act(() => result.current.onScan(`peerpay:${KEY}?sats=12`))
    expect(result.current.target).toEqual({ kind: 'handle', identityKey: KEY })
    expect(onPeerPayAmount).toHaveBeenCalledWith(12)
    expect(result.current.scannerVisible).toBe(false)
  })

  it('hands a nearby session up and closes the scanner without setting a target', () => {
    const onNearbySession = jest.fn()
    const { result } = draw({ onNearbySession })
    const session = mintSession({
      identityKey: KEY,
      derivationPrefix: 'ZGV2LXByZWZpeA==',
      derivationSuffix: 'ZGV2LXN1ZmZpeA==',
      supportsAwdl: false
    })
    act(() => result.current.openScanner())
    act(() => result.current.onScan(encodeSession(session)))
    expect(onNearbySession).toHaveBeenCalledWith(expect.objectContaining({ identityKey: KEY }))
    expect(result.current.target).toBeNull()
    expect(result.current.scannerVisible).toBe(false)
  })

  it('ignores junk and leaves the scanner open', () => {
    const { result } = draw()
    act(() => result.current.openScanner())
    act(() => result.current.onScan('hello world'))
    expect(result.current.target).toBeNull()
    expect(result.current.scannerVisible).toBe(true)
  })
})
```

- [ ] **Step 3: Run to verify failure**

Run: `npm test -- packages/expo-wallet-toolbox/__tests__/pay/useRecipientInput.test.ts`
Expected: FAIL — `useRecipientInput` not exported.

- [ ] **Step 4: Implement the hook**

Replace `ui/components/pay/useRecipientInput.ts` with:

```ts
/**
 * Recipient state for the universal send form.
 *
 * Typed text goes through classifyRecipientInput; a scanned code goes through
 * classifyScan. Both are pure and live in core/pay/rails. This hook only holds
 * the resulting state and the identity search that free text turns into.
 *
 * Grew out of useIdentitySearch (handle-only). The search machinery is the
 * same; what is new is that an address is a first-class outcome and a nearby
 * session is handed up to whoever mounted the form.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Keyboard } from 'react-native'
import { IdentityClient } from '@bsv/sdk'
import type { DisplayableIdentity } from '@bsv/sdk'
import { searchIdentities } from '../../resolveIdentity'
import {
  classifyRecipientInput,
  classifyScan,
  peerPayValidationMessage,
  type PayTarget,
  type Session
} from '@bsv/expo-wallet-toolbox'

export { peerPayValidationMessage }

/** Any throw from the overlay lookup is an outage, not “no such person”. */
export function classifyIdentitySearchError(_e: unknown): boolean {
  return true
}

export type RecipientTarget = Extract<PayTarget, { kind: 'handle' | 'address' }>
export type RecipientInlineError = 'invalid_bsv_address'

export interface UseRecipientInputOptions {
  wallet: unknown
  adminOriginator: string | undefined
  /** A recipient known before the form opened (deep link, scan on the way in). */
  initialTarget?: RecipientTarget
  /** A link or code named an amount too. */
  onPeerPayAmount?: (sats: number) => void
  /** A peerpay link that did not validate; the message is the validator's. */
  onPeerPayError?: (message: string) => void
  /** A nearby-session code was scanned: this form is the wrong surface for it. */
  onNearbySession?: (session: Session) => void
}

const SEARCH_DEBOUNCE_MS = 400

function textFor(target: RecipientTarget): string {
  return target.kind === 'handle' ? target.identityKey : target.address
}

export function useRecipientInput({
  wallet,
  adminOriginator,
  initialTarget,
  onPeerPayAmount,
  onPeerPayError,
  onNearbySession
}: UseRecipientInputOptions) {
  const identityClientRef = useRef<IdentityClient | null>(null)
  useEffect(() => {
    if (!wallet) return
    try {
      identityClientRef.current = new IdentityClient(wallet as never, undefined, adminOriginator)
    } catch {
      // Identity search is decorative; a client that will not build leaves the form usable.
    }
  }, [wallet, adminOriginator])

  const [inputText, setInputText] = useState(initialTarget ? textFor(initialTarget) : '')
  const [target, setTarget] = useState<RecipientTarget | null>(initialTarget ?? null)
  const [inlineError, setInlineError] = useState<RecipientInlineError | null>(null)
  const [selectedIdentity, setSelectedIdentity] = useState<DisplayableIdentity | null>(null)
  const [searchResults, setSearchResults] = useState<DisplayableIdentity[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [searchError, setSearchError] = useState(false)
  const [scannerVisible, setScannerVisible] = useState(false)
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const stopSearch = useCallback(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    searchTimerRef.current = null
    setSearchResults([])
    setIsSearching(false)
  }, [])

  const setDirectTarget = useCallback(
    (next: RecipientTarget) => {
      stopSearch()
      setInputText(textFor(next))
      setTarget(next)
      setSelectedIdentity(null)
      setSearchError(false)
      setInlineError(null)
    },
    [stopSearch]
  )

  useEffect(() => {
    if (initialTarget) setDirectTarget(initialTarget)
  }, [initialTarget, setDirectTarget])

  const onChangeText = useCallback(
    (text: string) => {
      setInputText(text)
      setSelectedIdentity(null)
      setTarget(null)
      setInlineError(null)
      setSearchError(false)
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current)

      const input = classifyRecipientInput(text)
      switch (input.kind) {
        case 'empty':
          stopSearch()
          return
        case 'address':
          stopSearch()
          setTarget({ kind: 'address', address: input.address })
          return
        case 'invalid_address':
          stopSearch()
          setInlineError('invalid_bsv_address')
          return
        case 'handle':
          stopSearch()
          setTarget({
            kind: 'handle',
            identityKey: input.identityKey,
            ...(input.messageBoxUrl ? { messageBoxUrl: input.messageBoxUrl } : {})
          })
          if (input.sats !== undefined) onPeerPayAmount?.(input.sats)
          return
        case 'invalid_link':
          stopSearch()
          onPeerPayError?.(input.message)
          return
        case 'search':
          setSearchResults([])
          setIsSearching(true)
          searchTimerRef.current = setTimeout(async () => {
            const client = identityClientRef.current
            if (!client) {
              setIsSearching(false)
              return
            }
            try {
              setSearchResults(await searchIdentities(client, input.query))
              setSearchError(false)
            } catch (error) {
              console.error('Identity search error:', error)
              if (classifyIdentitySearchError(error)) setSearchError(true)
              setSearchResults([])
            } finally {
              setIsSearching(false)
            }
          }, SEARCH_DEBOUNCE_MS)
          return
      }
    },
    [onPeerPayAmount, onPeerPayError, stopSearch]
  )

  const selectIdentity = useCallback(
    (identity: DisplayableIdentity) => {
      stopSearch()
      setSelectedIdentity(identity)
      setTarget({ kind: 'handle', identityKey: identity.identityKey })
      setInputText(identity.name || identity.abbreviatedKey)
      setSearchError(false)
      setInlineError(null)
      Keyboard.dismiss()
    },
    [stopSearch]
  )

  const clearRecipient = useCallback(() => {
    stopSearch()
    setSelectedIdentity(null)
    setTarget(null)
    setInputText('')
    setSearchError(false)
    setInlineError(null)
  }, [stopSearch])

  const clearSearchError = useCallback(() => setSearchError(false), [])
  const openScanner = useCallback(() => setScannerVisible(true), [])

  const onScan = useCallback(
    (data: string) => {
      const scanned = classifyScan(data)
      if (!scanned) return // QRScanner is in multiScan mode: it keeps looking.
      setScannerVisible(false)
      if (scanned.kind === 'nearby') {
        onNearbySession?.(scanned.session)
        return
      }
      if (scanned.kind === 'handle') {
        setDirectTarget({
          kind: 'handle',
          identityKey: scanned.identityKey,
          ...(scanned.messageBoxUrl ? { messageBoxUrl: scanned.messageBoxUrl } : {})
        })
        if (scanned.sats !== undefined) onPeerPayAmount?.(scanned.sats)
        return
      }
      setDirectTarget({ kind: 'address', address: scanned.address })
    },
    [onNearbySession, onPeerPayAmount, setDirectTarget]
  )

  return {
    inputText,
    target,
    inlineError,
    selectedIdentity,
    searchResults,
    isSearching,
    searchError,
    clearSearchError,
    onChangeText,
    selectIdentity,
    clearRecipient,
    scannerVisible,
    setScannerVisible,
    openScanner,
    onScan
  }
}
```

- [ ] **Step 5: Update the barrel**

In `ui/index.ts`, replace the block

```ts
export {
  peerPayValidationMessage,
  classifyIdentitySearchError,
  useIdentitySearch
} from './components/pay/useIdentitySearch'
```

with

```ts
export {
  peerPayValidationMessage,
  classifyIdentitySearchError,
  useRecipientInput,
  type RecipientTarget,
  type RecipientInlineError,
  type UseRecipientInputOptions
} from './components/pay/useRecipientInput'
```

`HandleSend.tsx` still imports `./useIdentitySearch` at this point and will fail to typecheck. That is expected: Task 7 deletes it. Do NOT run `npx tsc --noEmit` as a gate in this task; run only the test.

- [ ] **Step 6: Run the test**

Run: `npm test -- packages/expo-wallet-toolbox/__tests__/pay/useRecipientInput.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A packages/expo-wallet-toolbox/ui/components/pay/useIdentitySearch.ts packages/expo-wallet-toolbox/ui/components/pay/useRecipientInput.ts packages/expo-wallet-toolbox/__tests__/pay/useIdentitySearch.test.ts packages/expo-wallet-toolbox/__tests__/pay/useRecipientInput.test.ts packages/expo-wallet-toolbox/ui/index.ts
git commit -m "$(cat <<'EOF'
feat(pay): recipient hook that classifies text and scans into a rail

useIdentitySearch becomes useRecipientInput: same debounced identity
search for free text, plus address as a first-class outcome and a
nearby-session scan handed up to the mounting screen. HandleSend still
points at the old module until the next commit replaces it.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: `UniversalSend` — one send form; `RecipientField` status row; delete `HandleSend`/`AddressSend`

**Files:**
- Create: `ui/components/pay/UniversalSend.tsx` (start by copying `HandleSend.tsx`; the full target file is given below)
- Modify: `ui/components/pay/RecipientField.tsx`
- Delete: `ui/components/pay/HandleSend.tsx`, `ui/components/pay/AddressSend.tsx`
- Modify: `ui/index.ts` (exports), `ui/screens/PayScreen.tsx` (imports only — a temporary shim so tsc passes; Task 11 rewrites the screen)
- Test: `__tests__/ui/universalSend.test.tsx` (create)

**Interfaces:**
- Consumes: `useRecipientInput`, `RecipientTarget` (Task 6); `CONSEQUENCE_KEYS`, `sendToAddress`, `sendViaHandle(recipientHost)` (Task 3), `NO_MESSAGE_BOX`, `useMessageBoxConfig`.
- Produces:
  ```ts
  export interface UniversalSendProps {
    initialTarget?: Extract<RecipientTarget, { kind: 'handle' }>
    initialSats?: number
    initialNotice?: string | null
    openScannerOnMount?: boolean
    onNearbySession: (session: Session) => void
  }
  export default function UniversalSend(props: UniversalSendProps): JSX.Element
  ```
  `RecipientField` props become: `selectedIdentity, inputText, target, inlineError, isSearching, searchResults, colors, t, onChangeText, onSelectIdentity, onClear, onOpenScanner`.

- [ ] **Step 1: Write the failing render test**

Create `__tests__/ui/universalSend.test.tsx`:

```tsx
/**
 * The universal send form recomposes by what the recipient field resolved to.
 * These tests drive the field and check which questions the form then asks —
 * not the send itself, which the rail tests cover.
 */
jest.mock('expo-haptics', () => ({
  selectionAsync: jest.fn(() => Promise.resolve()),
  impactAsync: jest.fn(() => Promise.resolve()),
  notificationAsync: jest.fn(() => Promise.resolve()),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' }
}))
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }))
jest.mock('expo-local-authentication', () => require('../__mocks__/localAuthFake').fake)
jest.mock('expo-secure-store', () => require('../__mocks__/secureStoreFake').fake)
jest.mock('expo-status-bar', () => ({ StatusBar: 'StatusBar' }))
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children
}))
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => {} }
}))
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn(), dismissTo: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => ({}),
  useFocusEffect: () => {}
}))
jest.mock('../../ui/components/QRScanner', () => 'QRScanner')
jest.mock('../../ui/screens/WalletCheckScreen', () => ({ promptCheckWallet: jest.fn() }))
jest.mock('../../ui/components/pay/AvailableBalance', () => {
  const { Text } = require('react-native')
  return { __esModule: true, default: () => <Text testID="available-balance">balance</Text> }
})
jest.mock('../../ui/components/wallet/AmountInput', () => {
  const { TextInput } = require('react-native')
  return {
    __esModule: true,
    SEND_MAX_VALUE: '2099999999999999',
    AmountInput: ({ value, onChangeText }: { value: string; onChangeText: (v: string) => void }) => (
      <TextInput testID="amount-input" value={value} onChangeText={onChangeText} />
    )
  }
})
// wallet null: no IdentityClient, no PeerPay client, no outbox read. The form's
// composition does not depend on any of them.
jest.mock('@bsv/expo-wallet-toolbox', () => ({
  ...jest.requireActual('@bsv/expo-wallet-toolbox'),
  useWallet: () => ({ managers: null, adminOriginator: 'admin.com', storage: undefined })
}))

import React from 'react'
import { fireEvent, render, waitFor } from '@testing-library/react-native'
import { ThemeProvider } from '@bsv/expo-wallet-toolbox'
import UniversalSend from '../../ui/components/pay/UniversalSend'

const KEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const ADDRESS = '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2'
const BROKEN_ADDRESS = ADDRESS.slice(0, -1) + '3'

const draw = (props: Partial<React.ComponentProps<typeof UniversalSend>> = {}) =>
  render(
    <ThemeProvider>
      <UniversalSend onNearbySession={jest.fn()} {...props} />
    </ThemeProvider>
  )

describe('UniversalSend', () => {
  it('opens with the universal placeholder, an amount, and neither note nor consequence', () => {
    const s = draw()
    expect(s.getByPlaceholderText('recipient_placeholder')).toBeTruthy()
    expect(s.getByText('amount')).toBeTruthy()
    expect(s.queryByText('note')).toBeNull()
    expect(s.queryByText('pay_conseq_address')).toBeNull()
    expect(s.queryByText('pay_conseq_handle')).toBeNull()
  })

  it('an address: valid-address row, address consequence, no note field', async () => {
    const s = draw()
    fireEvent.changeText(s.getByPlaceholderText('recipient_placeholder'), ADDRESS)
    await waitFor(() => expect(s.getByText('valid_bsv_address')).toBeTruthy())
    expect(s.getByText('pay_conseq_address')).toBeTruthy()
    expect(s.queryByText('note')).toBeNull()
  })

  it('a key: valid-key row, note field, and no consequence callout', async () => {
    const s = draw()
    fireEvent.changeText(s.getByPlaceholderText('recipient_placeholder'), KEY)
    await waitFor(() => expect(s.getByText('valid_identity_key')).toBeTruthy())
    expect(s.getByText('note')).toBeTruthy()
    expect(s.queryByText('pay_conseq_address')).toBeNull()
    expect(s.queryByText('pay_conseq_handle')).toBeNull()
  })

  it('a checksum-broken address: inline error, nothing else', async () => {
    const s = draw()
    fireEvent.changeText(s.getByPlaceholderText('recipient_placeholder'), BROKEN_ADDRESS)
    await waitFor(() => expect(s.getByText('invalid_bsv_address')).toBeTruthy())
    expect(s.queryByText('valid_bsv_address')).toBeNull()
    expect(s.queryByText('pay_conseq_address')).toBeNull()
  })

  it('prefills from an initial handle target and amount', () => {
    const s = draw({ initialTarget: { kind: 'handle', identityKey: KEY }, initialSats: 1500 })
    expect(s.getByText('valid_identity_key')).toBeTruthy()
    expect(s.getByTestId('amount-input').props.value).toBe('1500')
  })

  it('shows an initial notice as a banner', () => {
    const s = draw({ initialNotice: 'PeerPay link contains an invalid identity key' })
    expect(s.getByText('PeerPay link contains an invalid identity key')).toBeTruthy()
  })

  it('never shows the message-box server bar', () => {
    const s = draw()
    expect(s.queryByLabelText('message_box_server')).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- packages/expo-wallet-toolbox/__tests__/ui/universalSend.test.tsx`
Expected: FAIL — module `UniversalSend` not found.

- [ ] **Step 3: Rewrite `RecipientField`**

Replace the props interface and the component body of `ui/components/pay/RecipientField.tsx` (keep the file header, the `loadIonicons` helper, and the `styles` block, adding one style). New header comment, props and component:

```tsx
/**
 * The universal recipient field: one input that takes a handle, a public key,
 * an address or a peerpay link, plus the QR button that scans the same set. It
 * shows the search dropdown for free text, a status row for a resolved target
 * or a checksum failure, and collapses to an identity card once a search hit
 * is chosen. What the text MEANS is decided in core/pay/rails and held by
 * useRecipientInput; this file only renders that state.
 */
```

```tsx
interface RecipientFieldProps {
  readonly selectedIdentity: DisplayableIdentity | null
  readonly inputText: string
  readonly target: RecipientTarget | null
  readonly inlineError: RecipientInlineError | null
  readonly isSearching: boolean
  readonly searchResults: DisplayableIdentity[]
  readonly colors: ReturnType<typeof import('@bsv/expo-wallet-toolbox').useTheme>['colors']
  readonly t: ReturnType<typeof import('react-i18next').useTranslation>['t']
  readonly onChangeText: (v: string) => void
  readonly onSelectIdentity: (i: DisplayableIdentity) => void
  readonly onClear: () => void
  readonly onOpenScanner: () => void
}

export default function RecipientField({
  selectedIdentity,
  inputText,
  target,
  inlineError,
  isSearching,
  searchResults,
  colors,
  t,
  onChangeText,
  onSelectIdentity,
  onClear,
  onOpenScanner
}: RecipientFieldProps) {
  const Ionicons = loadIonicons()
  const reducedMotion = useReducedMotion()
  if (selectedIdentity) {
    /* … the existing selected-identity card, unchanged … */
  }
  const showDropdown = (isSearching || searchResults.length > 0) && !target && !inlineError
  const borderColor = inlineError ? colors.error : target ? colors.success : colors.separator
  const borderWidth = inlineError || target ? 1 : StyleSheet.hairlineWidth
  return (
    <>
      <View style={[styles.inputRow, { backgroundColor: colors.backgroundSecondary, borderColor, borderWidth }]}>
        <TextInput
          value={inputText}
          onChangeText={onChangeText}
          placeholder={t('recipient_placeholder')}
          placeholderTextColor={colors.textTertiary}
          autoCapitalize="none"
          autoCorrect={false}
          style={[styles.recipientInput, { color: colors.textPrimary }]}
        />
        <TouchableOpacity onPress={onOpenScanner} style={styles.inputAction} accessibilityLabel={t('scan_qr_code')}>
          <Ionicons name="qr-code-outline" size={20} color={colors.accent} />
        </TouchableOpacity>
      </View>
      {inlineError ? (
        <View style={styles.statusRow}>
          <Ionicons name="close-circle-outline" size={14} color={colors.error} />
          <Text style={[styles.statusText, { color: colors.error }]}>{t(inlineError)}</Text>
        </View>
      ) : target?.kind === 'handle' ? (
        <View style={styles.statusRow}>
          <Ionicons name="key-outline" size={14} color={colors.success} />
          <Text style={[styles.statusText, { color: colors.success }]}>{t('valid_identity_key')}</Text>
        </View>
      ) : target?.kind === 'address' ? (
        <View style={styles.statusRow}>
          <Ionicons name="wallet-outline" size={14} color={colors.success} />
          <Text style={[styles.statusText, { color: colors.success }]}>{t('valid_bsv_address')}</Text>
        </View>
      ) : null}
      {showDropdown && (
        /* … the existing dropdown block, unchanged … */
      )}
    </>
  )
}
```

Where the plan says "unchanged", keep the existing JSX exactly. Rename styles `directKeyRow` → `statusRow` and `directKeyText` → `statusText` (same values). Add `import type { RecipientInlineError, RecipientTarget } from './useRecipientInput'`.

- [ ] **Step 4: Create `UniversalSend.tsx`**

`git mv packages/expo-wallet-toolbox/ui/components/pay/HandleSend.tsx packages/expo-wallet-toolbox/ui/components/pay/UniversalSend.tsx`, then edit it into the following. Keep the three lazy-load helpers (`loadStatusBar`, `loadExpoRouter`) and the `OutgoingSection` component and the `styles` block exactly as they are in `HandleSend`; everything else below replaces the old header, imports, props and component body.

Header and imports:

```tsx
/**
 * Pay → anyone.
 *
 * One recipient field decides the rail: a base58check address goes out as a
 * plain P2PKH payment; an identity key, peerpay link or search hit goes out as
 * a PeerPay token dropped in the recipient's message box; a nearby-session
 * code is handed up to the Pay screen, which swaps this form for NearbyFlow.
 * Nothing here is chosen by the user except the recipient and the amount.
 *
 * The form recomposes by what the field resolved to: a note field exists
 * only for handles (an address has nowhere to carry one), and the "they are
 * not notified" consequence is shown only for addresses, where it is
 * load-bearing — a user who pastes an address expecting messaging-style
 * delivery has effectively posted cash.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, Modal, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { useTranslation } from 'react-i18next'

import QRScanner from '../QRScanner'
import AmountDisplay from '../wallet/AmountDisplay'
import { showAlert } from '../ui/AlertCard'
import { showChoiceSheet } from '../ui/ChoiceSheet'
import { promptCheckWallet } from '../../screens/WalletCheckScreen'
import { userFacingPayError } from '../../../core/pay/userError'
import PressableScale from '../ui/PressableScale'
import { showToast } from '../ui/Toast'
import { ConsequenceNote, PayAmountField, PayCta, PayField } from './PayForm'
import PaymentSuccessOverlay from './PaymentSuccessOverlay'
import ResultBanner from './ResultBanner'
import RecipientField from './RecipientField'
import { useMessageBoxConfig } from './MessageBoxConfig'
import { useRecipientInput, type RecipientTarget } from './useRecipientInput'
import {
  useTheme,
  spacing,
  typography,
  radii,
  hitTargets,
  useWallet,
  CONSEQUENCE_KEYS,
  NO_MESSAGE_BOX,
  cancelOutboxPayment,
  isMessageBoxNetworkError,
  makePeerPayClient,
  retryDelivery,
  sendViaHandle,
  sendToAddress,
  getOutboxEntries,
  pruneExpiredSent,
  unsentEntries,
  type OutboxEntry,
  type Session,
  haptics,
  listPendingResendRequests
} from '@bsv/expo-wallet-toolbox'
```

Props and component (replace `HandleSendProps` and `export default function HandleSend…` through the end of its `return`):

```tsx
export interface UniversalSendProps {
  /** A recipient known before the form opened: a peerpay deep link or `?identityKey=`. */
  initialTarget?: Extract<RecipientTarget, { kind: 'handle' }>
  /** Prefilled amount in satoshis from a peerpay link or `?sats=`. */
  initialSats?: number
  /** Error text from a malformed peerpay link, shown as a banner. */
  initialNotice?: string | null
  /** Open the scanner as soon as the form mounts (deep link `cell=pay-nearby`). */
  openScannerOnMount?: boolean
  /** A nearby-session code was scanned. The Pay screen swaps this form for NearbyFlow. */
  onNearbySession: (session: Session) => void
}

export default function UniversalSend({
  initialTarget,
  initialSats,
  initialNotice,
  openScannerOnMount = false,
  onNearbySession
}: UniversalSendProps) {
  const { t } = useTranslation()
  const { colors } = useTheme()
  const StatusBar = loadStatusBar()
  const { managers, adminOriginator, storage } = useWallet()
  const wallet = managers?.permissionsManager || null

  // Read-only here: the server is configured in Settings › Advanced.
  const { messageBoxUrl } = useMessageBoxConfig(t)
  const isConfigured = !!messageBoxUrl && messageBoxUrl !== NO_MESSAGE_BOX

  const [sendAmount, setSendAmount] = useState(initialSats && initialSats > 0 ? String(initialSats) : '')
  const [note, setNote] = useState('')
  const [notice, setNotice] = useState<{ type: 'error'; message: string } | null>(
    initialNotice ? { type: 'error', message: initialNotice } : null
  )
  const [isSending, setIsSending] = useState(false)
  const [sendResult, setSendResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null)
  /** The success moment, held until acknowledged — same screen as every rail. */
  const [sent, setSent] = useState<{ amount: number; recipient?: string } | null>(null)
  const [outbox, setOutbox] = useState<OutboxEntry[]>([])
  const [retryingId, setRetryingId] = useState<string | null>(null)

  const onPeerPayAmount = useCallback((sats: number) => setSendAmount(String(sats)), [])
  const onPeerPayError = useCallback((message: string) => setNotice({ type: 'error', message }), [])
  const recipient = useRecipientInput({
    wallet,
    adminOriginator,
    initialTarget,
    onPeerPayAmount,
    onPeerPayError,
    onNearbySession
  })
  const target = recipient.target

  useEffect(() => {
    if (openScannerOnMount) recipient.openScanner()
    // Mount-only by design: re-opening on every render would trap the user in the camera.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const peerPayClient = useMemo(
    () => makePeerPayClient({ wallet: wallet as never, messageBoxUrl, originator: adminOriginator }),
    [messageBoxUrl, wallet, adminOriginator]
  )

  const loadOutbox = useCallback(async () => {
    if (!storage) return
    await pruneExpiredSent(storage)
    setOutbox(unsentEntries(await getOutboxEntries(storage)))
  }, [storage])

  useEffect(() => {
    void loadOutbox()
  }, [loadOutbox])

  const pollResendRequests = useCallback(async () => {
    const client = peerPayClient
    if (!client || !storage) return
    try {
      await listPendingResendRequests({ client, storage })
    } catch {
      // Home owns the unanswered-resend banner; a failed poll here is retryable.
    }
  }, [peerPayClient, storage])

  useEffect(() => {
    void pollResendRequests()
  }, [pollResendRequests])

  const flashResult = useCallback((result: { type: 'success' | 'error'; message: string }) => {
    setSendResult(result)
    setTimeout(() => setSendResult(null), 5000)
  }, [])

  const handleWalletCheck = useCallback(
    async (error: unknown): Promise<boolean> => {
      if (!userFacingPayError(error).offerWalletCheck) return false
      const choice = await promptCheckWallet(t)
      if (choice === 'check_wallet') loadExpoRouter().router.push('/wallet-check' as any)
      return true
    },
    [t]
  )

  const sendHandle = useCallback(
    async (to: Extract<RecipientTarget, { kind: 'handle' }>, sats: number) => {
      const client = peerPayClient
      if (!client || !storage || !wallet) return
      const { satoshis: paidSats } = await sendViaHandle({
        wallet: wallet as any,
        adminOriginator,
        client,
        storage,
        recipient: to.identityKey,
        recipientHost: to.messageBoxUrl,
        satoshis: sats,
        messageBoxUrl,
        note,
        recipientName: recipient.selectedIdentity?.name
      })
      await loadOutbox()
      // Only a human-readable name goes on the success screen — a raw key is noise there.
      setSent({ amount: paidSats, recipient: recipient.selectedIdentity?.name })
    },
    [peerPayClient, storage, wallet, adminOriginator, messageBoxUrl, note, recipient.selectedIdentity, loadOutbox]
  )

  const sendAddress = useCallback(
    async (to: Extract<RecipientTarget, { kind: 'address' }>, sats: number) => {
      if (!wallet) return
      const { paidSatoshis } = await sendToAddress({ wallet: wallet as any, adminOriginator, address: to.address, satoshis: sats })
      setSent({ amount: paidSatoshis, recipient: to.address })
    },
    [wallet, adminOriginator]
  )

  const handleSend = useCallback(async () => {
    if (!target) return
    const sats = Math.round(Number(sendAmount))
    if (!Number.isFinite(sats) || sats <= 0) {
      flashResult({ type: 'error', message: t('enter_valid_amount') })
      return
    }
    haptics.confirm()
    setIsSending(true)
    try {
      if (target.kind === 'handle') await sendHandle(target, sats)
      else await sendAddress(target, sats)
      setSendAmount('')
      setNote('')
      recipient.clearRecipient()
    } catch (error: any) {
      if (await handleWalletCheck(error)) return
      const message =
        error instanceof RangeError
          ? t('enter_valid_amount')
          : isMessageBoxNetworkError(error)
            ? t('message_box_unreachable')
            : error?.message || t('unknown_error')
      flashResult({ type: 'error', message })
      // A failed handle send leaves its entry 'unsent' and offered for retry below.
      if (target.kind === 'handle') await loadOutbox()
    } finally {
      setIsSending(false)
    }
  }, [target, sendAmount, sendHandle, sendAddress, recipient, handleWalletCheck, flashResult, loadOutbox, t])

  const handleRetry = useCallback(
    async (entry: OutboxEntry) => {
      const client =
        peerPayClient ??
        makePeerPayClient({ wallet: wallet as never, messageBoxUrl: entry.messageBoxUrl, originator: adminOriginator })
      if (!client || !storage) {
        showToast(t('message_box_off_hint'), { type: 'error' })
        return
      }
      setRetryingId(entry.id)
      try {
        await retryDelivery({ wallet: wallet as any, adminOriginator, client, storage, entry })
        setSent({ amount: entry.token.amount })
      } catch (e: any) {
        if (await handleWalletCheck(e)) return
        const reason = isMessageBoxNetworkError(e) ? t('message_box_unreachable') : e?.message || t('unknown_error')
        showToast(`${t('retry_failed')}: ${reason}`, { type: 'error' })
      } finally {
        setRetryingId(null)
        await loadOutbox()
      }
    },
    [peerPayClient, storage, loadOutbox, wallet, adminOriginator, t, handleWalletCheck]
  )

  const handleCancel = useCallback(
    async (entry: OutboxEntry) => {
      if (!storage || !wallet) return
      const deliveredOrUncertain = entry.delivered === true || entry.delivering === true
      if (deliveredOrUncertain) {
        const key = await showChoiceSheet({
          title: t('cancel_this_payment'),
          options: [
            { key: 'abandon', label: t('abandon_payment'), destructive: true },
            { key: 'finish', label: t('finish_payment') }
          ],
          cancelLabel: t('cancel')
        })
        if (key === 'finish') {
          await handleRetry(entry)
          return
        }
        if (key !== 'abandon') return
        const client = peerPayClient
        if (!client) {
          showToast(t('message_box_off_hint'), { type: 'error' })
          return
        }
        setRetryingId(entry.id)
        try {
          await cancelOutboxPayment({ wallet: wallet as any, adminOriginator, storage, entry, client, mode: 'abandon' })
        } catch (e: any) {
          const reason = isMessageBoxNetworkError(e) ? t('message_box_unreachable') : e?.message || t('unknown_error')
          showToast(reason, { type: 'error' })
        } finally {
          setRetryingId(null)
          await loadOutbox()
        }
        return
      }
      const choice = await showAlert({
        title: t('cancel_this_payment'),
        buttons: [
          { text: t('cancel'), style: 'cancel', key: 'cancel' },
          { text: t('cancel_payment'), style: 'destructive', key: 'cancel_payment' }
        ]
      })
      if (choice !== 'cancel_payment') return
      setRetryingId(entry.id)
      try {
        await cancelOutboxPayment({ wallet: wallet as any, adminOriginator, storage, entry, mode: 'undelivered' })
      } catch (e: any) {
        showToast(e?.message || t('unknown_error'), { type: 'error' })
      } finally {
        setRetryingId(null)
        await loadOutbox()
      }
    },
    [storage, wallet, adminOriginator, peerPayClient, handleRetry, loadOutbox, t]
  )

  const amountOk = Number(sendAmount) > 0
  const isHandle = target?.kind === 'handle'
  const isAddress = target?.kind === 'address'
  // A stuck handle payment blocks new HANDLE sends: every attempt while the box
  // is unreachable would mint another noSend action and another stuck entry.
  // Address sends never touch the box, so they are not held hostage by it.
  const handleBlockedByOutbox = isHandle && outbox.length > 0
  const handleFormValid = isHandle && amountOk && !isSending && isConfigured
  const canSend = isAddress ? amountOk && !isSending : handleFormValid && !handleBlockedByOutbox

  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {notice && <ResultBanner result={notice} onDismiss={() => setNotice(null)} colors={colors} />}
      {recipient.searchError && (
        <ResultBanner
          result={{ type: 'error', message: t('identity_search_unavailable') }}
          onDismiss={recipient.clearSearchError}
          colors={colors}
        />
      )}

      <PayField labelKey="recipient">
        <RecipientField
          selectedIdentity={recipient.selectedIdentity}
          inputText={recipient.inputText}
          target={recipient.target}
          inlineError={recipient.inlineError}
          isSearching={recipient.isSearching}
          searchResults={recipient.searchResults}
          colors={colors}
          t={t}
          onChangeText={recipient.onChangeText}
          onSelectIdentity={recipient.selectIdentity}
          onClear={recipient.clearRecipient}
          onOpenScanner={recipient.openScanner}
        />
      </PayField>

      <PayAmountField value={sendAmount} onChangeText={setSendAmount} />

      {isHandle && (
        <PayField labelKey="note">
          <TextInput
            value={note}
            onChangeText={setNote}
            placeholder={t('note_placeholder')}
            placeholderTextColor={colors.textQuaternary}
            maxLength={280}
            style={[
              styles.noteInput,
              { backgroundColor: colors.backgroundSecondary, borderColor: colors.separator, color: colors.textPrimary }
            ]}
          />
        </PayField>
      )}

      {/* Load-bearing for an address: this rail cannot notify the payee. Nothing for a handle. */}
      {isAddress && <ConsequenceNote textKey={CONSEQUENCE_KEYS.address} />}

      {isHandle && !isConfigured && (
        <Text style={[styles.consequence, { color: colors.textSecondary }]}>{t('message_box_off_hint')}</Text>
      )}
      {handleFormValid && handleBlockedByOutbox && (
        <Text style={[styles.consequence, { color: colors.textSecondary }]}>{t('finish_or_cancel_outgoing')}</Text>
      )}

      <PayCta onPress={handleSend} disabled={!canSend} busy={isSending} />

      {sendResult && <ResultBanner result={sendResult} onDismiss={() => setSendResult(null)} colors={colors} />}

      {outbox.length > 0 && (
        <OutgoingSection
          entries={outbox}
          retryingId={retryingId}
          colors={colors}
          t={t}
          onRetry={handleRetry}
          onCancel={handleCancel}
        />
      )}

      <Modal
        visible={recipient.scannerVisible}
        animationType="slide"
        onRequestClose={() => recipient.setScannerVisible(false)}
        statusBarTranslucent
      >
        <StatusBar style="light" />
        <QRScanner
          multiScan
          onScan={recipient.onScan}
          onClose={() => recipient.setScannerVisible(false)}
          hintText={t('scan_recipient_hint')}
        />
      </Modal>

      {sent && (
        <PaymentSuccessOverlay
          direction="sent"
          amount={sent.amount}
          recipientName={sent.recipient}
          onDismiss={() => setSent(null)}
        />
      )}
    </ScrollView>
  )
}
```

- [ ] **Step 5: Delete `AddressSend`, fix the barrel, shim `PayScreen`**

```bash
git rm -q packages/expo-wallet-toolbox/ui/components/pay/AddressSend.tsx
```

In `ui/index.ts`: delete the `AddressSend` export line; replace the `HandleSend` line with `export { default as UniversalSend, type UniversalSendProps } from './components/pay/UniversalSend'`; change the `MessageBoxConfig` line to `export { useMessageBoxConfig, MessageBoxBar, ConfigPanel } from './components/pay/MessageBoxConfig'` (unchanged for now — `MessageBoxBar` goes in Task 12). Update the comment on line 48 to name `UniversalSend/NearbyFlow`.

In `ui/screens/PayScreen.tsx` (temporary, so tsc passes until Task 11): replace `import HandleSend from '../components/pay/HandleSend'` and `import AddressSend from '../components/pay/AddressSend'` with `import UniversalSend from '../components/pay/UniversalSend'`; replace the `case 'pay-handle':` return with

```tsx
        return (
          <UniversalSend
            initialTarget={initialIdentityKey ? { kind: 'handle', identityKey: initialIdentityKey } : undefined}
            initialSats={initialSats}
            initialNotice={peerPayNotice}
            onNearbySession={() => setCell('pay-nearby')}
          />
        )
```

and the `case 'pay-address':` return with `return <UniversalSend onNearbySession={() => setCell('pay-nearby')} />`. In `__tests__/ui/payScreen.test.tsx`, change the two mock lines `jest.mock('../../ui/components/pay/HandleSend', () => 'HandleSend')` / `AddressSend` to a single `jest.mock('../../ui/components/pay/UniversalSend', () => 'UniversalSend')`, and in the two tests that look up `'HandleSend'` by type, look up `'UniversalSend'` instead and assert `cell.props.initialTarget.identityKey` is `KEY`. (Task 11 rewrites this test file properly; this keeps it green meanwhile.)

- [ ] **Step 6: Run tests and typecheck**

Run: `npx tsc --noEmit && npm test -- packages/expo-wallet-toolbox/__tests__/ui/universalSend.test.tsx packages/expo-wallet-toolbox/__tests__/ui/payScreen.test.tsx packages/expo-wallet-toolbox/__tests__/pay/useRecipientInput.test.ts`
Expected: tsc clean; PASS.

If tsc reports `HandleReceive.tsx` importing `MessageBoxBar` — it still exists, so it should not. If it reports the old `RecipientField` props anywhere, that file is only used by `UniversalSend`.

- [ ] **Step 7: Commit**

```bash
git add -A packages/expo-wallet-toolbox/ui packages/expo-wallet-toolbox/__tests__/ui
git commit -m "$(cat <<'EOF'
feat(pay): one send form that infers the rail from the recipient

UniversalSend replaces HandleSend and AddressSend. The recipient field
takes a handle, key, address or peerpay link; the form then asks only
the questions that rail needs — a note for handles, the "not notified"
consequence for addresses — and dispatches to the matching send. The
message-box bar leaves the form; configuration lives in Settings.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: `NearbyFlow` — `initialSession` (payer) and `initialRequest` (payee)

No unit test is feasible for this 2,300-line native-bound component; the gate is `npx tsc --noEmit` plus the existing localpay suite. Every edit below is mechanical.

**Files:**
- Modify: `ui/components/pay/NearbyFlow.tsx` (props ~392-399; mount effect ~634-643; `reset` ~661-690; `startRequest` ~1034-1100; `onSessionScanned` ~1151-1171; `receive_amount` view ~1859-1881)
- Modify: `core/i18n/translations.tsx` — remove `local_pay_amount_optional_hint` from all twelve locales

**Interfaces:**
- Produces:
  ```ts
  export interface NearbyFlowProps {
    role: 'payer' | 'payee'
    onExit: () => void
    /** Payer only: a session the Pay screen already scanned. Skips the scanner, lands on confirm. */
    initialSession?: Session
    /** Payee only: mint immediately for this amount (undefined = open request). Skips receive_amount. */
    initialRequest?: { sats?: number }
  }
  ```

- [ ] **Step 1: Props**

Replace `NearbyFlowProps` with the interface above (keep the existing doc comments on `role` and `onExit`). Change the signature to `export default function NearbyFlow({ role: initialRole, onExit, initialSession, initialRequest }: NearbyFlowProps)`.

- [ ] **Step 2: `startRequest` takes the amount**

Change `const startRequest = useCallback(async () => {` to `const startRequest = useCallback(async (requested?: number) => {`. Replace the two lines

```ts
    const requested = satsFrom(requestAmount)
    const sats = requested > 0 ? requested : undefined
```

with

```ts
    const sats = requested !== undefined && Number.isFinite(requested) && requested > 0 ? Math.round(requested) : undefined
```

and remove `requestAmount` from the dependency array. In the `receive_amount` view, change the Continue button to `onPress={() => void startRequest(satsFrom(requestAmount) || undefined)}`. Delete the line `{supportText(t('local_pay_amount_optional_hint'))}` and change the comment above `PayAmountField` to end with: `Zero or blank is a real choice — payer decides — and the design says so by not gating on it.`

- [ ] **Step 3: Split `onSessionScanned`**

Replace the `onSessionScanned` callback with:

```ts
  /** The state moves that follow a valid session, whether scanned here or handed in. */
  const adoptSession = useCallback((session: Session) => {
    setScannedSession(session)
    // Prompt-free read of this device's Bluetooth state for describeFloor.
    // Never prepare() here: a payer who lands on QR must never be prompted.
    setBleState(readBluetoothState())
    // Who is being paid. Best-effort lookup for the presence row and the
    // recipient card; nothing waits on it.
    setPeerKey(session.identityKey)
    setSendAmount('')
    setRole('payer')
    setPhase('send_confirm')
  }, [])

  const onSessionScanned = useCallback(
    (data: string) => {
      if (scanLatchRef.current) return
      scanLatchRef.current = true
      let session: Session
      try {
        session = decodeSession(data)
      } catch {
        fail('generic', t('invalid_qr_code'))
        return
      }
      adoptSession(session)
    },
    [adoptSession, fail, t]
  )
```

- [ ] **Step 4: Move and extend the mount effect**

Delete the `enteredRef` block at ~634-643 (the one commented "The grid already asked which side the user is on…"). Immediately after `onSessionScanned` (from Step 3), add:

```ts
  // One entry per mount. A payee with a pre-set request mints at once; a payer
  // with a pre-scanned session lands on confirm. Without either, the old
  // behaviour: payee names an amount, payer raises the camera. Declared here,
  // below startRequest and adoptSession, because a dependency array is read at
  // render time and both are `const`s — referencing them from above would TDZ.
  const enteredRef = useRef(false)
  useEffect(() => {
    if (enteredRef.current) return
    enteredRef.current = true
    if (initialRole === 'payee') {
      if (initialRequest) void startRequest(initialRequest.sats)
      else setPhase('receive_amount')
    } else if (initialSession) {
      adoptSession(initialSession)
    } else {
      openScanner('send_scan')
    }
  }, [initialRole, initialRequest, initialSession, openScanner, startRequest, adoptSession])
```

- [ ] **Step 5: `reset` leaves when the entry was pre-set**

At the top of `reset`'s body (before `abortAll()`), add:

```ts
    // A mount whose amount or session came from outside has no phase to go
    // back to — the hub or the send form owns that state. Leaving is the reset.
    if (initialRequest || initialSession) {
      abortAll()
      onExit()
      return
    }
```

Add `initialRequest`, `initialSession`, `onExit` to `reset`'s dependency array.

- [ ] **Step 6: Remove the retired copy**

In `core/i18n/translations.tsx`, delete the `local_pay_amount_optional_hint:` line from all twelve locales (`en` line 707; grep the key for the others).

- [ ] **Step 7: Verify**

Run:
```bash
grep -c "local_pay_amount_optional_hint" packages/expo-wallet-toolbox/core/i18n/translations.tsx packages/expo-wallet-toolbox/ui/components/pay/NearbyFlow.tsx
npx tsc --noEmit && npm test -- packages/expo-wallet-toolbox/__tests__/localpay
```
Expected: `0` and `0`; tsc clean; PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/expo-wallet-toolbox/ui/components/pay/NearbyFlow.tsx packages/expo-wallet-toolbox/core/i18n/translations.tsx
git commit -m "$(cat <<'EOF'
feat(nearby): accept a pre-scanned session or a pre-set request amount

The Pay screen now scans on the payer's behalf and the request hub
names the amount on the payee's, so NearbyFlow can land directly on
confirm or on the pairing QR. Both entry phases stay for the no-prop
path. The "leave it at zero" hint is gone: the design says it.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: `HandleReceive` and `AddressReceive` carry the requested amount; config bar leaves `HandleReceive`

**Files:**
- Modify: `ui/components/pay/HandleReceive.tsx` (import line 21; signature ~370; `link` ~436; the `MessageBoxBar`/`ConfigPanel` block ~680-698; QR ~703; styles ~811)
- Modify: `ui/components/pay/AddressReceive.tsx` (signature; QR block ~303-310; styles ~443)

**Interfaces:**
- Produces: `HandleReceive({ initialSats }: { initialSats?: number })`, `AddressReceive({ initialSats }: { initialSats?: number })`.
- Consumes: `peerPayLinkFor(identityKey, sats?, messageBoxUrl?)` (Task 3).

- [ ] **Step 1: `HandleReceive`**

(a) Change the import to `import { useMessageBoxConfig } from './MessageBoxConfig'`.
(b) Signature: `export default function HandleReceive({ initialSats }: { initialSats?: number } = {})`.
(c) Replace `const link = identityKey ? peerPayLinkFor(identityKey) : ''` with

```ts
  // BRC-125 with this app's url extension: the payer learns where to deliver
  // without an overlay lookup. Omitted when no server is configured, since
  // there is then nowhere to point them.
  const link = identityKey ? peerPayLinkFor(identityKey, initialSats, isConfigured ? messageBoxUrl : undefined) : ''
```

(d) Delete the `<MessageBoxBar …/>` element, the `{config.showConfig && (<ConfigPanel …/>)}` block and the comment above them. Replace `const config = useMessageBoxConfig(t)` / `const { messageBoxUrl } = config` with `const { messageBoxUrl } = useMessageBoxConfig(t)`.
(e) Replace `<QRCode value={identityKey} …/>` with `<QRCode value={link} size={240} color="#000" backgroundColor="#fff" />`.
(f) Directly above `<View style={styles.qrHero}>`, insert:

```tsx
      {/* The figure the code asks for, as its price. Only when one was named. */}
      {initialSats !== undefined && initialSats > 0 && (
        <Text style={[styles.requestedAmount, { color: colors.textPrimary }]}>
          <AmountDisplay>{initialSats}</AmountDisplay>
        </Text>
      )}
```

(g) Add to `styles`: `requestedAmount: { ...typography.title2, textAlign: 'center', marginBottom: spacing.lg }`.
(h) Update the file's header comment where it says the QR is the bare key: it is now the peerpay link.

- [ ] **Step 2: `AddressReceive`**

(a) Signature: `export default function AddressReceive({ initialSats }: { initialSats?: number } = {})`.
(b) Directly above `<View style={styles.qrHero}>` (inside the `<>` fragment), insert the same `requestedAmount` block as above. The QR stays `value={address}` — an address code is a bare address whatever was asked for.
(c) Add to `styles`: `requestedAmount: { ...typography.title2, textAlign: 'center', marginBottom: spacing.lg }`.

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit && npm test -- packages/expo-wallet-toolbox/__tests__/pay/handleInbox.test.ts packages/expo-wallet-toolbox/__tests__/pay/addressRail.test.ts`
Expected: tsc clean; PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/expo-wallet-toolbox/ui/components/pay/HandleReceive.tsx packages/expo-wallet-toolbox/ui/components/pay/AddressReceive.tsx
git commit -m "$(cat <<'EOF'
feat(receive): show the requested figure, encode the remote link as BRC-125

The remote code and share link carry sats and the payee's message-box
host so the payer needs no lookup. The address code stays a bare
address — every wallet reads that — with the figure shown above it.
The message-box bar leaves the receive screen for Settings.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: `RequestHub` — amount first, then three method rows

**Files:**
- Create: `ui/components/pay/RequestHub.tsx`
- Test: `__tests__/ui/requestHub.test.tsx` (create)
- Modify: `ui/index.ts` (add export)

**Interfaces:**
- Produces:
  ```ts
  export type RequestMethod = 'get-nearby' | 'get-handle' | 'get-address'
  export interface RequestHubProps {
    requestSats: string
    onChangeRequestSats: (v: string) => void
    onPick: (method: RequestMethod) => void
    online: boolean
  }
  export default function RequestHub(props: RequestHubProps): JSX.Element
  /** Satoshis from the hub's raw field, or undefined for an open request. */
  export function requestSatsFrom(text: string): number | undefined
  ```

- [ ] **Step 1: Write the failing test**

Create `__tests__/ui/requestHub.test.tsx`:

```tsx
jest.mock('expo-haptics', () => ({
  selectionAsync: jest.fn(() => Promise.resolve()),
  impactAsync: jest.fn(() => Promise.resolve()),
  notificationAsync: jest.fn(() => Promise.resolve()),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' }
}))
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }))
jest.mock('expo-local-authentication', () => require('../__mocks__/localAuthFake').fake)
jest.mock('expo-secure-store', () => require('../__mocks__/secureStoreFake').fake)
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => {} }
}))
jest.mock('../../ui/components/pay/AvailableBalance', () => {
  const { Text } = require('react-native')
  return { __esModule: true, default: () => <Text testID="available-balance">balance</Text> }
})
jest.mock('../../ui/components/wallet/AmountInput', () => {
  const { TextInput } = require('react-native')
  return {
    __esModule: true,
    SEND_MAX_VALUE: '2099999999999999',
    AmountInput: ({ value, onChangeText }: { value: string; onChangeText: (v: string) => void }) => (
      <TextInput testID="amount-input" value={value} onChangeText={onChangeText} />
    )
  }
})

import React from 'react'
import { fireEvent, render } from '@testing-library/react-native'
import { ThemeProvider } from '@bsv/expo-wallet-toolbox'
import RequestHub, { requestSatsFrom } from '../../ui/components/pay/RequestHub'

const draw = (props: Partial<React.ComponentProps<typeof RequestHub>> = {}) =>
  render(
    <ThemeProvider>
      <RequestHub requestSats="" onChangeRequestSats={jest.fn()} onPick={jest.fn()} online {...props} />
    </ThemeProvider>
  )

describe('RequestHub', () => {
  it('asks for an amount with no balance line, then lists three methods under a Method label', () => {
    const s = draw()
    expect(s.getByText('amount')).toBeTruthy()
    expect(s.queryByTestId('available-balance')).toBeNull()
    expect(s.getByText('pay_method')).toBeTruthy()
    expect(s.getByText('pay_method_nearby')).toBeTruthy()
    expect(s.getByText('pay_method_remote_link')).toBeTruthy()
    expect(s.getByText('pay_method_address')).toBeTruthy()
  })

  it('does not show the retired "leave it at zero" hint', () => {
    expect(draw().queryByText('local_pay_amount_optional_hint')).toBeNull()
  })

  it('passes amount edits up and reports the picked method', () => {
    const onChangeRequestSats = jest.fn()
    const onPick = jest.fn()
    const s = draw({ onChangeRequestSats, onPick })
    fireEvent.changeText(s.getByTestId('amount-input'), '2500')
    expect(onChangeRequestSats).toHaveBeenCalledWith('2500')
    fireEvent.press(s.getByText('pay_method_remote_link'))
    expect(onPick).toHaveBeenCalledWith('get-handle')
    fireEvent.press(s.getByText('pay_method_nearby'))
    expect(onPick).toHaveBeenCalledWith('get-nearby')
    fireEvent.press(s.getByText('pay_method_address'))
    expect(onPick).toHaveBeenCalledWith('get-address')
  })

  it('disables remote link and address offline, leaving nearby alone', () => {
    const s = draw({ online: false })
    // PayCellRow's accessibility label is `${title}. ${subtitle}`.
    expect(s.getByLabelText('pay_method_nearby. pay_cell_nearby_get_sub').props.accessibilityState.disabled).toBe(false)
    expect(s.getByLabelText('pay_method_remote_link. pay_offline_needs_internet').props.accessibilityState.disabled).toBe(true)
    expect(s.getByLabelText('pay_method_address. pay_offline_needs_internet').props.accessibilityState.disabled).toBe(true)
  })
})

describe('requestSatsFrom', () => {
  it('maps blank, zero, negative and junk to an open request', () => {
    expect(requestSatsFrom('')).toBeUndefined()
    expect(requestSatsFrom('0')).toBeUndefined()
    expect(requestSatsFrom('-5')).toBeUndefined()
    expect(requestSatsFrom('abc')).toBeUndefined()
  })
  it('rounds a positive figure to whole satoshis', () => {
    expect(requestSatsFrom('2500')).toBe(2500)
    expect(requestSatsFrom('2500.4')).toBe(2500)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- packages/expo-wallet-toolbox/__tests__/ui/requestHub.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `ui/components/pay/RequestHub.tsx`:

```tsx
/**
 * Get paid — the amount first, then how.
 *
 * The figure (or its absence: blank means the payer decides) is the one thing
 * every receive method shares, so it is asked once, here, and carried into
 * whichever code is shown next. The three rows are the methods; nothing on
 * this screen is gated on the amount, because an open request is a real
 * request.
 */
import React from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'
import { useTranslation } from 'react-i18next'

import PayCellRow from './PayCellRow'
import { PayAmountField, PayField } from './PayForm'
import { spacing } from '@bsv/expo-wallet-toolbox'

export type RequestMethod = 'get-nearby' | 'get-handle' | 'get-address'

export interface RequestHubProps {
  /** Raw satoshi string from the amount field. '' is an open request. */
  requestSats: string
  onChangeRequestSats: (v: string) => void
  onPick: (method: RequestMethod) => void
  online: boolean
}

/** Satoshis from the hub's raw field, or undefined for an open request. */
export function requestSatsFrom(text: string): number | undefined {
  const n = Math.round(Number(text))
  return Number.isFinite(n) && n > 0 ? n : undefined
}

export default function RequestHub({ requestSats, onChangeRequestSats, onPick, online }: RequestHubProps) {
  const { t } = useTranslation()
  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {/* No max button and no balance line: this asks the PAYER for money, so
          the requester's own balance is meaningless here. */}
      <PayAmountField value={requestSats} onChangeText={onChangeRequestSats} showMax={false} showBalance={false} />

      <PayField labelKey="pay_method">
        <View style={styles.rows}>
          <PayCellRow
            title={t('pay_method_nearby')}
            subtitle={t('pay_cell_nearby_get_sub')}
            icon="qr-code-outline"
            onPress={() => onPick('get-nearby')}
          />
          {/* Remote and address both need the network: a message-box round-trip
              and an overlay lookup respectively. Nearby is the offline rail. */}
          <PayCellRow
            title={t('pay_method_remote_link')}
            subtitle={online ? t('pay_cell_handle_get_sub') : t('pay_offline_needs_internet')}
            icon="share-outline"
            disabled={!online}
            onPress={() => onPick('get-handle')}
          />
          <PayCellRow
            title={t('pay_method_address')}
            subtitle={online ? t('pay_cell_address_get_sub') : t('pay_offline_needs_internet')}
            icon="wallet-outline"
            disabled={!online}
            onPress={() => onPick('get-address')}
          />
        </View>
      </PayField>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: spacing.lg, paddingTop: spacing.lg },
  rows: { gap: spacing.md }
})
```

In `ui/index.ts`, after the `PayCellRow` export line add:
`export { default as RequestHub, requestSatsFrom, type RequestHubProps, type RequestMethod } from './components/pay/RequestHub'`

- [ ] **Step 4: Run**

Run: `npm test -- packages/expo-wallet-toolbox/__tests__/ui/requestHub.test.tsx && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add packages/expo-wallet-toolbox/ui/components/pay/RequestHub.tsx packages/expo-wallet-toolbox/__tests__/ui/requestHub.test.tsx packages/expo-wallet-toolbox/ui/index.ts
git commit -m "$(cat <<'EOF'
feat(receive): request hub — amount first, then the method

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: `PayScreen` composition and its tests

**Files:**
- Modify: `ui/screens/PayScreen.tsx`
- Test: `__tests__/ui/payScreen.test.tsx` (rewrite the grid/cell tests; keep the queue/banner tests)

**Interfaces:**
- Consumes: `UniversalSend` (Task 7), `RequestHub`, `requestSatsFrom`, `RequestMethod` (Task 10), `NearbyFlow` props (Task 8), `HandleReceive`/`AddressReceive` `initialSats` (Task 9), `validatePeerPayURI` with `messageBoxUrl` (Task 1).

- [ ] **Step 1: Rewrite the tests**

In `__tests__/ui/payScreen.test.tsx`:

(a) Replace the mock lines for the cells with:

```ts
jest.mock('../../ui/components/pay/NearbyFlow', () => 'NearbyFlow')
jest.mock('../../ui/components/pay/UniversalSend', () => 'UniversalSend')
jest.mock('../../ui/components/pay/RequestHub', () => ({
  __esModule: true,
  default: 'RequestHub',
  requestSatsFrom: (text: string) => {
    const n = Math.round(Number(text))
    return Number.isFinite(n) && n > 0 ? n : undefined
  }
}))
jest.mock('../../ui/components/pay/HandleReceive', () => 'HandleReceive')
jest.mock('../../ui/components/pay/AddressReceive', () => 'AddressReceive')
```

(b) Delete these tests: `'renders the three counterparty rows for the Pay direction'`, `'titles the screen Get paid and lists the receive rows for ?direction=get'`, `'opens the handle cell when a deep link names it'`, `'opens the handle cell for a peerpay link and forwards the key'`, `'ignores an unknown cell param and shows the grid'`, `'disables the handle and address cells while offline, leaving nearby alone'`, `'leaves every cell enabled while online'`. Keep `'titles the screen with the direction it was opened in, with no switcher'` and `'opens the nearby payee cell for the get-nearby link'` (edit the latter as below) and every queue/banner test. In `'keeps the grid working when the queue read itself fails'`, rename to `'keeps the send form working when the queue read itself fails'` and replace `await findByText('pay_cell_nearby_pay')` with `await waitFor(() => expect(UNSAFE_getByType('UniversalSend' as never)).toBeTruthy())` (destructure `UNSAFE_getByType` from `draw()` and import `waitFor`).

(c) Add:

```ts
  it('opens straight on the send form for the Pay direction — no chooser', () => {
    const { UNSAFE_getByType, queryByText } = draw()
    expect(UNSAFE_getByType('UniversalSend' as never)).toBeTruthy()
    expect(queryByText('pay_cell_nearby_pay')).toBeNull()
    expect(queryByText('pay_cell_handle_pay')).toBeNull()
  })

  it('treats pay-handle and pay-address as aliases for the send form', () => {
    mockParams.cell = 'pay-address'
    expect(draw().UNSAFE_getByType('UniversalSend' as never).props.openScannerOnMount).toBeFalsy()
  })

  it('opens the send form with the scanner up for pay-nearby', () => {
    mockParams.cell = 'pay-nearby'
    expect(draw().UNSAFE_getByType('UniversalSend' as never).props.openScannerOnMount).toBe(true)
  })

  it('prefills the send form from a peerpay link, url extension included', () => {
    mockParams.peerpay = `peerpay:${KEY}?sats=1000&url=${encodeURIComponent('https://mb.example')}`
    const form = draw().UNSAFE_getByType('UniversalSend' as never)
    expect(form.props.initialTarget).toEqual({ kind: 'handle', identityKey: KEY, messageBoxUrl: 'https://mb.example' })
    expect(form.props.initialSats).toBe(1000)
  })

  it('surfaces a malformed peerpay link as a notice on the send form', () => {
    mockParams.peerpay = 'peerpay:nope'
    expect(draw().UNSAFE_getByType('UniversalSend' as never).props.initialNotice).toContain('identity key')
  })

  it('swaps the send form for the nearby payer flow when a session code is scanned', () => {
    const { UNSAFE_getByType } = draw()
    const session = mintSession({
      identityKey: KEY,
      derivationPrefix: 'ZGV2LXByZWZpeA==',
      derivationSuffix: 'ZGV2LXN1ZmZpeA==',
      supportsAwdl: false
    })
    act(() => UNSAFE_getByType('UniversalSend' as never).props.onNearbySession(session))
    // The nearby advisory has not been acknowledged in this test, so the flow
    // waits behind the modal; the header already names the rail.
    const nearby = UNSAFE_getByType('NearbyFlow' as never)
    expect(nearby.props.role).toBe('payer')
    expect(nearby.props.initialSession).toBe(session)
  })

  it('opens the request hub for the Get direction, titled Request Payment', () => {
    mockParams.direction = 'get'
    const { UNSAFE_getByType, getByText, queryByText } = draw()
    expect(UNSAFE_getByType('RequestHub' as never)).toBeTruthy()
    expect(getByText('local_pay_request')).toBeTruthy()
    expect(queryByText('pay_direction_receive')).toBeNull()
  })

  it('carries the hub amount into the picked method', () => {
    mockParams.direction = 'get'
    const { UNSAFE_getByType } = draw()
    const hub = UNSAFE_getByType('RequestHub' as never)
    act(() => hub.props.onChangeRequestSats('2500'))
    act(() => UNSAFE_getByType('RequestHub' as never).props.onPick('get-handle'))
    expect(UNSAFE_getByType('HandleReceive' as never).props.initialSats).toBe(2500)
  })

  it('opens a receive method directly, amount unset, when a deep link names it', () => {
    mockParams.cell = 'get-handle'
    const { UNSAFE_getByType, getByText } = draw()
    expect(UNSAFE_getByType('HandleReceive' as never).props.initialSats).toBeUndefined()
    expect(getByText('pay_method_remote_link')).toBeTruthy()
  })
```

Edit `'opens the nearby payee cell for the get-nearby link'` to also assert `expect(UNSAFE_getByType('NearbyFlow' as never).props.initialRequest).toEqual({ sats: undefined })`.

Add `act` and `waitFor` to the `@testing-library/react-native` import and `mintSession` to the barrel import. Note: `NearbyFlow` renders only once the advisory flag resolves; in this test environment `nearbyAdvisory.get()` reads AsyncStorage (mocked, empty) → `false` → the advisory modal shows and `NearbyFlow` is NOT mounted. So in the two nearby tests, first make the flag true: add at the top of the file `import { nearbyAdvisory } from '../../core/localpay/nearbyAdvisory'` and in those two tests `await act(async () => { await nearbyAdvisory.set() })` before `draw()`, and use `await findBy…`/`waitFor` around the `NearbyFlow` lookup. In `beforeEach`, clear it: `await AsyncStorage.clear()` (import `AsyncStorage from '@react-native-async-storage/async-storage'`; it is the jest mock via `moduleNameMapper`).

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- packages/expo-wallet-toolbox/__tests__/ui/payScreen.test.tsx`
Expected: FAIL on the new tests.

- [ ] **Step 3: Rewrite `PayScreen.tsx`**

(a) Header comment — replace the block comment at the top with:

```ts
/**
 * Pay — two screens, no chooser.
 *
 * Pay opens on one send form whose recipient field infers the rail from what
 * is typed or scanned (see core/pay/rails: classifyRecipientInput,
 * classifyScan). A scanned nearby-session code swaps the form for NearbyFlow.
 *
 * Get paid opens on the request hub: the amount first, then three method
 * rows, each of which shows that method's code with the amount carried in.
 *
 * `?cell=` values survive as deep-link aliases: any `pay-*` opens the send form
 * (`pay-nearby` with the scanner up), any `get-*` opens that method directly.
 */
```

(b) Imports — replace the cell imports with:

```ts
import UniversalSend from '../components/pay/UniversalSend'
import RequestHub, { requestSatsFrom, type RequestMethod } from '../components/pay/RequestHub'
import NearbyFlow from '../components/pay/NearbyFlow'
import HandleReceive from '../components/pay/HandleReceive'
import AddressReceive from '../components/pay/AddressReceive'
```

Remove `PayCellRow` from the imports. Add `type Session` to the barrel import list.

(c) Delete the `CellSpec` interface, the `CELLS` constant and the `CELL_TITLE_KEYS` constant. Add:

```ts
const METHOD_TITLE_KEYS: Record<RequestMethod, string> = {
  'get-nearby': 'pay_method_nearby',
  'get-handle': 'pay_method_remote_link',
  'get-address': 'pay_method_address'
}

const isRequestMethod = (v: string | undefined): v is RequestMethod =>
  v === 'get-nearby' || v === 'get-handle' || v === 'get-address'
```

(d) Params and state — replace from `const peerpay = firstParam(params.peerpay)` through `const [cell, setCell] = useState<PayCell | null>(openingCell)` with:

```ts
  const peerpay = firstParam(params.peerpay)
  const peerPayValidation = useMemo(() => (peerpay ? validatePeerPayURI(peerpay) : null), [peerpay])
  const peerPayNotice = useMemo(() => {
    if (!peerPayValidation) return null
    const messages = [peerPayValidation.errors.identityKey, peerPayValidation.errors.sats].filter(Boolean)
    return messages.length ? messages.join('. ') : null
  }, [peerPayValidation])

  const initialIdentityKey = peerPayValidation?.identityKey ?? firstParam(params.identityKey)
  const satsParam = peerPayValidation?.sats ?? Number(firstParam(params.sats))
  const initialSats = Number.isFinite(satsParam) && satsParam > 0 ? Number(satsParam) : undefined
  // Memoized: useRecipientInput re-adopts initialTarget whenever its identity changes.
  const initialTarget = useMemo(
    () =>
      initialIdentityKey
        ? {
            kind: 'handle' as const,
            identityKey: initialIdentityKey,
            ...(peerPayValidation?.messageBoxUrl ? { messageBoxUrl: peerPayValidation.messageBoxUrl } : {})
          }
        : undefined,
    [initialIdentityKey, peerPayValidation?.messageBoxUrl]
  )

  const paramCell = firstParam(params.cell)
  // Direction is fixed by how the user got here. A peerpay link is a request
  // to pay; a `get-*` cell or `?direction=get` is the receive side.
  const direction: Direction =
    peerpay || (paramCell ?? '').startsWith('pay')
      ? 'pay'
      : isRequestMethod(paramCell) || firstParam(params.direction) === 'get'
        ? 'get'
        : 'pay'
  /** Pay side: a scanned nearby session takes over the screen. */
  const [nearbySession, setNearbySession] = useState<Session | null>(null)
  /** Get side: the method chosen on the hub, or named by a deep link. */
  const [method, setMethod] = useState<RequestMethod | null>(isRequestMethod(paramCell) ? paramCell : null)
  /** Get side: the hub's raw amount, carried into the method. */
  const [requestSats, setRequestSats] = useState('')
  const openScannerOnMount = paramCell === 'pay-nearby'
```

Remove the `PayCell`/`isPayCell` imports if now unused.

(e) Replace `const isNearbyCell = cell === 'pay-nearby' || cell === 'get-nearby'` with `const isNearbyCell = (direction === 'pay' && nearbySession !== null) || method === 'get-nearby'`.

(f) In the queue effect's dependency array, replace `cell` with `method, nearbySession`. Update its comment's "enters/leaves a pay cell" to "enters/leaves a method".

(g) Replace `grid()` and `body()` with:

```tsx
  const offlineNotice = (
    <View style={styles.noticeWrap}>
      <OfflineNotice
        online={online}
        queued={queued}
        rejected={rejected}
        sentRejected={sentRejected}
        onSendNow={() => TaskSendOffline.requestNow()}
        stalled={stalled}
        pendingCount={pendingCount}
        pendingStuck={pendingStuck}
        pendingCorrupt={pendingCorrupt}
        queuedSent={queuedSentRows}
        onShowCode={setShowCode}
        onRequestAgain={row => void onRequestAgain(row)}
        onCopyDetails={onCopyDetails}
        onDismiss={row => void onDismiss(row)}
        onSendAgain={row => void onSendAgain(row)}
      />
    </View>
  )

  const body = () => {
    if (direction === 'pay') {
      if (nearbySession) {
        return nearbyAdvisorySeen ? <NearbyFlow role="payer" initialSession={nearbySession} onExit={goBack} /> : null
      }
      return (
        <>
          {offlineNotice}
          <UniversalSend
            initialTarget={initialTarget}
            initialSats={initialSats}
            initialNotice={peerPayNotice}
            openScannerOnMount={openScannerOnMount}
            onNearbySession={setNearbySession}
          />
        </>
      )
    }
    const sats = requestSatsFrom(requestSats)
    switch (method) {
      case 'get-nearby':
        return nearbyAdvisorySeen ? <NearbyFlow role="payee" initialRequest={{ sats }} onExit={goBack} /> : null
      case 'get-handle':
        return <HandleReceive initialSats={sats} />
      case 'get-address':
        return <AddressReceive initialSats={sats} />
      default:
        return (
          <>
            {offlineNotice}
            <RequestHub
              requestSats={requestSats}
              onChangeRequestSats={setRequestSats}
              onPick={setMethod}
              online={online}
            />
          </>
        )
    }
  }
```

(h) Header title — replace the `{cell ? t(CELL_TITLE_KEYS[cell]) : …}` expression with:

```tsx
          {direction === 'pay'
            ? t(nearbySession ? 'pay_cell_nearby_pay' : 'pay_direction_pay')
            : t(method ? METHOD_TITLE_KEYS[method] : 'local_pay_request')}
```

and replace the comment above it with `{/* The screen names what it is doing: the direction, or the rail/method once one is live. */}`.

(i) Body background — replace `{ backgroundColor: cell ? colors.background : colors.backgroundSecondary }` with `{ backgroundColor: colors.background }` and trim the comment above it to: `{/* Both entry screens are forms now; the hub's rows carry their own elevation. */}`.

(j) `NearbyAdvisoryModal` — `onCancel={() => (direction === 'pay' ? setNearbySession(null) : setMethod(null))}`.

(k) Styles — delete `grid` and `rows`; add `noticeWrap: { paddingHorizontal: spacing.lg }`.

(l) `useOfflineNoticeActions`'s `pushPay` is unchanged.

- [ ] **Step 4: Run tests and typecheck**

Run: `npx tsc --noEmit && npm test -- packages/expo-wallet-toolbox/__tests__/ui/payScreen.test.tsx`
Expected: tsc clean; PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/expo-wallet-toolbox/ui/screens/PayScreen.tsx packages/expo-wallet-toolbox/__tests__/ui/payScreen.test.tsx
git commit -m "$(cat <<'EOF'
feat(pay): open on the send form and the request hub — no chooser

Pay lands on the universal send form; a scanned session code swaps it
for the nearby payer flow. Get paid lands on the amount, then a method
row opens that method's code with the amount carried in. Cell names
survive only as deep-link aliases.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: Message-box row in Settings › Advanced; delete `MessageBoxBar`; retire old copy; final sweep

**Files:**
- Modify: `ui/screens/WalletConfigScreen.tsx` (imports ~1-60; state ~150-165; Advanced › Configuration ~617-720)
- Modify: `ui/components/pay/MessageBoxConfig.tsx` (delete `MessageBoxBar` and its props/styles)
- Modify: `ui/index.ts` (drop `MessageBoxBar`)
- Modify: `core/i18n/translations.tsx` (remove `scan_bsv_address_hint`, `scan_identity_key_hint` from all twelve locales)
- Modify: `app/+native-intent.ts` comment only (optional: none needed — `cell=pay-handle` remains a valid alias)

- [ ] **Step 1: Settings row**

In `ui/screens/WalletConfigScreen.tsx`:

(a) Add `import { ConfigPanel, useMessageBoxConfig } from '../components/pay/MessageBoxConfig'` next to the other `../components` imports, and `NO_MESSAGE_BOX` to the barrel import list.

(b) Inside the component, after `const currentCurrency = …`, add `const messageBox = useMessageBoxConfig(t)`.

(c) In the Advanced › Configuration `GroupedSection`, directly before the `<ListRow label="Auto Spend Up To" …` element, insert:

```tsx
            {/* The one home of the message-box setting. Save / Default / Use no
                server live in ConfigPanel, unchanged from when it sat on the
                pay screens; the row's value says which server handle payments
                go through, or that none does. */}
            <ListRow
              label={t('message_box_server')}
              value={
                messageBox.messageBoxUrl === NO_MESSAGE_BOX
                  ? t('message_box_off')
                  : messageBox.messageBoxUrl.replace(/^https:\/\//, '')
              }
              icon="mail-outline"
              iconColor="#5E5CE6"
              onPress={() => messageBox.setShowConfig(v => !v)}
              showChevron={messageBox.showConfig}
              chevronDown={messageBox.showConfig}
            />
            {messageBox.showConfig && (
              <View style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.md }}>
                <ConfigPanel
                  urlInput={messageBox.urlInput}
                  isSaving={messageBox.isSaving}
                  colors={colors}
                  t={t}
                  onChangeUrl={messageBox.setUrlInput}
                  onSave={() => {
                    void messageBox.handleSave(messageBox.urlInput)
                  }}
                  onReset={messageBox.handleReset}
                  onNone={messageBox.handleNone}
                />
              </View>
            )}
```

(`useMessageBoxConfig` auto-opens the panel when the saved value is the no-server sentinel; here that simply means the row opens expanded, which is right — the user is looking at a setting that needs attention.)

- [ ] **Step 2: Delete `MessageBoxBar`**

In `ui/components/pay/MessageBoxConfig.tsx`: delete `MessageBoxBarProps`, the `MessageBoxBar` function and its doc comment, and the `bar`/`barText` styles. Update the file header: "the state hook and the panel; both now render from Settings › Advanced". In `ui/index.ts`, change the export to `export { useMessageBoxConfig, ConfigPanel } from './components/pay/MessageBoxConfig'`.

- [ ] **Step 3: Retire the two old scan hints**

Delete `scan_bsv_address_hint:` and `scan_identity_key_hint:` from all twelve locale blocks.

- [ ] **Step 4: Sweep**

Run:
```bash
grep -rn "HandleSend\|AddressSend\|useIdentitySearch\|MessageBoxBar\|search_name_or_key\|scan_bsv_address_hint\|scan_identity_key_hint\|local_pay_amount_optional_hint\|CELL_TITLE_KEYS\|PayCellRow" app packages/expo-wallet-toolbox/ui packages/expo-wallet-toolbox/core packages/expo-wallet-toolbox/__tests__ | grep -v "^packages/expo-wallet-toolbox/ui/components/pay/PayCellRow.tsx\|^packages/expo-wallet-toolbox/ui/components/pay/RequestHub.tsx\|^packages/expo-wallet-toolbox/__tests__/ui/requestHub.test.tsx\|^packages/expo-wallet-toolbox/ui/index.ts.*PayCellRow"
```
Expected: no output. (`PayCellRow` stays: `RequestHub` uses it and the barrel exports it.)

Then the full gate:
```bash
npx tsc --noEmit && npm test -- packages/expo-wallet-toolbox && npm run lint
```
Expected: tsc clean; all suites PASS; lint clean (or only pre-existing warnings — compare against `git stash`-free baseline by checking the warning list mentions no file this plan touched).

- [ ] **Step 5: Commit**

```bash
git add packages/expo-wallet-toolbox/ui/screens/WalletConfigScreen.tsx packages/expo-wallet-toolbox/ui/components/pay/MessageBoxConfig.tsx packages/expo-wallet-toolbox/ui/index.ts packages/expo-wallet-toolbox/core/i18n/translations.tsx
git commit -m "$(cat <<'EOF'
feat(settings): message-box server moves to Advanced; retire the pay-screen bar

One place to see and change which server handle payments go through.
The bar and cog that sat atop the pay and receive screens are gone,
along with the two rail-specific scan hints the unified scanner no
longer needs.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

## Manual verification (device, after Task 12)

Not automatable; do before opening the PR:

1. Pay: paste an address → green "Valid address entered", consequence note, no note field; pay 1 sat to your own address.
2. Pay: paste a compressed key → green key row, note field, no callout.
3. Pay: paste `1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN3` → red "Invalid BSV address", no search spinner.
4. Pay: type a name → search dropdown; pick → identity card.
5. Pay: QR button → scan each of: an address QR, a `peerpay:` QR, a bare-key QR, a nearby session QR from a second device. The last one must land on NearbyFlow's confirm step with the peer's key shown.
6. Get paid: type 2500 → Nearby → pairing QR shows 2,500; pay it from the second device.
7. Get paid: type 2500 → Share remote link → QR is `peerpay:<key>?sats=2500&url=…`; Share sheet shows the same; scan it from the second device → send form prefilled with 2,500 and the send skips the overlay (check logs for no `ls_messagebox` lookup).
8. Get paid: To an address → QR is the bare address; 2,500 shown above it.
9. Settings › Advanced › Message Box Server: change, Default, Use no server; back on Pay with a key entered, the CTA is disabled with the "off" footnote.
10. Balance line reads "N available" under the amount, in satoshis (BSV mode) and as a bare 2-dp figure (USD mode).
