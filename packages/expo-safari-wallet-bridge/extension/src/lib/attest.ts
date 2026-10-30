/**
 * Origin attestation (spec 6.8): the origin comes only from the message `sender`, never from the page.
 * The sender frame's URL is re-read on every call (a frame can navigate and keep its `frameId`), and the
 * top frame's URL is never consulted, so a cross-origin iframe cannot borrow the top origin.
 */
import { canonicalizeBridgeOrigin, OriginRefused } from '@bsv/expo-wallet-toolbox/core/bridge/protocol/origin'
import type { ContinuityContext } from '../../../shared/native'

export interface Sender {
  tab?: { id?: number; incognito?: boolean; url?: string }
  frameId?: number
  url?: string
  origin?: string
}

export interface AttestedFrame {
  origin: string
  tabId: number
  frameId: number
  context: ContinuityContext
}

/** `scheme://authority` as written, untouched: P1 refuses a non-canonical origin rather than fixing it. */
function textualOrigin(url: string): string | undefined {
  const m = /^(https?:\/\/[^/?#]*)/.exec(url)
  return m ? m[1] : undefined
}

export function attestFrame(sender: Sender, opts: { allowLocalhostHttp: boolean }): AttestedFrame | undefined {
  const tabId = sender?.tab?.id
  if (typeof tabId !== 'number') return undefined
  const frameId = typeof sender.frameId === 'number' ? sender.frameId : 0

  const url = typeof sender.url === 'string' ? sender.url : undefined
  // about:blank and about:srcdoc inherit an origin in some engines; they must not announce.
  if (url !== undefined && url.startsWith('about:')) return undefined

  let candidate: string | undefined
  if (typeof sender.origin === 'string') {
    candidate = sender.origin === 'null' ? undefined : sender.origin
  } else if (url !== undefined) {
    candidate = textualOrigin(url)
  }
  if (candidate === undefined) return undefined

  let origin: string
  try {
    origin = canonicalizeBridgeOrigin({
      origin: candidate,
      attestation: 'browser',
      allowLocalhostHttp: opts.allowLocalhostHttp
    }).applicationOrigin
  } catch (e) {
    if (e instanceof OriginRefused) return undefined
    throw e
  }

  // A private tab, or one whose flag is not a boolean, gets the private context (spec 6.9).
  const context: ContinuityContext = sender.tab?.incognito === false ? 'safari' : 'safari-private'
  return { origin, tabId, frameId, context }
}
