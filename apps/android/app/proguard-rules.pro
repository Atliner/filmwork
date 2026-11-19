# LibVLC calls Java members from native code. Keep its JNI bridge if R8 is ever
# enabled again; this alone does not replace release-device testing.
-keep class org.videolan.libvlc.** { *; }
