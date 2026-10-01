// Android status-bar icon for payment push notifications.
//
// Android draws a notification's small icon as a pure-white silhouette, so the
// full-colour launcher icon renders as a white blob. This writes a white
// Bitcoin B (cut from the app icon, without the lines behind it) as
// @drawable/notification_icon at every density, plus the accent colour the
// shade tints it with as @color/notification_icon_color.
//
// @react-native-firebase/messaging's own plugin adds the manifest meta-data that
// points FCM at those two resources when it is given
// `android.notificationIcon` / `android.notificationColor` (see app.json), but
// it no longer creates the drawable itself — that used to come from
// expo-notifications or the removed `config.notification` field, and this app
// uses neither.
const fs = require('fs')
const path = require('path')
const { withDangerousMod, withAndroidColors, AndroidConfig } = require('@expo/config-plugins')

const DENSITIES = ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']
const SOURCE_DIR = 'assets/images/notification-icon'
const COLOR_NAME = 'notification_icon_color'

const withIconDrawables = (config) =>
  withDangerousMod(config, [
    'android',
    async (mod) => {
      const resDir = path.join(mod.modRequest.platformProjectRoot, 'app/src/main/res')
      for (const density of DENSITIES) {
        const from = path.join(mod.modRequest.projectRoot, SOURCE_DIR, `notification_icon-${density}.png`)
        const toDir = path.join(resDir, `drawable-${density}`)
        fs.mkdirSync(toDir, { recursive: true })
        fs.copyFileSync(from, path.join(toDir, 'notification_icon.png'))
      }
      return mod
    }
  ])

const withIconColor = (config, color) =>
  withAndroidColors(config, (mod) => {
    mod.modResults = AndroidConfig.Colors.assignColorValue(mod.modResults, { name: COLOR_NAME, value: color })
    return mod
  })

module.exports = (config, { color = '#E5AF35' } = {}) => withIconColor(withIconDrawables(config), color)
