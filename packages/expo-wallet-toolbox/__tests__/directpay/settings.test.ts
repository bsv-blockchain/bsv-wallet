import {
  DEFAULT_DIRECT_PAY_SETTINGS,
  DEFAULT_RELAY_URL,
  DIRECT_PAY_SETTINGS_KEY,
  DirectPaySettingsError,
  iceServersFrom,
  isRelayUrl,
  isStunUrl,
  loadDirectPaySettings,
  saveDirectPaySettings
} from '../../core/directpay'
import type { DirectPaySettings } from '../../core/directpay'

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(initial))
  return {
    map,
    getKeyValue: jest.fn(async (k: string) => map.get(k)),
    setKeyValue: jest.fn(async (k: string, v: string) => void map.set(k, v))
  }
}

const stored = (value: unknown) => fakeStorage({ [DIRECT_PAY_SETTINGS_KEY]: JSON.stringify(value) })

// Rejects with the problem code, so a test can tell which rule refused.
const refusal = async (input: Partial<DirectPaySettings>) => {
  const storage = fakeStorage()
  const error = await saveDirectPaySettings(storage, input).then(
    () => undefined,
    (e: unknown) => e
  )
  expect(storage.setKeyValue).not.toHaveBeenCalled()
  return error as DirectPaySettingsError | undefined
}

describe('defaults', () => {
  it('receive on, signaling through the public relay, STUN with the BSV server first', () => {
    expect(DEFAULT_DIRECT_PAY_SETTINGS).toEqual({
      receiveEnabled: true,
      signaling: 'relay',
      relayUrl: 'wss://webrtpay-relay-us-1.bsvblockchain.tech',
      stunUrls: ['stun:stun-us-1.bsvb.tech:3478', 'stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478']
    })
    expect(DEFAULT_DIRECT_PAY_SETTINGS.relayUrl).toBe(DEFAULT_RELAY_URL)
  })

  it('is stored under one device-level key', () => {
    expect(DIRECT_PAY_SETTINGS_KEY).toBe('direct_pay_settings_v1')
  })

  it('cannot have its STUN list changed by a caller', () => {
    expect(Object.isFrozen(DEFAULT_DIRECT_PAY_SETTINGS.stunUrls)).toBe(true)
    expect(() => (DEFAULT_DIRECT_PAY_SETTINGS.stunUrls as string[]).push('stun:x.example.com')).toThrow(TypeError)
  })
})

