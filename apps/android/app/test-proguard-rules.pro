# Annotation metadata references compiler APIs absent from Android; tests do not
# inspect those annotations at runtime. This applies only to the test APK.
-dontwarn javax.lang.model.**
-keep class com.filmwork.app.NativeEntryTest { *; }
