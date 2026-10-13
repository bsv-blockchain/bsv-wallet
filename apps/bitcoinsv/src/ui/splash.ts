// The native splash, held from the app's start (app/_layout.tsx) until the
// first screen has drawn under it: Home, in Home's own time (app/index.tsx);
// anything else that opened first, at once. On iOS the splash is Home's top as
// it first draws (plugins/withHomeLaunchScreen.js), so the app opens straight
// onto it; on Android, the plain ground.
import * as SplashScreen from 'expo-splash-screen'

/** The native splash goes: whatever's under it has drawn. */
export const hideSplash = () => void SplashScreen.hideAsync().catch(() => {})
