package com.filmwork.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.SurfaceView;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.SeekBar;
import android.widget.TextView;
import android.widget.Toast;

import org.videolan.libvlc.LibVLC;
import org.videolan.libvlc.Media;
import org.videolan.libvlc.MediaPlayer;

import java.util.ArrayList;
import java.util.Locale;

/** Native VLC playback for HTTPS streams. This activity is not exported. */
public final class NativePlayerActivity extends Activity {
  private LibVLC vlc;
  private MediaPlayer player;
  private final Handler handler = new Handler(Looper.getMainLooper());
  private SeekBar seek;
  private TextView elapsed;
  private TextView duration;
  private Button play;
  private boolean seeking;
  private final Runnable update = new Runnable() {
    @Override public void run() {
      if (player == null) return;
      long length = player.getLength();
      long time = player.getTime();
      if (!seeking) seek.setProgress(length > 0 ? (int) Math.min(1000, Math.max(0, time * 1000 / length)) : 0);
      elapsed.setText(formatTime(time));
      duration.setText(formatTime(length));
      play.setText(player.isPlaying() ? "توقف" : "پخش");
      handler.postDelayed(this, 500);
    }
  };

  static Uri validStreamUri(String value) {
    if (value == null || value.length() > 8192) return null;
    Uri uri = Uri.parse(value);
    if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null || uri.getHost().isEmpty()
        || uri.getUserInfo() != null) return null;
    return uri;
  }

  @SuppressWarnings("deprecation")
  @Override public void onCreate(Bundle state) {
    super.onCreate(state);
    Uri source = validStreamUri(getIntent().getDataString());
    if (source == null) { finish(); return; }
    getWindow().setStatusBarColor(Color.BLACK);
    getWindow().setNavigationBarColor(Color.BLACK);
    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    if (Build.VERSION.SDK_INT >= 30) getWindow().setDecorFitsSystemWindows(false);
    else getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE
        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);

    FrameLayout root = new FrameLayout(this);
    root.setBackgroundColor(Color.BLACK);
    FrameLayout content = new FrameLayout(this);
    root.addView(content, new FrameLayout.LayoutParams(-1, -1));
    root.setOnApplyWindowInsetsListener((v, insets) -> {
      int l, t, r, b;
      if (Build.VERSION.SDK_INT >= 30) {
        Insets i = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
        l = i.left; t = i.top; r = i.right; b = i.bottom;
      } else {
        l = insets.getSystemWindowInsetLeft(); t = insets.getSystemWindowInsetTop();
        r = insets.getSystemWindowInsetRight(); b = insets.getSystemWindowInsetBottom();
        if (Build.VERSION.SDK_INT >= 28 && insets.getDisplayCutout() != null) {
          l = Math.max(l, insets.getDisplayCutout().getSafeInsetLeft());
          t = Math.max(t, insets.getDisplayCutout().getSafeInsetTop());
          r = Math.max(r, insets.getDisplayCutout().getSafeInsetRight());
          b = Math.max(b, insets.getDisplayCutout().getSafeInsetBottom());
        }
      }
      content.setPadding(l, t, r, b);
      return insets;
    });
    SurfaceView surface = new SurfaceView(this);
    content.addView(surface, new FrameLayout.LayoutParams(-1, -1));
    LinearLayout controls = new LinearLayout(this);
    controls.setOrientation(LinearLayout.VERTICAL);
    controls.setPadding(dp(8), dp(8), dp(8), dp(8));
    controls.setBackgroundColor(0xdd101014);
    FrameLayout.LayoutParams controlParams = new FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM);
    content.addView(controls, controlParams);
    LinearLayout timeline = new LinearLayout(this);
    timeline.setGravity(Gravity.CENTER_VERTICAL);
    timeline.setLayoutDirection(View.LAYOUT_DIRECTION_LTR);
    elapsed = timeLabel(); duration = timeLabel();
    seek = new SeekBar(this); seek.setMax(1000);
    timeline.addView(elapsed); timeline.addView(seek, new LinearLayout.LayoutParams(0, -2, 1)); timeline.addView(duration);
    controls.addView(timeline);
    LinearLayout actions = new LinearLayout(this);
    actions.setGravity(Gravity.CENTER);
    actions.setLayoutDirection(View.LAYOUT_DIRECTION_RTL);
    play = button("توقف", () -> { if (player.isPlaying()) player.pause(); else player.play(); });
    actions.addView(play, new LinearLayout.LayoutParams(0, -2, 1));
    actions.addView(button("صدا", () -> showTracks(false)), new LinearLayout.LayoutParams(0, -2, 1));
    actions.addView(button("زیرنویس", () -> showTracks(true)), new LinearLayout.LayoutParams(0, -2, 1));
    actions.addView(button("بازگشت", this::finish), new LinearLayout.LayoutParams(0, -2, 1));
    controls.addView(actions);
    setContentView(root);
    root.requestApplyInsets();

    ArrayList<String> options = new ArrayList<>();
    options.add("--network-caching=1500");
    vlc = new LibVLC(this, options);
    player = new MediaPlayer(vlc);
    player.getVLCVout().setVideoView(surface);
    player.getVLCVout().attachViews();
    surface.addOnLayoutChangeListener((v, left, top, right, bottom, ol, ot, oright, ob) -> {
      if (player != null) player.getVLCVout().setWindowSize(right - left, bottom - top);
    });
    player.setEventListener(event -> {
      if (event.type == MediaPlayer.Event.EncounteredError) runOnUiThread(() ->
          Toast.makeText(this, "پخش فایل ممکن نشد. اتصال و نشانی فایل را بررسی کنید.", Toast.LENGTH_LONG).show());
    });
    Media media = new Media(vlc, source);
    player.setMedia(media);
    media.release();
    seek.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
      @Override public void onProgressChanged(SeekBar bar, int value, boolean user) { }
      @Override public void onStartTrackingTouch(SeekBar bar) { seeking = true; }
      @Override public void onStopTrackingTouch(SeekBar bar) {
        long length = player.getLength();
        if (length > 0) player.setTime(length * bar.getProgress() / 1000);
        seeking = false;
      }
    });
    player.play();
    handler.post(update);
  }

  private void showTracks(boolean subtitles) {
    MediaPlayer.TrackDescription[] tracks = subtitles ? player.getSpuTracks() : player.getAudioTracks();
    if (tracks == null || tracks.length == 0) {
      Toast.makeText(this, "هنوز ترکی پیدا نشده است؛ پس از شروع پخش دوباره امتحان کنید.", Toast.LENGTH_SHORT).show();
      return;
    }
    String[] names = new String[tracks.length];
    int selectedId = subtitles ? player.getSpuTrack() : player.getAudioTrack();
    int selected = -1;
    for (int i = 0; i < tracks.length; i++) {
      names[i] = tracks[i].id == -1 ? "خاموش" : (tracks[i].name == null || tracks[i].name.trim().isEmpty()
          ? "ترک " + (i + 1) : tracks[i].name);
      if (tracks[i].id == selectedId) selected = i;
    }
    new AlertDialog.Builder(this).setTitle(subtitles ? "انتخاب زیرنویس" : "انتخاب صدا")
        .setSingleChoiceItems(names, selected, (dialog, which) -> {
          boolean success = subtitles ? player.setSpuTrack(tracks[which].id) : player.setAudioTrack(tracks[which].id);
          if (!success) Toast.makeText(this, "انتخاب این ترک ممکن نشد.", Toast.LENGTH_SHORT).show();
          dialog.dismiss();
        }).setNegativeButton("بستن", null).show();
  }

  private int dp(int value) { return (int) (value * getResources().getDisplayMetrics().density + 0.5f); }
  private TextView timeLabel() { TextView text = new TextView(this); text.setTextColor(Color.WHITE); text.setText("00:00"); return text; }
  private Button button(String text, Runnable action) {
    Button result = new Button(this); result.setText(text); result.setAllCaps(false);
    result.setTextSize(12); result.setMinWidth(0); result.setMinimumWidth(0); result.setPadding(0, 0, 0, 0);
    result.setOnClickListener(view -> action.run()); return result;
  }
  private static String formatTime(long milliseconds) {
    long total = Math.max(0, milliseconds / 1000);
    return total >= 3600 ? String.format(Locale.ROOT, "%02d:%02d:%02d", total / 3600, total / 60 % 60, total % 60)
        : String.format(Locale.ROOT, "%02d:%02d", total / 60, total % 60);
  }
  @Override protected void onStop() { if (player != null && player.isPlaying()) player.pause(); super.onStop(); }
  @Override protected void onDestroy() {
    handler.removeCallbacksAndMessages(null);
    if (player != null) { player.stop(); player.getVLCVout().detachViews(); player.release(); player = null; }
    if (vlc != null) { vlc.release(); vlc = null; }
    super.onDestroy();
  }
}
