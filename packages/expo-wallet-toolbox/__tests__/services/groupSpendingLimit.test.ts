// A site's one-time group grant may spend each month only up to what the user lets it spend without asking.
import fs from 'fs'
import path from 'path'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { AUTO_APPROVE_STORAGE_KEY, DEFAULT_AUTO_APPROVE_THRESHOLD } from '../../core/constants'
import { profileScopedKey } from '../../core/profiles/profileStore'
import { clampGroupSpending, groupSpendingLimit } from '../../core/services/groupSpendingLimit'
import { sanitizeGroup } from '../../core/services/signingPermissionPolicy'

const KEY = profileScopedKey(AUTO_APPROVE_STORAGE_KEY)

beforeEach(async () => {
  await AsyncStorage.clear()
})

describe('groupSpendingLimit', () => {
  it('limit is the default threshold when nothing is stored', async () => {
    expect(await groupSpendingLimit()).toBe(DEFAULT_AUTO_APPROVE_THRESHOLD)
  })

  it('limit is the stored threshold', async () => {
    await AsyncStorage.setItem(KEY, '2500')
    expect(await groupSpendingLimit()).toBe(2500)
  })

  it('limit is 0 when the stored value is 0 or not a number', async () => {
    await AsyncStorage.setItem(KEY, '0')
    expect(await groupSpendingLimit()).toBe(0)
    await AsyncStorage.setItem(KEY, 'abc')
    expect(await groupSpendingLimit()).toBe(0)
  })
})

describe('clampGroupSpending', () => {
  it('lowers an amount above the limit', () => {
    const group = { description: 'x', spendingAuthorization: { amount: 500, description: 'd' } }
    expect(clampGroupSpending(group, 100)).toEqual({
      description: 'x',
      spendingAuthorization: { amount: 100, description: 'd' }
    })
  })

  it('keeps an amount at or below it', () => {
    const group = { spendingAuthorization: { amount: 100 } }
    expect(clampGroupSpending(group, 100)).toBe(group)
    expect(clampGroupSpending(group, 200)).toBe(group)
  })

  it('removes spending when the limit is 0', () => {
    const group = { description: 'x', basketAccess: [], spendingAuthorization: { amount: 100 } }
    const out = clampGroupSpending(group, 0)
    expect('spendingAuthorization' in out).toBe(false)
    expect(out).toEqual({ description: 'x', basketAccess: [] })
  })

  it('returns a group with no spending unchanged', () => {
    const group: { description: string; spendingAuthorization?: { amount: number } } = { description: 'x' }
    expect(clampGroupSpending(group, 0)).toBe(group)
    expect(clampGroupSpending(group, 100)).toBe(group)
  })
})

describe('sanitizeGroup(raw, limit)', () => {
  const protocol = { protocolID: [1, 'chat'], description: 'Chat' }

  it('clamps a 2 BSV ask (200000000) to the limit', () => {
    const g = sanitizeGroup({ spendingAuthorization: { amount: 200000000, description: 'pay' } }, 100000)
    expect(g?.spendingAuthorization).toEqual({ amount: 100000, description: 'pay' })
  })

  it('drops spending when the limit is 0 and keeps the protocol list', () => {
    const g = sanitizeGroup({ spendingAuthorization: { amount: 5000 }, protocolPermissions: [protocol] }, 0)
    expect(g?.spendingAuthorization).toBeUndefined()
    expect(g?.protocolPermissions).toHaveLength(1)
  })

  it('returns null when only spending was asked and the limit is 0', () => {
    expect(sanitizeGroup({ spendingAuthorization: { amount: 5000 } }, 0)).toBeNull()
  })

  it('still rejects a non-integer or negative amount', () => {
    expect(sanitizeGroup({ spendingAuthorization: { amount: 1.5 } }, 100000)).toBeNull()
    expect(sanitizeGroup({ spendingAuthorization: { amount: -5 } }, 100000)).toBeNull()
  })
})

// This guards the patch against being dropped: it reads the patched toolbox files as text.
describe('the patched files carry the change', () => {
  const read = (p: string) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8')

  it('has the monthly wording, the en keys and the clamp', () => {
    expect(read('ui/components/ui/PermissionSheet.tsx')).toContain('spending_each_month')
    expect(read('core/i18n/translations.tsx')).toContain("spending_each_month: 'each month, until you remove it'")
    expect(read('core/context/WalletContext.tsx')).toContain('clampGroupSpending(permissions, limit)')
  })
})
