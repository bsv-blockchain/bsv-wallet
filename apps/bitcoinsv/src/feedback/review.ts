// Rating the app in its store: the platform's own sheet (StoreKit's review
// prompt on iOS, Play In-App Review on Android), which the app can't style or
// see the answer of; the prototype's RatingSheet stands in for it. Neither
// works until the app is listed (iOS shows a test sheet in development builds
// and nothing from TestFlight; Android needs an install from Play), so until
// the listing is set (src/feedback/config.ts) it says reviews come later.
import { Linking, Platform } from 'react-native'
import Constants from 'expo-constants'
import * as StoreReview from 'expo-store-review'
import { APP_STORE_ID, PLAY_STORE_LISTED } from './config'

const PACKAGE = Constants.expoConfig?.android?.package ?? 'org.bsvblockchain.wallet'

/** The app is in this platform's store. */
export const isListed = () => (Platform.OS === 'ios' ? !!APP_STORE_ID : Platform.OS === 'android' ? PLAY_STORE_LISTED : false)

/** Its store page, at the place to write a review; null until it's listed. */
export function storeReviewUrl(): string | null {
  if (!isListed()) return null
  if (Platform.OS === 'ios') return `https://apps.apple.com/app/id${APP_STORE_ID}?action=write-review`
  return `https://play.google.com/store/apps/details?id=${PACKAGE}&showAllReviews=true`
}

export type RateOutcome = 'sheet' | 'store' | 'later'

/**
 * Ask for a rating: the store's own sheet where it can show, its page where
 * it can't; 'later' while the app isn't in the store yet. Development builds
 * try the sheet regardless, so the flow can be seen (iOS shows a test sheet).
 */
export async function rateTheApp(): Promise<RateOutcome> {
  if (isListed() || __DEV__) {
    try {
      if (await StoreReview.isAvailableAsync()) {
        await StoreReview.requestReview()
        return 'sheet'
      }
    } catch {
      // the page instead
    }
  }
  const url = storeReviewUrl()
  if (url) {
    try {
      await Linking.openURL(url)
      return 'store'
    } catch {
      // nowhere to go
    }
  }
  return 'later'
}
