# Filmwork — راهنمای استقرار روی cPanel Linux

این راهنما برای MySQL 8، Node.js 18.18 یا جدیدتر، HTTPS و قابلیت **Setup Node.js App** در cPanel نوشته شده است. برنامه یک سرویس Node دارد که API، رابط وب و هر دو ربات تلگرام را اجرا می‌کند؛ بنابراین فقط یک Application لازم است.

> **نکته امنیتی مهم:** توکن ربات خصوصی در سورس هاردکد نشده است. هاردکد کردن توکن، آن را وارد Git و نسخه‌های پشتیبان می‌کند. `ADMIN_BOT_TOKEN` به‌همراه فهرست بسته `ADMIN_OWNER_IDS` همان جداسازی امنیتی موردنیاز را بدون افشای کلید فراهم می‌کند. کد کنسول مالک نیز بیرون پوشه عمومی است و فقط پس از ورود یک‌بارمصرف ربات خصوصی ارسال می‌شود.

## 1) پیش‌نیازها

- دامنه یا زیردامنه دارای گواهی SSL معتبر، برای مثال `stream.example.com`
- cPanel با Node.js `18.18+` (Node.js 20 LTS پیشنهاد می‌شود)
- MySQL `8.0+`
- دسترسی Terminal یا SSH برای اجرای `npm ci`
- دو ربات جداگانه از BotFather:
  1. ربات عمومی ورود و تحویل فایل
  2. ربات خصوصی مالک/ورود مدیریت/پارسر
- سه کانال خصوصی تلگرام برای نسخه اصلی و دو fallback

## 2) انتقال کد

کد را با Git Version Control خود cPanel یا SSH در مسیری داخل Home کاربر قرار دهید:

```bash
cd ~
git clone https://github.com/OWNER/REPOSITORY.git filmwork
cd ~/filmwork/backend
npm ci --omit=dev
```

فایل `frontend/styles.css` از قبل build شده و در Git قرار دارد؛ سرور production به Tailwind CLI نیاز ندارد. فقط برای تغییر طراحی و build مجدد CSS اجرا کنید:

```bash
cd ~/filmwork/backend
npm ci
npm run build:css
```

## 3) ساخت دیتابیس

1. از **MySQL Databases** یک database و یک user بسازید.
2. یک رمز تصادفی طولانی برای user تعیین کنید.
3. user را با مجوزهای `SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES, EXECUTE` به database متصل کنید.
4. از phpMyAdmin، database را انتخاب و `database/schema.sql` را Import کنید؛ یا در SSH:

```bash
mysql -u CPANEL_DB_USER -p CPANEL_DB_NAME < ~/filmwork/database/schema.sql
```

Schema از InnoDB و `utf8mb4` استفاده می‌کند و جدول‌ها را idempotent می‌سازد. جدول‌های `playback_progress` و `download_history` به‌ترتیب ادامه‌تماشا و تاریخچه ارسال فایل را نگه می‌دارند؛ شماره تلفن یا متن خصوصی تلگرام در این جدول‌ها ذخیره نمی‌شود. هنگام ارتقای نسخه قبلی نیز اجرای دوباره همین فایل، جدول‌های جدید را با `CREATE TABLE IF NOT EXISTS` اضافه می‌کند و داده‌های قبلی را حذف نمی‌کند. در پایان یک procedure نگه‌داری به نام `promote_media_fallback` ایجاد می‌شود. API برای بازیابی به procedure وابسته نیست و همان جابه‌جایی را داخل transaction و با `SELECT ... FOR UPDATE` انجام می‌دهد. اگر host اجازه `CREATE ROUTINE` نمی‌دهد، فقط بخش بین `DROP PROCEDURE` و آخر فایل را حذف و import را تکرار کنید.

## 4) ساخت کلیدها و `.env`

```bash
cd ~/filmwork/backend
cp .env.example .env
chmod 600 .env
openssl rand -hex 32   # JWT_SECRET
openssl rand -hex 32   # AUTH_CODE_PEPPER
openssl rand -hex 32   # PHONE_ENCRYPTION_KEY
```

هر خروجی باید مستقل باشد. سپس `.env` را ویرایش کنید. مهم‌ترین متغیرها:

