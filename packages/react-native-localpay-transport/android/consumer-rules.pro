# R8 keep rules shipped to any app that depends on this library.
#
# The Nitro C++ side (fbjni + nitrogen-generated JNI) finds the Kotlin
# HybridObjects, their specs, callback and struct classes, and their methods
# and fields by name, so none of them may be renamed or stripped.
-keep class com.margelo.nitro.localpaytransport.** { *; }
