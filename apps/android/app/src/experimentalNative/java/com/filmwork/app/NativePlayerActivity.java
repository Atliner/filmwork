package com.filmwork.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.os.SystemClock;
import android.graphics.Color;
import android.graphics.Insets;
import android.graphics.Bitmap;
import android.graphics.Rect;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ImageView;
import android.widget.ScrollView;
import android.widget.SeekBar;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;
import org.videolan.libvlc.LibVLC;
import org.videolan.libvlc.Media;
import org.videolan.libvlc.MediaPlayer;
import org.videolan.libvlc.interfaces.IMedia;
import org.videolan.libvlc.util.VLCVideoLayout;

import java.util.ArrayList;
import java.util.Locale;

/**
 * Android renderer backed by LibVLC. This activity is private to the app; its
 * inputs come from the configured site's main-frame WebMessage listener.
 * Only direct HTTPS sources are accepted. Never put a site token in an Intent URL.
 */
public final class NativePlayerActivity extends Activity {
  private final Handler handler = new Handler(Looper.getMainLooper());
  private final ArrayList<Uri> subtitles = new ArrayList<>();
  private final ArrayList<Uri> audios = new ArrayList<>();
  private LibVLC vlc;
  private MediaPlayer player;
  // Content stays loaded and paused while a separate player renders an ad.
  private MediaPlayer suspendedContentPlayer;
  private boolean adHasContent;
  private boolean suspendedTracksAdded;
  private VLCVideoLayout videoLayout;
  private LinearLayout playbackStatus;
  private TextView playbackStatusText;
  private Button retryPlayback;
  private int mediaStartSequence;
  private Uri source;
  private static final class PlaybackVersion {
    Uri uri; String label; int season, episode;
    final ArrayList<Uri> subtitles = new ArrayList<>(), audios = new ArrayList<>();
  }
  private final ArrayList<PlaybackVersion> versions = new ArrayList<>();
  private int selectedVersion;
  private TextView elapsed;
  private TextView duration;
  private TextView audioCount;
  private TextView subtitleCount;
  private Button play;
  private SeekBar seek;
  private View topControls, centerControls, bottomControls;
  private boolean controlsVisible = true;
  private final Runnable hideControls = () -> {
    if (!this.userSeeking && this.phase == Phase.CONTENT && this.player != null && this.player.isPlaying()) setControlsVisible(false);
  };
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
  private boolean pausedForBackground;
  private boolean preRollDone;
  private boolean midRollDone;
  private boolean postRollDone;
  private boolean adImpression;
  private boolean resumeAfterAd;
  private boolean finishAfterAd;
  private String pendingPlacement;
  private long adStartedAt;
  private long adLastPosition;
  private long adLastAdvanceAt;
  private long lastProgressAt;
  private int adRequestSequence;
  private float playbackRate = 1f;
  private int playbackVolume = 100;
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
        if (!adImpression && visible && hasWindowFocus() && videoLayout.isShown() && player.isPlaying() && elapsedAd > 0) {
          adImpression = true;
          adClient.record(activeAd, "impression");
        }
        long left = Math.max(0, activeAd.skipSeconds * 1000L - elapsedAd);
        adSkip.setEnabled(left == 0 && adImpression);
        adSkip.setText(left == 0 ? "رد کردن تبلیغ" : "رد کردن · " + ((left + 999) / 1000));
        if (visible) {
          long now = SystemClock.elapsedRealtime();
          if (elapsedAd > adLastPosition) { adLastPosition = elapsedAd; adLastAdvanceAt = now; }
          if ((!adImpression && now - adStartedAt > 20000) || (adImpression && now - adLastAdvanceAt > 20000)) finishAd(null);
        }
      } else if (phase == Phase.CONTENT) {
        long length = Math.max(0, player.getLength());
        long position = Math.max(0, player.getTime());
        if (!userSeeking) seek.setProgress(length > 0 ? (int) Math.min(1000, position * 1000 / length) : 0);
        elapsed.setText(formatTime(position)); duration.setText(formatTime(length));
        play.setText(player.isPlaying() ? "❚❚" : "▶");
        audioCount.setText("صدا " + trackCount(player.getAudioTracks()));
        subtitleCount.setText("زیرنویس " + trackCount(player.getSpuTracks()));
        restoreSelectedTracks();
        if (visible && player.isPlaying() && !bannerPlayerScheduled) schedulePlayerBanner();
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
    PlayerDiagnostics.mark(this, "PLAYER_CREATE");
    source = safeHttps(getIntent().getDataString());
    if (source == null) { PlayerDiagnostics.mark(this, "INVALID_SOURCE"); finish(); return; }
    getWindow().setStatusBarColor(Color.BLACK);
    getWindow().setNavigationBarColor(Color.BLACK);
    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    if (Build.VERSION.SDK_INT >= 30) getWindow().setDecorFitsSystemWindows(false);
    else getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE
        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
    appendUrls(getIntent().getStringArrayListExtra("subtitleUrls"), subtitles);
    appendUrls(getIntent().getStringArrayListExtra("audioUrls"), audios);
    loadVersions(getIntent().getStringExtra("versions"));
    selectedVersion = savedState != null ? savedState.getInt("selectedVersion", getIntent().getIntExtra("selectedVersion", 0)) : getIntent().getIntExtra("selectedVersion", 0);
    if (!versions.isEmpty() && selectedVersion >= 0 && selectedVersion < versions.size()) {
      PlaybackVersion selected = versions.get(selectedVersion);
      source = selected.uri; subtitles.clear(); subtitles.addAll(selected.subtitles); audios.clear(); audios.addAll(selected.audios);
    } else selectedVersion = 0;
    pendingSeek = Math.max(0, getIntent().getLongExtra("resumeMillis", 0));
    if (savedState != null) {
      pendingSeek = Math.max(0, savedState.getLong("position", pendingSeek));
      subtitleDelayUs = savedState.getLong("subtitleDelayUs", 0);
      subtitleScale = savedState.getInt("subtitleScale", 16);
      subtitleColor = savedState.getInt("subtitleColor", 0xffffff);
      subtitleFontIndex = Math.max(0, Math.min(fontPaths.length - 1, savedState.getInt("subtitleFont", 0)));
      if (versions.isEmpty()) {
        appendUrls(savedState.getStringArrayList("subtitleUrls"), subtitles);
        appendUrls(savedState.getStringArrayList("audioUrls"), audios);
      }
      resumeAfterRebuild = savedState.getBoolean("wasPlaying", true);
      if (savedState.containsKey("audioTrack")) pendingAudioId = savedState.getInt("audioTrack");
      if (savedState.containsKey("subtitleTrack")) pendingSubtitleId = savedState.getInt("subtitleTrack");
    }
    contentId = getIntent().getStringExtra("contentId");
    sessionToken = getIntent().getStringExtra("sessionToken");
    android.content.SharedPreferences prefs = getSharedPreferences("vizosten-player", MODE_PRIVATE);
    playbackRate = Math.max(0.5f, Math.min(2f, prefs.getFloat("playbackRate", 1f)));
    playbackVolume = Math.max(0, Math.min(100, prefs.getInt("playbackVolume", 100)));
    if (savedState == null) {
      subtitleDelayUs = Math.max(-60000000L, Math.min(60000000L, prefs.getLong("subtitleDelayUs", 0)));
      subtitleScale = Math.max(6, Math.min(20, prefs.getInt("subtitleScale", 16)));
      subtitleColor = prefs.getInt("subtitleColor", 0xffffff) & 0xffffff;
      subtitleFontIndex = Math.max(0, Math.min(fontPaths.length - 1, prefs.getInt("subtitleFont", 0)));
      if ((sessionToken == null || sessionToken.isEmpty()) && contentId != null && prefs.contains("progress:" + contentId)) {
        pendingSeek = Math.max(0, prefs.getLong("progress:" + contentId, 0));
      }
    }
    adClient = new NativeAdClient(BuildConfig.APP_URL, sessionToken);
    buildUi();
    PlayerDiagnostics.mark(this, "PLAYER_UI_READY");
    try {
      PlayerDiagnostics.mark(this, "VLC_INITIALIZING");
      createEngine();
      PlayerDiagnostics.mark(this, "VLC_INITIALIZED");
    } catch (RuntimeException | LinkageError error) {
      PlayerDiagnostics.recordFailure(this, "VLC_INITIALIZING", error, false);
      showPlaybackStatus("موتور پخش راه‌اندازی نشد. از دکمهٔ عیب‌یابی گزارش را ببینید.", false);
      return;
    }
    if (savedState != null) {
      preRollDone = savedState.getBoolean("preRollDone", false);
      midRollDone = savedState.getBoolean("midRollDone", false);
      postRollDone = savedState.getBoolean("postRollDone", false);
    }
    String interruptedAd = savedState == null ? null : savedState.getString("interruptedAd");
    if (interruptedAd != null) {
      requestInterstitial(interruptedAd, savedState.getBoolean("adResume", true), savedState.getBoolean("adFinish", false));
    } else if (savedState != null && savedState.getBoolean("finished", false)) {
      phase = Phase.FINISHED;
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

  private void loadVersions(String json) {
    if (json == null) return;
    try {
      JSONArray items = new JSONArray(json);
      for (int i = 0; i < items.length() && i < 100; i++) {
        JSONObject item = items.getJSONObject(i);
        Uri uri = safeHttps(item.optString("streamUrl"));
        if (uri == null) { versions.clear(); return; }
        PlaybackVersion version = new PlaybackVersion();
        version.uri = uri; version.label = item.optString("label", "نسخه پخش");
        version.season = item.optInt("season", 0); version.episode = item.optInt("episode", 0);
        JSONArray sub = item.optJSONArray("subtitleUrls"), audio = item.optJSONArray("audioUrls");
        if (sub != null) for (int j = 0; j < sub.length() && j < 30; j++) {
          Uri track = safeHttps(sub.optString(j)); if (track != null) version.subtitles.add(track);
        }
        if (audio != null) for (int j = 0; j < audio.length() && j < 30; j++) {
          Uri track = safeHttps(audio.optString(j)); if (track != null) version.audios.add(track);
        }
        versions.add(version);
      }
    } catch (org.json.JSONException ignored) { versions.clear(); }
  }

  private void showVersions() {
    if (phase != Phase.CONTENT || player == null || versions.isEmpty()) return;
    String[] labels = new String[versions.size()];
    for (int i = 0; i < versions.size(); i++) labels[i] = versions.get(i).label;
    new AlertDialog.Builder(this, R.style.PlayerDialog).setTitle("انتخاب نسخه پخش")
        .setSingleChoiceItems(labels, selectedVersion, (dialog, index) -> {
          dialog.dismiss(); switchVersion(index);
        }).setNegativeButton("بستن", null).show();
  }

  private void switchVersion(int index) {
    if (phase != Phase.CONTENT || player == null || index < 0 || index >= versions.size() || index == selectedVersion) return;
    PlaybackVersion previous = versions.get(selectedVersion), next = versions.get(index);
    boolean sameEpisode = previous.season == next.season && previous.episode == next.episode;
    saveContentProgress(true);
    pendingSeek = sameEpisode ? Math.max(0, player.getTime()) : 0;
    resumeAfterRebuild = player.isPlaying();
    pendingAudioId = null; pendingSubtitleId = null; restoreAttempts = 0;
    if (!sameEpisode) { midRollDone = false; postRollDone = false; }
    selectedVersion = index; source = next.uri;
    subtitles.clear(); subtitles.addAll(next.subtitles); audios.clear(); audios.addAll(next.audios);
    clearBanner();
    startContent();
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
    // LibVLC's managed TextureView handles surface creation, aspect ratio and
    // resizing. Reattaching a bare SurfaceView before it is ready can flash
    // black or leave video invisible on some devices.
    videoLayout = new VLCVideoLayout(this);
    content.addView(videoLayout, new FrameLayout.LayoutParams(-1, -1));
    View tapSurface = new View(this);
    tapSurface.setContentDescription("نمایش یا پنهان کردن کنترل‌های پخش");
    tapSurface.setOnClickListener(v -> setControlsVisible(!controlsVisible));
    content.addView(tapSurface, new FrameLayout.LayoutParams(-1, -1));

    LinearLayout top = new LinearLayout(this);
    topControls = top;
    top.setGravity(Gravity.CENTER_VERTICAL);
    top.setPadding(dp(12), dp(8), dp(12), dp(16));
    top.setBackground(new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, new int[]{0xdd08090d, 0x0008090d}));
    FrameLayout.LayoutParams topParams = new FrameLayout.LayoutParams(-1, -2, Gravity.TOP);
    content.addView(top, topParams);
    Button back = button("‹", this::finish); back.setContentDescription("بازگشت");
    back.setTextSize(24); top.addView(back, new LinearLayout.LayoutParams(dp(48), dp(48)));
    TextView title = label(getIntent().getStringExtra("title") == null ? "ویزوستن" : getIntent().getStringExtra("title"), 16);
    title.setSingleLine(true); title.setEllipsize(android.text.TextUtils.TruncateAt.END);
    title.setPadding(dp(10), 0, dp(10), 0);
    title.setTypeface(null, android.graphics.Typeface.BOLD);
    top.addView(title, new LinearLayout.LayoutParams(0, -2, 1));
    if (versions.size() > 1) {
      Button quality = button("نسخه ▾", this::showVersions);
      quality.setContentDescription("انتخاب نسخه پخش"); top.addView(quality, new LinearLayout.LayoutParams(dp(72), dp(48)));
    }
    Button info = button("ⓘ", () -> PlayerDiagnostics.show(this, false));
    info.setContentDescription("گزارش عیب‌یابی"); top.addView(info, new LinearLayout.LayoutParams(dp(48), dp(48)));

    LinearLayout center = new LinearLayout(this);
    centerControls = center;
    center.setGravity(Gravity.CENTER);
    center.setOrientation(LinearLayout.HORIZONTAL);
    FrameLayout.LayoutParams centerParams = new FrameLayout.LayoutParams(-1, -2, Gravity.CENTER);
    content.addView(center, centerParams);
    Button backTen = button("↶ ۱۰", () -> seekRelative(-10000));
    backTen.setContentDescription("۱۰ ثانیه عقب");
    center.addView(backTen, new LinearLayout.LayoutParams(dp(64), dp(56)));
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
    play.setTextSize(23); play.setContentDescription("پخش یا مکث");
    LinearLayout.LayoutParams playParams = new LinearLayout.LayoutParams(dp(68), dp(68));
    playParams.setMargins(dp(14), 0, dp(14), 0);
    center.addView(play, playParams);
    Button forwardTen = button("۱۰ ↷", () -> seekRelative(10000));
    forwardTen.setContentDescription("۱۰ ثانیه جلو");
    center.addView(forwardTen, new LinearLayout.LayoutParams(dp(64), dp(56)));

    LinearLayout timeline = new LinearLayout(this);
    timeline.setGravity(Gravity.CENTER_VERTICAL);
    timeline.setLayoutDirection(View.LAYOUT_DIRECTION_LTR);
    timeline.setPadding(dp(10), dp(6), dp(10), dp(6));
    timeline.setBackgroundColor(Color.TRANSPARENT);
    LinearLayout bottom = new LinearLayout(this);
    bottomControls = bottom;
    bottom.setOrientation(LinearLayout.VERTICAL);
    bottom.setPadding(dp(8), dp(16), dp(8), dp(6));
    bottom.setBackground(new GradientDrawable(GradientDrawable.Orientation.BOTTOM_TOP, new int[]{0xee08090d, 0x0008090d}));
    FrameLayout.LayoutParams timelineParams = new FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM);
    content.addView(bottom, timelineParams);
    bottom.addView(timeline, new LinearLayout.LayoutParams(-1, -2));
    elapsed = label("00:00", 12); duration = label("00:00", 12);
    seek = new SeekBar(this); seek.setMax(1000);
    timeline.addView(elapsed); timeline.addView(seek, new LinearLayout.LayoutParams(0, -2, 1)); timeline.addView(duration);
    seek.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
      @Override public void onProgressChanged(SeekBar bar, int value, boolean fromUser) { }
      @Override public void onStartTrackingTouch(SeekBar bar) { userSeeking = true; handler.removeCallbacks(hideControls); }
      @Override public void onStopTrackingTouch(SeekBar bar) {
        if (phase == Phase.CONTENT && player != null && player.getLength() > 0) player.setTime(player.getLength() * bar.getProgress() / 1000);
        userSeeking = false;
        scheduleControlsHide();
      }
    });
    LinearLayout options = new LinearLayout(this);
    options.setGravity(Gravity.CENTER_VERTICAL);
    options.setLayoutDirection(View.LAYOUT_DIRECTION_LTR);
    audioCount = button("صدا", () -> showTracks(false));
    subtitleCount = button("زیرنویس", () -> showTracks(true));
    addOption(options, audioCount);
    addOption(options, subtitleCount);
    Button settings = button("⚙", this::showSubtitleSettings);
    settings.setContentDescription("تنظیمات زیرنویس"); addOption(options, settings);
    addOption(options, button("سرعت", this::showSpeed));
    Button volume = button("◖))", this::showVolume); volume.setContentDescription("تنظیم صدا"); addOption(options, volume);
    Button fullscreen = button("⛶", () -> {
      if (getRequestedOrientation() == ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE)
        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
      else setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE);
    });
    fullscreen.setContentDescription("تغییر جهت صفحه"); addOption(options, fullscreen);
    bottom.addView(options, new LinearLayout.LayoutParams(-1, -2));
    bannerHost = new FrameLayout(this);
    FrameLayout.LayoutParams bannerParams = new FrameLayout.LayoutParams(-1, dp(88), Gravity.BOTTOM);
    bannerParams.bottomMargin = dp(105);
    content.addView(bannerHost, bannerParams);
    bannerHost.setVisibility(View.GONE);
    playbackStatus = new LinearLayout(this);
    playbackStatus.setOrientation(LinearLayout.VERTICAL);
    playbackStatus.setGravity(Gravity.CENTER);
    playbackStatus.setPadding(dp(16), dp(12), dp(16), dp(12));
    GradientDrawable statusBackground = new GradientDrawable();
    statusBackground.setColor(0xe6202129); statusBackground.setCornerRadius(dp(14));
    playbackStatus.setBackground(statusBackground);
    playbackStatusText = label("در حال آماده‌سازی پخش…", 14);
    playbackStatusText.setGravity(Gravity.CENTER);
    playbackStatus.addView(playbackStatusText);
    retryPlayback = button("تلاش دوباره", () -> { if (phase == Phase.CONTENT) startContent(); });
    retryPlayback.setVisibility(View.GONE);
    playbackStatus.addView(retryPlayback);
    FrameLayout.LayoutParams statusParams = new FrameLayout.LayoutParams(-2, -2, Gravity.CENTER);
    content.addView(playbackStatus, statusParams);
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
    createPlayer();
  }

  private void createPlayer() {
    player = new MediaPlayer(vlc);
    player.setVolume(playbackVolume);
    tracksAdded = false;
    final MediaPlayer activePlayer = player;
    player.setEventListener(event -> {
      if (event.type == MediaPlayer.Event.Playing) runOnUiThread(() -> { if (player == activePlayer) onMediaPlaying(); });
      if (event.type == MediaPlayer.Event.EndReached) runOnUiThread(() -> { if (player == activePlayer) onMediaEnded(); });
      if (event.type == MediaPlayer.Event.EncounteredError) runOnUiThread(() -> {
        if (player != activePlayer) return;
        PlayerDiagnostics.mark(this, phase == Phase.AD ? "AD_MEDIA_ERROR" : "CONTENT_MEDIA_ERROR");
        if (phase == Phase.AD) finishAd(null);
        else if (phase == Phase.CONTENT) {
          showPlaybackStatus("پخش ممکن نشد. اتصال اینترنت یا دسترسی و فرمت فایل را بررسی کنید.", true);
          final int failedSequence = mediaStartSequence;
          adClient.probeMedia(source, result -> {
            if (phase != Phase.CONTENT || mediaStartSequence != failedSequence || isFinishing()) return;
            PlayerDiagnostics.mark(this, "SOURCE_" + result);
            showPlaybackStatus("پخش ممکن نشد. نتیجهٔ بررسی اتصال: " + result + "\nجزئیات بیشتر در عیب‌یابی", true);
          });
        }
      });
    });
  }

  private void playStream(Uri uri) {
    if (vlc == null || uri == null) return;
    PlayerDiagnostics.mark(this, phase == Phase.AD ? "AD_PREPARE" : "CONTENT_PREPARE");
    try {
    // Each media gets its own player identity. Queued events from a stopped ad
    // must never be mistaken for completion or progress of the next video.
    releasePlayer();
    createPlayer();
    final int sequence = ++mediaStartSequence;
    player.attachViews(videoLayout, null, true, true);
    if (phase == Phase.CONTENT) {
      showPlaybackStatus("در حال بارگیری ویدیو…", false);
      handler.postDelayed(() -> {
        if (phase == Phase.CONTENT && mediaStartSequence == sequence && player != null && !tracksAdded && !player.isPlaying())
          showPlaybackStatus("ویدیو هنوز آماده نشده؛ اتصال و دسترسی فایل را بررسی کنید.", true);
      }, 25000);
    } else playbackStatus.setVisibility(View.GONE);
    Media media = new Media(vlc, uri);
    player.setMedia(media);
    media.release();
    if (visible) player.play();
    } catch (RuntimeException | LinkageError error) {
      PlayerDiagnostics.recordFailure(this, phase == Phase.AD ? "AD_PREPARE" : "CONTENT_PREPARE", error, false);
      if (phase == Phase.AD) finishAd(null);
      else showPlaybackStatus("راه‌اندازی فایل ممکن نشد. از عیب‌یابی گزارش را ببینید.", true);
    }
  }

  private void showPlaybackStatus(String message, boolean retry) {
    playbackStatusText.setText(message);
    retryPlayback.setVisibility(retry ? View.VISIBLE : View.GONE);
    playbackStatus.setVisibility(View.VISIBLE);
  }

  private void onMediaPlaying() {
    if (player == null) return;
    player.setVolume(playbackVolume);
    if (phase == Phase.AD) { PlayerDiagnostics.mark(this, "AD_PLAYING"); return; }
    if (phase != Phase.CONTENT) return;
    if (!tracksAdded) PlayerDiagnostics.mark(this, "CONTENT_PLAYING");
    playbackStatus.setVisibility(View.GONE);
    if (tracksAdded) { scheduleControlsHide(); return; }
    tracksAdded = true;
    scheduleControlsHide();
    for (Uri uri : subtitles) player.addSlave(IMedia.Slave.Type.Subtitle, uri, false);
    for (Uri uri : audios) player.addSlave(IMedia.Slave.Type.Audio, uri, false);
    if (pendingSeek > 0) { player.setTime(pendingSeek); pendingSeek = 0; }
    player.setSpuDelay(subtitleDelayUs);
    player.setRate(playbackRate);
    if (!resumeAfterRebuild) player.pause();
    resumeAfterRebuild = true;
    if (waitingPauseBanner) {
      waitingPauseBanner = false;
      handler.postDelayed(() -> showBanner("banner_pause"), 300);
    }
  }

  /** The original file is always paused while the ad occupies the renderer. */
  private void requestInterstitial(String placement, boolean resume, boolean finishAfter) {
    if (player == null || phase == Phase.AD || phase == Phase.AD_LOADING || isFinishing()) return;
    adHasContent = phase == Phase.CONTENT;
    if (phase == Phase.CONTENT) {
      pendingSeek = Math.max(0, player.getTime());
      pendingAudioId = player.getAudioTrack();
      pendingSubtitleId = player.getSpuTrack();
      restoreAttempts = 0;
      saveContentProgress(true);
      if (player.isPlaying()) player.pause();
    }
    clearBanner();
    if (trackDialog != null) { trackDialog.dismiss(); trackDialog = null; }
    PlayerDiagnostics.mark(this, "AD_REQUEST_" + placement.toUpperCase(Locale.ROOT));
    pendingPlacement = placement;
    resumeAfterAd = resume;
    finishAfterAd = finishAfter;
    phase = Phase.AD_LOADING;
    playbackStatus.setVisibility(View.GONE);
    adLayer.removeAllViews();
    adLayer.setBackgroundColor(0xcc000000);
    adLayer.setClickable(true);
    adLayer.setVisibility(View.VISIBLE);
    TextView loading = label("در حال دریافت تبلیغ…", 15);
    loading.setGravity(Gravity.CENTER);
    adLayer.addView(loading, new FrameLayout.LayoutParams(-1, -1));
    final int requestId = ++adRequestSequence;
    handler.postDelayed(() -> {
      if (phase == Phase.AD_LOADING && adRequestSequence == requestId) finishAd(null);
    }, 12000);
    adClient.requestAd(placement, ad -> {
      if (phase != Phase.AD_LOADING || adRequestSequence != requestId || isFinishing()) return;
      if (ad == null || !"video".equals(ad.assetType)) { PlayerDiagnostics.mark(this, "AD_UNAVAILABLE"); finishAd(null); return; }
      Uri adUri = safeHttps(ad.creativeUrl);
      if (adUri == null) { finishAd(null); return; }
      if (adHasContent) {
        // Preserve the opened media and its network buffers, position and tracks.
        suspendedTracksAdded = tracksAdded;
        player.detachViews();
        suspendedContentPlayer = player;
        player = null;
      }
      activeAd = ad;
      adImpression = false;
      phase = Phase.AD;
      showAdControls(ad);
      adStartedAt = SystemClock.elapsedRealtime();
      adLastAdvanceAt = adStartedAt;
      adLastPosition = 0;
      playStream(adUri);
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
    adRequestSequence++;
    activeAd = null;
    adLayer.setVisibility(View.GONE);
    adLayer.removeAllViews();
    if ("pre_roll".equals(pendingPlacement)) preRollDone = true;
    waitingPauseBanner = !resumeAfterAd && "pause_overlay".equals(pendingPlacement);
    pendingPlacement = null;
    if (finishAfterAd) {
      if (player != null) player.stop();
      if (suspendedContentPlayer != null) {
        suspendedContentPlayer.setEventListener(null);
        suspendedContentPlayer.stop(); suspendedContentPlayer.release(); suspendedContentPlayer = null;
      }
      adHasContent = false;
      phase = Phase.FINISHED;
      play.setText("▶");
      setControlsVisible(true);
      return;
    }
    if (adHasContent) {
      if (suspendedContentPlayer != null) {
        releasePlayer();
        player = suspendedContentPlayer;
        suspendedContentPlayer = null;
        tracksAdded = suspendedTracksAdded;
        player.attachViews(videoLayout, null, true, true);
      }
      phase = Phase.CONTENT;
      adHasContent = false;
      pendingSeek = 0;
      pendingAudioId = null;
      pendingSubtitleId = null;
      playbackStatus.setVisibility(View.GONE);
      if (resumeAfterAd && visible && player != null) player.play();
      else {
        if (resumeAfterAd && !visible) pausedForBackground = true;
        setControlsVisible(true);
      }
      if (waitingPauseBanner) {
        waitingPauseBanner = false;
        handler.postDelayed(() -> showBanner("banner_pause"), 300);
      }
      return;
    }
    resumeAfterRebuild = resumeAfterAd;
    startContent();
  }

  private void startContent() {
    if (vlc == null || isFinishing()) return;
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

  private void schedulePlayerBanner() {
    bannerPlayerScheduled = true;
    handler.postDelayed(() -> {
      if (phase == Phase.CONTENT && visible && player != null && player.isPlaying()) showBanner("banner_player");
      else bannerPlayerScheduled = false;
    }, 8000);
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
    bannerHost.post(new Runnable() {
      @Override public void run() {
        if (!displayId.equals(bannerHost.getTag())) return;
        Rect visibleRect = new Rect();
        long area = (long) bannerHost.getWidth() * bannerHost.getHeight();
        long visibleArea = bannerHost.getGlobalVisibleRect(visibleRect) ? (long) visibleRect.width() * visibleRect.height() : 0;
        if (visible && hasWindowFocus() && phase == Phase.CONTENT && bannerHost.isShown()
            && area > 0 && visibleArea * 2 >= area) adClient.record(ad, "impression");
        else bannerHost.postDelayed(this, 250);
      }
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
      // Some LibVLC demuxers expose an external slave URL as the track name.
      if (name.matches("(?is).*https?://.*")) name = "ترک خارجی " + track.id;
      if (name.isEmpty() || name.equalsIgnoreCase("null")) name = "ترک " + track.id;
      final int id = track.id;
      addTrackButton(list, name, id == selected, () -> { if (isSubtitle) player.setSpuTrack(id); else player.setAudioTrack(id); });
    }
    if (trackCount(tracks) == 0) {
      TextView empty = label("ترکی یافت نشد؛ اگر ویدیو در حال بارگیری است کمی صبر کنید.", 14);
      empty.setPadding(dp(12), dp(14), dp(12), dp(14));
      list.addView(empty);
    }
    ScrollView scroller = new ScrollView(this); scroller.addView(list);
    trackDialog = new AlertDialog.Builder(this, R.style.PlayerDialog).setTitle(isSubtitle ? "انتخاب زیرنویس" : "انتخاب صدا")
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
    item.setTextColor(selected ? 0xffffc451 : Color.WHITE);
    list.addView(item, new LinearLayout.LayoutParams(-1, -2));
  }

  private void showSpeed() {
    if (phase != Phase.CONTENT || player == null) return;
    String[] labels = {"۰٫۵×", "۰٫۷۵×", "عادی", "۱٫۲۵×", "۱٫۵×", "۲×"};
    float[] rates = {0.5f, 0.75f, 1f, 1.25f, 1.5f, 2f};
    new AlertDialog.Builder(this, R.style.PlayerDialog).setTitle("سرعت پخش").setItems(labels, (dialog, which) -> {
      if (player == null || phase != Phase.CONTENT) return;
      playbackRate = rates[which];
      player.setRate(playbackRate);
      getSharedPreferences("vizosten-player", MODE_PRIVATE).edit().putFloat("playbackRate", playbackRate).apply();
    }).setNegativeButton("بستن", null).show();
  }

  private void showSubtitleSettings() {
    String[] choices = {"تأخیر: " + (subtitleDelayUs / 1000000f) + " ثانیه", "اندازه (برای پخش بعدی)", "رنگ (برای پخش بعدی)", "فونت (برای پخش بعدی)"};
    new AlertDialog.Builder(this, R.style.PlayerDialog).setTitle("تنظیمات زیرنویس").setItems(choices, (dialog, which) -> {
      if (which == 0) showDelay();
      else if (which == 1) chooseSize();
      else if (which == 2) chooseColor();
      else chooseFont();
    }).setNegativeButton("بستن", null).show();
  }

  private void showDelay() {
    String[] choices = {"نیم ثانیه زودتر", "بازنشانی", "نیم ثانیه دیرتر"};
    new AlertDialog.Builder(this, R.style.PlayerDialog).setTitle("تأخیر زیرنویس").setItems(choices, (dialog, which) -> {
      subtitleDelayUs = which == 1 ? 0 : Math.max(-60000000L, Math.min(60000000L, subtitleDelayUs + (which == 0 ? -500000 : 500000)));
      if (player != null) player.setSpuDelay(subtitleDelayUs);
      saveSubtitlePreferences();
      showDelay();
    }).setNegativeButton("انجام", null).show();
  }

  private void chooseSize() {
    String[] labels = {"کوچک", "معمولی", "بزرگ", "خیلی بزرگ"};
    int[] scales = {20, 16, 12, 6};
    new AlertDialog.Builder(this, R.style.PlayerDialog).setTitle("اندازه زیرنویس").setItems(labels, (dialog, which) -> { subtitleScale = scales[which]; saveDeferredSubtitleStyle(); }).setNegativeButton("بستن", null).show();
  }

  private void chooseColor() {
    String[] labels = {"سفید", "زرد", "سبز"};
    int[] colors = {0xffffff, 0xffff00, 0x00ff00};
    new AlertDialog.Builder(this, R.style.PlayerDialog).setTitle("رنگ زیرنویس").setItems(labels, (dialog, which) -> { subtitleColor = colors[which]; saveDeferredSubtitleStyle(); }).setNegativeButton("بستن", null).show();
  }

  private void chooseFont() {
    new AlertDialog.Builder(this, R.style.PlayerDialog).setTitle("فونت زیرنویس").setItems(fontLabels, (dialog, which) -> {
      if (which > 0 && !new java.io.File(fontPaths[which]).isFile()) { Toast.makeText(this, "این فونت روی دستگاه موجود نیست.", Toast.LENGTH_SHORT).show(); return; }
      subtitleFontIndex = which; saveDeferredSubtitleStyle();
    }).setNegativeButton("بستن", null).show();
  }

  // LibVLC 3 configures text rendering when its engine is created. Do not
  // tear down an active network stream just to change appearance.
  private void saveDeferredSubtitleStyle() {
    saveSubtitlePreferences();
    Toast.makeText(this, "ظاهر زیرنویس در باز کردن بعدی پلیر اعمال می‌شود؛ تأخیر فوراً تغییر می‌کند.", Toast.LENGTH_LONG).show();
  }
  private void saveSubtitlePreferences() {
    getSharedPreferences("vizosten-player", MODE_PRIVATE).edit()
        .putLong("subtitleDelayUs", subtitleDelayUs).putInt("subtitleScale", subtitleScale)
        .putInt("subtitleColor", subtitleColor).putInt("subtitleFont", subtitleFontIndex).apply();
  }
  private void releasePlayer() {
    if (player == null) return;
    MediaPlayer old = player;
    player = null; // ignore already-queued events from this instance
    old.setEventListener(null);
    old.stop(); old.detachViews(); old.release();
  }
  private void releaseEngine() {
    releasePlayer();
    if (suspendedContentPlayer != null) {
      suspendedContentPlayer.setEventListener(null);
      suspendedContentPlayer.stop(); suspendedContentPlayer.release(); suspendedContentPlayer = null;
    }
    if (vlc != null) { vlc.release(); vlc = null; }
  }
  private int dp(int value) { return (int) (value * getResources().getDisplayMetrics().density + 0.5f); }
  private TextView label(String text, int size) { TextView v = new TextView(this); v.setText(text); v.setTextColor(Color.WHITE); v.setTextSize(size); return v; }
  private void addOption(LinearLayout row, View view) {
    LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, dp(44), 1);
    params.setMargins(dp(2), 0, dp(2), 0); row.addView(view, params);
  }
  private void showVolume() {
    SeekBar slider = new SeekBar(this); slider.setMax(100); slider.setProgress(playbackVolume);
    LinearLayout panel = new LinearLayout(this); panel.setPadding(dp(24), dp(12), dp(24), dp(12)); panel.addView(slider, new LinearLayout.LayoutParams(-1, -2));
    slider.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
      @Override public void onProgressChanged(SeekBar bar, int value, boolean fromUser) {
        if (!fromUser) return;
        playbackVolume = value; if (player != null) player.setVolume(value);
        getSharedPreferences("vizosten-player", MODE_PRIVATE).edit().putInt("playbackVolume", value).apply();
      }
      @Override public void onStartTrackingTouch(SeekBar bar) { }
      @Override public void onStopTrackingTouch(SeekBar bar) { }
    });
    new AlertDialog.Builder(this, R.style.PlayerDialog).setTitle("صدای پخش").setView(panel).setPositiveButton("انجام", null).show();
  }
  private void setControlsVisible(boolean show) {
    controlsVisible = show;
    int visibility = show ? View.VISIBLE : View.INVISIBLE;
    if (topControls != null) topControls.setVisibility(visibility);
    if (centerControls != null) centerControls.setVisibility(visibility);
    if (bottomControls != null) bottomControls.setVisibility(visibility);
    handler.removeCallbacks(hideControls);
    if (show) scheduleControlsHide();
  }
  private void scheduleControlsHide() {
    handler.removeCallbacks(hideControls);
    if (controlsVisible && !userSeeking && phase == Phase.CONTENT && player != null && player.isPlaying())
      handler.postDelayed(hideControls, 4000);
  }
  private Button button(String text, Runnable action) {
    Button b = new Button(this); b.setText(text); b.setTextColor(Color.WHITE); b.setAllCaps(false); b.setTextSize(13);
    b.setMinWidth(0); b.setMinimumWidth(0); b.setMinHeight(0); b.setMinimumHeight(0);
    GradientDrawable background = new GradientDrawable(); background.setColor(0x9924262f); background.setCornerRadius(dp(14));
    b.setBackground(background);
    b.setPadding(dp(3), dp(4), dp(3), dp(4));
    b.setOnClickListener(v -> { action.run(); scheduleControlsHide(); }); return b;
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
    out.putInt("selectedVersion", selectedVersion);
    out.putBoolean("finished", phase == Phase.FINISHED);
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
    if (player != null && (phase == Phase.AD || phase == Phase.CONTENT)
        && (pausedForBackground || (phase == Phase.CONTENT && !tracksAdded) || phase == Phase.AD) && !player.isPlaying()) {
      if (phase == Phase.AD) { adStartedAt = SystemClock.elapsedRealtime(); adLastAdvanceAt = adStartedAt; }
      player.play();
    }
    pausedForBackground = false;
  }
  @Override protected void onStop() {
    visible = false;
    clearBanner();
    saveContentProgress(true);
    pausedForBackground = player != null && player.isPlaying();
    if (pausedForBackground) player.pause();
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