describe('loadDirectPaySettings', () => {
  it('gives the defaults when nothing is stored', async () => {
    expect(await loadDirectPaySettings(fakeStorage())).toEqual(DEFAULT_DIRECT_PAY_SETTINGS)
  })

  it('hands out its own copy of the defaults', async () => {
    const first = await loadDirectPaySettings(fakeStorage())
    first.stunUrls.push('stun:mutated.example:3478')
    expect(DEFAULT_DIRECT_PAY_SETTINGS.stunUrls).toHaveLength(3)
    expect((await loadDirectPaySettings(fakeStorage())).stunUrls).toHaveLength(3)
  })

  it('reads one key and nothing else: there is nothing to migrate from', async () => {
    const storage = fakeStorage()
    await loadDirectPaySettings(storage)
    expect(storage.getKeyValue).toHaveBeenCalledTimes(1)
    expect(storage.getKeyValue).toHaveBeenCalledWith('direct_pay_settings_v1')
    expect(storage.setKeyValue).not.toHaveBeenCalled()
  })

  it('keeps what the user chose', async () => {
    const settings: DirectPaySettings = {
      receiveEnabled: false,
      signaling: 'messagebox',
      relayUrl: 'wss://relay.example.com/pay',
      stunUrls: ['stun:stun.example.com:3478'],
      turn: { urls: 'turn:turn.example.com:3478', username: 'u', credential: 'c' }
    }
    expect(await loadDirectPaySettings(stored(settings))).toEqual(settings)
  })

  it('keeps receiving off once the user has turned it off', async () => {
    expect((await loadDirectPaySettings(stored({ receiveEnabled: false }))).receiveEnabled).toBe(false)
  })

  it('takes the default for each field that is missing', async () => {
    expect(await loadDirectPaySettings(stored({ signaling: 'messagebox' }))).toEqual({
      ...DEFAULT_DIRECT_PAY_SETTINGS,
      signaling: 'messagebox'
    })
  })

  it('takes the default for each field that is no longer valid, and keeps the rest', async () => {
    const loaded = await loadDirectPaySettings(
      stored({
        receiveEnabled: 'yes',
        signaling: 'carrier-pigeon',
        relayUrl: 'ws://relay.example.com',
        stunUrls: ['http://not-stun.example.com'],
        turn: { urls: 'stun:wrong-scheme.example.com', username: 'u', credential: 'c' }
      })
    )
    expect(loaded).toEqual(DEFAULT_DIRECT_PAY_SETTINGS)

    const partly = await loadDirectPaySettings(stored({ receiveEnabled: false, relayUrl: 'https://relay.example.com' }))
    expect(partly).toEqual({ ...DEFAULT_DIRECT_PAY_SETTINGS, receiveEnabled: false })
  })

  // saveDirectPaySettings refuses this; only a store edited by hand can hold it.
  it('does not load relay signaling with no relay: it takes the default relay', async () => {
    expect(await loadDirectPaySettings(stored({ signaling: 'relay', relayUrl: '' }))).toEqual(
      DEFAULT_DIRECT_PAY_SETTINGS
    )
    expect(await loadDirectPaySettings(stored({ relayUrl: '   ' }))).toMatchObject({
      signaling: 'relay',
      relayUrl: DEFAULT_RELAY_URL
    })
  })

  it('keeps an empty relay when the message box does the signaling', async () => {
    expect(await loadDirectPaySettings(stored({ signaling: 'messagebox', relayUrl: '' }))).toMatchObject({
      signaling: 'messagebox',
      relayUrl: ''
    })
  })

  it('drops an incomplete TURN server rather than half using it', async () => {
    const loaded = await loadDirectPaySettings(stored({ turn: { urls: 'turn:turn.example.com:3478', username: 'u' } }))
    expect(loaded).not.toHaveProperty('turn')
  })

  it.each([
    ['corrupt JSON', '{not json'],
    ['a JSON array', '[1,2]'],
    ['a JSON string', '"relay"'],
    ['JSON null', 'null'],
    ['an empty string', '']
  ])('gives the defaults for %s', async (_name, text) => {
    expect(await loadDirectPaySettings(fakeStorage({ [DIRECT_PAY_SETTINGS_KEY]: text }))).toEqual(
      DEFAULT_DIRECT_PAY_SETTINGS
    )
  })

  it('gives the defaults, without throwing, when storage cannot be read', async () => {
    const storage = fakeStorage()
    storage.getKeyValue.mockRejectedValueOnce(new Error('disk'))
    expect(await loadDirectPaySettings(storage)).toEqual(DEFAULT_DIRECT_PAY_SETTINGS)
  })
})

