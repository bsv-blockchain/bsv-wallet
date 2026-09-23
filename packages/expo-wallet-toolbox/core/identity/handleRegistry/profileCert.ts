/**
 * The profile certificate: mint one, and decide whether one handed to us is
 * worth believing.
 *
 * The registry is a directory, not an authority on what a profile says, so
 * every certificate read from any host passes `verifyProfileCertificate`
 * before a single field of it is shown or used. `Certificate.verify()` alone
 * is not that decision: it proves the certificate was signed by the key it
 * NAMES as certifier, which for a self-signed profile is only meaningful once
 * `subject === certifier` has been checked separately — otherwise a third
 * party's well-formed signature over someone else's subject verifies happily.
 *
 * Nothing here touches a network; `client.ts` does that and calls in here.
 */
import { Certificate, Random, Utils, type ProtoWallet } from '@bsv/sdk'
import {
  MAX_CERT_BODY_BYTES,
  MAX_FIELDS,
  MAX_FIELD_NAME_BYTES,
  MAX_FIELD_VALUE_BYTES,
  PROFILE_CERT_TYPE,
  ZERO_OUTPOINT,
  parsePaymail,
  utf8ByteLength
} from './rules'

/** The seven-member BRC-52 wire shape, exactly as the registry serves it. */
export interface ProfileCertJson {
  type: string
  serialNumber: string
  subject: string
  certifier: string
  revocationOutpoint: string
  fields: Record<string, string>
  signature: string
}

/**
 * The two `WalletInterface` methods `Certificate.sign` reaches for.
 *
 * Callers pass the wallet wrapped with `bindOriginator(wallet, adminOriginator)`
 * (core/mandala/createRuntime.ts) so signing the user's own profile never
 * raises a permission prompt.
 *
 * `counterparty` is optional because the SDK never sends one: `Certificate.sign`
 * passes `data`, `protocolID` and `keyID` alone. The wallet's own default of
 * `'anyone'` is what the certificate then verifies against, since
 * `Certificate.verify()` is an `'anyone'` ProtoWallet checking the signature
 * against `certifier`. Declaring it required would describe a contract the SDK
 * does not honour.
 */
export interface ProfileSigner {
  getPublicKey(args: { identityKey: true }, originator?: string): Promise<{ publicKey: string }>
  createSignature(
    args: { data: number[]; protocolID: [number, string]; keyID: string; counterparty?: string },
    originator?: string
  ): Promise<{ signature: number[] }>
}

/** A certificate that passed every rule in the trust model. */
export interface RegistryProfile {
  identityKey: string
  paymail: string
  handle: string
  domain: string
  displayName?: string
  issuedAt: Date
  certificate: ProfileCertJson
}

export async function buildProfileCertificate(args: {
  signer: ProfileSigner
  paymail: string
  issuedAt: Date
  displayName?: string
  released?: boolean
}): Promise<ProfileCertJson> {
  const parsed = parsePaymail(args.paymail)
  if (!parsed) throw new Error(`handleRegistry: not a valid paymail: ${args.paymail}`)
  if (!Number.isFinite(args.issuedAt.getTime())) throw new Error('handleRegistry: issuedAt is not a date')

  const fields: Record<string, string> = {
    paymail: `${parsed.handle}@${parsed.domain}`,
    issuedAt: args.issuedAt.toISOString()
  }
  const displayName = args.displayName?.trim() ?? ''
  if (displayName !== '') fields.displayName = displayName
  if (args.released === true) fields.released = 'true'
  assertWithinLimits(fields)

  const { publicKey } = await args.signer.getPublicKey({ identityKey: true })
  const certificate = new Certificate(
    PROFILE_CERT_TYPE,
    Utils.toBase64(Random(32)),
    publicKey,
    publicKey,
    ZERO_OUTPOINT,
    fields
  )
  // `sign` is typed against ProtoWallet; structurally it needs only the two
  // methods ProfileSigner names, and the wallet this app passes is the
  // originator-bound PermissionsManager, not a ProtoWallet.
  await certificate.sign(args.signer as unknown as ProtoWallet)

  const json: ProfileCertJson = {
    type: certificate.type,
    serialNumber: certificate.serialNumber,
    subject: certificate.subject,
    certifier: certificate.certifier,
    revocationOutpoint: certificate.revocationOutpoint,
    fields: certificate.fields,
    signature: certificate.signature ?? ''
  }
  if (json.signature === '') throw new Error('handleRegistry: signing produced no signature')
  if (utf8ByteLength(JSON.stringify(json)) > MAX_CERT_BODY_BYTES) {
    throw new Error('handleRegistry: certificate exceeds the 16 KB body limit')
  }
  return json
}

/** Refused here rather than at the server, so a too-long name is an immediate
 * message about the field the user is typing, not a 400 two seconds later. */
function assertWithinLimits(fields: Record<string, string>): void {
  const names = Object.keys(fields)
  if (names.length > MAX_FIELDS) throw new Error(`handleRegistry: more than ${MAX_FIELDS} certificate fields`)
  for (const name of names) {
    if (utf8ByteLength(name) >= MAX_FIELD_NAME_BYTES) throw new Error(`handleRegistry: field name too long: ${name}`)
    if (utf8ByteLength(fields[name]) > MAX_FIELD_VALUE_BYTES) {
      throw new Error(`handleRegistry: field value too long: ${name}`)
    }
  }
}

