package com.filmwork.app;

import android.net.Uri;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Handler;
import android.os.Looper;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Site API client for the experimental native player. Work is serialised so the
 * impression cannot overtake a skip/complete. A signed session is reused on retry.
 * Tokens are passed only in HTTPS Authorization headers, never in media URLs.
 */
final class NativeAdClient {
  interface Callback { void onResult(Ad ad); }
  interface ImageCallback { void onResult(Bitmap image); }
  interface ProbeCallback { void onResult(String result); }
  static final class Ad {
    final String id, session, placement, creativeUrl, headline, body, assetType;
    final int skipSeconds, durationSeconds;
    Ad(String id, String session, String placement, String creativeUrl, String headline,
       String body, String assetType, int skipSeconds, int durationSeconds) {
      this.id = id; this.session = session; this.placement = placement; this.creativeUrl = creativeUrl;
      this.headline = headline; this.body = body; this.assetType = assetType;
      this.skipSeconds = skipSeconds; this.durationSeconds = durationSeconds;
    }
  }
  private static final Set<String> PLACEMENTS = new HashSet<>(Arrays.asList(
      "pre_roll", "mid_roll", "timed_banner", "pause_overlay", "banner_player", "banner_pause"));
  private static final Set<String> EVENTS = new HashSet<>(Arrays.asList("impression", "click", "skip", "complete"));
  private static final String UUID_PATTERN = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
  private final ExecutorService executor = Executors.newSingleThreadExecutor();
  private final Handler main = new Handler(Looper.getMainLooper());
  private final String origin;
  private final String token;
  private volatile boolean closed;

  NativeAdClient(String appUrl, String token) {
    Uri base = Uri.parse(appUrl);
    if (!"https".equalsIgnoreCase(base.getScheme()) || base.getHost() == null || base.getUserInfo() != null) {
      throw new IllegalArgumentException("Invalid site origin");
    }
    origin = "https://" + base.getHost() + (base.getPort() < 0 ? "" : ":" + base.getPort());
    this.token = token == null || token.length() > 4096 || token.contains("\n") || token.contains("\r") ? "" : token;
  }

  void requestAd(String placement, Callback callback) {
    if (closed || !PLACEMENTS.contains(placement)) { main.post(() -> callback.onResult(null)); return; }
    executor.execute(() -> {
      Ad ad = null;
      try {
        JSONObject response = new JSONObject(request("GET", "/api/ads/serve?placement=" + placement, null, null));
        JSONObject item = response.optJSONObject("ad");
        if (item != null) {
          String id = item.optString("id");
          String session = item.optString("session");
          String creative = item.optString("creativeUrl");
          String assetType = item.optString("assetType");
          if (id.matches(UUID_PATTERN) && session.length() >= 40 && session.length() <= 400
              && NativePlayerActivity.safeHttps(creative) != null
              && ("image".equals(assetType) || "video".equals(assetType))) {
            ad = new Ad(id, session, placement, creative, item.optString("headline", "تبلیغ"),
                item.optString("body", ""), assetType,
                Math.max(0, Math.min(30, item.optInt("skipAfterSeconds", 0))),
                Math.max(1, Math.min(120, item.optInt("durationSeconds", 8))));
          }
        }
      } catch (Exception ignored) { /* Ads fail open when service is unavailable. */ }
      final Ad result = ad;
      main.post(() -> { if (!closed) callback.onResult(result); });
    });
  }

