package com.filmwork.app;

import android.app.Activity;
import android.os.Bundle;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.content.Intent;
import android.net.Uri;

public final class MainActivity extends Activity {
  private WebView webView;
  private String appHost;

  @Override public void onCreate(Bundle state) {
    super.onCreate(state);
    Uri base = Uri.parse(BuildConfig.APP_URL);
    appHost = base.getHost();
    webView = new WebView(this);
    webView.getSettings().setJavaScriptEnabled(true);
    webView.getSettings().setDomStorageEnabled(true);
    webView.getSettings().setAllowFileAccess(false);
    webView.getSettings().setAllowContentAccess(false);
    webView.setWebChromeClient(new WebChromeClient());
    webView.setWebViewClient(new WebViewClient() {
      @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        Uri uri = request.getUrl();
        if ("https".equalsIgnoreCase(uri.getScheme()) && appHost.equalsIgnoreCase(uri.getHost())) return false;
        if ("https".equalsIgnoreCase(uri.getScheme())) {
          startActivity(new Intent(Intent.ACTION_VIEW, uri));
          return true;
        }
        return true;
      }
    });
    setContentView(webView);
    if (state == null) webView.loadUrl(BuildConfig.APP_URL);
    else webView.restoreState(state);
  }

  @Override protected void onSaveInstanceState(Bundle out) { webView.saveState(out); super.onSaveInstanceState(out); }
  @Override public void onBackPressed() { if (webView != null && webView.canGoBack()) webView.goBack(); else super.onBackPressed(); }
}
