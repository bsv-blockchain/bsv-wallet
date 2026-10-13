// iOS's launch screen is Home's top as it first draws: the bar, the total with
// its figure to come, Pay and Get paid (pieces drawn by scripts/launch-home.js
// into assets/images/launch). Home draws in the same places at once on launch
// (app/index.tsx, from how it looked last time), so the app opens straight
// onto it: the avatar and what's below the buttons fill in, nothing moves.
//
// Laid out as Home lays them out, from the safe area's top and the screen's
// edges (src/home/TopBar.tsx, BalanceHero.tsx, QuickActions.tsx; the content's
// paddings in app/index.tsx), so it matches at any width. Replaces
// expo-splash-screen's storyboard (its tube image is unused here); listed
// before expo-splash-screen in app.config.js, so this runs after it.
const fs = require('fs')
const path = require('path')
const xml2js = require('xml2js')
const { withDangerousMod, withMod } = require('@expo/config-plugins')

// the top bar: 16 below the safe area, 60 tall (40 search box, 10 above and below)
const BAR = 16
// the bar's hairline, then the content's 24 above the total
const HERO = BAR + 60 + 1 / 3 + 24
// the total: 4 down, its label (16), 4, then the figure's place (40, 4 above and below)
const LABEL = HERO + 4
const FIGURE = LABEL + 16 + 4 + 4
// 24 below the total, the buttons (80 tall: 16, icon 24, 8, label 22, 10)
const TILES = FIGURE + 40 + 4 + 24
// the search box's shadow reaches this far round it (scripts/launch-home.js)
const SHADOW = 24

const n = v => Number(v.toFixed(2))

