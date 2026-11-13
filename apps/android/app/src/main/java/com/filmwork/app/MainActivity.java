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

public final class MainActivity extends Activity {
  private static final long MIN_SPLASH_MS = 900;
  private static final long MAX_SPLASH_MS = 3500;
  private final Handler handler = new Handler(Looper.getMainLooper());
  private WebView webView;
  private View splash;
  private String appHost;
  private long splashStarted;
  private boolean splashDismissed;
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
      return insets;
    });

    appHost = Uri.parse(BuildConfig.APP_URL).getHost();
    webView = new WebView(this);
    webView.setBackgroundColor(Color.rgb(8, 8, 13));
    webView.getSettings().setJavaScriptEnabled(true);
    webView.getSettings().setDomStorageEnabled(true);
    webView.getSettings().setAllowFileAccess(false);
    webView.getSettings().setAllowContentAccess(false);
    webView.getSettings().setMixedContentMode(android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW);
    if (Build.VERSION.SDK_INT >= 26) webView.getSettings().setSafeBrowsingEnabled(true);
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
    splash = createSplash();
    content.addView(splash, new FrameLayout.LayoutParams(-1, -1));
    setContentView(root);
    root.requestApplyInsets();
    splashStarted = SystemClock.uptimeMillis();
    handler.postDelayed(dismissSplash, MAX_SPLASH_MS);
    if (state == null) webView.loadUrl(BuildConfig.APP_URL); else webView.restoreState(state);
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

  @Override protected void onDestroy() { handler.removeCallbacksAndMessages(null); super.onDestroy(); }
  @Override protected void onSaveInstanceState(Bundle out) { webView.saveState(out); super.onSaveInstanceState(out); }
  @Override public void onBackPressed() { if (webView != null && webView.canGoBack()) webView.goBack(); else super.onBackPressed(); }
}
