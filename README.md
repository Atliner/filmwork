# Filmwork

Filmwork is a production-oriented, RTL movie and series platform with a Node.js/MySQL API, a premium responsive SPA, Telegram login and file delivery, a three-replica self-healing media store, a private owner bot, and an advertiser hub.

## Repository layout

```text
backend/
  server.js                 Express API, SPA host, owner-only routes
  bots/adminBot.js          metadata parser, media replication, owner login
  bots/authBot.js           contact login codes and Telegram delivery
  config/db.js              mysql2/promise pool and transactions
  services/mediaDelivery.js fallback promotion and delivery
  private/                   owner console (never publicly served)
frontend/
  index.html                 RTL SPA shell
  app.js                     routing, player, downloads, auth, advertiser UI
  styles.css                 committed production Tailwind build
database/schema.sql          complete MySQL 8 schema
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

## Security model

- Public sessions are short JWT claims hydrated from the database on each request.
- Six-digit codes are HMAC-protected, single-use, globally unique while active, rate-limited, and expire quickly.
- Phone numbers use AES-256-GCM at rest.
- Public roles can only be `user` or `advertiser`.
- Owner access is issued only by a separate allowlisted bot through a five-minute, one-use exchange URL.
- Owner assets live outside the public static directory and unauthenticated requests receive 404.
- Media fallback promotion is row-locked and recorded in an audit table.

See [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md) for the complete production procedure.
