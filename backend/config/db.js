'use strict';

const path = require('path');
const dotenv = require('dotenv');
const mysql = require('mysql2/promise');

dotenv.config({
  path: process.env.DOTENV_CONFIG_PATH || path.join(__dirname, '..', '.env'),
  quiet: true,
});

const required = ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'];
for (const name of required) {
  if (!process.env[name]) {
    throw new Error(`Missing required database environment variable: ${name}`);
  }
}

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  waitForConnections: true,
  connectionLimit: Math.max(2, Number(process.env.DB_CONNECTION_LIMIT || 10)),
  maxIdle: Math.max(2, Number(process.env.DB_CONNECTION_LIMIT || 10)),
  idleTimeout: 60_000,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
  charset: 'utf8mb4',
  timezone: 'Z',
  dateStrings: false,
  decimalNumbers: true,
  namedPlaceholders: true,
  multipleStatements: false,
});

async function query(sql, params = {}) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

async function withTransaction(work, options = {}) {
  const connection = await pool.getConnection();
  try {
    if (options.isolationLevel) {
      const allowed = new Set([
        'READ UNCOMMITTED',
        'READ COMMITTED',
        'REPEATABLE READ',
        'SERIALIZABLE',
      ]);
      if (!allowed.has(options.isolationLevel)) {
        throw new Error('Unsupported transaction isolation level');
      }
      await connection.query(`SET TRANSACTION ISOLATION LEVEL ${options.isolationLevel}`);
    }
    await connection.beginTransaction();
    const value = await work(connection);
    await connection.commit();
    return value;
  } catch (error) {
    try {
      await connection.rollback();
    } catch (rollbackError) {
      console.error('MySQL rollback failed', rollbackError);
    }
    throw error;
  } finally {
    connection.release();
  }
}

async function healthCheck() {
  const startedAt = Date.now();
  const rows = await query('SELECT 1 AS ok');
  return { ok: rows[0]?.ok === 1, latencyMs: Date.now() - startedAt };
}

async function closePool() {
  await pool.end();
}

module.exports = {
  pool,
  query,
  withTransaction,
  healthCheck,
  closePool,
};