function storyboard() {
  let id = 0
  const views = []
  const constraints = []
  const own = {}
  const sizes = {}
  const view = (name, image, w, h) => {
    const v = `HOME-${name}`
    views.push({ v, image })
    sizes[image] = sizes[image] || [w, h]
    own[v] = []
    if (w != null) own[v].push(`<constraint firstAttribute="width" constant="${n(w)}" id="HOME-c${++id}"/>`)
    if (h != null) own[v].push(`<constraint firstAttribute="height" constant="${n(h)}" id="HOME-c${++id}"/>`)
    return v
  }
  const pin = (a, attrA, b, attrB, constant = 0) =>
    constraints.push(
      `<constraint firstItem="${a}" firstAttribute="${attrA}" secondItem="${b}" secondAttribute="${attrB}"${constant ? ` constant="${n(constant)}"` : ''} id="HOME-c${++id}"/>`
    )
  const C = 'HOME-Frame'
  const SAFE = 'HOME-FrameSafe'
  const top = (v, y) => pin(v, 'top', SAFE, 'top', y)
  const leading = (v, x) => pin(v, 'leading', C, 'leading', x)
  const trailing = (v, x) => pin(C, 'trailing', v, 'trailing', x)

  // the bar: the avatar's place, scan, the search box and its icon, help, settings
  const avatar = view('Avatar', 'LaunchAvatar', 32, 32)
  leading(avatar, 18)
  top(avatar, BAR + 14)
  const scan = view('Scan', 'LaunchScan', 20, 20)
  leading(scan, 66)
  top(scan, BAR + 20)
  const search = view('Search', 'LaunchSearch', null, 40 + 2 * SHADOW)
  sizes.LaunchSearch = [2 * (SHADOW + 20) + 1, 40 + 2 * SHADOW]
  leading(search, 104 - SHADOW)
  trailing(search, 100 - SHADOW)
  top(search, BAR + 10 - SHADOW)
  const glass = view('SearchIcon', 'LaunchSearchIcon', 16, 16)
  leading(glass, 120)
  top(glass, BAR + 22)
  const help = view('Help', 'LaunchHelp', 20, 20)
  trailing(help, 62)
  top(help, BAR + 20)
  const settings = view('Settings', 'LaunchSettings', 20, 20)
  trailing(settings, 22)
  top(settings, BAR + 20)

  // the total: its label, and the figure's place
  const total = view('Total', 'LaunchTotal', 200, 16)
  pin(total, 'centerX', C, 'centerX')
  top(total, LABEL)
  const figure = view('Figure', 'LaunchFigure', 168, 40)
  pin(figure, 'centerX', C, 'centerX')
  top(figure, FIGURE)

  // Pay and Get paid, sharing the row with 8 between
  const pay = view('PayTile', 'LaunchTile', null, 80)
  sizes.LaunchTile = [41, 80]
  leading(pay, 16)
  pin(pay, 'trailing', C, 'centerX', -4)
  top(pay, TILES)
  const paid = view('PaidTile', 'LaunchTile', null, 80)
  pin(paid, 'leading', C, 'centerX', 4)
  trailing(paid, 16)
  top(paid, TILES)
  const payLabel = view('Pay', 'LaunchPay', 120, 54)
  pin(payLabel, 'centerX', pay, 'centerX')
  top(payLabel, TILES + 16)
  const paidLabel = view('Paid', 'LaunchGetPaid', 120, 54)
  pin(paidLabel, 'centerX', paid, 'centerX')
  top(paidLabel, TILES + 16)

  const subviews = views
    .map(
      ({ v, image }) => `
                            <imageView userInteractionEnabled="NO" contentMode="scaleToFill" image="${image}" translatesAutoresizingMaskIntoConstraints="NO" id="${v}">
                                <constraints>${own[v].join('')}</constraints>
                            </imageView>`
    )
    .join('')
  const images = Object.entries(sizes)
    .map(([name, [w, h]]) => `<image name="${name}" width="${w}" height="${h}"/>`)
    .join('\n        ')

  return `<?xml version="1.0" encoding="UTF-8"?>
<document type="com.apple.InterfaceBuilder3.CocoaTouch.Storyboard.XIB" version="3.0" toolsVersion="24093.7" targetRuntime="iOS.CocoaTouch" propertyAccessControl="none" useAutolayout="YES" launchScreen="YES" useTraitCollections="YES" useSafeAreas="YES" colorMatched="YES" initialViewController="EXPO-VIEWCONTROLLER-1">
    <device id="retina6_12" orientation="portrait" appearance="light"/>
    <dependencies>
        <deployment identifier="iOS"/>
        <plugIn identifier="com.apple.InterfaceBuilder.IBCocoaTouchPlugin" version="24053.1"/>
        <capability name="Named colors" minToolsVersion="9.0"/>
        <capability name="Safe area layout guides" minToolsVersion="9.0"/>
        <capability name="documents saved in the Xcode 8 format" minToolsVersion="8.0"/>
    </dependencies>
    <scenes>
        <scene sceneID="EXPO-SCENE-1">
            <objects>
                <viewController storyboardIdentifier="SplashScreenViewController" id="EXPO-VIEWCONTROLLER-1" sceneMemberID="viewController">
                    <view key="view" userInteractionEnabled="NO" contentMode="scaleToFill" insetsLayoutMarginsFromSafeArea="NO" id="HOME-View" userLabel="ContainerView">
                        <rect key="frame" x="0.0" y="0.0" width="393" height="852"/>
                        <autoresizingMask key="autoresizingMask" flexibleMaxX="YES" flexibleMaxY="YES"/>
                        <subviews>
                            <view userInteractionEnabled="NO" contentMode="scaleToFill" translatesAutoresizingMaskIntoConstraints="NO" id="${C}" userLabel="Frame">
                                <rect key="frame" x="0.0" y="0.0" width="393" height="852"/>
                                <subviews>${subviews}
                                </subviews>
                                <viewLayoutGuide key="safeArea" id="${SAFE}"/>
                                <constraints>
                                    ${constraints.join('\n                                    ')}
                                </constraints>
                            </view>
                        </subviews>
                        <constraints>
                            <constraint firstItem="${C}" firstAttribute="top" secondItem="HOME-View" secondAttribute="top" id="HOME-f1"/>
                            <constraint firstItem="${C}" firstAttribute="bottom" secondItem="HOME-View" secondAttribute="bottom" id="HOME-f2"/>
                            <constraint firstItem="${C}" firstAttribute="leading" secondItem="HOME-View" secondAttribute="leading" id="HOME-f3"/>
                            <constraint firstItem="${C}" firstAttribute="trailing" secondItem="HOME-View" secondAttribute="trailing" id="HOME-f4"/>
                        </constraints>
                        <color key="backgroundColor" name="SplashScreenBackground"/>
                    </view>
                </viewController>
                <placeholder placeholderIdentifier="IBFirstResponder" id="EXPO-PLACEHOLDER-1" userLabel="First Responder" sceneMemberID="firstResponder"/>
            </objects>
            <point key="canvasLocation" x="0.0" y="0.0"/>
        </scene>
    </scenes>
    <resources>
        ${images}
        <namedColor name="SplashScreenBackground">
            <color alpha="1.000" blue="0.941176470588235" green="0.952941176470588" red="0.956862745098039" customColorSpace="sRGB" colorSpace="custom"/>
        </namedColor>
    </resources>
</document>
`
}

module.exports = function withHomeLaunchScreen(config) {
  // the pieces, into the app's asset catalog
  config = withDangerousMod(config, [
    'ios',
    cfg => {
      const from = path.join(cfg.modRequest.projectRoot, 'assets/images/launch')
      const catalog = path.join(cfg.modRequest.platformProjectRoot, cfg.modRequest.projectName, 'Images.xcassets')
      for (const set of fs.readdirSync(from)) {
        if (!set.endsWith('.imageset')) continue
        fs.cpSync(path.join(from, set), path.join(catalog, set), { recursive: true })
      }
      return cfg
    }
  ])
  // the storyboard, in place of expo-splash-screen's
  return withMod(config, {
    platform: 'ios',
    mod: 'splashScreenStoryboard',
    action: async cfg => {
      cfg.modResults = await xml2js.parseStringPromise(storyboard())
      return cfg
    }
  })
}

module.exports.storyboard = storyboard