describe('saveDirectPaySettings', () => {
  it('stores the settings under the key, and loads them back', async () => {
    const storage = fakeStorage()
    const saved = await saveDirectPaySettings(storage, {
      receiveEnabled: false,
      signaling: 'relay',
      relayUrl: 'wss://relay.example.com',
      stunUrls: ['stun:stun.example.com:3478']
    })
    expect(JSON.parse(storage.map.get(DIRECT_PAY_SETTINGS_KEY) as string)).toEqual(saved)
    expect(await loadDirectPaySettings(storage)).toEqual(saved)
    expect(saved.receiveEnabled).toBe(false)
  })

  it('takes the defaults for fields left out, so the argument is the whole state', async () => {
    expect(await saveDirectPaySettings(fakeStorage(), {})).toEqual(DEFAULT_DIRECT_PAY_SETTINGS)
    expect(await saveDirectPaySettings(fakeStorage(), { signaling: 'messagebox' })).toEqual({
      ...DEFAULT_DIRECT_PAY_SETTINGS,
      signaling: 'messagebox'
    })
  })

  it('trims, and drops blank STUN lines', async () => {
    const saved = await saveDirectPaySettings(fakeStorage(), {
      relayUrl: '  wss://relay.example.com  ',
      stunUrls: [' stun:a.example.com:3478 ', '', '   ', 'stuns:b.example.com:5349']
    })
    expect(saved.relayUrl).toBe('wss://relay.example.com')
    expect(saved.stunUrls).toEqual(['stun:a.example.com:3478', 'stuns:b.example.com:5349'])
  })

  it('allows no STUN servers at all', async () => {
    expect((await saveDirectPaySettings(fakeStorage(), { stunUrls: [] })).stunUrls).toEqual([])
  })

  describe('the relay must be wss://', () => {
    it.each([
      'wss://relay.example.com',
      'wss://relay.example.com/',
      'wss://relay.example.com:8443/pay?room=1',
      'wss://relay.example.com#top',
      'wss://[::1]:8443',
      'wss://10.0.0.5:9000',
      'wss://relay.example.com:443',
      'wss://relay-1.example.com',
      'wss://localhost',
      'wss://a'
    ])('accepts %s', async relayUrl => {
      expect((await saveDirectPaySettings(fakeStorage(), { relayUrl })).relayUrl).toBe(relayUrl)
    })

    it.each([
      ['ws://relay.example.com', 'plain ws'],
      ['ws://localhost:8080', 'plain ws, even for localhost'],
      ['ws://127.0.0.1:8080', 'plain ws, even for loopback'],
      ['https://relay.example.com', 'https'],
      ['relay.example.com', 'no scheme'],
      ['WSS://relay.example.com', 'an upper-case scheme'],
      ['wss://', 'no host'],
      ['wss:///pay', 'no host before the path'],
      ['wss://user:secret@relay.example.com', 'credentials in the address'],
      ['wss://relay.example.com/a b', 'a space'],
      ['wss://relay example.com', 'a space in the host'],
      ['wss://:443', 'a port with no host'],
      ['wss://:', 'a colon with no host'],
      ['wss://[', 'an unclosed IPv6 bracket'],
      ['wss://[]', 'an empty IPv6 address'],
      ['wss://-', 'a host that starts with a hyphen'],
      ['wss://.', 'a host that is a dot'],
      ['wss://relay.example.com-', 'a host that ends with a hyphen'],
      ['wss://relay.example.com:abc', 'a port that is not a number'],
      ['wss://relay.example.com:123456', 'a port with too many digits'],
      ['wss://relay.example.com:', 'a colon with no port'],
      ['wss://relay.example.com\\pay', 'a backslash'],
      ['wss://user:123@relay.example.com', 'credentials with a numeric password'],
      ['wss://@relay.example.com', 'an empty credential']
    ])('refuses %s (%s)', async relayUrl => {
      const error = await refusal({ relayUrl })
      expect(error).toBeInstanceOf(DirectPaySettingsError)
      expect(error).toMatchObject({ code: 'relay_invalid', field: 'relayUrl' })
    })

    it('refuses what is not a string', async () => {
      expect(await refusal({ relayUrl: 42 as unknown as string })).toMatchObject({ code: 'relay_invalid' })
    })

    // A token in the query string looks like any other query, so only user:password@ is caught.
    it('does not read a query as credentials', async () => {
      const relayUrl = 'wss://relay.example.com/pay?room=1&token=abc'
      expect((await saveDirectPaySettings(fakeStorage(), { relayUrl })).relayUrl).toBe(relayUrl)
    })

    it('isRelayUrl judges the text as written, without trimming', () => {
      expect(isRelayUrl('wss://relay.example.com')).toBe(true)
      expect(isRelayUrl(' wss://relay.example.com')).toBe(false)
      expect(isRelayUrl('wss://relay.example.com ')).toBe(false)
      expect(isRelayUrl('')).toBe(false)
    })

    // URL.hostname is unreliable on Hermes, so a relay is judged by regex alone.
    it('never asks URL about it', async () => {
      const real = global.URL
      global.URL = function URL() {
        throw new Error('URL must not be used to validate an address')
      } as unknown as typeof global.URL
      try {
        const saved = await saveDirectPaySettings(fakeStorage(), {
          relayUrl: 'wss://relay.example.com',
          turn: { urls: 'turn:turn.example.com:3478', username: 'u', credential: 'c' }
        })
        expect(saved.relayUrl).toBe('wss://relay.example.com')
        expect(await refusal({ relayUrl: 'ws://relay.example.com' })).toMatchObject({ code: 'relay_invalid' })
        expect(await loadDirectPaySettings(stored({ relayUrl: 'wss://relay.example.com' }))).toMatchObject({
          relayUrl: 'wss://relay.example.com'
        })
      } finally {
        global.URL = real
      }
    })
  })

  describe('relay or message box signaling', () => {
    it('relay signaling needs a relay address', async () => {
      expect(await refusal({ signaling: 'relay', relayUrl: '' })).toMatchObject({
        code: 'relay_required',
        field: 'relayUrl'
      })
      expect(await refusal({ signaling: 'relay', relayUrl: '   ' })).toMatchObject({ code: 'relay_required' })
    })

    it('the message box does not', async () => {
      const saved = await saveDirectPaySettings(fakeStorage(), { signaling: 'messagebox', relayUrl: '' })
      expect(saved).toMatchObject({ signaling: 'messagebox', relayUrl: '' })
    })

    it('refuses any other signaling', async () => {
      expect(await refusal({ signaling: 'smoke' as unknown as 'relay' })).toMatchObject({
        code: 'signaling_invalid',
        field: 'signaling'
      })
    })
  })

  describe('STUN servers', () => {
    it.each([
      'http://stun.example.com',
      'stun.example.com:3478',
      'stun: example.com',
      'turn:turn.example.com:3478',
      'STUN:a.example.com',
      'stun://x',
      'stuns://stun.example.com:5349',
      'stun:',
      'stuns:?',
      'stun::3478',
      'stun:stun.example.com:abc',
      'stun:stun.example.com:',
      'stun:-'
    ])('refuses %s', async url => {
      expect(await refusal({ stunUrls: [url] })).toMatchObject({ code: 'stun_invalid', field: 'stunUrls' })
    })

    it.each(['stun:stun.example.com', 'stuns:stun.example.com:5349', 'stun:192.0.2.1:3478', 'stun:[2001:db8::1]:3478'])(
      'accepts %s',
      async url => {
        expect((await saveDirectPaySettings(fakeStorage(), { stunUrls: [url] })).stunUrls).toEqual([url])
        expect(isStunUrl(url)).toBe(true)
      }
    )

    it('isStunUrl judges the text as written, without trimming', () => {
      expect(isStunUrl(' stun:stun.example.com')).toBe(false)
      expect(isStunUrl('')).toBe(false)
    })

    it('refuses a list that is not a list, or an entry that is not a string', async () => {
      expect(await refusal({ stunUrls: 'stun:a.example.com:3478' as unknown as string[] })).toMatchObject({
        code: 'stun_invalid'
      })
      expect(await refusal({ stunUrls: [42 as unknown as string] })).toMatchObject({ code: 'stun_invalid' })
    })
  })

  describe('a TURN server', () => {
    const turn = { urls: 'turn:turn.example.com:3478', username: 'u', credential: 'c' }

    it('is stored with its credentials, trimmed', async () => {
      const saved = await saveDirectPaySettings(fakeStorage(), {
        turn: { urls: ' turns:turn.example.com:5349 ', username: ' u ', credential: ' c ' }
      })
      expect(saved.turn).toEqual({ urls: 'turns:turn.example.com:5349', username: 'u', credential: 'c' })
    })

    it('is none when every field is blank', async () => {
      const saved = await saveDirectPaySettings(fakeStorage(), { turn: { urls: '', username: ' ', credential: '' } })
      expect(saved).not.toHaveProperty('turn')
    })

    it('needs a turn: or turns: address', async () => {
      expect(await refusal({ turn: { ...turn, urls: 'stun:turn.example.com:3478' } })).toMatchObject({
        code: 'turn_invalid',
        field: 'turn'
      })
      expect(await refusal({ turn: { ...turn, urls: '' } })).toMatchObject({ code: 'turn_invalid' })
      expect(await refusal({ turn: { ...turn, urls: 'turn://x' } })).toMatchObject({ code: 'turn_invalid' })
      expect(await refusal({ turn: { ...turn, urls: 'turn:' } })).toMatchObject({ code: 'turn_invalid' })
    })

    it('takes a transport query', async () => {
      const urls = 'turn:turn.example.com:3478?transport=udp'
      expect((await saveDirectPaySettings(fakeStorage(), { turn: { ...turn, urls } })).turn?.urls).toBe(urls)
    })

    it('needs both a username and a credential', async () => {
      expect(await refusal({ turn: { ...turn, username: '' } })).toMatchObject({ code: 'turn_incomplete' })
      expect(await refusal({ turn: { ...turn, credential: '' } })).toMatchObject({ code: 'turn_incomplete' })
    })

    it('must be an object', async () => {
      expect(await refusal({ turn: 'turn:turn.example.com' as unknown as DirectPaySettings['turn'] })).toMatchObject({
        code: 'turn_invalid'
      })
    })
  })

  it('refuses a receive switch that is not on or off', async () => {
    expect(await refusal({ receiveEnabled: 'no' as unknown as boolean })).toMatchObject({
      code: 'receive_invalid',
      field: 'receiveEnabled'
    })
  })

  it('stores nothing when any field is refused', async () => {
    const storage = fakeStorage({ [DIRECT_PAY_SETTINGS_KEY]: JSON.stringify({ receiveEnabled: false }) })
    await expect(saveDirectPaySettings(storage, { receiveEnabled: true, relayUrl: 'ws://nope' })).rejects.toThrow()
    expect(storage.map.get(DIRECT_PAY_SETTINGS_KEY)).toBe(JSON.stringify({ receiveEnabled: false }))
  })

  it('reports a store that cannot be written', async () => {
    const storage = fakeStorage()
    storage.setKeyValue.mockRejectedValueOnce(new Error('disk full'))
    await expect(saveDirectPaySettings(storage, {})).rejects.toMatchObject({
      name: 'DirectPaySettingsError',
      code: 'storage_failed',
      message: expect.stringContaining('disk full')
    })
  })
})

