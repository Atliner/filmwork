package com.filmwork.app;

import static org.junit.Assert.*;

import android.app.Activity;
import android.content.Intent;
import android.os.SystemClock;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.widget.TextView;

import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry;
import androidx.test.runner.lifecycle.Stage;

import org.junit.Test;
import org.junit.runner.RunWith;

import java.util.concurrent.atomic.AtomicBoolean;

/** Release APK smoke test: real WebView bridge, Activity and LibVLC startup. */
@RunWith(AndroidJUnit4.class)
public class NativeEntryTest {
  private static WebView findWebView(View view) {
    if (view instanceof WebView) return (WebView) view;
    if (view instanceof ViewGroup) {
      ViewGroup group = (ViewGroup) view;
      for (int i = 0; i < group.getChildCount(); i++) {
        WebView result = findWebView(group.getChildAt(i));
        if (result != null) return result;
      }
    }
    return null;
  }
  private static boolean hasText(View view, String text) {
    if (view instanceof TextView && ((TextView) view).getText().toString().contains(text)) return true;
    if (view instanceof ViewGroup) {
      ViewGroup group = (ViewGroup) view;
      for (int i = 0; i < group.getChildCount(); i++) if (hasText(group.getChildAt(i), text)) return true;
    }
    return false;
  }

  @Test public void siteMessageOpensNativePlayerWithoutCrash() {
    Intent launch = new Intent(InstrumentationRegistry.getInstrumentation().getTargetContext(), MainActivity.class);
    try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(launch)) {
      scenario.onActivity(activity -> {
        WebView webView = findWebView(activity.getWindow().getDecorView());
        assertNotNull("WebView is present", webView);
        String html = "<!doctype html><meta charset='utf-8'><script>" +
            "window.addEventListener('load',function(){if(window.VizostenNative){" +
            "VizostenNative.postMessage(JSON.stringify({action:'openPlayer'," +
            "contentId:'34a3f2c2-6edb-4132-a4da-0f14e660bdcc'," +
            "title:'Bridge playback test',streamUrl:'https://example.com/test.mkv'," +
            "subtitleUrls:[],audioUrls:[],resumeMillis:0,sessionToken:''}));}});" +
            "</script>";
        webView.loadDataWithBaseURL("https://namdarcompost.ir/", html, "text/html", "UTF-8", null);
      });
      AtomicBoolean opened = new AtomicBoolean(false);
      long until = SystemClock.elapsedRealtime() + 20000;
      while (!opened.get() && SystemClock.elapsedRealtime() < until) {
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
          for (Activity activity : ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED)) {
            if (activity instanceof NativePlayerActivity && hasText(activity.getWindow().getDecorView(), "Bridge playback test")) opened.set(true);
          }
        });
        if (!opened.get()) SystemClock.sleep(250);
      }
      assertTrue("native player opened through the site's WebMessage bridge", opened.get());
      // Give the asynchronous ad response / native video initialisation time to run.
      SystemClock.sleep(16000);
      InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
        boolean present = false;
        for (Activity activity : ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED)) {
          if (activity instanceof NativePlayerActivity && hasText(activity.getWindow().getDecorView(), "Bridge playback test")) present = true;
        }
        assertTrue("release player remains open after native initialisation", present);
      });
    }
  }
}
