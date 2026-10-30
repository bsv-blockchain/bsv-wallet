# Keep rules shipped with the library (merged into the host's R8 configuration).
# The Expo module is found by name from expo-module.config.json; the trampoline and the service are named in the manifest.
-keep class org.bsv.walletbridge.BsvAndroidBridgeModule { *; }
-keep class org.bsv.walletbridge.LaunchTrampolineActivity { *; }
-keep class org.bsv.walletbridge.BridgeService { *; }
# The sheet Activity (named in the manifest) and the two ReactActivityDelegate/ReactDelegate members its destroy guard calls.
-keep class org.bsv.walletbridge.BridgeSheetActivity { *; }
-keepclassmembers class com.facebook.react.ReactActivityDelegate { *** getReactDelegate(); }
-keepclassmembers class com.facebook.react.ReactDelegate { *** unloadApp(); }
