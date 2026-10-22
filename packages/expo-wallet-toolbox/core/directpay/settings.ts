/**
 * Settings for direct (peer-to-peer) payments, stored on this device.
 *
 * Device-level, not wallet-level: they are read before sign-in and survive logout, so the
 * `storage` passed in must not be the wallet's own database (an AsyncStorage-backed store,
 * not the wallet's key/value table, which is per wallet and cleared with it).
 *
 * Receiving is on by default, and wallets find each other through the public WebRTPay relay by
 * default, with the message box as the other choice. A stored value that is missing or no
 * longer valid falls back to the default field by field; a stored STUN list that is exactly
 * the previous default ({@link PREVIOUS_DEFAULT_STUN_URLS}) is read as the current default.
 * Receiving answers live payments only while the Receive screen is showing (see
 * DirectPayManager.openReceiveScreen).
 *
 * Addresses are checked with regexes, not `URL`: `URL.hostname` is unreliable on Hermes. A relay
 * must be `wss://` (desktop also allows `ws://` for localhost; a phone has no local relay, so
 * there is no exception here), and an address with `user:password@` in it is refused. A token in
 * the query string cannot be told from any other query, so that is not.
 *
 * The TURN credential is stored as plain JSON beside the other settings, and AsyncStorage is
 * not encrypted: do not give it a secret that matters beyond this one relay.
 */
import type { KVStorage } from '../localpay/pending'
import type { DirectPaySettings, DirectPayTurn } from './types'

export const DIRECT_PAY_SETTINGS_KEY = 'direct_pay_settings_v1'

/** The public WebRTPay relay, the default way wallets find each other. */
export const DEFAULT_RELAY_URL = 'wss://webrtpay-relay-us-1.bsvblockchain.tech'

/** The default `stunUrls` is frozen; `loadDirectPaySettings` hands out copies of it. */
export const DEFAULT_DIRECT_PAY_SETTINGS: Readonly<Omit<DirectPaySettings, 'stunUrls'>> & {
  readonly stunUrls: readonly string[]
} = {
  receiveEnabled: true,
  signaling: 'relay',
  relayUrl: DEFAULT_RELAY_URL,
  // BSVA's own STUN server only (2026-10-21): every STUN server learns this device's address
  // and when it connects.
  stunUrls: Object.freeze(['stun:stun-us-1.bsvb.tech:3478'])
}

/**
 * The STUN list that was the default until 2026-10-21. A stored list that is exactly this
 * (saved before, never edited) is read as the current default; any other list is the user's.
 */
export const PREVIOUS_DEFAULT_STUN_URLS: readonly string[] = Object.freeze([
  'stun:stun-us-1.bsvb.tech:3478',
  'stun:stun.l.google.com:19302',
  'stun:stun.cloudflare.com:3478'
])

/**
 * Largest transaction (Atomic BEEF) sent or taken live: 1 MB (2026-10-21). A larger payment
 * is refused before anything is spent and the message box is offered; a payee refuses larger
 * live messages and closes the session.
 */
export const MAX_LIVE_TRANSACTION_BYTES = 1_000_000
/**
 * The largest message an authenticated live session may send this wallet: a `payment` with a
 * {@link MAX_LIVE_TRANSACTION_BYTES} transaction in base64 (a third larger), plus 4096 bytes for
 * the rest of the message, as @bsv/webrtpay counts it (MAX_DIRECT_TRANSACTION_BYTES).
 */
export const MAX_LIVE_MESSAGE_BYTES = 4 * Math.ceil(MAX_LIVE_TRANSACTION_BYTES / 3) + 4096

/**
 * `servers` (the relay's TURN answer) without its STUN entries: the relay passes on the TURN
 * provider's STUN urls (Cloudflare's), and only the settings' STUN list is asked.
 */
export function onlyOwnStun<T extends { urls: string | string[] }>(servers: T[]): T[] {
  const out: T[] = []
  for (const server of servers) {
    const urls = (typeof server.urls === 'string' ? [server.urls] : [...server.urls]).filter(u => !/^stuns?:/i.test(u))
    if (urls.length > 0) out.push({ ...server, urls })
  }
  return out
}

/** True for a stored STUN list that is exactly {@link PREVIOUS_DEFAULT_STUN_URLS}. */
function previousDefaultStun(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length === PREVIOUS_DEFAULT_STUN_URLS.length &&
    value.every((u, i) => u === PREVIOUS_DEFAULT_STUN_URLS[i])
  )
}

