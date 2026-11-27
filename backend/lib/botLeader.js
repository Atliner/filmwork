'use strict';
const crypto = require('crypto');

// MySQL named locks are tied to a dedicated connection, need no migration, and
// coordinate web workers sharing this database. Legacy/independent deployments
// that do not use this protocol must still be stopped by the operator.
class BotLeader {
  constructor(pool, onLoss, options = {}) {
    this.pool = pool;
    this.onLoss = onLoss;
    this.name = options.name || `filmwork:pollers:${crypto.createHash('sha256').update(String(process.env.DB_NAME || '')).digest('hex').slice(0, 32)}`;
    this.heartbeatMs = options.heartbeatMs || 5000;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs || 7000;
    this.connection = null;
    this.acquiring = null;
    this.timer = null;
    this.closed = false;
    this.checking = false;
  }
  async acquire() {
    if (this.closed) return false;
    if (this.connection) return true;
    if (this.acquiring) return this.acquiring;
    this.acquiring = this.tryAcquire().finally(() => { this.acquiring = null; });
    return this.acquiring;
  }
  async tryAcquire() {
    const connection = await this.pool.getConnection();
    let locked = false;
    try {
      const [rows] = await connection.execute('SELECT GET_LOCK(:name, 0) AS acquired', { name: this.name });
      locked = Number(rows[0]?.acquired) === 1;
      if (!locked) { connection.release(); return false; }
      if (this.closed) { await this.unlock(connection); return false; }
      this.connection = connection;
      this.timer = setInterval(() => this.check().catch(() => {}), this.heartbeatMs);
      this.timer.unref?.();
      return true;
    } catch (error) {
      if (locked) await this.unlock(connection);
      else connection.release();
      throw error;
    }
  }
  async check() {
    const connection = this.connection;
    if (!connection || this.checking) return;
    this.checking = true;
    try {
      let timeout;
      let rows;
      try {
        [rows] = await Promise.race([
          connection.execute('SELECT IS_USED_LOCK(:name) = CONNECTION_ID() AS owned', { name: this.name }),
          new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Telegram leader heartbeat timed out')), this.heartbeatTimeoutMs); timeout.unref?.(); }),
        ]);
      } finally { clearTimeout(timeout); }
      if (Number(rows[0]?.owned) !== 1) throw new Error('Telegram leader lock was lost');
    } catch (error) {
      if (this.connection === connection) {
        this.connection = null;
        clearInterval(this.timer);
        this.timer = null;
        connection.destroy();
        await this.onLoss(error);
      }
    } finally { this.checking = false; }
  }
  async unlock(connection) {
    try {
      await connection.execute('SELECT RELEASE_LOCK(:name)', { name: this.name });
      connection.release();
    } catch { connection.destroy(); }
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    this.timer = null;
    if (this.acquiring) await this.acquiring.catch(() => {});
    const connection = this.connection;
    this.connection = null;
    if (connection) await this.unlock(connection);
  }
}
module.exports = { BotLeader };
