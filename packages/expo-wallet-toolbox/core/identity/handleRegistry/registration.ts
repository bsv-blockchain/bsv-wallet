/**
 * Every write to the registry, and the journal that makes each one idempotent.
 *
 * The order is the whole design: a certificate is signed and written to
 * `key_value_store` BEFORE the first request, so a retry after a crash, a
 * double tap or a timeout re-sends the identical bytes — which the registry
 * treats as a no-op `200` rather than a second claim. That is why "the write
 * landed but the response was lost" and "the write never landed" do not have
 * to be told apart here: replaying settles both.
 *
 * `issuedAt` is the registry's replay guard, so it has to beat every value this
 * device has already minted (a clock that jumped backwards would otherwise
 * mint a certificate the server calls stale) while never running away from the
 * server's own clock (more than five minutes ahead is refused outright). The
 * corrected `serverNow` handles the second; the stored high-water mark, the
 * first.
 */
import { parsePaymail } from './rules'
import { buildProfileCertificate, type ProfileCertJson, type ProfileSigner } from './profileCert'
import type { HandleRegistryClient } from './client'

/** The in-flight journal. One at a time; a second intent replaces it. */
export const PENDING_JOURNAL_KEY = 'profile_handle_pending'
/** The highest `issuedAt` this device has ever minted. */
export const ISSUED_AT_KV_KEY = 'profile_handle_issued_at'
/**
 * How far ahead of the registry's own clock an `issuedAt` may be dated. The
 * server refuses anything past five minutes (`profilecert.MaxClockSkew`); four
 * leaves room for the request to arrive.
 */
export const MAX_ISSUED_AT_LEAD_MS = 240_000

/** Structurally satisfied by `StorageExpoSQLite`. */
export interface RegistrationStorage {
  getKeyValue(key: string): Promise<string | undefined>
  setKeyValue(key: string, value: string): Promise<void>
}

export type RegistrationIntent = 'register' | 'update' | 'change'

export interface PendingStep {
  kind: 'release' | 'claim'
  paymail: string
  cert: ProfileCertJson
}

/**
 * `intent` is not in the design's journal shape. `resumePending` runs a journal
 * it did not start and still has to say which of registered/updated/changed
 * happened, and no combination of the other fields tells those apart.
 * `attemptedPaymail` is there for the same reason: a rollback resumed on a
 * later mount has to name the handle that was lost, and its one step is the
 * reclaim. Nothing has shipped, so the version stays 1.
 */
export interface PendingJournal {
  v: 1
  intent: RegistrationIntent
  steps: PendingStep[]
  previousPaymail?: string
  attemptedPaymail?: string
  startedAt: string
}

/**
 * A refusal this module reached on its own rather than read off the wire, for a
 * caller that has to say it in the user's language — `message` is diagnostic
 * English, often the SDK's, and is the wrong thing to put in front of anybody.
 */
export type RegistrationFailureCode = 'invalid_handle' | 'wrong_domain' | 'same_handle' | 'clock_ahead'

export type RegistrationResult =
  | { kind: 'registered'; paymail: string }
  | { kind: 'updated'; paymail: string }
  | { kind: 'changed'; paymail: string }
  /** `attempted` is the handle that was lost; `paymail` is the one kept. */
  | { kind: 'rolled_back'; paymail: string; attempted?: string }
  | { kind: 'pending' }
  | { kind: 'rejected'; code: string; description: string }
  | { kind: 'failed'; message: string; code?: RegistrationFailureCode }
  | { kind: 'unavailable' }
  | { kind: 'idle' }

export interface RegistrationDeps {
  /** null when this chain has no registry configured. */
  client: HandleRegistryClient | null
  signer: ProfileSigner
  storage: RegistrationStorage
}

