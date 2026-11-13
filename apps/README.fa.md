# اپ‌های سبک Filmwork

Android و Windows فقط پوستهٔ کوچکی هستند و سایت زنده را از `https://namdarcompost.ir/#/home` نمایش می‌دهند. محتوا و API داخل اپ کپی نمی‌شوند؛ بنابراین تغییرات سایت بدون نصب مجدد اپ دیده می‌شوند.

هدف اندازهٔ APK و EXE هرکدام حداکثر **۱۰ MiB** است. Workflow این سقف را کنترل می‌کند و در صورت بزرگ‌تر بودن خروجی، build را fail می‌کند. اندازهٔ واقعی پس از اولین اجرای موفق GitHub Actions تأیید می‌شود.

## Android

از `android-actions/setup-android@v4` استفاده کنید و `tools` را به SDK Manager ندهید؛ این پکیج قدیمی حذف شده است و باعث خطای `Failed to find package 'tools'` می‌شود. Workflow این branch تنها `platform-tools` را نصب می‌کند. ساخت APK با Java 17، Gradle 8.9 و shrink/minify فعال انجام می‌شود.

## Windows

Windows با Tauri ساخته می‌شود و از WebView2 خود Windows استفاده می‌کند، نه Chromium/Electron. اگر WebView2 موجود نباشد، installer نصب‌کنندهٔ کوچک آن را هنگام نصب دریافت می‌کند.

## iPhone / iPad

در Safari آدرس سایت را باز کنید، **Share → Add to Home Screen** را بزنید. PWA فقط پوسته را cache می‌کند؛ درخواست‌های API و اطلاعات حساب cache نمی‌شوند.

## هشدار نصب و امضا

APK با debug key قابل نصب ساخته می‌شود اما ناشر را تأیید نمی‌کند؛ EXE نیز فعلاً Authenticode ندارد. ممکن است Android یا Windows هشدار منبع/ناشر ناشناس نشان دهد. برای ناشر تأییدشده باید کلید انتشار Android و گواهی معتبر Windows تهیه شوند. هیچ‌کدام تضمین نمی‌کنند همهٔ آنتی‌ویروس‌ها هیچ‌گاه هشدار ندهند.
