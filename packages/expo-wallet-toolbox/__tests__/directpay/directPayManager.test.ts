/**
 * DirectPayManager (core/directpay/DirectPayManager.ts) with @bsv/webrtpay's client and
 * signalers replaced by fakes, as BSV Desktop's test/directPayManager.test.ts replaces them. The
 * manager picks the signaler from the device settings, receives only while the user left
 * receiving on and the app is in the foreground, falls back to the message box when the relay
 * cannot be reached, takes payments into the wallet at once and announces each once.
 */
import {
  DIAL_MS,
  DirectPayManager,
  RELAY_RETRY_FIRST_MS,
  RELAY_START_MS,
  RETRY_FIRST_MS,
  signalBox,
  type DirectPayManagerDeps,
  type DirectPayStartOptions
} from '../../core/directpay/DirectPayManager'
import { DEFAULT_DIRECT_PAY_SETTINGS, iceServersFrom } from '../../core/directpay/settings'
import { listKeptDirectPayments } from '../../core/directpay/receive'
import { loadWebRTPay, type WebRTPayModule } from '../../core/directpay/webrtpay'
import type { DirectPaySettings } from '../../core/directpay/types'
import i18n from '../../core/i18n/translations'
import { P2PKH, PrivateKey, Transaction } from '@bsv/sdk'

const real = loadWebRTPay() as WebRTPayModule
const IDENTITY = `02${'42'.repeat(32)}`
const SENDER = `03${'17'.repeat(32)}`
const HOST = 'https://messagebox.example'

type Fake = Record<string, any>

function fakeModule() {
  const made = { clients: [] as Fake[], messageBoxes: [] as Fake[], relays: [] as Fake[] }
  const accept = jest.fn(async (_wallet: unknown, p: any, _options?: Fake) => ({
    txid: 'ab'.repeat(32),
    status: 'accepted' as const,
    p
  }))
  const module = {
    DirectPayClient: jest.fn(function (this: unknown, options: Fake) {
      const client: Fake = {
        options,
        handlers: undefined,
        startReceiving: jest.fn(async (h: Fake) => {
          client.handlers = h
        }),
        stopReceiving: jest.fn(async () => {}),
        connect: jest.fn(),
        sendPayment: jest.fn(),
        close: jest.fn(async () => {})
      }
      made.clients.push(client)
      return client
    }),
    MessageBoxSignaler: jest.fn(function (this: unknown, client: Fake, options: Fake) {
      const signaler = { client, options, send: jest.fn(), listen: jest.fn() }
      made.messageBoxes.push(signaler)
      return signaler
    }),
    RelaySignaler: jest.fn(function (this: unknown, options: Fake) {
      const provider = async () => []
      const signaler = {
        options,
        provider,
        turnProvider: jest.fn(() => provider),
        listen: jest.fn(async () => async () => {}),
        send: jest.fn(),
        close: jest.fn(async () => {})
      }
      made.relays.push(signaler)
      return signaler
    }),
    WebRTPayError: real.WebRTPayError,
    acceptDirectPayment: accept,
    validatePaymentToken: real.validatePaymentToken,
    MAX_DIRECT_TRANSACTION_BYTES: real.MAX_DIRECT_TRANSACTION_BYTES
  }
  return { made, accept, module: module as unknown as WebRTPayModule }
}

function memoryStorage() {
  const map = new Map<string, string>()
  return {
    map,
    getKeyValue: async (k: string) => map.get(k),
    setKeyValue: async (k: string, v: string) => void map.set(k, v)
  }
}

function peerPayClient() {
  return {
    sendMessage: jest.fn(),
    listMessages: jest.fn(async () => []),
    acknowledgeMessage: jest.fn(),
    sendLiveMessage: jest.fn(),
    listenForLiveMessages: jest.fn(),
    resolveHostForRecipient: jest.fn()
  }
}

const wallet = { getPublicKey: jest.fn(), internalizeAction: jest.fn() } as never

const managers: DirectPayManager[] = []

