import type { ProfileRecord } from './profileStore'

/**
 * What the user calls a profile: the private name they gave it, else the
 * default `profile<n+1>`. The number follows the derivation index, so removing
 * a profile never renumbers the ones after it.
 */
export function profileLabel(
  record: Pick<ProfileRecord, 'index' | 'name'>,
  t: (key: string, options?: Record<string, unknown>) => string
): string {
  return record.name || t('profile_label', { number: record.index + 1 })
}
