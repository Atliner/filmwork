package com.filmwork.app;

import static org.junit.Assert.*;

import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.SystemClock;
import android.view.TextureView;
import android.view.View;
import android.view.ViewGroup;

import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.videolan.libvlc.MediaPlayer;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.concurrent.atomic.AtomicInteger;

/** Verify the rendered pixels, not just LibVLC's reported track IDs. */
@RunWith(AndroidJUnit4.class)
public class NativeSubtitleTest {
  private static Object field(Object obj, String name) throws Exception {
    Field f = obj.getClass().getDeclaredField(name); f.setAccessible(true); return f.get(obj);
  }
  private static TextureView texture(View view) {
    if (view instanceof TextureView) return (TextureView) view;
    if (view instanceof ViewGroup) {
      ViewGroup group = (ViewGroup) view;
      for (int i = 0; i < group.getChildCount(); i++) {
        TextureView result = texture(group.getChildAt(i)); if (result != null) return result;
      }
    }
    return null;
  }
  private static int brightPixels(TextureView view) {
    if (view == null || !view.isAvailable()) return 0;
    Bitmap bitmap = view.getBitmap(320, 180); if (bitmap == null) return 0;
    int count = 0;
    for (int y = 0; y < bitmap.getHeight(); y++) for (int x = 0; x < bitmap.getWidth(); x++) {
      int color = bitmap.getPixel(x, y);
      if (((color >> 16) & 255) > 100 && ((color >> 8) & 255) > 100 && (color & 255) > 100) count++;
    }
    bitmap.recycle(); return count;
  }
  private static int maxPixels(ActivityScenario<NativePlayerActivity> scenario) {
    // Subtitle frames from the previous decoder can remain visible briefly;
    // measure only after its old cue and queued surface frames have expired.
    SystemClock.sleep(1800);
    AtomicInteger max = new AtomicInteger();
    for (int i = 0; i < 12; i++) {
      scenario.onActivity(activity -> max.set(Math.max(max.get(), brightPixels(texture(activity.getWindow().getDecorView())))));
      SystemClock.sleep(150);
    }
    return max.get();
  }
  private static void select(NativePlayerActivity activity, int track) throws Exception {
    Method select = activity.getClass().getDeclaredMethod("selectSubtitle", int.class); select.setAccessible(true); select.invoke(activity, track);
  }

  @Test public void embeddedSubtitleChoicesChangeRenderedPixelsAndOverridePendingRestore() throws Exception {
    Context target = InstrumentationRegistry.getInstrumentation().getTargetContext();
    target.getSharedPreferences("vizosten-player", Context.MODE_PRIVATE).edit().clear().commit();
    File video = new File(target.getFilesDir(), "subtitle-switch.mkv");
    try (InputStream in = InstrumentationRegistry.getInstrumentation().getContext().getAssets().open("subtitle-switch.mkv");
         FileOutputStream out = new FileOutputStream(video)) {
      byte[] bytes = new byte[8192]; int count; while ((count = in.read(bytes)) != -1) out.write(bytes, 0, count);
    }
    Intent intent = new Intent(target, NativePlayerActivity.class).setData(Uri.parse("https://example.com/test.mkv"));
    try (ActivityScenario<NativePlayerActivity> scenario = ActivityScenario.launch(intent)) {
      scenario.onActivity(activity -> {
        try {
          Field phase = activity.getClass().getDeclaredField("phase"); phase.setAccessible(true);
          @SuppressWarnings({"rawtypes", "unchecked"}) Object content = Enum.valueOf((Class) phase.getType(), "CONTENT");
          phase.set(activity, content);
          Method play = activity.getClass().getDeclaredMethod("playStream", Uri.class); play.setAccessible(true); play.invoke(activity, Uri.fromFile(video));
        } catch (Exception e) { throw new AssertionError(e); }
      });
      AtomicInteger first = new AtomicInteger(-1), second = new AtomicInteger(-1), count = new AtomicInteger();
      long deadline = SystemClock.elapsedRealtime() + 15000;
      while (count.get() < 6 && SystemClock.elapsedRealtime() < deadline) {
        scenario.onActivity(activity -> {
          try {
            MediaPlayer player = (MediaPlayer) field(activity, "player");
            MediaPlayer.TrackDescription[] tracks = player.getSpuTracks();
            ArrayList<Integer> ids = new ArrayList<>();
            if (tracks != null) for (MediaPlayer.TrackDescription track : tracks) if (track.id >= 0) ids.add(track.id);
            count.set(ids.size()); if (ids.size() >= 2) { first.set(ids.get(0)); second.set(ids.get(1)); }
          } catch (Exception e) { throw new AssertionError(e); }
        });
        if (count.get() < 6) SystemClock.sleep(200);
      }
      assertEquals("six embedded subtitle tracks", 6, count.get());
      scenario.onActivity(activity -> {
        try { select(activity, first.get()); } catch (Exception e) { throw new AssertionError(e); }
      });
      int longPixels = maxPixels(scenario);
      scenario.onActivity(activity -> {
        try {
          Field pending = activity.getClass().getDeclaredField("pendingSubtitleId"); pending.setAccessible(true); pending.set(activity, first.get());
          select(activity, second.get());
          assertNull("user selection cancels pending restore", pending.get(activity));
          Method restore = activity.getClass().getDeclaredMethod("restoreSelectedTracks"); restore.setAccessible(true); restore.invoke(activity);
          assertEquals("selected track is not overwritten", second.get(), ((MediaPlayer) field(activity, "player")).getSpuTrack());
        } catch (Exception e) { throw new AssertionError(e); }
      });
      int shortPixels = maxPixels(scenario);
      scenario.onActivity(activity -> {
        try { select(activity, -1); } catch (Exception e) { throw new AssertionError(e); }
      });
      int offPixels = maxPixels(scenario);
      assertTrue("long subtitle is rendered: " + longPixels, longPixels > 40);
      assertTrue("short subtitle changes the rendered picture: long=" + longPixels + " short=" + shortPixels + " off=" + offPixels, shortPixels > 0 && shortPixels * 2 < longPixels);
      assertTrue("turning subtitles off clears the overlay: " + offPixels, offPixels < longPixels / 3);
    }
  }
}