  /** Creative download never carries the site session token to the media host. */
  void loadImage(Ad ad, ImageCallback callback) {
    if (closed || ad == null || !"image".equals(ad.assetType)) { main.post(() -> callback.onResult(null)); return; }
    executor.execute(() -> {
      Bitmap bitmap = null;
      HttpURLConnection connection = null;
      try {
        connection = (HttpURLConnection) new URL(ad.creativeUrl).openConnection();
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(3500); connection.setReadTimeout(3500);
        int status = connection.getResponseCode();
        if (status >= 200 && status < 300) {
          ByteArrayOutputStream output = new ByteArrayOutputStream();
          try (InputStream input = connection.getInputStream()) {
            byte[] chunk = new byte[8192]; int count; int total = 0;
            while ((count = input.read(chunk)) != -1) {
              total += count; if (total > 4 * 1024 * 1024) throw new IllegalStateException("Creative too large");
              output.write(chunk, 0, count);
            }
          }
          byte[] bytes = output.toByteArray();
          BitmapFactory.Options options = new BitmapFactory.Options();
          options.inJustDecodeBounds = true; BitmapFactory.decodeByteArray(bytes, 0, bytes.length, options);
          if (options.outWidth > 0 && options.outHeight > 0) {
            options.inSampleSize = 1;
            while (options.outWidth / options.inSampleSize > 1600 || options.outHeight / options.inSampleSize > 1600) options.inSampleSize *= 2;
            options.inJustDecodeBounds = false;
            bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.length, options);
          }
        }
      } catch (Exception ignored) { }
      finally { if (connection != null) connection.disconnect(); }
      final Bitmap result = bitmap;
      main.post(() -> { if (!closed) callback.onResult(result); });
    });
  }

  /** Test only the direct host after a playback error. No URL is logged or sent to the site. */
  void probeMedia(Uri media, ProbeCallback callback) {
    if (closed || media == null) return;
    executor.execute(() -> {
      String result = "NETWORK_ERROR";
      HttpURLConnection connection = null;
      try {
        connection = (HttpURLConnection) new URL(media.toString()).openConnection();
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(4000); connection.setReadTimeout(4000);
        connection.setRequestProperty("Range", "bytes=0-0");
        connection.setRequestProperty("Accept-Encoding", "identity");
        result = "HTTP_" + connection.getResponseCode();
      } catch (javax.net.ssl.SSLException error) { result = "TLS_ERROR"; }
        catch (java.net.UnknownHostException error) { result = "DNS_ERROR"; }
        catch (java.net.SocketTimeoutException error) { result = "TIMEOUT"; }
        catch (Exception ignored) { }
      finally { if (connection != null) connection.disconnect(); }
      final String safeResult = result;
      main.post(() -> { if (!closed) callback.onResult(safeResult); });
    });
  }

  void record(Ad ad, String event) {
    if (closed || ad == null || !EVENTS.contains(event)) return;
    executor.execute(() -> {
      JSONObject body = new JSONObject();
      try { body.put("eventType", event); body.put("session", ad.session); } catch (Exception ignored) { return; }
      for (int attempt = 0; attempt < 3; attempt++) {
        try { request("POST", "/api/ads/" + ad.id + "/events", body.toString(), ad.session); return; }
        catch (HttpFailure failure) { if (failure.status > 0 && failure.status < 500 && failure.status != 429) return; }
        catch (Exception ignored) { }
        if (attempt < 2) try { Thread.sleep(250L * (attempt + 1)); } catch (InterruptedException ex) { Thread.currentThread().interrupt(); return; }
      }
    });
  }

  void saveProgress(String contentId, long positionMillis, long durationMillis) {
    if (closed || token.isEmpty() || contentId == null || !contentId.matches(UUID_PATTERN)
        || durationMillis <= 0 || positionMillis < 1000) return;
    long duration = Math.min(10000000, durationMillis / 1000);
    long position = Math.min(duration, Math.max(0, positionMillis / 1000));
    executor.execute(() -> {
      try {
        JSONObject body = new JSONObject().put("positionSeconds", position).put("durationSeconds", duration);
        request("POST", "/api/contents/" + contentId + "/progress", body.toString(), null);
      } catch (Exception ignored) { /* Best effort; do not block video playback. */ }
    });
  }

  String tunnelUrl(Ad ad) { return origin + "/api/ad-tunnel/" + ad.id; }

  private String request(String method, String path, String body, String adSession) throws Exception {
    HttpURLConnection connection = (HttpURLConnection) new URL(origin + path).openConnection();
    connection.setInstanceFollowRedirects(false);
    connection.setConnectTimeout(3500);
    connection.setReadTimeout(3500);
    connection.setRequestMethod(method);
    connection.setRequestProperty("Accept", "application/json");
    if (!token.isEmpty()) connection.setRequestProperty("Authorization", "Bearer " + token);
    if (adSession != null) connection.setRequestProperty("X-Ad-Session", adSession);
    try {
      if (body != null) {
        connection.setDoOutput(true);
        connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        connection.setFixedLengthStreamingMode(bytes.length);
        try (OutputStream output = connection.getOutputStream()) { output.write(bytes); }
      }
      int status = connection.getResponseCode();
      if (status < 200 || status >= 300) throw new HttpFailure(status);
      try (InputStream input = connection.getInputStream(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
        byte[] buffer = new byte[4096]; int count; int total = 0;
        while ((count = input.read(buffer)) != -1) {
          total += count;
          if (total > 131072) throw new IllegalStateException("Response too large");
          output.write(buffer, 0, count);
        }
        return output.toString("UTF-8");
      }
    } finally { connection.disconnect(); }
  }
  void close() { closed = true; executor.shutdown(); }
  private static final class HttpFailure extends Exception {
    final int status;
    HttpFailure(int status) { this.status = status; }
  }
}
