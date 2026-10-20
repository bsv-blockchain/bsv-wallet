/**
 * Settings for direct (peer-to-peer) payments, stored on this device.
 *
 * Device-level, not wallet-level: they are read before sign-in and survive logout, so the
 * `storage` passed in must not be the wallet's own database (an AsyncStorage-backed store,
 * not the wallet's key/value table, which is per wallet and cleared with it).
 *
 * Receiving is on by default, and wallets find each other through the public WebRTPay relay by
 * default, with the message box as the other choice. There is no migration: this key is the
 * first, and a stored value that is missing or no longer valid falls back to the default
 * field by field.
 *
 * Addresses are checked with regexes, not `URL`: `URL.hostname` is unreliable on Hermes. A relay
 * must be `wss://` (desktop also allows `ws://` for localhost; a phone has no local relay, so
 * there is no exception here), and an address with credentials in it is refused.
 */
import type { KVStorage } from '../localpay/pending'
import type { DirectPaySettings, DirectPayTurn } from './types'

export const DIRECT_PAY_SETTINGS_KEY = 'direct_pay_settings_v1'

/** The public WebRTPay relay, the default way wallets find each other. */
export const DEFAULT_RELAY_URL = 'wss://webrtpay-relay-us-1.bsvblockchain.tech'

/** Never mutate it: `loadDirectPaySettings` hands out copies of `stunUrls`. */
export const DEFAULT_DIRECT_PAY_SETTINGS: Readonly<DirectPaySettings> = {
  receiveEnabled: true,
  signaling: 'relay',
  relayUrl: DEFAULT_RELAY_URL,
  stunUrls: ['stun:stun-us-1.bsvb.tech:3478', 'stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478']
}

/** wss:// then a host (no credentials), then an optional path, query or fragment, with no spaces. */
const RELAY_URL = /^wss:\/\/[^\s/?#@]+(?:[/?#]\S*)?$/
const STUN_URL = /^stuns?:\S+$/
const TURN_URL = /^turns?:\S+$/

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
  if (!RELAY_URL.test(text)) {
    throw new DirectPaySettingsError(
      'relay_invalid',
      'relayUrl must be a wss:// address without credentials',
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
    if (text === null || !STUN_URL.test(text)) {
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
 * The stored settings, with the default for each field that is missing or no longer valid.
 * Never throws: unreadable or corrupt storage gives the defaults.
 */
export async function loadDirectPaySettings(storage: KVStorage): Promise<DirectPaySettings> {
  const defaults = DEFAULT_DIRECT_PAY_SETTINGS
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

  return withTurn(
    {
      receiveEnabled: field(checkReceiveEnabled, stored.receiveEnabled, defaults.receiveEnabled),
      signaling: field(checkSignaling, stored.signaling, defaults.signaling),
      relayUrl: field(checkRelayUrl, stored.relayUrl, defaults.relayUrl),
      stunUrls: field(checkStunUrls, stored.stunUrls, [...defaults.stunUrls])
    },
    field(checkTurn, stored.turn, undefined)
  )
}

/**
 * Validates and stores the settings. Fields left out take their defaults, so the argument
 * describes the whole stored state. Throws a {@link DirectPaySettingsError} and stores nothing
 * when a value is not acceptable; relay signaling needs a relay URL.
 */
export async function saveDirectPaySettings(
  storage: KVStorage,
  input: Partial<DirectPaySettings>
): Promise<DirectPaySettings> {
  const defaults = DEFAULT_DIRECT_PAY_SETTINGS
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
export function iceServersFrom(settings: Pick<DirectPaySettings, 'stunUrls' | 'turn'>): IceServer[] {
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
