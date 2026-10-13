// Where feedback goes and where the app's store listings are, from the build's
// settings (.env.example; docs/backend-integration.md, Feedback). All empty
// until BSVA has them: feedback then waits on the phone (src/feedback/outbox),
// and rating waits for the store (src/feedback/review). Its own module: Expo
// inlines EXPO_PUBLIC_ values, which tests can't load.

/** The feedback service, e.g. https://feedback.bitcoinsv.com ('' while there's none). */
export const FEEDBACK_URL = (process.env.EXPO_PUBLIC_FEEDBACK_URL ?? '').trim().replace(/\/+$/, '')

/** The app's App Store ID (the digits in apps.apple.com/app/id…), once it's listed. */
export const APP_STORE_ID = (process.env.EXPO_PUBLIC_APP_STORE_ID ?? '').trim()

/** The app is live on Google Play (its listing is at the package name). */
export const PLAY_STORE_LISTED = (process.env.EXPO_PUBLIC_PLAY_STORE_LISTED ?? '').trim() === 'true'

/**
 * How the review is asked for, per platform. 'ask-first' is the prototype's:
 * "Enjoying Bitcoin SV Wallet?", then the store's rating for "I love it" and a
 * note to the team for "I don't like it". 'direct' skips the question: the
 * store's own rating sheet at the same moments, and feedback from Help only.
 * Google Play's In-App Review rules don't allow asking how someone feels
 * (or how they'd rate it) before or while showing the rating, so Android is
 * 'direct'. App Store guidelines only require the system's own rating sheet,
 * so iOS keeps the prototype's question.
 */
export const REVIEW_FUNNEL: { ios: 'ask-first' | 'direct'; android: 'ask-first' | 'direct' } = {
  ios: 'ask-first',
  android: 'direct'
}

/** Whether this platform may ask how someone feels before asking for a rating. */
export const asksFirst = (os: string) => (os === 'android' ? REVIEW_FUNNEL.android : REVIEW_FUNNEL.ios) === 'ask-first'
