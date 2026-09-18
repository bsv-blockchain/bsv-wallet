import {
  publishDisplayName,
  DISPLAY_NAME_CERT_TYPE,
  NO_REVOCATION_OUTPOINT,
  type ProfileCertWallet
} from '../../core/identity/profileCertificate'
import type { IdentityClient } from '@bsv/sdk'

const OWN_KEY = '03' + 'cc'.repeat(32)
const ORIGINATOR = 'urn:test:admin'

function idClient() {
  return { publiclyRevealAttributes: jest.fn().mockResolvedValue({}) } as unknown as IdentityClient
}

/** A wallet that can play certifier: identity key, field-key wrapping, signing. */
function certifyingWallet(acquired: unknown = { type: DISPLAY_NAME_CERT_TYPE }): ProfileCertWallet {
  return {
    getPublicKey: jest.fn().mockResolvedValue({ publicKey: OWN_KEY }),
    encrypt: jest.fn().mockResolvedValue({ ciphertext: [1, 2, 3] }),
    createSignature: jest.fn().mockResolvedValue({ signature: [4, 5, 6] }),
    acquireCertificate: jest.fn().mockResolvedValue(acquired)
  }
}

describe('publishDisplayName', () => {
  it('refuses an empty name without touching the wallet', async () => {
    const wallet = certifyingWallet()
    const result = await publishDisplayName({ wallet, idClient: idClient(), displayName: '   ' })
    expect(result).toEqual({ kind: 'failed', message: 'Display name cannot be empty' })
    expect(wallet.acquireCertificate).not.toHaveBeenCalled()
    expect(wallet.createSignature).not.toHaveBeenCalled()
  })

  // 2026-09-18: every save failed with `The serialNumber parameter must be valid
  // when acquisitionProtocol is "direct"`. 'direct' stores an already-issued
  // certificate, so the wallet has to issue and sign one first — as its own
  // certifier — and hand over everything the SDK validator demands.
  it('issues, signs and stores a self-certified certificate, then reveals it', async () => {
    const cert = { type: DISPLAY_NAME_CERT_TYPE, fields: { displayName: 'enc' } }
    const wallet = certifyingWallet(cert)
    const client = idClient()

    const result = await publishDisplayName({
      wallet,
      idClient: client,
      adminOriginator: ORIGINATOR,
      displayName: 'Dee'
    })

    expect(result).toEqual({ kind: 'published' })
    const [args, originator] = (wallet.acquireCertificate as jest.Mock).mock.calls[0]
    expect(originator).toBe(ORIGINATOR)
    expect(args).toMatchObject({
      type: DISPLAY_NAME_CERT_TYPE,
      certifier: OWN_KEY,
      acquisitionProtocol: 'direct',
      revocationOutpoint: NO_REVOCATION_OUTPOINT,
      signature: '040506',
      keyringRevealer: 'certifier'
    })
    // 32 random bytes, base64.
    expect(typeof args.serialNumber).toBe('string')
    expect(Buffer.from(args.serialNumber, 'base64')).toHaveLength(32)
    // The field is stored encrypted, never as the plaintext name; the keyring
    // carries the wrapped field key under the same field name.
    expect(Object.keys(args.fields)).toEqual(['displayName'])
    expect(args.fields.displayName).not.toBe('Dee')
    expect(args.keyringForSubject).toEqual({ displayName: Buffer.from([1, 2, 3]).toString('base64') })
    expect(client.publiclyRevealAttributes).toHaveBeenCalledWith(cert, ['displayName'])
  })

  it('wraps the field key for itself and signs as certifier, all under the admin originator', async () => {
    const wallet = certifyingWallet()
    await publishDisplayName({ wallet, idClient: idClient(), adminOriginator: ORIGINATOR, displayName: 'Dee' })

    const [encryptArgs, encryptOriginator] = (wallet.encrypt as jest.Mock).mock.calls[0]
    expect(encryptOriginator).toBe(ORIGINATOR)
    expect(encryptArgs.counterparty).toBe('self')

    const [signArgs, signOriginator] = (wallet.createSignature as jest.Mock).mock.calls[0]
    expect(signOriginator).toBe(ORIGINATOR)
    expect(signArgs.protocolID).toEqual([2, 'certificate signature'])
    expect(signArgs.keyID).toMatch(new RegExp(`^${DISPLAY_NAME_CERT_TYPE.replace(/[+/=]/g, '\\$&')} `))
  })

  it('reports failed with the underlying message on a throw', async () => {
    const wallet = certifyingWallet()
    ;(wallet.acquireCertificate as jest.Mock).mockRejectedValue(new Error('no network'))
    const result = await publishDisplayName({ wallet, idClient: idClient(), displayName: 'Dee' })
    expect(result).toEqual({ kind: 'failed', message: 'no network' })
  })
})