| متغیر | کاربرد |
|---|---|
| `APP_URL` | URL کامل HTTPS بدون slash پایانی |
| `CORS_ORIGINS` | originهای مجاز، جداشده با کاما |
| `DB_*` | اطلاعات MySQL ساخته‌شده در cPanel |
| `JWT_SECRET` | امضای sessionهای کاربر و مالک |
| `AUTH_CODE_PEPPER` | HMAC کدهای ورود و داده‌های ضدتقلب |
| `PHONE_ENCRYPTION_KEY` | AES-256-GCM شماره تلفن‌ها؛ تغییر آن اطلاعات قبلی را غیرقابل رمزگشایی می‌کند |
| `AUTH_BOT_TOKEN` | token ربات عمومی |
| `AUTH_BOT_USERNAME` | username ربات عمومی، بدون `@` |
| `ADMIN_BOT_TOKEN` | token کاملاً مجزای ربات خصوصی |
| `ADMIN_OWNER_IDS` | Telegram numeric user ID مالک‌ها، با کاما |
| `*_CHAT_ID` | شناسه عددی سه کانال، معمولاً با `-100` |

در production باید `NODE_ENV=production`، `TRUST_PROXY=1` و `APP_URL=https://...` باشد.

### نگه‌داری امن شماره تلفن

شماره تلفن در ستون `encrypted_phone` با AES-256-GCM و nonce تصادفی ذخیره می‌شود. API عمومی هرگز Telegram ID، username یا شماره را در دیدگاه‌ها برنمی‌گرداند؛ تنها `account_name` نمایش داده می‌شود. از سه secret فایل `.env` نسخه پشتیبان رمزگذاری‌شده نگه دارید.

## 5) آماده‌سازی تلگرام

### 5.1 ربات عمومی

1. در BotFather ربات بسازید و token را در `AUTH_BOT_TOKEN` بگذارید.
2. ربات را در هر سه کانال storage به‌عنوان administrator اضافه کنید. دسترسی مشاهده و ارسال پیام لازم است تا `copyMessage` بتواند فایل را برای کاربر کپی کند.
3. کاربر باید یک‌بار `/start` را در این ربات بزند. دکمه contact فقط شماره متعلق به همان Telegram user را قبول می‌کند.

### 5.2 ربات خصوصی مدیریت

1. ربات دوم بسازید و token آن را فقط در `ADMIN_BOT_TOKEN` بگذارید.
2. numeric Telegram user ID مالک را در `ADMIN_OWNER_IDS` وارد کنید. پیام افراد دیگر بی‌صدا نادیده گرفته می‌شود.
3. ربات را administrator هر سه کانال کنید تا فایل را به fallbackها کپی کند.
4. `ADMIN_SOURCE_CHAT_ID` و `TELEGRAM_PRIMARY_CHAT_ID` معمولاً یک کانال هستند.

### 5.3 یافتن chat ID بدون سرویس شخص ثالث

پیش از اجرای production، ربات را به کانال اضافه کنید و یک پیام جدید بفرستید. موقتاً با token خودتان (آن را در chat، ticket یا Git قرار ندهید) اجرا کنید:

```bash
curl -s "https://api.telegram.org/bot${TOKEN}/getUpdates"
```

در JSON مقدار `channel_post.chat.id` را بردارید. بعد از ثبت IDها، برنامه را اجرا کنید. هم‌زمان نباید process دیگری `getUpdates` همان bot را مصرف کند.

### 5.4 لینک‌های private storage

برای کانال خصوصی، برنامه لینک `https://t.me/c/<internal-id>/<message-id>` می‌سازد. بررسی قطعی حذف فایل private با HTTP ممکن نیست؛ به همین دلیل `/api/download` از Telegram Bot API و `copyMessage` به‌عنوان health check قطعی استفاده می‌کند. اگر Telegram اعلام کند پیام حذف شده است، API در transaction:

1. primary معیوب را از رکورد خارج می‌کند؛
2. fallback 1 را به primary ارتقا می‌دهد؛
3. fallback 2 را به fallback 1 می‌برد؛
4. رخداد را در `media_health_events` ثبت می‌کند؛
5. همان درخواست کاربر را با نسخه سالم ادامه می‌دهد.

## 6) ساخت Node.js Application در cPanel

در **Setup Node.js App**:

- **Node.js version:** 20.x (یا حداقل 18.18)
- **Application mode:** Production
- **Application root:** `filmwork/backend`
- **Application URL:** دامنه/زیردامنه موردنظر، بدون sub-path ترجیحاً
- **Application startup file:** `app.js`  ← **نه** `server.js`

> **مهم:** Passenger (که cPanel از آن استفاده می‌کند) فایل startup را با `require()` بارگذاری می‌کند و آن را به‌عنوان ماژول اصلی اجرا نمی‌کند. اگر startup file را روی `server.js` بگذارید، شرط `if (require.main === module)` هرگز برقرار نمی‌شود، هیچ پورتی باز نمی‌شود و دامنه پاسخ **503 Service Unavailable** می‌دهد. فایل `app.js` دقیقاً برای همین ساخته شده و در هر حالتی سرور را بالا می‌آورد.

