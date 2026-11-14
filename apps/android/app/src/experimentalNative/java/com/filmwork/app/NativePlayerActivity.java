package com.filmwork.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.os.SystemClock;
import android.graphics.Color;
import android.graphics.Insets;
import android.graphics.Bitmap;
import android.graphics.drawable.GradientDrawable;
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
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ImageView;
import android.widget.ScrollView;
import android.widget.SeekBar;
import android.widget.TextView;
import android.widget.Toast;

import org.videolan.libvlc.LibVLC;
import org.videolan.libvlc.Media;
import org.videolan.libvlc.MediaPlayer;
import org.videolan.libvlc.interfaces.IMedia;

import java.util.ArrayList;
import java.util.Locale;

/**
 * Experimental native renderer. Intentionally NOT registered or reachable from
 * the release app until ad playback, progress, and origin-scoped bridge are wired.
 * Only direct HTTPS sources are accepted. Never put a site token in an Intent URL.
 */
public final class NativePlayerActivity extends Activity {
  private final Handler handler = new Handler(Looper.getMainLooper());
  private final ArrayList<Uri> subtitles = new ArrayList<>();
  private final ArrayList<Uri> audios = new ArrayList<>();
  private LibVLC vlc;
  private MediaPlayer player;
  private SurfaceView surface;
  private Uri source;
  private TextView elapsed;
  private TextView duration;
  private TextView audioCount;
  private TextView subtitleCount;
  private Button play;
  private SeekBar seek;
  private enum Phase { LOADING, CONTENT, AD_LOADING, AD, FINISHED }
  private Phase phase = Phase.LOADING;
  private NativeAdClient adClient;
  private NativeAdClient.Ad activeAd;
  private FrameLayout adLayer;
  private FrameLayout bannerHost;
  private boolean bannerPlayerScheduled;
  private boolean waitingPauseBanner;
  private String sessionToken;
  private TextView adCaption;
  private Button adSkip;
  private String contentId;
  private boolean visible;
  private boolean preRollDone;
  private boolean midRollDone;
  private boolean postRollDone;
  private boolean adImpression;
  private boolean resumeAfterAd;
  private boolean finishAfterAd;
  private String pendingPlacement;
  private long adStartedAt;
  private long lastProgressAt;
  private boolean userSeeking;
  private boolean tracksAdded;
  private boolean resumeAfterRebuild = true;
  private AlertDialog trackDialog;
  private long pendingSeek;
  private long subtitleDelayUs;
  private Integer pendingAudioId;
  private Integer pendingSubtitleId;
  private int restoreAttempts;
  private int subtitleScale = 16;
  private int subtitleColor = 0xffffff;
  private int subtitleFontIndex = 0;
  private final String[] fontLabels = {"پیش‌فرض", "نسخ", "ساده"};
  private final String[] fontPaths = {"", "/system/fonts/NotoNaskhArabic-Regular.ttf", "/system/fonts/Roboto-Regular.ttf"};
  private final Runnable update = new Runnable() {
    @Override public void run() {
      if (player == null || isFinishing()) return;
      if (phase == Phase.AD && activeAd != null) {
        long elapsedAd = Math.max(0, player.getTime());
        long left = Math.max(0, activeAd.skipSeconds * 1000L - elapsedAd);
        adSkip.setEnabled(left == 0 && adImpression);
        adSkip.setText(left == 0 ? "رد کردن تبلیغ" : "رد کردن · " + ((left + 999) / 1000));
        if (visible && !adImpression && SystemClock.elapsedRealtime() - adStartedAt > 20000) finishAd(null);
      } else if (phase == Phase.CONTENT) {
        long length = Math.max(0, player.getLength());
        long position = Math.max(0, player.getTime());
        if (!userSeeking) seek.setProgress(length > 0 ? (int) Math.min(1000, position * 1000 / length) : 0);
        elapsed.setText(formatTime(position)); duration.setText(formatTime(length));
        play.setText(player.isPlaying() ? "❚❚" : "▶");
        audioCount.setText("صدا " + trackCount(player.getAudioTracks()));
        subtitleCount.setText("زیرنویس " + trackCount(player.getSpuTracks()));
        restoreSelectedTracks();
        if (visible && player.isPlaying() && length > 60000 && position >= length / 2 && !midRollDone) {
          midRollDone = true;
          requestInterstitial("mid_roll", true, false);
        } else if (visible && player.isPlaying() && SystemClock.elapsedRealtime() - lastProgressAt >= 15000) {
          saveContentProgress(false);
        }
      }
      handler.postDelayed(this, 500);
    }
  };