/**
 * One run at a time, and the key is what makes that safe.
 *
 * Two mounted Profile screens or a double tap ask for the SAME thing, and the
 * second caller should get the first caller's answer rather than mint a second
 * certificate. Two DIFFERENT intents are not interchangeable: the mount's
 * `resumePending` is routinely still in flight when the user taps Claim, and
 * handing the claim the resume's `{kind:'idle'}` would spin the button, send
 * nothing, and leave the user with no handle and no explanation. A different
 * key therefore queues behind the run in progress instead of joining it.
 *
 * Which is why the live runs are a map rather than one slot: the tail of the
 * queue is not the only run worth joining. A tap that arrives after the
 * mount's resume has queued asks for exactly what the tap before it asked for,
 * and one slot would have had it start its own release/claim pair behind the
 * resume — twice the writes for one user action.
 */
const live = new Map<string, Promise<RegistrationResult>>()
/** What a genuinely new key chains onto, so runs never overlap. */
let tail: Promise<RegistrationResult> | null = null

function share(key: string, run: () => Promise<RegistrationResult>): Promise<RegistrationResult> {
  const joined = live.get(key)
  if (joined) return joined
  const previous = tail
  const promise = (async () => {
    // Never reject on the predecessor's behalf: every entry point already
    // answers a result rather than throwing, and a rejection here would be
    // this caller's request never having been attempted.
    if (previous) await previous.catch(() => undefined)
    return await run()
  })()
  live.set(key, promise)
  tail = promise
  // `then(clear, clear)` rather than `finally`: an ignored `finally` chain
  // would re-raise a rejection nobody is listening to.
  const clear = () => {
    if (live.get(key) === promise) live.delete(key)
    if (tail === promise) tail = null
  }
  void promise.then(clear, clear)
  return promise
}

