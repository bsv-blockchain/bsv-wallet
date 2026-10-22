import type { ColorTokenAccessHandler } from '@bsv/color-permission-module'

/** Every consent message type the color module 0.2.0 sends (IC §2.5). */
export type ColorPromptType =
  | 'color_send'
  | 'color_signature'
  | 'color_access'
  | 'color_relinquish'
  | 'color_receive_offline'

export const COLOR_PROMPT_TYPES: readonly ColorPromptType[] = [
  'color_send',
  'color_signature',
  'color_access',
  'color_relinquish',
  'color_receive_offline'
]

export interface ColorAccessPolicyOptions {
  /** The wallet's own originator. Its screens are the consent surface (W2). */
  adminOriginator: string
  /** Shows the request to the user and resolves true only on an explicit approval. */
  prompt: (originator: string, message: string) => Promise<boolean>
  now?: () => number
  /** How long a `color_access` approval covers further reads by the same originator. */
  readGrantMs?: number /* default 1_800_000 */
}

const DEFAULT_READ_GRANT_MS = 1_800_000

/** The message's `type` when it is a JSON object naming a known consent type, else undefined. */
export function colorPromptType(message: string): { type: ColorPromptType; seekPermission: boolean } | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(message)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const { type, seekPermission } = parsed as { type?: unknown; seekPermission?: unknown }
  if (typeof type !== 'string' || !(COLOR_PROMPT_TYPES as readonly string[]).includes(type)) return undefined
  // The module always sends a boolean; anything but an explicit false may prompt (`!== false`, IC §2.5).
  return { type: type as ColorPromptType, seekPermission: seekPermission !== false }
}

/**
 * The host's `requestTokenAccess` for the color module.
 *
 * - An unreadable message or an unknown type is refused for everyone, without a prompt.
 * - `adminOriginator` is approved for every known type without a prompt (W2).
 * - Only `color_access` (a read) can be answered from a grant: an approval leaves a
 *   `readGrantMs` grant for that originator alone. Spend, signature, relinquish and
 *   offline-credit requests prompt every time, and their approvals grant nothing (C10).
 * - `seekPermission: false` with no live grant refuses without a prompt.
 * - Anything but a literal `true` from the prompt, including a rejection, is a refusal.
 *
 * Concurrent reads by one originator (two tabs, a list racing a balance) share one
 * prompt, so the user answers once; the grant then covers the rest.
 */
export function createColorAccessPolicy(
  o: ColorAccessPolicyOptions
): ColorTokenAccessHandler & { clearGrants(): void } {
  if (typeof o?.adminOriginator !== 'string' || o.adminOriginator.length === 0) {
    throw new TypeError('createColorAccessPolicy: adminOriginator is required')
  }
  if (typeof o.prompt !== 'function') throw new TypeError('createColorAccessPolicy: prompt is required')
  const readGrantMs = o.readGrantMs ?? DEFAULT_READ_GRANT_MS
  if (typeof readGrantMs !== 'number' || !Number.isFinite(readGrantMs) || readGrantMs < 0) {
    throw new TypeError('createColorAccessPolicy: readGrantMs must be a finite number >= 0')
  }
  const { adminOriginator, prompt } = o
  const now = o.now ?? Date.now

  /** originator → time the read grant was given. */
  const readGrants = new Map<string, number>()
  /** originator → the read prompt in flight, shared by concurrent reads. */
  const readPrompts = new Map<string, Promise<boolean>>()
  /** Bumped by clearGrants, so a prompt answered after a clear grants nothing. */
  let generation = 0

  const hasReadGrant = (originator: string): boolean => {
    const grantedAt = readGrants.get(originator)
    if (grantedAt === undefined) return false
    const elapsed = now() - grantedAt
    // A clock that went backwards proves nothing about the grant's age: fail closed.
    if (elapsed >= 0 && elapsed < readGrantMs) return true
    readGrants.delete(originator)
    return false
  }

  const ask = async (originator: string, message: string): Promise<boolean> => {
    try {
      return (await prompt(originator, message)) === true
    } catch {
      return false
    }
  }

  const askRead = (originator: string, message: string): Promise<boolean> => {
    const inFlight = readPrompts.get(originator)
    if (inFlight !== undefined) return inFlight
    const asked = generation
    const answer = ask(originator, message).then(approved => {
      if (approved && asked === generation) readGrants.set(originator, now())
      return approved
    })
    readPrompts.set(originator, answer)
    const release = (): void => {
      if (readPrompts.get(originator) === answer) readPrompts.delete(originator)
    }
    answer.then(release, release)
    return answer
  }

  const policy = async (app: string, message: string): Promise<boolean> => {
    if (typeof app !== 'string' || typeof message !== 'string') return false
    const request = colorPromptType(message)
    if (request === undefined) return false
    if (app === adminOriginator) return true
    if (request.type === 'color_access') {
      if (hasReadGrant(app)) return true
      if (!request.seekPermission) return false
      return await askRead(app, message)
    }
    if (!request.seekPermission) return false
    return await ask(app, message)
  }

  return Object.assign(policy, {
    clearGrants(): void {
      generation += 1
      readGrants.clear()
    }
  })
}