function setup(deps: Partial<DirectPayManagerDeps> = {}) {
  const fake = fakeModule()
  const storage = memoryStorage()
  const onToast = jest.fn()
  let online: ((online: boolean) => void) | undefined
  const manager = new DirectPayManager({
    webrtpay: fake.module,
    storage,
    onToast,
    subscribeOnline: cb => {
      online = cb
      return () => {
        online = undefined
      }
    },
    ...deps
  })
  managers.push(manager)
  const options = (
    o: Partial<DirectPayStartOptions> = {},
    settings: Partial<DirectPaySettings> = {}
  ): DirectPayStartOptions => ({
    wallet,
    originator: 'admin.com',
    identity: IDENTITY,
    chain: 'main',
    peerPayClient: peerPayClient(),
    messageBoxUrl: HOST,
    settings: { ...DEFAULT_DIRECT_PAY_SETTINGS, stunUrls: [...DEFAULT_DIRECT_PAY_SETTINGS.stunUrls], ...settings },
    ...o
  })
  return { ...fake, storage, onToast, manager, options, goOnline: () => online?.(true) }
}

afterEach(async () => {
  // Stopping clears every timer the manager set (relay fallback, kept-payment retries).
  await Promise.all(managers.splice(0).map(m => m.stop()))
  jest.useRealTimers()
})

