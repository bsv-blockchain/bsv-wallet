import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  DEFAULT_UNVERIFIED_SEEK_FLAGS,
  DEFAULT_VERIFIED_SEEK_FLAGS,
  SEEK_FLAG_DISCLOSURE,
  SEEK_FLAG_KEYS,
  effectiveUnverified,
  loadStoredPolicy,
  resolvePermissionPolicy,
  saveStoredPolicy,
  type PermissionPolicy,
  type SeekFlags
} from '../../core/bridge/permissionPolicy'
import { configureToolbox, resetToolboxConfig } from '../../core/toolboxConfig'

// The literal WalletContext.tsx held before the policy object existed, copied by value.
const OLD_LITERAL: SeekFlags = {
  seekBasketInsertionPermissions: false,
  seekBasketListingPermissions: false,
  seekBasketRemovalPermissions: false,
  seekCertificateAcquisitionPermissions: false,
  seekCertificateDisclosurePermissions: false,
  seekCertificateRelinquishmentPermissions: false,
  seekCertificateListingPermissions: false,
  seekGroupedPermission: true,
  seekPermissionsForIdentityKeyRevelation: false,
  seekPermissionsForIdentityResolution: false,
  seekPermissionsForKeyLinkageRevelation: false,
  seekPermissionsForPublicKeyRevelation: false,
  seekPermissionWhenApplyingActionLabels: false,
  seekPermissionWhenListingActionsByLabel: false,
  seekProtocolPermissionsForEncrypting: false,
  seekProtocolPermissionsForHMAC: false,
  seekProtocolPermissionsForSigning: true,
  seekSpendingPermissions: true
}

const allFlags = (v: boolean): SeekFlags => Object.fromEntries(SEEK_FLAG_KEYS.map(k => [k, v])) as unknown as SeekFlags

// A deterministic stand-in for the admin wallet: the tag is a keyed digest of the message.
function fakeAdminWallet(secret = 1) {
  const mac = (data: number[]) => {
    let h = secret
    const out: number[] = []
    for (let i = 0; i < 32; i++) {
      for (const b of data) h = (h * 31 + b + i) >>> 0
      out.push(h & 255)
    }
    return out
  }
  return {
    createHmac: jest.fn(async (args: any) => ({ hmac: mac(args.data) })),
    verifyHmac: jest.fn(async (args: any) => {
      const expected = mac(args.data)
      if (expected.length !== args.hmac.length || expected.some((b, i) => b !== args.hmac[i])) {
        throw new Error('HMAC is not valid')
      }
      return { valid: true as const }
    })
  } as any
}

beforeEach(async () => {
  await AsyncStorage.clear()
  resetToolboxConfig()
})

describe('permission policy', () => {
  it('verified defaults equal the old literal', () => {
    expect(DEFAULT_VERIFIED_SEEK_FLAGS).toStrictEqual(OLD_LITERAL)
    expect(Object.keys(DEFAULT_VERIFIED_SEEK_FLAGS).sort()).toEqual([...SEEK_FLAG_KEYS].sort())
    expect(resolvePermissionPolicy().verified).toStrictEqual(OLD_LITERAL)
  })

  it('unverified defaults ask for baskets', () => {
    expect(DEFAULT_UNVERIFIED_SEEK_FLAGS).toStrictEqual({
      ...OLD_LITERAL,
      seekBasketInsertionPermissions: true,
      seekBasketListingPermissions: true,
      seekBasketRemovalPermissions: true
    })
  })

  it('effective unverified never looser', () => {
    const verified = allFlags(false)
    verified.seekCertificateListingPermissions = true
    const eff = effectiveUnverified({ verified, unverified: allFlags(false) })
    for (const k of SEEK_FLAG_KEYS) if (verified[k]) expect(eff[k]).toBe(true)
    expect(effectiveUnverified({ verified: OLD_LITERAL, unverified: allFlags(false) })).toStrictEqual(OLD_LITERAL)
  })

  it('forced flags', () => {
    const eff = effectiveUnverified({ verified: allFlags(false), unverified: allFlags(false) })
    expect(eff.seekSpendingPermissions).toBe(true)
    expect(eff.seekProtocolPermissionsForSigning).toBe(true)
    expect(eff.seekGroupedPermission).toBe(true)
    expect(eff.seekBasketListingPermissions).toBe(false)
  })

  it('every SeekFlags key has a disclosure entry', () => {
    expect(Object.keys(SEEK_FLAG_DISCLOSURE).sort()).toEqual([...SEEK_FLAG_KEYS].sort())
    const keys = Object.values(SEEK_FLAG_DISCLOSURE).flatMap(d => [d.off, d.on])
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('applies host defaults, then the stored user policy', () => {
    configureToolbox({
      backupUrl: null,
      browserBridge: { permissionPolicy: { verified: { seekCertificateListingPermissions: true } } }
    })
    expect(resolvePermissionPolicy().verified.seekCertificateListingPermissions).toBe(true)
    const stored: PermissionPolicy = { verified: allFlags(false), unverified: allFlags(true) }
    const resolved = resolvePermissionPolicy(stored)
    expect(resolved.verified.seekCertificateListingPermissions).toBe(false)
    expect(resolved.unverified).toStrictEqual(allFlags(true))
  })

  describe('stored policy', () => {
    const policy: PermissionPolicy = { verified: allFlags(true), unverified: allFlags(true) }

    it('round-trips', async () => {
      const wallet = fakeAdminWallet()
      await saveStoredPolicy('p1', policy, wallet)
      expect(await loadStoredPolicy('p1', wallet)).toStrictEqual(policy)
      expect(await AsyncStorage.getItem('bsv-bridge-permission-policy:p1')).not.toBeNull()
    })

    it('tampered stored policy ignored', async () => {
      const wallet = fakeAdminWallet()
      await saveStoredPolicy('p1', policy, wallet)
      const raw = JSON.parse((await AsyncStorage.getItem('bsv-bridge-permission-policy:p1'))!)
      raw.policy.verified.seekSpendingPermissions = false
      await AsyncStorage.setItem('bsv-bridge-permission-policy:p1', JSON.stringify(raw))
      expect(await loadStoredPolicy('p1', wallet)).toBeUndefined()
    })

    it('ignores a policy copied from another profile, a missing tag and garbage', async () => {
      const wallet = fakeAdminWallet()
      await saveStoredPolicy('p1', policy, wallet)
      const raw = (await AsyncStorage.getItem('bsv-bridge-permission-policy:p1'))!
      await AsyncStorage.setItem('bsv-bridge-permission-policy:p2', raw)
      expect(await loadStoredPolicy('p2', wallet)).toBeUndefined()
      await AsyncStorage.setItem('bsv-bridge-permission-policy:p3', JSON.stringify({ policy }))
      expect(await loadStoredPolicy('p3', wallet)).toBeUndefined()
      await AsyncStorage.setItem('bsv-bridge-permission-policy:p4', '{nope')
      expect(await loadStoredPolicy('p4', wallet)).toBeUndefined()
      expect(await loadStoredPolicy('absent', wallet)).toBeUndefined()
    })

    it('a tag from a different wallet fails', async () => {
      await saveStoredPolicy('p1', policy, fakeAdminWallet(1))
      expect(await loadStoredPolicy('p1', fakeAdminWallet(2))).toBeUndefined()
    })
  })
})
