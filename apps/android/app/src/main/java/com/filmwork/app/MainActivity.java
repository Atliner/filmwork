package com.filmwork.app;

import android.app.Activity;
import android.content.Intent;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Insets;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.Collections;

public final class MainActivity extends Activity {
  private static final long MIN_SPLASH_MS = 900;
  private static final long MAX_SPLASH_MS = 3500;
  private final Handler handler = new Handler(Looper.getMainLooper());
  private WebView webView;
  private View splash;
  private String appHost;
  private long splashStarted;
  private boolean splashDismissed;
  private boolean playerOpen;
  private boolean crashReportShown;
  private final Runnable dismissSplash = () -> {
    if (splashDismissed || splash == null) return;
    splashDismissed = true;
    splash.animate().alpha(0f).setDuration(200).withEndAction(() -> splash.setVisibility(View.GONE)).start();
  };

  @SuppressWarnings("deprecation")
  @Override public void onCreate(Bundle state) {
    super.onCreate(state);
    getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
    getWindow().setStatusBarColor(Color.TRANSPARENT);
    getWindow().setNavigationBarColor(Color.TRANSPARENT);
    if (Build.VERSION.SDK_INT >= 29) getWindow().setNavigationBarContrastEnforced(false);
    if (Build.VERSION.SDK_INT >= 30) {
      getWindow().setDecorFitsSystemWindows(false);
    } else {
      getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE
          | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
    }

    FrameLayout root = new FrameLayout(this);
    root.setBackgroundColor(Color.rgb(8, 8, 13));
    FrameLayout content = new FrameLayout(this);
    root.addView(content, new FrameLayout.LayoutParams(-1, -1));
    root.setOnApplyWindowInsetsListener((view, insets) -> {
      int left, top, right, bottom;
      if (Build.VERSION.SDK_INT >= 30) {
        Insets safe = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
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
      // The WebView is already inset above. Do not send the same system bars and
      // cutout to it again: CSS safe-area-inset-bottom would otherwise add a
      // second navigation-bar gap to fixed elements such as the dock.
      if (Build.VERSION.SDK_INT >= 30) return WindowInsets.CONSUMED;
      WindowInsets consumed = insets.consumeSystemWindowInsets();
      return Build.VERSION.SDK_INT >= 28 ? consumed.consumeDisplayCutout() : consumed;
    });

    appHost = Uri.parse(BuildConfig.APP_URL).getHost();
    webView = new WebView(this);
    webView.setBackgroundColor(Color.rgb(8, 8, 13));
    webView.getSettings().setUserAgentString(webView.getSettings().getUserAgentString() + " VizostenAndroid/1.5");
    webView.getSettings().setJavaScriptEnabled(true);
    webView.getSettings().setDomStorageEnabled(true);
    webView.getSettings().setAllowFileAccess(false);
    webView.getSettings().setAllowContentAccess(false);
    webView.getSettings().setMixedContentMode(android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW);
    if (Build.VERSION.SDK_INT >= 26) webView.getSettings().setSafeBrowsingEnabled(true);
    PlayerDiagnostics.mark(this, "WEBVIEW_READY");
    installPlayerBridge();
    webView.setWebChromeClient(new WebChromeClient());
    webView.setWebViewClient(new WebViewClient() {
      @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        Uri uri = request.getUrl();
        if ("https".equalsIgnoreCase(uri.getScheme()) && appHost.equalsIgnoreCase(uri.getHost())) return false;
        if ("https".equalsIgnoreCase(uri.getScheme())) startActivity(new Intent(Intent.ACTION_VIEW, uri));
        return true;
      }
      @Override public void onPageFinished(WebView view, String url) {
        if (!splashDismissed) {
          handler.removeCallbacks(dismissSplash);
          handler.postDelayed(dismissSplash, Math.max(0, MIN_SPLASH_MS - (SystemClock.uptimeMillis() - splashStarted)));
        }
      }
    });
    content.addView(webView, new FrameLayout.LayoutParams(-1, -1));
    TextView diagnostics = new TextView(this);
    diagnostics.setText("عیب‌یابی"); diagnostics.setTextSize(11); diagnostics.setTextColor(Color.WHITE);
    diagnostics.setPadding(12, 8, 12, 8); diagnostics.setBackgroundColor(0xcc27272a);
    diagnostics.setContentDescription("باز کردن گزارش عیب‌یابی پلیر");
    diagnostics.setOnClickListener(v -> PlayerDiagnostics.show(this, false));
    FrameLayout.LayoutParams diagParams = new FrameLayout.LayoutParams(-2, -2, Gravity.BOTTOM | Gravity.LEFT);
    diagParams.leftMargin = (int) (8 * getResources().getDisplayMetrics().density);
    diagParams.bottomMargin = (int) (82 * getResources().getDisplayMetrics().density);
    content.addView(diagnostics, diagParams);
    splash = createSplash();
    content.addView(splash, new FrameLayout.LayoutParams(-1, -1));
    setContentView(root);
    root.requestApplyInsets();
    splashStarted = SystemClock.uptimeMillis();
    handler.postDelayed(dismissSplash, MAX_SPLASH_MS);
    if (state == null) webView.loadUrl(BuildConfig.APP_URL); else webView.restoreState(state);
  }

