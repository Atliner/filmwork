'use strict';

const mysqlStore = require('./contentStore').store;
const demoStore = require('./contentStoreDemo').store;

/**
 * The owner console talks to exactly one store object.
 *
 * `DEMO_DATA=1` swaps in the in-memory store so the panel can be reviewed on a
 * machine without MySQL (local design work, screenshots). Every real deployment —
 * including cPanel — runs the MySQL store.
 */
function contentStore() {
  return process.env.DEMO_DATA === '1' ? demoStore : mysqlStore;
}

module.exports = { contentStore, mysqlStore, demoStore };
