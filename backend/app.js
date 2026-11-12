'use strict';

const path = require('path');
const http = require('http');

/**
 * Hosting-safe entry point.
 *
 * Two very different runtimes start this application:
 *
 * 1. A plain process manager (systemd, PM2, `npm start`): `node app.js`.
 * 2. Phusion Passenger — the runtime behind cPanel's "Setup Node.js App" and most
 *    LiteSpeed/CloudLinux Node selectors. Passenger `require()`s the startup file
 *    instead of executing it as the main module.
 *
 * `server.js` used to listen only inside `if (require.main === module)`. Under
 * Passenger that branch is never taken, so nothing ever bound a port and the web
 * server answered **503 Service Unavailable** for every request — the exact symptom
 * of a deployment that looks "finished" but returns 503 on the domain.
 *
 * This file therefore starts the server however it was launched. When startup fails
 * (wrong `.env`, database not created yet, revoked bot token) it keeps the port open
 * with a diagnostic page that names the real cause, and swaps the real application in
 * automatically once it can start. It is an entry point only: nothing imports it, and
 * unit tests import `server.js` directly so nothing starts by accident.
 */

// `npm start` / `node app.js` runs in production unless NODE_ENV says otherwise;
// leaving it unset silently disables the production guards (HTTPS-only `APP_URL`,
// required bot tokens, Secure cookies).
if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = 'production';
  console.warn('NODE_ENV was not set; defaulting to production.');
}

const envBeforeDotenv = process.env.NODE_ENV;
let serverModule = null;
let loadError = null;
try {
  serverModule = require('./server');
} catch (error) {
  loadError = error;
}

/** `.env` may supply NODE_ENV; reload so the production guards actually apply. */
function reloadIfModeChanged() {
  if (envBeforeDotenv === process.env.NODE_ENV) return;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(__dirname) && !key.includes(`${path.sep}tests${path.sep}`)) {
      delete require.cache[key];
    }
  }
  serverModule = require('./server');
  loadError = null;
}

function isHostedRuntime() {
  return process.env.PASSENGER_BASE_URI !== undefined
    || process.env.PASSENGER_APP_ENV !== undefined
    || process.env.PASSENGER_APP_ROOT !== undefined
    || process.env.PHUSION_PASSENGER !== undefined;
}

async function main() {
  const fail = (error) => {
    console.error('Filmwork failed to start:', error);
    // FILMWORK_BOOT_PAGE=0 exits instead of serving the page (CI, or hosts that
    // restart the process and expect a non-zero exit).
    if (process.env.FILMWORK_BOOT_PAGE === '0') {
      process.exit(1);
      return undefined;
    }

    reloadIfModeChanged();
    const { renderBootError } = require('./lib/bootError');
    const port = Number(String(process.env.PORT || 3000).trim()) || 3000;
    let appState = 'booting';

    // One listener for the whole lifetime of the process. While the app cannot start
    // it answers with the diagnostic page; as soon as a retry succeeds it forwards
    // every request to the real app (calling `app.handle` on the same socket is the
    // supported way to swap a request listener without rebinding the port).
    const server = http.createServer((req, res) => {
      if (appState === 'ready' && serverModule) {
        serverModule.app(req, res);
        return;
      }
      res.writeHead(500, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Robots-Tag': 'noindex, nofollow',
      });
      res.end(renderBootError(loadError || error));
    });
    server.on('error', (listenError) => {
      console.error('Could not open the HTTP port:', listenError.message);
      process.exit(1);
    });
    server.listen(port, '0.0.0.0', () => {
      console.error(`Diagnostic page listening on 0.0.0.0:${port} (the application itself did not start)`);
    });

    if (serverModule) {
      serverModule.hooks.listenOnceReady = () => server;
    }

    // Self-healing: a database that is still being imported, or MySQL restarting after
    // the app, must not require a manual "Restart Application".
    const retryMs = Math.max(5_000, Number(process.env.BOOT_RETRY_SECONDS || 15) * 1000);
    const retry = setInterval(async () => {
      if (!serverModule) {
        reloadIfModeChanged();
        if (!serverModule) return;
        serverModule.hooks.listenOnceReady = () => server;
      }
      try {
        await serverModule.start({ listen: false });
        appState = 'ready';
        clearInterval(retry);
        console.log('Filmwork recovered; serving the application on the existing port.');
      } catch (retryError) {
        console.error('Startup retry still failing:', retryError.message);
      }
    }, retryMs);
    retry.unref?.();

    const stop = () => {
      clearInterval(retry);
      server.close(() => process.exit(0));
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    return undefined;
  };

  reloadIfModeChanged();
  if (loadError) return fail(loadError);

  // Passenger restarts the process with SIGTERM; shut down gracefully.
  const stop = () => (serverModule && serverModule.shutdown
    ? serverModule.shutdown('SIGTERM').then(() => process.exit(0)).catch(() => process.exit(0))
    : process.exit(0));
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);

  try {
    await serverModule.start();
    console.log('Filmwork is up.');
  } catch (error) {
    return fail(error);
  }
  return undefined;
}

main().catch((error) => {
  console.error('Filmwork bootstrap failed:', error);
  process.exit(1);
});

module.exports = Object.assign({}, serverModule || {}, { hosted: isHostedRuntime(), entrypoint: true });
