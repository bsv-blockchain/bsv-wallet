// After Android's splash, the app's own theme takes over, and with no window
// background of its own it shows the system's near-white until the app has
// drawn (and, in a development build, while its code downloads): a white flash
// between the splash and the launch screen. The window takes the splash's own
// ground instead, which already has its dark-mode twin (values-night).
const { withAndroidStyles } = require('@expo/config-plugins')

module.exports = function withLaunchWindowBackground(config) {
  return withAndroidStyles(config, cfg => {
    const theme = cfg.modResults.resources.style?.find(s => s.$.name === 'AppTheme')
    if (!theme) return cfg
    theme.item = (theme.item ?? []).filter(i => i.$.name !== 'android:windowBackground')
    theme.item.push({ $: { name: 'android:windowBackground' }, _: '@color/splashscreen_background' })
    return cfg
  })
}
