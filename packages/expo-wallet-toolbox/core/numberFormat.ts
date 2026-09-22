/**
 * Which separators money is printed with.
 *
 * The wallet used to read this off the device and nothing else, which is right
 * until it is not: a holder running an `en-NL` phone saw `US$ 0,00` and had to
 * decide whether that comma was a decimal point or a thousands mark. The
 * answer differs by region for the SAME digits, so a figure that is ambiguous
 * is a figure that can be misread by three orders of magnitude.
 *
 * So the preference is explicit and the device is only the default. Each
 * choice names a concrete rendering rather than a locale, because the question
 * a holder is answering is "which of these looks right", not "which country am
 * I in".
 *
 * Stored outside `WalletSettings`: that type belongs to
 * `@bsv/wallet-toolbox-mobile` and is not ours to extend. AsyncStorage instead,
 * loaded once at startup.
 */
import { useSyncExternalStore } from 'react'
import AsyncStorage from '@react-native-async-storage/async-storage'

export type NumberFormatPref = 'device' | 'period' | 'comma' | 'space'

const STORAGE_KEY = 'wallet_number_format'

/**
 * A locale chosen purely for its separators — never shown to the user, and
 * never used to pick a language.
 */
const LOCALE_FOR: Record<Exclude<NumberFormatPref, 'device'>, string> = {
  period: 'en-US', // 1,234.56
  comma: 'de-DE', // 1.234,56
  space: 'fr-FR' // 1 234,56
}

/** The device's own locale, resolved once. */
function detectDeviceLocale(): string {
  try {
    return Intl.NumberFormat().resolvedOptions().locale?.split('-u-')[0] || 'en-US'
  } catch {
    return 'en-US'
  }
}

const deviceLocale = detectDeviceLocale()

const listeners = new Set<() => void>()
let pref: NumberFormatPref = 'device'

/** The locale every formatter in `amountFormatHelpers` prints through. */
export function getNumberLocale(): string {
  return pref === 'device' ? deviceLocale : LOCALE_FOR[pref]
}

export function getNumberFormatPref(): NumberFormatPref {
  return pref
}

/** What `device` currently resolves to, for the "Follow device" row's subtitle. */
export function getDeviceLocale(): string {
  return deviceLocale
}

export function setNumberFormatPref(next: NumberFormatPref): void {
  if (pref === next) return
  pref = next
  listeners.forEach(l => l())
  // Fire-and-forget: the preference is already live in memory, and a failed
  // write costs the next launch's default, never the figure on screen now.
  void AsyncStorage.setItem(STORAGE_KEY, next).catch(() => {})
}

export function subscribeNumberFormat(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Restore the stored preference. Call once at startup; safe to call twice. */
export async function loadNumberFormatPref(): Promise<void> {
  try {
    const stored = await AsyncStorage.getItem(STORAGE_KEY)
    if (stored === 'device' || stored === 'period' || stored === 'comma' || stored === 'space') {
      if (stored !== pref) {
        pref = stored
        listeners.forEach(l => l())
      }
    }
  } catch {
    // Keep the device default; an unreadable preference is not an error worth
    // surfacing on a balance screen.
  }
}

/** A sample figure per option, rendered in that option's own separators. */
export function numberFormatSample(option: NumberFormatPref): string {
  const locale = option === 'device' ? deviceLocale : LOCALE_FOR[option]
  try {
    return new Intl.NumberFormat(locale, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
      useGrouping: true
    }).format(1234.56)
  } catch {
    return '1234.56'
  }
}

/**
 * Re-renders the caller whenever the preference changes, so a figure formatted
 * during render is always in the separators currently chosen.
 */
export function useNumberFormatPref(): NumberFormatPref {
  return useSyncExternalStore(subscribeNumberFormat, getNumberFormatPref, getNumberFormatPref)
}