// A host is a name or IPv4 address that starts and ends with a letter or digit, or a bracketed
// IPv6 address, then an optional port. No credentials, and nothing else before the path.
const HOST = String.raw`(?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?`
/** wss:// then a host, then an optional path, query or fragment, with no spaces. */
const RELAY_URL = new RegExp(String.raw`^wss://${HOST}(?:[/?#]\S*)?$`)
/** stun:/stuns:/turn:/turns: then a host, then an optional query such as `?transport=udp`. */
const STUN_URL = new RegExp(String.raw`^stuns?:${HOST}(?:\?\S*)?$`)
const TURN_URL = new RegExp(String.raw`^turns?:${HOST}(?:\?\S*)?$`)

/** Whether `text` is a relay address as written: `wss://`, a host, no credentials. Nothing is trimmed. */
export const isRelayUrl = (text: string): boolean => RELAY_URL.test(text)

/** Whether `text` is a `stun:` / `stuns:` server as written. Nothing is trimmed. */
export const isStunUrl = (text: string): boolean => STUN_URL.test(text)

/** Which setting a {@link DirectPaySettingsError} is about. */
export type DirectPaySettingsField = keyof DirectPaySettings

/**
 * Why a setting cannot be saved. `code` is for the screen to word (nothing here is English for
 * the user); `message` is for developers and logs.
 */
export type DirectPaySettingsProblem =
  | 'receive_invalid'
  | 'signaling_invalid'
  | 'relay_invalid'
  | 'relay_required'
  | 'stun_invalid'
  | 'turn_invalid'
  | 'turn_incomplete'
  | 'storage_failed'

export class DirectPaySettingsError extends Error {
  constructor(
    readonly code: DirectPaySettingsProblem,
    message: string,
    readonly field?: DirectPaySettingsField
  ) {
    super(message)
    this.name = 'DirectPaySettingsError'
  }
}

function checkReceiveEnabled(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw new DirectPaySettingsError('receive_invalid', 'receiveEnabled must be a boolean', 'receiveEnabled')
  }
  return value
}

function checkSignaling(value: unknown): DirectPaySettings['signaling'] {
  if (value !== 'relay' && value !== 'messagebox') {
    throw new DirectPaySettingsError('signaling_invalid', "signaling must be 'relay' or 'messagebox'", 'signaling')
  }
  return value
}

/** An empty string means no relay is configured. */
function checkRelayUrl(value: unknown): string {
  if (typeof value !== 'string') {
    throw new DirectPaySettingsError('relay_invalid', 'relayUrl must be a string', 'relayUrl')
  }
  const text = value.trim()
  if (text === '') return ''
  if (!isRelayUrl(text)) {
    throw new DirectPaySettingsError(
      'relay_invalid',
      'relayUrl must be a wss:// address (a host, then an optional port and path) without user:password@',
      'relayUrl'
    )
  }
  return text
}

/** Blank entries are dropped, so a form can pass one line per server. */
function checkStunUrls(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new DirectPaySettingsError('stun_invalid', 'stunUrls must be a list of stun: or stuns: addresses', 'stunUrls')
  }
  const urls: string[] = []
  for (const entry of value) {
    const text = typeof entry === 'string' ? entry.trim() : null
    if (text === '') continue
    if (text === null || !isStunUrl(text)) {
      throw new DirectPaySettingsError(
        'stun_invalid',
        `STUN server "${String(entry)}" must start with stun: or stuns:`,
        'stunUrls'
      )
    }
    urls.push(text)
  }
  return urls
}

/** Absent, or a form with every field blank, means no TURN server. */
function checkTurn(value: unknown): DirectPayTurn | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object') {
    throw new DirectPaySettingsError('turn_invalid', 'turn must be an object', 'turn')
  }
  const { urls, username, credential } = value as Record<string, unknown>
  const text = (field: unknown) => (typeof field === 'string' ? field.trim() : null)
  const [turnUrls, turnUser, turnCredential] = [text(urls), text(username), text(credential)]
  if (!turnUrls && !turnUser && !turnCredential) return undefined
  if (!turnUrls || !TURN_URL.test(turnUrls)) {
    throw new DirectPaySettingsError('turn_invalid', 'the TURN server must start with turn: or turns:', 'turn')
  }
  if (!turnUser || !turnCredential) {
    throw new DirectPaySettingsError('turn_incomplete', 'a TURN server needs both a username and a credential', 'turn')
  }
  return { urls: turnUrls, username: turnUser, credential: turnCredential }
}

function withTurn(settings: Omit<DirectPaySettings, 'turn'>, turn: DirectPayTurn | undefined): DirectPaySettings {
  return turn ? { ...settings, turn } : settings
}

/**
 * This build's own relay and STUN servers (`ToolboxConfig.directPay`), which stand in for the
 * built-in ones. Checked by `configureToolbox` with the same rules as the user's settings.
 */
