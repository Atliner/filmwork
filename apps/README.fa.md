# اپ‌های Filmwork

این پوشه شامل Android WebView و Windows Electron است. هر دو پوسته سایت زنده را نشان می‌دهند؛ تغییرات سایت بدون نصب نسخهٔ جدید پوسته دیده می‌شوند. PWA آیفون نیز از همان دامنه استفاده می‌کند.

## نشانی سایت

نشانی عمومی فعلی اپ‌ها:

```text
https://namdarcompost.ir/#/home
```

این URL را در build variable با نام `FILMWORK_APP_URL` قرار دهید. مسیر `/#/home` لازم است تا اپ از خانه شروع شود. از IP هاست استفاده نکنید.

## ساخت Android در GitHub Actions

یک workflow دستی بسازید (`workflow_dispatch`) و در runner اوبونتو این کارها را انجام دهید:

1. Checkout مخزن.
2. Java 17 و Android SDK را نصب/فعال کنید و Gradle 8.9 را آماده کنید.
3. `FILMWORK_APP_URL=https://namdarcompost.ir/#/home` را برای مرحلهٔ build تنظیم کنید.
4. از مسیر `apps/android` اجرا کنید: `gradle assembleRelease`.
5. با `actions/upload-artifact@v4` این فایل را به‌عنوان Artifact بارگذاری کنید:
   `apps/android/app/build/outputs/apk/release/*.apk`

در `app/build.gradle` دامنه در BuildConfig قرار می‌گیرد و اتصال HTTP ناامن غیرفعال است.

## ساخت Windows در GitHub Actions

از runner ویندوز و Node.js 20 استفاده کنید:

1. قبل از ساخت، مقدار `FILMWORK_APP_URL` را به JSON زیر در `apps/desktop/app-config.json` تبدیل کنید:
   `{"url":"https://namdarcompost.ir/#/home"}`
2. در `apps/desktop`، `npm ci` و سپس `npm run dist:win` را اجرا کنید.
3. با `actions/upload-artifact@v4` خروجی `apps/desktop/dist/*.exe` را بارگذاری کنید.

`app-config.json` و فایل‌های خروجی عمداً در Git نادیده گرفته می‌شوند. برای trigger از `workflow_dispatch` استفاده کنید تا متغیر URL در زمان build قابل تنظیم باشد. برای آرتیفکت‌های GitHub، مدت نگهداری را در مرحلهٔ upload تنظیم کنید؛ برای لینک دائمی لازم است آن‌ها را به GitHub Release متصل کنید.

## iPhone / iPad (PWA)

در Safari آیفون `https://namdarcompost.ir/#/home` را باز کنید، Share و سپس **Add to Home Screen** را بزنید. PWA از سایت زنده استفاده می‌کند؛ داده‌ها و APIهای حساب کاربری آفلاین cache نمی‌شوند.

## امضا و هشدارهای امنیتی

Android با کلید debug امضا می‌شود تا APK قابل نصب باشد؛ این امضا هویت ناشر را اثبات نمی‌کند. EXE نیز فعلاً گواهی Authenticode ندارد. بنابراین Android ممکن است هشدار نصب از منبع ناشناس و Windows هشدار SmartScreen ناشر ناشناس نشان دهد. برای هویت ناشر تأییدشده، باید کلید انتشار Android و گواهی معتبر Windows تهیه و به‌صورت GitHub Secrets استفاده شوند؛ کلید خصوصی را commit نکنید. هیچ روشی نمی‌تواند تضمین کند هر آنتی‌ویروس هیچ‌وقت هشدار ندهد.

فعلاً اپ‌ها مستقیم به دامنهٔ عمومی بالا وصل می‌شوند؛ میزبان اصلی از روی دامنه قابل شناسایی است. اگر بعداً Cloudflare Worker اضافه شد، buildها را با URL عمومی Worker دوباره تولید کنید و دسترسی مستقیم origin را هم در فایروال ببندید.
