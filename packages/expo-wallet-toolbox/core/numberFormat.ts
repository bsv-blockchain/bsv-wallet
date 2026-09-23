/**
 * Which separators money is printed with: always the device's own locale.
 */

/** The device's own locale, resolved once. */
function detectDeviceLocale(): string {
  try {
    return Intl.NumberFormat().resolvedOptions().locale?.split('-u-')[0] || 'en-US'
  } catch {
    return 'en-US'
  }
}

const deviceLocale = detectDeviceLocale()

/** The locale every formatter in `amountFormatHelpers` prints through. */
export function getNumberLocale(): string {
  return deviceLocale
}
