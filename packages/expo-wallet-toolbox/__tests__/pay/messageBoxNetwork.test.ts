import AsyncStorage from '@react-native-async-storage/async-storage'
import { MessageBoxClient, PeerPayClient } from '@bsv/message-box-client'
import { LookupResolver, PrivateKey, ProtoWallet, type WalletInterface } from '@bsv/sdk'
import {
  bindMessageBoxNetwork,
  DEFAULT_MESSAGE_BOX_URL,
  defaultMessageBoxUrlFor,
  LEGACY_MESSAGE_BOX_URL,
  makePeerPayClient,
  NO_MESSAGE_BOX,
  readMessageBoxUrl,
  resolveMessageBoxUrl
} from '../../core/pay/rails/handle'
import { configureToolbox, resetToolboxConfig } from '../../core/toolboxConfig'

// Routing never signs: a key-only wallet is enough to construct the clients.
const wallet = new ProtoWallet(PrivateKey.fromRandom()) as unknown as WalletInterface

afterEach(async () => {
  resetToolboxConfig()
  await AsyncStorage.clear()
})

describe('resolveMessageBoxUrl', () => {
  it('gives each network its own server by default', () => {
    expect(resolveMessageBoxUrl(null, 'main')).toBe('https://messagebox.bsvblockchain.tech')
    expect(resolveMessageBoxUrl(null, 'test')).toBe('https://messagebox-testnet.bsvblockchain.tech')
    expect(resolveMessageBoxUrl(null, 'teratest')).toBe('https://messagebox-ttn.bsvblockchain.tech')
    expect(resolveMessageBoxUrl(null, 'scaletest')).toBe('https://messagebox-tstn.bsvblockchain.tech')
  })

  // Until each network had a server, every network used mainnet's: a test
  // profile that saved it saved the default, not a choice of mainnet's box.
  it("reads any network's default, or the retired one, as the default", () => {
    expect(resolveMessageBoxUrl(DEFAULT_MESSAGE_BOX_URL, 'teratest')).toBe('https://messagebox-ttn.bsvblockchain.tech')
    expect(resolveMessageBoxUrl('https://messagebox-testnet.bsvblockchain.tech', 'main')).toBe(DEFAULT_MESSAGE_BOX_URL)
    expect(resolveMessageBoxUrl(LEGACY_MESSAGE_BOX_URL, 'test')).toBe('https://messagebox-testnet.bsvblockchain.tech')
  })

  it('keeps a server the user chose, and keeps MessageBox off when they turned it off', () => {
    expect(resolveMessageBoxUrl('https://mb.example.com', 'teratest')).toBe('https://mb.example.com')
    expect(resolveMessageBoxUrl(NO_MESSAGE_BOX, 'teratest')).toBeUndefined()
  })

  it("uses the host's configured default, and only a safe one", () => {
    configureToolbox({ backupUrl: null, services: { teratest: { messageBoxUrl: 'https://mb.example.com/' } } })
    expect(defaultMessageBoxUrlFor('teratest')).toBe('https://mb.example.com')
    configureToolbox({ backupUrl: null, services: { teratest: { messageBoxUrl: 'http://mb.example.com' } } })
    expect(defaultMessageBoxUrlFor('teratest')).toBe('https://messagebox-ttn.bsvblockchain.tech')
  })

  it('reads the named profile’s preference', async () => {
    await AsyncStorage.setItem('message_box_url__p2', 'https://mb.example.com')
    expect(await readMessageBoxUrl('test', 2)).toBe('https://mb.example.com')
    expect(await readMessageBoxUrl('test')).toBe('https://messagebox-testnet.bsvblockchain.tech')
  })
})

describe('bindMessageBoxNetwork', () => {
  // Pins the two fields MessageBoxClient reads for routing. If an upgrade
  // renames them this fails, instead of routing through mainnet's overlay again.
  it('points a PeerPayClient at the network’s overlay — the constructor alone cannot', () => {
    const client = new PeerPayClient({
      messageBoxHost: 'https://messagebox-ttn.bsvblockchain.tech',
      walletClient: wallet
    })
    expect((client as any).networkPreset).toBe('mainnet')
    bindMessageBoxNetwork(client, 'teratest')
    expect((client as any).networkPreset).toBe('teratestnet')
    expect((client as any).lookupResolver).toBeInstanceOf(LookupResolver)
  })

  it('routes to the configured host when the network has no overlay', async () => {
    const client = bindMessageBoxNetwork(
      new MessageBoxClient({ host: 'https://messagebox-tstn.bsvblockchain.tech', walletClient: wallet }),
      'scaletest'
    )
    expect((client as any).networkPreset).toBe('local')
    const recipient = PrivateKey.fromRandom().toPublicKey().toString()
    await expect(client.resolveHostForRecipient(recipient)).resolves.toBe('https://messagebox-tstn.bsvblockchain.tech')
  })

  it('makePeerPayClient binds the client it builds', () => {
    const client = makePeerPayClient({
      wallet,
      messageBoxUrl: 'https://messagebox-testnet.bsvblockchain.tech',
      network: 'test'
    })
    expect((client as any).networkPreset).toBe('testnet')
  })
})
