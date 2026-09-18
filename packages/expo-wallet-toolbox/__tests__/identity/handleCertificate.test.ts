import {
  isValidHandleFormat,
  checkHandleAvailability,
  registerHandle,
  HANDLE_CERT_TYPE,
  type HandleCertWallet
} from '../../core/identity/handleCertificate'
import type { HandleCertifierConfig } from '../../core/toolboxConfig'
import type { IdentityClient } from '@bsv/sdk'

const CERTIFIER: HandleCertifierConfig = {
  certifierIdentityKey: '02' + 'aa'.repeat(32),
  certifierUrl: 'https://certifier.example'
}

function idClientResolving(names: string[]): IdentityClient {
  return {
    resolveByAttributes: jest.fn().mockResolvedValue(names.map(name => ({ identityKey: 'ff'.repeat(32), name })))
  } as unknown as IdentityClient
}

describe('isValidHandleFormat', () => {
  it.each(['dee', 'de_gen-1', 'a'.repeat(20)])('accepts %s', h => expect(isValidHandleFormat(h)).toBe(true))
  it.each(['de', 'a'.repeat(21), 'Dee', 'de gen', 'dee!'])('rejects %s', h =>
    expect(isValidHandleFormat(h)).toBe(false)
  )
})

describe('checkHandleAvailability', () => {
  it('rejects an invalid handle before asking the overlay', async () => {
    const client = idClientResolving([])
    expect(await checkHandleAvailability(client, 'x')).toBe('invalid')
    expect(client.resolveByAttributes).not.toHaveBeenCalled()
  })

  it('reports available when nobody resolves to that exact name', async () => {
    const client = idClientResolving(['someone-else'])
    expect(await checkHandleAvailability(client, 'dee')).toBe('available')
  })

  it('reports taken when the overlay already resolves this exact name', async () => {
    const client = idClientResolving(['dee'])
    expect(await checkHandleAvailability(client, 'dee')).toBe('taken')
  })

  it('fails open to "failed" on an overlay error, never throwing', async () => {
    const client = { resolveByAttributes: jest.fn().mockRejectedValue(new Error('offline')) } as unknown as IdentityClient
    expect(await checkHandleAvailability(client, 'dee')).toBe('failed')
  })
})

describe('registerHandle', () => {
  const idClient = () => ({ publiclyRevealAttributes: jest.fn().mockResolvedValue({}) }) as unknown as IdentityClient

  it('returns invalid without touching the wallet or the certifier', async () => {
    const wallet: HandleCertWallet = { acquireCertificate: jest.fn() }
    const result = await registerHandle({ wallet, idClient: idClient(), certifier: CERTIFIER, handle: 'x' })
    expect(result).toEqual({ kind: 'invalid' })
    expect(wallet.acquireCertificate).not.toHaveBeenCalled()
  })

  it('returns unavailable when no certifier is configured', async () => {
    const wallet: HandleCertWallet = { acquireCertificate: jest.fn() }
    const result = await registerHandle({ wallet, idClient: idClient(), certifier: undefined, handle: 'dee' })
    expect(result).toEqual({ kind: 'unavailable' })
    expect(wallet.acquireCertificate).not.toHaveBeenCalled()
  })

  it('acquires the certificate against the configured certifier, then reveals it', async () => {
    const cert = { type: HANDLE_CERT_TYPE, fields: { handle: 'dee' } }
    const wallet: HandleCertWallet = { acquireCertificate: jest.fn().mockResolvedValue(cert) }
    const client = idClient()
    const result = await registerHandle({ wallet, idClient: client, certifier: CERTIFIER, handle: 'dee' })
    expect(result).toEqual({ kind: 'registered' })
    expect(wallet.acquireCertificate).toHaveBeenCalledWith(
      expect.objectContaining({
        type: HANDLE_CERT_TYPE,
        certifier: CERTIFIER.certifierIdentityKey,
        acquisitionProtocol: 'issuance',
        fields: { handle: 'dee' },
        certifierUrl: CERTIFIER.certifierUrl
      }),
      undefined
    )
    expect(client.publiclyRevealAttributes).toHaveBeenCalledWith(cert, ['handle'])
  })

  it('reports failed with the underlying message on a throw', async () => {
    const wallet: HandleCertWallet = { acquireCertificate: jest.fn().mockRejectedValue(new Error('no network')) }
    const result = await registerHandle({ wallet, idClient: idClient(), certifier: CERTIFIER, handle: 'dee' })
    expect(result).toEqual({ kind: 'failed', message: 'no network' })
  })
})
