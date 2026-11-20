package com.filmwork.app;

import android.app.Application;

public final class VizostenApplication extends Application {
  @Override public void onCreate() {
    super.onCreate();
    PlayerDiagnostics.installCrashHandler(this);
    PlayerDiagnostics.mark(this, "APP_STARTED");
  }
}