/**
 * The trust model, in order. Answers a profile or null; never throws, because
 * every caller is rendering a list and a bad row is a row to leave out.
 */
export async function verifyProfileCertificate(
  cert: unknown,
  expect: { domain: string; paymail?: string; identityKey?: string }
): Promise<RegistryProfile | null> {
  try {
    const json = asProfileCertJson(cert)
    if (!json) return drop('not a certificate object')
    if (json.type !== PROFILE_CERT_TYPE) return drop('wrong certificate type')
    if (json.subject.toLowerCase() !== json.certifier.toLowerCase()) return drop('subject is not the certifier')
    if (json.revocationOutpoint !== ZERO_OUTPOINT) return drop('revocation outpoint is not the zero outpoint')
    if (utf8ByteLength(JSON.stringify(json)) > MAX_CERT_BODY_BYTES) return drop('over the body limit')

    const names = Object.keys(json.fields)
    if (names.length > MAX_FIELDS) return drop('too many fields')
    for (const name of names) {
      if (utf8ByteLength(name) >= MAX_FIELD_NAME_BYTES) return drop('field name over the limit')
      if (utf8ByteLength(json.fields[name]) > MAX_FIELD_VALUE_BYTES) return drop('field value over the limit')
    }
    if (json.fields.released === 'true') return drop('released')

    const paymail = json.fields.paymail
    if (typeof paymail !== 'string' || paymail !== paymail.trim().toLowerCase()) {
      return drop('paymail is not exact lowercase')
    }
    const parsed = parsePaymail(paymail)
    if (!parsed) return drop('paymail is not handle@domain')
    if (parsed.domain !== expect.domain.trim().toLowerCase()) return drop('paymail is for another domain')
    if (expect.paymail !== undefined && paymail !== expect.paymail.trim().toLowerCase()) {
      return drop('not the paymail that was asked for')
    }
    if (expect.identityKey !== undefined && json.subject.toLowerCase() !== expect.identityKey.trim().toLowerCase()) {
      return drop('not the key that was asked for')
    }

    const issuedAtMs = Date.parse(json.fields.issuedAt ?? '')
    if (!Number.isFinite(issuedAtMs)) return drop('issuedAt is missing or unparseable')

    const verified = await new Certificate(
      json.type,
      json.serialNumber,
      json.subject,
      json.certifier,
      json.revocationOutpoint,
      json.fields,
      json.signature
    ).verify()
    // Since @bsv/sdk 2.8 `verify` answers false for a forged or malformed
    // signature instead of throwing, so this is where a forgery is refused.
    if (!verified) return drop('signature does not verify')

    const displayName = json.fields.displayName?.trim()
    return {
      identityKey: json.subject,
      paymail,
      handle: parsed.handle,
      domain: parsed.domain,
      ...(displayName ? { displayName } : {}),
      issuedAt: new Date(issuedAtMs),
      certificate: json
    }
  } catch (e) {
    // Every throw shares one reason, because the text is the SDK's and some of
    // it is shaped by the certificate: one bad character in `serialNumber`
    // reaches the base64 decoder, which names the index it failed at — a
    // different sentence per position, and enough of them to spend the budget
    // below and silence every real reason afterwards. The first one still
    // reports its own words, which is what a broken registry is diagnosed from.
    return drop('certificate threw during verification', e instanceof Error ? e.message : String(e))
  }
}

/**
 * One line per reason, then silence.
 *
 * A failed certificate is never shown, and a registry serving ten junk rows on
 * every debounced keystroke must not be able to fill the log either — so a
 * reason already reported is not reported again. Every reason is one of this
 * module's own literals; the cap is there so that a reason built one day from
 * text the registry supplied still cannot grow the set without bound.
 */
const droppedReasons = new Set<string>()
function drop(why: string, detail?: string): null {
  if (!droppedReasons.has(why) && droppedReasons.size < 32) {
    droppedReasons.add(why)
    const line = detail === undefined ? why : `${why}: ${detail}`
    console.log('handleRegistry: dropped a profile certificate —', line, '(further reports suppressed)')
  }
  return null
}

/** Test-only: forget which reasons have been reported. */
export function resetDroppedLog(): void {
  droppedReasons.clear()
}

function asProfileCertJson(value: unknown): ProfileCertJson | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Record<string, unknown>
  for (const key of ['type', 'serialNumber', 'subject', 'certifier', 'revocationOutpoint', 'signature'] as const) {
    if (typeof candidate[key] !== 'string') return null
  }
  if (!candidate.fields || typeof candidate.fields !== 'object' || Array.isArray(candidate.fields)) return null
  const fields: Record<string, string> = {}
  for (const [name, fieldValue] of Object.entries(candidate.fields as Record<string, unknown>)) {
    if (typeof fieldValue !== 'string') return null
    fields[name] = fieldValue
  }
  return {
    type: candidate.type as string,
    serialNumber: candidate.serialNumber as string,
    subject: candidate.subject as string,
    certifier: candidate.certifier as string,
    revocationOutpoint: candidate.revocationOutpoint as string,
    fields,
    signature: candidate.signature as string
  }
}