/** Test-only: forget the shared runs between cases. */
export function resetRegistrationState(): void {
  live.clear()
  tail = null
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

async function readJournal(storage: RegistrationStorage): Promise<PendingJournal | null> {
  const raw = await storage.getKeyValue(PENDING_JOURNAL_KEY)
  if (!raw) return null
  const parsed = parseJournal(raw)
  // A row no reader can act on is a row nothing would ever clear: every reader
  // answers "no journal" for it, so it would sit in the store for the life of
  // the install. Whatever it is, it is not a write this app can finish.
  if (!parsed) await clearJournal(storage)
  return parsed
}

function parseJournal(raw: string): PendingJournal | null {
  try {
    const parsed = JSON.parse(raw) as PendingJournal
    if (parsed?.v !== 1 || !Array.isArray(parsed.steps) || parsed.steps.length === 0) return null
    return parsed
  } catch {
    return null
  }
}

/** `setKeyValue('')` rather than a delete: the store has no delete, and an
 * empty string reads back as "no journal" everywhere it is checked. */
async function clearJournal(storage: RegistrationStorage): Promise<void> {
  await storage.setKeyValue(PENDING_JOURNAL_KEY, '')
}

async function writeJournal(storage: RegistrationStorage, journal: PendingJournal): Promise<void> {
  await storage.setKeyValue(PENDING_JOURNAL_KEY, JSON.stringify(journal))
}

/**
 * Strictly after everything this device has minted, at least the server's own
 * idea of now, and never so far ahead that the server refuses it.
 *
 * Stored before it is used, so a crash between minting and sending cannot let
 * the next attempt repeat the value — the registry compares `issuedAt` AND
 * `serialNumber`, and an equal `issuedAt` under a fresh serial is stale.
 *
 * The ceiling is what keeps a fast clock from being permanent. A phone an hour
 * ahead mints `now + 1h` on its first write, the server refuses it, and that
 * refused value is already the stored high-water mark; flooring alone would
 * re-mint `+1h` for ever. A mark beyond the ceiling cannot correspond to any
 * certificate the server accepted, so it is discarded rather than honoured —
 * and by then the refused response has corrected `serverNow`'s skew, so the
 * next attempt is inside the window with room left to climb.
 */
async function nextIssuedAt(deps: RegistrationDeps, client: HandleRegistryClient, after?: Date): Promise<Date> {
  const serverMs = client.serverNow().getTime()
  const ceiling = serverMs + MAX_ISSUED_AT_LEAD_MS
  const stored = Date.parse((await deps.storage.getKeyValue(ISSUED_AT_KV_KEY)) ?? '')
  const mark = Number.isFinite(stored) && stored < ceiling ? stored + 1 : 0
  const at = new Date(Math.min(Math.max(serverMs, mark, after ? after.getTime() + 1 : 0), ceiling))
  await deps.storage.setKeyValue(ISSUED_AT_KV_KEY, at.toISOString())
  return at
}

/**
 * Whether the registry already shows the world this step was trying to make —
 * with `unknown` for the registry that did not answer at all.
 *
 * That third answer is why this asks `lookupProfile` rather than
 * `lookupIdentityKey`: the latter flattens "this key holds nothing" and "no
 * answer" into one `null`, and reading silence as a tombstone would send the
 * claim that follows a release on a premise nobody confirmed.
 *
 * A claim is applied when the profile on offer IS the profile the step asked
 * for — the paymail and the display name both. The paymail alone tests nothing
 * for an `update`, where the paymail is by definition one this key already
 * holds, so a display name the registry refused would read back as saved.
 *
 * `paymailIsEnough` is the one case where it does test something: the claim of
 * a change — one with a release behind it — where holding the new handle IS
 * what the user asked for. The display name rides along on the same
 * certificate, and denying a change that happened because the registry is
 * serving an older name would leave the user told `failed` about a handle that
 * is theirs.
 */
async function alreadyApplied(
  client: HandleRegistryClient,
  step: PendingStep,
  paymailIsEnough: boolean
): Promise<boolean | 'unknown'> {
  const seen = await client.lookupProfile(step.cert.subject)
  if (seen.kind === 'failed') return 'unknown'
  const mine = seen.kind === 'found' ? seen.profile : null
  if (step.kind === 'claim') {
    if (mine?.paymail !== step.paymail) return false
    return paymailIsEnough || (mine.displayName ?? '') === (step.cert.fields.displayName ?? '')
  }
  return mine === null || mine.paymail !== step.paymail
}

/** The `issuedAt` a step was minted with, as the journal carries it. */
function issuedAtOf(step: PendingStep | undefined): Date | undefined {
  const ms = Date.parse(step?.cert.fields.issuedAt ?? '')
  return Number.isFinite(ms) ? new Date(ms) : undefined
}

/**
 * The handle to put the user back on, when the step the registry just refused
 * is the claim of a change that has already tombstoned the old one.
 *
 * `null` for everything else, and the `i > 0` is not decoration: `rollBack`
 * writes a journal of exactly one claim for `previousPaymail`, so a rollback
 * being resumed matches on paymail alone and would reclaim what it is already
 * reclaiming instead of reporting the refusal.
 */
function reclaimFor(
  journal: PendingJournal,
  step: PendingStep,
  i: number
): { paymail: string; releasedAt: Date | undefined; attempted: string } | null {
  if (step.kind !== 'claim' || i === 0 || !journal.previousPaymail) return null
  return {
    paymail: journal.previousPaymail,
    releasedAt: issuedAtOf(journal.steps.find(s => s.kind === 'release')),
    attempted: step.paymail
  }
}

async function runJournal(
  deps: RegistrationDeps,
  client: HandleRegistryClient,
  journal: PendingJournal
): Promise<RegistrationResult> {
  for (let i = 0; i < journal.steps.length; i++) {
    const step = journal.steps[i]
    const outcome = await client.putCertificate(step.cert)
    if (outcome.kind === 'created' || outcome.kind === 'ok') continue
    // No answer: the journal stays, and the next mount or an explicit retry
    // re-sends the same bytes.
    if (outcome.kind === 'failed') return { kind: 'pending' }
    // Whatever the registry's reason, refusing the claim of a change that has
    // already tombstoned the old handle leaves the user holding nothing — so
    // both branches below reach for the reclaim rather than the verdict.
    const reclaim = reclaimFor(journal, step, i)
    if (outcome.code === 'ERR_STALE_CERTIFICATE') {
      const applied = await alreadyApplied(client, step, reclaim !== null)
      if (applied === true) continue
      // Nobody said whether this step landed, so its fate is still open: the
      // journal stays and the next mount asks again.
      if (applied === 'unknown') return { kind: 'pending' }
      // Stale on such a claim means whoever released the new handle dated
      // their tombstone ahead of ours — any device a few minutes fast does —
      // and is the same hazard as the handle being taken. Replaying cannot
      // win, but the reclaim still can.
      if (reclaim) return await rollBack(deps, client, reclaim.paymail, reclaim.releasedAt, reclaim.attempted)
      // Replaying a certificate the registry calls stale can never win, so
      // keeping the journal would only retry it on every mount, forever.
      await clearJournal(deps.storage)
      return { kind: 'failed', message: outcome.description }
    }
    if (reclaim) return await rollBack(deps, client, reclaim.paymail, reclaim.releasedAt, reclaim.attempted)
    await clearJournal(deps.storage)
    return { kind: 'rejected', code: outcome.code, description: outcome.description }
  }
  await clearJournal(deps.storage)
  const paymail = journal.steps[journal.steps.length - 1].paymail
  // `rollBack`'s own journal, resumed: intent `change`, one step, and that step
  // reclaims the handle the change started from. It has to answer `rolled_back`
  // — the new handle was taken and the old one kept — rather than `changed`,
  // which would announce a handle the user never stopped holding.
  if (journal.intent === 'change' && journal.steps.length === 1 && journal.previousPaymail === paymail) {
    return {
      kind: 'rolled_back',
      paymail,
      ...(journal.attemptedPaymail ? { attempted: journal.attemptedPaymail } : {})
    }
  }
  if (journal.intent === 'update') return { kind: 'updated', paymail }
  if (journal.intent === 'change') return { kind: 'changed', paymail }
  return { kind: 'registered', paymail }
}

/**
 * Put the user back where they were. The previous owner is exempt from the
 * cooldown on a handle they released themselves, so this claim is one the
 * registry will accept.
 *
 * `releasedAt` is the release's own `issuedAt`, taken from the journal, and it
 * is what the reclaim has to beat: a release rewrites the row's `issuedAt` to
 * its own, and a reclaim not strictly after that is refused as stale. The
 * stored high-water mark cannot be relied on for it — a mark sitting on the
 * ceiling is discarded, and then the mint would land minutes BEHIND the
 * tombstone it is undoing, leaving the user holding neither handle.
 *
 * Nor can the mint be trusted to honour it, because the ceiling is applied
 * last: a phone four minutes fast dates its release on the fast clock, has it
 * accepted, and is corrected by that very response — which leaves the ceiling
 * sitting exactly on the tombstone. A reclaim that cannot beat the tombstone is
 * one the registry refuses, so it is not sent at all and the caller's journal
 * is left whole: the next attempt replays the release as a no-op, is refused
 * the claim again, and reaches here with a ceiling that has moved on.
 */
async function rollBack(
  deps: RegistrationDeps,
  client: HandleRegistryClient,
  previousPaymail: string,
  releasedAt?: Date,
  attempted?: string
): Promise<RegistrationResult> {
  try {
    const issuedAt = await nextIssuedAt(deps, client, releasedAt)
    if (releasedAt && issuedAt.getTime() <= releasedAt.getTime()) return { kind: 'pending' }
    const cert = await buildProfileCertificate({ signer: deps.signer, paymail: previousPaymail, issuedAt })
    await writeJournal(deps.storage, {
      v: 1,
      intent: 'change',
      steps: [{ kind: 'claim', paymail: previousPaymail, cert }],
      previousPaymail,
      // Carried so a rollback finished on a later mount can still name the
      // handle that was lost: by then its own claim is gone from the journal.
      ...(attempted ? { attemptedPaymail: attempted } : {}),
      startedAt: issuedAt.toISOString()
    })
    const outcome = await client.putCertificate(cert)
    if (outcome.kind === 'failed') return { kind: 'pending' }
    await clearJournal(deps.storage)
    if (outcome.kind === 'rejected') return { kind: 'rejected', code: outcome.code, description: outcome.description }
    return { kind: 'rolled_back', paymail: previousPaymail, ...(attempted ? { attempted } : {}) }
  } catch (e) {
    await clearJournal(deps.storage)
    return { kind: 'failed', message: messageOf(e) }
  }
}

/**
 * An unfinished journal outranks a new intent, and answering with its outcome
 * is the whole of the fix.
 *
 * A `release` is idempotent only while the IDENTICAL bytes are replayed: the
 * registry recognises a replayed tombstone by its `issuedAt`, so a freshly
 * minted one for a handle an earlier journal already tombstoned finds nothing
 * to release and comes back `404 ERR_HANDLE_NOT_FOUND` — while the signed,
 * still-replayable claim that would have finished the first attempt has already
 * been overwritten, leaving the user holding neither handle and the journal
 * that could have rescued them gone.
 *
 * So a second Claim press after a timeout, a display-name save arriving while a
 * change is still in flight, or a second Profile screen, all finish what is
 * already journalled rather than starting again. Nothing is minted until the
 * store is empty.
 */
async function finishOutstanding(
  deps: RegistrationDeps,
  client: HandleRegistryClient
): Promise<RegistrationResult | null> {
  const journal = await readJournal(deps.storage)
  return journal ? await runJournal(deps, client, journal) : null
}

export function registerHandle(
  deps: RegistrationDeps,
  args: { handle: string; displayName?: string }
): Promise<RegistrationResult> {
  return share(`register:${args.handle.trim().toLowerCase()}:${args.displayName?.trim() ?? ''}`, async () => {
    const client = deps.client
    if (!client) return { kind: 'unavailable' }
    try {
      const outstanding = await finishOutstanding(deps, client)
      if (outstanding) return outstanding
      const paymail = `${args.handle.trim().toLowerCase()}@${client.domain}`
      if (!parsePaymail(paymail))
        return { kind: 'failed', code: 'invalid_handle', message: `handleRegistry: not a valid handle: ${args.handle}` }
      const issuedAt = await nextIssuedAt(deps, client)
      const cert = await buildProfileCertificate({
        signer: deps.signer,
        paymail,
        issuedAt,
        displayName: args.displayName
      })
      const journal: PendingJournal = {
        v: 1,
        intent: 'register',
        steps: [{ kind: 'claim', paymail, cert }],
        startedAt: issuedAt.toISOString()
      }
      await writeJournal(deps.storage, journal)
      return await runJournal(deps, client, journal)
    } catch (e) {
      return { kind: 'failed', message: messageOf(e) }
    }
  })
}

export function updateProfile(
  deps: RegistrationDeps,
  args: { paymail: string; displayName?: string }
): Promise<RegistrationResult> {
  return share(`update:${args.paymail.trim().toLowerCase()}:${args.displayName?.trim() ?? ''}`, async () => {
    const client = deps.client
    if (!client) return { kind: 'unavailable' }
    try {
      const outstanding = await finishOutstanding(deps, client)
      if (outstanding) return outstanding
      const parsed = parsePaymail(args.paymail)
      if (!parsed || parsed.domain !== client.domain) {
        return {
          kind: 'failed',
          code: 'wrong_domain',
          message: `handleRegistry: not this registry's paymail: ${args.paymail}`
        }
      }
      const paymail = `${parsed.handle}@${parsed.domain}`
      const issuedAt = await nextIssuedAt(deps, client)
      const cert = await buildProfileCertificate({
        signer: deps.signer,
        paymail,
        issuedAt,
        displayName: args.displayName
      })
      const journal: PendingJournal = {
        v: 1,
        intent: 'update',
        steps: [{ kind: 'claim', paymail, cert }],
        startedAt: issuedAt.toISOString()
      }
      await writeJournal(deps.storage, journal)
      return await runJournal(deps, client, journal)
    } catch (e) {
      return { kind: 'failed', message: messageOf(e) }
    }
  })
}

export function changeHandle(
  deps: RegistrationDeps,
  args: { previousPaymail: string; handle: string; displayName?: string }
): Promise<RegistrationResult> {
  const key = `change:${args.previousPaymail.trim().toLowerCase()}:${args.handle.trim().toLowerCase()}:${args.displayName?.trim() ?? ''}`
  return share(key, async () => {
    const client = deps.client
    if (!client) return { kind: 'unavailable' }
    try {
      const outstanding = await finishOutstanding(deps, client)
      if (outstanding) return outstanding
      const previous = parsePaymail(args.previousPaymail)
      const paymail = `${args.handle.trim().toLowerCase()}@${client.domain}`
      if (!previous || previous.domain !== client.domain || !parsePaymail(paymail)) {
        return {
          kind: 'failed',
          code: 'wrong_domain',
          message: `handleRegistry: cannot change ${args.previousPaymail} to ${paymail}`
        }
      }
      const previousPaymail = `${previous.handle}@${previous.domain}`
      // Releasing a live handle to claim it straight back buys nothing and
      // costs a window in which the user holds neither — with every way a
      // change can go wrong inherited for a no-op. A display name is saved
      // through `updateProfile`, which needs no tombstone at all.
      if (previousPaymail === paymail) {
        return {
          kind: 'failed',
          code: 'same_handle',
          message: `handleRegistry: ${paymail} is already the registered handle`
        }
      }
      // One key may hold one handle, so the old one is tombstoned first and
      // the claim must be dated strictly after that tombstone.
      const releaseAt = await nextIssuedAt(deps, client)
      const claimAt = await nextIssuedAt(deps, client, releaseAt)
      // Both mints can land on the ceiling at once (a mark exactly one
      // millisecond below it), and then the claim does not beat the tombstone
      // the release leaves behind — nor would the reclaim that undoes it. Far
      // better to refuse a change and leave the user the handle they have; the
      // ceiling moves with the clock, so this clears itself in minutes.
      if (claimAt.getTime() <= releaseAt.getTime()) {
        return {
          kind: 'failed',
          code: 'clock_ahead',
          message: 'handleRegistry: the clock is too far ahead to change handle yet'
        }
      }
      const release = await buildProfileCertificate({
        signer: deps.signer,
        paymail: previousPaymail,
        issuedAt: releaseAt,
        released: true
      })
      const claim = await buildProfileCertificate({
        signer: deps.signer,
        paymail,
        issuedAt: claimAt,
        displayName: args.displayName
      })
      const journal: PendingJournal = {
        v: 1,
        intent: 'change',
        steps: [
          { kind: 'release', paymail: previousPaymail, cert: release },
          { kind: 'claim', paymail, cert: claim }
        ],
        previousPaymail,
        startedAt: releaseAt.toISOString()
      }
      await writeJournal(deps.storage, journal)
      return await runJournal(deps, client, journal)
    } catch (e) {
      return { kind: 'failed', message: messageOf(e) }
    }
  })
}

/** Called on every Profile mount. Nothing journalled is the common case. */
export function resumePending(deps: RegistrationDeps): Promise<RegistrationResult> {
  return share('resume', async () => {
    const client = deps.client
    if (!client) return { kind: 'unavailable' }
    try {
      return (await finishOutstanding(deps, client)) ?? { kind: 'idle' }
    } catch (e) {
      return { kind: 'failed', message: messageOf(e) }
    }
  })
}
