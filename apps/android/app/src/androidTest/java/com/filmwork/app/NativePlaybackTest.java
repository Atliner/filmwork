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
import org.videolan.libvlc.interfaces.IMedia;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

/** Runs the real LibVLC renderer on an Android emulator, not a Java source mock. */
@RunWith(AndroidJUnit4.class)
public final class NativePlaybackTest {
  private File copyAsset(String name, Context target) throws Exception {
    File file = new File(target.getFilesDir(), name);
    try (InputStream input = InstrumentationRegistry.getInstrumentation().getContext().getAssets().open(name);
         FileOutputStream output = new FileOutputStream(file)) {
      byte[] buffer = new byte[8192]; int n;
      while ((n = input.read(buffer)) >= 0) output.write(buffer, 0, n);
    }
    return file;
  }

  private static Object field(Object object, String name) throws Exception {
    Field field = object.getClass().getDeclaredField(name); field.setAccessible(true); return field.get(object);
  }
  private static TextureView findTexture(View view) {
    if (view instanceof TextureView) return (TextureView) view;
    if (view instanceof ViewGroup) {
      ViewGroup group = (ViewGroup) view;
      for (int i = 0; i < group.getChildCount(); i++) {
        TextureView found = findTexture(group.getChildAt(i));
        if (found != null) return found;
      }
    }
    return null;
  }
  private static View findByDescription(View view, String description) {
    if (description.contentEquals(view.getContentDescription() == null ? "" : view.getContentDescription())) return view;
    if (view instanceof ViewGroup) {
      ViewGroup group = (ViewGroup) view;
      for (int i = 0; i < group.getChildCount(); i++) {
        View result = findByDescription(group.getChildAt(i), description);
        if (result != null) return result;
      }
    }
    return null;
  }
  private static boolean coloredFrame(TextureView view) {
    if (view == null || !view.isAvailable() || view.getWidth() < 10 || view.getHeight() < 10) return false;
    Bitmap bitmap = view.getBitmap(100, 56);
    if (bitmap == null) return false;
    int colored = 0;
    for (int y = 0; y < bitmap.getHeight(); y += 2) for (int x = 0; x < bitmap.getWidth(); x += 2) {
      int rgb = bitmap.getPixel(x, y) & 0xffffff;
      if (rgb > 0x181818) colored++;
    }
    bitmap.recycle();
    return colored > 100;
  }

