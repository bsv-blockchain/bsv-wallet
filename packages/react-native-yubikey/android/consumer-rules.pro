# R8 keep rules shipped to any app that depends on this library.
#
# The Nitro C++ side (fbjni + nitrogen-generated JNI) finds the Kotlin
# HybridObject, its spec, callback and struct classes, and their methods and
# fields by name, so none of them may be renamed or stripped.
-keep class com.margelo.nitro.yubikeypiv.** { *; }

# YubiKit is driven only through this module; keep it whole rather than chase
# its internal reflection (ServiceLoader codecs, session/connection lookups).
-keep class com.yubico.yubikit.** { *; }

# YubiKit annotates a field with SpotBugs' @SuppressFBWarnings but doesn't ship
# the annotation jar. It's build-time metadata only; nothing reads it at runtime.
-dontwarn edu.umd.cs.findbugs.annotations.SuppressFBWarnings
