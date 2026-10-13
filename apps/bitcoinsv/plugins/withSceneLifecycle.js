// Apps built against the iOS 27 SDK trap at launch when Info.plist carries no
// scene manifest (UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption).
// This app's ios/ is generated, so the scene manifest and a SceneDelegate are
// added here at prebuild. The delegate follows Expo's own ExpoAppSceneDelegate
// (expo 57.0.27+, not yet in the version both apps pin): React Native starts
// in the scene's window, not in a frameless window from didFinishLaunching,
// so safe-area insets are right from the first layout, and a cold-start URL
// reaches React Native (and the dev launcher) as launch options instead of
// a second load racing the first.
const { withAppDelegate, withInfoPlist } = require('@expo/config-plugins')

const MARKER = '// MARK: - UIScene lifecycle'

// The template's start in didFinishLaunching, which moves to the scene.
const WINDOW_LINE = /^ *window = UIWindow\(frame: UIScreen\.main\.bounds\)\n/m
const START_CALL =
  /^ *factory\.startReactNative\(\n *withModuleName: "main",\n *in: window,\n *launchOptions: launchOptions\)\n/m

const SCENE_DELEGATE = `
${MARKER} (plugins/withSceneLifecycle.js)
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene,
      let appDelegate = UIApplication.shared.delegate as? AppDelegate,
      let factory = appDelegate.reactNativeFactory
    else { return }
    let sceneWindow = UIWindow(windowScene: windowScene)
    window = sceneWindow
    // modules that still read the app delegate's window (expo-system-ui, ...)
    appDelegate.window = sceneWindow

    // Under the scene life cycle a cold-start URL arrives in connectionOptions,
    // not in the app delegate's launch options, where React Native's
    // getInitialURL (and the dev launcher) read it.
    let webActivity = connectionOptions.userActivities.first { $0.activityType == NSUserActivityTypeBrowsingWeb }
    factory.startReactNative(
      withModuleName: "main",
      in: sceneWindow,
      launchOptions: Self.launchOptions(url: connectionOptions.urlContexts.first?.url, userActivity: webActivity)
    )

    for context in connectionOptions.urlContexts {
      _ = appDelegate.application(UIApplication.shared, open: context.url, options: Self.openURLOptions(context.options))
    }
    for activity in connectionOptions.userActivities {
      _ = appDelegate.application(UIApplication.shared, continue: activity, restorationHandler: { _ in })
    }
  }

  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    let appDelegate = UIApplication.shared.delegate as? AppDelegate
    for context in URLContexts {
      _ = appDelegate?.application(UIApplication.shared, open: context.url, options: Self.openURLOptions(context.options))
    }
  }

  func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    let appDelegate = UIApplication.shared.delegate as? AppDelegate
    _ = appDelegate?.application(UIApplication.shared, continue: userActivity, restorationHandler: { _ in })
  }

  // By their raw keys: the UIApplication accessors are deprecated in iOS 26,
  // but React Native still reads launch options by exactly these keys.
  static func launchOptions(url: URL?, userActivity: NSUserActivity?) -> [UIApplication.LaunchOptionsKey: Any]? {
    var options: [UIApplication.LaunchOptionsKey: Any] = [:]
    if let url {
      options[UIApplication.LaunchOptionsKey(rawValue: "UIApplicationLaunchOptionsURLKey")] = url
    }
    if let userActivity {
      options[UIApplication.LaunchOptionsKey(rawValue: "UIApplicationLaunchOptionsUserActivityDictionaryKey")] = [
        "UIApplicationLaunchOptionsUserActivityTypeKey": userActivity.activityType,
        "UIApplicationLaunchOptionsUserActivityKey": userActivity
      ]
    }
    return options.isEmpty ? nil : options
  }

  static func openURLOptions(_ sceneOptions: UIScene.OpenURLOptions) -> [UIApplication.OpenURLOptionsKey: Any] {
    var options: [UIApplication.OpenURLOptionsKey: Any] = [:]
    if let sourceApplication = sceneOptions.sourceApplication { options[.sourceApplication] = sourceApplication }
    if let annotation = sceneOptions.annotation { options[.annotation] = annotation }
    options[.openInPlace] = sceneOptions.openInPlace
    return options
  }
}
`

module.exports = function withSceneLifecycle(config) {
  config = withInfoPlist(config, cfg => {
    cfg.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: 'Default Configuration',
            UISceneDelegateClassName: '$(PRODUCT_MODULE_NAME).SceneDelegate'
          }
        ]
      }
    }
    return cfg
  })
  // Listed before @react-native-firebase/app in app.config.js, so this runs
  // after its FirebaseApp.configure() insertion (mods run in reverse), which
  // stays in didFinishLaunching.
  return withAppDelegate(config, cfg => {
    const mod = cfg.modResults
    if (mod.language !== 'swift') throw new Error('withSceneLifecycle: expected a Swift AppDelegate')
    if (mod.contents.includes(MARKER)) return cfg
    if (!WINDOW_LINE.test(mod.contents) || !START_CALL.test(mod.contents)) {
      throw new Error('withSceneLifecycle: the AppDelegate template changed; update the plugin')
    }
    mod.contents = mod.contents.replace(WINDOW_LINE, '').replace(START_CALL, '') + SCENE_DELEGATE
    return cfg
  })
}