روی **Create** و سپس **Run NPM Install** بزنید. اگر UI وابستگی dev را نصب می‌کند مشکلی ندارد، ولی در SSH `npm ci --omit=dev` کم‌حجم‌تر است.

متغیرهای `.env` با `dotenv` بارگذاری می‌شوند. اگر سیاست host ذخیره secret در `.env` را منع می‌کند، همان مقادیر را در بخش **Environment Variables** cPanel قرار دهید؛ environment واقعی بر فایل مقدم است.

پس از هر تغییر:

```bash
cd ~/filmwork/backend
mkdir -p tmp
touch tmp/restart.txt
```

یا دکمه **Restart Application** را بزنید.

### یک process برای long polling

هر bot token فقط باید توسط یک process polling شود. تعداد instanceهای Application را روی **1** نگه دارید. اگر host برنامه‌های idle را متوقف می‌کند:

- در صورت دسترسی، `PassengerMinInstances 1` را برای app فعال کنید؛ یا
- هر پنج دقیقه یک cron محلی برای health endpoint بسازید:

```cron
*/5 * * * * /usr/bin/curl -fsS https://stream.example.com/api/health >/dev/null 2>&1
```

Cron جای SSL و process manager سالم را نمی‌گیرد. اگر host اجرای process پایدار Node/Telegram را ممنوع کرده است، بخش backend باید روی VPS/Node host پایدار اجرا شود و frontend همچنان می‌تواند روی cPanel بماند.

## 7) مجوز پوشه uploads

خلاقه‌های آپلودشده تبلیغات در `backend/uploads` قرار می‌گیرند:

```bash
cd ~/filmwork/backend
chmod 750 uploads
```

این پوشه در Git ignore شده است. آن را در برنامه backup cPanel قرار دهید. در استقرار release-based بهتر است پوشه‌ای پایدار بسازید و symlink کنید.

## 8) تست پس از استقرار

### Health check

```bash
curl -i https://stream.example.com/api/health
```

پاسخ مورد انتظار:

```json
{
  "status": "ok",
  "database": { "ok": true, "latencyMs": 3 },
  "bots": { "authentication": true, "administration": true },
  "timestamp": "..."
}
```

اگر دیتابیس در دسترس نباشد، همان endpoint کد `503` و `status: "degraded"` برمی‌گرداند تا مانیتورینگ آن را از 503 دامنه تشخیص دهد. اگر یکی از botها `false` است، `bots.status.lastError` و log اپ را ببینید. اکنون شکست ربات، سایت را از کار نمی‌اندازد: فقط همان ربات در پس‌زمینه هر پنج دقیقه دوباره تلاش می‌کند.

### اگر دامنه 503 داد

1. در cPanel → **Setup Node.js App** مقدار **Application startup file** باید `app.js` باشد؛ اگر `server.js` است عوض کنید و Restart بزنید.
2. دامنه را باز کنید. به‌جای صفحه 503 خالی، صفحه‌ای فارسی با **علت دقیق** و فهرست متغیرهای تنظیم‌نشده نمایش داده می‌شود (هیچ مقدار محرمانه‌ای در آن صفحه نیست). همان متن را رفع کنید و Restart بزنید.
3. اگر پیام `EADDRINUSE` دیدید، یک instance قدیمی هنوز روی پورت است: در cPanel روی **Stop Application** بزنید و دوباره Start کنید.
4. اگر پیام `409 Conflict` دیدید، بیش از یک process همان bot token را poll می‌کند؛ instance را روی 1 نگه دارید.
5. لاگ خطای Passenger در `stderr.log` پوشه Application یا بخش **Errors** در cPanel است.

### تست محلی سورس

```bash
cd ~/filmwork/backend
npm test
node --check app.js
node --check server.js
```

### مسیر کامل تست عملی

1. یک پست metadata را برای ربات خصوصی forward کنید، متن آن را paste کنید، یا لینک عمومی `t.me/channel/message` را بفرستید. نمونه قالب قابل تشخیص:

   ```text
   عنوان: Dune Part Two
   IMDb: 8.7
   سال انتشار: 2024
   ژانر: علمی تخیلی، ماجراجویی
   خلاصه داستان: متن خلاصه
   ```

2. ربات UUID اثر را برمی‌گرداند.
3. در Channel 1 دستور زیر را بفرستید:

   ```text
   #اثر 550e8400-e29b-41d4-a716-446655440000 #نسخه DigiMovies #نوع سافتساب #زیرنویس مجزا #رزولوشن 1080p #سریال S01.E01 #کیفیت WEB-DL #انکودر x265
   ```