describe('DirectPayManager', () => {
  it('signals through the relay by default, with its TURN servers, and is online once the relay accepts', async () => {
    const { made, manager, options } = setup()
    const RTCPeerConnection = function FakePc() {}
    await manager.start(options({ RTCPeerConnection }))
    expect(made.relays).toHaveLength(1)
    expect(made.relays[0].options).toMatchObject({
      url: DEFAULT_DIRECT_PAY_SETTINGS.relayUrl,
      wallet,
      originator: 'admin.com'
    })
    const client = made.clients[0]
    expect(client.options).toMatchObject({ chain: 'main', signaler: made.relays[0], timeouts: { dialMs: DIAL_MS } })
    expect(client.options.rtc).toEqual({ iceServers: iceServersFrom(DEFAULT_DIRECT_PAY_SETTINGS), RTCPeerConnection })
    expect(client.options.iceServersProvider).toBe(made.relays[0].provider)
    expect(client.startReceiving).toHaveBeenCalledTimes(1)
    expect(manager.getSnapshot()).toMatchObject({ status: 'starting', via: 'relay', client })

    made.relays[0].options.onStateChange('online')
    expect(manager.getSnapshot()).toMatchObject({ status: 'online', via: 'relay', error: '' })
  })

  it('does nothing when started again with the same inputs', async () => {
    const { made, manager, options } = setup()
    const o = options()
    await manager.start(o)
    await manager.start({ ...o, settings: { ...o.settings } })
    expect(made.clients).toHaveLength(1)
  })

  it('keeps a client for sending but does not receive when the user turned receiving off', async () => {
    const { made, manager, options } = setup()
    await manager.start(options({}, { receiveEnabled: false }))
    expect(made.clients[0].startReceiving).not.toHaveBeenCalled()
    expect(manager.getSnapshot()).toMatchObject({ status: 'off', via: 'relay' })
    expect(manager.getSnapshot().client).toBe(made.clients[0])
  })

  it("signals through this network's message box, online once a poll works", async () => {
    const { made, manager, options } = setup()
    const box = peerPayClient()
    await manager.start(options({ chain: 'test', peerPayClient: box }, { signaling: 'messagebox' }))
    const signaler = made.messageBoxes[0]
    expect(signaler.options).toEqual({ host: HOST, messageBox: signalBox('test') })
    expect(signalBox('main')).toBe('webrtpay_signals')
    expect(made.relays).toHaveLength(0)
    // The live websocket calls are passed on, so a dial is not left to polling.
    expect(typeof signaler.client.listenForLiveMessages).toBe('function')
    expect(typeof signaler.client.resolveHostForRecipient).toBe('function')

    await signaler.client.listMessages({ messageBox: signalBox('test') })
    expect(manager.getSnapshot()).toMatchObject({ status: 'online', via: 'messagebox' })
    box.listMessages.mockRejectedValue(new Error('down'))
    await expect(signaler.client.listMessages({ messageBox: 'x' })).rejects.toThrow('down')
    expect(manager.getSnapshot().status).toBe('online')
    await expect(signaler.client.listMessages({ messageBox: 'x' })).rejects.toThrow('down')
    expect(manager.getSnapshot()).toMatchObject({ status: 'error' })
  })

  it('is not set up (a notice, not an error) on the message box without one', async () => {
    const { made, manager, options } = setup()
    await manager.start(options({ peerPayClient: null }, { signaling: 'messagebox' }))
    expect(manager.getSnapshot()).toMatchObject({ status: 'off', via: null, error: '' })
    expect(manager.getSnapshot().notice).not.toBe('')
    expect(made.clients[0].startReceiving).not.toHaveBeenCalled()
  })

  it('receives through the message box when the relay does not accept this wallet in time, then goes back', async () => {
    jest.useFakeTimers()
    const { made, manager, options } = setup()
    await manager.start(options())
    await jest.advanceTimersByTimeAsync(RELAY_START_MS)
    expect(manager.getSnapshot()).toMatchObject({ via: 'messagebox', relayUnreachable: true })
    expect(made.clients[0].close).toHaveBeenCalled()
    expect(made.clients[1].options.signaler).toBe(made.messageBoxes[0])
    expect(made.clients[1].options.iceServersProvider).toBeUndefined()

    // The relay is retried after the first wait, and receiving moves back once it accepts.
    await jest.advanceTimersByTimeAsync(RELAY_RETRY_FIRST_MS)
    const retry = made.relays[1]
    expect(retry.listen).toHaveBeenCalled()
    retry.options.onStateChange('online')
    await jest.advanceTimersByTimeAsync(0)
    expect(retry.close).toHaveBeenCalled()
    expect(manager.getSnapshot()).toMatchObject({ via: 'relay', relayUnreachable: false })
    expect(made.clients[2].options.signaler).toBe(made.relays[2])
  })

  it('shows the relay error when there is no message box to fall back to', async () => {
    const { made, manager, options } = setup()
    await manager.start(options({ peerPayClient: null }))
    made.relays[0].options.onStateChange('offline', new real.WebRTPayError('rejected', 'nope'))
    expect(manager.getSnapshot().status).toBe('error')
    expect(made.clients).toHaveLength(1)
  })

  it('receives only in the foreground', async () => {
    const { made, manager, options } = setup()
    await manager.start(options())
    manager.setForeground(false)
    await Promise.resolve()
    expect(made.clients[0].close).toHaveBeenCalled()
    expect(made.clients[1].startReceiving).not.toHaveBeenCalled()
    expect(manager.getSnapshot()).toMatchObject({ status: 'off', background: true, client: made.clients[1] })

    manager.setForeground(true)
    await new Promise(r => setTimeout(r, 0))
    expect(made.clients[2].startReceiving).toHaveBeenCalledTimes(1)
    expect(manager.getSnapshot()).toMatchObject({ status: 'starting', background: false })
  })

  it('starts in the background without receiving when told so', async () => {
    const { made, manager, options } = setup({ foreground: false })
    await manager.start(options())
    expect(made.clients[0].startReceiving).not.toHaveBeenCalled()
    expect(manager.getSnapshot().background).toBe(true)
  })

  it('takes a payment into the wallet and announces it once', async () => {
    const { made, accept, onToast, manager, options } = setup()
    const onReceived = jest.fn()
    manager.setCallbacks({ onReceived })
    await manager.start(options())
    const payment = {
      messageId: 'p1',
      sender: SENDER,
      token: {
        customInstructions: { derivationPrefix: 'AA==', derivationSuffix: 'AQ==' },
        transaction: [1],
        amount: 500
      }
    }
    await expect(made.clients[0].handlers.onPayment(payment, { note: 'tea', txid: 'ab'.repeat(32) })).resolves.toBe(
      'accepted'
    )
    expect(accept.mock.calls[0][2]).toMatchObject({
      labels: ['peerpay'],
      description: 'tea  ',
      originator: 'admin.com'
    })
    expect(onToast).toHaveBeenCalledWith(i18n.t('payment_arrived'), { type: 'success' })
    expect(onReceived).toHaveBeenCalledWith({ amount: 500, sender: SENDER, status: 'accepted' })
    expect(manager.getSnapshot().received).toBe(1)

    accept.mockResolvedValueOnce({ txid: 'ab'.repeat(32), status: 'duplicate' } as never)
    await made.clients[0].handlers.onPayment(payment, { txid: 'ab'.repeat(32) })
    expect(onToast).toHaveBeenCalledTimes(1)
    expect(manager.getSnapshot().received).toBe(1)
  })

  it('keeps a payment the wallet cannot take yet, and retries it after the first wait and when back online', async () => {
    jest.useFakeTimers()
    const { made, accept, storage, manager, options, goOnline } = setup()
    const o = options({}, { signaling: 'messagebox' })
    await manager.start(o)
    const store = { storage, identity: IDENTITY, chain: 'main' }
    const tx = new Transaction()
    tx.addOutput({ lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()), satoshis: 900 })
    const payment = {
      messageId: 'p2',
      sender: SENDER,
      token: {
        customInstructions: { derivationPrefix: 'AA==', derivationSuffix: 'Ag==' },
        transaction: tx.toAtomicBEEF(),
        amount: 900
      }
    }
    accept.mockRejectedValueOnce(new Error('database is locked'))
    await expect(made.clients[0].handlers.onPayment(payment, { txid: tx.id('hex') })).resolves.toBe('received')
    expect((await listKeptDirectPayments(store)).payments).toHaveLength(1)

    accept.mockRejectedValueOnce(new Error('database is locked'))
    await jest.advanceTimersByTimeAsync(RETRY_FIRST_MS)
    expect((await listKeptDirectPayments(store)).payments).toHaveLength(1)

    goOnline()
    await jest.advanceTimersByTimeAsync(0)
    expect((await listKeptDirectPayments(store)).payments).toHaveLength(0)
  })

  it('tells the user when a kept payment needs attention', async () => {
    const { made, accept, onToast, manager, options } = setup()
    await manager.start(options({}, { signaling: 'messagebox' }))
    const tx = new Transaction()
    tx.addOutput({ lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()), satoshis: 1234 })
    const payment = {
      messageId: 'p3',
      sender: SENDER,
      token: {
        customInstructions: { derivationPrefix: 'AA==', derivationSuffix: 'Aw==' },
        transaction: tx.toAtomicBEEF(),
        amount: 1234
      }
    }
    accept.mockRejectedValueOnce(new Error('database is locked'))
    await made.clients[0].handlers.onPayment(payment, { txid: tx.id('hex') })
    accept.mockRejectedValueOnce(new Error('doubleSpend'))
    manager.setForeground(false)
    manager.setForeground(true) // the return to the foreground runs a pass
    await new Promise(r => setTimeout(r, 0))
    expect(onToast).toHaveBeenLastCalledWith(
      i18n.t('direct_pay_kept_needs_attention', { amount: (1234).toLocaleString(), name: `${SENDER.slice(0, 8)}…` }),
      { type: 'error' }
    )
  })

  it('says its own signaling is down when the relay failed or the device is offline', async () => {
    let deviceOnline = true
    const { made, manager, options } = setup({ getOnline: async () => deviceOnline })
    await manager.start(options({}, { receiveEnabled: false }))
    await expect(manager.signalingDown()).resolves.toBe(false)
    made.relays[0].options.onStateChange('offline', new real.WebRTPayError('rejected', 'unreachable'))
    await expect(manager.signalingDown()).resolves.toBe(true)
    made.relays[0].options.onStateChange('online')
    await expect(manager.signalingDown()).resolves.toBe(false)
    deviceOnline = false
    await expect(manager.signalingDown()).resolves.toBe(true)
  })

  it('stop closes the client and the relay and clears the snapshot', async () => {
    const { made, manager, options } = setup()
    await manager.start(options())
    const seen: unknown[] = []
    manager.subscribe(s => seen.push(s))
    await manager.stop()
    expect(made.clients[0].close).toHaveBeenCalled()
    expect(made.relays[0].close).toHaveBeenCalled()
    expect(manager.getSnapshot()).toMatchObject({ client: null, status: 'off', via: null })
    expect(seen).toHaveLength(1)
  })
})
