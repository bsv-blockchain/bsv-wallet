import {
  publishDisplayName,
  DISPLAY_NAME_CERT_TYPE,
  type ProfileCertWallet
} from '../../core/identity/profileCertificate'
import type { IdentityClient } from '@bsv/sdk'

const OWN_KEY = '03' + 'cc'.repeat(32)

function idClient() {
  return { publiclyRevealAttributes: jest.fn().mockResolvedValue({}) } as unknown as IdentityClient
}

describe('publishDisplayName', () => {
  it('refuses an empty name without touching the wallet', async () => {
    const wallet: ProfileCertWallet = { getPublicKey: jest.fn(), acquireCertificate: jest.fn() }
    const result = await publishDisplayName({ wallet, idClient: idClient(), displayName: '   ' })
    expect(result).toEqual({ kind: 'failed', message: 'Display name cannot be empty' })
    expect(wallet.acquireCertificate).not.toHaveBeenCalled()
  })

  it('self-certifies with the wallet’s own identity key, then reveals it', async () => {
    const cert = { type: DISPLAY_NAME_CERT_TYPE, fields: { displayName: 'Dee' } }
    const wallet: ProfileCertWallet = {
      getPublicKey: jest.fn().mockResolvedValue({ publicKey: OWN_KEY }),
      acquireCertificate: jest.fn().mockResolvedValue(cert)
    }
    const client = idClient()
    const result = await publishDisplayName({ wallet, idClient: client, displayName: 'Dee' })
    expect(result).toEqual({ kind: 'published' })
    expect(wallet.acquireCertificate).toHaveBeenCalledWith(
      expect.objectContaining({
        type: DISPLAY_NAME_CERT_TYPE,
        certifier: OWN_KEY,
        acquisitionProtocol: 'direct',
        fields: { displayName: 'Dee' }
      }),
      undefined
    )
    expect(client.publiclyRevealAttributes).toHaveBeenCalledWith(cert, ['displayName'])
  })

  it('reports failed with the underlying message on a throw', async () => {
    const wallet: ProfileCertWallet = {
      getPublicKey: jest.fn().mockResolvedValue({ publicKey: OWN_KEY }),
      acquireCertificate: jest.fn().mockRejectedValue(new Error('no network'))
    }
    const result = await publishDisplayName({ wallet, idClient: idClient(), displayName: 'Dee' })
    expect(result).toEqual({ kind: 'failed', message: 'no network' })
  })
})