  static Uri safeHttps(String value) {
    if (value == null || value.length() > 8192) return null;
    Uri uri = Uri.parse(value);
    if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null
        || uri.getHost().isEmpty() || uri.getUserInfo() != null) return null;
    return uri;
  }

  @SuppressWarnings("deprecation")
  @Override public void onCreate(Bundle savedState) {
    super.onCreate(savedState);
    source = safeHttps(getIntent().getDataString());
    if (source == null) { finish(); return; }
    getWindow().setStatusBarColor(Color.BLACK);
    getWindow().setNavigationBarColor(Color.BLACK);
    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    if (Build.VERSION.SDK_INT >= 30) getWindow().setDecorFitsSystemWindows(false);
    else getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE
        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
    appendUrls(getIntent().getStringArrayListExtra("subtitleUrls"), subtitles);
    appendUrls(getIntent().getStringArrayListExtra("audioUrls"), audios);
    pendingSeek = Math.max(0, getIntent().getLongExtra("resumeMillis", 0));
    if (savedState != null) {
      pendingSeek = Math.max(0, savedState.getLong("position", pendingSeek));
      subtitleDelayUs = savedState.getLong("subtitleDelayUs", 0);
      subtitleScale = savedState.getInt("subtitleScale", 16);
      subtitleColor = savedState.getInt("subtitleColor", 0xffffff);
      subtitleFontIndex = Math.max(0, Math.min(fontPaths.length - 1, savedState.getInt("subtitleFont", 0)));
      appendUrls(savedState.getStringArrayList("subtitleUrls"), subtitles);
      appendUrls(savedState.getStringArrayList("audioUrls"), audios);
      resumeAfterRebuild = savedState.getBoolean("wasPlaying", true);
      if (savedState.containsKey("audioTrack")) pendingAudioId = savedState.getInt("audioTrack");
      if (savedState.containsKey("subtitleTrack")) pendingSubtitleId = savedState.getInt("subtitleTrack");
    }
    contentId = getIntent().getStringExtra("contentId");
    sessionToken = getIntent().getStringExtra("sessionToken");
    if (savedState == null) {
      android.content.SharedPreferences prefs = getSharedPreferences("vizosten-player", MODE_PRIVATE);
      subtitleDelayUs = Math.max(-60000000L, Math.min(60000000L, prefs.getLong("subtitleDelayUs", 0)));
      subtitleScale = Math.max(6, Math.min(20, prefs.getInt("subtitleScale", 16)));
      subtitleColor = prefs.getInt("subtitleColor", 0xffffff) & 0xffffff;
      subtitleFontIndex = Math.max(0, Math.min(fontPaths.length - 1, prefs.getInt("subtitleFont", 0)));
      if ((sessionToken == null || sessionToken.isEmpty()) && contentId != null && pendingSeek == 0) {
        pendingSeek = Math.max(0, prefs.getLong("progress:" + contentId, 0));
      }
    }
    adClient = new NativeAdClient(BuildConfig.APP_URL, sessionToken);
    buildUi();
    createEngine();
    if (savedState != null) {
      preRollDone = savedState.getBoolean("preRollDone", false);
      midRollDone = savedState.getBoolean("midRollDone", false);
      postRollDone = savedState.getBoolean("postRollDone", false);
    }
    String interruptedAd = savedState == null ? null : savedState.getString("interruptedAd");
    if (interruptedAd != null) {
      requestInterstitial(interruptedAd, savedState.getBoolean("adResume", true), savedState.getBoolean("adFinish", false));
    } else if (preRollDone) startContent();
    else requestInterstitial("pre_roll", true, false);
    handler.post(update);
  }

  private void appendUrls(ArrayList<String> urls, ArrayList<Uri> target) {
    if (urls == null) return;
    for (String url : urls) {
      Uri uri = safeHttps(url);
      if (uri != null && !target.contains(uri) && target.size() < 30) target.add(uri);
    }
  }

  private void buildUi() {
    FrameLayout root = new FrameLayout(this);
    root.setBackgroundColor(Color.BLACK);
    FrameLayout content = new FrameLayout(this);
    root.addView(content, new FrameLayout.LayoutParams(-1, -1));
    root.setOnApplyWindowInsetsListener((view, insets) -> {
      int left, top, right, bottom;
      if (Build.VERSION.SDK_INT >= 30) {
        Insets safe = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
        left = safe.left; top = safe.top; right = safe.right; bottom = safe.bottom;
      } else {
        left = insets.getSystemWindowInsetLeft(); top = insets.getSystemWindowInsetTop();
        right = insets.getSystemWindowInsetRight(); bottom = insets.getSystemWindowInsetBottom();
        if (Build.VERSION.SDK_INT >= 28 && insets.getDisplayCutout() != null) {
          left = Math.max(left, insets.getDisplayCutout().getSafeInsetLeft());
          top = Math.max(top, insets.getDisplayCutout().getSafeInsetTop());
          right = Math.max(right, insets.getDisplayCutout().getSafeInsetRight());
          bottom = Math.max(bottom, insets.getDisplayCutout().getSafeInsetBottom());
        }
      }
      content.setPadding(left, top, right, bottom);
      return insets;
    });
    surface = new SurfaceView(this);
    content.addView(surface, new FrameLayout.LayoutParams(-1, -1));
    surface.addOnLayoutChangeListener((v, left, top, right, bottom, oldLeft, oldTop, oldRight, oldBottom) -> {
      if (player != null) player.getVLCVout().setWindowSize(right - left, bottom - top);
    });

    LinearLayout top = new LinearLayout(this);
    top.setGravity(Gravity.CENTER_VERTICAL);
    top.setPadding(dp(8), dp(4), dp(8), dp(4));
    top.setBackgroundColor(0xc9000000);
    FrameLayout.LayoutParams topParams = new FrameLayout.LayoutParams(-1, -2, Gravity.TOP);
    content.addView(top, topParams);
    top.addView(button("‹", this::finish));
    TextView title = label(getIntent().getStringExtra("title") == null ? "ویزوستن" : getIntent().getStringExtra("title"), 14);
    title.setMaxLines(2);
    top.addView(title, new LinearLayout.LayoutParams(0, -2, 1));
    audioCount = label("صدا", 12); audioCount.setOnClickListener(v -> showTracks(false));
    subtitleCount = label("زیرنویس", 12); subtitleCount.setOnClickListener(v -> showTracks(true));
    audioCount.setPadding(dp(8), dp(12), dp(8), dp(12));
    subtitleCount.setPadding(dp(8), dp(12), dp(8), dp(12));
    top.addView(audioCount); top.addView(subtitleCount);
    top.addView(button("⚙", this::showSubtitleSettings));

    LinearLayout center = new LinearLayout(this);
    center.setGravity(Gravity.CENTER);
    center.setOrientation(LinearLayout.HORIZONTAL);
    FrameLayout.LayoutParams centerParams = new FrameLayout.LayoutParams(-1, -2, Gravity.CENTER);
    content.addView(center, centerParams);
    center.addView(button("↶ ۱۰", () -> seekRelative(-10000)));
    play = button("▶", () -> {
      if (player == null) return;
      if (phase == Phase.FINISHED) {
        pendingSeek = 0; preRollDone = false; midRollDone = false; postRollDone = false;
        requestInterstitial("pre_roll", true, false);
        return;
      }
      if (phase != Phase.CONTENT) return;
      if (player.isPlaying()) {
        player.pause();
        saveContentProgress(true);
        if (player.getTime() > 1000) requestInterstitial("pause_overlay", false, false);
      } else { clearBanner(); player.play(); }
    });
    center.addView(play);
    center.addView(button("۱۰ ↷", () -> seekRelative(10000)));

    LinearLayout timeline = new LinearLayout(this);
    timeline.setGravity(Gravity.CENTER_VERTICAL);
    timeline.setLayoutDirection(View.LAYOUT_DIRECTION_LTR);
    timeline.setPadding(dp(10), dp(6), dp(10), dp(6));
    timeline.setBackgroundColor(0xc9000000);
    FrameLayout.LayoutParams timelineParams = new FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM);
    content.addView(timeline, timelineParams);
    elapsed = label("00:00", 12); duration = label("00:00", 12);
    seek = new SeekBar(this); seek.setMax(1000);
    timeline.addView(elapsed); timeline.addView(seek, new LinearLayout.LayoutParams(0, -2, 1)); timeline.addView(duration);
    seek.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
      @Override public void onProgressChanged(SeekBar bar, int value, boolean fromUser) { }
      @Override public void onStartTrackingTouch(SeekBar bar) { userSeeking = true; }
      @Override public void onStopTrackingTouch(SeekBar bar) {
        if (phase == Phase.CONTENT && player != null && player.getLength() > 0) player.setTime(player.getLength() * bar.getProgress() / 1000);
        userSeeking = false;
      }
    });
    bannerHost = new FrameLayout(this);
    FrameLayout.LayoutParams bannerParams = new FrameLayout.LayoutParams(-1, dp(88), Gravity.BOTTOM);
    bannerParams.bottomMargin = dp(54);
    content.addView(bannerHost, bannerParams);
    bannerHost.setVisibility(View.GONE);
    adLayer = new FrameLayout(this);
    adLayer.setVisibility(View.GONE);
    content.addView(adLayer, new FrameLayout.LayoutParams(-1, -1));
    setContentView(root);
    root.requestApplyInsets();
  }

  private void createEngine() {
    ArrayList<String> options = new ArrayList<>();
    options.add("--network-caching=1500");
    options.add("--freetype-rel-fontsize=" + subtitleScale);
    options.add("--freetype-color=" + subtitleColor);
    if (!fontPaths[subtitleFontIndex].isEmpty()) options.add("--freetype-font=" + fontPaths[subtitleFontIndex]);
    vlc = new LibVLC(this, options);
    player = new MediaPlayer(vlc);
    player.getVLCVout().setVideoView(surface);
    player.getVLCVout().attachViews();
    if (surface.getWidth() > 0 && surface.getHeight() > 0) player.getVLCVout().setWindowSize(surface.getWidth(), surface.getHeight());
    tracksAdded = false;
    final MediaPlayer activePlayer = player;
    player.setEventListener(event -> {
      if (event.type == MediaPlayer.Event.Playing) runOnUiThread(() -> { if (player == activePlayer) onMediaPlaying(); });
      if (event.type == MediaPlayer.Event.EndReached) runOnUiThread(() -> { if (player == activePlayer) onMediaEnded(); });
      if (event.type == MediaPlayer.Event.EncounteredError) runOnUiThread(() -> {
        if (player != activePlayer) return;
        if (phase == Phase.AD) finishAd(null);
        else Toast.makeText(this, "پخش ممکن نشد؛ اتصال، قالب و نشانی فایل را بررسی کنید.", Toast.LENGTH_LONG).show();
      });
    });
  }

  private void playStream(Uri uri) {
    if (player == null) return;
    Media media = new Media(vlc, uri);
    player.setMedia(media);
    media.release();
    if (visible) player.play();
  }

  private void onMediaPlaying() {
    if (player == null) return;
    if (phase == Phase.AD) {
      if (visible && !adImpression && activeAd != null) {
        adImpression = true;
        adClient.record(activeAd, "impression");
      }
      return;
    }
    if (phase != Phase.CONTENT || tracksAdded) return;
    tracksAdded = true;
    for (Uri uri : subtitles) player.addSlave(IMedia.Slave.Type.Subtitle, uri, false);
    for (Uri uri : audios) player.addSlave(IMedia.Slave.Type.Audio, uri, false);
    if (pendingSeek > 0) { player.setTime(pendingSeek); pendingSeek = 0; }
    player.setSpuDelay(subtitleDelayUs);
    if (!resumeAfterRebuild) player.pause();
    resumeAfterRebuild = true;
    if (waitingPauseBanner) { waitingPauseBanner = false; showBanner("banner_pause"); }
    if (!bannerPlayerScheduled) {
      bannerPlayerScheduled = true;
      handler.postDelayed(() -> { if (phase == Phase.CONTENT && visible && player != null && player.isPlaying()) showBanner("banner_player"); }, 8000);
    }
  }

  /** The original file is always paused while the ad occupies the renderer. */
  private void requestInterstitial(String placement, boolean resume, boolean finishAfter) {
    if (player == null || phase == Phase.AD || phase == Phase.AD_LOADING || isFinishing()) return;
    if (phase == Phase.CONTENT) {
      pendingSeek = Math.max(0, player.getTime());
      pendingAudioId = player.getAudioTrack();
      pendingSubtitleId = player.getSpuTrack();
      restoreAttempts = 0;
      saveContentProgress(true);
      if (player.isPlaying()) player.pause();
    }
    clearBanner();
    pendingPlacement = placement;
    resumeAfterAd = resume;
    finishAfterAd = finishAfter;
    phase = Phase.AD_LOADING;
    adLayer.removeAllViews();
    adLayer.setBackgroundColor(0xcc000000);
    adLayer.setClickable(true);
    adLayer.setVisibility(View.VISIBLE);
    TextView loading = label("در حال دریافت تبلیغ…", 15);
    loading.setGravity(Gravity.CENTER);
    adLayer.addView(loading, new FrameLayout.LayoutParams(-1, -1));
    adClient.requestAd(placement, ad -> {
      if (phase != Phase.AD_LOADING || isFinishing()) return;
      if (ad == null || !"video".equals(ad.assetType)) { finishAd(null); return; }
      activeAd = ad;
      adImpression = false;
      phase = Phase.AD;
      showAdControls(ad);
      adStartedAt = SystemClock.elapsedRealtime();
      playStream(safeHttps(ad.creativeUrl));
    });
  }

  private void showAdControls(NativeAdClient.Ad ad) {
    adLayer.removeAllViews();
    // Transparent in the middle so native video remains visible; the layer
    // intercepts taps and prevents seeking or changing the content during ads.
    adLayer.setBackgroundColor(Color.TRANSPARENT);
    adLayer.setClickable(true);
    LinearLayout bar = new LinearLayout(this);
    bar.setPadding(dp(12), dp(8), dp(12), dp(8));
    bar.setGravity(Gravity.CENTER_VERTICAL);
    bar.setBackgroundColor(0xdd000000);
    FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM);
    adLayer.addView(bar, params);
    adCaption = label("تبلیغ · " + ad.headline, 13);
    adCaption.setMaxLines(2);
    adCaption.setOnClickListener(view -> {
      adClient.record(ad, "click");
      try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(adClient.tunnelUrl(ad)))); }
      catch (Exception ignored) { Toast.makeText(this, "باز کردن تبلیغ ممکن نشد.", Toast.LENGTH_SHORT).show(); }
    });
    bar.addView(adCaption, new LinearLayout.LayoutParams(0, -2, 1));
    adSkip = button("رد کردن", () -> {
      if (adSkip.isEnabled() && phase == Phase.AD) finishAd("skip");
    });
    adSkip.setEnabled(false);
    bar.addView(adSkip);
  }

  private void finishAd(String outcome) {
    if (phase != Phase.AD && phase != Phase.AD_LOADING) return;
    if (activeAd != null && adImpression && outcome != null) adClient.record(activeAd, outcome);
    activeAd = null;
    adLayer.setVisibility(View.GONE);
    adLayer.removeAllViews();
    if ("pre_roll".equals(pendingPlacement)) preRollDone = true;
    waitingPauseBanner = !resumeAfterAd && "pause_overlay".equals(pendingPlacement);
    pendingPlacement = null;
    if (finishAfterAd) {
      phase = Phase.FINISHED;
      play.setText("▶");
      return;
    }
    resumeAfterRebuild = resumeAfterAd;
    startContent();
  }

  private void startContent() {
    if (player == null || isFinishing()) return;
    phase = Phase.CONTENT;
    tracksAdded = false;
    playStream(source);
  }

  private void onMediaEnded() {
    if (phase == Phase.AD) { finishAd("complete"); return; }
    if (phase != Phase.CONTENT || postRollDone) return;
    long length = Math.max(0, player.getLength());
    if (length > 0) {
      adClient.saveProgress(contentId, length, length);
      if ((sessionToken == null || sessionToken.isEmpty()) && contentId != null)
        getSharedPreferences("vizosten-player", MODE_PRIVATE).edit().putLong("progress:" + contentId, 0).apply();
    }
    postRollDone = true;
    requestInterstitial("timed_banner", false, true);
  }

  private void clearBanner() {
    if (bannerHost == null) return;
    bannerHost.setVisibility(View.GONE);
    bannerHost.removeAllViews();
    bannerHost.setTag(null);
  }

  private void showBanner(String placement) {
    if (!visible || phase != Phase.CONTENT || player == null || isFinishing()) return;
    final boolean pausePlacement = "banner_pause".equals(placement);
    if (pausePlacement == player.isPlaying()) return;
    adClient.requestAd(placement, ad -> {
      if (ad == null || !"image".equals(ad.assetType) || !visible || phase != Phase.CONTENT
          || player == null || pausePlacement == player.isPlaying()) return;
      adClient.loadImage(ad, bitmap -> {
        if (bitmap == null || !visible || phase != Phase.CONTENT || player == null || pausePlacement == player.isPlaying()) return;
        renderBanner(ad, bitmap);
      });
    });
  }

  private void renderBanner(NativeAdClient.Ad ad, Bitmap bitmap) {
    clearBanner();
    final String displayId = ad.id + ":" + ad.session;
    bannerHost.setTag(displayId);
    LinearLayout card = new LinearLayout(this);
    card.setGravity(Gravity.CENTER_VERTICAL);
    card.setPadding(dp(8), dp(6), dp(8), dp(6));
    card.setBackgroundColor(0xee17171b);
    ImageView image = new ImageView(this);
    image.setImageBitmap(bitmap); image.setScaleType(ImageView.ScaleType.CENTER_CROP);
    card.addView(image, new LinearLayout.LayoutParams(dp(100), -1));
    TextView caption = label("تبلیغ · " + ad.headline, 12);
    caption.setPadding(dp(10), 0, dp(10), 0); caption.setMaxLines(3);
    card.addView(caption, new LinearLayout.LayoutParams(0, -2, 1));
    card.setOnClickListener(view -> {
      adClient.record(ad, "click");
      try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(adClient.tunnelUrl(ad)))); }
      catch (Exception ignored) { Toast.makeText(this, "باز کردن تبلیغ ممکن نشد.", Toast.LENGTH_SHORT).show(); }
    });
    bannerHost.addView(card, new FrameLayout.LayoutParams(-1, -1));
    bannerHost.setVisibility(View.VISIBLE);
    bannerHost.post(() -> {
      if (visible && phase == Phase.CONTENT && bannerHost.isShown() && displayId.equals(bannerHost.getTag())) adClient.record(ad, "impression");
    });
    handler.postDelayed(() -> { if (displayId.equals(bannerHost.getTag())) clearBanner(); }, ad.durationSeconds * 1000L);
  }

  private void saveContentProgress(boolean force) {
    if (player == null || adClient == null || phase != Phase.CONTENT) return;
    long now = SystemClock.elapsedRealtime();
    if (!force && now - lastProgressAt < 15000) return;
    long length = player.getLength();
    long position = player.getTime();
    if (length <= 0 || position < 1000) return;
    lastProgressAt = now;
    if ((sessionToken == null || sessionToken.isEmpty()) && contentId != null) {
      long saved = position * 100 / length >= 92 ? 0 : position;
      getSharedPreferences("vizosten-player", MODE_PRIVATE).edit().putLong("progress:" + contentId, saved).apply();
    }
    adClient.saveProgress(contentId, position, length);
  }

  private void restoreSelectedTracks() {
    if (player == null || !tracksAdded || (pendingAudioId == null && pendingSubtitleId == null)) return;
    if (pendingSubtitleId != null && pendingSubtitleId == -1) {
      player.setSpuTrack(-1);
      pendingSubtitleId = null;
    }
    MediaPlayer.TrackDescription[] subTracks = player.getSpuTracks();
    if (pendingSubtitleId != null && subTracks != null) for (MediaPlayer.TrackDescription track : subTracks) {
      if (track.id == pendingSubtitleId && player.setSpuTrack(track.id)) { pendingSubtitleId = null; break; }
    }
    MediaPlayer.TrackDescription[] audioTracks = player.getAudioTracks();
    if (pendingAudioId != null && audioTracks != null) for (MediaPlayer.TrackDescription track : audioTracks) {
      if (track.id == pendingAudioId && player.setAudioTrack(track.id)) { pendingAudioId = null; break; }
    }
    if (++restoreAttempts >= 30) { pendingAudioId = null; pendingSubtitleId = null; }
  }

  private void seekRelative(long delta) {
    if (player == null || phase != Phase.CONTENT) return;
    long max = player.getLength() > 0 ? player.getLength() : Long.MAX_VALUE;
    player.setTime(Math.max(0, Math.min(max, player.getTime() + delta)));
  }

  private static int trackCount(MediaPlayer.TrackDescription[] tracks) {
    int count = 0;
    if (tracks != null) for (MediaPlayer.TrackDescription track : tracks) if (track.id >= 0) count++;
    return count;
  }

  private void showTracks(boolean isSubtitle) {
    if (player == null) return;
    MediaPlayer.TrackDescription[] tracks = isSubtitle ? player.getSpuTracks() : player.getAudioTracks();
    int selected = isSubtitle ? player.getSpuTrack() : player.getAudioTrack();
    LinearLayout list = new LinearLayout(this);
    list.setOrientation(LinearLayout.VERTICAL);
    list.setPadding(dp(16), dp(8), dp(16), dp(8));
    if (isSubtitle) addTrackButton(list, "خاموش", selected == -1, () -> player.setSpuTrack(-1));
    if (tracks != null) for (MediaPlayer.TrackDescription track : tracks) {
      if (track.id < 0) continue;
      String name = track.name == null ? "" : track.name.trim();
      name = name.replaceAll("(?i)\\s*\\(null\\)", "").trim();
      if (name.isEmpty() || name.equalsIgnoreCase("null")) name = "ترک " + track.id;
      final int id = track.id;
      addTrackButton(list, name, id == selected, () -> { if (isSubtitle) player.setSpuTrack(id); else player.setAudioTrack(id); });
    }
    Button add = button(isSubtitle ? "افزودن لینک زیرنویس" : "افزودن لینک صدا", () -> {
      if (trackDialog != null) trackDialog.dismiss();
      promptTrackUrl(isSubtitle);
    });
    list.addView(add, new LinearLayout.LayoutParams(-1, -2));
    ScrollView scroller = new ScrollView(this); scroller.addView(list);
    trackDialog = new AlertDialog.Builder(this).setTitle(isSubtitle ? "انتخاب زیرنویس" : "انتخاب صدا")
        .setView(scroller).setNegativeButton("بستن", null).create();
    trackDialog.show();
  }

  private void addTrackButton(LinearLayout list, String text, boolean selected, Runnable action) {
    Button item = button((selected ? "✓  " : "") + text, () -> {
      action.run();
      if (trackDialog != null) trackDialog.dismiss();
    });
    item.setAllCaps(false); item.setSingleLine(false); item.setMaxLines(5);
    item.setGravity(Gravity.RIGHT | Gravity.CENTER_VERTICAL);
    item.setTextColor(selected ? 0xffef4444 : Color.WHITE);
    list.addView(item, new LinearLayout.LayoutParams(-1, -2));
  }

  private void promptTrackUrl(boolean subtitle) {
    EditText field = new EditText(this);
    field.setSingleLine(true);
    field.setHint("https://…");
    field.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_URI);
    new AlertDialog.Builder(this).setTitle(subtitle ? "لینک زیرنویس" : "لینک صدا")
        .setView(field).setNegativeButton("انصراف", null).setPositiveButton("افزودن", (dialog, which) -> {
          Uri uri = safeHttps(field.getText().toString().trim());
          if (uri == null || player == null) { Toast.makeText(this, "نشانی HTTPS معتبر وارد کنید.", Toast.LENGTH_SHORT).show(); return; }
          ArrayList<Uri> list = subtitle ? subtitles : audios;
          if (!list.contains(uri) && list.size() < 30) list.add(uri);
          boolean ok = player.addSlave(subtitle ? IMedia.Slave.Type.Subtitle : IMedia.Slave.Type.Audio, uri, true);
          Toast.makeText(this, ok ? "ترک اضافه شد." : "افزودن ترک ممکن نشد.", Toast.LENGTH_SHORT).show();
        }).show();
  }

  private void showSubtitleSettings() {
    String[] choices = {"تأخیر: " + (subtitleDelayUs / 1000000f) + " ثانیه", "اندازه زیرنویس", "رنگ زیرنویس", "فونت زیرنویس"};
    new AlertDialog.Builder(this).setTitle("تنظیمات زیرنویس").setItems(choices, (dialog, which) -> {
      if (which == 0) showDelay();
      else if (which == 1) chooseSize();
      else if (which == 2) chooseColor();
      else chooseFont();
    }).setNegativeButton("بستن", null).show();
  }

  private void showDelay() {
    String[] choices = {"نیم ثانیه زودتر", "بازنشانی", "نیم ثانیه دیرتر"};
    new AlertDialog.Builder(this).setTitle("تأخیر زیرنویس").setItems(choices, (dialog, which) -> {
      subtitleDelayUs = which == 1 ? 0 : Math.max(-60000000L, Math.min(60000000L, subtitleDelayUs + (which == 0 ? -500000 : 500000)));
      if (player != null) player.setSpuDelay(subtitleDelayUs);
      saveSubtitlePreferences();
      showDelay();
    }).setNegativeButton("انجام", null).show();
  }

  private void chooseSize() {
    String[] labels = {"کوچک", "معمولی", "بزرگ", "خیلی بزرگ"};
    int[] scales = {20, 16, 12, 6};
    new AlertDialog.Builder(this).setTitle("اندازه زیرنویس").setItems(labels, (dialog, which) -> { subtitleScale = scales[which]; recreateEngine(); }).setNegativeButton("بستن", null).show();
  }

  private void chooseColor() {
    String[] labels = {"سفید", "زرد", "سبز"};
    int[] colors = {0xffffff, 0xffff00, 0x00ff00};
    new AlertDialog.Builder(this).setTitle("رنگ زیرنویس").setItems(labels, (dialog, which) -> { subtitleColor = colors[which]; recreateEngine(); }).setNegativeButton("بستن", null).show();
  }

  private void chooseFont() {
    new AlertDialog.Builder(this).setTitle("فونت زیرنویس").setItems(fontLabels, (dialog, which) -> {
      if (which > 0 && !new java.io.File(fontPaths[which]).isFile()) { Toast.makeText(this, "این فونت روی دستگاه موجود نیست.", Toast.LENGTH_SHORT).show(); return; }
      subtitleFontIndex = which; recreateEngine();
    }).setNegativeButton("بستن", null).show();
  }

  private void recreateEngine() {
    if (phase != Phase.CONTENT) return;
    saveSubtitlePreferences();
    if (player != null && phase == Phase.CONTENT) {
      pendingSeek = Math.max(0, player.getTime());
      resumeAfterRebuild = player.isPlaying();
      pendingAudioId = player.getAudioTrack();
      pendingSubtitleId = player.getSpuTrack();
      restoreAttempts = 0;
    }
    releaseEngine();
    createEngine();
    startContent();
  }
  private void saveSubtitlePreferences() {
    getSharedPreferences("vizosten-player", MODE_PRIVATE).edit()
        .putLong("subtitleDelayUs", subtitleDelayUs).putInt("subtitleScale", subtitleScale)
        .putInt("subtitleColor", subtitleColor).putInt("subtitleFont", subtitleFontIndex).apply();
  }
  private void releaseEngine() {
    if (player != null) { player.stop(); player.getVLCVout().detachViews(); player.release(); player = null; }
    if (vlc != null) { vlc.release(); vlc = null; }
  }
  private int dp(int value) { return (int) (value * getResources().getDisplayMetrics().density + 0.5f); }
  private TextView label(String text, int size) { TextView v = new TextView(this); v.setText(text); v.setTextColor(Color.WHITE); v.setTextSize(size); return v; }
  private Button button(String text, Runnable action) {
    Button b = new Button(this); b.setText(text); b.setTextColor(Color.WHITE); b.setAllCaps(false); b.setTextSize(13);
    b.setMinWidth(0); b.setMinimumWidth(0);
    GradientDrawable background = new GradientDrawable(); background.setColor(0x9918181b); background.setCornerRadius(dp(8));
    background.setStroke(dp(1), 0x99ffffff); b.setBackground(background);
    b.setPadding(dp(10), dp(8), dp(10), dp(8)); b.setOnClickListener(v -> action.run()); return b;
  }
  private static String formatTime(long ms) {
    long value = Math.max(0, ms / 1000);
    return value >= 3600 ? String.format(Locale.ROOT, "%02d:%02d:%02d", value / 3600, value / 60 % 60, value % 60)
        : String.format(Locale.ROOT, "%02d:%02d", value / 60, value % 60);
  }
  @Override protected void onSaveInstanceState(Bundle out) {
    if (player != null) out.putLong("position", phase == Phase.CONTENT ? Math.max(0, player.getTime()) : pendingSeek);
    out.putBoolean("wasPlaying", phase == Phase.CONTENT && player != null ? player.isPlaying() : resumeAfterAd);
    if (player != null && phase == Phase.CONTENT) { out.putInt("audioTrack", player.getAudioTrack()); out.putInt("subtitleTrack", player.getSpuTrack()); }
    else { if (pendingAudioId != null) out.putInt("audioTrack", pendingAudioId); if (pendingSubtitleId != null) out.putInt("subtitleTrack", pendingSubtitleId); }
    ArrayList<String> subtitleStrings = new ArrayList<>();
    for (Uri uri : subtitles) subtitleStrings.add(uri.toString());
    ArrayList<String> audioStrings = new ArrayList<>();
    for (Uri uri : audios) audioStrings.add(uri.toString());
    out.putStringArrayList("subtitleUrls", subtitleStrings); out.putStringArrayList("audioUrls", audioStrings);
    out.putBoolean("preRollDone", preRollDone); out.putBoolean("midRollDone", midRollDone); out.putBoolean("postRollDone", postRollDone);
    if ((phase == Phase.AD || phase == Phase.AD_LOADING) && pendingPlacement != null) {
      out.putString("interruptedAd", pendingPlacement);
      out.putBoolean("adResume", resumeAfterAd);
      out.putBoolean("adFinish", finishAfterAd);
    }
    out.putLong("subtitleDelayUs", subtitleDelayUs); out.putInt("subtitleScale", subtitleScale);
    out.putInt("subtitleColor", subtitleColor); out.putInt("subtitleFont", subtitleFontIndex);
    super.onSaveInstanceState(out);
  }
  @Override protected void onStart() {
    super.onStart();
    visible = true;
    if (player != null && phase == Phase.AD && !player.isPlaying()) player.play();
    else if (player != null && phase == Phase.CONTENT && !tracksAdded) player.play();
  }
  @Override protected void onStop() {
    visible = false;
    clearBanner();
    saveContentProgress(true);
    if (player != null && player.isPlaying()) player.pause();
    super.onStop();
  }
  @Override protected void onDestroy() {
    saveContentProgress(true);
    handler.removeCallbacksAndMessages(null);
    releaseEngine();
    if (adClient != null) adClient.close();
    super.onDestroy();
  }
}
