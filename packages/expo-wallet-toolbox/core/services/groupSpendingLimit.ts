import AsyncStorage from '@react-native-async-storage/async-storage'
import { AUTO_APPROVE_STORAGE_KEY, DEFAULT_AUTO_APPROVE_THRESHOLD } from '../constants'
import { profileScopedKey } from '../profiles/profileStore'

/**
 * The most a site's one-time group grant may let it spend each month: what it could spend without asking,
 * per payment (the stored auto-approve threshold). 0 means the user wants every payment asked about.
 */
export async function groupSpendingLimit(): Promise<number> {
  const v = await AsyncStorage.getItem(profileScopedKey(AUTO_APPROVE_STORAGE_KEY)).catch(() => null)
  return v === null ? DEFAULT_AUTO_APPROVE_THRESHOLD : Number(v) || 0
}

/** The same group with its spending limited to `limit`; with a limit of 0 or less, with no spending at all. */
export function clampGroupSpending<T extends { spendingAuthorization?: { amount: number; description?: string } }>(
  group: T,
  limit: number
): T {
  const spending = group.spendingAuthorization
  if (!spending) return group
  if (!(limit > 0)) {
    const { spendingAuthorization: _removed, ...rest } = group
    return rest as T
  }
  return spending.amount <= limit ? group : { ...group, spendingAuthorization: { ...spending, amount: limit } }
}