  @Test public void rendersVideoAndEnumeratesInternalAndExternalTracks() throws Exception {
    Context target = InstrumentationRegistry.getInstrumentation().getTargetContext();
    File video = copyAsset("test-video.mkv", target);
    File subtitle = copyAsset("test-subtitle.srt", target);
    Intent intent = new Intent(target, NativePlayerActivity.class)
        .setData(Uri.parse("https://example.com/test.mkv"))
        .putExtra("contentId", "34a3f2c2-6edb-4132-a4da-0f14e660bdcc");
    try (ActivityScenario<NativePlayerActivity> scenario = ActivityScenario.launch(intent)) {
      AtomicBoolean started = new AtomicBoolean(false);
      scenario.onActivity(activity -> {
        try {
          // The fixture is app-private and used only in instrumentation. Production
          // entry points still require HTTPS and never expose this test pathway.
          Field phase = activity.getClass().getDeclaredField("phase");
          phase.setAccessible(true);
          @SuppressWarnings({"rawtypes", "unchecked"})
          Object contentPhase = Enum.valueOf((Class) phase.getType(), "CONTENT");
          phase.set(activity, contentPhase);
          Method play = activity.getClass().getDeclaredMethod("playStream", Uri.class);
          play.setAccessible(true); play.invoke(activity, Uri.fromFile(video));
          started.set(true);
        } catch (Exception e) { throw new AssertionError(e); }
      });
      assertTrue("fixture started", started.get());
      AtomicInteger audioTracks = new AtomicInteger();
      AtomicInteger subtitles = new AtomicInteger();
      AtomicBoolean advancing = new AtomicBoolean();
      AtomicBoolean rendered = new AtomicBoolean();
      AtomicBoolean externalAdded = new AtomicBoolean();
      long deadline = SystemClock.elapsedRealtime() + 25000;
      while (SystemClock.elapsedRealtime() < deadline && !(advancing.get() && rendered.get() && audioTracks.get() >= 2 && subtitles.get() >= 1 && externalAdded.get())) {
        scenario.onActivity(activity -> {
          try {
            MediaPlayer player = (MediaPlayer) field(activity, "player");
            advancing.set(player.getTime() > 300);
            MediaPlayer.TrackDescription[] audio = player.getAudioTracks();
            MediaPlayer.TrackDescription[] sub = player.getSpuTracks();
            int audioCount = 0, subCount = 0;
            if (audio != null) for (MediaPlayer.TrackDescription track : audio) if (track.id >= 0) audioCount++;
            if (sub != null) for (MediaPlayer.TrackDescription track : sub) if (track.id >= 0) subCount++;
            audioTracks.set(audioCount); subtitles.set(subCount);
            if (advancing.get() && !externalAdded.get()) externalAdded.set(player.addSlave(IMedia.Slave.Type.Subtitle, Uri.fromFile(subtitle), true));
            rendered.set(coloredFrame(findTexture(activity.getWindow().getDecorView())));
          } catch (Exception e) { throw new AssertionError(e); }
        });
        SystemClock.sleep(250);
      }
      assertTrue("media time advances", advancing.get());
      assertTrue("video produces a visible non-black frame", rendered.get());
      assertTrue("two embedded audio tracks", audioTracks.get() >= 2);
      assertTrue("embedded subtitle track", subtitles.get() >= 1);
      assertTrue("external subtitle accepted by LibVLC", externalAdded.get());
      scenario.onActivity(activity -> {
        try {
          Object originalPlayer = field(activity, "player");
          int sequence = (Integer) field(activity, "mediaStartSequence");
          ((MediaPlayer) originalPlayer).pause();
          Field phase = activity.getClass().getDeclaredField("phase"); phase.setAccessible(true);
          @SuppressWarnings({"rawtypes", "unchecked"}) Object loading = Enum.valueOf((Class) phase.getType(), "AD_LOADING");
          @SuppressWarnings({"rawtypes", "unchecked"}) Object ad = Enum.valueOf((Class) phase.getType(), "AD");
          Field hasContent = activity.getClass().getDeclaredField("adHasContent"); hasContent.setAccessible(true); hasContent.setBoolean(activity, true);
          Field placement = activity.getClass().getDeclaredField("pendingPlacement"); placement.setAccessible(true); placement.set(activity, "pause_overlay");
          Field resume = activity.getClass().getDeclaredField("resumeAfterAd"); resume.setAccessible(true); resume.setBoolean(activity, false);
          Method finishAd = activity.getClass().getDeclaredMethod("finishAd", String.class); finishAd.setAccessible(true);
          phase.set(activity, loading); finishAd.invoke(activity, (Object) null);
          assertSame("no-ad pause preserves loaded content", originalPlayer, field(activity, "player"));
          assertEquals("no-ad pause does not reopen stream", sequence, ((Integer) field(activity, "mediaStartSequence")).intValue());
          // Exercise restoration after a separate ad player uses the same rendering view.
          ((MediaPlayer) originalPlayer).detachViews();
          Field suspended = activity.getClass().getDeclaredField("suspendedContentPlayer"); suspended.setAccessible(true); suspended.set(activity, originalPlayer);
          Field trackFlag = activity.getClass().getDeclaredField("suspendedTracksAdded"); trackFlag.setAccessible(true); trackFlag.setBoolean(activity, true);
          Field active = activity.getClass().getDeclaredField("player"); active.setAccessible(true); active.set(activity, null);
          hasContent.setBoolean(activity, true); placement.set(activity, "pause_overlay"); phase.set(activity, ad);
          Method playAd = activity.getClass().getDeclaredMethod("playStream", Uri.class); playAd.setAccessible(true); playAd.invoke(activity, Uri.fromFile(video));
          int afterAdStart = (Integer) field(activity, "mediaStartSequence");
          finishAd.invoke(activity, (Object) null);
          assertSame("returning from a video ad restores content player", originalPlayer, field(activity, "player"));
          assertEquals("returning from ad does not reopen content", afterAdStart, ((Integer) field(activity, "mediaStartSequence")).intValue());
          sequence = afterAdStart;
          Field scale = activity.getClass().getDeclaredField("subtitleScale"); scale.setAccessible(true); scale.setInt(activity, 12);
          Method save = activity.getClass().getDeclaredMethod("saveDeferredSubtitleStyle"); save.setAccessible(true); save.invoke(activity);
          assertSame("subtitle appearance does not recreate player", originalPlayer, field(activity, "player"));
          assertEquals("subtitle appearance does not start a new stream", sequence, ((Integer) field(activity, "mediaStartSequence")).intValue());
          Method visibility = activity.getClass().getDeclaredMethod("setControlsVisible", boolean.class);
          visibility.setAccessible(true); visibility.invoke(activity, false);
          assertEquals(View.INVISIBLE, ((View) field(activity, "bottomControls")).getVisibility());
          View surface = findByDescription(activity.getWindow().getDecorView(), "نمایش یا پنهان کردن کنترل‌های پخش");
          assertNotNull(surface); surface.performClick();
          assertEquals(View.VISIBLE, ((View) field(activity, "bottomControls")).getVisibility());
          if (((MediaPlayer) originalPlayer).isPlaying()) {
            ((Runnable) field(activity, "hideControls")).run();
            assertEquals(View.INVISIBLE, ((View) field(activity, "topControls")).getVisibility());
          }
          String variants = "[{\"label\":\"720p WEB-DL\",\"streamUrl\":\"https://example.com/one.mkv\",\"season\":1,\"episode\":1,\"subtitleUrls\":[],\"audioUrls\":[]}," +
              "{\"label\":\"1080p Blu-ray\",\"streamUrl\":\"https://example.com/two.mkv\",\"season\":1,\"episode\":1,\"subtitleUrls\":[\"https://example.com/two.srt\"],\"audioUrls\":[]}]";
          Method loadVersions = activity.getClass().getDeclaredMethod("loadVersions", String.class); loadVersions.setAccessible(true); loadVersions.invoke(activity, variants);
          long positionBeforeSwitch = Math.max(0, ((MediaPlayer) originalPlayer).getTime());
          Method switchVersion = activity.getClass().getDeclaredMethod("switchVersion", int.class); switchVersion.setAccessible(true); switchVersion.invoke(activity, 1);
          assertEquals("https://example.com/two.mkv", field(activity, "source").toString());
          assertEquals("switching quality preserves position", positionBeforeSwitch, ((Long) field(activity, "pendingSeek")).longValue());
          assertEquals("selected version's subtitle is used", 1, ((java.util.List<?>) field(activity, "subtitles")).size());
        } catch (Exception e) { throw new AssertionError(e); }
      });
    }
  }
}