describe("the host's relay and STUN servers", () => {
  const host = { relayUrl: 'wss://relay.host.example', stunUrls: ['stun:stun.host.example:3478'] }

  it('stand in for the built-in defaults when nothing is stored', async () => {
    const settings = await loadDirectPaySettings(fakeStorage(), host)
    expect(settings.relayUrl).toBe(host.relayUrl)
    expect(settings.stunUrls).toEqual(host.stunUrls)
  })

  it('give way to what the user saved', async () => {
    const storage = stored({ relayUrl: 'wss://mine.example', stunUrls: ['stun:mine.example'] })
    const settings = await loadDirectPaySettings(storage, host)
    expect(settings.relayUrl).toBe('wss://mine.example')
    expect(settings.stunUrls).toEqual(['stun:mine.example'])
  })

  it('fill the fields a save leaves out', async () => {
    const saved = await saveDirectPaySettings(fakeStorage(), { receiveEnabled: false }, host)
    expect(saved).toMatchObject({ receiveEnabled: false, relayUrl: host.relayUrl, stunUrls: host.stunUrls })
  })

  it('leave the frozen built-in list alone', async () => {
    await loadDirectPaySettings(fakeStorage(), host)
    expect(DEFAULT_DIRECT_PAY_SETTINGS.relayUrl).toBe(DEFAULT_RELAY_URL)
    expect(Object.isFrozen(DEFAULT_DIRECT_PAY_SETTINGS.stunUrls)).toBe(true)
  })
})

