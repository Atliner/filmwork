# Filmwork

Filmwork is a production-oriented, RTL movie and series platform with a Node.js/MySQL API, a premium responsive SPA, Telegram login and file delivery, a three-replica self-healing media store, a private owner bot, and an advertiser hub.

## Repository layout

```text
backend/
  app.js                    hosting-safe entry point (Passenger/cPanel startup file)
  server.js                 Express API, SPA host, owner-only routes
  bots/adminBot.js          metadata parser, media replication, owner login
  bots/authBot.js           contact login codes and Telegram delivery
  config/db.js              mysql2/promise pool and transactions
  services/mediaDelivery.js fallback promotion and delivery
  private/                   owner console (never publicly served)
    admin.html               console shell (overview / library / wizard / guide)
    admin.js                 views, wizard state machine, API calls
    admin.css                hand-written console styles (no build step)
    PANEL_GUIDE.md           full owner guide (post format, bot directives, deploy)
  lib/postParser.js          Telegram post → structured metadata (shared with the bot)
  lib/contentParams.js       owner payload validation and parse-draft builder
  services/contentStore.js   MySQL store for the console
  services/contentStoreDemo.js  in-memory store for DEMO_DATA=1 previews
  services/adminOverview.js  overview cards, charts and feeds
frontend/
  index.html                 RTL SPA shell
  app.js                     routing, player, downloads, auth, advertiser UI
  styles.css                 committed production Tailwind build
database/schema.sql          complete MySQL 8 schema
database/migrations/         additive migrations for existing installs
DEPLOYMENT_GUIDE.md          cPanel and Telegram setup
```

## Development

```bash
cd backend
cp .env.example .env        # fill real local values
npm install
npm run build:css
npm test
npm start
```

The server binds to `0.0.0.0:$PORT`, serves the frontend itself, and uses relative `/api` calls. Node.js 18.18+ and MySQL 8 are required.

`app.js` is the entry point for every runtime: `npm start` runs it, and Passenger (cPanel "Setup Node.js App") must be pointed at `app.js`, not `server.js` — Passenger imports the startup file instead of running it as the main module, so a `require.main === module` guard leaves the port unbound and the domain returns 503. If startup fails, the process keeps serving a diagnostic page that names the cause instead of a bare 503, and swaps the real application in automatically once it can start.

## Product experience

- Cinematic Obsidian mobile-first shell with an RTL header, four-item glass dock, cinematic hero, poster rails, and responsive search grid.
- Search by title or genre with type, year, and IMDb filters.
- Authenticated playback progress, resume-from-last-position, profile statistics, and Telegram download history.
- Custom player with direct source binding, external SRT/VTT and dubbed audio synchronization, embedded-track selection, and related titles.
- Hierarchical season/audio/resolution download picker and self-healing Telegram delivery.
- Advertiser analytics, wallet, placement mockup, campaign creation, and pause/resume controls.
- Owner console with a numeric overview (content split, views, users, media health, genres, 14-day trend), a card-based content library (poster, year, IMDb, seasons/episodes, qualities, views, hero toggle, edit and delete), and a four-step wizard that reads a Telegram post or link into prefilled metadata, builds subtitle/dub versions per quality, and pulls bot-ingested links into them.
- Owner-only manual content entry alongside automated Telegram ingestion; owner HTML, CSS and JavaScript remain outside public static hosting.
- `DEMO_DATA=1` runs the console on an in-memory store (development preview only; production always uses MySQL).

## Security model

- Public sessions are short JWT claims hydrated from the database on each request.
- Six-digit codes are HMAC-protected, single-use, globally unique while active, rate-limited, and expire quickly.
- Phone numbers use AES-256-GCM at rest.
- Public roles can only be `user` or `advertiser`.
- Owner access is issued only by a separate allowlisted bot through a five-minute, one-use exchange URL.
- Owner assets live outside the public static directory and unauthenticated requests receive 404.
- Media fallback promotion is row-locked and recorded in an audit table.

The owner console is documented in [backend/private/PANEL_GUIDE.md](backend/private/PANEL_GUIDE.md): post format, series rules, version building, bot directives and troubleshooting.

See [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md) for the complete production procedure.
