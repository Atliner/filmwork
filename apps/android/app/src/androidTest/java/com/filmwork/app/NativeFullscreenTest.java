package com.filmwork.app;

import static org.junit.Assert.*;

import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.res.Configuration;
import android.net.Uri;
import android.os.Build;
import android.os.SystemClock;
import android.view.WindowInsets;

import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import org.junit.Test;
import org.junit.runner.RunWith;
import java.util.concurrent.atomic.AtomicBoolean;

@RunWith(AndroidJUnit4.class)
public class NativeFullscreenTest {
  @Test public void landscapeHidesStatusAndNavigationBarsAndPortraitRestoresThem() {
    Intent intent = new Intent(InstrumentationRegistry.getInstrumentation().getTargetContext(), NativePlayerActivity.class)
        .setData(Uri.parse("https://example.com/test.mkv"));
    try (ActivityScenario<NativePlayerActivity> scenario = ActivityScenario.launch(intent)) {
      scenario.onActivity(activity -> activity.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE));
      assertTrue("landscape hides both system bars", awaitBars(scenario, Configuration.ORIENTATION_LANDSCAPE, false));
      scenario.onActivity(activity -> activity.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT));
      assertTrue("portrait restores both system bars", awaitBars(scenario, Configuration.ORIENTATION_PORTRAIT, true));
    }
  }
  private boolean awaitBars(ActivityScenario<NativePlayerActivity> scenario, int orientation, boolean visible) {
    AtomicBoolean result = new AtomicBoolean(false);
    long deadline = SystemClock.elapsedRealtime() + 10000;
    while (!result.get() && SystemClock.elapsedRealtime() < deadline) {
      scenario.onActivity(activity -> {
        if (activity.getResources().getConfiguration().orientation != orientation) return;
        if (Build.VERSION.SDK_INT >= 30) {
          WindowInsets insets = activity.getWindow().getDecorView().getRootWindowInsets();
          if (insets != null) result.set(insets.isVisible(WindowInsets.Type.statusBars()) == visible && insets.isVisible(WindowInsets.Type.navigationBars()) == visible);
        } else {
          int flags = activity.getWindow().getDecorView().getSystemUiVisibility();
          result.set(((flags & android.view.View.SYSTEM_UI_FLAG_FULLSCREEN) == 0) == visible && ((flags & android.view.View.SYSTEM_UI_FLAG_HIDE_NAVIGATION) == 0) == visible);
        }
      });
      if (!result.get()) SystemClock.sleep(200);
    }
    return result.get();
  }
}