export interface DirectPayHostDefaults {
  relayUrl?: string
  stunUrls?: readonly string[]
}

/** The defaults with this build's relay and STUN servers in place of the built-in ones. */
function defaultsWith(host: DirectPayHostDefaults | undefined): typeof DEFAULT_DIRECT_PAY_SETTINGS {
  if (!host?.relayUrl && !host?.stunUrls) return DEFAULT_DIRECT_PAY_SETTINGS
  return {
    ...DEFAULT_DIRECT_PAY_SETTINGS,
    ...(host.relayUrl ? { relayUrl: host.relayUrl } : {}),
    ...(host.stunUrls ? { stunUrls: Object.freeze([...host.stunUrls]) } : {})
  }
}

/**
 * The stored settings, with the default for each field that is missing or no longer valid.
 * Never throws: unreadable or corrupt storage gives the defaults. `host` replaces the
 * built-in relay and STUN defaults; what the user saved wins over both.
 */
export async function loadDirectPaySettings(
  storage: KVStorage,
  host?: DirectPayHostDefaults
): Promise<DirectPaySettings> {
  const defaults = defaultsWith(host)
  let stored: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse((await storage.getKeyValue(DIRECT_PAY_SETTINGS_KEY)) ?? 'null')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) stored = parsed as Record<string, unknown>
  } catch {
    // Corrupt or unreadable storage: the defaults apply.
  }

  const field = <T>(check: (value: unknown) => T, value: unknown, fallback: T): T => {
    try {
      return check(value)
    } catch {
      return fallback
    }
  }

  const settings = withTurn(
    {
      receiveEnabled: field(checkReceiveEnabled, stored.receiveEnabled, defaults.receiveEnabled),
      signaling: field(checkSignaling, stored.signaling, defaults.signaling),
      relayUrl: field(checkRelayUrl, stored.relayUrl, defaults.relayUrl),
      stunUrls: field(checkStunUrls, previousDefaultStun(stored.stunUrls) ? [...defaults.stunUrls] : stored.stunUrls, [
        ...defaults.stunUrls
      ])
    },
    field(checkTurn, stored.turn, undefined)
  )
  // `saveDirectPaySettings` never stores relay signaling with no relay; a store edited by hand might.
  if (settings.signaling === 'relay' && !settings.relayUrl) settings.relayUrl = defaults.relayUrl
  return settings
}

/**
 * Validates and stores the settings. Fields left out take their defaults (`host`'s relay and
 * STUN servers in place of the built-in ones), so the argument describes the whole stored
 * state. Throws a {@link DirectPaySettingsError} and stores nothing when a value is not
 * acceptable; relay signaling needs a relay URL.
 */
export async function saveDirectPaySettings(
  storage: KVStorage,
  input: Partial<DirectPaySettings>,
  host?: DirectPayHostDefaults
): Promise<DirectPaySettings> {
  const defaults = defaultsWith(host)
  const settings = withTurn(
    {
      receiveEnabled: checkReceiveEnabled(input.receiveEnabled ?? defaults.receiveEnabled),
      signaling: checkSignaling(input.signaling ?? defaults.signaling),
      relayUrl: checkRelayUrl(input.relayUrl ?? defaults.relayUrl),
      stunUrls: checkStunUrls(input.stunUrls ?? defaults.stunUrls)
    },
    checkTurn(input.turn)
  )
  if (settings.signaling === 'relay' && !settings.relayUrl) {
    throw new DirectPaySettingsError(
      'relay_required',
      'relay signaling needs a relayUrl; use the message box instead',
      'relayUrl'
    )
  }
  try {
    await storage.setKeyValue(DIRECT_PAY_SETTINGS_KEY, JSON.stringify(settings))
  } catch (e) {
    throw new DirectPaySettingsError(
      'storage_failed',
      `direct payment settings could not be stored: ${e instanceof Error ? e.message : String(e)}`
    )
  }
  return settings
}

/** An ICE server as WebRTC takes it. Declared here so this module needs no DOM or WebRTC types. */
export interface IceServer {
  urls: string | string[]
  username?: string
  credential?: string
}

/** The ICE servers for a connection: the STUN list, then TURN with its credentials. */
export function iceServersFrom(settings: { stunUrls: readonly string[]; turn?: DirectPayTurn }): IceServer[] {
  const servers: IceServer[] = []
  if (settings.stunUrls.length > 0) servers.push({ urls: [...settings.stunUrls] })
  if (settings.turn) {
    servers.push({
      urls: settings.turn.urls,
      username: settings.turn.username,
      credential: settings.turn.credential
    })
  }
  return servers
}