4. ویدیو و، برای `#زیرنویس مجزا`، فایل `.srt` را حداکثر ده ثانیه بعد بفرستید.
5. وجود پیام در هر سه کانال و کارت نسخه در سایت را بررسی کنید.
6. در سایت، ربات عمومی را باز کنید، contact را share کنید و کد شش‌رقمی را وارد کنید.
7. یک download را انتخاب کنید؛ پس از pre-roll و هشدار، فایل باید در گفت‌وگوی ربات عمومی کپی شود.
8. برای آزمون recovery، فقط پیام primary را حذف کنید و همان download را بزنید. رکورد باید خودکار به fallback 1 ارتقا یابد.

## 9) کنسول مالک و تبلیغ‌دهندگان

کنسول مالک URL عمومی یا bundle عمومی ندارد:

1. در **ربات خصوصی** دستور `/panel` را بزنید.
2. ربات یک URL تصادفی یک‌بارمصرف با اعتبار پنج دقیقه می‌دهد.
3. API token را مصرف می‌کند، cookie `HttpOnly + SameSite=Strict + Secure` می‌سازد و سپس فایل‌های کنسول را تحویل می‌دهد.
4. از کنسول می‌توان اثرها و تبلیغات را publish/approve کرد، نقش کاربر را به advertiser تغییر داد و کیف پول را شارژ کرد.

کاربر عادی هرگز نقش admin از ربات عمومی نمی‌گیرد؛ enum عمومی فقط `user` و `advertiser` است. routeهای مالک برای درخواست بدون cookie معتبر عمداً پاسخ 404 می‌دهند.

چرخه تبلیغات:

1. مالک نقش کاربر را در کنسول به **advertiser** تغییر می‌دهد و کیف پول را شارژ می‌کند.
2. تبلیغ‌دهنده از Hub جایگاه، بودجه، creative و زمان را انتخاب می‌کند.
3. بودجه با row lock از wallet رزرو و campaign با وضعیت `pending` ساخته می‌شود.
4. مالک آن را `active` می‌کند.
5. pre-roll، timed banner و pause overlay توسط player سرو می‌شوند؛ landing tunnel محتوای ثبت‌شده را بدون باز کردن Telegram نمایش می‌دهد.

## 10) سخت‌سازی production

- AutoSSL و اجبار HTTPS را فعال کنید.
- `.env` نباید داخل `public_html` یا Git باشد؛ mode آن `600` بماند.
- token ربات‌ها را هرگز در URL قابل‌مشاهده، screenshot یا log عمومی قرار ندهید.
- MySQL را فقط روی localhost باز نگه دارید و user برنامه را به همان database محدود کنید.
- backup روزانه MySQL، `backend/uploads` و secrets رمزگذاری‌شده را تنظیم کنید.
- logها را برای `MEDIA_UNAVAILABLE`، خطای Bot API و `media_health_events` مانیتور کنید.
- `CORS_ORIGINS` را به دامنه واقعی محدود کنید؛ از `*` استفاده نکنید.
- حداکثر upload و مدت session را متناسب با plan host تنظیم کنید.
- برای CDN خارجی creativeها، CORS لازم نیست؛ برای فایل SRT خارجی که player مستقیماً fetch می‌کند، سرور فایل باید `Access-Control-Allow-Origin` مناسب برگرداند.
- فقط محتوایی را منتشر و توزیع کنید که مجوز قانونی آن را دارید و سیاست حریم خصوصی/حذف حساب متناسب با حوزه فعالیت ارائه کنید.

## 11) رفع اشکال سریع

| نشانه | بررسی |
|---|---|
| `503` روی دامنه | startup file روی `app.js` تنظیم شده باشد؛ log اپ، نسخه Node، syntax `.env` و اتصال MySQL |
| `502` پس از restart | log اپ، نسخه Node، syntax `.env` و اتصال MySQL |
| bot با `409 Conflict` | process دیگری همان token را poll می‌کند؛ instance را به 1 کاهش دهید |
| فایل به کاربر کپی نمی‌شود | ربات عمومی باید در channel مربوط administrator و کاربر قبلاً `/start` کرده باشد |
| لینک `/c/` باز نمی‌شود | کاربر عضو کانال نیست؛ delivery خودکار با `copyMessage` را بررسی کنید |
| کد ورود منقضی است | ساعت سرور/NTP و `AUTH_CODE_TTL_MINUTES` را بررسی کنید |
| SRT نمایش داده نمی‌شود | URL فایل باید HTTPS و دارای CORS باشد؛ parser از SRT و WebVTT timestamp پشتیبانی می‌کند |
| console مالک 404 می‌دهد | URL باید تازه و یک‌بارمصرف باشد؛ دوباره `/panel` بزنید |
| campaign ساخته نمی‌شود | نقش advertiser، موجودی wallet، حداقل بودجه و تاریخ پایان را بررسی کنید |
