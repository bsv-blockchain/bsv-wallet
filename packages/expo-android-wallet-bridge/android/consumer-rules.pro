# Keep rules shipped with the library (merged into the host's R8 configuration).
# The Expo module is found by name from expo-module.config.json; the trampoline and the service are named in the manifest.
-keep class org.bsv.walletbridge.BsvAndroidBridgeModule { *; }
-keep class org.bsv.walletbridge.LaunchTrampolineActivity { *; }
-keep class org.bsv.walletbridge.BridgeService { *; }