describe('iceServersFrom', () => {
  it('lists the STUN servers together, then TURN with its credentials', () => {
    expect(
      iceServersFrom({
        stunUrls: ['stun:a.example.com:3478', 'stun:b.example.com:3478'],
        turn: { urls: 'turn:turn.example.com:3478', username: 'u', credential: 'c' }
      })
    ).toEqual([
      { urls: ['stun:a.example.com:3478', 'stun:b.example.com:3478'] },
      { urls: 'turn:turn.example.com:3478', username: 'u', credential: 'c' }
    ])
  })

  it('leaves out what is not set', () => {
    expect(iceServersFrom({ stunUrls: ['stun:a.example.com:3478'] })).toEqual([{ urls: ['stun:a.example.com:3478'] }])
    expect(
      iceServersFrom({ stunUrls: [], turn: { urls: 'turn:t.example.com', username: 'u', credential: 'c' } })
    ).toEqual([{ urls: 'turn:t.example.com', username: 'u', credential: 'c' }])
    expect(iceServersFrom({ stunUrls: [] })).toEqual([])
  })

  it('copies the list, so a caller cannot change the settings through it', () => {
    const settings = { stunUrls: ['stun:a.example.com:3478'] }
    const servers = iceServersFrom(settings)
    ;(servers[0].urls as string[]).push('stun:evil.example.com')
    expect(settings.stunUrls).toEqual(['stun:a.example.com:3478'])
  })

  it('is what the defaults give the connection', () => {
    expect(iceServersFrom(DEFAULT_DIRECT_PAY_SETTINGS)).toEqual([{ urls: DEFAULT_DIRECT_PAY_SETTINGS.stunUrls }])
  })
})