  private void installPlayerBridge() {
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
      PlayerDiagnostics.mark(this, "BRIDGE_UNSUPPORTED"); return;
    }
    PlayerDiagnostics.mark(this, "BRIDGE_INSTALLED");
    Uri base = Uri.parse(BuildConfig.APP_URL);
    String origin = base.getScheme() + "://" + base.getHost() + (base.getPort() < 0 ? "" : ":" + base.getPort());
    WebViewCompat.addWebMessageListener(webView, "VizostenNative", Collections.singleton(origin),
        (view, message, sourceOrigin, isMainFrame, reply) -> {
          PlayerDiagnostics.mark(MainActivity.this, "BRIDGE_MESSAGE");
          String raw = message.getData();
          if (!isMainFrame || sourceOrigin == null || !origin.equalsIgnoreCase(sourceOrigin.toString())
              || raw == null || raw.length() > 262144) { reply.postMessage("invalid-request"); return; }
          try {
            if (playerOpen) { reply.postMessage("already-open"); return; }
            JSONObject data = new JSONObject(raw);
            if (!"openPlayer".equals(data.optString("action"))) { reply.postMessage("invalid-request"); return; }
            String contentId = data.optString("contentId", "");
            if (!contentId.matches("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")) {
              reply.postMessage("invalid-content"); return;
            }
            Uri stream = NativePlayerActivity.safeHttps(data.optString("streamUrl"));
            if (stream == null) { reply.postMessage("invalid-url"); return; }
            String token = data.optString("sessionToken", "");
            if (token.length() > 4096 || token.contains("\n") || token.contains("\r")) { reply.postMessage("invalid-session"); return; }
            String title = data.optString("title", "ویزوستن");
            if (title.length() > 200) title = title.substring(0, 200);
            long resume = Math.max(0, Math.min(10000000000L, data.optLong("resumeMillis", 0)));
            Intent intent = new Intent(MainActivity.this, NativePlayerActivity.class);
            intent.setData(stream);
            intent.putExtra("contentId", contentId);
            intent.putExtra("title", title);
            intent.putExtra("sessionToken", token);
            intent.putExtra("resumeMillis", resume);
            intent.putStringArrayListExtra("subtitleUrls", safeTrackUrls(data.optJSONArray("subtitleUrls")));
            intent.putStringArrayListExtra("audioUrls", safeTrackUrls(data.optJSONArray("audioUrls")));
            JSONArray variants = safeVersions(data.optJSONArray("versions"));
            if (variants != null && variants.length() > 0) {
              int selected = data.optInt("selectedVersion", 0);
              if (selected < 0 || selected >= variants.length()
                  || !stream.toString().equals(variants.getJSONObject(selected).optString("streamUrl"))) {
                reply.postMessage("invalid-request"); return;
              }
              intent.putExtra("versions", variants.toString());
              intent.putExtra("selectedVersion", selected);
            }
            playerOpen = true;
            PlayerDiagnostics.mark(MainActivity.this, "PLAYER_LAUNCH_REQUESTED");
            try { startActivity(intent); } catch (Exception error) { playerOpen = false; throw error; }
            reply.postMessage("ok");
          } catch (Exception ignored) { reply.postMessage("invalid-request"); }
        });
  }

  private JSONArray safeVersions(JSONArray input) throws org.json.JSONException {
    if (input == null) return null; // Backward-compatible single-source bridge.
    if (input.length() > 1000) throw new org.json.JSONException("too many versions");
    JSONArray result = new JSONArray();
    for (int i = 0; i < input.length(); i++) {
      JSONObject item = input.getJSONObject(i);
      Uri uri = NativePlayerActivity.safeHttps(item.optString("streamUrl"));
      if (uri == null) throw new org.json.JSONException("invalid stream");
      String label = item.optString("label", "نسخه پخش").replaceAll("(?i)https?://\\S+", "").trim();
      if (label.length() > 160) label = label.substring(0, 160);
      if (label.isEmpty()) label = "نسخه پخش";
      JSONObject clean = new JSONObject();
      clean.put("label", label); clean.put("streamUrl", uri.toString());
      clean.put("season", Math.max(0, Math.min(10000, item.optInt("season", 0))));
      clean.put("episode", Math.max(0, Math.min(10000, item.optInt("episode", 0))));
      clean.put("subtitleUrls", new JSONArray(safeTrackUrls(item.optJSONArray("subtitleUrls"))));
      clean.put("audioUrls", new JSONArray(safeTrackUrls(item.optJSONArray("audioUrls"))));
      result.put(clean);
    }
    return result;
  }

  private ArrayList<String> safeTrackUrls(JSONArray array) {
    ArrayList<String> urls = new ArrayList<>();
    if (array == null) return urls;
    for (int i = 0; i < array.length() && urls.size() < 30; i++) {
      Uri uri = NativePlayerActivity.safeHttps(array.optString(i, ""));
      if (uri != null && !urls.contains(uri.toString())) urls.add(uri.toString());
    }
    return urls;
  }

  private View createSplash() {
    LinearLayout layout = new LinearLayout(this);
    layout.setOrientation(LinearLayout.VERTICAL);
    layout.setGravity(Gravity.CENTER);
    GradientDrawable background = new GradientDrawable(GradientDrawable.Orientation.TL_BR,
        new int[]{Color.rgb(21, 12, 6), Color.rgb(0, 0, 0), Color.rgb(15, 5, 27)});
    layout.setBackground(background);
    ImageView logo = new ImageView(this);
    logo.setImageResource(R.drawable.splash_logo);
    logo.setAdjustViewBounds(true);
    logo.setScaleType(ImageView.ScaleType.FIT_CENTER);
    int horizontal = (int) (24 * getResources().getDisplayMetrics().density);
    logo.setPadding(horizontal, 0, horizontal, 0);
    layout.addView(logo, new LinearLayout.LayoutParams(-1, -2));
    ProgressBar progress = new ProgressBar(this, null, android.R.attr.progressBarStyleSmall);
    progress.setIndeterminateTintList(ColorStateList.valueOf(Color.rgb(247, 181, 44)));
    LinearLayout.LayoutParams progressParams = new LinearLayout.LayoutParams(-2, -2);
    progressParams.topMargin = (int) (20 * getResources().getDisplayMetrics().density);
    layout.addView(progress, progressParams);
    return layout;
  }

  @Override protected void onResume() {
    super.onResume(); playerOpen = false;
    if (!crashReportShown && PlayerDiagnostics.hasPendingCrash(this)) {
      crashReportShown = true;
      handler.post(() -> { if (!isFinishing()) PlayerDiagnostics.show(this, true); });
    }
  }
  @Override protected void onDestroy() { handler.removeCallbacksAndMessages(null); super.onDestroy(); }
  @Override protected void onSaveInstanceState(Bundle out) { webView.saveState(out); super.onSaveInstanceState(out); }
  @Override public void onBackPressed() { if (webView != null && webView.canGoBack()) webView.goBack(); else super.onBackPressed(); }
}
