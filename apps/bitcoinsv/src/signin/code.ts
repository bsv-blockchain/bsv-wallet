// A website's sign-in code (src/signin/signIn.ts): read and checked as the
// core checks a pairing (validateConnectParams). Kept apart so it can be
// tested without the core's barrel.
import {
  validateConnectParams,
  type ConnectParams
} from '@bsv/expo-wallet-toolbox/core/services/walletConnectionValidation'

export interface SignInCode {
  params: Required<Pick<ConnectParams, 'topic' | 'backendIdentityKey' | 'protocolID' | 'origin' | 'expiry'>> & {
    sig?: string
  }
  /** the site's canonical origin, the only form of it ever shown */
  origin: string
  /** what the wallet calls the site in its prompts and permissions */
  originator: string
  /** what to call it: its host, without www. */
  domain: string
}

/** Whether a scanned code is a website's sign-in code (before checking it). */
export const isSignInCode = (raw: string) => /^bsv-(wallet|browser):\/\/pair\b/i.test(raw.trim())

/**
 * A bsv-wallet://pair link opened from outside the app (app/pair.tsx), back
 * from the route params Expo Router split it into, as the sign-in code it was.
 */
export function pairLinkFromParams(params: Record<string, string | string[] | undefined>): string {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    for (const one of Array.isArray(v) ? v : v === undefined ? [] : [v]) q.append(k, one)
  }
  return `bsv-wallet://pair?${q.toString()}`
}

/** A scanned code, checked as the core checks it; a reason when it isn't one. */
export function readSignInCode(raw: string, nowMs = Date.now()): { code: SignInCode } | { error: string } {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return { error: 'That isn’t a sign-in code.' }
  }
  if (url.protocol !== 'bsv-wallet:' && url.protocol !== 'bsv-browser:') return { error: 'That isn’t a sign-in code.' }
  const g = (k: string) => url.searchParams.get(k) ?? undefined
  const expiry = Number(g('expiry'))
  if (Number.isFinite(expiry) && nowMs / 1000 > expiry)
    return { error: 'This code has expired. Ask the website for a new one.' }
  try {
    const v = validateConnectParams(
      {
        topic: g('topic'),
        backendIdentityKey: g('backendIdentityKey'),
        protocolID: g('protocolID'),
        origin: g('origin'),
        expiry: g('expiry'),
        sig: g('sig')
      } as ConnectParams,
      nowMs
    )
    const host = v.external.originator.replace(/^www\./, '')
    return {
      code: {
        params: v.params as SignInCode['params'],
        origin: v.external.origin,
        originator: v.external.originator,
        domain: host
      }
    }
  } catch (e) {
    return {
      error: e instanceof Error && e.message ? `This code can’t be used: ${e.message}` : 'This code can’t be used.'
    }
  }
}
