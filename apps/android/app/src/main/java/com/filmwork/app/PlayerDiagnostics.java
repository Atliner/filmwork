package com.filmwork.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.os.Build;
import android.widget.Toast;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/** Local, opt-in diagnostics. Never store URLs, tokens, request bodies or exception messages. */
final class PlayerDiagnostics {
  private static final String PREFS = "player-diagnostics";
  private static final int MAX_LINES = 18;
  private PlayerDiagnostics() { }

  static synchronized void mark(Context context, String code) {
    String clean = String.valueOf(code).replaceAll("[^A-Z0-9_-]", "");
    if (clean.isEmpty()) return;
    if (clean.length() > 64) clean = clean.substring(0, 64);
    android.content.SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    String line = new SimpleDateFormat("HH:mm:ss", Locale.ROOT).format(new Date()) + " " + clean;
    String current = prefs.getString("steps", "");
    String[] lines = (current + "\n" + line).trim().split("\n");
    StringBuilder bounded = new StringBuilder();
    for (int i = Math.max(0, lines.length - MAX_LINES); i < lines.length; i++) {
      if (bounded.length() > 0) bounded.append('\n');
      bounded.append(lines[i]);
    }
    // Synchronous persistence is intentional: the next instruction may crash.
    prefs.edit().putString("stage", clean).putString("steps", bounded.toString()).commit();
  }

  static void recordFailure(Context context, String code, Throwable error, boolean uncaught) {
    String kind = error == null ? "Unknown" : error.getClass().getName();
    kind = kind.replaceAll("[^A-Za-z0-9_.$]", "");
    String location = "";
    if (error != null) for (StackTraceElement item : error.getStackTrace()) {
      String cls = item.getClassName();
      if (cls.startsWith("com.filmwork.") || cls.startsWith("org.videolan.")) {
        location = (cls + "." + item.getMethodName() + ":" + item.getLineNumber()).replaceAll("[^A-Za-z0-9_.$:-]", "");
        break;
      }
    }
    String clean = String.valueOf(code).replaceAll("[^A-Z0-9_-]", "");
    android.content.SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    prefs.edit().putString("failureStage", clean).putString("failureType", kind)
        .putString("failureLocation", location).putBoolean("pendingCrash", uncaught).commit();
    mark(context, "ERROR_" + clean);
  }

  static void installCrashHandler(Context context) {
    Context app = context.getApplicationContext();
    Thread.UncaughtExceptionHandler prior = Thread.getDefaultUncaughtExceptionHandler();
    Thread.setDefaultUncaughtExceptionHandler((thread, error) -> {
      try {
        String stage = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("stage", "APP_START");
        recordFailure(app, stage, error, true);
      } catch (Throwable ignored) { /* Never interfere with Android's crash handler. */ }
      if (prior != null) prior.uncaughtException(thread, error);
      else { android.os.Process.killProcess(android.os.Process.myPid()); System.exit(1); }
    });
  }

  static boolean hasPendingCrash(Context context) {
    return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean("pendingCrash", false);
  }

  static void show(Activity activity, boolean fromCrash) {
    android.content.SharedPreferences prefs = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    String report = "Vizosten " + BuildConfig.VERSION_NAME + "\nAndroid " + Build.VERSION.RELEASE + " (API " + Build.VERSION.SDK_INT + ")"
        + "\nDevice: " + Build.MANUFACTURER + " " + Build.MODEL
        + "\nCPU: " + android.text.TextUtils.join(", ", Build.SUPPORTED_ABIS)
        + "\nLast failure: " + prefs.getString("failureStage", "none") + " / " + prefs.getString("failureType", "none")
        + "\nLocation: " + prefs.getString("failureLocation", "none")
        + "\nSteps:\n" + prefs.getString("steps", "none");
    if (fromCrash) prefs.edit().putBoolean("pendingCrash", false).apply();
    new AlertDialog.Builder(activity)
        .setTitle(fromCrash ? "گزارش آخرین توقف برنامه" : "عیب‌یابی پلیر")
        .setMessage("گزارش فقط روی گوشی ذخیره شده و خودکار ارسال نمی‌شود. نشانی فایل و اطلاعات ورود در آن ثبت نمی‌شوند. در صورت تمایل آن را کپی و ارسال کنید.\n\n" + report)
        .setPositiveButton("کپی گزارش", (dialog, which) -> {
          ClipboardManager clipboard = (ClipboardManager) activity.getSystemService(Context.CLIPBOARD_SERVICE);
          if (clipboard != null) clipboard.setPrimaryClip(ClipData.newPlainText("Vizosten diagnostics", report));
          Toast.makeText(activity, "گزارش کپی شد.", Toast.LENGTH_SHORT).show();
        })
        .setNeutralButton("پاک کردن گزارش", (dialog, which) -> prefs.edit().clear().apply())
        .setNegativeButton("بستن", null).show();
  }
}
